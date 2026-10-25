import { expect, it, vi } from 'vitest';
import {
  CloudflareApi,
  CloudflareError,
  cloudflareCredentials,
  commandEnvelope,
  failCommand,
} from './api.js';

const accountId = 'a'.repeat(32);
const apiToken = 'token_SENTINEL';
function json(result: unknown, result_info?: unknown) {
  return new Response(JSON.stringify({ success: true, result, result_info }));
}
function harness(send: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  let time = Date.parse('2026-10-19T12:00:00Z');
  const sleep = vi.fn(async (ms: number) => {
    time += ms;
  });
  const fetch = vi.fn((url: unknown, init?: RequestInit) =>
    send(String(url), init),
  ) as unknown as typeof globalThis.fetch;
  return {
    api: new CloudflareApi({ accountId, apiToken, fetch, now: () => time, sleep }),
    sleep,
    fetch,
  };
}
it('pages the full numeric and cursor listings and refuses ambiguous completion', async () => {
  const h = harness((url) =>
    json([url.includes('page=2') ? { id: 2 } : { id: 1 }], { total_pages: 2 }),
  );
  expect(await h.api.list('/queues')).toEqual([{ id: 1 }, { id: 2 }]);
  expect(h.sleep).toHaveBeenCalledWith(1000);
  let page = 0;
  const cursors = harness(() =>
    json({ buckets: [{ page: ++page }] }, { cursor: page === 1 ? 'next' : '' }),
  );
  expect(await cursors.api.list('/r2/buckets', 'buckets')).toHaveLength(2);
  expect(String(vi.mocked(cursors.fetch).mock.calls[1]?.[0])).toContain('cursor=next');
  await expect(harness(() => json([])).api.list('/queues')).rejects.toMatchObject({
    code: 'capability_unknown',
  });
});
it('follows D1 page/count/total_count metadata without total_pages', async () => {
  const h = harness((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return json([{ id: page }], { count: 1, page, per_page: 100, total_count: 2 });
  });
  expect(await h.api.list('/d1/database')).toEqual([{ id: 1 }, { id: 2 }]);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(String(vi.mocked(h.fetch).mock.calls[1]?.[0])).toContain('page=2&per_page=100');
});

