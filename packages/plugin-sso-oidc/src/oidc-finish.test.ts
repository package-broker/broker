import { base64urlEncode } from '@package-broker/core/auth/primitives';
import type {
  DomainPolicy,
  IdentityContext,
  IdentityResult,
  LoginStateData,
} from '@package-broker/core/identity/port';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CryptoKey } from './jwt.js';
import { createOidcProvider, tokenEndpointError, type OidcConfig } from './oidc.js';

const mapped = vi.hoisted(() => ({ results: [] as unknown[] }));

vi.mock('./http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http.js')>();
  return {
    ...actual,
    tokenEndpointError: (json: unknown) => {
      const result = actual.tokenEndpointError(json);
      mapped.results.push(result);
      return result;
    },
  };
});

const ISSUER = 'https://dex.example.com/dex';
const CALLBACK = 'https://broker.example.com/auth/oidc/dex/callback';
const CLIENT_ID = 'package-broker';
const SECRET_NAME = 'PB_IDP_DEX_CLIENT_SECRET';
const SECRET_VALUE = 'finish-secret-value-7d1e';
const POLICY: DomainPolicy = { verifiedDomains: ['example.com'], autoJoin: false };
const START_MS = Date.parse('2026-10-15T08:00:00Z');
const NOW_S = START_MS / 1000;
const KID = 'test-key-1';
const encoder = new TextEncoder();

interface KeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

let signer: KeyPair;
let stranger: KeyPair;
let jwk: Record<string, unknown>;

async function generate(): Promise<KeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as KeyPair;
}

beforeAll(async () => {
  signer = await generate();
  stranger = await generate();
  const exported = (await crypto.subtle.exportKey('jwk', signer.publicKey)) as Record<
    string,
    unknown
  >;
  jwk = { kty: 'RSA', n: exported.n, e: exported.e, kid: KID, alg: 'RS256', use: 'sig' };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function segment(value: unknown): string {
  return base64urlEncode(encoder.encode(JSON.stringify(value)));
}

async function sign(payload: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const input = `${segment({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${segment(payload)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(input)),
  );
  return `${input}.${base64urlEncode(signature)}`;
}

function claims(
  nonce: string,
  overrides: Record<string, unknown> = {},
  removed: readonly string[] = [],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    iss: ISSUER,
    sub: 'opaque-sub-1',
    aud: CLIENT_ID,
    exp: NOW_S + 3600,
    iat: NOW_S - 5,
    auth_time: NOW_S - 8,
    nonce,
    email: 'Ada@Example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    groups: ['authors', 'admins'],
    ...overrides,
  };
  for (const name of removed) {
    delete payload[name];
  }
  return payload;
}

interface Scenario {
  readonly ctx: IdentityContext;
  readonly requests: Request[];
  secret: string | undefined;
  discovery: Record<string, unknown>;
  token: () => Promise<Response> | Response;
  jwks: () => Response;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function scenario(): Scenario {
  const state: Scenario = {
    requests: [],
    secret: SECRET_VALUE,
    discovery: {},
    token: () => json({}),
    jwks: () => json({ keys: [jwk] }),
    ctx: undefined as unknown as IdentityContext,
  };
  (state as { ctx: IdentityContext }).ctx = {
    fetch: async (request) => {
      state.requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/.well-known/openid-configuration')) {
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/keys`,
          code_challenge_methods_supported: ['S256'],
          ...state.discovery,
        });
      }
      if (url.pathname === '/dex/token') {
        return state.token();
      }
      if (url.pathname === '/dex/keys') {
        return state.jwks();
      }
      return new Response('unexpected', { status: 404 });
    },
    clock: { now: () => new Date(START_MS) },
    env: (name) => (name === SECRET_NAME ? state.secret : undefined),
  };
  return state;
}

function provider(s: Scenario, overrides: Partial<OidcConfig> = {}) {
  return createOidcProvider(
    {
      id: 'dex',
      kind: 'oidc',
      issuer: ISSUER,
      clientId: CLIENT_ID,
      policy: POLICY,
      ...overrides,
    },
    s.ctx,
  );
}

type Provider = ReturnType<typeof provider>;

async function begin(p: Provider): Promise<LoginStateData> {
  const result = await p.start({
    request: new Request(CALLBACK),
    purpose: 'login',
    callbackUrl: CALLBACK,
  });
  if (result.kind !== 'redirect') {
    throw new Error('expected redirect');
  }
  return result.state;
}

