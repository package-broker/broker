import { expect, it, vi } from 'vitest';
import type { AuditJournalReader, AuditJournalItemV1 } from '../../audit/plugin-api.js';
import { auditCanonicalVectors } from '../../audit/plugin-testing.js';
import type { AuthenticatedSession } from '../../auth/session.js';
import { setAccessContext } from '../../authz/access-context.js';
import { orgContext } from '../../db/port.js';
import { fixedClock, ulid } from '../../ids.js';
import type { RequestContext } from '../../plugin.js';
import { auditExportRoutes, type AuditExportDeps } from './audit-export.js';

const user = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const org = orgContext('01ARZ3NDEKTSV4RRFFQ69G5FAW');
const chainId = 'a'.repeat(32);
const now = '2026-10-30T00:00:00.000Z';
function fixture(
  options: {
    admin?: boolean;
    permissions?: string[];
    fresh?: boolean;
    mismatch?: boolean;
    token?: boolean;
    anonymous?: boolean;
    head?: number;
    boundary?: number;
    items?: AuditJournalItemV1[];
  } = {},
) {
  const principal = options.anonymous ? null : { kind: 'user' as const, id: user };
  const permissions = options.permissions ?? ['org:audit:export'];
  const head = {
    chainId,
    epoch: 2,
    headSeq: options.head ?? 1,
    headHash: '1'.repeat(64),
    boundarySeq: options.boundary ?? 1,
    boundaryPrevHash: '0'.repeat(64),
    pendingCount: 0,
    verification: null,
  };
  const list = vi.fn<AuditJournalReader['list']>(async () => ({
    items: options.items ?? [],
    next: null,
  }));
  const record = vi.fn<AuditExportDeps['store']['record']>(async () => 'recorded');
  const authenticate = vi.fn(
    async () =>
      ({
        session: { id: options.mismatch ? 'other' : 'session', userId: user },
      }) as AuthenticatedSession,
  );
  const deps: AuditExportDeps = {
    store: {
      rateAvailable: vi.fn(async () => true),
      journal: () => ({ head: async () => head, list }),
      snapshot: vi.fn(async () => ({ head, policy: 'availability' as const, modeGeneration: 0 })),
      dispositions: vi.fn(async () => []),
      record,
    },
    sessions: { authenticate, isReauthFresh: () => options.fresh !== false },
    clientIp: () => '192.0.2.10',
    clock: fixedClock(now),
    ids: { ulid },
    alert: vi.fn(),
  };
  const route = auditExportRoutes(deps)[0]!;
  const call = async (query = '') => {
    const ctx: RequestContext = {
      request: new Request(`https://broker.test/_pb/audit/export${query}`),
      requestId: ulid(),
      org,
      principal,
      projectId: null,
      params: {},
      ports: { organizations: { get: async () => null }, clock: fixedClock(now), ids: { ulid } },
    };
    if (principal === null) return route.handler(ctx);
    setAccessContext(ctx, {
      principal,
      projectId: null,
      boundary: 'organization',
      sessionId: principal === null || options.token ? null : 'session',
      token: options.token ? { kind: 'pat', scope: 'full', readOnly: false } : null,
      actor:
        principal === null || options.token
          ? null
          : {
              session: { id: 'session', userId: user },
              user: { id: user },
              organizationPermissions: permissions,
              projectPermissions: [],
              protectedHolder: options.admin !== false,
            },
      rateKey:
        principal === null
          ? { stage: 'anonymous', ip: null, routeClass: 'organization' }
          : {
              stage: 'authenticated',
              tokenSelector: null,
              principalId: user,
              routeClass: 'organization',
            },
    });
    return route.handler(ctx);
  };
  return { call, deps, record, list, authenticate, route };
}

