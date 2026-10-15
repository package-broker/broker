import { base64urlEncode } from '@package-broker/core/auth/primitives';
import type { Clock } from '@package-broker/core/ids';
import type { IdentityContext, IdentityResult } from '@package-broker/core/identity/port';
import { isValidTrustAnchor } from '@package-broker/core/identity/port';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type CloudflareAccessConfig,
  cloudflareAccessProblems,
  createCloudflareAccessProvider,
} from './cloudflare-access.js';
import type { CryptoKey } from './jwt.js';

const NOW = 1_800_000_000;
const TEAM = 'team.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const CERTS_URL = `${ISSUER}/cdn-cgi/access/certs`;
const AUDIENCE = 'ab12'.repeat(16);
const KID = 'key-1';
const HEADER = 'Cf-Access-Jwt-Assertion';
const encoder = new TextEncoder();

const clock: Clock = { now: () => new Date(NOW * 1000) };

let signer: { privateKey: CryptoKey; publicKey: CryptoKey };
let otherSigner: { privateKey: CryptoKey; publicKey: CryptoKey };
let jwks: unknown;

async function generate() {
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
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

beforeAll(async () => {
  signer = await generate();
  otherSigner = await generate();
  const jwk = await crypto.subtle.exportKey('jwk', signer.publicKey);
  jwks = { keys: [{ kty: 'RSA', kid: KID, use: 'sig', alg: 'RS256', n: jwk.n, e: jwk.e }] };
});

function segment(value: unknown): string {
  return base64urlEncode(encoder.encode(JSON.stringify(value)));
}

async function sign(payload: unknown, key: CryptoKey = signer.privateKey): Promise<string> {
  const signingInput = `${segment({ alg: 'RS256', typ: 'JWT', kid: KID })}.${segment(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    iss: ISSUER,
    sub: 'user-1',
    aud: [AUDIENCE],
    exp: NOW + 300,
    iat: NOW - 10,
    email: 'Someone@Example.test',
    type: 'app',
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete base[name];
    } else {
      base[name] = value;
    }
  }
  return base;
}

function jsonResponse(body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

interface Harness {
  readonly ctx: IdentityContext;
  readonly requested: string[];
}

function harness(respond: (request: Request) => Promise<Response> | Response): Harness {
  const requested: string[] = [];
  return {
    requested,
    ctx: {
      clock,
      env: () => undefined,
      fetch: async (request) => {
        requested.push(request.url);
        return respond(request);
      },
    },
  };
}

function certsHarness(): Harness {
  return harness(() => jsonResponse(jwks));
}

function config(overrides: Record<string, unknown> = {}): CloudflareAccessConfig {
  return {
    id: 'access',
    kind: 'cloudflare-access',
    teamDomain: TEAM,
    audience: AUDIENCE,
    policy: { verifiedDomains: ['example.test'], autoJoin: false },
    trustEmailVerification: true,
    ...overrides,
  } as CloudflareAccessConfig;
}

function requestWith(token: string | null): Request {
  const headers = new Headers();
  if (token !== null) {
    headers.set(HEADER, token);
  }
  return new Request('https://broker.example.test/sso/access/callback', { headers });
}

async function finish(
  token: string | null,
  options: { config?: CloudflareAccessConfig; harness?: Harness } = {},
): Promise<IdentityResult> {
  const { ctx } = options.harness ?? certsHarness();
  const provider = createCloudflareAccessProvider(options.config ?? config(), ctx);
  return provider.finish({
    request: requestWith(token),
    state: null,
    callbackUrl: 'https://broker.example.test/sso/access/callback',
  });
}

function failureOf(result: IdentityResult): string {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.reason;
}

describe('cloudflareAccessProblems', () => {
  it('accepts a complete configuration', () => {
    expect(cloudflareAccessProblems(config())).toEqual([]);
    expect(cloudflareAccessProblems(config({ displayName: 'Company SSO' }))).toEqual([]);
    expect(cloudflareAccessProblems(config({ trustEmailVerification: false }))).toEqual([]);
  });

  it('rejects a configuration that is not an object', () => {
    for (const value of [null, undefined, 'x', 1, [], true]) {
      expect(cloudflareAccessProblems(value)).not.toEqual([]);
    }
  });

  it('rejects a missing or non-boolean trustEmailVerification', () => {
    const rest: Record<string, unknown> = { ...config() };
    delete rest.trustEmailVerification;
    expect(cloudflareAccessProblems(rest)).toEqual(['trustEmailVerification must be a boolean']);
    for (const value of ['true', 1, null, undefined]) {
      expect(cloudflareAccessProblems(config({ trustEmailVerification: value }))).toEqual([
        'trustEmailVerification must be a boolean',
      ]);
    }
  });

  it('rejects a team domain that is not a bare lowercase hostname', () => {
    for (const teamDomain of [
      'https://x.cloudflareaccess.com',
      'x.cloudflareaccess.com/',
      'x.cloudflareaccess.com:443',
      'X.cloudflareaccess.com',
      'user@x.cloudflareaccess.com',
      'x.cloudflareaccess.com.',
      'localhost',
      'evil.example',
      'team.example.cloudflareaccess.com',
      'cloudflareaccess.com',
      '.cloudflareaccess.com',
      'team.cloudflareaccess.com.evil.example',
      'team-.cloudflareaccess.com',
      'evilcloudflareaccess.com',
      '',
      42,
      undefined,
    ]) {
      const problems = cloudflareAccessProblems(config({ teamDomain }));
      expect(problems.length, String(teamDomain)).toBeGreaterThan(0);
      expect(problems.join(' ')).toContain('teamDomain');
    }
  });

  it('rejects an audience that is not exactly 64 lowercase hex characters', () => {
    for (const audience of [
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      `${'a'.repeat(63)} `,
      '',
      42,
      undefined,
    ]) {
      const problems = cloudflareAccessProblems(config({ audience }));
      expect(problems.length, String(audience)).toBeGreaterThan(0);
      expect(problems.join(' ')).toContain('audience');
    }
  });

  it('rejects any groups key until the group shape is verified', () => {
    for (const groups of [['staff'], [], undefined, null, 'staff']) {
      expect(cloudflareAccessProblems(config({ groups }))).toContain(
        'groups are not supported until spike T172',
      );
    }
  });

  it('rejects an invalid policy and names the policy in the problem', () => {
    for (const policy of [
      undefined,
      null,
      {},
      { verifiedDomains: [], autoJoin: false },
      { verifiedDomains: ['*.example.test'], autoJoin: false },
      { verifiedDomains: ['Example.test'], autoJoin: false },
      { verifiedDomains: ['example.test'] },
    ]) {
      const problems = cloudflareAccessProblems(config({ policy }));
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((problem) => problem.startsWith('policy'))).toBe(true);
    }
  });

  it('rejects unknown keys, including misspelt and inherited group keys', () => {
    for (const key of ['group', 'Groups', 'groupIds', 'allowedGroups', 'audiences', 'extra']) {
      expect(cloudflareAccessProblems(config({ [key]: ['staff'] })), key).toEqual([
        'unknown configuration key',
      ]);
    }
    const inherited = Object.create({ groups: ['staff'] }) as Record<string, unknown>;
    Object.assign(inherited, config());
    expect(cloudflareAccessProblems(inherited)).toContain(
      'groups are not supported until spike T172',
    );
    const inheritedOther = Object.create({ extra: 1 }) as Record<string, unknown>;
    Object.assign(inheritedOther, config());
    expect(cloudflareAccessProblems(inheritedOther)).not.toEqual([]);
    const hidden = config();
    Object.defineProperty(hidden, 'groups', { value: ['staff'], enumerable: false });
    expect(cloudflareAccessProblems(hidden)).toContain('groups are not supported until spike T172');
    expect(cloudflareAccessProblems({ ...config(), [Symbol('x')]: 1 })).toEqual([
      'unknown configuration key',
    ]);
  });

  it('rejects a wrong kind, an invalid or reserved id and a non-string displayName', () => {
    expect(cloudflareAccessProblems(config({ kind: 'oidc' }))).not.toEqual([]);
    expect(cloudflareAccessProblems(config({ id: 'Access' }))).not.toEqual([]);
    expect(cloudflareAccessProblems(config({ id: 'local' }))).not.toEqual([]);
    expect(cloudflareAccessProblems(config({ id: undefined }))).not.toEqual([]);
    expect(cloudflareAccessProblems(config({ displayName: 3 }))).not.toEqual([]);
  });

  it('reports every problem at once and never echoes configured values', () => {
    const problems = cloudflareAccessProblems({
      id: 'x',
      kind: 'cloudflare-access',
      teamDomain: 'https://secret-team.example',
      audience: 'secret-audience',
      policy: { verifiedDomains: ['secret.example'], autoJoin: 'secret' },
      groups: ['secret-group'],
    });
    expect(problems.length).toBeGreaterThanOrEqual(5);
    expect(problems.join(' ')).not.toContain('secret');
  });
});

describe('createCloudflareAccessProvider', () => {
  it('rejects an invalid configuration at creation time', () => {
    const { ctx } = certsHarness();
    expect(() => createCloudflareAccessProvider(config({ groups: ['staff'] }), ctx)).toThrow(
      'groups are not supported until spike T172',
    );
    expect(() => createCloudflareAccessProvider(config({ audience: 'a'.repeat(63) }), ctx)).toThrow(
      RangeError,
    );
  });

  it('exposes the trust anchor, no re-authentication and the direct start', async () => {
    const { ctx, requested } = certsHarness();
    const provider = createCloudflareAccessProvider(config(), ctx);
    expect(provider.id).toBe('access');
    expect(provider.kind).toBe('cloudflare-access');
    expect(provider.trustAnchor).toBe(`access:${TEAM}/${AUDIENCE}`);
    expect(isValidTrustAnchor(provider.trustAnchor)).toBe(true);
    expect(provider.supportsReauth).toBe(false);
    expect(provider.policy).toEqual({ verifiedDomains: ['example.test'], autoJoin: false });
    expect(typeof provider.displayName).toBe('string');
    expect(
      await provider.start({
        request: requestWith(null),
        purpose: 'login',
        callbackUrl: 'https://broker.example.test/sso/access/callback',
      }),
    ).toEqual({ kind: 'direct' });
    expect(requested).toEqual([]);
  });

  it('refuses to start a re-authentication', async () => {
    const { ctx, requested } = certsHarness();
    const provider = createCloudflareAccessProvider(config(), ctx);
    await expect(
      provider.start({
        request: requestWith(null),
        purpose: 'reauth',
        callbackUrl: 'https://broker.example.test/sso/access/callback',
      }),
    ).rejects.toThrow('re-authentication is not supported');
    expect(requested).toEqual([]);
  });

  it('uses the configured display name', () => {
    const { ctx } = certsHarness();
    expect(
      createCloudflareAccessProvider(config({ displayName: 'Company SSO' }), ctx).displayName,
    ).toBe('Company SSO');
  });

  it('does not follow later changes to the configuration object', () => {
    const { ctx } = certsHarness();
    const verifiedDomains = ['example.test'];
    const provider = createCloudflareAccessProvider(
      config({ policy: { verifiedDomains, autoJoin: false } }),
      ctx,
    );
    verifiedDomains.push('evil.test');
    expect(provider.policy.verifiedDomains).toEqual(['example.test']);
  });
});

describe('finish', () => {
  it('turns a valid assertion into an identity', async () => {
    const harness = certsHarness();
    const result = await finish(await sign(payload()), { harness });
    expect(result).toEqual({
      ok: true,
      identity: {
        provider: 'access',
        subject: 'user-1',
        email: 'someone@example.test',
        emailVerified: true,
        displayName: null,
        groups: [],
        issuedAt: new Date((NOW - 10) * 1000).toISOString(),
        authTime: null,
      },
    });
    expect(harness.requested).toEqual([CERTS_URL]);
  });

  it('sets emailVerified from the configuration flag', async () => {
    const token = await sign(payload());
    for (const flag of [true, false]) {
      const result = await finish(token, { config: config({ trustEmailVerification: flag }) });
      expect(result.ok).toBe(true);
      expect(result).toEqual({
        ok: true,
        identity: {
          provider: 'access',
          subject: 'user-1',
          email: 'someone@example.test',
          emailVerified: flag,
          displayName: null,
          groups: [],
          issuedAt: new Date((NOW - 10) * 1000).toISOString(),
          authTime: null,
        },
      });
    }
  });

  it('passes the normalised e-mail address on', async () => {
    const result = await finish(await sign(payload({ email: '  Some.One@EXAMPLE.test ' })));
    expect(result.ok && result.identity.email).toBe('some.one@example.test');
    const trailing = await finish(await sign(payload({ email: 'someone@example.test\r\n' })));
    expect(trailing.ok && trailing.identity.email).toBe('someone@example.test');
  });

  it('returns email_missing for an e-mail address that cannot be normalised', async () => {
    for (const email of [
      '',
      '  ',
      'ü@example.test',
      'someone@exämple.test',
      'some\r\none@example.test',
      'some\u0000one@example.test',
      'someone',
      'someone@',
      'a@b@example.test',
      'someone@localhost',
    ]) {
      expect(failureOf(await finish(await sign(payload({ email })))), JSON.stringify(email)).toBe(
        'email_missing',
      );
    }
  });

  it('ignores an assertion that only arrives in the CF_Authorization cookie', async () => {
    const harness = certsHarness();
    const provider = createCloudflareAccessProvider(config(), harness.ctx);
    const token = await sign(payload());
    const request = new Request('https://broker.example.test/sso/access/callback', {
      headers: { cookie: `CF_Authorization=${token}` },
    });
    const result = await provider.finish({
      request,
      state: null,
      callbackUrl: 'https://x.test/cb',
    });
    expect(failureOf(result)).toBe('missing_credentials');
    expect(harness.requested).toEqual([]);
  });

  it('never reports a group or an authentication time even when the claims carry them', async () => {
    const token = await sign(
      payload({ groups: ['staff'], auth_time: NOW - 5, custom: { groups: ['x'] } }),
    );
    const result = await finish(token);
    expect(result.ok && result.identity.groups).toEqual([]);
    expect(result.ok && result.identity.authTime).toBeNull();
  });

  it('accepts aud as the bare audience string and a missing type claim', async () => {
    expect((await finish(await sign(payload({ aud: AUDIENCE })))).ok).toBe(true);
    expect((await finish(await sign(payload({ type: undefined })))).ok).toBe(true);
  });

  it('fetches the signing keys once for several assertions', async () => {
    const harness = certsHarness();
    const provider = createCloudflareAccessProvider(config(), harness.ctx);
    const token = await sign(payload());
    for (let index = 0; index < 3; index += 1) {
      const result = await provider.finish({
        request: requestWith(token),
        state: null,
        callbackUrl: 'https://broker.example.test/cb',
      });
      expect(result.ok).toBe(true);
    }
    expect(harness.requested).toHaveLength(1);
  });

  it('returns missing_credentials without a header or with an empty one, before any network call', async () => {
    const harness = certsHarness();
    expect(failureOf(await finish(null, { harness }))).toBe('missing_credentials');
    expect(failureOf(await finish('', { harness }))).toBe('missing_credentials');
    expect(harness.requested).toEqual([]);
  });

  it('returns invalid_token for a malformed assertion', async () => {
    for (const token of ['x', 'a.b', 'a.b.c', '...']) {
      expect(failureOf(await finish(token))).toBe('invalid_token');
    }
  });

  it('refuses service tokens: common_name, empty or missing sub, non-app type', async () => {
    for (const overrides of [
      { common_name: 'abc.access', sub: '' },
      { common_name: 'abc.access' },
      { common_name: '' },
      { common_name: null },
      { sub: '' },
      { sub: undefined },
      { sub: 7 },
      { type: 'service' },
      { type: '' },
      { type: null },
      { type: ['app'] },
    ]) {
      expect(
        failureOf(await finish(await sign(payload(overrides)))),
        JSON.stringify(overrides),
      ).toBe('invalid_token');
    }
  });

  it('returns email_missing when email is absent or not a string', async () => {
    for (const email of [undefined, null, 7, ['a@example.test'], { value: 'a@example.test' }]) {
      expect(failureOf(await finish(await sign(payload({ email }))))).toBe('email_missing');
    }
  });

  it('checks the audience before looking at the e-mail', async () => {
    const token = await sign(payload({ aud: ['b'.repeat(64)], email: undefined }));
    expect(failureOf(await finish(token))).toBe('invalid_token');
  });

  it('rejects an aud array with any entry besides the configured audience', async () => {
    for (const aud of [
      [AUDIENCE, 'b'.repeat(64)],
      ['b'.repeat(64), AUDIENCE],
      [AUDIENCE, AUDIENCE],
      ['b'.repeat(64)],
      [],
      '',
      42,
      undefined,
    ]) {
      expect(failureOf(await finish(await sign(payload({ aud })))), JSON.stringify(aud)).toBe(
        'invalid_token',
      );
    }
  });

  it('rejects a wrong issuer, an expired assertion and a foreign signature', async () => {
    for (const token of [
      await sign(payload({ iss: 'https://other.cloudflareaccess.com' })),
      await sign(payload({ iss: `${ISSUER}/` })),
      await sign(payload({ exp: NOW - 3600 })),
      await sign(payload({ iat: NOW + 3600 })),
      await sign(payload(), otherSigner.privateKey),
    ]) {
      expect(failureOf(await finish(token))).toBe('invalid_token');
    }
  });

  it('rejects a kid that the key set does not contain', async () => {
    const header = { alg: 'RS256', typ: 'JWT', kid: 'other-key' };
    const signingInput = `${segment(header)}.${segment(payload())}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      signer.privateKey,
      encoder.encode(signingInput),
    );
    const token = `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
    expect(failureOf(await finish(token))).toBe('invalid_token');
  });

  it('returns provider_error, not invalid_token, when the signing keys cannot be loaded', async () => {
    const token = await sign(payload());
    const broken: Array<() => Promise<Response> | Response> = [
      () => {
        throw new TypeError('offline');
      },
      () => Promise.reject(new TypeError('offline')),
      () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
      () => new Response('{}', { status: 302, headers: { location: 'https://evil.test/' } }),
      () => jsonResponse(jwks, 'text/html'),
      () => jsonResponse(jwks, 'text/plain'),
      () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
      () => jsonResponse({ keys: 'nope' }),
    ];
    for (const respond of broken) {
      expect(failureOf(await finish(token, { harness: harness(respond) }))).toBe('provider_error');
    }
  });

  it('treats a well-formed but empty key set as an unknown key, not an outage', async () => {
    const token = await sign(payload());
    const result = await finish(token, { harness: harness(() => jsonResponse({ keys: [] })) });
    expect(failureOf(result)).toBe('invalid_token');
  });

  it('accepts a key set served as application/jwk-set+json', async () => {
    const result = await finish(await sign(payload()), {
      harness: harness(() => jsonResponse(jwks, 'application/jwk-set+json; charset=utf-8')),
    });
    expect(result.ok).toBe(true);
  });

  it('does not put the assertion or the e-mail address into the outbound request', async () => {
    const seen: Request[] = [];
    const token = await sign(payload());
    await finish(token, {
      harness: harness((request) => {
        seen.push(request);
        return jsonResponse(jwks);
      }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get(HEADER)).toBeNull();
    expect(seen[0]?.headers.get('authorization')).toBeNull();
    expect(seen[0]?.headers.get('cookie')).toBeNull();
    expect(seen[0]?.url).toBe(CERTS_URL);
  });
});