function callback(query: Record<string, string>, extra = ''): Request {
  const params = new URLSearchParams(query);
  return new Request(`${CALLBACK}?${params.toString()}${extra}`);
}

function finish(
  p: Provider,
  request: Request,
  state: LoginStateData | null,
): Promise<IdentityResult> {
  return p.finish({ request, state, callbackUrl: CALLBACK });
}

interface LoginOptions {
  readonly config?: Partial<OidcConfig>;
  readonly overrides?: Record<string, unknown>;
  readonly removed?: readonly string[];
  readonly nonce?: (stored: string) => string;
  readonly key?: () => CryptoKey;
  readonly query?: (stored: LoginStateData) => Record<string, string>;
}

async function login(s: Scenario, options: LoginOptions = {}): Promise<IdentityResult> {
  const p = provider(s, options.config);
  const stored = await begin(p);
  const nonce = options.nonce?.(stored.nonce as string) ?? (stored.nonce as string);
  const idToken = await sign(
    claims(nonce, options.overrides, options.removed),
    options.key?.() ?? signer.privateKey,
  );
  s.token = () => json({ access_token: 'at', token_type: 'bearer', id_token: idToken });
  const query = options.query?.(stored) ?? { code: 'the-code', state: stored.state as string };
  return finish(p, callback(query), stored);
}

function tokenRequests(s: Scenario): Request[] {
  return s.requests.filter((request) => new URL(request.url).pathname === '/dex/token');
}

function afterStart(s: Scenario): Request[] {
  return s.requests.filter(
    (request) => !new URL(request.url).pathname.endsWith('/.well-known/openid-configuration'),
  );
}

function identityOf(result: IdentityResult) {
  if (!result.ok) {
    throw new Error(`expected identity, got ${result.reason}`);
  }
  return result.identity;
}

