import { describe, expect, it } from 'vitest';
import { bindCredential, parseCredentialMaterial, type CredentialKind } from './credentials.js';
import {
  createPolicyFetch,
  GITHUB_API_VERSION,
  UpstreamError,
  type UpstreamRequest,
} from './policy-fetch.js';
import { createOutboundPolicy, type OutboundPolicy } from './url-policy.js';

const SECRET = 'contract-secret-0001';
const BOUND = 'https://a.example.com';
const SELF = 'https://broker.example.com';

const nodePolicy = createOutboundPolicy({
  allowPrivateHosts: [],
  runtime: 'node',
  selfOrigins: [SELF],
});

const workersPolicy = createOutboundPolicy({
  allowPrivateHosts: ['127.0.0.1:8080', 'localhost'],
  runtime: 'cloudflare',
  selfOrigins: [SELF],
});

interface Hop {
  readonly url: URL;
  readonly headers: Headers;
}

type Route = (url: URL, signal: AbortSignal) => Response | Promise<Response>;

function upstream(routes: Record<string, Route>, policy: OutboundPolicy = nodePolicy) {
  const hops: Hop[] = [];
  const fetch = createPolicyFetch({
    policy,
    userAgent: 'pb-contract',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      hops.push({ url, headers: new Headers(init?.headers) });
      const route = routes[`${url.origin}${url.pathname}`];
      if (route === undefined) throw new Error('unexpected request');
      return route(url, init?.signal as AbortSignal);
    },
  });
  return { hops, fetch };
}

const to =
  (location: string, status = 302): Route =>
  () =>
    new Response(null, { status, headers: { location } });
const ok: Route = () => new Response('{}', { status: 200 });

const get = (url: string, extra: Partial<UpstreamRequest> = {}): UpstreamRequest => ({
  url,
  method: 'GET',
  purpose: 'metadata',
  maxBytes: 1024,
  timeoutMs: 1000,
  ...extra,
});

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UpstreamError);
  const upstreamError = error as UpstreamError;
  expect(upstreamError.code).toBe('refused');
  return upstreamError.reason;
}

const materials: Record<Exclude<CredentialKind, 'github_app' | 'ssh_key'>, object> = {
  http_basic: { username: 'ci', password: SECRET },
  bearer: { token: SECRET },
  header: { name: 'X-Api-Key', value: SECRET },
  query: { param: 'access_token', value: SECRET },
  npm_token: { token: SECRET },
};

const credentialFor = (kind: keyof typeof materials) =>
  bindCredential(parseCredentialMaterial(kind, JSON.stringify(materials[kind])), [BOUND]);

const basicSecret = btoa(`ci:${SECRET}`);

function leaks(hop: Hop): boolean {
  const text = `${hop.url.href} ${JSON.stringify([...hop.headers])}`;
  return text.includes(SECRET) || text.includes(basicSecret);
}

