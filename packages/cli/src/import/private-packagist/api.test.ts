import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { MAX_OBJECTS, MAX_PAGE_BYTES, MAX_PAGES, PackagistApi } from './api.js';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomUUID: vi.fn(crypto.randomUUID) };
});

const key = 'SENTINEL_KEY';
const secret = 'SENTINEL_SECRET';
const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { headers });
function harness(responses: (() => Response)[], limits = {}) {
  let time = 1_700_000_000_000;
  const sleep = vi.fn(async (ms: number) => {
    time += ms;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!());
  const api = new PackagistApi({
    key,
    secret,
    fetch,
    sleep,
    now: () => time,
    random: () => 0,
    limits,
  });
  return { api, fetch, sleep };
}

it('signs GET query parameters with independently constructed documented HMAC v2 vectors on each attempt', async () => {
  const { api, fetch } = harness([() => new Response('', { status: 429 }), () => json([])]);
  await api.request('/api/packages/?z=!*%27()&a=hello+world&limit=500');
  const timestamps: string[] = [];
  const nonces: string[] = [];
  for (const [, init] of fetch.mock.calls) {
    const header = new Headers(init?.headers).get('authorization')!;
    const fields = Object.fromEntries(
      [...header.matchAll(/(Key|Timestamp|Cnonce|Version|Signature)=([^,]+)/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const rfc3986 = (text: string) =>
      encodeURIComponent(text).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      );
    const query = 'a=hello%20world&limit=500&z=%21%2A%27%28%29';
    const canonical =
      'GET\npackagist.com\n/api/packages/\n' +
      `cnonce=${rfc3986(fields.Cnonce!)}&key=SENTINEL_KEY&query=${rfc3986(query)}&timestamp=${fields.Timestamp}&version=2`;
    expect(fields.Signature).toBe(createHmac('sha256', secret).update(canonical).digest('base64'));
    expect(fields.Key).toBe(key);
    expect(fields.Version).toBe('2');
    timestamps.push(fields.Timestamp!);
    nonces.push(fields.Cnonce!);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
  }
  expect(new Set(timestamps).size).toBe(2);
  expect(new Set(nonces).size).toBe(2);
});

it('always includes the empty canonical query in a signature', async () => {
  const { api, fetch } = harness([() => json({})]);
  await api.request('/api/packages/1/');
  const header = new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')!;
  const nonce = /Cnonce=([^,]+)/.exec(header)![1];
  const canonical = `GET\npackagist.com\n/api/packages/1/\ncnonce=${nonce}&key=SENTINEL_KEY&query=&timestamp=1700000000&version=2`;
  expect(header).toContain(
    `Signature=${createHmac('sha256', secret).update(canonical).digest('base64')}`,
  );
});

it('matches both pinned PHP RequestSignature vectors, including the next-link request', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL('../fixtures/private-packagist/signature-vectors.json', import.meta.url),
      'utf8',
    ),
  ) as {
    vectors: {
      path: string;
      key: string;
      secret: string;
      timestamp: number;
      cnonce: ReturnType<typeof randomUUID>;
      authorization: string;
      nextLink: boolean;
    }[];
  };
  expect(fixture.vectors).toHaveLength(2);
  for (const vector of fixture.vectors) {
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      calls++;
      return json(
        [],
        vector.nextLink && calls === 1 ? { link: `<${vector.path}>; rel="next"` } : {},
      );
    });
    const api = new PackagistApi({
      key: vector.key,
      secret: vector.secret,
      now: () => vector.timestamp * 1000,
      fetch,
    });
    if (vector.nextLink) {
      vi.mocked(randomUUID).mockReturnValueOnce(vector.cnonce).mockReturnValueOnce(vector.cnonce);
      await api.list('/api/packages/');
    } else {
      vi.mocked(randomUUID).mockReturnValueOnce(vector.cnonce);
      await api.request(vector.path);
    }
    const last = fetch.mock.calls.at(-1)!;
    expect(new URL(String(last[0])).pathname + new URL(String(last[0])).search).toBe(vector.path);
    expect(new Headers(last[1]?.headers).get('authorization')).toBe(vector.authorization);
  }
});

