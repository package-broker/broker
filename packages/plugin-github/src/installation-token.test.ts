import type { Observability } from '@package-broker/core/platform/observability';
import {
  GITHUB_API_VERSION,
  UpstreamError,
  createPolicyFetch,
} from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { describe, expect, it } from 'vitest';
import {
  InstallationTokenError,
  createInstallationTokens,
  parseRateLimit,
  type InstallationTokensOptions,
} from './installation-token.js';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

function inspect(value: unknown, ...rest: readonly unknown[]): string {
  void rest;
  const custom = (value as { [INSPECT]?: unknown } | null)?.[INSPECT];
  if (typeof custom === 'function') return String(custom.call(value));
  if (value instanceof Error) {
    const own = Object.getOwnPropertyNames(value).map((key) =>
      String((value as unknown as Record<string, unknown>)[key]),
    );
    return [value.name, value.message, value.stack ?? '', ...own].join('\n');
  }
  return `${String(value)} ${JSON.stringify(value) ?? ''}`;
}

const TOKEN = 'ghs_fakeInstallationTokenValue0123456789';
const OTHER = 'ghs_secondFakeInstallationToken987654321';
const MINT = 'https://api.github.com/app/installations/42/access_tokens';
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
const HOUR = 3600_000;

const pair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  },
  true,
  ['sign', 'verify'],
);
const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
let binary = '';
for (const byte of der) binary += String.fromCharCode(byte);
const PEM = `-----BEGIN PRIVATE KEY-----\n${(btoa(binary).match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

type Reply = (call: Call) => Response;

function repository(name: string, id: number): Record<string, unknown> {
  const base = `https://api.github.com/repos/acme/${name}`;
  const urls = Object.fromEntries(
    [
      'forks',
      'keys',
      'collaborators',
      'teams',
      'hooks',
      'issue_events',
      'events',
      'assignees',
      'branches',
      'tags',
      'blobs',
      'git_tags',
      'git_refs',
      'trees',
      'statuses',
      'languages',
      'stargazers',
      'contributors',
      'subscribers',
      'subscription',
      'commits',
      'git_commits',
      'comments',
      'issue_comment',
      'contents',
      'compare',
      'merges',
      'archive',
      'downloads',
      'issues',
      'pulls',
      'milestones',
      'notifications',
      'labels',
      'releases',
      'deployments',
    ].map((field) => [`${field}_url`, `${base}/${field}{/sha}`]),
  );
  return {
    id,
    node_id: `R_kgDO${id.toString(36).padStart(8, '0')}`,
    name,
    full_name: `acme/${name}`,
    private: true,
    owner: { login: 'acme', id: 1, type: 'Organization', url: 'https://api.github.com/users/acme' },
    html_url: `https://github.com/acme/${name}`,
    description: 'An internal package repository used for registry tests',
    url: base,
    ...urls,
    default_branch: 'main',
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
  };
}