describe('refused address spellings', () => {
  it.each([
    ['https://127.0.0.1/', 'blocked_address'],
    ['https://0x7f.1/', 'blocked_address'],
    ['https://2130706433/', 'blocked_address'],
    ['https://017700000001/', 'blocked_address'],
    ['https://127.1/', 'blocked_address'],
    ['https://0.0.0.0/', 'blocked_address'],
    ['https://10.0.0.1/', 'blocked_address'],
    ['https://172.16.0.1/', 'blocked_address'],
    ['https://192.168.1.1/', 'blocked_address'],
    ['https://100.64.0.1/', 'blocked_address'],
    ['https://169.254.169.254/', 'blocked_address'],
    ['https://[::1]/', 'blocked_address'],
    ['https://[::]/', 'blocked_address'],
    ['https://[::ffff:127.0.0.1]/', 'blocked_address'],
    ['https://[::ffff:7f00:1]/', 'blocked_address'],
    ['https://[64:ff9b::a00:1]/', 'blocked_address'],
    ['https://[2002:a9fe:a9fe::]/', 'blocked_address'],
    ['https://[fd00::1]/', 'blocked_address'],
    ['https://[fe80::1]/', 'blocked_address'],
    ['https://[fe80::1%25en0]/', 'invalid_url'],
    ['https://127.255.255.254/', 'blocked_address'],
    ['https://10.255.255.255/', 'blocked_address'],
    ['https://172.31.255.255/', 'blocked_address'],
    ['https://100.127.255.254/', 'blocked_address'],
    ['https://0.1.2.3/', 'blocked_address'],
    ['https://224.0.0.1/', 'blocked_address'],
    ['https://239.255.255.250/', 'blocked_address'],
    ['https://240.0.0.1/', 'blocked_address'],
    ['https://255.255.255.255/', 'blocked_address'],
    ['https://192.0.0.1/', 'blocked_address'],
    ['https://192.0.2.1/', 'blocked_address'],
    ['https://198.51.100.1/', 'blocked_address'],
    ['https://203.0.113.1/', 'blocked_address'],
    ['https://198.18.0.1/', 'blocked_address'],
    ['https://198.19.255.254/', 'blocked_address'],
    ['https://192.88.99.1/', 'blocked_address'],
    ['https://[0:0:0:0:0:0:0:1]/', 'blocked_address'],
    ['https://[::127.0.0.1]/', 'blocked_address'],
    ['https://[::ffff:10.0.0.1]/', 'blocked_address'],
    ['https://[::ffff:a9fe:a9fe]/', 'blocked_address'],
    ['https://[0:0:0:0:0:ffff:192.168.0.1]/', 'blocked_address'],
    ['https://[::ffff:0:7f00:1]/', 'blocked_address'],
    ['https://[64:ff9b::7f00:1]/', 'blocked_address'],
    ['https://[64:ff9b:1::1]/', 'blocked_address'],
    ['https://[2002:7f00:1::]/', 'blocked_address'],
    ['https://[fc00::1]/', 'blocked_address'],
    ['https://[fdff:ffff::1]/', 'blocked_address'],
    ['https://[febf::1]/', 'blocked_address'],
    ['https://[fec0::1]/', 'blocked_address'],
    ['https://[ff02::1]/', 'blocked_address'],
    ['https://[ff05::fb]/', 'blocked_address'],
    ['https://[2001::1]/', 'blocked_address'],
    ['https://[2001:db8::1]/', 'blocked_address'],
    ['https://[3fff::1]/', 'blocked_address'],
    ['https://[2001:2::1]/', 'blocked_address'],
    ['https://[100::1]/', 'blocked_address'],
    ['https://router.home.arpa/', 'blocked_host'],
    ['https://svc.internal/', 'blocked_host'],
    ['https://LOCALHOST./', 'blocked_host'],
    ['https://localhost/', 'blocked_host'],
    ['https://api.localhost/', 'blocked_host'],
    ['https://metadata.google.internal/', 'blocked_host'],
    ['https://printer.local./', 'blocked_host'],
    ['https://intranet/', 'blocked_host'],
    ['http://a.example.com/', 'scheme'],
    ['ftp://a.example.com/', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['https://user:pass@a.example.com/', 'userinfo'],
    ['https://a.example.com:8443/', 'port'],
  ])('%s is refused (%s) before any socket', async (url, reason) => {
    const { hops, fetch } = upstream({});
    expect(await refusal(fetch(get(url)))).toBe(reason);
    expect(hops).toHaveLength(0);
  });
});

describe('redirect chains', () => {
  it.each([
    ['https://10.0.0.1/', 'blocked_address'],
    ['https://[::ffff:169.254.169.254]/', 'blocked_address'],
    ['https://localhost/', 'blocked_host'],
    ['http://a.example.com/next', 'scheme'],
    [`${SELF}/api/admin`, 'self_origin'],
  ])('refuses a hop to %s', async (location, reason) => {
    const { hops, fetch } = upstream({ [`${BOUND}/p`]: to(location) });
    expect(await refusal(fetch(get(`${BOUND}/p`)))).toBe(reason);
    expect(hops).toHaveLength(1);
  });

  it('follows five redirects and refuses the sixth', async () => {
    const chain = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`${BOUND}/r${i}`, to(`/r${i + 1}`)] as const),
      );
    const five = upstream({ ...chain(5), [`${BOUND}/r5`]: ok });
    expect((await five.fetch(get(`${BOUND}/r0`))).status).toBe(200);
    const six = upstream({ ...chain(6), [`${BOUND}/r6`]: ok });
    expect(await refusal(six.fetch(get(`${BOUND}/r0`)))).toBe('redirect_limit');
    expect(six.hops).toHaveLength(6);
  });

  it('refuses an https to http downgrade even toward a host with an explicit port entry', async () => {
    const allowing = createOutboundPolicy({
      allowPrivateHosts: ['plain.example.com:80'],
      runtime: 'node',
      selfOrigins: [],
    });
    const direct = upstream({ 'http://plain.example.com/x': ok }, allowing);
    expect(await refusal(direct.fetch(get('http://plain.example.com/x')))).toBe('scheme');
    expect(direct.hops).toHaveLength(0);
    const { hops, fetch } = upstream(
      { [`${BOUND}/p`]: to('http://plain.example.com/x'), 'http://plain.example.com/x': ok },
      allowing,
    );
    expect(await refusal(fetch(get(`${BOUND}/p`)))).toBe('scheme');
    expect(hops).toHaveLength(1);
  });

  it('checks destinations on every hop', async () => {
    const { hops, fetch } = upstream({ [`${BOUND}/p`]: to('https://b.example.com/x') });
    expect(await refusal(fetch(get(`${BOUND}/p`, { destinations: [BOUND] })))).toBe('destination');
    expect(hops).toHaveLength(1);
  });

  it.each(Object.keys(materials) as (keyof typeof materials)[])(
    'drops the %s credential on a cross-origin hop and never re-attaches it',
    async (kind) => {
      const callerHeaders = { accept: 'application/json', 'if-none-match': '"v1"' };
      const { hops, fetch } = upstream({
        [`${BOUND}/p`]: to('https://b.example.com/x?keep=1'),
        'https://b.example.com/x': to(`${BOUND}/back`),
        [`${BOUND}/back`]: ok,
      });
      await fetch(get(`${BOUND}/p`, { credential: credentialFor(kind), headers: callerHeaders }));
      expect(hops[0]?.headers.get('accept')).toBe('application/json');
      expect(hops[0]?.headers.get('if-none-match')).toBe('"v1"');
      for (const hop of hops.slice(1)) {
        expect(hop.headers.has('accept')).toBe(false);
        expect(hop.headers.has('if-none-match')).toBe(false);
      }
      expect(hops.map((h) => h.url.origin)).toEqual([BOUND, 'https://b.example.com', BOUND]);
      expect(leaks(hops[0] as Hop)).toBe(true);
      expect(leaks(hops[1] as Hop)).toBe(false);
      expect(leaks(hops[2] as Hop)).toBe(false);
      expect(hops[1]?.url.searchParams.get('keep')).toBe('1');
    },
  );
});

