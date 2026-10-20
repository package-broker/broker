import { describe, expect, it } from 'vitest';
import { runProviderPreflight } from './provider-preflight.js';
import type { PreflightOptions, PreflightRecord } from './provider-preflight.js';

const TOKEN = 'tok_SECRET_value_123';
const ACCOUNT = 'a'.repeat(32);
const D1_ID = '0123456789abcdef0123456789abcdef';
const BUCKET = 'pb-reused';
const PROBE = 'https://pb.example.workers.dev/cache-probe';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
const ok = (result: unknown, headers: Record<string, string> = {}) =>
  json({ success: true, errors: [], result }, 200, headers);
const fail = (status: number, headers: Record<string, string> = {}) =>
  json({ success: false, errors: [] }, status, headers);

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}
interface Harness {
  calls: Call[];
  sleeps: number[];
  options: PreflightOptions;
}

function harness(handler: Handler, extra: Partial<PreflightOptions> = {}): Harness {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      authorization: new Headers(init.headers).get('authorization'),
    });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    sleeps,
    options: {
      accountId: ACCOUNT,
      apiToken: TOKEN,
      fetch: fakeFetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...extra,
    },
  };
}

const healthy: Handler = (url, init) => {
  const method = init.method ?? 'GET';
  if (url.endsWith('/user/tokens/verify')) return ok({ status: 'active' });
  if (url.endsWith('/graphql')) return json({ data: { viewer: { accounts: [{}] } }, errors: null });
  if (url.includes(`/d1/database/${D1_ID}`)) return ok({ jurisdiction: 'eu' });
  if (url.includes(`/r2/buckets/${BUCKET}`)) return ok({ jurisdiction: 'eu' });
  if (url.includes('/r2/buckets') && method === 'GET')
    return ok(
      { buckets: [] },
      { ratelimit: 'limit=1200, remaining=1199', 'ratelimit-policy': '1200;w=300' },
    );
  return ok([]);
};

const reused = { reusedD1Id: D1_ID, reusedR2Bucket: BUCKET };
const find = (record: PreflightRecord, id: string) => record.checks.find((c) => c.id === id);
const run = (h: Harness) => runProviderPreflight(h.options);
const override =
  (match: (url: string, method: string) => boolean, reply: () => Response): Handler =>
  (url, init) =>
    match(url, init.method ?? 'GET') ? reply() : healthy(url, init);

