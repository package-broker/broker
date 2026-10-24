import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { CloudflareApi } from './api.js';
import { installIdentity, type Operation, type ResourceKind } from './inventory.js';
import { cloudflareProviderContract, type RemoteResource } from './provision.js';

// Sanitized owner response (queuesEmpty) and recorded documented response shapes; see T969 report.
const fixtures = JSON.parse(
  await readFile(new URL('./fixtures/provider-responses.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>;
const identity = installIdentity({ accountId: 'a'.repeat(32), workerName: 'broker' });
const required = { queues: true, r2: false, analytics: false };
const contract = cloudflareProviderContract;
function harness(responses: { body: unknown; status?: number }[]) {
  let time = Date.parse('2026-10-23T12:00:00Z');
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const api = new CloudflareApi({
    accountId: identity.account_id,
    apiToken: 'token_SENTINEL',
    fetch,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    jitter: () => 0,
  });
  return { api, fetch };
}
it('accepts the real empty queues response with null diagnostics and zero pages', async () => {
  const h = harness([{ body: fixtures.queuesEmpty }]);
  expect(await contract.capabilities(h.api, required, identity)).toEqual({
    queues: { supported: true, remaining: 10_000 },
  });
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(String(h.fetch.mock.calls[0]?.[0])).toContain(
    `/accounts/${identity.account_id}/queues?page=1&per_page=100`,
  );
});
it('counts every queue page before calculating remaining capacity', async () => {
  const h = harness([{ body: fixtures.queuesFirstPage }, { body: fixtures.queuesLastPage }]);
  expect(await contract.capabilities(h.api, required, identity)).toEqual({
    queues: { supported: true, remaining: 9998 },
  });
  expect(String(h.fetch.mock.calls[1]?.[0])).toContain('page=2&per_page=100');
});
it.each([200, 403, 429])(
  'treats queue denial or documented plan limit (%s) as unsupported',
  async (status) => {
    const h = harness([
      { body: status === 403 ? fixtures.forbidden : fixtures.queuesPlanLimit, status },
    ]);
    expect(await contract.capabilities(h.api, required, identity)).toEqual({
      queues: { supported: false, remaining: 0 },
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ['missing metadata', undefined],
  ['partial page', { total_pages: 1, total_count: 2 }],
  ['invalid page count', { total_pages: '1', total_count: 0 }],
  ['contradictory zero pages', { total_pages: 0, total_count: 1 }],
  ['incorrect page number', { page: 2, total_pages: 1, total_count: 0 }],
  ['incorrect page count', { count: 1, total_pages: 0, total_count: 0 }],
  ['invalid cursor', { cursor: null, total_count: 0 }],
])('leaves malformed queue pagination unknown: %s', async (_name, result_info) => {
  const h = harness([{ body: { ...fixtures.queuesEmpty, result_info } }]);
  await expect(contract.capabilities(h.api, required, identity)).rejects.toMatchObject({
    code: 'capability_unknown',
    check: 'queues',
  });
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it.each([{ result: null }, { result: {} }, { result: [null] }])(
  'leaves malformed queue results unknown: $result',
  async ({ result }) => {
    const h = harness([{ body: { ...fixtures.queuesEmpty, result } }]);
    await expect(contract.capabilities(h.api, required, identity)).rejects.toMatchObject({
      code: 'capability_unknown',
      check: 'queues',
    });
  },
);
it('rejects changing queue totals between pages', async () => {
  const h = harness([
    { body: fixtures.queuesFirstPage },
    { body: { ...fixtures.queuesLastPage, result_info: { total_pages: 2, total_count: 3 } } },
  ]);
  await expect(contract.capabilities(h.api, required, identity)).rejects.toMatchObject({
    code: 'capability_unknown',
    check: 'queues',
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
it('keeps an authentication failure unknown and excludes provider diagnostics from output', async () => {
  const h = harness([{ body: fixtures.forbidden, status: 401 }]);
  const error: unknown = await contract
    .capabilities(h.api, required, identity)
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'capability_unknown', check: 'queues' });
  expect(String(error)).not.toMatch(/SENTINEL|person@example.com|user:password/);
  expect(JSON.stringify(error)).not.toMatch(/SENTINEL|person@example.com|user:password/);
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('does not accept a denied second queue page as a complete count', async () => {
  const h = harness([
    { body: fixtures.queuesFirstPage },
    { body: fixtures.forbidden, status: 403 },
  ]);
  expect(await contract.capabilities(h.api, required, identity)).toEqual({
    queues: { supported: false, remaining: 0 },
  });
});
it.each([200, 403])('checks R2 in the selected jurisdiction (%s)', async (status) => {
  const h = harness([{ body: status === 200 ? fixtures.r2Empty : fixtures.forbidden, status }]);
  expect(
    await contract.capabilities(h.api, { ...required, queues: false, r2: true }, identity),
  ).toEqual({
    r2: { supported: status === 200 },
  });
  expect(String(h.fetch.mock.calls[0]?.[0])).toContain('/r2/buckets?');
  expect(new Headers(h.fetch.mock.calls[0]?.[1]?.headers).get('cf-r2-jurisdiction')).toBe(
    identity.jurisdiction,
  );
});
it('follows all R2 cursors and refuses incomplete bucket listings', async () => {
  const h = harness([
    { body: { ...fixtures.r2Empty, result_info: { cursor: 'next' } } },
    { body: fixtures.r2Empty },
  ]);
  expect(
    await contract.capabilities(h.api, { ...required, queues: false, r2: true }, identity),
  ).toEqual({ r2: { supported: true } });
  expect(String(h.fetch.mock.calls[1]?.[0])).toContain('cursor=next');
  for (const [, init] of h.fetch.mock.calls)
    expect(new Headers(init?.headers).get('cf-r2-jurisdiction')).toBe('eu');
  const partial = harness([{ body: { ...fixtures.r2Empty, result_info: undefined } }]);
  await expect(
    contract.capabilities(partial.api, { ...required, queues: false, r2: true }, identity),
  ).rejects.toMatchObject({ code: 'capability_unknown', check: 'r2' });
});
it('recognizes required Analytics Engine on a confirmed paid Workers account', async () => {
  const h = harness([{ body: fixtures.workersPaid }]);
  expect(
    await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
  ).toEqual({ analytics: { supported: true, source: 'subscriptions' } });
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(String(h.fetch.mock.calls[0]?.[0])).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${identity.account_id}/subscriptions`,
  );
});
it.each([true, false])(
  'accepts the documented subscription array without pagination metadata (paid: %s)',
  async (paid) => {
    const h = harness([
      {
        body: {
          ...fixtures.workersPaid,
          result: paid ? fixtures.workersPaid!.result : [],
          result_info: undefined,
        },
      },
    ]);
    expect(
      await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
    ).toEqual({ analytics: { supported: paid, source: 'subscriptions' } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ['more pages', { total_pages: 2, total_count: 2 }],
  ['a continuing cursor', { cursor: 'next' }],
  ['a larger total', { total_count: 2 }],
])('uses SQL when the subscription snapshot advertises %s', async (_name, result_info) => {
  const h = harness([
    { body: { ...fixtures.workersPaid, result_info } },
    { body: fixtures.analyticsTablesEmpty },
  ]);
  expect(
    await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
  ).toEqual({ analytics: { supported: true, source: 'analytics_engine_sql' } });
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(String(h.fetch.mock.calls[1]?.[0])).toContain('/analytics_engine/sql');
});
it.each(['workers_paid', 'WORKERS_PAID'])(
  'recognizes paid plan identifier %s without inspecting provider prose',
  async (id) => {
    const h = harness([
      {
        body: {
          ...fixtures.workersPaid,
          result: [{ rate_plan: { id, scope: 'account' }, state: 'Paid' }],
        },
      },
    ]);
    expect(
      await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
    ).toEqual({ analytics: { supported: true, source: 'subscriptions' } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([
  [[]],
  [[{ rate_plan: { id: 'free', public_name: 'Workers Paid', scope: 'account' }, state: 'Paid' }]],
  [[{ rate_plan: { id: 'WORKERS_PAID', scope: 'account' }, state: 'Cancelled' }]],
  [[{ rate_plan: { id: 'WORKERS_PAID', scope: 'zone' }, state: 'Paid' }]],
])(
  'does not infer Analytics Engine availability from unrelated or inactive subscriptions: %j',
  async (result) => {
    const h = harness([
      { body: { ...fixtures.workersPaid, result, result_info: { total_count: result.length } } },
    ]);
    expect(
      await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
    ).toEqual({ analytics: { supported: false, source: 'subscriptions' } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each([403, 200])(
  'accepts the real SQL response when subscription evidence is unavailable (%s)',
  async (status) => {
    const h = harness([
      {
        body:
          status === 403
            ? fixtures.forbidden
            : { ...fixtures.workersPaid, result_info: { total_count: 2 } },
        status,
      },
      { body: fixtures.analyticsTablesEmpty },
    ]);
    expect(
      await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
    ).toEqual({ analytics: { supported: true, source: 'analytics_engine_sql' } });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const [url, init] = h.fetch.mock.calls[1]!;
    expect(String(url)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${identity.account_id}/analytics_engine/sql`,
    );
    expect(init).toMatchObject({ method: 'POST', body: 'SHOW TABLES' });
    expect(new Headers(init?.headers).get('content-type')).toBe('text/plain');
  },
);
it.each([401, 403])('keeps SQL permission denial unknown with a safe hint (%s)', async (status) => {
  const h = harness([
    { body: fixtures.forbidden, status: 403 },
    { body: fixtures.forbidden, status },
  ]);
  const error: unknown = await contract
    .capabilities(h.api, { queues: false, r2: false, analytics: true }, identity)
    .catch((error: unknown) => error);
  expect(error).toMatchObject({
    code: 'capability_unknown',
    check: 'analytics_engine',
    source: 'analytics_engine_sql',
    message: expect.stringMatching(/Analytics Engine.*Read.*permission/),
  });
  expect(String(error)).not.toMatch(/SENTINEL|person@example.com|user:password/);
  expect(JSON.stringify(error)).not.toMatch(/SENTINEL|person@example.com|user:password/);
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
it.each([
  { status: 201, body: fixtures.analyticsTablesEmpty },
  { status: 404, body: fixtures.forbidden },
  { status: 429, body: fixtures.forbidden },
  { status: 500, body: fixtures.forbidden },
  { body: { success: true, result: [] } },
  { body: { ...fixtures.analyticsTablesEmpty, meta: [] } },
  { body: { ...fixtures.analyticsTablesEmpty, meta: [{ name: 'dataset', type: 'Int32' }] } },
  { body: { ...fixtures.analyticsTablesEmpty, data: null } },
  { body: { ...fixtures.analyticsTablesEmpty, data: [null], rows: 1 } },
  { body: { ...fixtures.analyticsTablesEmpty, data: [{ dataset: 1 }], rows: 1 } },
  { body: { ...fixtures.analyticsTablesEmpty, rows: 1 } },
  { body: { ...fixtures.analyticsTablesEmpty, rows: '0' } },
])('keeps other SQL answers unknown: %j', async (response) => {
  const h = harness([{ body: fixtures.forbidden, status: 403 }, response]);
  await expect(
    contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
  ).rejects.toMatchObject({
    code: 'capability_unknown',
    check: 'analytics_engine',
    source: 'analytics_engine_sql',
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
it('accepts an existing dataset in the SQL table listing', async () => {
  const h = harness([
    { body: fixtures.forbidden, status: 403 },
    { body: { ...fixtures.analyticsTablesEmpty, data: [{ dataset: 'broker_metrics' }], rows: 1 } },
  ]);
  expect(
    await contract.capabilities(h.api, { queues: false, r2: false, analytics: true }, identity),
  ).toEqual({ analytics: { supported: true, source: 'analytics_engine_sql' } });
});
it('does not probe services or Analytics Engine when no binding is required', async () => {
  const h = harness([]);
  expect(
    await contract.capabilities(h.api, { queues: false, r2: false, analytics: false }, identity),
  ).toEqual({});
  expect(h.fetch).not.toHaveBeenCalled();
});
it.each<ResourceKind>(['d1', 'r2', 'queue', 'worker', 'analytics'])(
  'reports documented name uniqueness for %s',
  (kind) => {
    expect(contract.exactNameUnique(kind)).toBe(kind !== 'analytics');
  },
);
it.each<ResourceKind>(['d1', 'r2', 'queue', 'worker', 'analytics'])(
  'never invents a pending-creation window for %s',
  (kind) => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    const resource: RemoteResource = {
      kind,
      id: 'resource',
      name: 'broker',
      jurisdiction: null,
      created_at: new Date(now).toISOString(),
    };
    const operation: Operation = {
      id: 'intent',
      kind,
      name: 'broker',
      spec_sha256: 'a'.repeat(64),
      absence_observed_at: new Date(now - 1000).toISOString(),
      started_at: new Date(now - 1000).toISOString(),
      state: 'pending',
      resolved_id: null,
    };
    expect(contract.pendingCreation(resource, operation, now)).toBe(false);
    expect(contract.pendingCreation(resource, operation, now + 60_000)).toBe(false);
  },
);
