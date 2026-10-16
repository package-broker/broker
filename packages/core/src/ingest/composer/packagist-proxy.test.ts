import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../ids.js';
import { bindCredential, parseCredentialMaterial } from '../../sources/credentials.js';
import { createPolicyFetch, type UpstreamCredential } from '../../sources/policy-fetch.js';
import type {
  PackageDescription,
  ProviderContext,
  ProviderSource,
} from '../../sources/provider.js';
import { createOutboundPolicy } from '../../sources/url-policy.js';
import { codeloadUrl, describePackagist, packagistProxyProvider } from './packagist-proxy.js';

const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const NAME = 'acme/widget';
const REPO = 'https://repo.packagist.org';
const API = 'https://api.github.com';
const CODELOAD = 'https://codeload.github.com';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TOKEN = 'ghp_supersecrettoken123';
const NOW = '2026-10-17T10:00:00.000Z';

type Reply = { status: number; body?: string; headers?: Record<string, string> };

interface Call {
  readonly url: string;
  readonly auth: string | null;
}

function setup(routes: Record<string, Reply>): {
  calls: Call[];
  fetch: ReturnType<typeof createPolicyFetch>;
} {
  const calls: Call[] = [];
  const fetch = createPolicyFetch({
    policy,
    userAgent: 'pb-test/1 (ops@example.com)',
    fetchImpl: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      calls.push({ url, auth: headers.get('authorization') });
      const reply = routes[url];
      if (reply === undefined) return new Response('{}', { status: 404 });
      return new Response(reply.body ?? '', { status: reply.status, headers: reply.headers ?? {} });
    },
  });
  return { calls, fetch };
}

function token(origins: readonly string[] = [API, CODELOAD]): UpstreamCredential {
  return bindCredential(
    parseCredentialMaterial('bearer', JSON.stringify({ token: TOKEN })),
    origins,
  );
}

function ctx(
  fetch: ProviderContext['fetch'],
  credential: UpstreamCredential | null = null,
): ProviderContext {
  return {
    fetch,
    credential,
    clock: fixedClock(NOW),
    signal: new AbortController().signal,
    codecs: undefined as never,
    observability: undefined as never,
  };
}

function source(githubToken = true): ProviderSource {
  return {
    id: 'src-1',
    type: 'packagist_proxy',
    ecosystem: 'composer',
    url: REPO,
    providerId: 'packagist',
    config: { githubToken },
  };
}

const p2 = (version: string): string =>
  JSON.stringify({
    minified: 'composer/2.0',
    'security-advisories': [{ advisoryId: 'PKSA-1' }],
    packages: {
      [NAME]: [
        {
          name: NAME,
          version,
          notification_url: 'https://packagist.org/downloads/',
          filter: 'x',
          dist: { type: 'zip', url: `${API}/repos/acme/widget/zipball/${SHA}`, reference: SHA },
        },
      ],
    },
  });

async function drain(description: PackageDescription): Promise<string[]> {
  const out: string[] = [];
  for await (const member of description.members) out.push(member.raw);
  return out;
}