describe('finish success', () => {
  it('returns the identity with groups and authTime', async () => {
    const s = scenario();
    const identity = identityOf(await login(s));
    expect(identity).toEqual({
      provider: 'dex',
      subject: 'opaque-sub-1',
      email: 'Ada@Example.com',
      emailVerified: true,
      displayName: 'Ada Lovelace',
      groups: ['authors', 'admins'],
      issuedAt: new Date((NOW_S - 5) * 1000).toISOString(),
      authTime: new Date((NOW_S - 8) * 1000).toISOString(),
    });
  });

  it('sends the verifier, the code and the redirect uri in one token request', async () => {
    const s = scenario();
    const p = provider(s);
    const stored = await begin(p);
    const idToken = await sign(claims(stored.nonce as string), signer.privateKey);
    s.token = () => json({ id_token: idToken });
    const result = await finish(
      p,
      callback({ code: 'c0de', state: stored.state as string }),
      stored,
    );
    expect(result.ok).toBe(true);
    const sent = tokenRequests(s);
    expect(sent).toHaveLength(1);
    const request = sent[0] as Request;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${ISSUER}/token`);
    expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(await request.text());
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'c0de',
      redirect_uri: CALLBACK,
      code_verifier: stored.verifier,
    });
    expect(body.has('client_secret')).toBe(false);
    expect(body.has('client_id')).toBe(false);
  });

  it('form-encodes the client id and secret before the Basic header', async () => {
    const s = scenario();
    s.secret = 'p%&+';
    const result = await login(s, { config: { clientId: 'a:b' }, overrides: { aud: 'a:b' } });
    expect(result.ok).toBe(true);
    const header = (tokenRequests(s)[0] as Request).headers.get('authorization') as string;
    expect(header.startsWith('Basic ')).toBe(true);
    const decoded = atob(header.slice('Basic '.length));
    expect(decoded).toBe('a%3Ab:p%25%26%2B');
    const [encodedId, encodedSecret] = decoded.split(':') as [string, string];
    expect(new URLSearchParams(`v=${encodedId}`).get('v')).toBe('a:b');
    expect(new URLSearchParams(`v=${encodedSecret}`).get('v')).toBe('p%&+');
  });

  it('uses the application/x-www-form-urlencoded form for space (secret), asterisk and tilde', async () => {
    const s = scenario();
    s.secret = 'p w*~';
    const result = await login(s, {
      config: { clientId: 'a*~b' },
      overrides: { aud: 'a*~b' },
    });
    expect(result.ok).toBe(true);
    const header = (tokenRequests(s)[0] as Request).headers.get('authorization') as string;
    expect(atob(header.slice('Basic '.length))).toBe('a*%7Eb:p+w*%7E');
  });

  it('sends the secret only to the discovered token endpoint', async () => {
    const s = scenario();
    await login(s);
    const withCredentials = s.requests.filter((request) => request.headers.has('authorization'));
    expect(withCredentials.map((request) => request.url)).toEqual([`${ISSUER}/token`]);
  });

  it('accepts aud as a one-element array', async () => {
    const identity = identityOf(await login(scenario(), { overrides: { aud: [CLIENT_ID] } }));
    expect(identity.subject).toBe('opaque-sub-1');
  });

  it('accepts trusted extra audiences when azp is the client id', async () => {
    const result = await login(scenario(), {
      config: { trustedAudiences: ['other-app'] },
      overrides: { aud: [CLIENT_ID, 'other-app'], azp: CLIENT_ID },
    });
    expect(result.ok).toBe(true);
  });

  it('reports a null authTime when auth_time is absent', async () => {
    const identity = identityOf(await login(scenario(), { removed: ['auth_time'] }));
    expect(identity.authTime).toBeNull();
    expect(identity.issuedAt).toBe(new Date((NOW_S - 5) * 1000).toISOString());
  });

  it('treats a missing groups claim as an empty list', async () => {
    const identity = identityOf(await login(scenario(), { removed: ['groups'] }));
    expect(identity.groups).toEqual([]);
  });

  it('uses a null display name when name is absent or not a string', async () => {
    expect(identityOf(await login(scenario(), { removed: ['name'] })).displayName).toBeNull();
    expect(identityOf(await login(scenario(), { overrides: { name: 7 } })).displayName).toBeNull();
    expect(identityOf(await login(scenario(), { overrides: { name: '' } })).displayName).toBeNull();
  });

  it('returns emailVerified false for email_verified false', async () => {
    const identity = identityOf(await login(scenario(), { overrides: { email_verified: false } }));
    expect(identity.emailVerified).toBe(false);
  });

  it.each([['true'], [1], [null], [[true]]])(
    'refuses a present non-boolean email_verified (%j)',
    async (value) => {
      const result = await login(scenario(), { overrides: { email_verified: value } });
      expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    },
  );

  it('returns emailVerified false when email_verified is absent', async () => {
    const identity = identityOf(await login(scenario(), { removed: ['email_verified'] }));
    expect(identity.emailVerified).toBe(false);
  });

  it('keeps the subject verbatim', async () => {
    const sub = 'Cg5vcGFxdWUtc3ViLTE-ZXhhbXBsZQ';
    const identity = identityOf(await login(scenario(), { overrides: { sub } }));
    expect(identity.subject).toBe(sub);
  });
});

describe('finish callback checks', () => {
  it('refuses a state mismatch without contacting the issuer', async () => {
    const s = scenario();
    const result = await login(s, { query: () => ({ code: 'c', state: 'not-the-state' }) });
    expect(result).toEqual({ ok: false, reason: 'state_mismatch' });
    expect(afterStart(s)).toHaveLength(0);
  });

  it('refuses a missing state parameter', async () => {
    const s = scenario();
    const result = await login(s, { query: () => ({ code: 'c' }) });
    expect(result).toEqual({ ok: false, reason: 'state_mismatch' });
    expect(afterStart(s)).toHaveLength(0);
  });

  it('refuses a repeated state parameter', async () => {
    const s = scenario();
    const p = provider(s);
    const stored = await begin(p);
    const request = callback({ code: 'c', state: stored.state as string }, '&state=other');
    expect(await finish(p, request, stored)).toEqual({ ok: false, reason: 'state_mismatch' });
    expect(afterStart(s)).toHaveLength(0);
  });

  it('refuses a state that differs only in length', async () => {
    const s = scenario();
    const result = await login(s, {
      query: (stored) => ({ code: 'c', state: `${stored.state as string}x` }),
    });
    expect(result).toEqual({ ok: false, reason: 'state_mismatch' });
  });

  it('maps an error parameter to provider_error without contacting the issuer', async () => {
    const s = scenario();
    const result = await login(s, {
      query: (stored) => ({ error: 'access_denied', state: stored.state as string }),
    });
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
    expect(afterStart(s)).toHaveLength(0);
  });

  it('refuses a callback without a code', async () => {
    const s = scenario();
    const result = await login(s, { query: (stored) => ({ state: stored.state as string }) });
    expect(result).toEqual({ ok: false, reason: 'missing_credentials' });
    expect(afterStart(s)).toHaveLength(0);
  });

  it('refuses a repeated code parameter', async () => {
    const s = scenario();
    const p = provider(s);
    const stored = await begin(p);
    const request = callback({ code: 'a', state: stored.state as string }, '&code=b');
    expect(await finish(p, request, stored)).toEqual({ ok: false, reason: 'missing_credentials' });
    expect(tokenRequests(s)).toHaveLength(0);
  });

  it('refuses a missing login state', async () => {
    const s = scenario();
    const p = provider(s);
    expect(await finish(p, callback({ code: 'c', state: 's' }), null)).toEqual({
      ok: false,
      reason: 'state_mismatch',
    });
    expect(afterStart(s)).toHaveLength(0);
  });

  it('refuses a login state without a verifier or nonce', async () => {
    const s = scenario();
    const p = provider(s);
    const stored = await begin(p);
    const incomplete = { state: stored.state as string, nonce: stored.nonce as string };
    expect(await finish(p, callback({ code: 'c', state: incomplete.state }), incomplete)).toEqual({
      ok: false,
      reason: 'state_mismatch',
    });
    expect(tokenRequests(s)).toHaveLength(0);
  });

  it('refuses an empty stored state against an empty state parameter', async () => {
    const s = scenario();
    const p = provider(s);
    const stored = await begin(p);
    const empty = { ...stored, state: '' };
    const request = new Request(`${CALLBACK}?state=&code=c`);
    expect(await finish(p, request, empty)).toEqual({ ok: false, reason: 'state_mismatch' });
    expect(afterStart(s)).toHaveLength(0);
  });

  it.each([
    ['not a url'],
    ['ftp://broker.example.com/cb'],
    ['http://broker.example.com/cb'],
    [`${CALLBACK}#fragment`],
    ['https://user:pw@broker.example.com/cb'],
  ])('fails before any network call for the callback URL %j', async (callbackUrl) => {
    const s = scenario();
    const p = provider(s);
    const stored = await begin(p);
    const sent = s.requests.length;
    const result = await p.finish({
      request: callback({ code: 'c', state: stored.state as string }),
      state: stored,
      callbackUrl,
    });
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
    expect(s.requests).toHaveLength(sent);
  });

  it('fails with provider_error when the client secret is missing', async () => {
    const s = scenario();
    const p = provider(s);
    const stored = await begin(p);
    s.secret = undefined;
    const result = await finish(p, callback({ code: 'c', state: stored.state as string }), stored);
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
    expect(tokenRequests(s)).toHaveLength(0);
  });
});