it.each([
  [{ admin: false }, 403],
  [{ permissions: ['org:audit:read'] }, 403],
  [{ permissions: ['project:audit:read'] }, 403],
  [{ anonymous: true }, 401],
  [{ token: true }, 401],
  [{ fresh: false }, 403],
  [{ mismatch: true }, 401],
])('denies %j before reading or recording', async (options, status) => {
  const f = fixture(options);
  expect((await f.call()).status).toBe(status);
  expect(f.deps.store.snapshot).not.toHaveBeenCalled();
  expect(f.record).not.toHaveBeenCalled();
});
it.each([
  '?from_seq=0',
  '?from_seq=2&to_seq=1',
  '?from_seq=1&to_seq=10001',
  '?from_seq=9007199254740992',
  '?from_seq=1&from_seq=2',
  '?token=secret',
])('rejects invalid range %s without recording access', async (query) => {
  const f = fixture({ head: 20000 });
  const response = await f.call(query);
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('secret');
  expect(f.record).not.toHaveBeenCalled();
});
it('returns snapshot pins, withheld markers and records the exact count and range', async () => {
  const withheld: AuditJournalItemV1 = {
    kind: 'withheld',
    reasonCode: 'unreadable',
    markerId: ulid(),
    chainId,
    epoch: 2,
    orgId: org.orgId,
    seq: 1,
    prevHash: '0'.repeat(64),
    hash: '1'.repeat(64),
  };
  const f = fixture({ items: [withheld] });
  const response = await f.call();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    schema: 'audit-chain/1',
    snapshot: { chainId, epoch: 2, headSeq: 1 },
    items: [
      {
        kind: 'withheld',
        reason_code: 'unreadable',
        marker_id: withheld.markerId,
        chain_id: chainId,
        epoch: 2,
        org_id: org.orgId,
        seq: 1,
        prev_hash: '0'.repeat(64),
        hash: '1'.repeat(64),
      },
    ],
    dispositions: [],
  });
  expect(f.record).toHaveBeenCalledOnce();
  expect(f.record.mock.calls[0]![3]).toMatchObject({
    action: 'audit.export',
    actor: { type: 'user', id: user },
  });
  expect(JSON.parse(f.record.mock.calls[0]![3].payloadJson)).toMatchObject({
    changes: {
      from_seq: { new: 1 },
      to_seq: { new: 1 },
      count: { new: 1 },
      format: { new: 'api' },
    },
  });
  expect(f.record.mock.calls[0]![4].map((entry) => entry.kind)).toEqual(['export']);
  expect(f.deps.alert).toHaveBeenCalledOnce();
});
it.each(['conflict', 'forbidden', 'rate_limited', 'payload_too_large', 'unavailable'] as const)(
  'withholds the response when recording returns %s',
  async (result) => {
    const f = fixture();
    f.record.mockResolvedValue(result);
    const response = await f.call();
    expect(response.status).toBe(
      {
        conflict: 409,
        forbidden: 403,
        rate_limited: 429,
        payload_too_large: 413,
        unavailable: 503,
      }[result],
    );
    if (result === 'rate_limited') expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.text()).not.toContain('snapshot');
  },
);
it('defaults to exactly 2000 sequence positions with a continuation cursor', async () => {
  const f = fixture({ head: 10000 });
  f.list.mockImplementation(async ({ afterSeq = 0, limit }) => {
    const items: AuditJournalItemV1[] = Array.from(
      { length: Math.min(limit, 10000 - afterSeq) },
      (_, index) => ({
        kind: 'withheld',
        reasonCode: 'unreadable',
        markerId: ulid(),
        chainId,
        epoch: 2,
        orgId: org.orgId,
        seq: afterSeq + index + 1,
        prevHash: '0'.repeat(64),
        hash: '1'.repeat(64),
      }),
    );
    return { items, next: afterSeq + limit < 10000 ? afterSeq + limit : null };
  });
  const response = await f.call();
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: unknown[]; next_from_seq: number | null };
  expect(body.items).toHaveLength(2000);
  expect(body.next_from_seq).toBe(2001);
  expect(f.list).toHaveBeenCalledTimes(1);
  expect(f.list).toHaveBeenLastCalledWith({ projectId: null, afterSeq: 0, limit: 2000 });
  expect(f.record.mock.calls[0]![4]).toHaveLength(1);
  expect(f.record.mock.calls[0]![4][0]).toMatchObject({
    kind: 'export',
    fromSeq: 1,
    toSeq: 2000,
    count: 2000,
  });
});
it('refuses data from another epoch before recording or returning records', async () => {
  const f = fixture({
    items: [
      {
        kind: 'withheld',
        reasonCode: 'unreadable',
        markerId: ulid(),
        chainId,
        epoch: 3,
        orgId: org.orgId,
        seq: 1,
        prevHash: '0'.repeat(64),
        hash: '1'.repeat(64),
      },
    ],
  });
  expect((await f.call()).status).toBe(409);
  expect(f.record).not.toHaveBeenCalled();
});
it('rejects a range beyond the sealed high-water mark', async () => {
  const f = fixture();
  expect((await f.call('?from_seq=1&to_seq=2')).status).toBe(409);
  expect(f.list).not.toHaveBeenCalled();
});

