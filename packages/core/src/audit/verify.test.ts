import { beforeAll, describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import type { JobContext } from '../platform/jobs.js';
import { createObservability, type ObsRecord } from '../platform/observability.js';
import { AUDIT_GENESIS_HASH, hashRow, type AuditRow } from './chain.js';
import { auditVerifyJob } from './verify.js';

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
  const markVerified = vi.fn<(ctx: typeof org, completedAt: string) => Promise<void>>(
    async () => undefined,
  );
  const context = {
    org,
    signal: abort.signal,
    observability,
    ports: { clock: { now } },
  } as unknown as JobContext;
  const job = auditVerifyJob({ page, markVerified });
  return {
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
    });
    await s.run();
    expect(s.markVerified.mock.calls).toEqual([[org, completedAt]]);
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
