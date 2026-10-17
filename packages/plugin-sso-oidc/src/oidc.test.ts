import { base64urlEncode } from '@package-broker/core/auth/primitives';
import type { DomainPolicy, IdentityContext } from '@package-broker/core/identity/port';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOidcProvider,
  OidcProviderError,
  oidcProblems,
  type OidcConfig,
  type OidcFailureDetail,
} from './oidc.js';

const ISSUER = 'https://dex.example.com/dex';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CALLBACK = 'https://broker.example.com/auth/oidc/dex/callback';
const SECRET_NAME = 'PB_IDP_DEX_CLIENT_SECRET';
const SECRET_VALUE = 'test-secret-value-9f3c';
const POLICY: DomainPolicy = { verifiedDomains: ['example.com'], autoJoin: false };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const START = Date.parse('2026-10-15T08:00:00Z');

afterEach(() => {
  vi.useRealTimers();
});

type Handler = (request: Request) => Promise<Response> | Response;

interface Harness {
  readonly ctx: IdentityContext;
  readonly requests: Request[];
  readonly envReads: string[];
  secret: string | undefined;
  now: number;
  handler: Handler;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/auth`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/keys`,
    code_challenge_methods_supported: ['S256', 'plain'],
    ...overrides,
  };
}

function harness(handler?: Handler): Harness {
  const state: Harness = {
    requests: [],
    envReads: [],
    secret: SECRET_VALUE,
    now: START,
    handler: handler ?? (() => jsonResponse(doc())),
    ctx: undefined as unknown as IdentityContext,
  };
  (state as { ctx: IdentityContext }).ctx = {
    fetch: async (request) => {
      state.requests.push(request);
      return state.handler(request);
    },
    clock: { now: () => new Date(state.now) },
    env: (name) => {
      state.envReads.push(name);
      return name === SECRET_NAME ? state.secret : undefined;
    },
  };
  return state;
}

function config(overrides: Partial<OidcConfig> = {}): OidcConfig {
  return {
    id: 'dex',
    kind: 'oidc',
    issuer: ISSUER,
    clientId: 'package-broker',
    policy: POLICY,
    ...overrides,
  };
}

function provider(h: Harness, overrides: Partial<OidcConfig> = {}) {
  return createOidcProvider(config(overrides), h.ctx);
}

function start(p: ReturnType<typeof createOidcProvider>, purpose: 'login' | 'reauth' = 'login') {
  return p.start({ request: new Request(CALLBACK), purpose, callbackUrl: CALLBACK });
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OidcProviderError) {
      expect(error.reason).toBe('provider_error');
      return error.detail;
    }
    throw error;
  }
  return 'resolved';
}

async function errorOf(promise: Promise<unknown>): Promise<OidcProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OidcProviderError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected rejection');
}

async function redirectOf(promise: ReturnType<typeof start>) {
  const result = await promise;
  if (result.kind !== 'redirect') {
    throw new Error('expected redirect');
  }
  return { url: new URL(result.location), state: result.state };
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  return base64urlEncode(digest);
}

describe('provider fields', () => {
  it('exposes the identity port fields', () => {
    const p = provider(harness(), { displayName: 'Company SSO' });
    expect(p.id).toBe('dex');
    expect(p.kind).toBe('oidc');
    expect(p.displayName).toBe('Company SSO');
    expect(p.trustAnchor).toBe(`oidc:${ISSUER}`);
    expect(p.supportsReauth).toBe(true);
    expect(p.policy).toEqual(POLICY);
  });

  it('defaults the display name to the id', () => {
    expect(provider(harness()).displayName).toBe('dex');
  });

  it('is not affected by later changes of the config object', () => {
    const source = { ...config(), policy: { verifiedDomains: ['example.com'], autoJoin: false } };
    const p = createOidcProvider(source, harness().ctx);
    (source.policy.verifiedDomains as string[]).push('evil.example');
    expect(p.policy.verifiedDomains).toEqual(['example.com']);
  });

  it('throws RangeError for an invalid config without echoing values', () => {
    const bad = config({ clientId: 'leaky-client-id-value\n' });
    expect(() => createOidcProvider(bad, harness().ctx)).toThrow(RangeError);
    try {
      createOidcProvider(bad, harness().ctx);
    } catch (error) {
      expect((error as Error).message).not.toContain('leaky-client-id-value');
    }
  });
});