it('reads Worker versions from result.items with the real page/per_page metadata', async () => {
  const h = harness(() =>
    json(
      { items: [{ id: 'version-1' }] },
      {
        page: 1,
        per_page: 10,
        count: 1,
        total_count: 1,
      },
    ),
  );
  expect(await h.api.list('/workers/scripts/broker/versions', 'items')).toEqual([
    { id: 'version-1' },
  ]);
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('follows all result.items pages when Worker versions omit total_pages', async () => {
  const h = harness((url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return json(
      { items: [{ id: `version-${page}` }] },
      {
        page,
        per_page: 1,
        count: 1,
        total_count: 2,
      },
    );
  });
  expect(await h.api.list('/workers/scripts/broker/versions', 'items')).toEqual([
    { id: 'version-1' },
    { id: 'version-2' },
  ]);
});
it.each([
  { count: 1, page: 1, total_count: 2 },
  { count: 1, per_page: 100, total_count: 2 },
  { count: 1, page: 1, per_page: 0, total_count: 2 },
  { count: 1, page: 1, per_page: '100', total_count: 2 },
  { count: 0, page: 1, per_page: 100, total_count: 2 },
])('refuses incomplete D1 pagination metadata: %j', async (info) => {
  const h = harness(() => json([{ id: 1 }], info));
  await expect(h.api.list('/d1/database')).rejects.toMatchObject({ code: 'capability_unknown' });
  expect(h.fetch).toHaveBeenCalledTimes(1);
});

it('bounds safe read retries, honors Retry-After and never retries a POST', async () => {
  let calls = 0;
  const h = harness(() =>
    ++calls === 1
      ? new Response('sentinel', { status: 429, headers: { 'retry-after': '3' } })
      : json([]),
  );
  await h.api.request('/queues');
  expect(h.sleep).toHaveBeenCalledWith(3000);
  const unavailable = harness(() => new Response('sentinel', { status: 503 }));
  await expect(unavailable.api.request('/queues')).rejects.toMatchObject({ retryable: true });
  expect(unavailable.fetch).toHaveBeenCalledTimes(5);
  for (const status of [409, 429, 500]) {
    const post = harness(() => new Response('sentinel', { status }));
    await expect(post.api.request('/queues', 'POST', {})).rejects.toMatchObject({ status });
    expect(post.fetch).toHaveBeenCalledTimes(1);
  }
});
it('refuses redirects and permission errors immediately without leaking transport or provider data', async () => {
  const sentinel = `${accountId} ${apiToken} person@example.com https://user:password@example.com`;
  for (const status of [301, 401, 403]) {
    const h = harness(() => new Response(sentinel, { status }));
    const error = await h.api.request('/queues').catch((error: unknown) => error);
    expect(String(error)).not.toContain('SENTINEL');
    expect(String(error)).not.toContain(accountId);
    expect(String(error)).not.toContain('person@example.com');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  }
  const h = harness(() => {
    throw new Error(sentinel);
  });
  expect(String(await h.api.request('/queues').catch((e: unknown) => e))).not.toContain(sentinel);
});
it('bounds JSON bytes, handles truncated bodies, and will not sleep beyond the deadline', async () => {
  const h = harness(() => new Response('{truncated'));
  await expect(h.api.request('/queues', 'POST')).rejects.toMatchObject({ retryable: true });
  expect(h.fetch).toHaveBeenCalledTimes(1);
  const large = harness(() => new Response('a'.repeat(1_048_577)));
  await expect(large.api.request('/queues', 'POST')).rejects.toBeInstanceOf(CloudflareError);
  const deadline = harness(
    () => new Response('', { status: 429, headers: { 'retry-after': '1000' } }),
  );
  await expect(deadline.api.request('/queues')).rejects.toMatchObject({ retryable: true });
  expect(deadline.sleep).not.toHaveBeenCalled();
});
it('rejects hostile paths, malformed credentials and produces the common safe failure envelope', async () => {
  const h = harness(() => json([]));
  for (const path of ['https://elsewhere.example', '//evil', '/../x', '/x#secret'])
    await expect(h.api.request(path)).rejects.toMatchObject({ exitCode: 2 });
  expect(h.fetch).not.toHaveBeenCalled();
  expect(() => cloudflareCredentials({})).toThrow(CloudflareError);
  const result = failCommand(commandEnvelope('provision', true), new Error(apiToken));
  expect(result.output).toMatchObject({
    schema_version: 1,
    status: 'error',
    dry_run: true,
    kv_namespace_id: null,
    queue_names: [],
    migrations_applied: [],
    rollback: { status: 'not_needed', target_version_id: null },
  });
  expect(JSON.stringify(result)).not.toContain(apiToken);
});

it('serializes two API clients for the same account and transport at one request per second', async () => {
  let time = 0;
  const times: number[] = [];
  const transport = (async () => {
    times.push(time);
    return json([]);
  }) as typeof fetch;
  const options = {
    accountId,
    apiToken,
    fetch: transport,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
  await Promise.all([
    new CloudflareApi(options).request('/queues'),
    new CloudflareApi(options).request('/workers/subdomain'),
  ]);
  expect(times).toEqual([0, 1000]);
});

it('honors date Retry-After and refuses repeating cursors', async () => {
  let tries = 0;
  const h = harness(() =>
    ++tries === 1
      ? new Response('', {
          status: 429,
          headers: { 'retry-after': 'Mon, 19 Oct 2026 12:00:05 GMT' },
        })
      : json([]),
  );
  await h.api.request('/queues');
  expect(h.sleep).toHaveBeenCalledWith(5000);
  const cursor = harness(() => json([], { cursor: 'same' }));
  await expect(cursor.api.list('/queues')).rejects.toMatchObject({ code: 'provider_failure' });
});

it.each(['60', 'Mon, 19 Oct 2026 12:01:00 GMT'])(
  'shares create Retry-After %s with subsequent reconciliation reads without retrying POST',
  async (retryAfter) => {
    let time = Date.parse('2026-10-19T12:00:00Z');
    const start = time;
    const calls: { method: string; at: number }[] = [];
    const transport = (async (_input, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, at: time - start });
      return method === 'POST'
        ? new Response('', { status: 429, headers: { 'retry-after': retryAfter } })
        : json([]);
    }) as typeof fetch;
    const options = {
      accountId,
      apiToken,
      fetch: transport,
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
    };
    await expect(new CloudflareApi(options).request('/queues', 'POST', {})).rejects.toMatchObject({
      status: 429,
    });
    await new CloudflareApi(options).request('/queues');
    expect(calls).toEqual([
      { method: 'POST', at: 0 },
      { method: 'GET', at: 60_000 },
    ]);
  },
);

it('refuses reconciliation when a create Retry-After exceeds the command deadline', async () => {
  const h = harness((_url, init) =>
    init?.method === 'POST'
      ? new Response('', { status: 429, headers: { 'retry-after': '1000' } })
      : json([]),
  );
  await expect(h.api.request('/queues', 'POST', {})).rejects.toMatchObject({ status: 429 });
  await expect(h.api.request('/queues')).rejects.toMatchObject({
    code: 'provider_failure',
    retryable: true,
  });
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.sleep).not.toHaveBeenCalled();
});

