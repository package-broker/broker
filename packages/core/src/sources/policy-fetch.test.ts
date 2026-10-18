import { describe, expect, it } from 'vitest';
import {
  createObservability,
  type Observability,
  type ObsRecord,
} from '../platform/observability.js';
import {
  GITHUB_API_VERSION,
  UpstreamError,
  createPolicyFetch,
  type UpstreamCredential,
  type UpstreamRequest,
} from './policy-fetch.js';
import { createOutboundPolicy } from './url-policy.js';

const SECRET = 'sek-ret-token-123';
const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });

interface Hop {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

type Reply = Response | ((signal: AbortSignal | null | undefined) => Promise<Response>);

function fake(replies: Record<string, Reply>): {
  hops: Hop[];
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
} {
  const hops: Hop[] = [];
  return {
    hops,
    fetchImpl: async (input, init) => {
      const url = String(input);
      hops.push({
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      expect(init?.redirect).toBe('manual');
      const reply = replies[url];
      if (reply === undefined) throw new Error('unexpected request');
      return typeof reply === 'function' ? reply(init?.signal) : reply;
    },
  };
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function recorder(): { obs: Observability; seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    obs: {
      log: (r) => seen.push(r),
      counter: (n, l, v) => seen.push({ n, l, v }),
      histogram: (n, v, l) => seen.push({ n, v, l }),
    },
  };
}

const credential: UpstreamCredential = {
  origins: ['https://a.example.com'],
  queryParams: [],
  apply(headers, url) {
    const next = new URL(url);
    next.searchParams.set('token', SECRET);
    const out = new Headers(headers);
    out.set('authorization', `Bearer ${SECRET}`);
    out.set('x-api-key', SECRET);
    return { headers: out, url: next };
  },
};

function request(overrides: Partial<UpstreamRequest> = {}): UpstreamRequest {
  return {
    url: 'https://a.example.com/start?x=1',
    method: 'GET',
    headers: { accept: 'application/json' },
    purpose: 'metadata',
    maxBytes: 1024,
    timeoutMs: 1000,
    ...overrides,
  };
}

function make(replies: Record<string, Reply>, observability?: Observability) {
  const f = fake(replies);
  const run = createPolicyFetch({
    fetchImpl: f.fetchImpl,
    policy,
    userAgent: 'pb-test/1',
    ...(observability ? { observability } : {}),
  });
  return { ...f, run };
}

async function failure(promise: Promise<unknown>): Promise<UpstreamError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamError);
    return error as UpstreamError;
  }
  throw new Error('expected a refusal');
}

describe('createPolicyFetch redirect mode', () => {
  it.each([301, 302, 307, 308])(
    'refuses a same-origin %s without requesting its target',
    async (status) => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      const { run, hops } = make({
        'https://a.example.com/start?x=1': new Response(body, {
          status,
          headers: { location: '/other' },
        }),
        'https://a.example.com/other': new Response('ok'),
      });
      await expect(run(request({ redirects: 'error' }))).rejects.toMatchObject({
        code: 'refused',
        reason: 'redirect_refused',
      });
      expect(hops.map((hop) => hop.url)).toEqual(['https://a.example.com/start?x=1']);
      expect(cancelled).toBe(true);
    },
  );

  it.each([300, 303, 305, 399])('refuses any %s with a Location', async (status) => {
    const { run, hops } = make({
      'https://a.example.com/start?x=1': redirect('/other', status),
    });
    await expect(run(request({ redirects: 'error' }))).rejects.toMatchObject({
      code: 'refused',
      reason: 'redirect_refused',
    });
    expect(hops).toHaveLength(1);
  });

  it('returns a conditional 304 with a Location in error mode', async () => {
    const { run, hops } = make({
      'https://a.example.com/start?x=1': new Response(null, {
        status: 304,
        headers: { location: '/other', etag: '"cached"' },
      }),
    });
    const response = await run(
      request({ redirects: 'error', headers: { 'if-none-match': '"cached"' } }),
    );
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe('"cached"');
    expect(response.body).toBeNull();
    expect(hops.map((hop) => hop.url)).toEqual(['https://a.example.com/start?x=1']);
    expect(hops[0]?.headers.get('if-none-match')).toBe('"cached"');
  });

  it('discards and refuses an opaque redirect in error mode', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    );
    Object.defineProperties(response, {
      status: { value: 0 },
      type: { value: 'opaqueredirect' },
    });
    const { run, hops } = make({ 'https://a.example.com/start?x=1': response });
    await expect(run(request({ redirects: 'error' }))).rejects.toMatchObject({
      code: 'refused',
      reason: 'redirect_refused',
    });
    expect(cancelled).toBe(true);
    expect(hops).toHaveLength(1);
  });

  it.each(['manual', '', null, true])(
    'refuses invalid redirects %j before fetching',
    async (redirects) => {
      const { run, hops } = make({ 'https://a.example.com/start?x=1': new Response('ok') });
      await expect(run(request({ redirects: redirects as never }))).rejects.toMatchObject({
        code: 'refused',
        reason: 'request',
      });
      expect(hops).toHaveLength(0);
    },
  );
});