describe('start', () => {
  it('builds the authorization request with every parameter', async () => {
    const h = harness();
    const { url, state } = await redirectOf(start(provider(h)));
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/auth`);
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('package-broker');
    expect(q.get('redirect_uri')).toBe(CALLBACK);
    expect(q.get('scope')).toBe('openid email profile groups');
    expect(q.get('state')).toBe(state.state);
    expect(q.get('nonce')).toBe(state.nonce);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBe(await challengeFor(state.verifier as string));
    expect(q.has('prompt')).toBe(false);
    expect(q.has('max_age')).toBe(false);
    expect(q.has('client_secret')).toBe(false);
    expect([...q.keys()].sort()).toEqual(
      [
        'client_id',
        'code_challenge',
        'code_challenge_method',
        'nonce',
        'redirect_uri',
        'response_type',
        'scope',
        'state',
      ].sort(),
    );
  });

  it('returns state, nonce and verifier as distinct random tokens', async () => {
    const h = harness();
    const p = provider(h);
    const first = (await redirectOf(start(p))).state;
    const second = (await redirectOf(start(p))).state;
    expect(Object.keys(first).sort()).toEqual(['nonce', 'state', 'verifier']);
    for (const value of [...Object.values(first), ...Object.values(second)]) {
      expect(value).toMatch(TOKEN);
    }
    expect(new Set([...Object.values(first), ...Object.values(second)]).size).toBe(6);
  });

  it('adds openid to custom scopes that lack it', async () => {
    const h = harness();
    const { url } = await redirectOf(start(provider(h, { scopes: ['email', 'groups'] })));
    expect(url.searchParams.get('scope')).toBe('openid email groups');
  });

  it('keeps custom scopes that already contain openid without duplicating it', async () => {
    const h = harness();
    const { url } = await redirectOf(
      start(provider(h, { scopes: ['email', 'openid', 'email', 'profile'] })),
    );
    expect(url.searchParams.get('scope')).toBe('email openid profile');
  });

  it('adds prompt=login and max_age=0 for reauth', async () => {
    const h = harness();
    const { url } = await redirectOf(start(provider(h), 'reauth'));
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('overrides same-named parameters already present on the authorization endpoint', async () => {
    const h = harness(() =>
      jsonResponse(
        doc({ authorization_endpoint: `${ISSUER}/auth?connector_id=ldap&client_id=attacker` }),
      ),
    );
    const { url } = await redirectOf(start(provider(h)));
    expect(url.searchParams.get('connector_id')).toBe('ldap');
    expect(url.searchParams.getAll('client_id')).toEqual(['package-broker']);
  });

  it('reads the client secret from the scoped environment name only', async () => {
    const h = harness();
    await start(provider(h));
    expect(h.envReads).toEqual([SECRET_NAME]);
  });

  it('never sends credentials with the discovery request', async () => {
    const h = harness();
    await start(provider(h));
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0] as Request;
    expect(request.method).toBe('GET');
    expect(request.url).toBe(DISCOVERY_URL);
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('cookie')).toBe(false);
    expect(request.redirect).toBe('manual');
  });

  it('works for a loopback http issuer such as a local Dex', async () => {
    const issuer = 'http://127.0.0.1:5556/dex';
    const h = harness(() =>
      jsonResponse(
        doc({
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/keys`,
        }),
      ),
    );
    const { url } = await redirectOf(start(provider(h, { issuer })));
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/auth`);
  });

  it('removes reserved parameters from the discovered authorization endpoint', async () => {
    const injected = [
      'prompt=none',
      'max_age=999',
      'response_mode=fragment',
      'request=x',
      'request_uri=https%3A%2F%2Fevil.example%2Fr',
      'id_token_hint=x',
      'login_hint=x',
      'acr_values=x',
      'display=popup',
      'scope=admin',
      'state=fixed',
      'nonce=fixed',
      'code_challenge=fixed',
      'code_challenge_method=plain',
      'redirect_uri=https%3A%2F%2Fevil.example%2Fcb',
      'response_type=token',
      'client_secret=x',
      'connector_id=ldap',
    ].join('&');
    const h = harness(() =>
      jsonResponse(doc({ authorization_endpoint: `${ISSUER}/auth?${injected}` })),
    );
    const p = provider(h);
    const login = (await redirectOf(start(p))).url.searchParams;
    expect([...login.keys()].sort()).toEqual(
      [
        'client_id',
        'code_challenge',
        'code_challenge_method',
        'connector_id',
        'nonce',
        'redirect_uri',
        'response_type',
        'scope',
        'state',
      ].sort(),
    );
    expect(login.get('connector_id')).toBe('ldap');
    expect(login.get('code_challenge_method')).toBe('S256');
    expect(login.get('scope')).toBe('openid email profile groups');
    expect(login.get('response_type')).toBe('code');
    const reauth = (await redirectOf(start(p, 'reauth'))).url.searchParams;
    expect(reauth.getAll('prompt')).toEqual(['login']);
    expect(reauth.getAll('max_age')).toEqual(['0']);
  });

  it('rejects an invalid callback URL', async () => {
    const h = harness();
    const p = provider(h);
    for (const callbackUrl of [
      '',
      'not a url',
      '/relative',
      'javascript:alert(1)',
      `${CALLBACK}#x`,
      'https://user:pass@broker.example.com/cb',
      'https://user@broker.example.com/cb',
      'https://:pass@broker.example.com/cb',
      'http://broker.example.com/cb',
    ]) {
      expect(
        await failureOf(p.start({ request: new Request(CALLBACK), purpose: 'login', callbackUrl })),
      ).toBe('callback_invalid');
    }
  });
});

