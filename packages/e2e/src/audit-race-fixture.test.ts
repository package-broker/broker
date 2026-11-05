import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import { orgContext } from '@package-broker/core/db/port';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import { exportAuditBatch } from '@package-broker/core/audit/export';
import type { AuditExportOptions } from '@package-broker/core/audit/export';
import type { AuditBatchV1 } from '@package-broker/core/audit/plugin-api';
import { pruneAudit } from '@package-broker/core/audit/prune';
import { createAuditSealRepository } from '@package-broker/db-sqlite/repositories/audit-seal';
import { createAuditExportRepository } from '@package-broker/db-sqlite/repositories/audit-export';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createAuditPruneRepository } from '@package-broker/db-sqlite/repositories/audit-prune';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { auditRaceBundle, overlapRace, staleSealRace } from './audit-race-fixture.js';

async function fixture() {
  const db = await openMigratedDatabase({ twoOrganizations: true });
  const org = db.orgs!.a;
  const run = (sql: string, params: (string | number)[]) => db.executor.batch([{ sql, params }]);
  for (const ctx of [org, db.orgs!.b]) {
    await run(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type, target_id, payload_json)
      VALUES (?, ?, '2026-10-30T00:00:00.000Z', 'system', 'project.create', 'project', 'project', '{}')`,
      [ulid(), ctx.orgId],
    );
    await createAuditSealRepository(db.executor).seal(ctx);
    await run("UPDATE audit_chain SET mode = 'export' WHERE org_id = ?", [ctx.orgId]);
    for (const sink of ['webhook', 'otlp']) {
      await run(
        `INSERT INTO audit_sink (org_id, sink_id, plugin_id, kind, generation,
        receiver_fingerprint, durable_ack, activation_source, state, progress_seq, progress_hash,
        custody_seq, inflight_repr) VALUES (?, ?, 'audit', 'webhook', 1, 'fingerprint',
        ?, 'FIXTURE_URL', 'active', 0, ?, 0, '{"custodyFromSeq":1}')`,
        [ctx.orgId, sink, Number(sink === 'webhook'), '0'.repeat(64)],
      );
    }
  }
  // Retention has only one configured sink; overlap still captures the independent OTLP job.
  await run("UPDATE audit_sink SET state = 'inactive' WHERE org_id = ? AND sink_id = 'otlp'", [
    org.orgId,
  ]);
  const receipts: AuditBatchV1[] = [];
  const options = (id: string): AuditExportOptions => ({
    id,
    generation: 1,
    pluginVersion: '1.0',
    sourceIp: 'omit',
    now: () => new Date(),
    rejectionRetries: 'terminal',
    sink: {
      async deliver(batch) {
        receipts.push(batch);
        return {
          outcome: 'accepted',
          chainId: batch.chainId,
          epoch: batch.epoch,
          throughSeq: batch.throughSeq,
          throughHash: batch.throughHash,
        };
      },
    },
  });
  return { db, org, run, receipts, options };
}

function control(
  executor: SqlExecutor,
  options: (id: string) => AuditExportOptions,
  orgId: string,
  body: string,
  createPort = createAuditExportRepository,
) {
  let handler!: (c: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  const bundle = auditRaceBundle(
    `
function createAuditExportRepository(executor) { return realExport(executor); }
function auditExportJob(port, options) { return {}; }
app.get("/health/live", () => {});
  app.get("/health/ready", async (c) => {});
`,
    '/fixture',
    body,
  );
  runInNewContext(
    bundle +
      `
for (const id of ['webhook', 'otlp']) auditExportJob(createAuditExportRepository(executor), options(id));`,
    {
      executor,
      options,
      realExport: createPort,
      exportAuditBatch,
      createAuditSealRepository,
      createAuditPruneRepository,
      createJobRepository,
      pruneAudit,
      systemMutationFence,
      ulid,
      AbortController,
      resolveOrg: async () => orgContext(orgId),
      app: {
        post: (_path: string, route: typeof handler) => {
          handler = route;
        },
        get() {},
      },
    },
  );
  return (requestedOrg = orgId) =>
    handler({
      req: {
        json: async () => ({ orgId: requestedOrg }),
        raw: new Request('https://fixture.test'),
      },
      json: (body: unknown, status = 200) => ({ status, body }),
    });
}

describe('live-request audit race controls', () => {
  it('distinguishes cancellation from a real stale save with unchanged sink CAS state', async () => {
    const { db, org, run, options, receipts } = await fixture();
    try {
      await run("UPDATE audit_sink SET state = 'active' WHERE org_id = ? AND sink_id = 'otlp'", [
        org.orgId,
      ]);
      const request = control(db.executor, options, org.orgId, overlapRace);
      expect(await request('foreign')).toEqual({
        status: 409,
        body: { error: 'ForeignFixtureOrganization' },
      });
      const result = await request();
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
      expect(receipts).toHaveLength(4);
      expect(
        [receipts[0], receipts[1], receipts[3]].every(
          (batch) => JSON.stringify(batch) === JSON.stringify(receipts[0]),
        ),
      ).toBe(true);
      const foreign = await createAuditExportRepository(db.executor).read(db.orgs!.b, 'webhook');
      expect(foreign.sink.progressSeq).toBe(0);
      expect(
        await db.executor.all({ sql: 'SELECT id FROM job WHERE org_id = ?', params: [org.orgId] }),
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('exposes a removed lease predicate as an accepted stale save, independently of sink CAS', async () => {
    const { db, org, run, options } = await fixture();
    try {
      await run("UPDATE audit_sink SET state = 'active' WHERE org_id = ? AND sink_id = 'otlp'", [
        org.orgId,
      ]);
      const bypassLease = (executor: SqlExecutor) => {
        const port = createAuditExportRepository(executor);
        return {
          ...port,
          async save(...args: Parameters<typeof port.save>) {
            const [ctx, fence, expected, next] = args;
            if (fence.job.fence === 1 && next.progressSeq > expected.sink.progressSeq) {
              const [current] = await executor.all<{ id: string; owner: string; fence: number }>({
                sql: 'SELECT id, lease_owner AS owner, fence FROM job WHERE org_id = ? AND id = ?',
                params: [ctx.orgId, fence.job.id],
              });
              args[1] = systemMutationFence('audit-export', current!, {});
            }
            return port.save(...args);
          },
        };
      };
      const result = await control(db.executor, options, org.orgId, overlapRace, bypassLease)();
      expect(result.body).toMatchObject({
        sameSnapshot: true,
        staleOutcome: 'accepted',
        afterStale: 1,
        replacementOutcome: 'contended',
        attempts: [{ fence: 1, saved: true }],
      });
    } finally {
      await db.close();
    }
  });

  it('executes the stale batch only after a real winning seal, durable delivery and prune', async () => {
    const { db, org, options, run } = await fixture();
    try {
      await run(
        `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type, target_id, payload_json)
        VALUES (?, ?, '2026-10-30T00:00:00.000Z', 'system', 'project.create', 'project', 'project', '{}')`,
        [ulid(), org.orgId],
      );
      const result = await control(db.executor, options, org.orgId, staleSealRace)();
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        outcome: 'contended',
        attempted: 1,
        winner: 'sealed',
        delivered: 'accepted',
        ack: { progress_seq: 2, custody_seq: 2 },
        prune: 'pruned',
        pruned: { head_seq: 2, boundary_seq: 3 },
      });
      expect(result.body['afterStale']).toEqual(result.body['pruned']);
      expect(
        await db.executor.all({
          sql: 'SELECT seq FROM audit_event WHERE org_id = ?',
          params: [org.orgId],
        }),
      ).toEqual([]);
      expect(
        await db.executor.all({
          sql: 'SELECT seq FROM audit_event WHERE org_id = ?',
          params: [db.orgs!.b.orgId],
        }),
      ).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