describe('createPolicyFetch redirects and credentials', () => {
  it.each([0, 1, 2])('reports whether it followed %i redirects', async (count) => {
    const replies: Record<string, Reply> = {};
    for (let i = 0; i < count; i++) {
      replies[`https://a.example.com/${i}`] = redirect(`/${i + 1}`);
    }
    replies[`https://a.example.com/${count}`] = new Response('{"error":"Not found"}', {
      status: 404,
    });
    const { run, hops } = make(replies);
    const response = await run(request({ url: 'https://a.example.com/0' }));
    expect(response.status).toBe(404);
    expect(response.redirected).toBe(count > 0);
    expect(hops).toHaveLength(count + 1);
    await response.body?.cancel();
  });

  it('drops credentials, the credential header, the query parameter and caller headers on a cross-origin hop', async () => {
    const { run, hops } = make({
      [`https://a.example.com/start?x=1&token=${SECRET}`]: redirect(
        `https://b.example.com/dist.zip?token=${SECRET}&y=2`,
      ),
      'https://b.example.com/dist.zip?y=2': new Response('zip'),
    });
    const response = await run(request({ credential }));
    expect(await new Response(response.body).text()).toBe('zip');
    expect(hops).toHaveLength(2);
    const first = hops[0];
    expect(first?.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(first?.headers.get('x-api-key')).toBe(SECRET);
    expect(first?.headers.get('accept')).toBe('application/json');
    expect(first?.headers.get('user-agent')).toBe('pb-test/1');
    const second = hops[1];
    expect(second?.url).not.toContain(SECRET);
    expect(second?.headers.get('authorization')).toBeNull();
    expect(second?.headers.get('x-api-key')).toBeNull();
    expect(second?.headers.get('cookie')).toBeNull();
    expect(second?.headers.get('accept')).toBeNull();
    expect(second?.headers.get('user-agent')).toBe('pb-test/1');
  });

  it('keeps caller headers on a same-origin hop and strips the query credential from Location', async () => {
    const { run, hops } = make({
      [`https://a.example.com/start?x=1&token=${SECRET}`]: redirect(`/moved?token=${SECRET}`),
      'https://a.example.com/moved': new Response('ok'),
    });
    await run(request({ credential }));
    expect(hops[1]?.headers.get('accept')).toBe('application/json');
    expect(hops[1]?.url).toBe('https://a.example.com/moved');
  });

  it('applies a credential again only on a hop whose origin is bound, without the query parameter', async () => {
    const bound: UpstreamCredential = {
      ...credential,
      origins: ['https://a.example.com', 'https://b.example.com'],
      queryParams: [],
    };
    const { run, hops } = make({
      [`https://a.example.com/start?x=1&token=${SECRET}`]: redirect('https://b.example.com/d'),
      'https://b.example.com/d': new Response('ok'),
    });
    await run(request({ credential: bound }));
    expect(hops[1]?.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(hops[1]?.url).toBe('https://b.example.com/d');
  });

  it('calls apply only for a bound origin', async () => {
    const calls: string[] = [];
    const spy: UpstreamCredential = {
      origins: ['https://other.example.com'],
      queryParams: [],
      apply(headers, url) {
        calls.push(url.href);
        return { headers, url };
      },
    };
    const { run } = make({ 'https://a.example.com/start?x=1': new Response('ok') });
    await run(request({ credential: spy }));
    expect(calls).toEqual([]);
  });

  it.each([
    'https://10.0.0.5/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'http://b.example.com/x',
    'https://user:pw@b.example.com/x',
    'ftp://b.example.com/x',
  ])('refuses a redirect to %s without sending a request to it', async (location) => {
    const { run, hops } = make({ 'https://a.example.com/start?x=1': redirect(location) });
    const error = await failure(run(request()));
    expect(error.code).toBe('refused');
    expect(hops).toHaveLength(1);
  });

  it('refuses https to http even with an explicit port allowlist entry', async () => {
    const lax = createOutboundPolicy({
      allowPrivateHosts: ['plain.example.com:80'],
      runtime: 'node',
      selfOrigins: [],
    });
    const f = fake({ 'https://a.example.com/start?x=1': redirect('http://plain.example.com/x') });
    const run = createPolicyFetch({ fetchImpl: f.fetchImpl, policy: lax, userAgent: 'pb-test/1' });
    const error = await failure(run(request()));
    expect(error.code).toBe('refused');
    expect(error.reason).toBe('scheme');
    expect(f.hops).toHaveLength(1);
  });

  it('refuses http on port 443 under a host:443 entry before requesting it', async () => {
    const f = fake({ 'http://plain.example.com:443/x': new Response('ok') });
    const run = createPolicyFetch({
      fetchImpl: f.fetchImpl,
      policy: createOutboundPolicy({
        allowPrivateHosts: ['plain.example.com:443'],
        runtime: 'node',
        selfOrigins: [],
      }),
      userAgent: 'pb-test/1',
    });
    const error = await failure(run(request({ url: 'http://plain.example.com:443/x' })));
    expect(error.code).toBe('refused');
    expect(error.reason).toBe('scheme');
    expect(f.hops).toHaveLength(0);
  });

  it('refuses a redirect to http on port 443 under a host:443 entry', async () => {
    const f = fake({
      'https://plain.example.com/a': redirect('http://plain.example.com:443/b'),
      'http://plain.example.com:443/b': new Response('ok'),
    });
    const run = createPolicyFetch({
      fetchImpl: f.fetchImpl,
      policy: createOutboundPolicy({
        allowPrivateHosts: ['plain.example.com:443'],
        runtime: 'node',
        selfOrigins: [],
      }),
      userAgent: 'pb-test/1',
    });
    const error = await failure(run(request({ url: 'https://plain.example.com/a' })));
    expect(error.code).toBe('refused');
    expect(error.reason).toBe('scheme');
    expect(f.hops).toHaveLength(1);
  });

  it('allows https on port 443 under a host:443 entry', async () => {
    const f = fake({ 'https://plain.example.com/x': new Response('ok') });
    const run = createPolicyFetch({
      fetchImpl: f.fetchImpl,
      policy: createOutboundPolicy({
        allowPrivateHosts: ['plain.example.com:443'],
        runtime: 'node',
        selfOrigins: [],
      }),
      userAgent: 'pb-test/1',
    });
    const response = await run(request({ url: 'https://plain.example.com/x' }));
    expect(response.status).toBe(200);
  });

  it('refuses an HTTP redirect under a bare allowlist entry before requesting it', async () => {
    const f = fake({
      'https://repo.corp.internal/a': redirect('http://repo.corp.internal/b', 302),
      'http://repo.corp.internal/b': new Response('ok'),
    });
    const run = createPolicyFetch({
      fetchImpl: f.fetchImpl,
      policy: createOutboundPolicy({
        allowPrivateHosts: ['repo.corp.internal'],
        runtime: 'node',
        selfOrigins: [],
      }),
      userAgent: 'pb-test/1',
    });
    const error = await failure(
      run(
        request({
          url: 'https://repo.corp.internal/a',
          destinations: ['https://repo.corp.internal', 'http://repo.corp.internal'],
        }),
      ),
    );
    expect(error.code).toBe('refused');
    expect(error.reason).toBe('scheme');
    expect(f.hops.map((hop) => hop.url)).toEqual(['https://repo.corp.internal/a']);
  });

  it('refuses the start URL when it is classified as blocked', async () => {
    const { run, hops } = make({});
    const error = await failure(run(request({ url: 'https://169.254.169.254/latest' })));
    expect(error.code).toBe('refused');
    expect(hops).toHaveLength(0);
  });

  it('refuses a sixth redirect', async () => {
    const replies: Record<string, Reply> = { 'https://a.example.com/0': redirect('/1') };
    for (let i = 1; i <= 6; i++) replies[`https://a.example.com/${i}`] = redirect(`/${i + 1}`);
    const { run, hops } = make(replies);
    const error = await failure(run(request({ url: 'https://a.example.com/0' })));
    expect(error.code).toBe('refused');
    expect(hops).toHaveLength(6);
  });

  it('follows five redirects', async () => {
    const replies: Record<string, Reply> = { 'https://a.example.com/5': new Response('end') };
    for (let i = 0; i < 5; i++) replies[`https://a.example.com/${i}`] = redirect(`/${i + 1}`);
    const { run } = make(replies);
    const response = await run(request({ url: 'https://a.example.com/0' }));
    expect(response.status).toBe(200);
  });

  it('refuses a redirect status outside the allowed set and a redirect without Location', async () => {
    const a = make({ 'https://a.example.com/start?x=1': redirect('/x', 300) });
    expect((await failure(a.run(request()))).code).toBe('refused');
    const b = make({ 'https://a.example.com/start?x=1': new Response(null, { status: 302 }) });
    const error = await failure(b.run(request()));
    expect(error.code).toBe('http_status');
    expect(error.status).toBe(302);
  });

  it('returns 304 and 404 responses to the caller', async () => {
    const { run } = make({
      'https://a.example.com/start?x=1': new Response(null, { status: 304 }),
    });
    expect((await run(request())).status).toBe(304);
    const nf = make({ 'https://a.example.com/start?x=1': new Response('no', { status: 404 }) });
    expect((await nf.run(request())).status).toBe(404);
  });

  it('turns a POST into a GET without body on 303 and keeps both on 307', async () => {
    const body = new Uint8Array([1, 2, 3]);
    const post = make({
      'https://a.example.com/p': redirect('/q', 303),
      'https://a.example.com/q': new Response('ok'),
    });
    await post.run(
      request({
        url: 'https://a.example.com/p',
        method: 'POST',
        purpose: 'git',
        body,
        headers: { 'content-type': 'application/x-git-upload-pack-request' },
      }),
    );
    expect(post.hops[1]?.method).toBe('GET');
    expect(post.hops[1]?.body).toBeUndefined();
    const keep = make({
      'https://a.example.com/p': redirect('/q', 307),
      'https://a.example.com/q': new Response('ok'),
    });
    await keep.run(
      request({ url: 'https://a.example.com/p', method: 'POST', purpose: 'git', body }),
    );
    expect(keep.hops[1]?.method).toBe('POST');
    expect(keep.hops[1]?.body).toBe(body);
  });
});

describe('createPolicyFetch destinations', () => {
  it('refuses a hop to a public origin that is not a destination', async () => {
    const { run, hops } = make({
      'https://a.example.com/start?x=1': redirect('https://evil.example.org/x'),
    });
    const error = await failure(run(request({ destinations: ['https://a.example.com'] })));
    expect(error.code).toBe('refused');
    expect(error.reason).toBe('destination');
    expect(hops).toHaveLength(1);
  });

  it('refuses a start URL outside the destinations and allows a listed redirect target', async () => {
    const miss = make({});
    const e = await failure(miss.run(request({ destinations: ['https://z.example.com'] })));
    expect(e.reason).toBe('destination');
    expect(miss.hops).toHaveLength(0);
    const ok = make({
      'https://a.example.com/start?x=1': redirect('https://b.example.com/t'),
      'https://b.example.com/t': new Response('ok'),
    });
    const response = await ok.run(
      request({ destinations: ['https://a.example.com', 'https://b.example.com'] }),
    );
    expect(response.status).toBe(200);
  });
});

describe('createPolicyFetch bodies and timeouts', () => {
  it('errors mid-stream past maxBytes', async () => {
    const chunk = new Uint8Array(400);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const { run } = make({ 'https://a.example.com/start?x=1': new Response(stream) });
    const response = await run(request({ maxBytes: 1000 }));
    const reader = response.body?.getReader();
    let seen = 0;
    let caught: unknown;
    try {
      for (;;) {
        const { done, value } = (await reader?.read()) ?? { done: true, value: undefined };
        if (done) break;
        seen += value?.byteLength ?? 0;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).code).toBe('too_large');
    expect(seen).toBeLessThanOrEqual(1000);
  });

  it('accepts a body of exactly maxBytes', async () => {
    const { run } = make({ 'https://a.example.com/start?x=1': new Response('x'.repeat(10)) });
    const response = await run(request({ maxBytes: 10 }));
    expect((await new Response(response.body).text()).length).toBe(10);
  });

  it('refuses a declared Content-Length above maxBytes before reading', async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { run } = make({
      'https://a.example.com/start?x=1': new Response(stream, {
        headers: { 'content-length': '5000' },
      }),
    });
    const error = await failure(run(request({ maxBytes: 100 })));
    expect(error.code).toBe('too_large');
    expect(pulled).toBe(false);
  });

  it('times out with a fixed code', async () => {
    const { run } = make({
      'https://a.example.com/start?x=1': (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    });
    const error = await failure(run(request({ timeoutMs: 20 })));
    expect(error.code).toBe('timeout');
  });

  it('times out while the body is streaming', async () => {
    const { run } = make({
      'https://a.example.com/start?x=1': (signal) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => controller.error(signal.reason));
          },
        });
        return Promise.resolve(new Response(stream));
      },
    });
    const response = await run(request({ timeoutMs: 20 }));
    let caught: unknown;
    try {
      await new Response(response.body).arrayBuffer();
    } catch (error) {
      caught = error;
    }
    expect((caught as UpstreamError).code).toBe('timeout');
  });

  it('maps a transport failure to the network code without its message', async () => {
    const f = createPolicyFetch({
      fetchImpl: () => Promise.reject(new Error(`boom ${SECRET}`)),
      policy,
      userAgent: 'pb-test/1',
    });
    const error = await failure(f(request()));
    expect(error.code).toBe('network');
    expect(error.message).not.toContain(SECRET);
  });

  it('refuses a body on GET, a body above 1 MiB and a non-positive limit', async () => {
    const { run, hops } = make({});
    expect((await failure(run(request({ body: new Uint8Array(1) })))).code).toBe('refused');
    const big = request({ method: 'POST', purpose: 'git', body: new Uint8Array(1024 * 1024 + 1) });
    expect((await failure(run(big))).code).toBe('refused');
    expect((await failure(run(request({ maxBytes: 0 })))).code).toBe('refused');
    expect(hops).toHaveLength(0);
  });
});