describe('discovery caching', () => {
  it('fetches the document once per provider instance', async () => {
    const h = harness();
    const p = provider(h);
    await start(p);
    await start(p, 'reauth');
    expect(h.requests).toHaveLength(1);
  });

  it('shares one in-flight fetch between concurrent starts', async () => {
    const h = harness();
    const p = provider(h);
    await Promise.all([start(p), start(p), start(p)]);
    expect(h.requests).toHaveLength(1);
  });

  it('remembers a failed discovery for 30 seconds without contacting the issuer', async () => {
    const h = harness(() => new Response('nope', { status: 500 }));
    const p = provider(h);
    expect(await failureOf(start(p))).toBe('discovery_status');
    expect(h.requests).toHaveLength(1);
    h.handler = () => jsonResponse(doc());
    h.now += 29_999;
    expect(await failureOf(start(p))).toBe('discovery_status');
    expect(await failureOf(start(p, 'reauth'))).toBe('discovery_status');
    expect(h.requests).toHaveLength(1);
  });

  it('retries discovery once 30 seconds have passed and caches the success', async () => {
    const h = harness(() => new Response('nope', { status: 500 }));
    const p = provider(h);
    expect(await failureOf(start(p))).toBe('discovery_status');
    h.handler = () => jsonResponse(doc());
    h.now += 30_000;
    await redirectOf(start(p));
    expect(h.requests).toHaveLength(2);
    h.handler = () => new Response('nope', { status: 500 });
    h.now += 3_600_000;
    await redirectOf(start(p));
    expect(h.requests).toHaveLength(2);
  });

  it('restarts the 30 second window after each failed retry', async () => {
    const h = harness(() => new Response('nope', { status: 500 }));
    const p = provider(h);
    await failureOf(start(p));
    h.now += 30_000;
    await failureOf(start(p));
    expect(h.requests).toHaveLength(2);
    h.now += 29_999;
    await failureOf(start(p));
    expect(h.requests).toHaveLength(2);
    h.now += 1;
    await failureOf(start(p));
    expect(h.requests).toHaveLength(3);
  });

  it('shares one failure between concurrent starts', async () => {
    const h = harness(() => new Response('nope', { status: 500 }));
    const p = provider(h);
    const results = await Promise.all([failureOf(start(p)), failureOf(start(p))]);
    expect(results).toEqual(['discovery_status', 'discovery_status']);
    expect(h.requests).toHaveLength(1);
  });

  it('does not share the cache between instances', async () => {
    const h = harness();
    await start(provider(h));
    await start(provider(h));
    expect(h.requests).toHaveLength(2);
  });
});