describe('packagist proxy describe', () => {
  it('requests only the p2 and ~dev documents on the fixed host, without credentials', async () => {
    const { calls, fetch } = setup({
      [`${REPO}/p2/${NAME}.json`]: { status: 200, body: p2('1.0.0'), headers: { etag: '"a"' } },
      [`${REPO}/p2/${NAME}~dev.json`]: {
        status: 200,
        body: p2('dev-main'),
        headers: { etag: '"b"' },
      },
    });
    const result = await packagistProxyProvider.describe(ctx(fetch, token()), source(), NAME, {});
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    const raws = await drain(result.description);
    expect(raws).toHaveLength(2);
    for (const raw of raws) {
      expect(raw).not.toMatch(/filter|notification|security-advisories|PKSA/);
    }
    expect(calls.map((call) => new URL(call.url).pathname).sort()).toEqual([
      `/p2/${NAME}.json`,
      `/p2/${NAME}~dev.json`,
    ]);
    expect(calls.every((call) => new URL(call.url).origin === REPO)).toBe(true);
    expect(calls.every((call) => call.auth === null)).toBe(true);
  });

  it('never follows a metadata redirect off the fixed host', async () => {
    const { calls, fetch } = setup({
      [`${REPO}/p2/${NAME}.json`]: {
        status: 302,
        headers: { location: `https://evil.example.com/p2/${NAME}.json` },
      },
    });
    await expect(
      packagistProxyProvider.describe(ctx(fetch), source(), NAME, {}),
    ).rejects.toMatchObject({ code: 'refused' });
    expect(calls.some((call) => call.url.startsWith('https://evil.example.com'))).toBe(false);
  });

  it('answers not_found for an invalid name without any request', async () => {
    const { calls, fetch } = setup({});
    const result = await packagistProxyProvider.describe(ctx(fetch), source(), '../etc', {});
    expect(result).toEqual({ kind: 'not_found', definitive: false });
    expect(calls).toEqual([]);
  });

  it('returns busy on the request path without sleeping on Retry-After', async () => {
    const { fetch } = setup({
      [`${REPO}/p2/${NAME}.json`]: { status: 429, headers: { 'retry-after': '5' } },
      [`${REPO}/p2/${NAME}~dev.json`]: { status: 429, headers: { 'retry-after': '5' } },
    });
    const result = await describePackagist(fetch, NAME, {
      path: 'request',
      clock: fixedClock(NOW),
      sleep: () => {
        throw new Error('slept on the request path');
      },
    });
    expect(result).toEqual({ kind: 'busy', retryAfterSeconds: 5 });
  });

  it('answers busy through the provider without sleeping, carrying Retry-After', async () => {
    const { calls, fetch } = setup({
      [`${REPO}/p2/${NAME}.json`]: { status: 429, headers: { 'retry-after': '7' } },
      [`${REPO}/p2/${NAME}~dev.json`]: { status: 429, headers: { 'retry-after': '7' } },
    });
    await expect(
      packagistProxyProvider.describe(ctx(fetch), source(), NAME, {}),
    ).rejects.toMatchObject({ code: 'http_status', status: 429, retryAfterSeconds: 7 });
    expect(calls).toHaveLength(2);
  });

  it('offers no complete listing', () => {
    expect(packagistProxyProvider.listPackages).toBeUndefined();
  });
});

