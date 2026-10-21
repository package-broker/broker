import { base64urlEncode } from '@package-broker/core/auth/primitives';
import type { IdentityContext, IdentityResult } from '@package-broker/core/plugin';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type CloudflareAccessConfig,
  cloudflareAccessProblems,
  createCloudflareAccessProvider,
} from './cloudflare-access.js';
import type { CryptoKey } from './jwt.js';

const NOW = 1_800_000_000;
const ISSUER = 'https://team.cloudflareaccess.com';
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const IDENTITY_URL = `${ISSUER}/cdn-cgi/access/get-identity`;
const AUDIENCE = 'ab12'.repeat(16);
const encoder = new TextEncoder();
let privateKey: CryptoKey;
let jwks: unknown;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  privateKey = pair.privateKey;
  const key = await crypto.subtle.exportKey('jwk', pair.publicKey);
  jwks = { keys: [{ ...key, kid: 'key-1', alg: 'RS256', use: 'sig' }] };
});

function config(groups?: unknown): CloudflareAccessConfig {
  return {
    id: 'access',
    kind: 'cloudflare-access',
    teamDomain: 'team.cloudflareaccess.com',
    audience: AUDIENCE,
    policy: { verifiedDomains: ['example.test'], autoJoin: false },
    trustEmailVerification: true,
    ...(groups === undefined ? {} : { groups }),
  } as unknown as CloudflareAccessConfig;
}

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_uuid: 'user-1',
    email: 'person@example.test',
    groups: ['staff', 'engineering'],
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function assertion(overrides: Record<string, unknown> = {}): Promise<string> {
  const segment = (value: unknown): string =>
    base64urlEncode(encoder.encode(JSON.stringify(value)));
  const input = `${segment({ alg: 'RS256', kid: 'key-1' })}.${segment({
    iss: ISSUER,
    sub: 'user-1',
    email: 'Person@EXAMPLE.test',
    aud: [AUDIENCE],
    iat: NOW - 10,
    exp: NOW + 300,
    type: 'app',
    ...overrides,
  })}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoder.encode(input),
  );
  return `${input}.${base64urlEncode(new Uint8Array(signature))}`;
}

async function run(
  options: {
    respond?: (request: Request) => Response | Promise<Response>;
    cookie?: string | null;
    groups?: unknown;
    claims?: Record<string, unknown>;
    token?: string;
  } = {},
): Promise<{ result: IdentityResult; seen: Request[] }> {
  const seen: Request[] = [];
  const ctx: IdentityContext = {
    clock: { now: () => new Date(NOW * 1000) },
    env: () => undefined,
    fetch: async (request) => {
      seen.push(request);
      if (request.url === CERTS_URL) return json(jwks);
      if (request.url === IDENTITY_URL) return options.respond?.(request) ?? json(fixture());
      throw new Error('unexpected origin');
    },
  };
  const provider = createCloudflareAccessProvider(config(options.groups ?? 'get-identity'), ctx);
  const headers = new Headers({
    'Cf-Access-Jwt-Assertion': options.token ?? (await assertion(options.claims)),
  });
  if (options.cookie !== null) {
    headers.set(
      'cookie',
      options.cookie ?? 'other=discard; CF_Authorization=synthetic-cookie; x=y',
    );
  }
  const result = await provider.finish({
    request: new Request('https://broker.example.test/sso/access/callback', { headers }),
    state: null,
    callbackUrl: 'https://broker.example.test/sso/access/callback',
  });
  return { result, seen };
}

const providerError = { ok: false, reason: 'provider_error' };

describe('Cloudflare Access get-identity groups', () => {
  it('accepts the two supported modes and the omitted default', () => {
    for (const mode of [undefined, 'none', 'get-identity']) {
      expect(cloudflareAccessProblems(config(mode))).toEqual([]);
    }
  });

  it('rejects other modes and hidden or inherited mode keys', () => {
    for (const mode of [null, false, [], {}, 'jwt', 'GET-IDENTITY']) {
      expect(cloudflareAccessProblems(config(mode))).not.toEqual([]);
    }
    const inherited = Object.assign(Object.create({ groups: 'get-identity' }) as object, config());
    expect(cloudflareAccessProblems(inherited)).not.toEqual([]);
    const hidden = config();
    Object.defineProperty(hidden, 'groups', { value: 'get-identity', enumerable: false });
    expect(cloudflareAccessProblems(hidden)).not.toEqual([]);
  });

  it('maps a synthetic string-array fixture and forwards only the Access cookie to the team', async () => {
    const { result, seen } = await run();
    expect(result.ok && result.identity.groups).toEqual(['staff', 'engineering']);
    expect(seen.map((request) => request.url)).toEqual([CERTS_URL, IDENTITY_URL]);
    expect(seen[0]?.headers.get('cookie')).toBeNull();
    const lookup = seen[1];
    expect(lookup?.method).toBe('GET');
    expect(lookup?.redirect).toBe('manual');
    expect(lookup?.headers.get('cookie') === 'CF_Authorization=synthetic-cookie').toBe(true);
    expect(lookup?.headers.has('Cf-Access-Jwt-Assertion')).toBe(false);
    expect(lookup?.headers.has('authorization')).toBe(false);
  });

  it('maps object identifiers with names as a fallback and drops malformed entries', async () => {
    const { result } = await run({
      respond: () =>
        json(
          fixture({
            groups: [
              { id: 'group-1', name: 'Staff' },
              { name: 'Engineering' },
              { id: '', name: 'Support' },
              'direct',
              '',
              null,
              7,
              {},
              { id: 12 },
              { name: [] },
              ['nested'],
            ],
          }),
        ),
    });
    expect(result.ok && result.identity.groups).toEqual([
      'group-1',
      'Engineering',
      'Support',
      'direct',
    ]);
  });

  it('accepts missing or empty groups for a matching identity', async () => {
    const missing = fixture();
    delete missing.groups;
    for (const body of [missing, fixture({ groups: [] })]) {
      const { result } = await run({ respond: () => json(body) });
      expect(result.ok && result.identity.groups).toEqual([]);
    }
  });

  it('requires both the UUID and normalized email to match, including when groups are absent', async () => {
    for (const body of [
      fixture({ user_uuid: 'other-user' }),
      fixture({ email: 'other@example.test' }),
      fixture({ user_uuid: undefined }),
      fixture({ email: undefined }),
      fixture({ user_uuid: null }),
      fixture({ user_uuid: 7 }),
      fixture({ email: null }),
      fixture({ email: [] }),
      { user_uuid: 'other-user', email: 'person@example.test' },
    ]) {
      expect((await run({ respond: () => json(body) })).result).toEqual(providerError);
    }
    expect(
      (await run({ respond: () => json(fixture({ email: ' Person@EXAMPLE.test ' })) })).result.ok,
    ).toBe(true);
  });

  it('fails closed for malformed identity documents and non-array group claims', async () => {
    for (const body of [
      null,
      [],
      'identity',
      1,
      {},
      fixture({ groups: null }),
      fixture({ groups: 'staff' }),
      fixture({ groups: {} }),
    ]) {
      expect((await run({ respond: () => json(body) })).result).toEqual(providerError);
    }
  });

  it('requires an unambiguous, nonempty Access cookie without making an identity request', async () => {
    for (const cookie of [
      null,
      '',
      'other=value',
      'CF_Authorization=',
      'CF_Authorization=x; CF_Authorization=y',
      'CF_Authorization="quoted"',
    ]) {
      const { result, seen } = await run({ cookie });
      expect(result).toEqual(providerError);
      expect(seen.every((request) => request.url === CERTS_URL)).toBe(true);
    }
  });

  it('returns provider_error for every non-200 status and refuses redirect targets', async () => {
    for (const status of [201, 202, 204, 301, 302, 303, 307, 308, 400, 401, 403, 404, 500]) {
      const { result, seen } = await run({
        respond: () =>
          new Response(status === 204 ? null : JSON.stringify(fixture()), {
            status,
            headers: {
              'content-type': 'application/json',
              location: 'https://other.example.test/',
            },
          }),
      });
      expect(result).toEqual(providerError);
      expect(seen.map((request) => request.url)).toEqual([CERTS_URL, IDENTITY_URL]);
    }
  });

  it('returns provider_error for oversized bodies while streaming', async () => {
    const { result } = await run({
      respond: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('{"padding":"'));
              controller.enqueue(encoder.encode('x'.repeat(64 * 1024)));
              controller.enqueue(encoder.encode(`",${JSON.stringify(fixture()).slice(1)}`));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });
    expect(result).toEqual(providerError);
  });

  it('returns provider_error for network, JSON and content-type failures', async () => {
    for (const respond of [
      () => Promise.reject(new Error('offline')),
      () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
      () => new Response(JSON.stringify(fixture()), { headers: { 'content-type': 'text/html' } }),
    ]) {
      expect((await run({ respond })).result).toEqual(providerError);
    }
  });

  it('does not fetch groups in none mode even if the assertion has groups', async () => {
    const { result, seen } = await run({
      groups: 'none',
      cookie: null,
      claims: { groups: ['ignored'] },
    });
    expect(result.ok && result.identity.groups).toEqual([]);
    expect(seen.map((request) => request.url)).toEqual([CERTS_URL]);
  });

  it('verifies assertions and rejects service tokens before fetching identity', async () => {
    for (const options of [
      { token: 'invalid' },
      { claims: { common_name: 'service', sub: '' } },
      { claims: { aud: ['cd34'.repeat(16)] } },
      { claims: { exp: NOW - 3600 } },
    ]) {
      const { result, seen } = await run(options);
      expect(result).toEqual({ ok: false, reason: 'invalid_token' });
      expect(seen.some((request) => request.url === IDENTITY_URL)).toBe(false);
    }
  });
});
