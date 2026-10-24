import { describe, expect, it } from 'vitest';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { bindCredential, parseCredentialMaterial } from '@package-broker/core/sources/credentials';
import { createPolicyFetch } from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import type { ProviderContext, ProviderSource } from '@package-broker/core/plugin';
import github from './index.js';

const token = 'ghp_private-token-sentinel';
const sha = 'a'.repeat(40);
const source: ProviderSource = {
  id: 'token-source',
  type: 'vcs',
  ecosystem: 'composer',
  url: null,
  config: {
    provider: 'github',
    repository: 'owner/repo',
    refs: { tags: true, branches: ['main'] },
  },
};
function setup(status = 200, echo: string | null = null) {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetch = createPolicyFetch({
    policy: createOutboundPolicy({ runtime: 'cloudflare', selfOrigins: [], allowPrivateHosts: [] }),
    userAgent: 'test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url: url.href, authorization: new Headers(init?.headers).get('authorization') });
      if (url.hostname === 'codeload.github.com') return new Response('zip');
      if (status !== 200) return new Response(token, { status });
      if (url.pathname.includes('/zipball/'))
        return new Response(null, {
          status: 302,
          headers: { location: 'https://codeload.github.com/owner/repo/zip/ref?token=x' },
        });
      if (url.pathname.endsWith('/tags'))
        return Response.json([{ name: 'v1.0.0', commit: { sha } }]);
      if (url.pathname.endsWith('/branches/main'))
        return Response.json({ name: 'main', commit: { sha } });
      if (url.pathname === '/graphql') {
        const { query } = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
          query: string;
        };
        return Response.json({
          data: {
            repository: {
              ...Object.fromEntries(
                [...query.matchAll(/(a[0-9]+): object/g)].map((match) => [
                  match[1],
                  {
                    byteSize: 64,
                    ...(query.includes('byteSize text')
                      ? { text: JSON.stringify({ name: echo ?? 'vendor/package' }) }
                      : {}),
                  },
                ]),
              ),
            },
          },
        });
      }
      if (url.pathname.includes('/contents/'))
        return Response.json({ name: echo ?? 'vendor/package' });
      return Response.json({ archived: false, full_name: 'owner/repo', default_branch: 'main' });
    },
  });
  const provider = collectRegistrations([github()]).sourceProviders.get('github')!;
  const ctx = {
    fetch,
    credential: bindCredential(parseCredentialMaterial('bearer', JSON.stringify({ token })), [
      'https://api.github.com',
    ]),
    signal: new AbortController().signal,
    clock: { now: () => new Date() },
  } as ProviderContext;
  return { provider, ctx, calls };
}
describe('GitHub token REST provider', () => {
  it('discovers a package, reads tags and configured branches and opens a redirected dist on Workers', async () => {
    const { provider, ctx, calls } = setup();
    expect((await provider.listPackages!(ctx, source, null)).names).toEqual(['vendor/package']);
    const result = await provider.describe(ctx, source, 'vendor/package', {});
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('missing description');
    const versions = [];
    for await (const member of result.description.members) versions.push(member.version);
    expect(versions).toEqual(['v1.0.0', 'dev-main']);
    expect(result.description.upstreamComplete).toBe(true);
    const dist = await provider.openDist(ctx, source, {
      packageName: 'vendor/package',
      version: '1.0.0',
      distType: 'zip',
      sourceRef: sha,
      url: null,
    });
    expect(await new Response(dist.body).text()).toBe('zip');
    expect(calls.find((call) => new URL(call.url).hostname === 'codeload.github.com')).toEqual({
      url: 'https://codeload.github.com/owner/repo/zip/ref?token=x',
      authorization: null,
    });
    expect(
      calls.every((call) =>
        new URL(call.url).hostname === 'api.github.com'
          ? call.authorization === `Bearer ${token}`
          : call.authorization === null,
      ),
    ).toBe(true);
    expect(calls.some((call) => call.url.includes('github.com/owner/repo.git'))).toBe(false);
    expect(calls.filter((call) => new URL(call.url).pathname === '/graphql')).toHaveLength(2);
    expect(calls.some((call) => call.url.endsWith('/branches/main'))).toBe(true);
    expect(calls.some((call) => new URL(call.url).pathname.endsWith('/branches'))).toBe(false);
  });
  it.each([401, 403])(
    'rejects authentication status %s without upstream response data',
    async (status) => {
      const { provider, ctx } = setup(status);
      await expect(provider.listPackages!(ctx, source, null)).rejects.toMatchObject({
        code: 'http_status',
        status,
        name: 'UpstreamError',
        message: 'upstream http_status',
      });
    },
  );
  it.each([`vendor/${token}`, `vendor/${encodeURIComponent(token).replace('ghp', '%67hp')}`])(
    'refuses a manifest echoing a token in the package name (%#)',
    async (name) => {
      const { provider, ctx } = setup(200, name);
      await expect(provider.listPackages!(ctx, source, null)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    },
  );
  it('uses packageName without reading the default-branch manifest', async () => {
    const { provider, ctx, calls } = setup();
    const configured = {
      ...source,
      config: { ...source.config, packageName: 'vendor/configured' },
    } as ProviderSource;
    expect((await provider.listPackages!(ctx, configured, null)).names).toEqual([
      'vendor/configured',
    ]);
    expect(calls).toEqual([
      { url: 'https://api.github.com/repos/owner/repo', authorization: `Bearer ${token}` },
    ]);
  });
  it('reports missing or unreadable token credentials as unauthorized', async () => {
    const { provider, ctx, calls } = setup();
    await expect(
      provider.describe({ ...ctx, credential: null }, source, 'vendor/package', {}),
    ).rejects.toMatchObject({ name: 'UpstreamError', code: 'http_status', status: 401 });
    await expect(
      provider.listPackages!({ ...ctx, credential: null }, source, null),
    ).rejects.toMatchObject({ name: 'UpstreamError', code: 'http_status', status: 401 });
    expect(calls).toEqual([]);
  });
  it('maps malformed token discovery to DiscoveryError', async () => {
    const { provider, ctx } = setup(200, 'invalid');
    await expect(provider.listPackages!(ctx, source, null)).rejects.toMatchObject({
      name: 'DiscoveryError',
      code: 'invalid_response',
    });
  });
  it('keeps a malformed historical manifest local to its ref', async () => {
    const { provider, ctx: original } = setup();
    const fetch = original.fetch;
    const ctx: ProviderContext = {
      ...original,
      fetch: async (request) =>
        request.url.endsWith('/graphql')
          ? {
              status: 200,
              headers: new Headers(),
              body: Response.json({
                data: {
                  repository: {
                    a0: { byteSize: 64, text: '{invalid' },
                    a1: { byteSize: 64, text: JSON.stringify({ name: 'vendor/package' }) },
                  },
                },
              }).body,
            }
          : fetch(request),
    };
    const result = await provider.describe(ctx, source, 'vendor/package', {});
    if (result.kind !== 'found') throw new Error('missing description');
    const versions = [];
    for await (const member of result.description.members) versions.push(member.version);
    expect(versions).toEqual(['dev-main']);
    expect(result.description.upstreamComplete).toBe(false);
  });
  it('describes 250 tags with bounded size and text batches', async () => {
    const { provider, ctx: original } = setup();
    const calls: string[] = [];
    const ctx: ProviderContext = {
      ...original,
      fetch: async (request) => {
        calls.push(request.url);
        const url = new URL(request.url);
        let value: unknown;
        if (url.pathname.endsWith('/tags')) {
          const page = Number(url.searchParams.get('page'));
          value = Array.from({ length: page < 3 ? 100 : 50 }, (_, index) => ({
            name: `v1.0.${(page - 1) * 100 + index}`,
            commit: { sha: ((page - 1) * 100 + index).toString(16).padStart(40, '0') },
          }));
        } else if (url.pathname === '/graphql') {
          const { query } = JSON.parse(new TextDecoder().decode(request.body)) as { query: string };
          value = {
            data: {
              repository: Object.fromEntries(
                [...query.matchAll(/(a[0-9]+): object/g)].map((match) => [
                  match[1],
                  { byteSize: 64, text: JSON.stringify({ name: 'vendor/package' }) },
                ]),
              ),
            },
          };
        } else value = { archived: false, full_name: 'owner/repo', default_branch: 'main' };
        return { status: 200, headers: new Headers(), body: Response.json(value).body };
      },
    };
    const tagsOnly = {
      ...source,
      config: { ...source.config, refs: { tags: true, branches: [] } },
    } as ProviderSource;
    const result = await provider.describe(ctx, tagsOnly, 'vendor/package', {});
    if (result.kind !== 'found') throw new Error('missing description');
    const members = [];
    for await (const member of result.description.members) members.push(member);
    expect(members).toHaveLength(250);
    expect(result.description.upstreamComplete).toBe(true);
    expect(calls).toHaveLength(10);
    expect(calls.filter((url) => url.endsWith('/graphql'))).toHaveLength(6);
  });
  it('does not treat a configured wildcard as all branches', async () => {
    const { provider, ctx, calls } = setup();
    const wildcard = {
      ...source,
      config: { ...source.config, refs: { tags: true, branches: ['*'] } },
    } as ProviderSource;
    const result = await provider.describe(ctx, wildcard, 'vendor/package', {});
    if (result.kind !== 'found') throw new Error('missing description');
    const versions = [];
    for await (const member of result.description.members) versions.push(member.version);
    expect(versions).toEqual(['v1.0.0']);
    expect(calls.some((call) => call.url.includes('/branches'))).toBe(false);
  });
  it('probes authentication even with a configured package name', async () => {
    const { provider, ctx, calls } = setup(401);
    await expect(
      provider.listPackages!(
        ctx,
        {
          ...source,
          config: { ...source.config, packageName: 'vendor/configured' },
        } as ProviderSource,
        null,
      ),
    ).rejects.toMatchObject({ name: 'UpstreamError', status: 401 });
    expect(calls.map((call) => call.url)).toEqual(['https://api.github.com/repos/owner/repo']);
  });
  it('classifies listing rate limits as upstream 429 for sync status', async () => {
    const { provider, ctx } = setup(429);
    await expect(provider.listPackages!(ctx, source, null)).rejects.toMatchObject({
      name: 'UpstreamError',
      code: 'http_status',
      status: 429,
    });
  });
  it('bounds branch lookups to four concurrent requests', async () => {
    const { provider, ctx: original } = setup();
    let active = 0;
    let peak = 0;
    const ctx: ProviderContext = {
      ...original,
      fetch: async (request) => {
        if (!request.url.includes('/branches/')) return original.fetch(request);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return {
          status: 200,
          headers: new Headers(),
          body: Response.json({
            name: decodeURIComponent(request.url.split('/branches/')[1]!),
            commit: { sha },
          }).body,
        };
      },
    };
    const result = await provider.describe(
      ctx,
      {
        ...source,
        config: {
          ...source.config,
          refs: {
            tags: false,
            branches: Array.from({ length: 12 }, (_, index) => `branch-${index}`),
          },
        },
      } as ProviderSource,
      'vendor/package',
      {},
    );
    expect(result.kind).toBe('found');
    expect(peak).toBe(4);
  });
});