describe('finish ID token checks', () => {
  it('refuses a nonce mismatch', async () => {
    const result = await login(scenario(), { nonce: () => 'another-nonce' });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a missing nonce', async () => {
    const result = await login(scenario(), { removed: ['nonce'] });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses an untrusted extra audience', async () => {
    const result = await login(scenario(), {
      overrides: { aud: [CLIENT_ID, 'evil-app'], azp: CLIENT_ID },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses an untrusted extra audience when another extra is trusted', async () => {
    const result = await login(scenario(), {
      config: { trustedAudiences: ['other-app'] },
      overrides: { aud: [CLIENT_ID, 'other-app', 'evil-app'], azp: CLIENT_ID },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses several audiences without azp', async () => {
    const result = await login(scenario(), {
      config: { trustedAudiences: ['other-app'] },
      overrides: { aud: [CLIENT_ID, 'other-app'] },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses several audiences with a foreign azp', async () => {
    const result = await login(scenario(), {
      config: { trustedAudiences: ['other-app'] },
      overrides: { aud: [CLIENT_ID, 'other-app'], azp: 'other-app' },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a single audience with a foreign azp', async () => {
    const result = await login(scenario(), { overrides: { azp: 'other-app' } });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a non-string azp', async () => {
    const result = await login(scenario(), { overrides: { azp: 5 } });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('accepts a single audience with azp equal to the client id', async () => {
    const result = await login(scenario(), { overrides: { azp: CLIENT_ID } });
    expect(result.ok).toBe(true);
  });

  it('refuses an audience that does not name the client', async () => {
    const result = await login(scenario(), { overrides: { aud: 'someone-else' } });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a wrong issuer', async () => {
    const result = await login(scenario(), { overrides: { iss: 'https://evil.example.com/dex' } });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses an expired token', async () => {
    const result = await login(scenario(), { overrides: { exp: NOW_S - 3600 } });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a token signed by another key', async () => {
    const result = await login(scenario(), { key: () => stranger.privateKey });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a token without an e-mail', async () => {
    expect(await login(scenario(), { removed: ['email'] })).toEqual({
      ok: false,
      reason: 'email_missing',
    });
    expect(await login(scenario(), { overrides: { email: '' } })).toEqual({
      ok: false,
      reason: 'email_missing',
    });
    expect(await login(scenario(), { overrides: { email: 7 } })).toEqual({
      ok: false,
      reason: 'email_missing',
    });
  });

  it.each([['authors'], [{ 0: 'authors' }], [7], [null]])(
    'refuses groups that are not an array (%j)',
    async (groups) => {
      const result = await login(scenario(), { overrides: { groups } });
      expect(result).toEqual({ ok: false, reason: 'invalid_token' });
    },
  );

  it('refuses groups holding a non-string entry', async () => {
    const result = await login(scenario(), { overrides: { groups: ['authors', 3] } });
    expect(result).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('fails with provider_error when the keys are unavailable', async () => {
    const s = scenario();
    s.jwks = () => new Response('down', { status: 503 });
    expect(await login(s)).toEqual({ ok: false, reason: 'provider_error' });
  });
});

describe('finish token endpoint origin', () => {
  it.each([
    ['a trusted foreign origin', 'https://tokens.example.net/dex/token'],
    ['a trusted foreign origin on another port', 'https://dex.example.com:8443/dex/token'],
  ])('sends no request and no credentials to %s', async (_name, tokenEndpoint) => {
    const s = scenario();
    s.discovery = { token_endpoint: tokenEndpoint };
    const origin = new URL(tokenEndpoint).origin;
    const result = await login(s, { config: { trustedEndpointOrigins: [origin] } });
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
    expect(afterStart(s)).toHaveLength(0);
    expect(s.requests.some((request) => request.headers.has('authorization'))).toBe(false);
  });
});

describe('finish token endpoint failures', () => {
  async function failing(
    respond: () => Promise<Response> | Response,
  ): Promise<{ result: IdentityResult; s: Scenario }> {
    const s = scenario();
    const p = provider(s);
    const stored = await begin(p);
    s.token = respond;
    const result = await finish(p, callback({ code: 'c', state: stored.state as string }), stored);
    return { result, s };
  }

  it('refuses an oversized token response', async () => {
    const { result } = await failing(() =>
      json(JSON.stringify({ id_token: 'x'.repeat(70 * 1024) })),
    );
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
  });

  it('refuses a redirecting token response and does not follow it', async () => {
    const { result, s } = await failing(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } }),
    );
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
    expect(s.requests.some((request) => new URL(request.url).host === 'evil.example.com')).toBe(
      false,
    );
  });

  it.each([400, 401, 500])('maps status %i to provider_error', async (status) => {
    const { result } = await failing(() =>
      json(
        { error: 'invalid_grant', error_description: 'Invalid or expired code parameter.' },
        { status },
      ),
    );
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
  });

  it('refuses a response that is not JSON', async () => {
    const { result } = await failing(
      () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    );
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
  });

  it('refuses malformed JSON', async () => {
    const { result } = await failing(() => json('{not json'));
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
  });

  it.each([[{}], [{ id_token: 5 }], [{ id_token: '' }], [[]], ['null']])(
    'refuses a response without a usable id_token (%j)',
    async (body) => {
      const { result } = await failing(() => json(body));
      expect(result).toEqual({ ok: false, reason: 'provider_error' });
    },
  );

  it('gives up after the deadline', async () => {
    vi.useFakeTimers();
    const s = scenario();
    const p = provider(s);
    const stored = await begin(p);
    s.token = () => new Promise<Response>(() => undefined);
    const pending = finish(p, callback({ code: 'c', state: stored.state as string }), stored);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toEqual({ ok: false, reason: 'provider_error' });
  });

  it('exchanges the code once and never retries', async () => {
    const { s } = await failing(() => json({ error: 'invalid_request' }, { status: 400 }));
    expect(tokenRequests(s)).toHaveLength(1);
  });
});

describe('finish secret handling', () => {
  it('never puts the client secret in a result, an error or the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    const outcomes: unknown[] = [];
    for (const key of [undefined, () => stranger.privateKey] as const) {
      const s = scenario();
      outcomes.push(await login(s, key === undefined ? {} : { key }));
    }
    const failing = scenario();
    const p = provider(failing);
    const stored = await begin(p);
    failing.token = () => json({ error: 'invalid_client' }, { status: 401 });
    outcomes.push(await finish(p, callback({ code: 'c', state: stored.state as string }), stored));
    failing.token = () => {
      throw new Error(`boom ${SECRET_VALUE}`);
    };
    outcomes.push(
      await finish(p, callback({ code: 'c', state: stored.state as string }), stored).catch(
        (error: unknown) => error,
      ),
    );
    const text = JSON.stringify(outcomes, (_key, value: unknown) =>
      value instanceof Error ? `${value.name} ${value.message} ${String(value.stack)}` : value,
    );
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain(btoa(`package-broker:${SECRET_VALUE}`));
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('token endpoint error bodies', () => {
  const DESCRIPTION = 'refresh-secret-4c1d leaked in error_description';

  function captureConsole(): unknown[][] {
    const records: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        records.push(args);
      });
    }
    return records;
  }

  beforeEach(() => {
    mapped.results.length = 0;
  });

  async function failWith(response: () => Response): Promise<IdentityResult> {
    const s = scenario();
    const p = provider(s);
    const stored = await begin(p);
    s.token = response;
    return finish(p, callback({ code: 'the-code', state: stored.state as string }), stored);
  }

  it('refuses a 400 invalid_grant body without exposing error_description', async () => {
    const records = captureConsole();
    const result = await failWith(() =>
      json({ error: 'invalid_grant', error_description: DESCRIPTION }, { status: 400 }),
    );
    expect(result).toEqual({ ok: false, reason: 'provider_error' });
    expect(mapped.results).toEqual(['invalid_grant']);
    expect(JSON.stringify(result)).not.toContain('refresh-secret');
    expect(JSON.stringify(records)).not.toContain('refresh-secret');
  });

  it('does not consult the error mapper for a successful token response', async () => {
    identityOf(await login(scenario()));
    expect(mapped.results).toEqual([]);
  });

  it.each([
    'invalid_grant',
    'invalid_client',
    'invalid_request',
    'unauthorized_client',
    'unsupported_grant_type',
    'invalid_scope',
  ])('maps the %s error code to itself', (code) => {
    expect(tokenEndpointError({ error: code, error_description: DESCRIPTION })).toBe(code);
  });

  it('maps an unknown error code to token_endpoint_error', () => {
    expect(tokenEndpointError({ error: 'temporarily_unavailable' })).toBe('token_endpoint_error');
    expect(tokenEndpointError({ error: DESCRIPTION })).toBe('token_endpoint_error');
  });

  it.each([
    ['a body without an error member', {}],
    ['a non-string error member', { error: 7 }],
    ['an array body', ['invalid_grant']],
    ['a string body', 'invalid_grant'],
  ])('maps %s to the status failure', (_name, body) => {
    expect(tokenEndpointError(body)).toBe('status');
  });

  it.each([
    ['a non-JSON body', () => new Response('<html>no</html>', { status: 400 })],
    ['an unparseable JSON body', () => json('{"error":', { status: 400 })],
    [
      'an over-cap body',
      () => json({ error: 'invalid_grant', pad: 'x'.repeat(70 * 1024) }, { status: 400 }),
    ],
    ['an unknown error code', () => json({ error: 'slow_down' }, { status: 400 })],
  ])('refuses %s as provider_error', async (_name, response) => {
    const records = captureConsole();
    expect(await failWith(response)).toEqual({ ok: false, reason: 'provider_error' });
    expect(records).toEqual([]);
  });
});