describe('discovery refusals', () => {
  async function refuses(
    handler: Handler,
    detail: OidcFailureDetail,
    overrides: Partial<OidcConfig> = {},
  ): Promise<void> {
    const h = harness(handler);
    const error = await errorOf(start(provider(h, overrides)));
    expect(error.reason).toBe('provider_error');
    expect(error.detail).toBe(detail);
    expect(h.requests).toHaveLength(1);
  }

  const invalid = (overrides: Record<string, unknown>) => () => jsonResponse(doc(overrides));

  it('refuses an issuer mismatch', async () => {
    await refuses(invalid({ issuer: 'https://dex.example.com/other' }), 'discovery_invalid');
  });

  it.each([`${ISSUER}/`, 'HTTPS://dex.example.com/dex', 'https://dex.example.com:443/dex'])(
    'compares the issuer exactly (%s)',
    async (issuer) => {
      await refuses(invalid({ issuer }), 'discovery_invalid');
    },
  );

  it.each([undefined, 7, null])('refuses a %j issuer', async (issuer) => {
    await refuses(invalid({ issuer }), 'discovery_invalid');
  });

  it.each(['authorization_endpoint', 'token_endpoint', 'jwks_uri'])(
    'refuses %s on another origin',
    async (field) => {
      await refuses(invalid({ [field]: 'https://evil.example.net/x' }), 'discovery_invalid');
    },
  );

  it.each([
    ['sibling subdomain', 'https://idp.dex.example.com/token'],
    ['another port', 'https://dex.example.com:8443/token'],
  ])('refuses a token_endpoint on %s', async (_name, token_endpoint) => {
    await refuses(invalid({ token_endpoint }), 'discovery_invalid');
  });

  it('accepts a token_endpoint on another origin when it is trusted', async () => {
    const h = harness(invalid({ token_endpoint: 'https://token.example.net/t' }));
    await redirectOf(start(provider(h, { trustedEndpointOrigins: ['https://token.example.net'] })));
  });

  it('does not let a trusted origin vouch for a different origin', async () => {
    await refuses(invalid({ jwks_uri: 'https://other.example.net/keys' }), 'discovery_invalid', {
      trustedEndpointOrigins: ['https://token.example.net'],
    });
  });

  it('refuses an http endpoint for an https issuer, trusted origin or not', async () => {
    await refuses(
      invalid({ token_endpoint: 'http://dex.example.com/dex/token' }),
      'discovery_invalid',
    );
    await refuses(invalid({ token_endpoint: 'http://127.0.0.1:5556/token' }), 'discovery_invalid', {
      trustedEndpointOrigins: ['http://127.0.0.1:5556'],
    });
    await refuses(
      invalid({ token_endpoint: 'http://token.example.net/token' }),
      'discovery_invalid',
      { trustedEndpointOrigins: ['https://token.example.net'] },
    );
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['number', 5],
    ['empty', ''],
    ['relative', '/dex/token'],
    ['not a url', 'not a url'],
    ['credentials', 'https://user:pass@dex.example.com/dex/token'],
    ['fragment', 'https://dex.example.com/dex/token#frag'],
  ])('refuses a %s token_endpoint', async (_name, value) => {
    await refuses(invalid({ token_endpoint: value }), 'discovery_invalid');
  });

  it.each([
    ['only plain', ['plain']],
    ['empty', []],
    ['a string', 'S256'],
    ['null', null],
    ['an object', { S256: true }],
  ])('refuses code_challenge_methods_supported that is %s', async (_name, value) => {
    await refuses(invalid({ code_challenge_methods_supported: value }), 'discovery_invalid');
  });

  it('accepts a discovery document without code_challenge_methods_supported', async () => {
    const h = harness(invalid({ code_challenge_methods_supported: undefined }));
    await redirectOf(start(provider(h)));
  });

  it.each([
    ['an array', () => jsonResponse([doc()])],
    ['null', () => jsonResponse('null')],
    ['a string', () => jsonResponse('"text"')],
  ])('refuses a document that is %s', async (_name, handler) => {
    await refuses(handler, 'discovery_invalid');
  });

  it('refuses a redirecting discovery response', async () => {
    await refuses(
      () => new Response(null, { status: 302, headers: { location: `${ISSUER}/elsewhere` } }),
      'discovery_redirect',
    );
  });

  it('refuses a 65 KiB document and accepts one of exactly 64 KiB', async () => {
    const sized = (bytes: number): string => {
      const base = JSON.stringify(doc({ pad: '' }));
      return JSON.stringify(doc({ pad: 'a'.repeat(bytes - base.length) }));
    };
    expect(sized(65 * 1024)).toHaveLength(65 * 1024);
    await refuses(() => jsonResponse(sized(65 * 1024)), 'discovery_too_large');
    await refuses(() => jsonResponse(sized(64 * 1024 + 1)), 'discovery_too_large');
    const h = harness(() => jsonResponse(sized(64 * 1024)));
    await redirectOf(start(provider(h)));
  });

  it.each([
    [
      'non-2xx status',
      () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
      'discovery_status',
    ],
    [
      'wrong content type',
      () => new Response(JSON.stringify(doc()), { headers: { 'content-type': 'text/html' } }),
      'discovery_content_type',
    ],
    ['no content type', () => new Response(JSON.stringify(doc())), 'discovery_content_type'],
    ['invalid json', () => jsonResponse('{not json'), 'discovery_bad_json'],
    [
      'network failure',
      () => Promise.reject(new TypeError('connect ECONNREFUSED')),
      'discovery_network',
    ],
  ] as const)('refuses on %s', async (_name, handler, detail) => {
    await refuses(handler, detail);
  });

  it('refuses after the 5 second deadline when the response never arrives', async () => {
    vi.useFakeTimers();
    const h = harness(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () =>
            reject(new DOMException('x', 'AbortError')),
          );
        }),
    );
    const outcome = errorOf(start(provider(h)));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error.reason).toBe('provider_error');
    expect(error.detail).toBe('discovery_timeout');
  });
});