describe('query credentials in Location', () => {
  it('strips the credential parameter echoed into a cross-origin Location', async () => {
    const { hops, fetch } = upstream({
      [`${BOUND}/p`]: (url) =>
        new Response(null, {
          status: 302,
          headers: { location: `https://b.example.com/x?${url.searchParams}&keep=1` },
        }),
      'https://b.example.com/x': ok,
    });
    await fetch(get(`${BOUND}/p`, { credential: credentialFor('query') }));
    expect(hops[0]?.url.searchParams.get('access_token')).toBe(SECRET);
    expect(hops[1]?.url.searchParams.has('access_token')).toBe(false);
    expect(hops[1]?.url.searchParams.get('keep')).toBe('1');
  });
});

describe('per-purpose header allowlists', () => {
  const conditional = {
    accept: 'application/json',
    'if-none-match': '"v1"',
    'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT',
  };
  const gitOnly = {
    'git-protocol': 'version=2',
    'content-type': 'application/x-git-upload-pack-request',
  };
  const apiOnly = {
    'x-github-api-version': GITHUB_API_VERSION,
    'content-type': 'application/json',
  };

  it.each([
    ['metadata', { ...conditional }, conditional],
    ['archive', { ...conditional }, conditional],
    [
      'git',
      { ...conditional, ...gitOnly },
      { ...conditional, ...gitOnly, 'x-github-api-version': GITHUB_API_VERSION },
    ],
    [
      'api',
      { ...conditional, ...apiOnly },
      { ...conditional, ...apiOnly, 'git-protocol': 'version=2' },
    ],
  ] as const)(
    '%s keeps its allowed headers and drops the rest',
    async (purpose, expected, sent) => {
      const { hops, fetch } = upstream({ [`${BOUND}/p`]: ok });
      await fetch(
        get(`${BOUND}/p`, { purpose, headers: { ...sent, cookie: 'a=b', 'x-forwarded-for': '1' } }),
      );
      const headers = Object.fromEntries((hops[0] as Hop).headers);
      expect(headers).toEqual({ ...expected, 'user-agent': 'pb-contract' });
    },
  );

  it.each([
    ['metadata', gitOnly],
    ['archive', apiOnly],
  ] as const)('%s drops headers that belong to other purposes', async (purpose, sent) => {
    const { hops, fetch } = upstream({ [`${BOUND}/p`]: ok });
    await fetch(get(`${BOUND}/p`, { purpose, headers: sent }));
    expect([...(hops[0] as Hop).headers.keys()]).toEqual(['user-agent']);
  });

  it.each([
    ['git', { 'content-type': 'application/json' }],
    ['api', { 'content-type': 'application/x-git-upload-pack-request' }],
    ['api', { 'x-github-api-version': '2020-01-01' }],
    ['metadata', { accept: 'text/plain\r\nx-injected: 1' }],
  ] as const)('%s refuses %j', async (purpose, sent) => {
    const { hops, fetch } = upstream({ [`${BOUND}/p`]: ok });
    expect(await refusal(fetch(get(`${BOUND}/p`, { purpose, headers: sent })))).toBe('header');
    expect(hops).toHaveLength(0);
  });

  it('drops headers outside the purpose allowlist', async () => {
    const { hops, fetch } = upstream({ [`${BOUND}/p`]: ok });
    await fetch(
      get(`${BOUND}/p`, {
        headers: { authorization: `Bearer ${SECRET}`, cookie: 'a=b', 'git-protocol': 'version=2' },
      }),
    );
    expect([...(hops[0] as Hop).headers.keys()].sort()).toEqual(['user-agent']);
  });

  it('refuses an allowed header with a value outside its check', async () => {
    const { hops, fetch } = upstream({ [`${BOUND}/p`]: ok });
    const request = get(`${BOUND}/p`, { purpose: 'git', headers: { 'git-protocol': 'version=1' } });
    expect(await refusal(fetch(request))).toBe('header');
    expect(hops).toHaveLength(0);
  });
});

