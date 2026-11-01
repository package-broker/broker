import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { createConfiguredGithubDiscovery } from './configured-discovery.js';

describe('configured organization discovery', () => {
  it.each([
    { projectId: 'project', kind: 'github_app' },
    { projectId: null, kind: 'bearer' },
    null,
  ])('refuses a credential outside discovery scope before decrypting: %s', async (row) => {
    const read = vi.fn();
    const service = createConfiguredGithubDiscovery({
      credentials: { get: vi.fn().mockResolvedValue(row) },
      store: { read },
      sources: {} as never,
      existingRepository: {} as never,
      fetch: vi.fn(),
      clock: { now: () => new Date() },
    });
    expect(
      await service.dryRun(
        orgContext('own'),
        {
          kind: 'organization',
          userId: 'U',
          isOrganizationAdmin: false,
          permissions: new Set(['org:sources:write']),
        },
        { credentialId: 'C', installationId: 42, pattern: '*', cursor: null },
      ),
    ).toEqual({ ok: false, error: 'credential_not_found' });
    expect(read).not.toHaveBeenCalled();
  });
  it('denies a caller without source write authority before reading credentials', async () => {
    const get = vi.fn();
    const service = createConfiguredGithubDiscovery({
      credentials: { get },
      store: { read: vi.fn() },
      sources: {} as never,
      existingRepository: {} as never,
      fetch: vi.fn(),
      clock: { now: () => new Date() },
    });
    expect(
      await service.dryRun(
        orgContext('own'),
        { kind: 'organization', userId: 'U', isOrganizationAdmin: false, permissions: new Set() },
        { credentialId: 'C', installationId: 42, pattern: '*', cursor: null },
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(get).not.toHaveBeenCalled();
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { mutationFence, type AuthenticatedActor } from '../authz/fence.js';
import { createPolicyFetch } from './policy-fetch.js';
import { createOutboundPolicy } from './url-policy.js';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const actor = {
  kind: 'organization',
  userId: 'U',
  isOrganizationAdmin: false,
  permissions: new Set(['org:sources:write']),
} as const;
const fence = mutationFence({ userId: 'U', sessionId: 'session' } as AuthenticatedActor, {});
const call = {
  audit: { opId: 'operation', requestId: 'request', sourceIp: null, tokenSelector: null },
};

function productionHarness(runtime: 'node' | 'cloudflare', fork = false) {
  const requests: string[] = [];
  const fetch = createPolicyFetch({
    policy: createOutboundPolicy({ runtime, allowPrivateHosts: [], selfOrigins: [] }),
    userAgent: 'test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname.endsWith('/access_tokens')) {
        const payload = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
          repositories?: string[];
          permissions: object;
        };
        return Response.json(
          {
            token: 'ghs_fixtureToken0123456789',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: payload.permissions,
            ...(payload.repositories === undefined
              ? {}
              : { repositories: payload.repositories.map((name) => ({ name })) }),
          },
          { status: 201 },
        );
      }
      if (url.pathname === '/installation/repositories')
        return Response.json({
          total_count: 50,
          repositories: Array.from({ length: 49 }, (_, index) => ({
            name: `repo${index}`,
            full_name: `acme/repo${index}`,
            owner: { login: 'acme' },
            archived: false,
            fork,
            default_branch: 'main',
          })),
        });
      if (url.pathname === '/repos/acme/limited')
        return new Response(null, { status: 429, headers: { 'retry-after': '30' } });
      if (/\/repos\/acme\/[^/]+$/.test(url.pathname))
        return Response.json({ archived: false, fork, default_branch: 'main' });
      if (url.pathname.endsWith('/composer.json')) return Response.json({ name: 'acme/library' });
      if (url.pathname.endsWith('/package.json')) return Response.json({ name: '@acme/library' });
      return new Response(null, { status: 404 });
    },
  });
  let source = 0;
  const create = vi.fn(async () => ({ ok: true as const, value: { id: `source${++source}` } }));
  const addRegisteredName = vi.fn(async () => ({ ok: true as const, value: {} }));
  const enable = vi.fn(async () => ({ ok: true as const, value: null }));
  const remove = vi.fn(async () => ({ ok: true as const, value: null }));
  const get = vi.fn(async (ctx) =>
    ctx.orgId === 'own' ? { projectId: null, kind: 'github_app' } : null,
  );
  const service = createConfiguredGithubDiscovery({
    credentials: { get } as never,
    store: {
      read: async () =>
        new TextEncoder().encode(
          JSON.stringify({ appId: '1', privateKeyPem: key, webhookSecret: 'fixture-secret' }),
        ),
    },
    sources: { create, addRegisteredName, enable, delete: remove } as never,
    existingRepository: { has: async () => false, hasSourceName: async () => false },
    fetch,
    clock: { now: () => new Date() },
  });
  return { service, create, addRegisteredName, enable, remove, get, requests };
}

it.each(['node', 'cloudflare'] as const)(
  'runs the configured production discovery flow on %s with bounded resume and both ecosystems',
  async (runtime) => {
    const h = productionHarness(runtime);
    const input = { credentialId: 'C', installationId: 42, pattern: '*', cursor: null };
    const plan = await h.service.dryRun(orgContext('own'), actor, input);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('plan');
    expect(plan.value.entries).toHaveLength(98);
    expect(plan.value.nextCursor).toBe('2');
    expect(await h.service.dryRun(orgContext('foreign'), actor, input)).toEqual({
      ok: false,
      error: 'credential_not_found',
    });
    const applied = await h.service.apply(
      orgContext('own'),
      actor,
      fence,
      { ...input, repositories: ['acme/one', 'acme/two', 'acme/three'], nextCursor: '2' },
      call,
    );
    expect(applied).toMatchObject({
      ok: true,
      value: { created: 4, remainingRepositories: ['acme/three'], nextCursor: '2' },
    });
    expect(h.create.mock.calls).toHaveLength(4);
  },
);

it.each(['composer', 'npm'] as const)(
  'requires fork opt-in through the production caller for %s',
  async (ecosystem) => {
    const h = productionHarness('node', true);
    const request = {
      credentialId: 'C',
      installationId: 42,
      ecosystem,
      repositories: ['acme/one'],
    };
    const excluded = await h.service.apply(orgContext('own'), actor, fence, request, call);
    expect(excluded).toMatchObject({
      ok: true,
      value: { skipped: 1, results: [{ reason: 'fork' }] },
    });
    expect(h.create).not.toHaveBeenCalled();
    const included = await h.service.apply(
      orgContext('own'),
      actor,
      fence,
      { ...request, includeForks: true },
      call,
    );
    expect(included).toMatchObject({ ok: true, value: { created: 1 } });
  },
);

it('resumes at a rate-limited repository after a two-ecosystem repository', async () => {
  const h = productionHarness('node');
  const result = await h.service.apply(
    orgContext('own'),
    actor,
    fence,
    {
      credentialId: 'C',
      installationId: 42,
      repositories: ['acme/one', 'acme/limited', 'acme/three'],
    },
    call,
  );
  expect(result).toMatchObject({
    ok: true,
    value: { created: 2, failed: 1, remainingRepositories: ['acme/limited', 'acme/three'] },
  });
});

it.each(['name_public', 'name_public_unverified', 'claim_overlap'] as const)(
  'shows %s and cleans up before a name is retained',
  async (reason) => {
    const h = productionHarness('node');
    h.addRegisteredName.mockResolvedValue({ ok: false, error: reason } as never);
    const result = await h.service.apply(
      orgContext('own'),
      actor,
      fence,
      { credentialId: 'C', installationId: 42, ecosystem: 'npm', repositories: ['acme/one'] },
      call,
    );
    expect(result).toMatchObject({ ok: true, value: { skipped: 1, results: [{ reason }] } });
    expect(h.remove).toHaveBeenCalledOnce();
    expect(h.enable).not.toHaveBeenCalled();
  },
);