describe('createPolicyFetch headers', () => {
  it('keeps Git-Protocol for git and X-GitHub-Api-Version for api, and drops unlisted headers', async () => {
    const git = make({ 'https://a.example.com/start?x=1': new Response('ok') });
    await git.run(
      request({
        purpose: 'git',
        headers: {
          accept: '*/*',
          'git-protocol': 'version=2',
          'x-unlisted': '1',
          cookie: 'a=b',
          authorization: 'Bearer x',
        },
      }),
    );
    const sent = git.hops[0]?.headers;
    expect(sent?.get('git-protocol')).toBe('version=2');
    expect(sent?.get('x-unlisted')).toBeNull();
    expect(sent?.get('cookie')).toBeNull();
    expect(sent?.get('authorization')).toBeNull();

    const api = make({ 'https://a.example.com/start?x=1': new Response('ok') });
    await api.run(
      request({
        purpose: 'api',
        headers: {
          'x-github-api-version': GITHUB_API_VERSION,
          'content-type': 'application/json',
        },
      }),
    );
    expect(api.hops[0]?.headers.get('x-github-api-version')).toBe(GITHUB_API_VERSION);
  });

  it.each([
    ['git', { 'git-protocol': 'version=1' }],
    ['git', { 'content-type': 'text/plain' }],
    ['api', { 'x-github-api-version': '1999-01-01' }],
    ['api', { 'content-type': 'text/plain' }],
    ['metadata', { accept: 'a\r\nx: y' }],
  ] as const)('refuses a wrong value for %s %j', async (purpose, headers) => {
    const { run, hops } = make({ 'https://a.example.com/start?x=1': new Response('ok') });
    const error = await failure(run(request({ purpose, headers })));
    expect(error.code).toBe('refused');
    expect(hops).toHaveLength(0);
  });

  it('does not allow git-protocol on a metadata request and ignores a client user-agent', async () => {
    const { run, hops } = make({ 'https://a.example.com/start?x=1': new Response('ok') });
    await run(
      request({
        headers: { 'git-protocol': 'version=2', 'user-agent': 'composer/2', accept: '*/*' },
      }),
    );
    expect(hops[0]?.headers.get('git-protocol')).toBeNull();
    expect(hops[0]?.headers.get('user-agent')).toBe('pb-test/1');
  });
});

