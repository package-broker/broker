import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditRaceBundle, overlapRace, staleSealRace } from './audit-race-fixture.js';
import { assertWorkerBundle, repository } from './local.js';

type Row = Record<string, unknown>;
interface Statement {
  sql: string;
  params: (string | number | null)[];
}
interface Executor {
  driver: 'node-sqlite';
  all(statement: Statement): Promise<Row[]>;
  batch(statements: Statement[]): Promise<{ rows: Row[]; changes: number }[]>;
}
interface Outcome {
  status: number;
  body: Row;
}
interface RaceFixture {
  request(orgId?: string): Promise<Outcome>;
  receipts: Row[];
}

// Load the production code from the built runtime, adding only a disposable fixture
// entry. Migrations and organization bootstrap run through the public CLI.
async function fixture(
  body = overlapRace,
  flags: { bypassLease?: boolean; frozenRetry?: boolean; nonDurable?: boolean } = {},
) {
  const directory = await mkdtemp(join(repository, '.pb/audit-race-test-'));
  const database = join(directory, 'db.sqlite');
  const output = join(repository, '.pb/cloudflare');
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [join(repository, 'packages/cli/dist/bin.js'), ...args], {
      cwd: repository,
      stdio: 'pipe',
    });
  let db: DatabaseSync | undefined;
  try {
    cli('migrate', '--sqlite', database, '--out', output);
    cli('bootstrap', '--sqlite', database, '--slug', 'race-a', '--name', 'race-a');
    db = new DatabaseSync(database);
    const connection = db;
    // Production bootstraps one organization; the isolation oracle needs a foreign row.
    connection.exec('DROP INDEX organization_singleton');
    connection
      .prepare('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)')
      .run('01J00000000000000000000B0B', 'race-b', 'race-b');
    const orgs = connection.prepare('SELECT id FROM organization ORDER BY slug').all() as {
      id: string;
    }[];
    const orgId = orgs[0]!.id;
    const foreignId = orgs[1]!.id;
    const run = (sql: string, params: Statement['params'] = []) =>
      connection.prepare(sql).run(...params);
    const executor: Executor = {
      driver: 'node-sqlite',
      async all({ sql, params }) {
        return connection.prepare(sql).all(...params);
      },
      async batch(statements) {
        connection.exec('BEGIN IMMEDIATE');
        try {
          const results = statements.map(({ sql, params }) => {
            const statement = connection.prepare(sql);
            if (statement.columns().length > 0)
              return { rows: statement.all(...params), changes: 0 };
            return { rows: [], changes: Number(statement.run(...params).changes) };
          });
          connection.exec('COMMIT');
          return results;
        } catch (error) {
          connection.exec('ROLLBACK');
          throw error;
        }
      },
    };
    const control = auditRaceBundle(
      `
function createAuditExportRepository(executor) { return realExport(executor); }
function auditExportJob(port, options) { return {}; }
app.get("/health/live", () => {});
  app.get("/health/ready", async (c) => {});
`,
      '/fixture',
      body,
    );
    const bundle = await readFile(join(output, 'worker.js'), 'utf8');
    assertWorkerBundle(bundle);
    const script = join(directory, 'race.mjs');
    await writeFile(
      script,
      bundle.replace(/^\/\/# sourceMappingURL=.*$/m, '') +
        `
export async function fixtureRace(executor, orgId, foreignId, flags) {
  const rawExecutor = executor;
  executor = { ...rawExecutor,
    async all(statement) {
      try { return await rawExecutor.all(statement); } catch (error) { throw classifySqliteError(error); }
    },
    async batch(statements) {
      try { return await rawExecutor.batch(statements); } catch (error) { throw classifySqliteError(error); }
    }
  };
  const org = orgContext(orgId);
  const run = (sql, params) => executor.batch([{ sql, params }]);
  for (const id of [orgId, foreignId]) {
    await run("INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type, target_id, payload_json) VALUES (?, ?, '2026-10-30T00:00:00.000Z', 'system', 'project.create', 'project', '01J00000000000000000000P0P', json_object('op_id', NULL, 'request_id', NULL))", [ulid(), id]);
    await createAuditSealRepository(executor).seal(orgContext(id));
    await run("UPDATE audit_chain SET mode = 'export' WHERE org_id = ?", [id]);
    for (const sink of ['webhook', 'otlp']) {
      await run(\`INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation,
        receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash,
        custody_seq, inflight_repr) VALUES (?, ?, 'audit', 'webhook', 1, 'fingerprint',
        ?, 'FIXTURE_URL', 'active', 0, ?, 0, '{"custodyFromSeq":1}')\`,
        [id, sink, Number(sink === 'webhook' && !flags.nonDurable), '0'.repeat(64)]);
    }
  }
  const receipts = [];
  const options = id => ({
    id, generation: 1, pluginVersion: '1.0', sourceIp: 'omit',
    now: () => new Date(), rejectionRetries: 'terminal',
    sink: { async deliver(batch) {
      receipts.push(batch);
      return { outcome: 'accepted', chainId: batch.chainId, epoch: batch.epoch,
        throughSeq: batch.throughSeq, throughHash: batch.throughHash };
    } }
  });
  if (flags.frozenRetry) {
    const lease = { id: ulid(), owner: ulid(), fence: 1 };
    await run("INSERT INTO job (id, org_id, type, resource_key, state, lease_owner, lease_until, fence) VALUES (?, ?, 'core:audit-export-webhook:v1', 'audit-export:webhook', 'running', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'), 1)", [lease.id, orgId, lease.owner]);
    const retry = await exportAuditBatch(createAuditExportRepository(executor), org,
      systemMutationFence('audit-export', lease, {}),
      { ...options('webhook'), sink: { deliver: async () => ({ outcome: 'retry', code: 'network' }) } },
      new AbortController().signal);
    if (retry !== 'retry') throw new Error('FixtureRetryNotFrozen');
    await run('DELETE FROM job WHERE org_id = ? AND id = ?', [orgId, lease.id]);
    await run("UPDATE audit_chain SET mode = 'trail', pending_mode = 'export', cutover_seq = 1 WHERE org_id = ?", [orgId]);
  }
  const originalExport = createAuditExportRepository;
  const realExport = executor => {
    const port = originalExport(executor);
    if (!flags.bypassLease) return port;
    return { ...port, async save(...args) {
      const [ctx, fence, expected, next] = args;
      if (fence.job.fence === 1 && next.progressSeq > expected.sink.progressSeq) {
        const [current] = await executor.all({
          sql: 'SELECT id, lease_owner AS owner, fence FROM job WHERE org_id = ? AND id = ?',
          params: [ctx.orgId, fence.job.id]
        });
        args[1] = systemMutationFence('audit-export', current, {});
      }
      return port.save(...args);
    } };
  };
  let handler;
  const app = { post(path, route) { handler = route; }, get() {} };
  const resolveOrg = async () => org;
  function registerControl() {
    ${control}
    for (const id of ['webhook', 'otlp'])
      auditExportJob(createAuditExportRepository(executor), options(id));
    // Background jobs recreate these repositories with a lease-scoped executor.
    // The request controls must retain the original, unscoped registrations.
    const expired = jobLeaseExecutor(executor, {
      org, signal: new AbortController().signal,
      fences: jobFences({ id: ulid(), owner: ulid(), fence: 1 })
    });
    for (const id of ['webhook', 'otlp'])
      auditExportJob(createAuditExportRepository(expired), options(id));
  }
  registerControl();
  return { receipts, request: async (requestedOrg = orgId) => handler({
    req: { json: async () => ({ orgId: requestedOrg }), raw: new Request('https://fixture.test') },
    json: (body, status = 200) => ({ status, body })
  }) };
}
`,
    );
    const runtime = (await import(/* @vite-ignore */ pathToFileURL(script).href)) as {
      fixtureRace(
        executor: Executor,
        orgId: string,
        foreignId: string,
        flags: object,
      ): Promise<RaceFixture>;
    };
    const race = await runtime.fixtureRace(executor, orgId, foreignId, flags);
    return {
      ...race,
      db: connection,
      orgId,
      foreignId,
      run,
      async close() {
        connection.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    db?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

describe('live-request audit race controls in the built runtime', () => {
  it('distinguishes cancellation from a real stale save with unchanged sink CAS state', async () => {
    const f = await fixture();
    try {
      expect(await f.request('foreign')).toEqual({
        status: 409,
        body: { error: 'ForeignFixtureOrganization' },
      });
      const result = await f.request();
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        cancelled: 'idle',
        heartbeatRefused: true,
        cancellationSaves: 0,
        independentOutcome: 'accepted',
        independentThrough: 1,
        staleOutcome: 'contended',
        replacementOutcome: 'accepted',
        before: 0,
        afterStale: 0,
        after: 1,
        attempts: [
          { fence: 1, saved: false },
          { fence: 2, saved: true },
        ],
        sameSnapshot: true,
        frozen: true,
      });
      expect(f.receipts).toHaveLength(4);
      expect(
        [f.receipts[0], f.receipts[1], f.receipts[3]].every(
          (batch) => JSON.stringify(batch) === JSON.stringify(f.receipts[0]),
        ),
      ).toBe(true);
      expect(
        f.db
          .prepare('SELECT progress_seq FROM audit_sink WHERE org_id = ? AND sink_id = ?')
          .get(f.foreignId, 'webhook'),
      ).toEqual({ progress_seq: 0 });
      expect(f.db.prepare('SELECT id FROM job WHERE org_id = ?').all(f.orgId)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('exposes a removed lease predicate as an accepted stale save, independently of sink CAS', async () => {
    const f = await fixture(overlapRace, { bypassLease: true });
    try {
      expect((await f.request()).body).toMatchObject({
        sameSnapshot: true,
        staleOutcome: 'accepted',
        afterStale: 1,
        replacementOutcome: 'contended',
        attempts: [{ fence: 1, saved: true }],
      });
    } finally {
      await f.close();
    }
  });

  it.each([false, true])(
    'executes the stale batch after durable delivery through the winning seal and prune (frozen retry: %s)',
    async (frozenRetry) => {
      const f = await fixture(staleSealRace, { frozenRetry });
      try {
        f.run("UPDATE audit_sink SET state = 'inactive' WHERE org_id = ? AND sink_id = 'otlp'", [
          f.orgId,
        ]);
        f.run(
          `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type, target_id, payload_json)
          VALUES (?, ?, '2026-10-30T00:00:00.000Z', 'system', 'project.create', 'project', '01J00000000000000000000P0P', json_object('op_id', NULL, 'request_id', NULL))`,
          ['01' + randomBytes(12).toString('hex').toUpperCase(), f.orgId],
        );
        const result = await f.request();
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({
          outcome: 'contended',
          attempted: 1,
          winner: 'sealed',
          delivered: 'accepted',
          deliveries: frozenRetry ? 2 : 1,
          ack: { progress_seq: 2, custody_seq: 2 },
          prune: 'pruned',
          pruned: { head_seq: 2, boundary_seq: 3, mode: 'export', pending_mode: null },
        });
        if (frozenRetry) expect(f.receipts.map((batch) => batch['throughSeq'])).toEqual([1, 2]);
        expect(
          f.receipts.flatMap((batch) => (batch['records'] as Row[]).map((row) => row['kind'])),
        ).toEqual(['event', 'event']);
        expect(result.body['afterStale']).toEqual(result.body['pruned']);
        expect(f.db.prepare('SELECT seq FROM audit_event WHERE org_id = ?').all(f.orgId)).toEqual(
          [],
        );
        expect(
          f.db.prepare('SELECT seq FROM audit_event WHERE org_id = ?').all(f.foreignId),
        ).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );

  it('refuses to prune when accepted delivery provides no durable custody', async () => {
    const f = await fixture(staleSealRace, { nonDurable: true });
    try {
      f.run("UPDATE audit_sink SET state = 'inactive' WHERE org_id = ? AND sink_id = 'otlp'", [
        f.orgId,
      ]);
      f.run(
        `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type, target_id, payload_json)
        VALUES (?, ?, '2026-10-30T00:00:00.000Z', 'system', 'project.create', 'project', '01J00000000000000000000P0P', json_object('op_id', NULL, 'request_id', NULL))`,
        ['01' + randomBytes(12).toString('hex').toUpperCase(), f.orgId],
      );
      await expect(f.request()).rejects.toThrow('FixtureDurableCustodyNotAdvancing');
      expect(
        f.db.prepare('SELECT boundary_seq FROM audit_chain WHERE org_id = ?').get(f.orgId),
      ).toEqual({ boundary_seq: 1 });
      expect(
        f.db.prepare('SELECT seq FROM audit_event WHERE org_id = ?').all(f.orgId),
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
});