describe('caps', () => {
  it('fails mid-stream once the body passes maxBytes', async () => {
    const { fetch } = upstream({
      [`${BOUND}/big`]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(400));
            },
          }),
        ),
    });
    const response = await fetch(get(`${BOUND}/big`));
    const read = new Response(response.body).arrayBuffer();
    await expect(read).rejects.toMatchObject({ code: 'too_large' });
  });

  it('times out a hop that never answers', async () => {
    const { fetch } = upstream({
      [`${BOUND}/slow`]: (_url, signal) =>
        new Promise<Response>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
    });
    await expect(fetch(get(`${BOUND}/slow`, { timeoutMs: 50 }))).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});

describe('self-origin denial on Workers (URL classification only, no DNS pinning)', () => {
  it.each([
    `${SELF}/`,
    'https://BROKER.example.com/',
    'https://broker.example.com./',
    'https://broker.example.com:443/x',
  ])('refuses %s without calling fetch', async (url) => {
    const { hops, fetch } = upstream({}, workersPolicy);
    expect(await refusal(fetch(get(url)))).toBe('self_origin');
    expect(hops).toHaveLength(0);
  });

  it('refuses a redirect into the self origin', async () => {
    const { hops, fetch } = upstream({ [`${BOUND}/p`]: to(`${SELF}/admin`, 307) }, workersPolicy);
    expect(await refusal(fetch(get(`${BOUND}/p`)))).toBe('self_origin');
    expect(hops).toHaveLength(1);
  });

  it('ignores the private-host allowlist', async () => {
    const { hops, fetch } = upstream({}, workersPolicy);
    expect(await refusal(fetch(get('http://127.0.0.1:8080/')))).toBe('scheme');
    expect(await refusal(fetch(get('https://localhost/')))).toBe('blocked_host');
    expect(hops).toHaveLength(0);
  });

  it('hands a public name to fetch unresolved', async () => {
    const { hops, fetch } = upstream({ 'https://rebind.example.net/p': ok }, workersPolicy);
    expect((await fetch(get('https://rebind.example.net/p'))).status).toBe(200);
    expect(hops[0]?.url.hostname).toBe('rebind.example.net');
  });
});