it('preserves canonical record bytes and maps every field to the versioned wire names', async () => {
  const vector = auditCanonicalVectors[0]!;
  const f = fixture({ items: [{ ...vector.record, chainId, epoch: 2, orgId: org.orgId }] });
  const response = await f.call();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(((await response.json()) as { items: unknown[] }).items).toEqual([
    { ...vector.wire, chain_id: chainId, epoch: 2, org_id: org.orgId },
  ]);
  expect(f.record.mock.calls[0]![4]).toHaveLength(1);
  expect(f.deps.alert).not.toHaveBeenCalled();
});
it('records an empty journal export without inventing an event', async () => {
  const f = fixture({ head: 0 });
  const response = await f.call();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    snapshot: { headSeq: 0 },
    fromSeq: 0,
    toSeq: 0,
    next_from_seq: null,
    items: [],
  });
  expect(JSON.parse(f.record.mock.calls[0]![3].payloadJson).changes).toMatchObject({
    from_seq: { new: 0 },
    to_seq: { new: 0 },
  });
  expect(f.record.mock.calls[0]![4][0]).toMatchObject({ kind: 'export', count: 0 });
});

it('refuses a limited request before any journal or disposition read', async () => {
  const f = fixture();
  vi.mocked(f.deps.store.rateAvailable).mockResolvedValue(false);
  const response = await f.call();
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(f.deps.store.snapshot).not.toHaveBeenCalled();
  expect(f.list).not.toHaveBeenCalled();
  expect(f.deps.store.dispositions).not.toHaveBeenCalled();
});
it.each(['?from_seq=1', '?to_seq=1', '?from_seq=2&to_seq=2'])(
  'refuses explicit ranges on an empty journal: %s',
  async (query) => {
    const f = fixture({ head: 0 });
    expect((await f.call(query)).status).toBe(409);
    expect(f.record).not.toHaveBeenCalled();
  },
);
it('repeated withheld exports write only one export row each and preserve source IP', async () => {
  const f = fixture({
    items: [
      {
        kind: 'withheld',
        reasonCode: 'unreadable',
        markerId: ulid(),
        chainId,
        epoch: 2,
        orgId: org.orgId,
        seq: 1,
        prevHash: '0'.repeat(64),
        hash: '1'.repeat(64),
      },
    ],
  });
  for (let i = 0; i < 3; i++) expect((await f.call()).status).toBe(200);
  for (const call of f.record.mock.calls) {
    expect(call[4].map((entry) => entry.kind)).toEqual(['export']);
    expect(call[3].sourceIp).toBe('192.0.2.10');
    expect(JSON.parse(call[3].payloadJson).changes.withheld).toEqual({ new: 1 });
  }
});

it('returns an empty artifact range when every sealed row has been pruned', async () => {
  const f = fixture({ head: 3, boundary: 4 });
  const response = await f.call();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    snapshot: { headSeq: 3, boundarySeq: 4 },
    fromSeq: 4,
    toSeq: 4,
    next_from_seq: null,
    items: [],
    dispositions: [],
  });
  expect(f.list).not.toHaveBeenCalled();
  expect(f.deps.store.dispositions).not.toHaveBeenCalled();
  expect(f.record).toHaveBeenCalledOnce();
  expect(f.record.mock.calls[0]![4][0]).toMatchObject({ count: 0, fromSeq: 4, toSeq: 4 });
});