describe('createPolicyFetch observability', () => {
  it('records only the purpose and never the credential or the query', async () => {
    const { obs, seen } = recorder();
    const { run } = make(
      {
        [`https://a.example.com/start?x=1&token=${SECRET}`]: redirect(
          `https://b.example.com/d?token=${SECRET}`,
        ),
        'https://b.example.com/d': new Response('x'.repeat(50)),
      },
      obs,
    );
    const response = await run(request({ credential, maxBytes: 10 }));
    const failed = await failure(new Response(response.body).arrayBuffer());
    const bad = make({ 'https://127.0.0.1/?token=1': new Response('') }, obs);
    const refused = await failure(bad.run(request({ url: `https://127.0.0.1/?token=${SECRET}` })));
    const dump = JSON.stringify(seen) + failed.message + refused.message + String(refused.stack);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('x=1');
    expect(dump).not.toContain('example.com');
    expect(seen.length).toBeGreaterThan(0);
    expect(dump).toContain('metadata');
  });
});

describe('createPolicyFetch round 2', () => {
  const tokenCredential: UpstreamCredential = {
    origins: ['https://a.example.com'],
    queryParams: [],
    apply(headers, url) {
      const next = new URL(url);
      next.searchParams.set('access_token', SECRET);
      return { headers, url: next };
    },
  };

  it('strips a query name it derived from apply without any declaration', async () => {
    const { run, hops } = make({
      [`https://a.example.com/s?access_token=${SECRET}`]: redirect(
        `https://b.example.com/d?access_token=${SECRET}&k=1`,
      ),
      'https://b.example.com/d?k=1': new Response('ok'),
    });
    await run(request({ url: 'https://a.example.com/s', credential: tokenCredential }));
    expect(hops[1]?.url).toBe('https://b.example.com/d?k=1');
  });

  it('does not apply a credential bound to a host to its trailing-dot spelling', async () => {
    const calls: string[] = [];
    const spy: UpstreamCredential = {
      origins: ['https://a.example.com'],
      queryParams: [],
      apply(headers, url) {
        calls.push(url.href);
        return { headers, url };
      },
    };
    const { run, hops } = make({ 'https://a.example.com./x': new Response('ok') });
    await run(request({ url: 'https://a.example.com./x', credential: spy }));
    expect(calls).toEqual([]);
    expect(hops).toHaveLength(1);
  });

  it('never re-applies a credential after the chain left the bound origins', async () => {
    const calls: string[] = [];
    const spy: UpstreamCredential = {
      origins: ['https://a.example.com'],
      queryParams: [],
      apply(headers, url) {
        calls.push(url.hostname);
        return { headers, url };
      },
    };
    const { run } = make({
      'https://a.example.com/1': redirect('https://b.example.com/2'),
      'https://b.example.com/2': redirect('https://a.example.com/3'),
      'https://a.example.com/3': new Response('ok'),
    });
    await run(request({ url: 'https://a.example.com/1', credential: spy }));
    expect(calls).toEqual(['a.example.com']);
  });

  it('refuses an apply that changes the path or origin', async () => {
    for (const mutate of [
      (u: URL) => new URL('/other', u),
      (u: URL) => new URL(u.pathname, 'https://evil.example.org'),
    ]) {
      const { run, hops } = make({});
      const bad: UpstreamCredential = {
        origins: ['https://a.example.com'],
        queryParams: [],
        apply: (headers, url) => ({ headers, url: mutate(url) }),
      };
      const error = await failure(run(request({ credential: bad })));
      expect(error.reason).toBe('credential');
      expect(hops).toHaveLength(0);
    }
  });

  it('leaves unrelated query bytes of a signed redirect untouched', async () => {
    const signed =
      'https://b.example.com/f?X-Amz-Signature=ab%2Bcd%3D&X-Amz-Date=20260101T000000Z&a=%20b+c&access_token=1';
    const { run, hops } = make({
      [`https://a.example.com/s?access_token=${SECRET}`]: redirect(signed),
      'https://b.example.com/f?X-Amz-Signature=ab%2Bcd%3D&X-Amz-Date=20260101T000000Z&a=%20b+c':
        new Response('ok'),
    });
    await run(request({ url: 'https://a.example.com/s', credential: tokenCredential }));
    expect(hops[1]?.url).toBe(
      'https://b.example.com/f?X-Amz-Signature=ab%2Bcd%3D&X-Amz-Date=20260101T000000Z&a=%20b+c',
    );
  });

  it('keeps a Location byte-identical when no stripped name is present', async () => {
    const loc = 'https://b.example.com/f?X-Amz-Signature=ab%2Bcd%3D&a=%20b+c';
    const { run, hops } = make({
      [`https://a.example.com/s?access_token=${SECRET}`]: redirect(loc),
      [loc]: new Response('ok'),
    });
    await run(request({ url: 'https://a.example.com/s', credential: tokenCredential }));
    expect(hops[1]?.url).toBe(loc);
  });

  it('never forwards prototype-named headers and refuses unknown purposes and methods', async () => {
    const headers = JSON.parse(
      '{"__proto__":"x","constructor":"x","toString":"x","hasOwnProperty":"x","accept":"a"}',
    ) as Record<string, string>;
    const { run, hops } = make({ 'https://a.example.com/start?x=1': new Response('ok') });
    await run(request({ headers }));
    const names = [...(hops[0]?.headers.keys() ?? [])].sort();
    expect(names).toEqual(['accept', 'user-agent']);
    for (const purpose of ['constructor', '__proto__', 'toString', 'other']) {
      const e = await failure(run(request({ purpose: purpose as never })));
      expect(e.code).toBe('refused');
    }
    expect((await failure(run(request({ method: 'DELETE' as never })))).code).toBe('refused');
    expect(hops).toHaveLength(1);
  });

  it('does not enforce Content-Length for HEAD, 204 and 304', async () => {
    for (const [method, status] of [
      ['HEAD', 200],
      ['GET', 204],
      ['GET', 304],
    ] as const) {
      const { run } = make({
        'https://a.example.com/start?x=1': new Response(null, {
          status,
          headers: { 'content-length': '99999' },
        }),
      });
      expect((await run(request({ method, maxBytes: 10 }))).status).toBe(status);
    }
  });

  it('maps a caller abort to its own code and applies a headers timeout cleared on headers', async () => {
    const hang: Reply = (signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    const controller = new AbortController();
    const a = make({ 'https://a.example.com/start?x=1': hang });
    const pending = failure(a.run(request({ signal: controller.signal, timeoutMs: 5000 })));
    setTimeout(() => controller.abort(), 10);
    const aborted = await pending;
    expect(aborted.code).toBe('network');
    expect(aborted.reason).toBe('aborted');

    const b = make({ 'https://a.example.com/start?x=1': hang });
    const started = Date.now();
    const e = await failure(b.run(request({ timeoutMs: 5000, headersTimeoutMs: 20 })));
    expect(e.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);

    const slowBody: Reply = () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          setTimeout(() => {
            c.enqueue(new Uint8Array(3));
            c.close();
          }, 80);
        },
      });
      return Promise.resolve(new Response(stream));
    };
    const c = make({ 'https://a.example.com/start?x=1': slowBody });
    const response = await c.run(request({ timeoutMs: 5000, headersTimeoutMs: 30 }));
    expect((await new Response(response.body).arrayBuffer()).byteLength).toBe(3);
  });

  it('drops body headers when a redirect turns POST into GET', async () => {
    const { run, hops } = make({
      'https://a.example.com/p': redirect('/q', 302),
      'https://a.example.com/q': new Response('ok'),
    });
    await run(
      request({
        url: 'https://a.example.com/p',
        method: 'POST',
        purpose: 'git',
        body: new Uint8Array([1]),
        headers: { 'content-type': 'application/x-git-upload-pack-request', accept: '*/*' },
      }),
    );
    expect(hops[1]?.headers.get('content-type')).toBeNull();
    expect(hops[1]?.headers.get('accept')).toBe('*/*');
  });

  it('canonicalises and validates origins and destinations', async () => {
    const ok = make({ 'https://a.example.com/start?x=1': new Response('ok') });
    expect((await ok.run(request({ destinations: ['HTTPS://A.Example.com:443'] }))).status).toBe(
      200,
    );
    for (const bad of [
      'https://a.example.com/path',
      'https://a.example.com/?q=1',
      'https://u@a.example.com',
      'a.example.com',
    ]) {
      const dest = make({});
      expect((await failure(dest.run(request({ destinations: [bad] })))).reason).toBe('origin');
      const cred = make({});
      const error = await failure(
        cred.run(
          request({
            credential: {
              origins: [bad],
              queryParams: [],
              apply: (h, u) => ({ headers: h, url: u }),
            },
          }),
        ),
      );
      expect(error.reason).toBe('origin');
      expect(dest.hops.length + cred.hops.length).toBe(0);
    }
  });

  it('refuses an opaque redirect response', async () => {
    const f = createPolicyFetch({
      fetchImpl: () =>
        Promise.resolve({
          status: 0,
          type: 'opaqueredirect',
          headers: new Headers(),
          body: null,
        } as unknown as Response),
      policy,
      userAgent: 'pb-test/1',
    });
    expect((await failure(f(request()))).reason).toBe('opaque_redirect');
  });

  it('emits only registered metrics through the real sink, including body-stream errors', async () => {
    const records: ObsRecord[] = [];
    const obs = createObservability(
      { emit: (r) => void records.push(r) },
      { deploymentId: 'dep-1', runtime: 'node', requestId: null },
      { events: new Set(), reasonCodes: new Set(), routeTemplates: new Set() },
    );
    const ok = make({ 'https://a.example.com/start?x=1': new Response('abc') }, obs);
    await new Response((await ok.run(request())).body).arrayBuffer();
    const big = make({ 'https://a.example.com/start?x=1': new Response('x'.repeat(50)) }, obs);
    await failure(new Response((await big.run(request({ maxBytes: 10 }))).body).arrayBuffer());
    await failure(make({}, obs).run(request({ url: 'https://10.0.0.1/' })));
    const names = records.map((r) => (r.kind === 'log' ? 'log' : r.name));
    expect(names).not.toContain('pb.obs.dropped');
    expect(new Set(names)).toEqual(new Set(['pb.upstream.requests', 'pb.upstream.duration_ms']));
    const outcomes = records.flatMap((r) => (r.kind === 'counter' ? [r.labels['outcome']] : []));
    expect(outcomes.sort()).toEqual(['body_too_large', 'ok', 'ok', 'refused']);
    expect(JSON.stringify(records)).not.toContain('example.com');
  });

  it('adds no trace header and no request detail when a parent span is supplied', async () => {
    const { obs, seen } = recorder();
    const f = fake({ [`https://a.example.com/s?access_token=${SECRET}`]: new Response('ok') });
    const run = createPolicyFetch({
      fetchImpl: f.fetchImpl,
      policy,
      userAgent: 'pb-test/1',
      observability: obs,
      span: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
    });
    await run(request({ url: 'https://a.example.com/s', credential: tokenCredential }));
    expect(f.hops[0]?.headers.get('traceparent')).toBeNull();
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(JSON.stringify(seen)).not.toContain('example.com');
  });

  it('strips a token from Location even when the initial URL already carried the same value', async () => {
    const { run, hops } = make({
      [`https://a.example.com/s?token=${SECRET}`]: redirect(
        `https://b.example.com/d?token=${SECRET}&k=1`,
      ),
      'https://b.example.com/d?k=1': new Response('ok'),
    });
    const same: UpstreamCredential = {
      origins: ['https://a.example.com'],
      queryParams: ['token'],
      apply(headers, url) {
        const next = new URL(url);
        next.searchParams.set('token', SECRET);
        return { headers, url: next };
      },
    };
    await run(request({ url: `https://a.example.com/s?token=${SECRET}`, credential: same }));
    expect(hops[1]?.url).toBe('https://b.example.com/d?k=1');
  });

  it('reports too_large without waiting for the source to cancel', async () => {
    const stuck = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>(
        {
          pull(c) {
            c.enqueue(new Uint8Array(50));
          },
          cancel: () => new Promise(() => undefined),
        },
        { highWaterMark: 0 },
      );
    const streamed = make({ 'https://a.example.com/start?x=1': new Response(stuck()) });
    const response = await streamed.run(request({ maxBytes: 10 }));
    await expect(new Response(response.body).arrayBuffer()).rejects.toMatchObject({
      code: 'too_large',
    });
    const declared = make({
      'https://a.example.com/start?x=1': new Response(stuck(), {
        headers: { 'content-length': '5000' },
      }),
    });
    expect((await failure(declared.run(request({ maxBytes: 10 })))).code).toBe('too_large');
  });

  it('refuses an apply that adds userinfo or changes the hash', async () => {
    for (const mutate of [
      (u: URL) => Object.assign(new URL(u), { username: 'u', password: 'p' }),
      (u: URL) => Object.assign(new URL(u), { hash: '#frag' }),
    ]) {
      const { run, hops } = make({});
      const bad: UpstreamCredential = {
        origins: ['https://a.example.com'],
        queryParams: [],
        apply: (headers, url) => ({ headers, url: mutate(url) }),
      };
      expect((await failure(run(request({ credential: bad })))).reason).toBe('credential');
      expect(hops).toHaveLength(0);
    }
  });

  it('emits the request metric when headers arrive, with the status class, even if the body is unread', async () => {
    const records: ObsRecord[] = [];
    const obs = createObservability(
      { emit: (r) => void records.push(r) },
      { deploymentId: 'dep-1', runtime: 'node', requestId: null },
      { events: new Set(), reasonCodes: new Set(), routeTemplates: new Set() },
    );
    const ok = make({ 'https://a.example.com/start?x=1': new Response('abc') }, obs);
    await ok.run(request());
    const missing = make(
      { 'https://a.example.com/start?x=1': new Response('no', { status: 404 }) },
      obs,
    );
    await missing.run(request());
    const counters = records.filter((r) => r.kind === 'counter');
    expect(counters.map((r) => r.labels)).toEqual([
      { kind: 'metadata', outcome: 'ok', status_class: '2xx' },
      { kind: 'metadata', outcome: 'ok', status_class: '4xx' },
    ]);
    expect(records.map((r) => (r.kind === 'log' ? 'log' : r.name))).not.toContain('pb.obs.dropped');
  });

  it('defaults the headers timeout to at most 30 seconds', async () => {
    const real = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return real(fn, ms);
    }) as typeof setTimeout;
    try {
      const { run } = make({ 'https://a.example.com/start?x=1': new Response('ok') });
      await run(request({ timeoutMs: 600000 }));
    } finally {
      globalThis.setTimeout = real;
    }
    expect(delays).toContain(30000);
    expect(delays).not.toContain(600000);
  });
});