function tokenReply(
  token: string,
  expiresAt: number,
  override: Record<string, unknown> = {},
  status = 201,
): Reply {
  return (call) => {
    const requested = bodyOf(call) as { repositories?: string[]; permissions: object };
    const body: Record<string, unknown> = {
      token,
      expires_at: new Date(expiresAt).toISOString().replace('.000', ''),
      permissions: requested.permissions,
      repository_selection: requested.repositories === undefined ? 'all' : 'selected',
      ...(requested.repositories === undefined
        ? {}
        : { repositories: requested.repositories.map((name, i) => repository(name, i + 1)) }),
      ...override,
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function bodyOf(call: Call): unknown {
  return JSON.parse(new TextDecoder().decode(call.body as Uint8Array));
}

function setup(replies: Reply[], extra: Partial<InstallationTokensOptions> = {}) {
  const calls: Call[] = [];
  const seen: unknown[] = [];
  let clock = T0;
  const observability: Observability = {
    log: (record) => seen.push(record),
    counter: (name, labels, value) => seen.push({ name, labels, value }),
    histogram: (name, value, labels) => seen.push({ name, value, labels }),
  };
  const fetch = createPolicyFetch({
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      const next = replies.shift();
      if (next === undefined) throw new Error('unexpected request');
      return next(calls[calls.length - 1]!);
    },
    policy: createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
    userAgent: 'package-broker-test',
    observability,
  });
  const tokens = createInstallationTokens({
    app: { appId: '123456', privateKeyPem: PEM },
    fetch,
    now: () => clock,
    ...extra,
  });
  return {
    calls,
    seen,
    tokens,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('createInstallationTokens', () => {
  it('narrows by sorted repository ids and isolates name and id caches', async () => {
    const { calls, tokens } = setup([
      tokenReply(TOKEN, T0 + HOUR, {
        repositories: [repository('renamed', 8), repository('other', 2)],
      }),
      tokenReply(OTHER, T0 + HOUR),
    ]);
    const token = await tokens.forRepositoryIds('42', [8, 2, 8]);
    expect(token.repositoryIds).toEqual([2, 8]);
    expect(token.repositories).toEqual([]);
    expect(bodyOf(calls[0]!)).toEqual({
      repository_ids: [2, 8],
      permissions: { contents: 'read', metadata: 'read' },
    });
    expect(await tokens.forRepositoryIds('42', [2, 8])).toBe(token);
    await tokens.forRepositories('42', ['2', '8']);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(token)).not.toContain(TOKEN);
    expect(inspect(token, { showHidden: true })).not.toContain(TOKEN);
  });

  it.each<Record<string, unknown>>([
    { permissions: { metadata: 'read' } },
    { permissions: { contents: 'read' } },
    { permissions: {} },
    { permissions: { contents: 'write', metadata: 'read' } },
    { permissions: { contents: 'read', metadata: 'read', issues: 'read' } },
    { permissions: { contents: 'read', metadata: 'read', toString: 'read' } },
    { repositories: [repository('same-name', 9)] },
    { repositories: [repository('same-name', 8), repository('extra', 9)] },
    { repositories: [{ name: 'same-name' }] },
  ])('refuses unusable id grants and retries without caching %#', async (override) => {
    const { calls, tokens } = setup([
      tokenReply(TOKEN, T0 + HOUR, { repositories: [repository('same-name', 8)], ...override }),
      tokenReply(OTHER, T0 + HOUR, { repositories: [repository('renamed', 8)] }),
    ]);
    await expect(tokens.forRepositoryIds('42', [8])).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect((await tokens.forRepositoryIds('42', [8])).value).toBe(OTHER);
    expect(calls).toHaveLength(2);
  });

  it.each([
    { ids: [] },
    { ids: [0] },
    { ids: [-1] },
    { ids: [1.5] },
    { ids: [Number.MAX_SAFE_INTEGER + 1] },
    { ids: Array.from({ length: 501 }, (_, i) => i + 1) },
  ])('rejects invalid repository ids before sending %#', async ({ ids }) => {
    const { calls, tokens } = setup([]);
    await expect(tokens.forRepositoryIds('42', ids)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(calls).toHaveLength(0);
  });

  it('requests exactly the sorted, deduplicated repositories with read permissions', async () => {
    const { calls, tokens } = setup([tokenReply(TOKEN, T0 + HOUR)]);
    const token = await tokens.forRepositories('42', ['zeta', 'alpha', 'zeta']);
    expect(token.value).toBe(TOKEN);
    expect(token.expiresAt).toBe(T0 + HOUR);
    expect(token.repositories).toEqual(['alpha', 'zeta']);
    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expect(call.url).toBe(MINT);
    expect(call.method).toBe('POST');
    expect(call.headers.get('accept')).toBe('application/vnd.github+json');
    expect(call.headers.get('x-github-api-version')).toBe(GITHUB_API_VERSION);
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.headers.get('authorization')).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(bodyOf(call)).toEqual({
      repositories: ['alpha', 'zeta'],
      permissions: { contents: 'read', metadata: 'read' },
    });
  });

  it('mints a listing token with metadata read only and no repository narrowing', async () => {
    const { calls, tokens } = setup([tokenReply(TOKEN, T0 + HOUR)]);
    const token = await tokens.forListing('42');
    expect(token.repositories).toBeNull();
    expect(bodyOf(calls[0]!)).toEqual({ permissions: { metadata: 'read' } });
  });

  it('reuses a cached token until ten minutes before expiry, then re-mints', async () => {
    const { calls, tokens, advance } = setup([
      tokenReply(TOKEN, T0 + HOUR),
      tokenReply(OTHER, T0 + 2 * HOUR),
    ]);
    expect((await tokens.forRepositories('42', ['b', 'a'])).value).toBe(TOKEN);
    advance(HOUR - 600_000 - 1);
    expect((await tokens.forRepositories('42', ['a', 'b'])).value).toBe(TOKEN);
    expect(calls).toHaveLength(1);
    advance(1);
    expect((await tokens.forRepositories('42', ['a', 'b'])).value).toBe(OTHER);
    expect(calls).toHaveLength(2);
  });

  it('keys the cache by installation and repository set', async () => {
    const { calls, tokens } = setup([
      tokenReply(TOKEN, T0 + HOUR),
      tokenReply(OTHER, T0 + HOUR),
      tokenReply(OTHER, T0 + HOUR),
      tokenReply(OTHER, T0 + HOUR),
    ]);
    await tokens.forRepositories('42', ['a']);
    expect((await tokens.forRepositories('42', ['a', 'b'])).value).toBe(OTHER);
    await tokens.forListing('42');
    await tokens.forRepositories('43', ['a']);
    expect(calls.map((call) => call.url)).toEqual([
      MINT,
      MINT,
      MINT,
      'https://api.github.com/app/installations/43/access_tokens',
    ]);
  });

  it('shares one in-flight mint between concurrent callers and drops failures', async () => {
    const { calls, tokens } = setup([
      () => new Response('{}', { status: 500 }),
      tokenReply(TOKEN, T0 + HOUR),
    ]);
    const results = await Promise.allSettled([
      tokens.forRepositories('42', ['a']),
      tokens.forRepositories('42', ['a']),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect((await tokens.forRepositories('42', ['a'])).value).toBe(TOKEN);
    expect(calls).toHaveLength(2);
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [422, 'unprocessable'],
    [500, 'upstream_status'],
  ] as const)('maps %i to a typed error without echoing the body', async (status, code) => {
    const { tokens } = setup([
      () =>
        new Response(JSON.stringify({ message: `bad ${TOKEN}` }), {
          status,
          headers: {
            'x-ratelimit-limit': '7750',
            'x-ratelimit-remaining': '5',
            'x-ratelimit-reset': '1792152000',
          },
        }),
    ]);
    const error = await tokens.forRepositories('42', ['a']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallationTokenError);
    expect((error as InstallationTokenError).code).toBe(code);
    expect((error as InstallationTokenError).status).toBe(status);
    expect((error as InstallationTokenError).rateLimit).toEqual({
      limit: 7750,
      remaining: 5,
      reset: 1792152000,
    });
    expect(inspect(error)).not.toContain(TOKEN);
  });

  it.each([
    ['not json', 'not json'],
    ['missing token', JSON.stringify({ expires_at: '2026-10-16T13:00:00Z' })],
    ['bad expiry', JSON.stringify({ token: TOKEN, expires_at: 'soon' })],
    ['already expired', JSON.stringify({ token: TOKEN, expires_at: '2026-10-16T11:00:00Z' })],
    [
      'token with spaces',
      JSON.stringify({ token: 'ghs_ bad', expires_at: '2026-10-16T13:00:00Z' }),
    ],
  ])('refuses an invalid response (%s) without leaking the body', async (_name, body) => {
    const { tokens } = setup([() => new Response(body, { status: 201 })]);
    const error = await tokens.forRepositories('42', ['a']).catch((e: unknown) => e);
    expect((error as InstallationTokenError).code).toBe('invalid_response');
    expect(inspect(error)).not.toContain(TOKEN);
  });

  it.each([
    ['empty repository list', '42', []],
    ['bad repository name', '42', ['a/b']],
    ['dot repository name', '42', ['..']],
    ['non-numeric installation', 'abc', ['a']],
    ['installation with path', '42/../1', ['a']],
  ])('rejects %s before any request', async (_name, installation, repositories) => {
    const { calls, tokens } = setup([]);
    const error = await tokens.forRepositories(installation, repositories).catch((e: unknown) => e);
    expect((error as InstallationTokenError).code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('rejects more than 500 repositories in one batch', async () => {
    const { calls, tokens } = setup([]);
    const names = Array.from({ length: 501 }, (_, i) => `r${i}`);
    const error = await tokens.forRepositories('42', names).catch((e: unknown) => e);
    expect((error as InstallationTokenError).code).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });

  it('never exposes the token through serialisation, inspection or observability', async () => {
    const { seen, tokens } = setup([tokenReply(TOKEN, T0 + HOUR)]);
    const token = await tokens.forRepositories('42', ['a']);
    expect(JSON.stringify(token)).not.toContain(TOKEN);
    expect(String(token)).not.toContain(TOKEN);
    expect(inspect(token, { showHidden: true })).not.toContain(TOKEN);
    expect(Object.keys(token)).not.toContain('value');
    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect(JSON.stringify(seen)).not.toMatch(/eyJ/);
  });

  it('signs the mint request with an app JWT valid for nine minutes', async () => {
    const { calls, tokens } = setup([tokenReply(TOKEN, T0 + HOUR)]);
    await tokens.forRepositories('42', ['a']);
    const jwt = calls[0]!.headers.get('authorization')!.slice('Bearer '.length);
    const [header, payload, signature] = jwt.split('.') as [string, string, string];
    const decode = (part: string) =>
      Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(decode(payload)))).toEqual({
      iss: '123456',
      iat: T0 / 1000 - 60,
      exp: T0 / 1000 + 540,
    });
    expect(
      await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        pair.publicKey,
        decode(signature),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  });

  it('accepts a 200 response', async () => {
    const { tokens } = setup([tokenReply(TOKEN, T0 + HOUR, {}, 200)]);
    expect((await tokens.forRepositories('42', ['a'])).value).toBe(TOKEN);
  });

  it('reads a realistic 500-repository response above 64 KiB', async () => {
    const names = Array.from({ length: 500 }, (_, i) => `package-repository-${i}`);
    let size = 0;
    const reply = tokenReply(TOKEN, T0 + HOUR);
    const { tokens } = setup([
      (call) => {
        const response = reply(call);
        void response
          .clone()
          .text()
          .then((text) => (size = text.length));
        return response;
      },
    ]);
    const token = await tokens.forRepositories('42', names);
    expect(token.repositories).toHaveLength(500);
    expect(size).toBeGreaterThan(1024 * 1024);
  });

  it('propagates a too_large transport error for a body over the cap', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const { tokens } = setup([
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < 9; i++) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 201 },
        ),
    ]);
    const error = await tokens.forRepositories('42', ['a']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).code).toBe('too_large');
  });

  it('propagates a network error raised mid-body', async () => {
    const { tokens } = setup([
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`{"token":"${TOKEN}"`));
              controller.error(new Error(`reset ${TOKEN}`));
            },
          }),
          { status: 201 },
        ),
    ]);
    const error = await tokens.forRepositories('42', ['a']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).code).toBe('network');
    expect(inspect(error)).not.toContain(TOKEN);
  });

  it('caps the cached lifetime at one hour from receipt', async () => {
    const { tokens } = setup([tokenReply(TOKEN, T0 + 5 * HOUR)]);
    expect((await tokens.forRepositories('42', ['a'])).expiresAt).toBe(T0 + HOUR);
  });

  it('refuses a token that is already within ten minutes of expiry', async () => {
    const { calls, tokens } = setup([
      tokenReply(TOKEN, T0 + 600_000),
      tokenReply(OTHER, T0 + HOUR),
    ]);
    const error = await tokens.forRepositories('42', ['a']).catch((e: unknown) => e);
    expect((error as InstallationTokenError).code).toBe('invalid_response');
    expect((await tokens.forRepositories('42', ['a'])).value).toBe(OTHER);
    expect(calls).toHaveLength(2);
  });

  it.each([
    [429, { 'retry-after': '30' }, 30],
    [403, { 'retry-after': '45' }, 45],
    [
      403,
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '7750', 'x-ratelimit-reset': '9' },
      undefined,
    ],
    [429, {}, undefined],
  ])('maps %i with %j to rate_limited', async (status, headers, retryAfter) => {
    const { tokens } = setup([() => new Response('{}', { status, headers })]);
    const error = await tokens.forRepositories('42', ['a']).catch((e: unknown) => e);
    expect((error as InstallationTokenError).code).toBe('rate_limited');
    expect((error as InstallationTokenError).retryAfter).toBe(retryAfter);
  });

  it('deduplicates and keys repositories case-insensitively', async () => {
    const { calls, tokens } = setup([tokenReply(TOKEN, T0 + HOUR)]);
    const token = await tokens.forRepositories('42', ['Beta', 'alpha', 'ALPHA']);
    expect(token.repositories).toEqual(['alpha', 'beta']);
    expect((bodyOf(calls[0]!) as { repositories: string[] }).repositories).toEqual([
      'alpha',
      'beta',
    ]);
    expect((await tokens.forRepositories('42', ['BETA', 'Alpha'])).value).toBe(TOKEN);
    expect(calls).toHaveLength(1);
  });

  it('accepts returned repository names that differ only in case', async () => {
    const { tokens } = setup([
      tokenReply(TOKEN, T0 + HOUR, { repositories: [repository('Alpha', 1)] }),
    ]);
    expect((await tokens.forRepositories('42', ['alpha'])).value).toBe(TOKEN);
  });

  it.each([
    ['extra permission', { permissions: { contents: 'read', metadata: 'read', issues: 'read' } }],
    ['write permission', { permissions: { contents: 'write', metadata: 'read' } }],
    ['missing permissions', { permissions: undefined }],
    ['missing contents permission', { permissions: { metadata: 'read' } }],
    ['empty permissions', { permissions: {} }],
    ['missing repository', { repositories: [repository('a', 1)] }],
    ['extra repository', { repositories: ['a', 'b', 'c'].map((n, i) => repository(n, i)) }],
    ['missing repositories', { repositories: undefined }],
  ])('refuses a broader or mismatched grant (%s) and caches nothing', async (_name, override) => {
    const { calls, tokens } = setup([
      tokenReply(TOKEN, T0 + HOUR, override),
      tokenReply(OTHER, T0 + HOUR),
    ]);
    const error = await tokens.forRepositories('42', ['a', 'b']).catch((e: unknown) => e);
    expect((error as InstallationTokenError).code).toBe('invalid_response');
    expect((await tokens.forRepositories('42', ['a', 'b'])).value).toBe(OTHER);
    expect(calls).toHaveLength(2);
  });

  it('refuses a listing token granted more than metadata read', async () => {
    const { tokens } = setup([
      tokenReply(TOKEN, T0 + HOUR, { permissions: { metadata: 'read', contents: 'read' } }),
    ]);
    const error = await tokens.forListing('42').catch((e: unknown) => e);
    expect((error as InstallationTokenError).code).toBe('invalid_response');
  });

  it('mints concurrently for different keys', async () => {
    const byRepository: Reply = (call) => {
      const [name] = (bodyOf(call) as { repositories: string[] }).repositories;
      return tokenReply(name === 'a' ? TOKEN : OTHER, T0 + HOUR)(call);
    };
    const { calls, tokens } = setup([byRepository, byRepository]);
    const [first, second] = await Promise.all([
      tokens.forRepositories('42', ['a']),
      tokens.forRepositories('42', ['b']),
    ]);
    expect([first.value, second.value]).toEqual([TOKEN, OTHER]);
    expect(calls).toHaveLength(2);
  });

  it('normalises the API origin and refuses one with a path', async () => {
    const { calls, tokens } = setup([tokenReply(TOKEN, T0 + HOUR)], {
      apiOrigin: 'https://ghe.example.com/',
    });
    await tokens.forListing('42');
    expect(calls[0]!.url).toBe('https://ghe.example.com/app/installations/42/access_tokens');
    for (const apiOrigin of [
      'https://ghe.example.com/api/v3',
      'https://ghe.example.com/?a=1',
      'nope',
    ]) {
      expect(() => setup([], { apiOrigin })).toThrow(InstallationTokenError);
    }
  });

  it('validates the installation id on observe and caps the rate-limit map', () => {
    const { tokens } = setup([]);
    const headers = new Headers({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '1',
      'x-ratelimit-reset': '1',
    });
    expect(() => tokens.observe('../1', headers)).toThrow(InstallationTokenError);
    for (let id = 1; id <= 1025; id++) tokens.observe(String(id), headers);
    expect(tokens.rateLimit('1')).toBeUndefined();
    expect(tokens.rateLimit('1025')).toBeDefined();
  });

  it.each([
    ['a successful mint', {}],
    ['a refused 2xx mint', { permissions: { contents: 'write', metadata: 'read' } }],
  ])('records rate-limit headers from %s', async (_name, override) => {
    const limited: Reply = (call) => {
      const response = tokenReply(TOKEN, T0 + HOUR, override)(call);
      const headers = new Headers(response.headers);
      headers.set('x-ratelimit-limit', '7750');
      headers.set('x-ratelimit-remaining', '7749');
      headers.set('x-ratelimit-reset', '1792152000');
      return new Response(response.body, { status: response.status, headers });
    };
    const { tokens } = setup([limited]);
    await tokens.forRepositories('42', ['a']).catch(() => undefined);
    expect(tokens.rateLimit('42')).toEqual({ limit: 7750, remaining: 7749, reset: 1792152000 });
    expect(tokens.rateLimit('43')).toBeUndefined();
  });

  it('retains retry-after independently of rate-limit counters and installation', async () => {
    const { tokens } = setup([]);
    tokens.observe('42', new Headers({ 'retry-after': '37' }));
    tokens.observe('42', new Headers({ 'retry-after': 'invalid' }));
    tokens.observe('42', new Headers());
    expect(tokens.retryAfterSeconds('42')).toBe(37);
    expect(tokens.retryAfterSeconds('43')).toBeUndefined();
    expect(tokens.rateLimit('42')).toBeUndefined();
  });

  it('retains retry-after from a rate-limited mint', async () => {
    const { tokens } = setup([
      () => new Response(null, { status: 429, headers: { 'retry-after': '19' } }),
    ]);
    await expect(tokens.forRepositoryIds('42', [7])).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfter: 19,
    });
    expect(tokens.retryAfterSeconds('42')).toBe(19);
  });

  it('records the rate limit observed on API responses per installation', async () => {
    const { tokens } = setup([]);
    expect(tokens.rateLimit('42')).toBeUndefined();
    tokens.observe(
      '42',
      new Headers({
        'x-ratelimit-limit': '7750',
        'x-ratelimit-remaining': '7700',
        'x-ratelimit-reset': '1792152000',
      }),
    );
    tokens.observe('42', new Headers());
    expect(tokens.rateLimit('42')).toEqual({ limit: 7750, remaining: 7700, reset: 1792152000 });
    expect(tokens.rateLimit('43')).toBeUndefined();
  });
});

describe('parseRateLimit', () => {
  it('reads the limit from headers rather than assuming 5000', () => {
    expect(
      parseRateLimit(
        new Headers({
          'x-ratelimit-limit': '7750',
          'x-ratelimit-remaining': '12',
          'x-ratelimit-reset': '1792152000',
        }),
      ),
    ).toEqual({ limit: 7750, remaining: 12, reset: 1792152000 });
  });

  it.each([
    [{}],
    [{ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '1' }],
    [{ 'x-ratelimit-limit': 'x', 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '1' }],
    [{ 'x-ratelimit-limit': '-1', 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '1' }],
  ])('returns undefined for missing or malformed headers %#', (headers) => {
    expect(parseRateLimit(new Headers(headers))).toBeUndefined();
  });
});
