import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import type { JobContext } from '../platform/jobs.js';
import { createObservability, type ObsRecord } from '../platform/observability.js';
import { AUDIT_GENESIS_HASH, hashRow, type AuditRow } from './chain.js';
import { auditVerifyJob, requestVerification, type AuditVerifySnapshot } from './verify.js';

const SENTINEL = 'PRIVATE-AUDIT-SENTINEL';
const org = orgContext('org-1');
let chain: AuditRow[];

beforeAll(async () => {
  chain = [];
  let prev = AUDIT_GENESIS_HASH;
  for (let seq = 1; seq <= 1200; seq += 1) {
    const row: AuditRow = {
      id: `row-${seq}`,
      org_id: org.orgId,
      seq,
      prev_hash: prev,
      hash: '',
      created_at: '2026-10-16T09:00:00.000Z',
      actor_type: 'system',
      actor_id: null,
      token_selector: null,
      source_ip: SENTINEL,
      action: 'role.create',
      target_type: 'role',
      target_id: null,
      project_id: null,
      payload_json: SENTINEL,
    };
    row.hash = await hashRow(prev, row);
    chain.push(row);
    prev = row.hash;
  }
});

function setup(rows: readonly AuditRow[] = chain) {
  const records: ObsRecord[] = [];
  const abort = new AbortController();
  const page = vi.fn(async (_ctx: typeof org, after: number, limit: number) =>
    rows.filter((row) => row.seq > after).slice(0, limit),
  );
  const observability = createObservability(
    {
      emit: (record) => {
        records.push(record);
      },
    },
    { deploymentId: 'test', runtime: 'node', requestId: null },
    {
      events: new Set(['audit.verified', 'audit.chain_broken', 'audit.verify_partial']),
      reasonCodes: new Set(),
      routeTemplates: new Set(),
    },
  );
  const now = vi.fn(() => new Date('2026-10-22T12:00:00.000Z'));
  const markVerified = vi.fn<
    (
      ctx: typeof org,
      completedAt: string,
      scope: import('./verify.js').AuditVerificationScope,
      snapshot: AuditVerifySnapshot,
    ) => Promise<boolean>
  >(async () => true);
  const context = {
    org,
    signal: abort.signal,
    observability,
    jobId: 'verify-run',
    ports: {
      clock: { now },
      platform: { jobs: { enqueue: vi.fn(async () => ({ id: 'continuation', created: true })) } },
    },
  } as unknown as JobContext;
  const snapshot: AuditVerifySnapshot = {
    chain_id: 'a'.repeat(32),
    epoch: 0,
    incarnation: 0,
    mode_generation: 0,
    boundary_seq: 1,
    boundary_prev_hash: AUDIT_GENESIS_HASH,
    stored_seq: 0,
    stored_hash: AUDIT_GENESIS_HASH,
    head_seq: rows.at(-1)?.seq ?? 0,
    head_hash: rows.at(-1)?.hash ?? AUDIT_GENESIS_HASH,
  };
  const readSnapshot = vi.fn(async () => ({ ...snapshot }));
  const job = auditVerifyJob({
    page,
    markVerified,
    snapshot: readSnapshot,
    clearVerification: vi.fn(),
  });
  return {
    snapshot,
    readSnapshot,
    context,
    records,
    now,
    markVerified,
    abort,
    page,
    job,
    run: () => job.handler({}, context),
    logs: () => records.flatMap((record) => (record.kind === 'log' ? [record.record] : [])),
  };
}

function expectBroken(s: ReturnType<typeof setup>, seq: number, reason: string) {
  expect(s.markVerified).not.toHaveBeenCalled();
  expect(s.logs()).toHaveLength(1);
  expect(s.logs()[0]).toMatchObject({ level: 'error', event: 'audit.chain_broken', seq, reason });
  expect(s.records.filter((r) => r.kind === 'counter')).toEqual([
    { kind: 'counter', name: 'pb.audit.chain_broken', labels: {}, value: 1 },
  ]);
  expect(JSON.stringify(s.records)).not.toContain(SENTINEL);
}