it.each([401, 403, 409, 429, 503])(
  'cancels nonterminating HTTP %s bodies before returning or retrying',
  async (status) => {
    const cancellations: number[] = [];
    const h = harness(() => {
      const index = cancellations.push(0) - 1;
      return new Response(
        new ReadableStream({
          cancel() {
            cancellations[index] = (cancellations[index] ?? 0) + 1;
          },
        }),
        { status },
      );
    });
    await expect(h.api.request('/queues')).rejects.toBeInstanceOf(CloudflareError);
    expect(cancellations).toEqual(Array([429, 503].includes(status) ? 5 : 1).fill(1));
  },
);

it('refuses a POST when the scheduler sleep overshoots the command deadline', async () => {
  let time = 0;
  const transport = vi.fn(async () => json([]));
  const api = new CloudflareApi({
    accountId,
    apiToken,
    fetch: transport,
    now: () => time,
    deadline: 10_000,
    sleep: async () => {
      time = 21_000;
    },
  });
  await api.request('/queues');
  await expect(api.request('/queues', 'POST', {})).rejects.toMatchObject({
    code: 'provider_failure',
    retryable: true,
  });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('bounds and cancels a nonterminating JSON Queues error body', async () => {
  const cancel = vi.fn();
  const h = harness(
    () =>
      new Response(new ReadableStream({ cancel }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  );
  await expect(h.api.list('/queues')).rejects.toMatchObject({
    code: 'provider_failure',
    status: 400,
    retryable: false,
  });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(h.fetch).toHaveBeenCalledTimes(1);
});

it('keeps an unrecognized Queues rate limit retryable without exposing its error body', async () => {
  const h = harness(
    () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10250, message: 'TOKEN_SENTINEL person@example.com' }],
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
  );
  const error: unknown = await h.api.list('/queues').catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'provider_failure', status: 429, retryable: true });
  expect(String(error)).not.toMatch(/SENTINEL|person@example.com/);
  expect(h.fetch).toHaveBeenCalledTimes(5);
});

it('preserves read retries for unsuccessful envelopes without a documented plan rejection', async () => {
  const h = harness(
    () => new Response(JSON.stringify({ success: false, errors: null, result: null })),
  );
  await expect(h.api.request('/workers/scripts')).rejects.toMatchObject({
    code: 'provider_failure',
    status: null,
    retryable: true,
  });
  expect(h.fetch).toHaveBeenCalledTimes(5);
});

it.each([
  [50_500, 'deadline_exceeded'],
  [51_000, null],
])('checks the create budget after the scheduler wait: deadline %i', async (deadline, code) => {
  let time = 0;
  const transport = vi.fn(async () => json({}));
  const api = new CloudflareApi({
    accountId,
    apiToken,
    fetch: transport,
    now: () => time,
    deadline,
    sleep: async (ms) => {
      time += ms;
    },
  });
  await api.request('/queues');
  const post = api.request('/queues', 'POST', {});
  if (code === null) await expect(post).resolves.toBeDefined();
  else await expect(post).rejects.toMatchObject({ code });
  expect(transport).toHaveBeenCalledTimes(code === null ? 2 : 1);
});

it('keeps an injected deadline when the budget is restarted', () => {
  const injected = new CloudflareApi({ accountId, apiToken, now: () => 5, deadline: 99 });
  injected.restartDeadline();
  expect(injected.deadline).toBe(99);
  const restarted = new CloudflareApi({ accountId, apiToken, now: () => 5 });
  restarted.restartDeadline();
  expect(restarted.deadline).toBe(600_005);
});

