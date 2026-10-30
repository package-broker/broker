import { AUDIT_VERIFIED_EXPORT, type AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { AUDIT_EVENTS, KERNEL_REASON_CODES } from '@package-broker/core/kernel/obs-codes';
import { createObservability, type ObsRecord } from '@package-broker/core/platform/observability';
import { createAuditLedgerRepository } from './audit-ledger.js';
import { createAuditSealRepository } from './audit-seal.js';
import { createAuditPruneRepository } from './audit-prune.js';
import { createAuditVerifyReader } from './audit-verify.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';

let database: MigratedDatabase;
let executor: SqlExecutor;
let org: OrgContext;
const options = { generation: 1, configuredSinkIds: ['archive'], trailActive: false };
beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  executor = database.executor;
  org = database.orgs!.a;
});
afterEach(async () => database.close());
async function run(sql: string, ...params: Statement['params']) {
  return executor.batch([{ sql, params }]);
}
async function seed(count = 3, ctx = org) {
  for (let start = 0; start < count; start += 100) {
    await executor.batch(
      Array.from({ length: Math.min(100, count - start) }, (_, n) => ({
        sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES (?, ?, '2026-10-29T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        params: [`${ctx.orgId}-${start + n}`, ctx.orgId],
      })),
    );
    await createAuditSealRepository(executor).seal(ctx);
  }
  await run("UPDATE audit_chain SET mode = 'export' WHERE org_id = ?", ctx.orgId);
  await run(
    `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation,
    receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash,
    custody_seq, inflight_repr) SELECT org_id, 'archive', 'audit', 'webhook', 1, ?, 1,
    'ARCHIVE_URL', 'active', head_seq, head_hash, head_seq, '{"custodyFromSeq":1}'
    FROM audit_chain WHERE org_id = ?`,
    'a'.repeat(64),
    ctx.orgId,
  );
}
async function chain(ctx = org) {
  return (
    await executor.all<Record<string, unknown>>({
      sql: 'SELECT * FROM audit_chain WHERE org_id = ?',
      params: [ctx.orgId],
    })
  )[0]!;
}
async function rows(ctx = org) {
  return executor.all({
    sql: 'SELECT * FROM audit_event WHERE org_id = ? ORDER BY seq',
    params: [ctx.orgId],
  });
}
async function disposition(
  kind: AuditLedgerEntry['kind'],
  sinkId: string | null = 'archive',
  overrides: Partial<AuditLedgerEntry> = {},
) {
  const state = await chain();
  await createAuditLedgerRepository(executor).append(org, [
    {
      id: ulid(),
      chainId: state.chain_id as string,
      epoch: 0,
      kind,
      fromSeq: 1,
      toSeq: 3,
      count: kind === 'gap' ? 3 : 0,
      sinkId,
      reasonCode: kind === 'export' ? 'verified_export' : 'seq_gap',
      policy: 'availability',
      modeGeneration: 0,
      actorType: 'system',
      actorId: null,
      createdAt: '2026-10-29T00:00:00.000Z',
      ...(kind === 'export' ? AUDIT_VERIFIED_EXPORT : {}),
      ...overrides,
    },
  ]);
}
const prune = () => createAuditPruneRepository(executor).prune(org, options);

it('prunes only its organization, preserves ledger and pending, clears verification and permits continued sealing', async () => {
  await seed();
  await seed(3, database.orgs!.b);
  await disposition('export', null);
  const ledger = await createAuditLedgerRepository(executor).page(org, null, 100);
  const reader = createAuditVerifyReader(executor);
  await reader.markVerified(
    org,
    '2026-10-29T01:00:00.000Z',
    { fromSeq: 1, throughSeq: 3, bodies: 3, withheld: 0 },
    await reader.snapshot(org),
  );
  const before = await rows();
  const foreign = await rows(database.orgs!.b);
  await run(
    `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
    VALUES ('next', ?, '2026-10-30T00:00:00.000Z', 'system', 'org.update', 'organization')`,
    org.orgId,
  );
  expect(await prune()).toEqual({ outcome: 'pruned', pruned: 3, boundarySeq: 4 });
  expect(await rows()).toEqual([]);
  expect(await rows(database.orgs!.b)).toEqual(foreign);
  expect(await chain()).toMatchObject({
    boundary_seq: 4,
    boundary_prev_hash: before[2]!.hash,
    head_seq: 3,
    head_hash: before[2]!.hash,
    journal_rows: 0,
    journal_bytes: 0,
    verified_at: null,
  });
  expect(await createAuditLedgerRepository(executor).page(org, null, 100)).toEqual(ledger);

  expect(
    await executor.all({
      sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
      params: [org.orgId],
    }),
  ).toEqual([{ id: 'next' }]);
  expect(await createAuditSealRepository(executor).seal(org)).toMatchObject({
    outcome: 'sealed',
    headSeq: 4,
  });
  expect((await rows())[0]).toMatchObject({ seq: 4, prev_hash: before[2]!.hash });
});

it.each([
  "UPDATE audit_chain SET mode = 'trail' WHERE org_id = ?",
  'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?',
  'UPDATE audit_sink SET generation = 2 WHERE org_id = ?',
  "UPDATE audit_sink SET state = 'blocked' WHERE org_id = ?",
  'UPDATE audit_sink SET durable_ack = 0 WHERE org_id = ?',
  'UPDATE audit_sink SET custody_seq = 0 WHERE org_id = ?',
  'DELETE FROM audit_sink WHERE org_id = ?',
])('retains rows when a safety condition fails: %s', async (sql) => {
  await seed();
  await run(sql, org.orgId);
  const before = await chain();
  expect(await prune()).toEqual({ outcome: 'retained' });
  expect(await rows()).toHaveLength(3);
  expect(await chain()).toEqual(before);
});

it.each(['disabled', 'blocked', 'active'])(
  'every holding %s sink constrains progress',
  async (state) => {
    await seed();
    await run(
      `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
    durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
    VALUES (?, 'slow', 'audit', 'webhook', 1, ?, 0, 'OTHER_URL', ?, 1, ?, 0)`,
      org.orgId,
      'b'.repeat(64),
      state,
      '0'.repeat(64),
    );
    expect(await prune()).toMatchObject({ outcome: 'pruned', pruned: 1, boundarySeq: 2 });
  },
);
it.each(['inactive', 'retired'])('%s sink does not constrain progress', async (state) => {
  await seed();
  await run(
    `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
    durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
    VALUES (?, 'slow', 'audit', 'webhook', 1, ?, 0, 'OTHER_URL', ?, 0, ?, 0)`,
    org.orgId,
    'b'.repeat(64),
    state,
    '0'.repeat(64),
  );
  expect(await prune()).toMatchObject({ outcome: 'pruned', pruned: 3 });
});
it('requires custody at the cutover before pruning even a smaller prefix', async () => {
  await seed();
  await run(
    "UPDATE audit_chain SET mode = 'trail', pending_mode = 'export', cutover_seq = 3 WHERE org_id = ?",
    org.orgId,
  );
  await run('UPDATE audit_sink SET custody_seq = 2 WHERE org_id = ?', org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
  await run('UPDATE audit_sink SET custody_seq = 3 WHERE org_id = ?', org.orgId);
  expect(
    await createAuditPruneRepository(executor).prune(org, { ...options, limit: 1 }),
  ).toMatchObject({ outcome: 'pruned', pruned: 1 });
});
it.each(['uncertain', 'withheld'] as const)(
  'required policy needs an independent acknowledgement for %s',
  async (kind) => {
    await seed();
    await disposition(kind);
    await run("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org.orgId);
    expect(await prune()).toEqual({ outcome: 'retained' });
    await run(
      `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
    durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq, inflight_repr)
    SELECT org_id, 'second', plugin_id, kind, generation, receiver_fingerprint, durable_ack,
      activation_source, state, progress_seq, progress_hash, custody_seq, inflight_repr FROM audit_sink WHERE org_id = ?`,
      org.orgId,
    );
    expect(await prune()).toMatchObject({ outcome: 'pruned', pruned: 3 });
  },
);
it('mode none requires a registered verified export of this chain and epoch', async () => {
  await seed();
  await run("UPDATE audit_chain SET mode = 'none' WHERE org_id = ?", org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
  await disposition('export', null);
  expect(await prune()).toMatchObject({ outcome: 'pruned', pruned: 3 });
});
it('bounds deletion to 500 rows and maintains exact byte counters', async () => {
  await seed(501);
  expect(await prune()).toEqual({ outcome: 'pruned', pruned: 500, boundarySeq: 501 });
  expect(await chain()).toMatchObject({ journal_rows: 1 });
  expect(await prune()).toEqual({ outcome: 'pruned', pruned: 1, boundarySeq: 502 });
  expect(await chain()).toMatchObject({ journal_rows: 0, journal_bytes: 0 });
});
it.each([
  'UPDATE audit_chain SET integrity_incidents = integrity_incidents + 1 WHERE org_id = ?',
  'UPDATE audit_chain SET mode_generation = mode_generation + 1 WHERE org_id = ?',
  'UPDATE audit_chain SET incarnation = incarnation + 1 WHERE org_id = ?',
  'UPDATE audit_chain SET epoch = epoch + 1 WHERE org_id = ?',
  "UPDATE audit_chain SET chain_id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE org_id = ?",
  'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?',
  'UPDATE audit_sink SET custody_seq = 0 WHERE org_id = ?',
  'UPDATE audit_sink SET progress_seq = 0 WHERE org_id = ?',
  'UPDATE audit_event SET payload_json = \'{"changed":true}\' WHERE org_id = ?',
])('CAS aborts atomically on a concurrent change: %s', async (sql) => {
  await seed();
  const before = await rows();
  const wrapped: SqlExecutor = {
    driver: executor.driver,
    all: (s) => executor.all(s),
    async batch(statements) {
      await run(sql, org.orgId);
      return executor.batch(statements);
    },
  };
  expect(await createAuditPruneRepository(wrapped).prune(org, options)).toEqual({
    outcome: /restore_pending|custody_seq|progress_seq/.test(sql) ? 'retained' : 'contended',
  });
  expect(await rows()).toHaveLength(before.length);
  expect(await chain()).toMatchObject({ boundary_seq: 1, journal_rows: 3 });
});
it('crosses only recorded holes and never changes the allocated head', async () => {
  await seed();
  await run('DELETE FROM audit_event WHERE org_id = ? AND seq = 2', org.orgId);
  await run('UPDATE audit_chain SET journal_rows = journal_rows - 1 WHERE org_id = ?', org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
  await createAuditSealRepository(executor).seal(org);
  const gaps = await createAuditLedgerRepository(executor).effectiveGaps(org);
  expect(gaps).toHaveLength(1);
  expect(await prune()).toEqual({ outcome: 'pruned', pruned: 2, boundarySeq: 4 });
  expect(await chain()).toMatchObject({ head_seq: 3, journal_rows: 0, journal_bytes: 0 });
  expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toEqual(gaps);
});

it('takes the durable custody limit even when progress is farther ahead', async () => {
  await seed();
  await run('UPDATE audit_sink SET custody_seq = 2 WHERE org_id = ?', org.orgId);
  expect(await prune()).toEqual({ outcome: 'pruned', pruned: 2, boundarySeq: 3 });
  expect((await rows()).map((row) => row.seq)).toEqual([3]);
});
it('availability dispositions permit pruning but never remove the ledger evidence', async () => {
  await seed();
  await disposition('uncertain');
  const before = await createAuditLedgerRepository(executor).page(org, null, 100);
  expect(await prune()).toMatchObject({ outcome: 'pruned', pruned: 3 });
  expect(await createAuditLedgerRepository(executor).page(org, null, 100)).toEqual(before);
});
it('no holding sinks is not itself permission to prune', async () => {
  await seed();
  await run('DELETE FROM audit_sink WHERE org_id = ?', org.orgId);
  expect(
    await createAuditPruneRepository(executor).prune(org, { ...options, configuredSinkIds: [] }),
  ).toEqual({ outcome: 'retained' });
});
it.each([
  'UPDATE audit_chain SET epoch = 1 WHERE org_id = ?',
  "UPDATE audit_chain SET chain_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE org_id = ?",
  'UPDATE audit_chain SET cutover_seq = 4 WHERE org_id = ?',
  "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?",
])('verified export cannot authorize another identity or uncovered cutover: %s', async (sql) => {
  await seed();
  await run("UPDATE audit_chain SET mode = 'none' WHERE org_id = ?", org.orgId);
  await disposition('export', null);
  await run(sql, org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
});
it('global withheld evidence holds required pruning even when multiple sinks have custody', async () => {
  await seed();
  await disposition('withheld', null);
  await run(
    `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
    durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
    SELECT org_id, 'second', plugin_id, kind, generation, receiver_fingerprint, 1,
      activation_source, state, progress_seq, progress_hash, custody_seq FROM audit_sink WHERE org_id = ?`,
    org.orgId,
  );
  await run("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
});
it.each(['boundary_prev_hash', 'head_hash'])(
  'keeps an inconsistent %s for the sealer to record',
  async (column) => {
    await seed();
    await run(`UPDATE audit_chain SET ${column} = ? WHERE org_id = ?`, 'b'.repeat(64), org.orgId);
    expect(await prune()).toEqual({ outcome: 'retained' });
    expect(await rows()).toHaveLength(3);
  },
);
it('uses bounded statements, parameters and snapshot chunks with maximum-size payloads', async () => {
  await seed(501);
  await run(
    'UPDATE audit_event SET payload_json = ? WHERE org_id = ?',
    '"' + 'x'.repeat(4094) + '"',
    org.orgId,
  );
  // Recover the byte counter after deliberately replacing test fixture bodies.
  await run('UPDATE audit_chain SET journal_bytes = 0 WHERE org_id = ?', org.orgId);
  await createAuditSealRepository(executor).seal(org);
  const wrapped: SqlExecutor = {
    driver: executor.driver,
    all: (s) => executor.all(s),
    batch(statements) {
      expect(statements.length).toBeLessThanOrEqual(200);
      for (const statement of statements) {
        expect(statement.params.length).toBeLessThanOrEqual(100);
        for (const param of statement.params)
          if (typeof param === 'string')
            expect(new TextEncoder().encode(param).length).toBeLessThan(512 * 1024);
      }
      return executor.batch(statements);
    },
  };
  expect(await createAuditPruneRepository(wrapped).prune(org, options)).toEqual({
    outcome: 'pruned',
    pruned: 500,
    boundarySeq: 501,
  });
});
it('retains the terminal safe sequence because its successor cannot be a boundary', async () => {
  await seed(1);
  await run('UPDATE audit_event SET seq = 9007199254740991 WHERE org_id = ?', org.orgId);
  await run(
    'UPDATE audit_chain SET boundary_seq = 9007199254740991, head_seq = 9007199254740991 WHERE org_id = ?',
    org.orgId,
  );
  await run(
    'UPDATE audit_sink SET progress_seq = 9007199254740991, custody_seq = 9007199254740991 WHERE org_id = ?',
    org.orgId,
  );
  expect(await prune()).toEqual({ outcome: 'retained' });
});

it('isolates configured membership from custody and progress', async () => {
  await seed();
  expect(
    await createAuditPruneRepository(executor).prune(org, {
      ...options,
      configuredSinkIds: ['archive', 'missing'],
    }),
  ).toEqual({ outcome: 'retained' });
});
it.each(['uncertain', 'withheld'] as const)(
  'ignores %s entirely below the retained boundary',
  async (kind) => {
    await seed();
    await disposition(kind, null);
    expect(await prune()).toMatchObject({ outcome: 'pruned' });
    await run("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org.orgId);
    await run(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
    VALUES ('later', ?, '2026-10-30T00:00:00.000Z', 'system', 'org.update', 'organization')`,
      org.orgId,
    );
    await createAuditSealRepository(executor).seal(org);
    await run(
      'UPDATE audit_sink SET progress_seq = 4, custody_seq = 4 WHERE org_id = ?',
      org.orgId,
    );
    expect(await prune()).toEqual({ outcome: 'pruned', pruned: 1, boundarySeq: 5 });
  },
);
it('referenced covering replay releases sink uncertainty regardless of id or time', async () => {
  await seed();
  await disposition('uncertain', 'archive', { id: '7ZZZZZZZZZZZZZZZZZZZZZZZZZ' });
  await run("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
  await disposition('replay', 'archive', {
    id: '00000000000000000000000000',
    resolvesId: '7ZZZZZZZZZZZZZZZZZZZZZZZZZ',
  });
  expect(await prune()).toMatchObject({ outcome: 'pruned', pruned: 3 });
});
it.each([
  { kind: 'export' as const },
  { kind: 'restore_confirmed' as const },
  { kind: 'replay' as const, toSeq: 2 },
  { kind: 'replay' as const, fromSeq: 2 },
  { kind: 'replay' as const, epoch: 1 },
  { kind: 'replay' as const, chainId: 'b'.repeat(32) },
  { kind: 'replay' as const, sinkId: null },
])('unrelated or incomplete replay evidence cannot release uncertainty: %j', async (entry) => {
  await seed();
  await disposition('uncertain');
  await disposition(entry.kind, 'archive', entry);
  await run("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
});
it('an earlier covering replay does not release later uncertainty', async () => {
  await seed();
  await disposition('replay');
  await disposition('uncertain');
  await run("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
});
it.each(['withheld', 'uncertain'] as const)(
  'global %s is not released by replay or control actions',
  async (kind) => {
    await seed();
    await disposition(kind, null);
    for (const action of ['replay', 'export', 'restore_confirmed', 'unblock'] as const) {
      await disposition(action);
      if (action !== 'unblock') await disposition(action, null);
    }
    await run("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org.orgId);
    expect(await prune()).toEqual({ outcome: 'retained' });
  },
);
it('a later replay does not release sink-specific withholding', async () => {
  await seed();
  await disposition('withheld');
  await disposition('replay');
  await run("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
});
it('sealing between the read and CAS preserves the new head and relative counters', async () => {
  await seed();
  await run(
    `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
    VALUES ('later', ?, '2026-10-30T00:00:00.000Z', 'system', 'org.update', 'organization')`,
    org.orgId,
  );
  const wrapped: SqlExecutor = {
    driver: executor.driver,
    all: (s) => executor.all(s),
    async batch(statements) {
      await createAuditSealRepository(executor).seal(org);
      return executor.batch(statements);
    },
  };
  expect(await createAuditPruneRepository(wrapped).prune(org, options)).toEqual({
    outcome: 'pruned',
    pruned: 3,
    boundarySeq: 4,
  });
  expect(await chain()).toMatchObject({ head_seq: 4, journal_rows: 1 });
  const remaining = await rows();
  expect(remaining).toHaveLength(1);
  expect((await chain()).journal_bytes).toBeGreaterThan(0);
});
it('retains a prefix whose successor does not link to the new boundary', async () => {
  await seed();
  await run(
    'UPDATE audit_event SET prev_hash = ? WHERE org_id = ? AND seq = 3',
    'b'.repeat(64),
    org.orgId,
  );
  expect(await createAuditPruneRepository(executor).prune(org, { ...options, limit: 2 })).toEqual({
    outcome: 'retained',
  });
  expect(await rows()).toHaveLength(3);
});
it.each(['active', 'disabled', 'blocked', 'inactive', 'retired'])(
  'fences in-flight rows for a %s sink',
  async (state) => {
    await seed();
    await run(
      'UPDATE audit_sink SET state = ?, inflight_from = 2, inflight_to = 3 WHERE org_id = ?',
      state,
      org.orgId,
    );
    await run(
      `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq) SELECT org_id, 'second', plugin_id, kind, generation, receiver_fingerprint, 1, activation_source, 'active', progress_seq, progress_hash, custody_seq FROM audit_sink WHERE org_id = ?`,
      org.orgId,
    );
    if (state === 'inactive' || state === 'retired') {
      await run("UPDATE audit_chain SET mode = 'none' WHERE org_id = ?", org.orgId);
      await disposition('export', null);
    }
    expect(await prune()).toMatchObject({
      outcome: 'pruned',
      pruned: state === 'inactive' || state === 'retired' ? 3 : 1,
    });
  },
);
it('clamps an undercounted byte counter at zero', async () => {
  await seed();
  await run('UPDATE audit_chain SET journal_bytes = 1 WHERE org_id = ?', org.orgId);
  expect(await prune()).toMatchObject({ outcome: 'pruned', pruned: 3 });
  expect(await chain()).toMatchObject({ journal_bytes: 0 });
});

it('mode none retains the rolling-deployment generation gate even with a verified export', async () => {
  await seed();
  await disposition('export', null);
  await run("UPDATE audit_chain SET mode = 'none' WHERE org_id = ?", org.orgId);
  await run('UPDATE audit_sink SET generation = 2 WHERE org_id = ?', org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
});
it('another sink replay cannot release uncertainty', async () => {
  await seed();
  await run(
    `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
    SELECT org_id, 'other', plugin_id, kind, generation, receiver_fingerprint, 0, activation_source, 'active', progress_seq, progress_hash, 0 FROM audit_sink WHERE org_id = ?`,
    org.orgId,
  );
  await disposition('uncertain');
  await disposition('replay', 'other');
  await run("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
});

it('a covering replay without a resolution reference never releases uncertainty', async () => {
  await seed();
  await disposition('uncertain');
  await disposition('replay');
  await run("UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
  expect(await rows()).toHaveLength(3);
});
it('retains on journal row underflow', async () => {
  await seed();
  await run('UPDATE audit_chain SET journal_rows = 1 WHERE org_id = ?', org.orgId);
  expect(await prune()).toEqual({ outcome: 'retained' });
  expect(await rows()).toHaveLength(3);
  expect(await chain()).toMatchObject({ boundary_seq: 1, journal_rows: 1 });
});
it('ignores marker-only in-flight batches', async () => {
  await seed();
  await run(
    `UPDATE audit_sink SET inflight_from = 1, inflight_to = 1,
      inflight_body = '{"v":1,"records":[]}',
      inflight_repr = '{"purpose":"registry_markers"}' WHERE org_id = ?`,
    org.orgId,
  );
  expect(await prune()).toMatchObject({ outcome: 'pruned', pruned: 3 });
});
it.each([1, 2, 3])('logs and counts integrity anchor refusal at row %s', async (seq) => {
  await seed();
  await run(
    'UPDATE audit_event SET prev_hash = ? WHERE org_id = ? AND seq = ?',
    'f'.repeat(64),
    org.orgId,
    seq,
  );
  const logs: unknown[] = [];
  const counters: string[] = [];
  const repository = createAuditPruneRepository(executor, {
    log: (record) => {
      logs.push(record);
    },
    counter: (name) => {
      counters.push(name);
    },
    histogram: () => {},
  });
  expect(await repository.prune(org, options)).toEqual({ outcome: 'retained' });
  expect(await rows()).toHaveLength(3);
  expect(logs).toEqual([
    { level: 'error', event: 'audit.chain_integrity', reason_code: 'audit.prune_anchor' },
  ]);
  expect(counters).toEqual(['pb.audit.chain_integrity']);
});

it('commits a pending none cutover only when the successful prune passes its sequence', async () => {
  await seed();
  await run(
    "UPDATE audit_chain SET mode = 'trail', pending_mode = 'none', cutover_seq = 3 WHERE org_id = ?",
    org.orgId,
  );
  expect(await prune()).toEqual({ outcome: 'retained' });
  expect(await chain()).toMatchObject({ mode: 'trail', pending_mode: 'none' });
  await disposition('export', null);
  const repository = createAuditPruneRepository(executor);
  expect(await repository.prune(org, { ...options, limit: 2 })).toEqual({
    outcome: 'pruned',
    pruned: 2,
    boundarySeq: 3,
  });
  expect(await chain()).toMatchObject({ mode: 'trail', pending_mode: 'none', cutover_seq: 3 });
  expect(await prune()).toEqual({ outcome: 'pruned', pruned: 1, boundarySeq: 4 });
  expect(await chain()).toMatchObject({ mode: 'none', pending_mode: null, cutover_seq: 3 });
});

const evict = (maxJournalBytes = 1, limit = 500, storage = executor) =>
  createAuditPruneRepository(storage).evict(org, { generation: 1, maxJournalBytes, limit });

it.each([1, 2])(
  'stops capacity eviction before a recorded hole at sequence %s',
  async (missing) => {
    await seed();
    await run('DELETE FROM audit_event WHERE org_id = ? AND seq = ?', org.orgId, missing);
    await run('UPDATE audit_chain SET journal_rows = journal_rows - 1 WHERE org_id = ?', org.orgId);
    await createAuditSealRepository(executor).seal(org);
    const before = await chain();
    const ledger = createAuditLedgerRepository(executor);
    const holes = await ledger.effectiveGaps(org);
    expect(holes).toMatchObject([{ fromSeq: missing, toSeq: missing, reasonCode: 'seq_gap' }]);
    expect(await evict()).toEqual(
      missing === 1 ? { outcome: 'retained' } : { outcome: 'evicted', evicted: 1, boundarySeq: 2 },
    );
    const gaps = await ledger.effectiveGaps(org);
    expect(gaps.filter((gap) => gap.reasonCode === 'seq_gap')).toEqual(holes);
    const losses = gaps.filter((gap) => gap.reasonCode === 'capacity');
    expect(losses).toHaveLength(missing - 1);
    for (const gap of losses) {
      expect(gap).toMatchObject({ fromSeq: 1, toSeq: 1, count: 1 });
      expect(gap.count).toBe(gap.toSeq - gap.fromSeq + 1);
    }
    expect((await rows()).map((row) => row.seq)).toEqual(missing === 1 ? [2, 3] : [3]);
    expect(await chain()).toMatchObject({ head_seq: before.head_seq, head_hash: before.head_hash });
    expect(await evict()).toEqual({ outcome: 'retained' });
    expect(await ledger.effectiveGaps(org)).toEqual(gaps);
  },
);

it('includes disabled sinks that lag the evicted range as possibly affected', async () => {
  await seed();
  await run(
    "UPDATE audit_sink SET state = 'disabled', progress_seq = 0 WHERE org_id = ?",
    org.orgId,
  );
  expect(await evict()).toMatchObject({ outcome: 'evicted', evicted: 3 });
  expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toMatchObject([
    { capacity: { affectedSinkIds: ['archive'] } },
  ]);
});

it('evicts with an active trail, records the gap atomically and never reuses a sequence', async () => {
  await seed();
  await seed(3, database.orgs!.b);
  await run(
    "UPDATE audit_chain SET mode = 'trail', verified_at = '2026-10-30T00:00:00.000Z' WHERE org_id = ?",
    org.orgId,
  );
  const foreign = await chain(database.orgs!.b);
  const foreignRows = await rows(database.orgs!.b);
  const head = await chain();
  await run(
    `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
    VALUES ('next', ?, '2026-10-30T00:00:00.000Z', 'system', 'org.update', 'organization')`,
    org.orgId,
  );
  expect(await evict()).toEqual({ outcome: 'evicted', evicted: 3, boundarySeq: 4 });
  expect(await chain()).toMatchObject({
    head_seq: head.head_seq,
    head_hash: head.head_hash,
    boundary_seq: 4,
    boundary_prev_hash: head.head_hash,
    boundary_reason: 'capacity',
    journal_rows: 0,
    journal_bytes: 0,
    verified_at: null,
  });
  expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toMatchObject([
    {
      fromSeq: 1,
      toSeq: 3,
      count: 3,
      reasonCode: 'capacity',
      sinkId: null,
      policy: 'availability',
      modeGeneration: 0,
    },
  ]);
  await createAuditSealRepository(executor).seal(org);
  expect(await rows()).toMatchObject([{ seq: 4, prev_hash: head.head_hash }]);
  expect(await chain(database.orgs!.b)).toEqual(foreign);
  expect(await rows(database.orgs!.b)).toEqual(foreignRows);
});
it.each([
  "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?",
  'UPDATE audit_chain SET restore_pending = 1 WHERE org_id = ?',
  'UPDATE audit_sink SET generation = 2 WHERE org_id = ?',
])('retains capacity rows when eviction is forbidden: %s', async (sql) => {
  await seed();
  await run(sql, org.orgId);
  const before = await chain();
  expect(await evict()).toEqual({ outcome: 'retained' });
  expect(await rows()).toHaveLength(3);
  expect(await chain()).toEqual(before);
  expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toEqual([]);
});
it('does not spend the incident reserve as journal budget and retains below the limit', async () => {
  await seed();
  const bytes = (await chain()).journal_bytes as number;
  expect(await evict(Math.ceil(bytes / 0.98))).toEqual({ outcome: 'retained' });
  expect(await evict(bytes + 1)).toEqual({ outcome: 'evicted', evicted: 1, boundarySeq: 2 });
  expect((await chain()).journal_bytes).toBeLessThan(bytes);
});
it('drops the oldest acknowledged prefix before unacknowledged events', async () => {
  await seed();
  await run('UPDATE audit_sink SET progress_seq = 1, custody_seq = 1 WHERE org_id = ?', org.orgId);
  expect(await evict(1, 1)).toEqual({ outcome: 'evicted', evicted: 1, boundarySeq: 2 });
  expect((await rows()).map((row) => row.seq)).toEqual([2, 3]);
  expect(await evict()).toEqual({ outcome: 'evicted', evicted: 2, boundarySeq: 4 });
  expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toMatchObject([
    { fromSeq: 1, toSeq: 3, count: 3 },
  ]);
});
it.each(['events', 'marker', 'registry_markers'])(
  'keeps frozen %s batch bytes and cursor, including when their event range is evicted',
  async (purpose) => {
    await seed();
    await run(
      `UPDATE audit_sink SET progress_seq = 0, custody_seq = 0,
      inflight_from = 1, inflight_to = 3, inflight_body = '{"frozen":true}', inflight_repr = ? WHERE org_id = ?`,
      JSON.stringify({ custodyFromSeq: 1, purpose }),
      org.orgId,
    );
    const [before] = await executor.all({
      sql: 'SELECT * FROM audit_sink WHERE org_id = ?',
      params: [org.orgId],
    });
    expect(await evict()).toMatchObject({ outcome: 'evicted', evicted: 3 });
    expect(
      await executor.all({ sql: 'SELECT * FROM audit_sink WHERE org_id = ?', params: [org.orgId] }),
    ).toEqual([before]);
    expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toHaveLength(1);
  },
);
it.each([
  'UPDATE audit_sink SET inflight_from = 1, inflight_to = 2 WHERE org_id = ?',
  'UPDATE audit_sink SET generation = 0 WHERE org_id = ?',
  'UPDATE audit_chain SET mode_generation = mode_generation + 1 WHERE org_id = ?',
  'UPDATE audit_event SET payload_json = \'{"changed":true}\' WHERE org_id = ?',
])('rolls back the gap and deletion on concurrent changes: %s', async (sql) => {
  await seed();
  const wrapped: SqlExecutor = {
    driver: executor.driver,
    all: (s) => executor.all(s),
    async batch(statements) {
      await run(sql, org.orgId);
      return executor.batch(statements);
    },
  };
  expect(await evict(1, 500, wrapped)).toEqual({ outcome: 'contended' });
  expect(await rows()).toHaveLength(3);
  expect(await chain()).toMatchObject({ boundary_seq: 1, journal_rows: 3 });
  expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toEqual([]);
});
it('keeps concurrent sealing and subtracts counters from their current values', async () => {
  await seed();
  await run(
    `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
    VALUES ('next', ?, '2026-10-30T00:00:00.000Z', 'system', 'org.update', 'organization')`,
    org.orgId,
  );
  const wrapped: SqlExecutor = {
    driver: executor.driver,
    all: (s) => executor.all(s),
    async batch(statements) {
      await createAuditSealRepository(executor).seal(org);
      return executor.batch(statements);
    },
  };
  expect(await evict(1, 500, wrapped)).toMatchObject({ outcome: 'evicted', evicted: 3 });
  expect(await chain()).toMatchObject({ head_seq: 4, journal_rows: 1 });
  expect(await rows()).toMatchObject([{ seq: 4 }]);
  expect((await chain()).journal_bytes).toBeGreaterThan(0);
});
it('aborts eviction if the ledger cannot record the loss', async () => {
  await seed();
  await disposition('gap', null, { reasonCode: 'capacity' });
  const before = await chain();
  await expect(evict()).rejects.toThrow('audit ledger overlapping report');
  expect(await chain()).toEqual(before);
  expect(await rows()).toHaveLength(3);
});
it.each([1, 2, 3])('retains broken hash links at seq %s during eviction', async (seq) => {
  await seed();
  await run(
    'UPDATE audit_event SET prev_hash = ? WHERE org_id = ? AND seq = ?',
    'f'.repeat(64),
    org.orgId,
    seq,
  );
  expect(await evict()).toEqual({ outcome: 'retained' });
  expect(await rows()).toHaveLength(3);
  expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toEqual([]);
});
it('bounds eviction to 500 rows and keeps exact counters through repeated batches', async () => {
  await seed(501);
  const wrapped: SqlExecutor = {
    driver: executor.driver,
    all: (s) => executor.all(s),
    batch(statements) {
      expect(statements.length).toBeLessThanOrEqual(200);
      for (const s of statements) expect(s.params.length).toBeLessThanOrEqual(100);
      return executor.batch(statements);
    },
  };
  expect(await evict(1, 500, wrapped)).toEqual({
    outcome: 'evicted',
    evicted: 500,
    boundarySeq: 501,
  });
  expect(await chain()).toMatchObject({ journal_rows: 1 });
  expect(await evict()).toEqual({ outcome: 'evicted', evicted: 1, boundarySeq: 502 });
  expect(await chain()).toMatchObject({ journal_rows: 0, journal_bytes: 0 });
  expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toMatchObject([
    { count: 501, fromSeq: 1, toSeq: 501 },
  ]);
});
it('pruning also ignores the marker purpose used by disposition batches', async () => {
  await seed();
  await run(
    `UPDATE audit_sink SET inflight_from = 1, inflight_to = 1,
    inflight_body = '{"v":1,"records":[]}', inflight_repr = '{"purpose":"marker"}' WHERE org_id = ?`,
    org.orgId,
  );
  expect(await prune()).toMatchObject({ outcome: 'pruned', pruned: 3 });
});
it('does not let concurrent marker-only frontiers hold eviction', async () => {
  await seed();
  await run(
    `UPDATE audit_sink SET inflight_from = 1, inflight_to = 1,
    inflight_body = '{"records":[]}', inflight_repr = '{"purpose":"marker"}' WHERE org_id = ?`,
    org.orgId,
  );
  const wrapped: SqlExecutor = {
    driver: executor.driver,
    all: (s) => executor.all(s),
    async batch(statements) {
      await run(
        'UPDATE audit_sink SET inflight_from = 2, inflight_to = 2 WHERE org_id = ?',
        org.orgId,
      );
      return executor.batch(statements);
    },
  };
  expect(await evict(1, 500, wrapped)).toMatchObject({ outcome: 'evicted', evicted: 3 });
});
it('alerts using fixed codes only after a committed capacity loss', async () => {
  await seed();
  const logs: unknown[] = [];
  const counters: unknown[] = [];
  const repository = createAuditPruneRepository(executor, {
    log: (record) => {
      logs.push(record);
    },
    counter: (...args) => {
      counters.push(args);
    },
    histogram: () => {},
  });
  expect(await repository.evict(org, { generation: 1, maxJournalBytes: 1 })).toMatchObject({
    outcome: 'evicted',
    evicted: 3,
  });
  expect(logs).toEqual([{ level: 'warn', event: 'audit.loss', reason_code: 'audit.capacity' }]);
  expect(counters).toEqual([['pb.audit.loss_events_total', { kind: 'gap' }, 3]]);
});

it('permits concurrent sink progress, custody and state changes during eviction', async () => {
  await seed();
  const wrapped: SqlExecutor = {
    driver: executor.driver,
    all: (s) => executor.all(s),
    async batch(statements) {
      await run(
        "UPDATE audit_sink SET progress_seq = 2, custody_seq = 2, state = 'blocked' WHERE org_id = ?",
        org.orgId,
      );
      return executor.batch(statements);
    },
  };
  expect(await evict(1, 500, wrapped)).toMatchObject({ outcome: 'evicted', evicted: 3 });
});
it('evicts to the low-water mark and merges repeated losses at a steady budget', async () => {
  await seed(100);
  const budget = (await chain()).journal_bytes as number;
  const firstLoss = await evict(budget);
  expect(firstLoss).toMatchObject({ outcome: 'evicted' });
  if (firstLoss.outcome !== 'evicted') throw new Error('expected eviction');
  let lost = firstLoss.evicted;
  expect(lost).toBeGreaterThanOrEqual(5);
  expect(lost).toBeLessThanOrEqual(6);
  expect((await chain()).journal_bytes).toBeLessThanOrEqual(budget - Math.ceil(budget / 20));
  expect(await evict(budget)).toEqual({ outcome: 'retained' });
  for (let i = 0; i < 3; i++) {
    await executor.batch(
      Array.from({ length: 10 }, (_, n) => ({
        sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES (?, ?, '2026-10-29T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        params: [`refill-${i}-${n}`, org.orgId],
      })),
    );
    await createAuditSealRepository(executor).seal(org);
    const loss = await evict(budget);
    expect(loss).toMatchObject({ outcome: 'evicted' });
    if (loss.outcome !== 'evicted') throw new Error('expected eviction');
    lost += loss.evicted;
  }
  expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toMatchObject([
    { fromSeq: 1, count: lost, toSeq: lost },
  ]);
});
it('bounds the atomic batch even when each row requires a snapshot chunk', async () => {
  await seed(500);
  await run(
    'UPDATE audit_event SET payload_json = ? WHERE org_id = ?',
    JSON.stringify({ data: 'x'.repeat(256 * 1024) }),
    org.orgId,
  );
  await run(
    'UPDATE audit_chain SET journal_bytes = journal_bytes + ? WHERE org_id = ?',
    500 * (JSON.stringify({ data: 'x'.repeat(256 * 1024) }).length - 2),
    org.orgId,
  );
  const wrapped: SqlExecutor = {
    driver: executor.driver,
    all: (s) => executor.all(s),
    batch(statements) {
      expect(statements.length).toBeLessThan(200);
      for (const statement of statements) expect(statement.params.length).toBeLessThanOrEqual(100);
      return executor.batch(statements);
    },
  };
  expect(await evict(1, 500, wrapped)).toMatchObject({ outcome: 'evicted', evicted: 180 });
});

it('caps sorted possibly affected sinks and records overflow without blocking loss accounting', async () => {
  await seed();
  await run(
    `WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM ids WHERE n < 1000)
    INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation, receiver_fingerprint,
      durable_ack, activation_source, state, progress_seq, progress_hash, custody_seq)
    SELECT ?, printf('sink-%04d', n), 'audit', 'webhook', 1, 'fingerprint', 0, 'build', 'active', 0, ?, 0 FROM ids`,
    org.orgId,
    '0'.repeat(64),
  );
  expect(await evict()).toMatchObject({ outcome: 'evicted' });
  const [gap] = await createAuditLedgerRepository(executor).effectiveGaps(org);
  expect(gap!.capacity).toMatchObject({ affectedSinkIdsOverflow: true });
  expect(gap!.capacity!.affectedSinkIds).toHaveLength(1000);
  expect(gap!.capacity!.affectedSinkIds).toEqual(
    Array.from({ length: 1000 }, (_, i) => `sink-${String(i).padStart(4, '0')}`),
  );
});

it('does not complete a pending none cutover through capacity eviction', async () => {
  await seed();
  await run(
    "UPDATE audit_chain SET mode = 'trail', pending_mode = 'none', cutover_seq = 2 WHERE org_id = ?",
    org.orgId,
  );
  expect(await evict()).toEqual({ outcome: 'evicted', evicted: 3, boundarySeq: 4 });
  expect(await chain()).toMatchObject({
    boundary_reason: 'capacity',
    mode: 'trail',
    pending_mode: 'none',
    cutover_seq: 2,
  });
});

it('keeps the capacity loss log through production observability', async () => {
  await seed();
  const records: ObsRecord[] = [];
  const observability = createObservability(
    { emit: (record) => records.push(record) },
    { deploymentId: 'deployment', runtime: 'node', requestId: null },
    { events: AUDIT_EVENTS, reasonCodes: KERNEL_REASON_CODES, routeTemplates: new Set() },
  );
  expect(
    await createAuditPruneRepository(executor, observability).evict(org, {
      generation: 1,
      maxJournalBytes: 1,
    }),
  ).toMatchObject({ outcome: 'evicted', evicted: 3 });
  expect(records.filter((record) => record.kind === 'log')).toMatchObject([
    { record: { level: 'warn', event: 'audit.loss', reason_code: 'audit.capacity' } },
  ]);
  expect(records.filter((record) => record.kind === 'counter')).toEqual([
    { kind: 'counter', name: 'pb.audit.loss_events_total', labels: { kind: 'gap' }, value: 3 },
  ]);
});

it('never reallocates evicted seqs after the head is rolled back', async () => {
  await seed();
  const evicted = await rows();
  expect(await evict()).toEqual({ outcome: 'evicted', evicted: 3, boundarySeq: 4 });
  await run(
    `UPDATE audit_chain SET head_seq = 0, head_hash = ? WHERE org_id = ?`,
    '0'.repeat(64),
    org.orgId,
  );
  await run(
    `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
    VALUES (?, ?, '2026-10-29T00:00:00.000Z', 'system', 'org.update', 'organization')`,
    `${org.orgId}-after`,
    org.orgId,
  );
  expect(await createAuditSealRepository(executor).seal(org)).toMatchObject({
    outcome: 'sealed',
    sealed: 1,
    headSeq: 4,
    integrity: ['head_mismatch'],
  });
  expect(await rows()).toMatchObject([{ seq: 4, prev_hash: evicted.at(-1)!.hash }]);
  expect(await chain()).toMatchObject({ boundary_seq: 4, head_seq: 4 });
});

it('continues an eviction cycle across bounded batches until the low-water mark', async () => {
  await seed(100);
  const budget = (await chain()).journal_bytes as number;
  const lowWater = budget - Math.ceil(budget / 20);
  let batches = 0;
  for (;;) {
    const loss = await evict(budget, 1);
    if (loss.outcome !== 'evicted') break;
    expect(loss.evicted).toBe(1);
    batches += 1;
    if (batches === 1) expect((await chain()).capacity_evict_to).toBe(lowWater);
  }
  expect(batches).toBeGreaterThanOrEqual(5);
  expect((await chain()).journal_bytes).toBeLessThanOrEqual(lowWater);
  expect((await chain()).capacity_evict_to).toBeNull();
  await executor.batch(
    ['refill-1', 'refill-2'].map((id) => ({
      sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES (?, ?, '2026-10-29T00:00:00.000Z', 'system', 'org.update', 'organization')`,
      params: [id, org.orgId],
    })),
  );
  await createAuditSealRepository(executor).seal(org);
  expect((await chain()).journal_bytes).toBeGreaterThan(lowWater);
  expect((await chain()).journal_bytes).toBeLessThan(budget - Math.ceil(budget / 100));
  expect(await evict(budget, 1)).toEqual({ outcome: 'retained' });
  expect(await createAuditLedgerRepository(executor).effectiveGaps(org)).toMatchObject([
    { fromSeq: 1, toSeq: batches, count: batches },
  ]);
});

it('closes only its own finished eviction cycle', async () => {
  const other = database.orgs!.b;
  await seed(3);
  await seed(3, other);
  for (const ctx of [org, other])
    await run(
      'UPDATE audit_chain SET capacity_evict_to = journal_bytes + 1 WHERE org_id = ?',
      ctx.orgId,
    );
  const budget = 10 * ((await chain()).journal_bytes as number);
  expect(await evict(budget)).toEqual({ outcome: 'retained' });
  expect((await chain()).capacity_evict_to).toBeNull();
  expect((await chain(other)).capacity_evict_to).toBe(
    ((await chain(other)).journal_bytes as number) + 1,
  );
});

it('keeps the prune anchor integrity log through production observability', async () => {
  await seed();
  await run(
    'UPDATE audit_event SET prev_hash = ? WHERE org_id = ? AND seq = 2',
    'f'.repeat(64),
    org.orgId,
  );
  const records: ObsRecord[] = [];
  const observability = createObservability(
    { emit: (record) => records.push(record) },
    { deploymentId: 'deployment', runtime: 'node', requestId: null },
    { events: AUDIT_EVENTS, reasonCodes: KERNEL_REASON_CODES, routeTemplates: new Set() },
  );
  expect(await createAuditPruneRepository(executor, observability).prune(org, options)).toEqual({
    outcome: 'retained',
  });
  expect(records.filter((record) => record.kind === 'log')).toMatchObject([
    {
      record: { level: 'error', event: 'audit.chain_integrity', reason_code: 'audit.prune_anchor' },
    },
  ]);
});

it('ends an eviction cycle when retention pruning reaches its target', async () => {
  await seed(100);
  const budget = (await chain()).journal_bytes as number;
  const lowWater = budget - Math.ceil(budget / 20);
  expect(await evict(budget, 1)).toMatchObject({ outcome: 'evicted', evicted: 1 });
  expect((await chain()).capacity_evict_to).toBe(lowWater);
  await run(
    'UPDATE audit_sink SET progress_seq = (SELECT head_seq FROM audit_chain WHERE org_id = ?) WHERE org_id = ?',
    org.orgId,
    org.orgId,
  );
  expect(await prune()).toMatchObject({ outcome: 'pruned', pruned: 99 });
  expect((await chain()).capacity_evict_to).toBeNull();
  for (let start = 0; start < 97; start += 50)
    await executor.batch(
      Array.from({ length: Math.min(50, 97 - start) }, (_, n) => ({
        sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES (?, ?, '2026-10-29T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        params: [`${org.orgId}-${100 + start + n}`, org.orgId],
      })),
    );
  await createAuditSealRepository(executor).seal(org);
  const refilled = (await chain()).journal_bytes as number;
  expect(refilled).toBeGreaterThan(lowWater);
  expect(refilled).toBeLessThan(budget - Math.ceil(budget / 100));
  expect(await evict(budget, 1)).toEqual({ outcome: 'retained' });
});

it('clears a reached cycle target even when the journal is empty', async () => {
  await seed(3);
  expect(await evict()).toMatchObject({ outcome: 'evicted', evicted: 3 });
  await run('UPDATE audit_chain SET capacity_evict_to = 0 WHERE org_id = ?', org.orgId);
  expect(await evict()).toEqual({ outcome: 'retained' });
  expect((await chain()).capacity_evict_to).toBeNull();
});

it('evicts nothing when the budget is raised during an unfinished cycle', async () => {
  await seed(100);
  const budget = (await chain()).journal_bytes as number;
  expect(await evict(budget, 1)).toMatchObject({ outcome: 'evicted', evicted: 1 });
  const before = await chain();
  expect(before.capacity_evict_to).toBe(budget - Math.ceil(budget / 20));
  const raised = budget * 2;
  expect(before.journal_bytes as number).toBeLessThanOrEqual(raised - Math.ceil(raised / 20));
  expect(await evict(raised, 1)).toEqual({ outcome: 'retained' });
  expect(await chain()).toMatchObject({
    boundary_seq: before.boundary_seq,
    journal_bytes: before.journal_bytes,
    capacity_evict_to: null,
  });
});