describe('auditVerifyJob', () => {
  it('records bodies and withheld payloads separately without exporting stored bytes', async () => {
    const first = {
      ...chain[0]!,
      source_ip: null,
      payload_json:
        '{"op_id":"01J0QPAD000000000000000000","request_id":"7c9e6679-7425-40de-944b-e07fc1f90ae7"}',
    };
    first.hash = await hashRow(first.prev_hash, first);
    const second = { ...chain[1]!, prev_hash: first.hash };
    second.hash = await hashRow(second.prev_hash, second);
    const s = setup([first, second]);
    await s.run();
    expect(s.markVerified).toHaveBeenCalledWith(
      org,
      expect.any(String),
      {
        fromSeq: 1,
        throughSeq: 2,
        bodies: 1,
        withheld: 1,
      },
      s.snapshot,
    );
    expect(JSON.stringify(s.records)).not.toContain(SENTINEL);
    expect(JSON.stringify(s.records)).not.toContain('7c9e6679');
    expect(s.logs()).toEqual([expect.objectContaining({ from_seq: 1, bodies: 1, withheld: 1 })]);
  });

  it('counts key-reordered json_set payloads as bodies', async () => {
    const row = {
      ...chain[0]!,
      source_ip: null,
      payload_json:
        '{"request_id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","op_id":"01J0QPAD000000000000000000"}',
    };
    row.hash = await hashRow(row.prev_hash, row);
    const s = setup([row]);
    await s.run();
    expect(s.markVerified.mock.calls[0]?.[2]).toMatchObject({ bodies: 1, withheld: 0 });
  });

  it('counts a stored token json_set patch as a body', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      const row = {
        ...chain[0]!,
        action: 'token.rotate',
        source_ip: null,
        payload_json: JSON.stringify({
          op_id: '01J0QPAD000000000000000000',
          request_id: '01J0QPAD000000000000000000',
          changes: {
            replacement_id: { new: '01J0QPAD000000000000000000' },
            overlap_days: { new: 7 },
          },
        }),
      };
      row.payload_json = (
        database
          .prepare("SELECT json_set(?, '$.changes.expires_at', json_object('new', ?)) AS payload")
          .get(row.payload_json, '2026-10-28T00:00:00.000Z') as { payload: string }
      ).payload;
      row.hash = await hashRow(row.prev_hash, row);
      const s = setup([row]);
      await s.run();
      expect(s.markVerified.mock.calls[0]?.[2]).toMatchObject({ bodies: 1, withheld: 0 });
    } finally {
      database.close();
    }
  });

  it.each([1, 2])('detects a consistent rewrite at or below stored head %s', async (storedSeq) => {
    let prev = AUDIT_GENESIS_HASH;
    const rewritten = [];
    for (const original of chain.slice(0, 3)) {
      const row = { ...original, prev_hash: prev, payload_json: 'rewritten' };
      row.hash = await hashRow(prev, row);
      rewritten.push(row);
      prev = row.hash;
    }
    const s = setup(rewritten);
    s.snapshot.stored_seq = storedSeq;
    s.snapshot.stored_hash = chain[storedSeq - 1]!.hash;
    await s.run();
    expectBroken(s, storedSeq, 'hash');
  });

  it('detects newest rows deleted down to the stored head during verification', async () => {
    const s = setup();
    s.snapshot.stored_seq = 500;
    s.snapshot.stored_hash = chain[499]!.hash;
    s.page.mockImplementation(async (_ctx, after) => (after === 0 ? chain.slice(0, 500) : []));
    await s.run();
    expectBroken(s, 500, 'seq_gap');
  });

  it('detects a missing retained prefix above sequence one', async () => {
    const s = setup(chain.slice(501));
    s.snapshot.boundary_seq = 501;
    s.snapshot.boundary_prev_hash = chain[499]!.hash;
    await s.run();
    expectBroken(s, 502, 'seq_gap');
  });

  it('detects a boundary previous hash mismatch', async () => {
    const s = setup(chain.slice(500));
    s.snapshot.boundary_seq = 501;
    s.snapshot.boundary_prev_hash = AUDIT_GENESIS_HASH;
    await s.run();
    expectBroken(s, 501, 'prev_hash');
  });

  it('checks the stored head immediately before the retained boundary', async () => {
    const s = setup(chain.slice(500));
    Object.assign(s.snapshot, {
      boundary_seq: 501,
      boundary_prev_hash: chain[499]!.hash,
      stored_seq: 500,
      stored_hash: 'a'.repeat(64),
    });
    await s.run();
    expectBroken(s, 500, 'hash');
  });

  it('detects a head hash mismatch at equal sequence', async () => {
    const s = setup(chain.slice(0, 1));
    s.snapshot.head_hash = 'a'.repeat(64);
    await s.run();
    expectBroken(s, 1, 'hash');
  });

  it('throws on an invalid snapshot', async () => {
    const s = setup([]);
    s.snapshot.boundary_seq = 0;
    await expect(s.run()).rejects.toThrow('audit verification snapshot invalid');
    expect(s.page).not.toHaveBeenCalled();
  });

  it.each([
    'chain_id',
    'epoch',
    'incarnation',
    'mode_generation',
    'boundary_seq',
    'boundary_prev_hash',
  ] as const)('reports partial instead of broken after concurrent %s change', async (field) => {
    const s = setup(chain.slice(1));
    s.readSnapshot.mockResolvedValueOnce({ ...s.snapshot });
    if (typeof s.snapshot[field] === 'number') Object.assign(s.snapshot, { [field]: 2 });
    else Object.assign(s.snapshot, { [field]: 'b'.repeat(64) });
    await s.run();
    expect(s.logs()).toEqual([expect.objectContaining({ event: 'audit.verify_partial' })]);
    expect(s.records.filter((r) => r.kind === 'counter')).toEqual([]);
    expect(s.markVerified).not.toHaveBeenCalled();
  });

  it('caps pages, enqueues an idempotent cursor, and completes only in the continuation', async () => {
    const s = setup();
    for (const row of chain.slice(0, 20)) s.page.mockResolvedValueOnce([row]);
    await s.run();
    expect(s.page).toHaveBeenCalledTimes(20);
    expect(s.markVerified).not.toHaveBeenCalled();
    const enqueue = vi.mocked(s.context.ports.platform!.jobs.enqueue);
    const [, , payload, options] = enqueue.mock.calls[0]!;
    expect(options).toMatchObject({
      resourceKey: 'audit-verify',
      idempotencyKey: expect.stringMatching(/^audit-verify:continue:[a-f0-9]{64}$/),
    });
    expect(payload).toMatchObject({
      cursor: {
        nextSeq: 21,
        prevHash: chain[19]!.hash,
        bodies: 0,
        withheld: 20,
        snapshot: s.snapshot,
      },
    });
    // A retried first job produces the same continuation and idempotency key.
    for (const row of chain.slice(0, 20)) s.page.mockResolvedValueOnce([row]);
    await s.run();
    expect(enqueue.mock.calls[1]).toEqual(enqueue.mock.calls[0]);
    await s.job.handler(s.job.validate(JSON.parse(JSON.stringify(payload))), s.context);
    expect(s.markVerified.mock.calls[0]?.[2]).toEqual({
      fromSeq: 1,
      throughSeq: 1200,
      bodies: 0,
      withheld: 1200,
    });
  });

  it.each(['mode_generation', 'head_seq'] as const)(
    'reports partial when %s changes between continuations',
    async (field) => {
      const s = setup();
      for (const row of chain.slice(0, 20)) s.page.mockResolvedValueOnce([row]);
      await s.run();
      const payload = vi.mocked(s.context.ports.platform!.jobs.enqueue).mock.calls[0]![2];
      s.snapshot[field] += 1;
      await s.job.handler(s.job.validate(payload), s.context);
      expect(s.page).toHaveBeenCalledTimes(20);
      expect(s.logs()).toEqual([expect.objectContaining({ event: 'audit.verify_partial' })]);
      expect(s.records.filter((r) => r.kind === 'counter')).toEqual([]);
      expect(s.markVerified).not.toHaveBeenCalled();
    },
  );

  it('verifies a retained suffix from its trusted boundary', async () => {
    const s = setup(chain.slice(500));
    s.snapshot.boundary_seq = 501;
    s.snapshot.boundary_prev_hash = chain[499]!.hash;
    await s.run();
    expect(s.markVerified).toHaveBeenCalledWith(
      org,
      expect.any(String),
      {
        fromSeq: 501,
        throughSeq: 1200,
        bodies: 0,
        withheld: 700,
      },
      s.snapshot,
    );
    expect(s.page.mock.calls[0]).toEqual([org, 500, 500]);
  });

  it('detects a missing newest suffix against the snapshotted head', async () => {
    const s = setup(chain.slice(0, 500));
    s.snapshot.head_seq = 1200;
    s.snapshot.head_hash = chain[1199]!.hash;
    await s.run();
    expectBroken(s, 500, 'seq_gap');
  });

  it('does not report success after a concurrent chain change', async () => {
    const s = setup([]);
    s.markVerified.mockResolvedValueOnce(false);
    await s.run();
    expect(s.logs()).toEqual([expect.objectContaining({ event: 'audit.verify_partial' })]);
  });

  it('requests verification with an organization-scoped idempotency key and lease', async () => {
    const enqueue = vi.fn(async () => ({ id: 'job', created: false }));
    const jobs = { enqueue, get: vi.fn() };
    const now = new Date('2026-10-22T12:00:01.000Z');
    await requestVerification(jobs, org, now);
    await requestVerification(jobs, org, now);
    expect(enqueue.mock.calls).toEqual(
      Array(2).fill([
        org,
        'core:audit-verify:v1',
        {},
        {
          idempotencyKey: 'audit-verify:2026-10-22T12:00',
          resourceKey: 'audit-verify',
        },
      ]),
    );
  });

  it.each([null, [], { extra: 'private' }, 'private'])('rejects invalid payloads', (payload) => {
    expect(() => setup([]).job.validate(payload)).toThrow('invalid_payload');
  });

  it('defines the daily job and accepts an empty payload', () => {
    const { job } = setup([]);
    expect(job).toMatchObject({
      name: 'audit-verify',
      version: 1,
      schedule: { everySeconds: 86400 },
      maxAttempts: 2,
    });
    expect(job.validate({})).toEqual({});
  });

  it('verifies 1200 rows across pages and emits only the head', async () => {
    const s = setup();
    await s.run();
    expect(s.page.mock.calls).toEqual([0, 500, 1000, 1200].map((after) => [org, after, 500]));
    expect(s.logs()).toHaveLength(1);
    expect(s.logs()[0]).toMatchObject({
      level: 'info',
      event: 'audit.verified',
      head_seq: 1200,
      head_hash: chain[1199]!.hash,
      rows: 1200,
    });
    expect(JSON.stringify(s.records)).not.toContain(SENTINEL);
  });

  it.each([0, 1200])('records completion time after verifying %s rows', async (count) => {
    const s = setup(chain.slice(0, count));
    const completedAt = '2026-10-22T12:34:56.789Z';
    s.page.mockImplementation(async (_ctx, after, limit) => {
      if (after === count) s.now.mockReturnValue(new Date(completedAt));
      return chain
        .slice(0, count)
        .filter((row) => row.seq > after)
        .slice(0, limit);
    });
    s.markVerified.mockImplementation(async () => {
      expect(s.logs()).toEqual([]);
      return true;
    });
    await s.run();
    expect(s.markVerified.mock.calls).toEqual([
      [
        org,
        completedAt,
        {
          fromSeq: 1,
          throughSeq: count,
          bodies: 0,
          withheld: count,
        },
        s.snapshot,
      ],
    ]);
  });

  it('does not record completion when a page read fails', async () => {
    const s = setup();
    s.page.mockRejectedValueOnce(new Error('read failed'));
    await expect(s.run()).rejects.toThrow('read failed');
    expect(s.markVerified).not.toHaveBeenCalled();
    expect(s.logs()).toEqual([]);
  });

  it('propagates a completion write failure without reporting success', async () => {
    const s = setup([]);
    s.markVerified.mockRejectedValueOnce(new Error('write failed'));
    await expect(s.run()).rejects.toThrow('write failed');
    expect(s.logs()).toEqual([]);
  });

  it('rejects a tampered payload at row 700', async () => {
    const s = setup(
      chain.map((row) => (row.seq === 700 ? { ...row, payload_json: 'tampered' } : row)),
    );
    await s.run();
    expectBroken(s, 700, 'hash');
    expect(s.page).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing row at the page boundary', async () => {
    const s = setup(chain.filter((row) => row.seq !== 501));
    await s.run();
    expectBroken(s, 502, 'seq_gap');
  });

  it('rejects a missing first row', async () => {
    const s = setup(chain.slice(1));
    await s.run();
    expectBroken(s, 2, 'seq_gap');
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, 9007199254740992n, NaN, Infinity, 1.5, 0, -1])(
    'reports an unsafe interior sequence %s using the last good sequence',
    async (seq) => {
      const s = setup([]);
      s.snapshot.head_seq = 1200;
      s.page.mockResolvedValueOnce([chain[0]!, { ...chain[1]!, seq: seq as number }]);
      await s.run();
      expectBroken(s, 1, 'seq_gap');
      expect(s.page).toHaveBeenCalledTimes(1);
    },
  );

  it.each([0, 500])(
    'reports the previous head when the next page starts unsafe after %s rows',
    async (head) => {
      const s = setup([]);
      s.snapshot.head_seq = 1200;
      if (head > 0) s.page.mockResolvedValueOnce(chain.slice(0, head));
      s.page.mockResolvedValueOnce([
        { ...chain[head]!, seq: 9007199254740992n as unknown as number },
      ]);
      await s.run();
      expectBroken(s, head, 'seq_gap');
      expect(s.page).toHaveBeenCalledTimes(head === 0 ? 1 : 2);
    },
  );

  it('reports an earlier hash break before an unsafe sequence', async () => {
    const s = setup([]);
    s.snapshot.head_seq = 1200;
    s.page.mockResolvedValueOnce([
      { ...chain[0]!, payload_json: 'tampered' },
      { ...chain[1]!, seq: Number.MAX_SAFE_INTEGER + 1 },
    ]);
    await s.run();
    expectBroken(s, 1, 'hash');
  });

  it('rejects a broken previous hash across pages', async () => {
    const s = setup(
      chain.map((row) => (row.seq === 501 ? { ...row, prev_hash: AUDIT_GENESIS_HASH } : row)),
    );
    await s.run();
    expectBroken(s, 501, 'prev_hash');
  });

  it('rejects a correctly hashed row from another organization', async () => {
    const row = { ...chain[500]!, org_id: 'org-2' };
    row.hash = await hashRow(row.prev_hash, row);
    const s = setup([...chain.slice(0, 500), row]);
    await s.run();
    expectBroken(s, 501, 'org_mismatch');
  });

  it('reports the first break before a later foreign row', async () => {
    const s = setup(
      chain.map((row) =>
        row.seq === 2
          ? { ...row, payload_json: 'tampered' }
          : row.seq === 3
            ? { ...row, org_id: 'org-2' }
            : row,
      ),
    );
    await s.run();
    expectBroken(s, 2, 'hash');
  });

  it('reports partial after aborting during the first read', async () => {
    const s = setup();
    s.page.mockImplementationOnce(async (_ctx, after, limit) => {
      s.abort.abort();
      return chain.filter((row) => row.seq > after).slice(0, limit);
    });
    await s.run();
    expect(s.page).toHaveBeenCalledTimes(1);
    expect(s.markVerified).not.toHaveBeenCalled();
    expect(s.logs()).toHaveLength(1);
    expect(s.logs()[0]).toMatchObject({ level: 'warn', event: 'audit.verify_partial', rows: 500 });
    expect(JSON.stringify(s.records)).not.toContain(SENTINEL);
  });

  it('does not read when already aborted', async () => {
    const s = setup();
    s.abort.abort();
    await s.run();
    expect(s.page).not.toHaveBeenCalled();
    expect(s.logs()).toHaveLength(1);
    expect(s.markVerified).not.toHaveBeenCalled();
    expect(s.logs()[0]).toMatchObject({ event: 'audit.verify_partial', rows: 0 });
  });

  it('reports partial when aborted during the terminal read', async () => {
    const s = setup([]);
    s.page.mockImplementationOnce(async () => {
      s.abort.abort();
      return [];
    });
    await s.run();
    expect(s.logs()).toHaveLength(1);
    expect(s.markVerified).not.toHaveBeenCalled();
    expect(s.logs()[0]).toMatchObject({ event: 'audit.verify_partial', rows: 0 });
  });

  it('reports the genesis head for an empty log', async () => {
    const s = setup([]);
    await s.run();
    expect(s.logs()).toHaveLength(1);
    expect(s.logs()[0]).toMatchObject({
      event: 'audit.verified',
      rows: 0,
      head_seq: 0,
      head_hash: AUDIT_GENESIS_HASH,
    });
  });
});
