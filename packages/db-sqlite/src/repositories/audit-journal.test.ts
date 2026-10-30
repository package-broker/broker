import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import { fixedClock } from '@package-broker/core/ids';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { JOURNAL_TIME, seedAuditJournal } from '../testing/audit-journal-fixture.js';
import { createAuditJournalReader } from './audit-query.js';
import { createAuditTrailServices } from './api-services.js';

let database: MigratedDatabase;
beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
});
afterEach(async () => {
  await database.close();
});
const orgs = () => database.orgs!;

it('pages by sequence, survives a removed cursor, and includes source IP by default', async () => {
  const { a, b } = orgs();
  await seedAuditJournal(database.executor, a);
  await seedAuditJournal(database.executor, b);
  const reader = createAuditJournalReader(database.executor, a);
  const first = await reader.list({ projectId: null, limit: 2 });
  expect(first.items.map((row) => row.seq)).toEqual([1, 2]);
  expect(first.next).toBe(2);
  expect(first.items[0]).toMatchObject({ kind: 'event', orgId: a.orgId, sourceIp: '203.0.113.7' });
  expect(first.items[0]).not.toHaveProperty('payload_json');
  await database.executor.batch([
    { sql: 'DELETE FROM audit_event WHERE org_id = ? AND seq = ?', params: [a.orgId, 2] },
  ]);
  const second = await reader.list({ projectId: null, afterSeq: first.next!, limit: 2 });
  expect(second.items.map((row) => row.seq)).toEqual([3, 4]);
  expect(second.next).toBe(4);
  const third = await reader.list({ projectId: null, afterSeq: second.next!, limit: 2 });
  expect(third.items.map((row) => row.seq)).toEqual([5]);
  expect(third.next).toBeNull();
});

it.each([
  [{ projectId: 'project-a' }, [1, 3, 5]],
  [{ projectId: 'project-b' }, [2, 4]],
  [{ projectId: null, actor: 'unknown' }, []],
  [{ projectId: null, action: 'source.update' }, [1, 2, 3, 4, 5]],
  [{ projectId: 'project-a', action: 'source.update', afterSeq: 1 }, [3, 5]],
] as const)('filters %j', async (filter, seqs) => {
  await seedAuditJournal(database.executor, orgs().a);
  const page = await createAuditJournalReader(database.executor, orgs().a).list({
    ...filter,
    limit: 200,
  });
  expect(page.items.map((row) => row.seq)).toEqual(seqs);
  expect(page.next).toBeNull();
});

it('withholds stored URL credentials while retaining safe chain fields', async () => {
  const { a } = orgs();
  await seedAuditJournal(database.executor, a, 1);
  const unsafe = 'https://user:password@host.test/repo?token=secret';
  await database.executor.batch([
    {
      sql: "UPDATE audit_event SET payload_json = json_set(payload_json, '$.changes.url.new', ?) WHERE org_id = ? AND seq = ?",
      params: [unsafe, a.orgId, 1],
    },
  ]);
  const { items } = await createAuditJournalReader(database.executor, a).list({
    projectId: null,
    limit: 200,
  });
  expect(items).toEqual([
    expect.objectContaining({
      kind: 'withheld',
      orgId: a.orgId,
      seq: 1,
      hash: '1'.repeat(64),
      reasonCode: 'content_unavailable',
    }),
  ]);
  expect(items[0]).not.toHaveProperty('payloadJson');
  expect(items[0]).not.toHaveProperty('sourceIp');
  expect(items[0]).not.toHaveProperty('tokenSelector');
  expect(JSON.stringify(items).includes(unsafe)).toBe(false);
});

it('reads the persistent head and boundary after pruning, including an empty verified range', async () => {
  const { a, b } = orgs();
  await seedAuditJournal(database.executor, a);
  await seedAuditJournal(database.executor, b, 2);
  await database.executor.batch([
    { sql: 'DELETE FROM audit_event WHERE org_id = ?', params: [a.orgId] },
    {
      sql: 'UPDATE audit_chain SET boundary_seq = 6, boundary_prev_hash = head_hash, verified_from_seq = 6, verified_through_seq = 5, verified_bodies = 0, verified_withheld = 0, verified_at = ? WHERE org_id = ?',
      params: [JOURNAL_TIME, a.orgId],
    },
    {
      sql: "INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type) VALUES ('pending', ?, ?, 'system', 'org.update', 'organization')",
      params: [a.orgId, JOURNAL_TIME],
    },
  ]);
  expect(await createAuditJournalReader(database.executor, a).head()).toEqual({
    chainId: expect.stringMatching(/^[0-9a-f]{32}$/),
    epoch: 0,
    headSeq: 5,
    headHash: '5'.repeat(64),
    boundarySeq: 6,
    boundaryPrevHash: '5'.repeat(64),
    pendingCount: 1,
    verification: { fromSeq: 6, throughSeq: 5, bodies: 0, withheld: 0, verifiedAt: JOURNAL_TIME },
  });
  expect(await createAuditJournalReader(database.executor, b).head()).toMatchObject({
    headSeq: 2,
    pendingCount: 0,
    verification: null,
  });
});