it('sends multipart without a JSON content type, isolates the asset-session token, and scopes zone calls correctly', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const h = harness((url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return json({});
  });
  const form = new FormData();
  form.set('metadata', '{}');
  form.set('worker.js', new Blob(['export default {}']), 'worker.js');
  await h.api.request('/workers/scripts/broker/versions', 'POST', form);
  await h.api.uploadAssets(form, 'SESSION_SENTINEL');
  await h.api.requestZone('b'.repeat(32), '/workers/routes', 'PUT', {});
  expect(calls[0]?.init?.body).toBe(form);
  expect(new Headers(calls[0]?.init?.headers).has('content-type')).toBe(false);
  expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe('Bearer SESSION_SENTINEL');
  expect(new Headers(calls[2]?.init?.headers).get('authorization')).toBe(`Bearer ${apiToken}`);
  expect(calls[2]?.url).toBe(
    `https://api.cloudflare.com/client/v4/zones/${'b'.repeat(32)}/workers/routes`,
  );
});
it.each(['PUT', 'PATCH'] as const)(
  'never retries a %s mutation after an unknown response',
  async (method) => {
    const h = harness(() => new Response('SENTINEL', { status: 503 }));
    await expect(
      h.api.request('/workers/scripts/broker/settings', method, {}),
    ).rejects.toMatchObject({ status: 503 });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  },
);

it('keeps preview cleanup within the caller-owned absolute recovery deadline', async () => {
  let time = 120_000;
  let recoveryEnd: number | undefined;
  const transport = vi.fn(async () => json({}));
  const api = new CloudflareApi({
    accountId,
    apiToken,
    fetch: transport,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    deadline: time,
    recoveryDeadline: () => (recoveryEnd ??= time + 60_000),
  });
  await expect(api.request('/workers/scripts/broker/subdomain')).rejects.toMatchObject({
    code: 'provider_failure',
  });
  api.reserveRecovery(20);
  expect(api.deadline).toBe(180_000);
  await api.request('/workers/scripts/broker/subdomain', 'POST', { previews_enabled: false });
  time = 180_000;
  api.reserveRecovery(20);
  expect(api.deadline).toBe(180_000);
  await expect(api.request('/workers/scripts/broker/subdomain')).rejects.toMatchObject({
    code: 'provider_failure',
  });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('reads a documented collection as one snapshot without pagination parameters', async () => {
  const h = harness(() => json([{ id: 'a' }, { id: 'b' }]));
  expect(await h.api.snapshot('/workers/scripts')).toEqual([{ id: 'a' }, { id: 'b' }]);
  expect(vi.mocked(h.fetch)).toHaveBeenCalledTimes(1);
  expect(String(vi.mocked(h.fetch).mock.calls[0]?.[0])).toMatch(/\/workers\/scripts$/);
  expect(
    await harness(() => json([], { total_pages: 0 })).api.snapshot('/queues/q/consumers'),
  ).toEqual([]);
  expect(await harness(() => json([{ id: 1 }], { total_pages: 1 })).api.snapshot('/x')).toEqual([
    { id: 1 },
  ]);
});

it.each([
  ['more pages', [{ id: 1 }], { total_pages: 2 }],
  ['a continuing cursor', [{ id: 1 }], { cursor: 'next' }],
  ['a larger total', [{ id: 1 }], { total_count: 2 }],
])('refuses a snapshot that advertises %s', async (_name, result, info) => {
  await expect(harness(() => json(result, info)).api.snapshot('/x')).rejects.toMatchObject({
    code: 'capability_unknown',
  });
});

it('refuses a snapshot whose result is not an array', async () => {
  await expect(harness(() => json({ id: 1 })).api.snapshot('/x')).rejects.toMatchObject({
    code: 'provider_failure',
  });
});

it('accepts null snapshot metadata without weakening paginated completion checks', async () => {
  const h = harness(() => json([], null));
  expect(await h.api.snapshot('/workers/scripts')).toEqual([]);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  await expect(harness(() => json([], null)).api.list('/queues')).rejects.toMatchObject({
    code: 'capability_unknown',
  });
});

it.each([false, 'invalid', []].map((info) => ({ info })))(
  'rejects malformed pagination metadata: $info',
  async ({ info }) => {
    await expect(
      harness(() => json([], info)).api.snapshot('/workers/scripts'),
    ).rejects.toMatchObject({
      code: 'provider_failure',
    });
  },
);

it('never lets caller headers replace the authorization header', async () => {
  const h = harness(() => json({}));
  await h.api.request('/r2/buckets/b/lifecycle', 'GET', undefined, {
    authorization: 'Bearer attacker',
    'cf-r2-jurisdiction': 'eu',
  });
  const headers = new Headers(vi.mocked(h.fetch).mock.calls[0]?.[1]?.headers);
  expect(headers.get('authorization')).toBe(`Bearer ${apiToken}`);
  expect(headers.get('cf-r2-jurisdiction')).toBe('eu');
});