it('uses comma-space Authorization separators and signs an unsorted Link query in sorted order', async () => {
  const { api, fetch } = harness([
    () => json([1], { link: '</api/packages/?page=2&limit=500>; rel="next"' }),
    () => json([2]),
  ]);
  expect(await api.list('/api/packages/')).toEqual([1, 2]);
  expect(new URL(String(fetch.mock.calls[1]![0])).search).toBe('?page=2&limit=500');
  for (const [index, [, init]] of fetch.mock.calls.entries()) {
    const header = new Headers(init?.headers).get('authorization')!;
    const nonce = /Cnonce=([^,]+)/.exec(header)![1];
    const sortedQuery = index === 0 ? 'limit%3D500' : 'limit%3D500%26page%3D2';
    const canonical = `GET\npackagist.com\n/api/packages/\ncnonce=${nonce}&key=SENTINEL_KEY&query=${sortedQuery}&timestamp=1700000000&version=2`;
    const signature = createHmac('sha256', secret).update(canonical).digest('base64');
    expect(header).toBe(
      `PACKAGIST-HMAC-SHA256 Key=${key}, Timestamp=1700000000, Cnonce=${nonce}, Version=2, Signature=${signature}`,
    );
  }
});

it('rejects non-GET before fetch', async () => {
  const { api, fetch } = harness([() => json([])]);
  await expect(api.request('/api/packages/', 'POST')).rejects.toMatchObject({ code: 'get_only' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  'https://evil.example.test/api/',
  'http://packagist.com/api/',
  'https://user:secret@packagist.com/api/',
])('pins requests and next links: %s', async (target) => {
  const { api, fetch } = harness([
    () => json([], { link: `<${target}>; rel="next"` }),
    () => json([]),
  ]);
  await expect(api.list('/api/packages/')).rejects.toMatchObject({ code: 'invalid_url' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('follows three pages with limit 500, including relative next links and multiple relations', async () => {
  const { api, fetch } = harness([
    () =>
      json([1], {
        link: '</api/packages/?page=2&limit=10000>; rel="next", </api/packages/?page=3>; rel="last"',
      }),
    () => json([2], { link: '<?page=3>; rel="next last"' }),
    () => json([3]),
  ]);
  expect(await api.list('/api/packages/')).toEqual([1, 2, 3]);
  expect(
    fetch.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('limit')),
  ).toEqual(['500', '500', '500']);
});

it('enforces page and object caps at their exact boundaries', async () => {
  expect([MAX_PAGES, MAX_OBJECTS, MAX_PAGE_BYTES]).toEqual([10000, 200000, 8 * 1024 * 1024]);
  const { api, fetch } = harness(
    [
      () => json([1], { link: '<?page=2>; rel=next' }),
      () => json([2], { link: '<?page=3>; rel=next' }),
      () => json([3]),
    ],
    { pages: 2 },
  );
  await expect(api.list('/api/packages/')).rejects.toMatchObject({
    code: 'snapshot_limit_exceeded',
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  const objects = harness([() => json([1, 2]), () => json([1, 2, 3])], { objects: 2 });
  expect(await objects.api.list('/api/packages/')).toEqual([1, 2]);
  await expect(objects.api.list('/api/packages/')).rejects.toMatchObject({
    code: 'snapshot_limit_exceeded',
  });
});

it('counts objects across pages', async () => {
  const { api } = harness([() => json([1, 2], { link: '<?page=2>; rel=next' }), () => json([3])], {
    objects: 2,
  });
  await expect(api.list('/api/packages/')).rejects.toMatchObject({
    code: 'snapshot_limit_exceeded',
  });
});

it.each(['3', 'Tue, 14 Nov 2023 22:13:23 GMT'])(
  'honors Retry-After %s on 429 then succeeds',
  async (retry) => {
    const { api, fetch, sleep } = harness([
      () => new Response('', { status: 429, headers: { 'retry-after': retry } }),
      () => json([]),
    ]);
    expect(await api.list('/api/packages/')).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  },
);

it('exhausts 5xx after five attempts with bounded jittered backoff', async () => {
  const { api, fetch, sleep } = harness(
    Array.from(
      { length: 5 },
      () => () => new Response('', { status: 503, headers: { 'retry-after': '999999' } }),
    ),
  );
  await expect(api.list('/api/packages/')).rejects.toMatchObject({ code: 'packagist_request' });
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(sleep.mock.calls).toEqual([[30000], [30000], [30000], [30000]]);
});

it.each([
  [
    400,
    'Timestamp is beyond the +-15 second difference allowed.',
    'clock_skew',
    'Check the local clock before retrying Private Packagist.',
  ],
  [401, `${key} ${secret}`, 'packagist_auth', 'Private Packagist authentication failed.'],
  [
    400,
    `Invalid signature ${key} ${secret}`,
    'packagist_signature',
    'Private Packagist signature failed.',
  ],
  [302, '', 'redirect_refused', 'Private Packagist redirect refused.'],
] as const)('stops on %s with fixed safe text (%s)', async (status, body, code, message) => {
  const { api, fetch } = harness([() => new Response(body, { status })]);
  await expect(api.list('/api/packages/')).rejects.toMatchObject({ code, message });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('sanitizes a native fetch redirect rejection or credential-bearing network error', async () => {
  const api = new PackagistApi({
    key,
    secret,
    fetch: async () => {
      throw new Error(`${key} ${secret}`);
    },
  });
  await expect(api.request('/api/packages/')).rejects.toMatchObject({
    message: 'Private Packagist request failed.',
  });
});

it.each([false, true])('rejects oversized bodies (content-length: %s)', async (length) => {
  const { api } = harness([
    () =>
      new Response(' '.repeat(MAX_PAGE_BYTES + 1), {
        headers: length ? { 'content-length': String(MAX_PAGE_BYTES + 1) } : {},
      }),
  ]);
  await expect(api.request('/api/packages/')).rejects.toMatchObject({
    code: 'snapshot_limit_exceeded',
  });
});

it.each(['{', '{}', '['.repeat(70) + '0' + ']'.repeat(70)])(
  'rejects malformed, non-list or deeply nested responses',
  async (text) => {
    const { api } = harness([() => new Response(text)]);
    await expect(api.list('/api/packages/')).rejects.toMatchObject({ code: 'invalid_response' });
  },
);

it('allows at most two in-flight requests including response reads', async () => {
  let active = 0;
  let maximum = 0;
  const releases: (() => void)[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return json([]);
  });
  const api = new PackagistApi({ key, secret, fetch });
  const requests = Array.from({ length: 5 }, () => api.list('/api/packages/'));
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  releases.splice(0).forEach((release) => release());
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  releases.splice(0).forEach((release) => release());
  await vi.waitFor(() => expect(releases).toHaveLength(1));
  releases.splice(0).forEach((release) => release());
  await Promise.all(requests);
  expect(maximum).toBe(2);
});

it('enforces the production object limit while accepting its exact boundary', async () => {
  const { api } = harness([
    () => json(Array(MAX_OBJECTS).fill(null)),
    () => json(Array(MAX_OBJECTS + 1).fill(null)),
  ]);
  expect(await api.list('/api/packages/')).toHaveLength(MAX_OBJECTS);
  await expect(api.list('/api/packages/')).rejects.toMatchObject({
    code: 'snapshot_limit_exceeded',
  });
});

it('applies exponential backoff and jitter and signs all five attempts freshly', async () => {
  let time = 1_700_000_000_000;
  const sleep = vi.fn(async (ms: number) => {
    time += ms;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 503 }));
  const api = new PackagistApi({ key, secret, fetch, sleep, now: () => time, random: () => 0.5 });
  await expect(api.request('/api/packages/')).rejects.toMatchObject({ code: 'packagist_request' });
  expect(sleep.mock.calls).toEqual([[1250], [2250], [4250], [8250]]);
  const headers = fetch.mock.calls.map(([, init]) =>
    new Headers(init?.headers).get('authorization')!,
  );
  expect(new Set(headers.map((header) => /Timestamp=([^,]+)/.exec(header)![1])).size).toBe(5);
  expect(new Set(headers.map((header) => /Cnonce=([^,]+)/.exec(header)![1])).size).toBe(5);
});

it('holds the concurrency slot until the response body finishes', async () => {
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodies.push(controller);
          },
        }),
      ),
  );
  const api = new PackagistApi({ key, secret, fetch });
  const requests = [
    api.list('/api/packages/'),
    api.list('/api/packages/'),
    api.list('/api/packages/'),
  ];
  await vi.waitFor(() => expect(bodies).toHaveLength(2));
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const body of bodies.splice(0)) {
    body.enqueue(new TextEncoder().encode('[]'));
    body.close();
  }
  await vi.waitFor(() => expect(bodies).toHaveLength(1));
  bodies[0]!.enqueue(new TextEncoder().encode('[]'));
  bodies[0]!.close();
  await Promise.all(requests);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([
  [401, 'packagist_auth'],
  [302, 'redirect_refused'],
  [200, 'snapshot_limit_exceeded'],
] as const)(
  'preserves the fixed %s refusal even when cancelling the body fails',
  async (status, code) => {
    const { api } = harness([
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw new Error(`${key} ${secret}`);
            },
          }),
          { status, headers: { 'content-length': String(MAX_PAGE_BYTES + 1) } },
        ),
    ]);
    await expect(api.request('/api/packages/')).rejects.toMatchObject({ code });
  },
);