it('returns genesis for an empty organization and fails closed for a missing chain', async () => {
  expect(await createAuditJournalReader(database.executor, orgs().a).head()).toMatchObject({
    headSeq: 0,
    headHash: '0'.repeat(64),
    boundarySeq: 1,
    verification: null,
  });
  await expect(
    createAuditJournalReader(database.executor, orgContext('missing')).head(),
  ).rejects.toThrow('Audit journal unavailable');
});

it.each([0, 201, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'rejects limit %s before querying',
  async (limit) => {
    const all = vi.fn();
    const reader = createAuditJournalReader({ ...database.executor, all }, orgs().a);
    await expect(reader.list({ projectId: null, limit })).rejects.toThrow(RangeError);
    expect(all).not.toHaveBeenCalled();
  },
);
it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'rejects cursor %s before querying',
  async (afterSeq) => {
    const all = vi.fn();
    const reader = createAuditJournalReader({ ...database.executor, all }, orgs().a);
    await expect(reader.list({ projectId: null, afterSeq, limit: 2 })).rejects.toThrow(
      'Invalid audit journal cursor',
    );
    expect(all).not.toHaveBeenCalled();
  },
);

it('binds assembly to the captured organization and uses core verification deduplication', async () => {
  const { a, b } = orgs();
  await seedAuditJournal(database.executor, a, 1);
  await seedAuditJournal(database.executor, b, 2);
  const mutableOrg = { orgId: a.orgId } as typeof a;
  const enqueue = vi.fn(async () => ({ id: 'job', created: false }));
  const services = createAuditTrailServices(
    database.executor,
    mutableOrg,
    { enqueue, get: async () => null },
    fixedClock(JOURNAL_TIME),
  );
  Object.assign(mutableOrg, { orgId: b.orgId });
  expect(await services.journal.head()).toMatchObject({ headSeq: 1 });
  // @ts-expect-error plugin-facing methods do not accept organization contexts
  expect(await services.journal.head(b)).toMatchObject({ headSeq: 1 });
  await services.requestVerification();
  await services.requestVerification();
  expect(enqueue).toHaveBeenCalledTimes(2);
  for (const call of enqueue.mock.calls)
    expect(call).toEqual([
      a,
      'core:audit-verify:v1',
      {},
      { idempotencyKey: 'audit-verify:2026-10-28T00:00', resourceKey: 'audit-verify' },
    ]);
});

it.each([
  ['action', 'unknown.action'],
  ['source_ip', 'hidden@example.test'],
] as const)(
  'pages past an unreadable %s and counts it without exposing envelope fields',
  async (column, value) => {
    const { a } = orgs();
    await seedAuditJournal(database.executor, a, 3);
    await database.executor.batch([
      {
        sql: `UPDATE audit_event SET ${column} = ? WHERE org_id = ? AND seq = ?`,
        params: [value, a.orgId, 2],
      },
    ]);
    const counter = vi.fn();
    const { journal: reader } = createAuditTrailServices(
      database.executor,
      a,
      { enqueue: async () => ({ id: 'job', created: false }), get: async () => null },
      fixedClock(JOURNAL_TIME),
      { counter },
    );
    const first = await reader.list({ projectId: null, limit: 2 });
    const head = await reader.head();
    expect(first.items[1]).toEqual({
      kind: 'withheld',
      reasonCode: 'unreadable',
      markerId: expect.any(String),
      orgId: a.orgId,
      chainId: head.chainId,
      epoch: head.epoch,
      seq: 2,
      prevHash: '1'.repeat(64),
      hash: '2'.repeat(64),
    });
    expect(first.next).toBe(2);
    expect(counter.mock.calls).toEqual([['pb.audit.journal_unreadable']]);
    const second = await reader.list({ projectId: null, afterSeq: first.next!, limit: 2 });
    expect(second.items.map((item) => item.seq)).toEqual([3]);
    expect(second.next).toBeNull();
    expect(JSON.stringify(first)).not.toContain(value);
  },
);

it('limits retained events to the persistent boundary and head sequence window', async () => {
  const { a } = orgs();
  await seedAuditJournal(database.executor, a);
  await database.executor.batch([
    {
      sql: 'UPDATE audit_chain SET boundary_seq = 2, head_seq = 4 WHERE org_id = ?',
      params: [a.orgId],
    },
  ]);
  const reader = createAuditJournalReader(database.executor, a);
  const first = await reader.list({ projectId: null, limit: 2 });
  expect(first.items.map((item) => item.seq)).toEqual([2, 3]);
  expect(first.next).toBe(3);
  const second = await reader.list({ projectId: null, afterSeq: first.next!, limit: 2 });
  expect(second.items.map((item) => item.seq)).toEqual([4]);
  expect(second.next).toBeNull();
});