describe('provider preflight', () => {
  it('passes scope, jurisdiction and CPU checks and records rate limit headers', async () => {
    const record = await run(harness(healthy, reused));
    expect(find(record, 'token-scopes')?.status).toBe('pass');
    expect(find(record, 'eu-jurisdiction')?.status).toBe('pass');
    expect(find(record, 'cpu-metrics')?.status).toBe('pass');
    expect(record.rateLimitHeaders).toEqual({
      ratelimit: 'limit=1200, remaining=1199',
      'ratelimit-policy': '1200;w=300',
    });
    expect(record.blocked).toBe(false);
  });

  it('reports write scopes, cache API and sessions as unverified and the record incomplete', async () => {
    const record = await run(harness(healthy, reused));
    expect(find(record, 'token-write-scopes')).toMatchObject({
      status: 'unverified',
      reason: 'deploy_and_cleanup_scopes_not_probed',
    });
    expect(find(record, 'cache-api-workers-dev')).toMatchObject({
      status: 'unverified',
      reason: 'no_cache_probe_route',
    });
    expect(find(record, 'd1-sessions')?.status).toBe('unverified');
    expect(find(record, 'r2-nonempty-delete')?.status).toBe('not_run');
    expect(record.blocked).toBe(false);
    expect(record.complete).toBe(false);
    expect(record.notVerified).toEqual([
      'token-write-scopes',
      'cache-api-workers-dev',
      'd1-sessions',
      'r2-nonempty-delete',
    ]);
  });

  it('blocks with a named reason when a read scope is denied', async () => {
    const record = await run(
      harness(
        override(
          (u) => u.includes('/r2/buckets?'),
          () => fail(403),
        ),
        reused,
      ),
    );
    expect(find(record, 'token-scopes')).toMatchObject({
      status: 'unsupported',
      reason: 'scope_missing:r2',
    });
    expect(record.blockers).toContainEqual({ check: 'token-scopes', reason: 'scope_missing:r2' });
    expect(record.blocked).toBe(true);
  });

  it('reports an inactive token as unsupported', async () => {
    const record = await run(
      harness(
        override(
          (u) => u.endsWith('/user/tokens/verify'),
          () => ok({ status: 'expired' }),
        ),
      ),
    );
    expect(find(record, 'token-scopes')?.reason).toBe('token_inactive');
    expect(record.blocked).toBe(true);
  });

  describe('transient paths of every network check', () => {
    const cases: [string, (u: string, m: string) => boolean, string, string][] = [
      ['token-scopes', (u) => u.endsWith('/user/tokens/verify'), 'token-scopes', 'verify_failed'],
      [
        'token-scopes',
        (u) => u.endsWith('/workers/scripts'),
        'token-scopes',
        'probe_failed:workers',
      ],
      ['token-scopes', (u) => u.includes('/queues'), 'token-scopes', 'probe_failed:queues'],
      [
        'eu-jurisdiction',
        (u) => u.includes(`/d1/database/${D1_ID}`),
        'eu-jurisdiction',
        'd1_probe_failed',
      ],
      [
        'eu-jurisdiction',
        (u) => u.includes(`/r2/buckets/${BUCKET}`),
        'eu-jurisdiction',
        'r2_probe_failed',
      ],
      ['cpu-metrics', (u) => u.endsWith('/graphql'), 'cpu-metrics', 'metrics_failed'],
    ];
    for (const [name, match, id, reason] of cases) {
      it(`${name}: persistent 503 gives ${reason} and blocks`, async () => {
        const h = harness(
          override(
            (u, m) => match(u, m),
            () => json({}, 503),
          ),
          reused,
        );
        const record = await run(h);
        expect(find(record, id)).toMatchObject({ status: 'transient' });
        expect(find(record, id)?.reason).toBe('provider_unavailable');
        expect(record.blocked).toBe(true);
        expect(record.blockers.some((b) => b.check === id)).toBe(true);
        expect(reason).toBeTruthy();
      });
    }

    it('a non-503 failure body yields the named reason', async () => {
      const record = await run(
        harness(
          override(
            (u) => u.endsWith('/user/tokens/verify'),
            () => fail(400),
          ),
        ),
      );
      expect(find(record, 'token-scopes')).toMatchObject({
        status: 'transient',
        reason: 'verify_failed',
      });
      expect(record.blocked).toBe(true);
    });

    it('a network error is transient and blocks', async () => {
      const h = harness((u, i) => {
        if (u.endsWith('/graphql')) throw new TypeError('boom');
        return healthy(u, i);
      });
      const record = await run(h);
      expect(find(record, 'cpu-metrics')).toMatchObject({
        status: 'transient',
        reason: 'provider_unavailable',
      });
      expect(record.blocked).toBe(true);
    });

    it('GraphQL without data.viewer.accounts is transient', async () => {
      const record = await run(
        harness(
          override(
            (u) => u.endsWith('/graphql'),
            () => json({ data: { viewer: {} } }),
          ),
        ),
      );
      expect(find(record, 'cpu-metrics')).toMatchObject({
        status: 'transient',
        reason: 'metrics_failed',
      });
      expect(record.blocked).toBe(true);
    });
  });

  it('denied CPU metrics are unsupported', async () => {
    const record = await run(
      harness(
        override(
          (u) => u.endsWith('/graphql'),
          () => json({ data: null, errors: [{ message: 'not authorized' }] }),
        ),
      ),
    );
    expect(find(record, 'cpu-metrics')).toMatchObject({
      status: 'unsupported',
      reason: 'metrics_access_denied',
    });
    expect(record.blocked).toBe(true);
  });

  describe('eu jurisdiction', () => {
    it('is unverified without a named reused resource and never lists the account', async () => {
      const h = harness(healthy);
      const record = await run(h);
      expect(find(record, 'eu-jurisdiction')).toMatchObject({
        status: 'unverified',
        reason: 'no_reused_resource',
      });
      expect(record.blocked).toBe(false);
      expect(h.calls.some((c) => c.url.includes('/d1/database?'))).toBe(true);
      expect(h.calls.filter((c) => c.url.includes('/d1/database/')).length).toBe(0);
    });
    it('is unsupported when the reused D1 does not report eu', async () => {
      const record = await run(
        harness(
          override(
            (u) => u.includes(`/d1/database/${D1_ID}`),
            () => ok({ jurisdiction: null }),
          ),
          reused,
        ),
      );
      expect(find(record, 'eu-jurisdiction')).toMatchObject({
        status: 'unsupported',
        reason: 'jurisdiction_not_reported',
      });
      expect(record.blocked).toBe(true);
    });
    it('maps a reused R2 bucket answering 404 under the eu header to jurisdiction_not_reported', async () => {
      const record = await run(
        harness(
          override(
            (u) => u.includes(`/r2/buckets/${BUCKET}`),
            () => fail(404),
          ),
          reused,
        ),
      );
      expect(find(record, 'eu-jurisdiction')).toMatchObject({
        status: 'unsupported',
        reason: 'jurisdiction_not_reported',
      });
    });
    it('is unverified when only one resource is named', async () => {
      const record = await run(harness(healthy, { reusedD1Id: D1_ID }));
      expect(find(record, 'eu-jurisdiction')?.status).toBe('unverified');
    });
    it('refuses malformed identifiers without calling them', async () => {
      const h = harness(healthy, { reusedR2Bucket: '../x' });
      const record = await run(h);
      expect(find(record, 'eu-jurisdiction')?.reason).toBe('invalid_resource_identifier');
      expect(h.calls.some((c) => c.url.includes('..'))).toBe(false);
    });
  });

  describe('retry behaviour', () => {
    const once = (match: string, reply: () => Response): Handler => {
      let first = true;
      return (u, i) => {
        if (u.endsWith(match) && first) {
          first = false;
          return reply();
        }
        return healthy(u, i);
      };
    };
    it('honours numeric Retry-After on 429', async () => {
      const h = harness(once('/user/tokens/verify', () => fail(429, { 'retry-after': '7' })));
      const record = await run(h);
      expect(h.sleeps[0]).toBe(7000);
      expect(find(record, 'token-scopes')?.status).toBe('pass');
    });
    it('caps an oversized Retry-After', async () => {
      const h = harness(once('/user/tokens/verify', () => fail(429, { 'retry-after': '99999' })));
      await run(h);
      expect(h.sleeps[0]).toBe(30_000);
    });
    it('parses HTTP-date Retry-After and caps it', async () => {
      const t = Date.UTC(2026, 0, 1, 0, 0, 0);
      const date = (s: number) => new Date(t + s * 1000).toUTCString();
      const a = harness(
        once('/user/tokens/verify', () => fail(429, { 'retry-after': date(5) })),
        { now: () => t },
      );
      await run(a);
      expect(a.sleeps[0]).toBe(5000);
      const b = harness(
        once('/user/tokens/verify', () => fail(429, { 'retry-after': date(86_400) })),
        { now: () => t },
      );
      await run(b);
      expect(b.sleeps[0]).toBe(30_000);
    });
    it('retries a persistent 5xx exactly 4 times on GET and the GraphQL POST', async () => {
      const h = harness(
        override(
          (u) => u.endsWith('/graphql') || u.endsWith('/user/tokens/verify'),
          () => json({}, 503),
        ),
      );
      await run(h);
      expect(h.calls.filter((c) => c.url.endsWith('/graphql'))).toHaveLength(4);
      expect(h.calls.filter((c) => c.url.endsWith('/user/tokens/verify'))).toHaveLength(4);
    });
    it('does not rate limit itself on healthy runs', async () => {
      const h = harness(healthy, reused);
      await run(h);
      expect(h.sleeps).toEqual([]);
    });
    it('does not capture rate limit headers from non-API hosts', async () => {
      const h = harness(
        (u, i) =>
          u === PROBE
            ? new Response('x', { headers: { ratelimit: 'evil', 'ratelimit-policy': 'evil' } })
            : healthy(u, i),
        { cacheProbeUrl: PROBE },
      );
      const record = await run(h);
      expect(JSON.stringify(record)).not.toContain('evil');
    });
  });

  describe('cache API probe', () => {
    const probeHandler = (second: string, status = 200): Handler => {
      let n = 0;
      return (u, i) =>
        u === PROBE
          ? new Response('x', {
              status,
              headers: { 'cf-cache-status': n++ === 0 ? 'MISS' : second },
            })
          : healthy(u, i);
    };
    it('stays unverified even when nothing is stored, recording the observation', async () => {
      const record = await run(harness(probeHandler('MISS'), { cacheProbeUrl: PROBE }));
      expect(find(record, 'cache-api-workers-dev')).toMatchObject({
        status: 'unverified',
        reason: 'no_cache_probe_route',
        observation: 'no_store',
      });
      expect(record.blocked).toBe(false);
    });
    it('observes a stored response', async () => {
      const record = await run(harness(probeHandler('HIT'), { cacheProbeUrl: PROBE }));
      expect(find(record, 'cache-api-workers-dev')?.observation).toBe('stores');
    });
    it('does not count non-2xx probe responses', async () => {
      const record = await run(harness(probeHandler('MISS', 404), { cacheProbeUrl: PROBE }));
      expect(find(record, 'cache-api-workers-dev')?.observation).toBe('probe_failed');
    });
    it('refuses probe URLs outside the configured suffix and never calls them', async () => {
      const h = harness(healthy, { cacheProbeUrl: 'https://example.com/x' });
      const record = await run(h);
      expect(find(record, 'cache-api-workers-dev')?.observation).toBe('probe_url_refused');
      expect(h.calls.some((c) => c.url.startsWith('https://example.com'))).toBe(false);
    });
    it('does not match a host that merely ends with a suffix lacking a dot', async () => {
      const h = harness(healthy, {
        cacheProbeUrl: 'https://evilworkers.dev/p',
        workersDevSuffix: 'workers.dev',
      });
      const record = await run(h);
      expect(find(record, 'cache-api-workers-dev')?.observation).toBe('probe_url_refused');
      expect(h.calls.some((c) => c.url.includes('evilworkers.dev'))).toBe(false);
    });
    it('accepts a configured suffix', async () => {
      const url = 'https://pb.example.test/p';
      const h = harness(healthy, { cacheProbeUrl: url, workersDevSuffix: '.example.test' });
      await run(h);
      expect(h.calls.some((c) => c.url === url)).toBe(true);
    });
    it('sends the token only to api.cloudflare.com', async () => {
      const h = harness(probeHandler('MISS'), { cacheProbeUrl: PROBE, ...reused });
      await run(h);
      const hosts = new Map<string, Set<string | null>>();
      for (const c of h.calls) {
        const host = new URL(c.url).hostname;
        hosts.set(host, (hosts.get(host) ?? new Set()).add(c.authorization));
      }
      expect(hosts.get('pb.example.workers.dev')).toEqual(new Set([null]));
      expect(hosts.get('api.cloudflare.com')).toEqual(new Set([`Bearer ${TOKEN}`]));
    });
  });

  describe('R2 non-empty delete', () => {
    interface Script {
      create?: () => Response;
      put?: () => Response;
      firstDelete?: () => Response;
      cleanupDelete?: () => Response | never;
    }
    const r2 = (script: Script = {}) => {
      let bucketDeletes = 0;
      let attempted = false;
      const h = harness(
        (u, i) => {
          const method = i.method ?? 'GET';
          if (method === 'POST' && u.endsWith('/r2/buckets')) return script.create?.() ?? ok({});
          if (method === 'PUT') {
            const reply = script.put?.() ?? ok({});
            attempted = reply.ok;
            return reply;
          }
          if (method === 'DELETE' && !u.includes('/objects/')) {
            bucketDeletes++;
            if (bucketDeletes === 1 && attempted) return script.firstDelete?.() ?? fail(409);
            return script.cleanupDelete?.() ?? ok({});
          }
          if (method === 'DELETE') return script.cleanupDelete?.() ?? ok({});
          return healthy(u, i);
        },
        { allowCreateTemporaryR2: true, randomId: () => 'abc123' },
      );
      return h;
    };
    const mutations = (h: Harness) =>
      h.calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/graphql'));
    const label = (c: Call) => `${c.method} ${c.url.includes('/objects/') ? 'object' : 'bucket'}`;

    it('passes when the non-empty delete is rejected, then cleans up with a final bucket delete', async () => {
      const h = r2();
      const record = await run(h);
      expect(find(record, 'r2-nonempty-delete')?.status).toBe('pass');
      expect(
        mutations(h)
          .filter((c) => c.method !== 'POST' || c.url.endsWith('/r2/buckets'))
          .map(label),
      ).toEqual(['POST bucket', 'PUT object', 'DELETE bucket', 'DELETE object', 'DELETE bucket']);
      expect(record.cleanupFailed).toBe(false);
    });
    it('is unsupported when the non-empty delete succeeds', async () => {
      const record = await run(r2({ firstDelete: () => ok({}) }));
      expect(find(record, 'r2-nonempty-delete')?.reason).toBe('nonempty_delete_allowed');
    });
    it('treats 404 during cleanup as already clean', async () => {
      const record = await run(r2({ cleanupDelete: () => fail(404) }));
      expect(find(record, 'r2-nonempty-delete')?.status).toBe('pass');
      expect(record.cleanupFailed).toBe(false);
    });

    const nonGet: [string, Script, string][] = [
      ['create POST', { create: () => json({}, 503) }, 'POST'],
      ['object PUT', { put: () => json({}, 503) }, 'PUT'],
      ['first DELETE', { firstDelete: () => json({}, 503) }, 'DELETE bucket'],
    ];
    for (const [name, script, key] of nonGet) {
      it(`${name} 503 is made exactly once and is transient, with cleanup`, async () => {
        const h = r2(script);
        const record = await run(h);
        const calls = mutations(h).map(label);
        const target =
          key === 'POST' ? 'POST bucket' : key === 'PUT' ? 'PUT object' : 'DELETE bucket';
        if (key !== 'DELETE bucket') expect(calls.filter((c) => c === target)).toHaveLength(1);
        else expect(calls.slice(0, 3)).toEqual(['POST bucket', 'PUT object', 'DELETE bucket']);
        expect(calls.at(-1)).toBe('DELETE bucket');
        expect(find(record, 'r2-nonempty-delete')?.status).toBe('transient');
        expect(record.blocked).toBe(true);
        expect(record.cleanupFailed).toBe(false);
      });
    }
    it('a 500 on put is reported as provider_unavailable', async () => {
      const record = await run(r2({ put: () => fail(500) }));
      expect(find(record, 'r2-nonempty-delete')).toMatchObject({
        status: 'transient',
        reason: 'provider_unavailable',
      });
    });
    for (const status of [409, 403, 400]) {
      it(`create ${status} is definitive: no DELETE calls and no cleanupFailed`, async () => {
        const h = r2({ create: () => fail(status) });
        const record = await run(h);
        expect(find(record, 'r2-nonempty-delete')).toMatchObject({
          status: 'transient',
          reason: 'bucket_create_failed',
        });
        expect(h.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
        expect(record.cleanupFailed).toBe(false);
        expect(record.blocked).toBe(true);
      });
    }
    it('cleanup bucket DELETE retries 409 within bounded attempts', async () => {
      let n = 0;
      const h = r2({ cleanupDelete: () => (n++ === 1 || n === 3 ? fail(409) : ok({})) });
      const record = await run(h);
      expect(find(record, 'r2-nonempty-delete')?.status).toBe('pass');
      expect(record.cleanupFailed).toBe(false);
    });
    it('a persistent 409 on cleanup bucket DELETE ends as cleanup_failed after 4 tries', async () => {
      const h = r2({ cleanupDelete: () => fail(409) });
      const record = await run(h);
      expect(find(record, 'r2-nonempty-delete')?.reason).toBe('cleanup_failed');
      expect(
        h.calls.filter((c) => c.method === 'DELETE' && !c.url.includes('/objects/')),
      ).toHaveLength(5);
    });
    it('a definitive 403 on cleanup bucket DELETE is cleanup_failed', async () => {
      const record = await run(r2({ cleanupDelete: () => fail(403) }));
      expect(find(record, 'r2-nonempty-delete')).toMatchObject({
        status: 'transient',
        reason: 'cleanup_failed',
      });
      expect(record.cleanupFailed).toBe(true);
      expect(record.blocked).toBe(true);
    });
    it('a 400 on put reports object_put_failed and still cleans up', async () => {
      const h = r2({ put: () => fail(400) });
      const record = await run(h);
      expect(find(record, 'r2-nonempty-delete')?.reason).toBe('object_put_failed');
      expect(mutations(h).map(label).at(-1)).toBe('DELETE bucket');
    });
    it('cleanup retries with bounded backoff and then blocks as cleanup_failed', async () => {
      const h = r2({ cleanupDelete: () => json({}, 500) });
      const record = await run(h);
      expect(find(record, 'r2-nonempty-delete')).toMatchObject({
        status: 'transient',
        reason: 'cleanup_failed',
      });
      expect(record.cleanupFailed).toBe(true);
      expect(record.blocked).toBe(true);
      expect(
        mutations(h).filter((c) => c.method === 'DELETE' && c.url.includes('/objects/')),
      ).toHaveLength(4);
      expect(h.sleeps.length).toBeGreaterThan(0);
    });
    it('cleanup succeeds after a transient failure', async () => {
      let n = 0;
      const record = await run(r2({ cleanupDelete: () => (n++ === 0 ? json({}, 503) : ok({})) }));
      expect(find(record, 'r2-nonempty-delete')?.status).toBe('pass');
      expect(record.cleanupFailed).toBe(false);
    });
    it('a transport that throws still attempts cleanup', async () => {
      let armed = false;
      const h = harness(
        (u, i) => {
          if (i.method === 'PUT') {
            armed = true;
            throw new TypeError('down');
          }
          if (armed && i.method === 'DELETE') throw new TypeError('down');
          return healthy(u, i);
        },
        { allowCreateTemporaryR2: true, randomId: () => 'abc123' },
      );
      const record = await run(h);
      expect(find(record, 'r2-nonempty-delete')?.reason).toBe('cleanup_failed');
      expect(record.cleanupFailed).toBe(true);
      expect(h.calls.filter((c) => c.method === 'DELETE').length).toBeGreaterThanOrEqual(8);
    });
    it('rejects an invalid generated bucket name before any call', async () => {
      const h = harness(healthy, { allowCreateTemporaryR2: true, randomId: () => 'BAD_NAME' });
      const record = await run(h);
      expect(find(record, 'r2-nonempty-delete')?.reason).toBe('invalid_bucket_name');
      expect(h.calls.some((c) => c.url.includes('BAD_NAME'))).toBe(false);
    });
    it('makes zero non-GET calls other than GraphQL without opt-in', async () => {
      const h = harness(healthy, reused);
      await run(h);
      expect(h.calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/graphql'))).toEqual([]);
    });
  });

  it('never emits the token or account id, in output or on failures', async () => {
    const h = harness(
      override(
        (u) => u.endsWith('/graphql'),
        () => json({ error: TOKEN }, 500),
      ),
      reused,
    );
    const text = JSON.stringify(await run(h));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ACCOUNT);
  });

  it('rejects malformed credentials without calling fetch', async () => {
    const h = harness(healthy, { apiToken: 'bad token' });
    await expect(run(h)).rejects.toThrow('invalid_credentials');
    expect(h.calls).toHaveLength(0);
  });
});
