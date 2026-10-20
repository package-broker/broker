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
