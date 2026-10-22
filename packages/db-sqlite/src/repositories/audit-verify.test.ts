import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_GENESIS_HASH } from '@package-broker/core/audit/chain';
import { auditVerifyJob } from '@package-broker/core/audit/verify';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { noopObservability, type LogRecord } from '@package-broker/core/platform/observability';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAuditQueryRepository } from './audit-query.js';
import { createAuditSealRepository } from './audit-seal.js';
import { createAuditVerifyReader } from './audit-verify.js';

let database: MigratedDatabase | undefined;
afterEach(async () => database?.close());

describe('audit verification reader on node:sqlite', () => {
  it('pages the sealed chain, isolates organizations and detects tampering', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const { executor } = database;
    const { a, b } = database.orgs!;
    const seal = createAuditSealRepository(executor);
    for (const org of [a, b]) {
      for (let start = 0; start < 503; start += 50) {
        await executor.batch(
          Array.from({ length: Math.min(50, 503 - start) }, (_, offset) => ({
            sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
                VALUES (?, ?, '2026-10-18T00:00:00.000Z', 'system', 'org.update', 'organization')`,
            params: [`${org.orgId}-${String(start + offset).padStart(4, '0')}`, org.orgId],
          })),
        );
      }
      while ((await seal.seal(org)).outcome === 'sealed') {
        /* drain pending pages */
      }
    }
    const reader = createAuditVerifyReader(executor);
    expect(await reader.page(a, 0, 2)).toEqual([
      expect.objectContaining({ org_id: a.orgId, seq: 1 }),
      expect.objectContaining({ org_id: a.orgId, seq: 2 }),
    ]);
    expect((await reader.page(a, 500, 500)).map((row) => row.seq)).toEqual([501, 502, 503]);
    expect(await reader.page(a, 503, 500)).toEqual([]);
    const records: LogRecord[] = [];
    let now = new Date('2026-10-22T12:00:00.000Z');
    const ctx: JobContext = {
      org: a,
      jobId: 'verify',
      idempotencyKey: 'verify',
      attempt: 1,
      fence: 1,
      signal: new AbortController().signal,
      ports: {
        organizations: { get: async () => null },
        clock: { now: () => now },
        ids: { ulid: () => 'id' },
      },
      observability: { ...noopObservability, log: (record) => void records.push(record) },
    };
    const job = auditVerifyJob(reader);
    await job.handler({}, ctx);
    expect(records).toContainEqual(
      expect.objectContaining({ event: 'audit.verified', rows: 503, head_seq: 503 }),
    );
    const query = createAuditQueryRepository(executor);
    expect((await query.head(a))?.lastVerifiedAt).toBe(now.toISOString());
    expect((await query.head(b))?.lastVerifiedAt).toBeNull();
    const lastVerifiedAt = now.toISOString();
    now = new Date('2026-10-23T12:00:00.000Z');
    records.length = 0;
    await executor.batch([
      {
        sql: "UPDATE audit_event SET action = 'org.delete' WHERE org_id = ? AND seq = 501",
        params: [a.orgId],
      },
    ]);
    await job.handler({}, ctx);
    expect(records).toEqual([
      { level: 'error', event: 'audit.chain_broken', seq: 501, reason: 'hash' },
    ]);
    expect((await query.head(a))?.lastVerifiedAt).toBe(lastVerifiedAt);
    records.length = 0;
    await job.handler({}, { ...ctx, org: b });
    expect(records).toContainEqual(expect.objectContaining({ event: 'audit.verified', rows: 503 }));
    expect((await query.head(b))?.lastVerifiedAt).toBe(now.toISOString());
  });

  it('persists empty-chain verification and keeps overlapping completions monotonic per organization', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const { a, b } = database.orgs!;
    const reader = createAuditVerifyReader(database.executor);
    const query = createAuditQueryRepository(database.executor);
    const earlier = '2026-10-22T11:00:00.000Z';
    const later = '2026-10-22T12:00:00.000Z';
    expect(await query.head(a)).toBeNull();
    await reader.markVerified(a, later);
    await reader.markVerified(a, earlier);
    await reader.markVerified(a, later);
    expect(await query.head(a)).toEqual({
      seq: 0,
      hash: AUDIT_GENESIS_HASH,
      pending: 0,
      lastVerifiedAt: later,
    });
    expect(await query.head(b)).toBeNull();
    await reader.markVerified(b, earlier);
    expect((await query.head(b))?.lastVerifiedAt).toBe(earlier);
    expect((await query.head(a))?.lastVerifiedAt).toBe(later);
  });

  it('rejects unbounded pages and invalid sequence cursors before querying', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const reader = createAuditVerifyReader(database.executor);
    const ctx = database.orgs!.a;
    for (const limit of [0, -1, 501, 1.5, NaN, Infinity]) {
      await expect(reader.page(ctx, 0, limit)).rejects.toThrow(RangeError);
    }
    for (const cursor of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(reader.page(ctx, cursor, 500)).rejects.toThrow(RangeError);
    }
  });
});
