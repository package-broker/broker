import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearJwksCache,
  createOidcVerifier,
  isWorkflowFilename,
  verifyOidcToken,
} from './verify.js';
import type { PolicyFetch } from '../../../sources/policy-fetch.js';
import { b64, claims, jwk, token } from './test-support/signed-fixture.js';

const now = 1800000000;
const publicUrl = 'https://registry.example.test:8443/prefix/';
const issuer = 'https://token.actions.githubusercontent.com';
const fetcher = (body: unknown = { keys: [jwk] }) =>
  vi.fn<PolicyFetch>(async () => ({
    status: 200,
    headers: new Headers(),
    body: new Response(typeof body === 'string' ? body : JSON.stringify(body)).body,
  }));
const verify = (jwt: string, policyFetch = fetcher(), at = now) =>
  verifyOidcToken(jwt, { publicUrl, policyFetch, now: at * 1000 });

beforeEach(() => clearJwksCache());
describe('workload OIDC verification', () => {
  it('verifies RS256, hostname audience, caller workflow and retains only safe claims', async () => {
    const result = await verify(
      await token({ ...claims, job_workflow_ref: 'ignored', email: 'hidden@example.test' }),
    );
    expect(result).toEqual({
      issuer,
      jti: 'unique',
      expiresAt: now + 300,
      repositoryId: '123',
      repositoryOwnerId: '456',
      repository: 'owner/repo',
      workflow: 'publish.yml',
      environment: '',
      ref: 'refs/tags/v1',
      eventName: 'push',
      repositoryVisibility: 'private',
    });
  });
  it.each([
    { iss: 'https://other.test' },
    { aud: ['npm:registry.example.test'] },
    { aud: 'npm:registry.example.test:8443' },
    { exp: now - 61 },
    { nbf: now + 61 },
    { iat: now + 61 },
    { exp: 'later' },
    { iat: null },
    { nbf: undefined },
    { exp: now },
    { repository_id: '1e2' },
    { repository_owner_id: '' },
    { jti: '' },
    { repository_visibility: 'unknown' },
    { workflow_ref: 'owner/repo/publish.yml@main' },
    { workflow_ref: 'owner/repo/.github/workflows/../publish.yml@main' },
    { ref: '' },
    { event_name: '' },
    { environment: null },
  ])('refuses invalid claims %j', async (patch) => {
    await expect(verify(await token({ ...claims, ...patch }))).rejects.toMatchObject({
      code: 'invalid_oidc_token',
    });
  });
  it.each([
    { alg: 'none' },
    { typ: 'JOSE' },
    { jku: 'https://evil.test' },
    { x5u: 'https://evil.test' },
    { crit: [] },
    { kid: '' },
  ])('refuses unsafe JOSE headers %j', async (patch) => {
    const fetch = fetcher();
    await expect(
      verify(await token(claims, { alg: 'RS256', typ: 'JWT', kid: 'key', ...patch }), fetch),
    ).rejects.toMatchObject({ code: 'invalid_oidc_token' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['', 'a.b.c.d', 'a=.b.c', 'a.b.c', 'a'.repeat(8193)])(
    'refuses malformed or oversized JWT before fetch',
    async (jwt) => {
      const fetch = fetcher();
      await expect(verify(jwt, fetch)).rejects.toMatchObject({ code: 'invalid_oidc_token' });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('refuses a forged signature', async () => {
    const jwt = await token();
    await expect(verify(jwt.slice(0, -10) + 'AAAAAAAAAA')).rejects.toMatchObject({
      code: 'invalid_oidc_token',
    });
  });
  it.each([
    '{"alg":"none","alg":"RS256","typ":"JWT","kid":"key"}',
    '{"alg":"RS256","typ":"JWT","kid":"key","extra":{"nested":{"too":{"deep":{"more":1}}}}}',
  ])('refuses duplicate keys and excessive JSON depth', async (header) => {
    await expect(verify(await token(claims, header))).rejects.toMatchObject({
      code: 'invalid_oidc_token',
    });
  });
  it('caches for ten minutes and uses only the fixed endpoint through policyFetch', async () => {
    const fetch = fetcher();
    const jwt = await token({ ...claims, exp: now + 2000 });
    await verify(jwt, fetch);
    await verify(jwt, fetch, now + 599);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${issuer}/.well-known/jwks`,
        redirects: 'error',
        maxBytes: 65536,
      }),
    );
    await verify(jwt, fetch, now + 600);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('refreshes once on unknown kid and shares concurrent downloads', async () => {
    const fetch = fetcher();
    const jwt = await token();
    await Promise.all([verify(jwt, fetch), verify(jwt, fetch)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      verify(await token(claims, { alg: 'RS256', typ: 'JWT', kid: 'unknown' }), fetch),
    ).rejects.toMatchObject({ code: 'invalid_oidc_token' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { keys: [jwk, jwk] },
    { keys: Array.from({ length: 21 }, () => jwk) },
    { keys: [{ ...jwk, alg: 'HS256' }] },
    { keys: [{ ...jwk, e: 'Aw' }] },
    ' '.repeat(65537),
  ])('fails closed on invalid JWKS', async (body) => {
    await expect(verify(await token(), fetcher(body))).rejects.toMatchObject({
      code: 'jwks_unavailable',
    });
  });
  it('does not use expired cached keys on refresh failure or expose transport errors', async () => {
    const fetch = fetcher();
    const jwt = await token({ ...claims, exp: now + 2000 });
    await verify(jwt, fetch);
    fetch.mockRejectedValue(new Error('credential secret@example.test'));
    await expect(verify(jwt, fetch, now + 600)).rejects.toMatchObject({
      message: 'jwks_unavailable',
      code: 'jwks_unavailable',
    });
  });
});

describe('OIDC edge bounds', () => {
  it.each([
    { jti: 'x'.repeat(257) },
    { repository_id: '1'.repeat(21) },
    { repository_owner_id: '1'.repeat(21) },
    { environment: 'a'.repeat(256) },
    { environment: 'é'.repeat(128) },
    { ref: 'x'.repeat(1025) },
    { event_name: 'x'.repeat(65) },
    { workflow_ref: 'x'.repeat(1025) },
    { exp: 253402297200 },
    { iat: -1 },
    { nbf: 1.5 },
  ])('refuses oversized or noncanonical claim values %j', async (patch) => {
    const fetch = fetcher();
    await expect(verify(await token({ ...claims, ...patch }), fetch)).rejects.toMatchObject({
      code: 'invalid_oidc_token',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { header: { alg: 'RS256', typ: 'JWT', kid: 'x'.repeat(257) } },
    { header: { alg: 'RS256', typ: 'JWT', kid: 'key', extra: 'x'.repeat(1024) } },
    { payload: { ...claims, extra: 'x'.repeat(6144) } },
  ])('caps JOSE header and payload segments before fetch', async ({ header, payload }) => {
    const fetch = fetcher();
    await expect(verify(await token(payload ?? claims, header), fetch)).rejects.toMatchObject({
      code: 'invalid_oidc_token',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts exact skew boundaries and optional environment, and rejects one second beyond', async () => {
    expect(
      await verify(
        await token({
          ...claims,
          iat: now + 60,
          nbf: now + 60,
          exp: now + 300,
          environment: 'release',
        }),
      ),
    ).toMatchObject({ environment: 'release' });
    expect(
      await verify(await token({ ...claims, iat: now - 300, nbf: now - 300, exp: now - 60 })),
    ).toMatchObject({ expiresAt: now - 60 });
    await expect(
      verify(await token({ ...claims, iat: now - 300, nbf: now - 300, exp: now - 61 })),
    ).rejects.toMatchObject({ code: 'invalid_oidc_token' });
  });
  it('refreshes an unknown kid to a rotated key exactly once', async () => {
    const fetch = fetcher();
    await verify(await token(), fetch);
    fetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'rotated' }] })).body,
    });
    expect(
      await verify(await token(claims, { alg: 'RS256', typ: 'JWT', kid: 'rotated' }), fetch),
    ).toMatchObject({ repositoryId: '123' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { keys: [] },
    { keys: [{ ...jwk, kty: 'EC' }] },
    { keys: [{ ...jwk, use: 'enc' }] },
    { keys: [{ ...jwk, kid: 'x'.repeat(257) }] },
    { keys: [{ ...jwk, n: b64(new Uint8Array(255).fill(255)) }] },
    { keys: [{ ...jwk, n: b64(new Uint8Array(1025).fill(255)) }] },
    { keys: [{ ...jwk, n: b64(new Uint8Array(256).fill(1)) }] },
    { keys: [{ ...jwk, d: 'private' }] },
    { keys: [{ ...jwk, n: 'invalid=' }] },
  ])('refuses unsafe JWKS key shapes', async (body) => {
    await expect(verify(await token(), fetcher(body))).rejects.toMatchObject({
      code: 'jwks_unavailable',
    });
  });
  it('accepts a JWKS of exactly 64 KiB and refuses one extra byte', async () => {
    const body = JSON.stringify({ keys: [jwk] });
    await expect(
      verify(await token(), fetcher(body + ' '.repeat(65536 - body.length))),
    ).resolves.toMatchObject({ jti: 'unique' });
    clearJwksCache();
    await expect(
      verify(await token(), fetcher(body + ' '.repeat(65537 - body.length))),
    ).rejects.toMatchObject({ code: 'jwks_unavailable' });
  });
  it('caps JWKS stream reads, including empty chunks', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ keys: [jwk] }));
    const fetch = fetcher();
    fetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 1023; i++) controller.enqueue(new Uint8Array());
          controller.enqueue(body);
          controller.close();
        },
      }),
    });
    await expect(verify(await token(), fetch)).rejects.toMatchObject({ code: 'jwks_unavailable' });
  });
  it('bounds the total JWKS request even if the transport ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<PolicyFetch>(() => new Promise(() => {}));
      const jwt = await token();
      const result = expect(verify(jwt, fetch)).rejects.toMatchObject({ code: 'jwks_unavailable' });
      await vi.advanceTimersByTimeAsync(5000);
      await result;
      expect(fetch.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { status: 302, body: null },
    { status: 200, body: null },
  ])('refuses status errors and absent bodies', async ({ status, body }) => {
    const fetch = fetcher();
    fetch.mockResolvedValue({ status, body, headers: new Headers() });
    await expect(verify(await token(), fetch)).rejects.toMatchObject({ code: 'jwks_unavailable' });
  });
});

describe('independent refusal guards', () => {
  it('enforces the total JWT cap independently of all segment caps', async () => {
    const jwt = await token(
      { ...claims, extra: 'x'.repeat(4900) },
      { alg: 'RS256', typ: 'JWT', kid: 'key', extra: 'x'.repeat(800) },
    );
    expect(jwt.length).toBeGreaterThan(8192);
    const fetch = fetcher();
    await expect(verify(jwt, fetch)).rejects.toMatchObject({ code: 'invalid_oidc_token' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('caps the payload independently of the total JWT cap', async () => {
    const jwt = await token({ ...claims, extra: 'x'.repeat(5300) });
    expect(jwt.length).toBeLessThanOrEqual(8192);
    const fetch = fetcher();
    await expect(verify(jwt, fetch)).rejects.toMatchObject({ code: 'invalid_oidc_token' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('caps the signature segment before fetching keys', async () => {
    const jwt = await token();
    const fetch = fetcher();
    await expect(
      verify(jwt.slice(0, jwt.lastIndexOf('.') + 1) + b64(new Uint8Array(1025)), fetch),
    ).rejects.toMatchObject({ code: 'invalid_oidc_token' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { iat: now - 9, nbf: now - 100, exp: now - 10 },
    { iat: now - 100, nbf: now - 9, exp: now - 10 },
  ])('refuses inconsistent time windows independently', async (patch) => {
    await expect(verify(await token({ ...claims, ...patch }))).rejects.toMatchObject({
      code: 'invalid_oidc_token',
    });
  });
});

it('caps distinct JWKS keys before import, independently of duplicate-kid refusal', async () => {
  const keys = [jwk, ...Array.from({ length: 20 }, (_, i) => ({ ...jwk, kid: `other-${i}` }))];
  await expect(verify(await token(), fetcher({ keys }))).rejects.toMatchObject({
    code: 'jwks_unavailable',
  });
});
it('caps retained JWKS bytes independently of JSON character and string limits', async () => {
  const body = JSON.stringify({ keys: [jwk], padding: Array(8).fill('é'.repeat(4096)) });
  expect(body.length).toBeLessThan(65536);
  expect(new TextEncoder().encode(body).length).toBeGreaterThan(65536);
  await expect(verify(await token(), fetcher(body))).rejects.toMatchObject({
    code: 'jwks_unavailable',
  });
});

it('refreshes cache after a clock rollback rather than extending cached key lifetime', async () => {
  const fetch = fetcher();
  const jwt = await token();
  await verify(jwt, fetch);
  await verify(jwt, fetch, now - 1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([null, [], 'text', false, 123])(
  'refuses non-object JOSE headers with a stable code',
  async (header) => {
    const fetch = fetcher();
    await expect(verify(await token(claims, header), fetch)).rejects.toMatchObject({
      name: 'OidcError',
      code: 'invalid_oidc_token',
      message: 'invalid_oidc_token',
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([null, [], 'text', false, 123])(
  'refuses non-object JWT claims with a stable code',
  async (payload) => {
    const fetch = fetcher();
    await expect(verify(await token(payload), fetch)).rejects.toMatchObject({
      name: 'OidcError',
      code: 'invalid_oidc_token',
      message: 'invalid_oidc_token',
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);
it('refuses a redirect status even when its body contains valid signing keys', async () => {
  const fetch = fetcher();
  fetch.mockResolvedValue({
    status: 302,
    headers: new Headers(),
    body: new Response(JSON.stringify({ keys: [jwk] })).body,
  });
  await expect(verify(await token(), fetch)).rejects.toMatchObject({ code: 'jwks_unavailable' });
});

it.each([
  `${'o'.repeat(40)}/repo/.github/workflows/publish.yml@refs/tags/v1`,
  `owner/${'r'.repeat(101)}/.github/workflows/publish.yml@refs/tags/v1`,
  `owner/repo/.github/workflows/${'w'.repeat(256)}@refs/tags/v1`,
  `o/r/.github/workflows/w@${'r'.repeat(768)}`,
])('caps each caller workflow-ref component independently', async (workflow_ref) => {
  const fetch = fetcher();
  await expect(verify(await token({ ...claims, workflow_ref }), fetch)).rejects.toMatchObject({
    code: 'invalid_oidc_token',
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('bounds JWKS body streaming after headers have arrived and cancels the reader', async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const fetch = fetcher();
    fetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({ pull: () => new Promise(() => {}), cancel }),
    });
    const jwt = await token();
    const result = expect(verify(jwt, fetch)).rejects.toMatchObject({ code: 'jwks_unavailable' });
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

describe('round 2 regressions', () => {
  it('suppresses serial unknown kids for sixty seconds after a missing-key refresh', async () => {
    const fetch = fetcher();
    await verify(await token(), fetch);
    const unknown = await token(claims, { alg: 'RS256', typ: 'JWT', kid: 'unknown' });
    const other = await token(claims, { alg: 'RS256', typ: 'JWT', kid: 'other' });
    await expect(verify(unknown, fetch)).rejects.toMatchObject({ code: 'invalid_oidc_token' });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(verify(other, fetch, now + 59)).rejects.toMatchObject({
      code: 'invalid_oidc_token',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await verify(await token(), fetch, now + 59);
    await expect(verify(other, fetch, now + 60)).rejects.toMatchObject({
      code: 'invalid_oidc_token',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([
    'CI Build.yml',
    '.publish.yml',
    'publish.yaml',
    '.yml',
    'a\x85.yml',
    'é'.repeat(125) + 'a.yml',
  ])('accepts workflow filename %s', async (name) => {
    expect(isWorkflowFilename(name)).toBe(true);
    expect(
      await verify(
        await token({ ...claims, workflow_ref: `owner/repo/.github/workflows/${name}@main` }),
      ),
    ).toMatchObject({ workflow: name });
  });
  it.each([
    '',
    '.',
    '..',
    'publish',
    'publish.YML',
    'dir/publish.yml',
    'publish@x.yml',
    'x'.repeat(252) + '.yml',
    'é'.repeat(126) + '.yml',
    ...Array.from({ length: 32 }, (_, i) => `a${String.fromCharCode(i)}.yml`),
    'a\x7f.yml',
    'a\ud800.yml',
  ])('refuses workflow filename %j', async (name) => {
    expect(isWorkflowFilename(name)).toBe(false);
    await expect(
      verify(await token({ ...claims, workflow_ref: `owner/repo/.github/workflows/${name}@main` })),
    ).rejects.toMatchObject({ code: 'invalid_oidc_token' });
  });
  it.each(['not a URL', 'https://', 'file:///registry'])(
    'validates publicUrl at verifier construction with a stable error',
    (url) => {
      expect(() => createOidcVerifier({ publicUrl: url, policyFetch: fetcher() })).toThrowError(
        expect.objectContaining({ code: 'invalid_oidc_config', message: 'invalid_oidc_config' }),
      );
    },
  );
  it.each([{}, [], { nested: ['value'] }, null, true, 42, 'value'])(
    'ignores non-projected JSON claim %j',
    async (extra) => {
      const result = await verify(await token({ ...claims, extra }));
      expect(result).not.toHaveProperty('extra');
    },
  );
  it.each(['aud', 'repository_id', 'workflow_ref', 'environment', 'exp'])(
    'keeps projected %s strict for object and array values',
    async (name) => {
      for (const value of [{}, []])
        await expect(verify(await token({ ...claims, [name]: value }))).rejects.toMatchObject({
          code: 'invalid_oidc_token',
        });
    },
  );
  it('ASCII folds environment without folding Unicode', async () => {
    expect(await verify(await token({ ...claims, environment: 'PrOD-Ä' }))).toMatchObject({
      environment: 'prod-Ä',
    });
  });
});

it('ignores unprojected structured claims independently', async () => {
  const result = await verify(await token({ ...claims, nested: { value: 'untrusted' } }));
  expect(result).not.toHaveProperty('nested');
});

it('captures the configured audience once at construction', async () => {
  const input = { publicUrl, policyFetch: fetcher() };
  const verifier = createOidcVerifier(input);
  input.publicUrl = 'malformed';
  expect(await verifier(await token(), now * 1000)).toMatchObject({ workflow: 'publish.yml' });
});

it('caps workflow filename before UTF-8 allocation', () => {
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  try {
    expect(isWorkflowFilename('x'.repeat(252) + '.yml')).toBe(false);
    expect(encode).not.toHaveBeenCalled();
  } finally {
    encode.mockRestore();
  }
});