describe('client secret', () => {
  it.each([undefined, ''])(
    'fails start with provider_error when the secret is %j',
    async (value) => {
      const h = harness();
      h.secret = value;
      const error = await errorOf(start(provider(h)));
      expect(error.reason).toBe('provider_error');
      expect(error.detail).toBe('secret_missing');
      const text = `${error.name} ${error.message} ${String(error.stack)} ${JSON.stringify(error)}`;
      expect(text).not.toContain(SECRET_NAME);
      expect(h.requests).toHaveLength(0);
    },
  );

  it('reads the secret when it is used, not when the provider is created', async () => {
    const h = harness();
    h.secret = undefined;
    const p = provider(h);
    expect(h.envReads).toEqual([]);
    h.secret = SECRET_VALUE;
    await redirectOf(start(p));
  });

  it('never puts the secret name or value in a thrown error', async () => {
    const h = harness(() => jsonResponse(doc({ issuer: 'https://dex.example.com/other' })));
    const error = await errorOf(start(provider(h)));
    const text = `${error.name} ${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain(SECRET_NAME);
    expect(error.name).toBe('OidcProviderError');
  });

  it('does not put the secret in the authorization URL', async () => {
    const h = harness();
    const { url } = await redirectOf(start(provider(h)));
    expect(url.toString()).not.toContain(SECRET_VALUE);
  });
});

describe('finish', () => {
  it('refuses a token response without an id_token', async () => {
    const h = harness();
    const p = provider(h);
    const { state } = await redirectOf(start(p));
    const result = await p.finish({
      request: new Request(`${CALLBACK}?code=abc&state=${state.state}`),
      state,
      callbackUrl: CALLBACK,
    });
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
  });

  it('refuses a missing login state with state_mismatch', async () => {
    const h = harness();
    const result = await provider(h).finish({
      request: new Request(`${CALLBACK}?code=abc&state=x`),
      state: null,
      callbackUrl: CALLBACK,
    });
    expect(result).toEqual({ ok: false, reason: 'state_mismatch' });
  });

  it('does not contact the issuer without a login state', async () => {
    const h = harness();
    await provider(h).finish({
      request: new Request(CALLBACK),
      state: null,
      callbackUrl: CALLBACK,
    });
    expect(h.requests).toHaveLength(0);
  });
});

describe('oidcProblems', () => {
  it('accepts a valid config and the full option set', () => {
    expect(oidcProblems(config())).toEqual([]);
    expect(
      oidcProblems(
        config({
          displayName: 'Company SSO',
          scopes: ['openid', 'email'],
          trustedAudiences: ['other-client'],
          trustedEndpointOrigins: ['https://token.example.net', 'http://localhost:5556'],
        }),
      ),
    ).toEqual([]);
    expect(oidcProblems(config({ issuer: 'http://127.0.0.1:5556/dex' }))).toEqual([]);
    expect(oidcProblems(config({ issuer: 'http://localhost:5556' }))).toEqual([]);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'dex'],
    ['undefined', undefined],
  ])('rejects a %s config', (_name, value) => {
    expect(oidcProblems(value)).not.toEqual([]);
  });

  const bad: readonly [string, Record<string, unknown>][] = [
    ['id uppercase', { id: 'Dex' }],
    ['id reserved', { id: 'local' }],
    ['id not a string', { id: 5 }],
    ['kind wrong', { kind: 'saml' }],
    ['kind access', { kind: 'cloudflare-access' }],
    ['displayName empty', { displayName: '' }],
    ['displayName control', { displayName: 'a\u0000b' }],
    ['displayName long', { displayName: 'x'.repeat(101) }],
    ['displayName number', { displayName: 3 }],
    ['issuer http non-loopback', { issuer: 'http://dex.example.com/dex' }],
    ['issuer query', { issuer: 'https://dex.example.com/dex?x=1' }],
    ['issuer fragment', { issuer: 'https://dex.example.com/dex#x' }],
    ['issuer credentials', { issuer: 'https://u:p@dex.example.com/dex' }],
    ['issuer relative', { issuer: '/dex' }],
    ['issuer empty', { issuer: '' }],
    ['issuer ftp', { issuer: 'ftp://dex.example.com' }],
    ['issuer missing', { issuer: undefined }],
    ['clientId empty', { clientId: '' }],
    ['clientId space', { clientId: 'a b' }],
    ['clientId number', { clientId: 1 }],
    ['clientId long', { clientId: 'c'.repeat(256) }],
    ['policy missing', { policy: undefined }],
    ['policy empty domains', { policy: { verifiedDomains: [], autoJoin: false } }],
    ['scopes string', { scopes: 'openid email' }],
    ['scopes empty', { scopes: [] }],
    ['scopes empty token', { scopes: [''] }],
    ['scopes with space', { scopes: ['a b'] }],
    ['scopes number', { scopes: [1] }],
    ['scopes offline_access', { scopes: ['openid', 'offline_access'] }],
    ['scopes too many', { scopes: Array.from({ length: 33 }, (_v, i) => `s${i}`) }],
    ['trustedAudiences string', { trustedAudiences: 'x' }],
    ['trustedAudiences empty entry', { trustedAudiences: [''] }],
    ['trustedEndpointOrigins string', { trustedEndpointOrigins: 'https://a.example' }],
    ['trusted origin with path', { trustedEndpointOrigins: ['https://a.example/x'] }],
    ['trusted origin trailing slash', { trustedEndpointOrigins: ['https://a.example/'] }],
    ['trusted origin http', { trustedEndpointOrigins: ['http://a.example'] }],
    ['trusted origin not url', { trustedEndpointOrigins: ['nope'] }],
    ['unknown key', { clientSecret: 'x' }],
    ['issuer trailing slash', { issuer: 'https://dex.example.com/dex/' }],
    ['issuer root trailing slash', { issuer: 'https://dex.example.com/' }],
    ['policy unknown key', { policy: { ...POLICY, extra: true } }],
    ['policy domains string', { policy: { verifiedDomains: 'example.com', autoJoin: false } }],
  ];

  it.each(bad)('rejects %s', (_name, override) => {
    const problems = oidcProblems({ ...config(), ...override });
    expect(problems.length).toBeGreaterThan(0);
  });

  it('never echoes values in problems', () => {
    const problems = oidcProblems({
      ...config(),
      clientId: 'ECHO-CLIENT value',
      issuer: 'http://echo-issuer.example.com/path',
      scopes: ['echo scope'],
      trustedEndpointOrigins: ['http://echo-origin.example.com'],
    });
    const text = problems.join('\n');
    expect(problems.length).toBeGreaterThan(0);
    for (const needle of ['ECHO-CLIENT', 'echo-issuer', 'echo scope', 'echo-origin']) {
      expect(text).not.toContain(needle);
    }
  });

  it('reports an own __proto__ key as unsupported', () => {
    const parsed = JSON.parse(
      JSON.stringify({ ...config() }).replace('{', '{"__proto__":{"issuer":"x"},'),
    ) as unknown;
    const problems = oidcProblems(parsed);
    expect(problems.some((problem) => problem.includes('unsupported key'))).toBe(true);
    expect(() => createOidcProvider(parsed as OidcConfig, harness().ctx)).toThrow(RangeError);
  });

  it('reports an own __proto__ key inside the policy as unsupported', () => {
    const policy = JSON.parse(
      '{"__proto__":{"autoJoin":true},"verifiedDomains":["example.com"],"autoJoin":false}',
    ) as DomainPolicy;
    const problems = oidcProblems({ ...config(), policy });
    expect(problems.some((problem) => problem.startsWith('policy: unsupported key'))).toBe(true);
  });

  it('does not let a config prototype supply values', () => {
    const inherited = Object.create({ clientId: 'inherited' }) as Record<string, unknown>;
    Object.assign(inherited, { ...config(), clientId: undefined });
    expect(oidcProblems(inherited).length).toBeGreaterThan(0);
  });

  it('survives a throwing accessor', () => {
    const hostile = {
      ...config(),
      get clientId(): string {
        throw new Error('boom');
      },
    };
    expect(oidcProblems(hostile).length).toBeGreaterThan(0);
  });
});

describe('issuer canonical form', () => {
  it.each([
    ['https default port', 'https://idp.example.com:443'],
    ['https default port with path', 'https://idp.example.com:443/dex'],
    ['http loopback default port', 'http://localhost:80/dex'],
  ])('refuses a %s (%s)', (_name, issuer) => {
    const problems = oidcProblems(config({ issuer }));
    expect(problems).toContain('issuer must not name the default port');
    expect(problems.join('\n')).not.toContain('idp.example.com');
  });

  it('refuses an issuer that does not serialise back to itself', () => {
    const problems = oidcProblems(config({ issuer: 'https://idp.example.com/{tenant}' }));
    expect(problems).toContain('issuer must be in canonical URL form');
    expect(problems.join('\n')).not.toContain('tenant');
  });

  it.each([
    ['trailing-dot host', 'https://idp.example.com./dex'],
    ['escaped unreserved character', 'https://idp.example.com/%7Euser'],
    ['lowercase hex escape', 'https://idp.example.com/a%2fb'],
    ['empty path segment', 'https://idp.example.com//dex'],
  ])('refuses a %s (%s)', (_name, issuer) => {
    const problems = oidcProblems(config({ issuer }));
    expect(problems).toContain('issuer must be in canonical URL form');
  });

  it('accepts an uppercase escape of a reserved character', () => {
    expect(oidcProblems(config({ issuer: 'https://idp.example.com/a%2Fb' }))).toEqual([]);
  });

  it('keeps a non-default port and a canonical path', () => {
    expect(oidcProblems(config({ issuer: 'https://idp.example.com:8443/dex' }))).toEqual([]);
    expect(oidcProblems(config({ issuer: 'http://localhost:5556' }))).toEqual([]);
  });
});

describe('discovery endpoint query and fragment', () => {
  async function detailFor(overrides: Record<string, unknown>): Promise<string> {
    const h = harness(() => jsonResponse(doc(overrides)));
    return failureOf(start(provider(h)));
  }

  it.each([
    ['token_endpoint with ?x=1', { token_endpoint: `${ISSUER}/token?x=1` }],
    ['token_endpoint with an empty query', { token_endpoint: `${ISSUER}/token?` }],
    ['token_endpoint with #f', { token_endpoint: `${ISSUER}/token#f` }],
    ['jwks_uri with ?x=1', { jwks_uri: `${ISSUER}/keys?x=1` }],
    ['jwks_uri with #f', { jwks_uri: `${ISSUER}/keys#f` }],
  ])('refuses %s', async (_name, overrides) => {
    expect(await detailFor(overrides)).toBe('discovery_invalid');
  });

  it('keeps accepting a query on authorization_endpoint', async () => {
    const h = harness(() => jsonResponse(doc({ authorization_endpoint: `${ISSUER}/auth?x=1` })));
    const { url } = await redirectOf(start(provider(h)));
    expect(url.searchParams.get('x')).toBe('1');
  });
});