describe('packagist proxy dist', () => {
  const zipball = `${API}/repos/acme/widget/zipball/${SHA}`;
  const legacy = `${CODELOAD}/acme/widget/legacy.zip/${SHA}`;
  const target = (url: string | null) => ({
    packageName: NAME,
    version: '1.0.0',
    url,
    distType: 'zip' as const,
    sourceRef: SHA,
  });

  it('rewrites api.github.com zipball URLs to codeload', () => {
    expect(codeloadUrl(zipball)).toBe(legacy);
    expect(codeloadUrl(`${API}/repos/acme/widget/tarball/${SHA}`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/acme/widget/zipball/${SHA}?x=1`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/../widget/zipball/${SHA}`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/acme/../zipball/${SHA}`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/acme/widget/zipball/..`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/acme/widget/zipball/.`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/acme/.github/zipball/${SHA}`)).toBe(
      `${CODELOAD}/acme/.github/legacy.zip/${SHA}`,
    );
    expect(codeloadUrl(`${API}/repos/acme/widget/zipball/refs/heads/main`)).toBe(
      `${CODELOAD}/acme/widget/legacy.zip/refs/heads/main`,
    );
    expect(codeloadUrl(`${API}/repos/acme/widget/zipball/release%20v1`)).toBe(
      `${CODELOAD}/acme/widget/legacy.zip/release%20v1`,
    );
    expect(codeloadUrl(`${API}/repos/acme/widget/zipball/refs/../main`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/acme/widget/zipball/refs/%2e%2e/main`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/acme/widget/zipball/refs/.../main`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/acme/widget/zipball/a%2Fb`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/acme/widget/zipball/refs//main`)).toBeNull();
    expect(codeloadUrl(`${API}/repos/.../widget/zipball/${SHA}`)).toBeNull();
    expect(codeloadUrl(`http://api.github.com/repos/acme/widget/zipball/${SHA}`)).toBeNull();
  });

  it('fetches a zipball from codeload with the GitHub token', async () => {
    const { calls, fetch } = setup({
      [legacy]: { status: 200, body: 'zip', headers: { 'content-length': '3' } },
    });
    const dist = await packagistProxyProvider.openDist(
      ctx(fetch, token()),
      source(),
      target(zipball),
    );
    expect(await new Response(dist.body).text()).toBe('zip');
    expect(dist.size).toBe(3);
    expect(calls).toEqual([{ url: legacy, auth: `Bearer ${TOKEN}` }]);
  });

  it('fetches other dist hosts without the token', async () => {
    const other = 'https://dl.example.com/acme/widget.zip';
    const { calls, fetch } = setup({ [other]: { status: 200, body: 'zip' } });
    await packagistProxyProvider.openDist(ctx(fetch, token()), source(), target(other));
    expect(calls).toEqual([{ url: other, auth: null }]);
  });

  it('keeps the token off a redirect away from the GitHub hosts', async () => {
    const { calls, fetch } = setup({
      [legacy]: { status: 302, headers: { location: 'https://evil.example.com/x.zip' } },
    });
    await expect(
      packagistProxyProvider.openDist(ctx(fetch, token()), source(), target(zipball)),
    ).rejects.toMatchObject({ code: 'refused' });
    expect(calls.filter((call) => call.auth !== null).map((call) => call.url)).toEqual([legacy]);
  });

  it('refuses a token bound to any host other than the GitHub hosts', async () => {
    const { calls, fetch } = setup({ [legacy]: { status: 200, body: 'zip' } });
    const wide = token([API, CODELOAD, 'https://dl.example.com']);
    await expect(
      packagistProxyProvider.openDist(ctx(fetch, wide), source(), target(zipball)),
    ).rejects.toMatchObject({ code: 'refused' });
    expect(calls).toEqual([]);
  });

  it('refuses a credential with no bound origins', async () => {
    const { calls, fetch } = setup({ [legacy]: { status: 200, body: 'zip' } });
    const empty: UpstreamCredential = { ...token(), origins: [] };
    await expect(
      packagistProxyProvider.openDist(ctx(fetch, empty), source(), target(zipball)),
    ).rejects.toMatchObject({ code: 'refused' });
    expect(calls).toEqual([]);
  });

  it('refuses a malformed dist URL', async () => {
    const { calls, fetch } = setup({});
    await expect(
      packagistProxyProvider.openDist(ctx(fetch), source(), target('not a url')),
    ).rejects.toMatchObject({ code: 'refused', reason: 'invalid_url' });
    expect(calls).toEqual([]);
  });

  it('sends no token when the source does not enable it', async () => {
    const { calls, fetch } = setup({ [legacy]: { status: 200, body: 'zip' } });
    await packagistProxyProvider.openDist(ctx(fetch, token()), source(false), target(zipball));
    expect(calls).toEqual([{ url: legacy, auth: null }]);
  });

  it('fails on a non-200 dist response and on a missing URL', async () => {
    const { fetch } = setup({ [legacy]: { status: 404 } });
    await expect(
      packagistProxyProvider.openDist(ctx(fetch), source(), target(zipball)),
    ).rejects.toMatchObject({ code: 'http_status', status: 404 });
    await expect(
      packagistProxyProvider.openDist(ctx(fetch), source(), target(null)),
    ).rejects.toMatchObject({ code: 'refused' });
  });
});
