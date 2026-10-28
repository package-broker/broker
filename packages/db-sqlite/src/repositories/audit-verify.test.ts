import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_GENESIS_HASH, hashRow } from '@package-broker/core/audit/chain';
import { auditVerifyJob } from '@package-broker/core/audit/verify';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { noopObservability, type LogRecord } from '@package-broker/core/platform/observability';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAuditQueryRepository } from './audit-query.js';
import { createAuditSealRepository } from './audit-seal.js';
import { clearAuditVerificationStatements, createAuditVerifyReader } from './audit-verify.js';

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
    await reader.markVerified(
      a,
      later,
      { fromSeq: 1, throughSeq: 0, bodies: 0, withheld: 0 },
      await reader.snapshot(a),
    );
    await reader.markVerified(
      a,
      earlier,
      { fromSeq: 1, throughSeq: 0, bodies: 0, withheld: 0 },
      await reader.snapshot(a),
    );
    await reader.markVerified(
      a,
      later,
      { fromSeq: 1, throughSeq: 0, bodies: 0, withheld: 0 },
      await reader.snapshot(a),
    );
    expect(await query.head(a)).toEqual({
      seq: 0,
      hash: AUDIT_GENESIS_HASH,
      pending: 0,
      lastVerifiedAt: later,
    });
    expect(await query.head(b)).toBeNull();
    await reader.markVerified(
      b,
      earlier,
      { fromSeq: 1, throughSeq: 0, bodies: 0, withheld: 0 },
      await reader.snapshot(b),
    );
    expect((await query.head(b))?.lastVerifiedAt).toBe(earlier);
    expect((await query.head(a))?.lastVerifiedAt).toBe(later);
  });

  it('fences completion against pruning, mode changes, epoch changes and incarnation changes', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const { executor, orgs } = database;
    const org = orgs!.a;
    const reader = createAuditVerifyReader(executor);
    for (const assignment of [
      'mode_generation = mode_generation + 1',
      'epoch = epoch + 1',
      'incarnation = incarnation + 1',
      'boundary_seq = 2',
    ]) {
      const snapshot = await reader.snapshot(org);
      await executor.batch([
        { sql: `UPDATE audit_chain SET ${assignment} WHERE org_id = ?`, params: [org.orgId] },
      ]);
      expect(
        await reader.markVerified(
          org,
          '2026-10-22T12:00:00.000Z',
          {
            fromSeq: 1,
            throughSeq: 0,
            bodies: 0,
            withheld: 0,
          },
          snapshot,
        ),
      ).toBe(false);
    }
    expect(
      (
        await executor.all({
          sql: 'SELECT verified_at FROM audit_chain WHERE org_id = ?',
          params: [org.orgId],
        })
      )[0],
    ).toEqual({ verified_at: null });
  });

  it('rejects completion after a concurrent append', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const { executor, orgs } = database;
    const org = orgs!.a;
    const reader = createAuditVerifyReader(executor);
    const snapshot = await reader.snapshot(org);
    await executor.batch([
      {
        sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
      VALUES ('append', ?, '2026-10-18T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        params: [org.orgId],
      },
    ]);
    await createAuditSealRepository(executor).seal(org);
    expect(
      await reader.markVerified(
        org,
        '2026-10-22T12:00:00.000Z',
        {
          fromSeq: 1,
          throughSeq: 0,
          bodies: 0,
          withheld: 0,
        },
        snapshot,
      ),
    ).toBe(false);
  });

  it('rejects a missing newest suffix even when deletion predates the verification snapshot', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const { executor, orgs } = database;
    const org = orgs!.a;
    await executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_seq = 2, head_hash = ? WHERE org_id = ?',
        params: ['a'.repeat(64), org.orgId],
      },
    ]);
    const reader = createAuditVerifyReader(executor);
    expect(await reader.snapshot(org)).toMatchObject({ head_seq: 2, head_hash: 'a'.repeat(64) });
    const log = noopObservability.log;
    const records: LogRecord[] = [];
    await auditVerifyJob(reader).handler({}, {
      org,
      signal: new AbortController().signal,
      ports: { clock: { now: () => new Date() } },
      observability: {
        ...noopObservability,
        log: (record: LogRecord) => {
          records.push(record);
          log(record);
        },
      },
    } as unknown as JobContext);
    expect(records).toEqual([
      { level: 'error', event: 'audit.chain_broken', seq: 0, reason: 'seq_gap' },
    ]);
  });

  it('keeps the persisted head hash authoritative at the same sequence', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const org = database.orgs!.a;
    await database.executor.batch([
      {
        sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
      VALUES ('head', ?, '2026-10-18T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        params: [org.orgId],
      },
    ]);
    await createAuditSealRepository(database.executor).seal(org);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_seq = 1, head_hash = ? WHERE org_id = ?',
        params: ['a'.repeat(64), org.orgId],
      },
    ]);
    const reader = createAuditVerifyReader(database.executor);
    expect(await reader.snapshot(org)).toMatchObject({ head_seq: 1, head_hash: 'a'.repeat(64) });
    const records: LogRecord[] = [];
    await auditVerifyJob(reader).handler({}, {
      org,
      signal: new AbortController().signal,
      ports: { clock: { now: () => new Date() } },
      observability: {
        ...noopObservability,
        log: (record: LogRecord) => void records.push(record),
      },
    } as unknown as JobContext);
    expect(records).toEqual([
      { level: 'error', event: 'audit.chain_broken', seq: 1, reason: 'hash' },
    ]);
  });

  it('clears scope and legacy completion only for the organization', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const reader = createAuditVerifyReader(database.executor);
    const { a, b } = database.orgs!;
    for (const org of [a, b]) {
      await reader.markVerified(
        org,
        '2026-10-22T12:00:00.000Z',
        {
          fromSeq: 1,
          throughSeq: 0,
          bodies: 0,
          withheld: 0,
        },
        await reader.snapshot(org),
      );
    }
    await reader.clearVerification(a);
    expect(await createAuditQueryRepository(database.executor).head(a)).toBeNull();
    const scope = (orgId: string) =>
      database!.executor.all({
        sql: 'SELECT verified_from_seq, verified_through_seq, verified_bodies, verified_withheld, verified_at FROM audit_chain WHERE org_id = ?',
        params: [orgId],
      });
    expect(await scope(a.orgId)).toEqual([
      {
        verified_from_seq: null,
        verified_through_seq: null,
        verified_bodies: null,
        verified_withheld: null,
        verified_at: null,
      },
    ]);
    expect(await scope(b.orgId)).toEqual([
      {
        verified_from_seq: 1,
        verified_through_seq: 0,
        verified_bodies: 0,
        verified_withheld: 0,
        verified_at: '2026-10-22T12:00:00.000Z',
      },
    ]);
  });

  it('records a retained suffix without setting the legacy full-history timestamp', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const org = database.orgs!.a;
    const reader = createAuditVerifyReader(database.executor);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_chain SET boundary_seq = 2, head_seq = 1 WHERE org_id = ?',
        params: [org.orgId],
      },
    ]);
    expect(
      await reader.markVerified(
        org,
        '2026-10-22T12:00:00.000Z',
        { fromSeq: 2, throughSeq: 1, bodies: 0, withheld: 0 },
        await reader.snapshot(org),
      ),
    ).toBe(true);
    expect(
      await database.executor.all({
        sql: 'SELECT audit_last_verified_at FROM organization WHERE id = ?',
        params: [org.orgId],
      }),
    ).toEqual([{ audit_last_verified_at: null }]);
    expect(
      await database.executor.all({
        sql: 'SELECT verified_from_seq, verified_at FROM audit_chain WHERE org_id = ?',
        params: [org.orgId],
      }),
    ).toEqual([{ verified_from_seq: 2, verified_at: '2026-10-22T12:00:00.000Z' }]);
  });

  it('keeps the legacy timestamp unchanged when the completion CAS fails', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const org = database.orgs!.a;
    const reader = createAuditVerifyReader(database.executor);
    const scope = { fromSeq: 1, throughSeq: 0, bodies: 0, withheld: 0 };
    const earlier = '2026-10-22T11:00:00.000Z';
    expect(await reader.markVerified(org, earlier, scope, await reader.snapshot(org))).toBe(true);
    const snapshot = await reader.snapshot(org);
    await database.executor.batch([
      {
        sql: 'UPDATE audit_chain SET mode_generation = mode_generation + 1 WHERE org_id = ?',
        params: [org.orgId],
      },
    ]);
    expect(await reader.markVerified(org, '2026-10-22T12:00:00.000Z', scope, snapshot)).toBe(false);
    expect(
      await database.executor.all({
        sql: 'SELECT audit_last_verified_at FROM organization WHERE id = ?',
        params: [org.orgId],
      }),
    ).toEqual([{ audit_last_verified_at: earlier }]);
  });

  it('allows scope clearing to join the same atomic boundary-change batch', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const org = database.orgs!.a;
    const reader = createAuditVerifyReader(database.executor);
    await reader.markVerified(
      org,
      '2026-10-22T12:00:00.000Z',
      { fromSeq: 1, throughSeq: 0, bodies: 0, withheld: 0 },
      await reader.snapshot(org),
    );
    await expect(
      database.executor.batch([
        ...clearAuditVerificationStatements(org),
        { sql: 'SELECT json_extract(?, ?)', params: ['{', '$'] },
      ]),
    ).rejects.toThrow();
    expect((await createAuditQueryRepository(database.executor).head(org))?.lastVerifiedAt).toBe(
      '2026-10-22T12:00:00.000Z',
    );
    await database.executor.batch([
      {
        sql: 'UPDATE audit_chain SET mode_generation = mode_generation + 1 WHERE org_id = ?',
        params: [org.orgId],
      },
      ...clearAuditVerificationStatements(org),
    ]);
    expect(await createAuditQueryRepository(database.executor).head(org)).toBeNull();
  });

  it('retains and checks the persisted checkpoint when the journal is ahead', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const org = database.orgs!.a;
    const { executor } = database;
    await executor.batch(
      Array.from({ length: 3 }, (_, i) => ({
        sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES (?, ?, '2026-10-18T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        params: [`row-${i}`, org.orgId],
      })),
    );
    await createAuditSealRepository(executor).seal(org);
    const reader = createAuditVerifyReader(executor);
    const original = await reader.page(org, 0, 500);
    await executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_seq = 2, head_hash = ? WHERE org_id = ?',
        params: [original[1]!.hash, org.orgId],
      },
    ]);
    const snapshot = await reader.snapshot(org);
    expect(snapshot).toMatchObject({
      stored_seq: 2,
      stored_hash: original[1]!.hash,
      head_seq: 3,
      head_hash: original[2]!.hash,
    });
    let prev = AUDIT_GENESIS_HASH;
    for (const old of original) {
      const row = { ...old, prev_hash: prev, action: 'org.delete' };
      row.hash = await hashRow(prev, row);
      await executor.batch([
        {
          sql: 'UPDATE audit_event SET prev_hash = ?, hash = ?, action = ? WHERE org_id = ? AND seq = ?',
          params: [prev, row.hash, row.action, org.orgId, row.seq],
        },
      ]);
      prev = row.hash;
    }
    const records: LogRecord[] = [];
    await auditVerifyJob(reader).handler({}, {
      org,
      signal: new AbortController().signal,
      ports: { clock: { now: () => new Date() } },
      observability: {
        ...noopObservability,
        log: (record: LogRecord) => void records.push(record),
      },
    } as unknown as JobContext);
    expect(records).toEqual([
      { level: 'error', event: 'audit.chain_broken', seq: 2, reason: 'hash' },
    ]);
    // Keep the journal tail fixed to isolate the stored-head CAS.
    const beforeHeadChange = await reader.snapshot(org);
    await executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_hash = ? WHERE org_id = ?',
        params: ['a'.repeat(64), org.orgId],
      },
    ]);
    expect(
      await reader.markVerified(
        org,
        '2026-10-22T12:00:00.000Z',
        { fromSeq: 1, throughSeq: 3, bodies: 0, withheld: 3 },
        beforeHeadChange,
      ),
    ).toBe(false);
  });

  it('reports deletion of newest rows through the stored head as broken', async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    const org = database.orgs!.a;
    const { executor } = database;
    await executor.batch(
      Array.from({ length: 3 }, (_, i) => ({
        sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
        VALUES (?, ?, '2026-10-18T00:00:00.000Z', 'system', 'org.update', 'organization')`,
        params: [`row-${i}`, org.orgId],
      })),
    );
    await createAuditSealRepository(executor).seal(org);
    const reader = createAuditVerifyReader(executor);
    const original = await reader.page(org, 0, 500);
    await executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_seq = 2, head_hash = ? WHERE org_id = ?',
        params: [original[1]!.hash, org.orgId],
      },
      { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq >= 2', params: [org.orgId] },
    ]);
    expect(await reader.snapshot(org)).toMatchObject({
      head_seq: 2,
      stored_seq: 2,
      stored_hash: original[1]!.hash,
    });
    const records: LogRecord[] = [];
    await auditVerifyJob(reader).handler({}, {
      org,
      signal: new AbortController().signal,
      ports: { clock: { now: () => new Date() } },
      observability: {
        ...noopObservability,
        log: (record: LogRecord) => void records.push(record),
      },
    } as unknown as JobContext);
    expect(records).toEqual([
      { level: 'error', event: 'audit.chain_broken', seq: 1, reason: 'seq_gap' },
    ]);
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