describe('list caps before copying', () => {
  function watched(length: number, entry: (index: number) => string) {
    const reads = { count: 0 };
    const list = new Proxy(
      Array.from({ length }, (_v, index) => entry(index)),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            reads.count += 1;
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    return { list, reads };
  }

  it.each(['scopes', 'trustedAudiences', 'trustedEndpointOrigins'])(
    'refuses an over-cap %s list without reading its entries',
    (key) => {
      const { list, reads } = watched(33, (index) => `https://o${index}.example.net`);
      const problems = oidcProblems({ ...config(), [key]: list });
      expect(problems).toContain(`${key} must be an array of 1 to 32 entries`);
      expect(reads.count).toBe(0);
    },
  );

  it('refuses an over-cap verifiedDomains list without reading its entries', () => {
    const { list, reads } = watched(33, (index) => `d${index}.example.com`);
    const problems = oidcProblems(config({ policy: { verifiedDomains: list, autoJoin: false } }));
    expect(problems).toContain('policy: verifiedDomains must list at most 32 domains');
    expect(reads.count).toBe(0);
  });

  it.each([
    ['scopes', ['openid', 's'.repeat(256)]],
    ['trustedAudiences', ['a'.repeat(256)]],
  ])('refuses an over-long %s entry', (key, value) => {
    const problems = oidcProblems({ ...config(), [key]: value });
    expect(problems.some((problem) => problem.startsWith(`${key}[`))).toBe(true);
  });
});

describe('hidden configuration keys', () => {
  it('refuses an inherited key', () => {
    const { clientId, ...rest } = config();
    const inherited = Object.create({ clientId }) as Record<string, unknown>;
    Object.assign(inherited, rest);
    expect(oidcProblems(inherited)).toContain(
      'configuration keys must be own, enumerable string keys',
    );
  });

  it('refuses a non-enumerable key', () => {
    const hidden = config() as unknown as Record<string, unknown>;
    Object.defineProperty(hidden, 'displayName', { value: 'Hidden', enumerable: false });
    expect(oidcProblems(hidden)).toContain(
      'configuration keys must be own, enumerable string keys',
    );
  });

  it('refuses a symbol key', () => {
    expect(oidcProblems({ ...config(), [Symbol('x')]: 1 })).toContain(
      'configuration keys must be own, enumerable string keys',
    );
  });

  it('refuses an inherited policy key', () => {
    const policy = Object.create({ autoJoin: false }) as Record<string, unknown>;
    policy['verifiedDomains'] = ['example.com'];
    expect(oidcProblems(config({ policy: policy as unknown as DomainPolicy }))).toContain(
      'policy: keys must be own, enumerable string keys',
    );
  });

  it('refuses a groups key in the policy', () => {
    const policy = { ...POLICY, groups: ['staff'] } as DomainPolicy;
    expect(oidcProblems(config({ policy }))).toContain('policy: unsupported key "groups"');
  });
});
