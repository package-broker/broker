import { orgContext } from '@package-broker/core/db/port';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { createProviderRegistry } from '@package-broker/core/sources/provider';
import type {
  ProviderContext,
  ProviderSource,
  SourceProviderContext,
} from '@package-broker/core/plugin';
import type { BearerMaterial } from '@package-broker/core/sources/credentials';
import { createPolicyFetch } from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { describe, expect, it, vi } from 'vitest';
import * as registryModule from '@package-broker/core/registry/module';
import * as onDemand from '@package-broker/core/ingest/on-demand';
import * as distService from '@package-broker/core/registry/dist-service';
import {
  createSourceSyncJob,
  type SourceSyncDeps,
} from '@package-broker/core/ingest/source-sync-job';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { noopObservability } from '@package-broker/core/platform/observability';
import { jobFences } from '@package-broker/core/platform/job-fences';
import {
  createPackageSyncJob,
  type PackageSyncDeps,
} from '@package-broker/core/ingest/package-sync-job';
import type { CatalogueWriteGuard, CatalogueWriter } from '@package-broker/core/db/catalogue';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import * as gitFetch from '@package-broker/core/sources/git/fetch';
import type { IngestSessionHandle } from '@package-broker/core/ingest/session';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { verifyKeyring } from '@package-broker/core/secrets/keyring-verifier';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { resolveRegistryConfig } from '@package-broker/core/registry/registry-config';
import github from './index.js';
import { githubWebhookVerifier } from './webhook.js';

const source: ProviderSource = {
  id: 'source',
  type: 'vcs',
  ecosystem: 'composer',
  url: null,
  config: {
    provider: 'github',
    repository: 'acme/lib',
    installationId: 42,
    refs: { tags: true, branches: [] },
  },
};
const sha = 'a'.repeat(40);

describe('GitHub plugin wiring', () => {
  it('registers a provider without runtime capabilities for build-time validation', () => {
    expect(collectRegistrations([github()]).sourceProviders.get('github')?.webhookVerifier).toBe(
      githubWebhookVerifier,
    );
  });

  it('uses organization-scoped context and the request fetch policy to open an archive', async () => {
    const app = await fixtureApp();
    const resolved = vi.fn();
    const tokensFor: SourceProviderContext['tokensFor'] = async (org, source, create) => {
      resolved(org, source);
      return create(app, '42');
    };
    const calls: string[] = [];
    const fetch = createPolicyFetch({
      userAgent: 'fixture',
      policy: createOutboundPolicy({ runtime: 'node', allowPrivateHosts: [], selfOrigins: [] }),
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/access_tokens')) {
          expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toEqual({
            repositories: ['lib'],
            permissions: { contents: 'read', metadata: 'read' },
          });
          return Response.json(
            {
              token: 'fixture-token',
              expires_at: '2030-01-01T01:00:00Z',
              repositories: [{ name: 'lib' }],
              permissions: { contents: 'read', metadata: 'read' },
            },
            { status: 201 },
          );
        }
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token');
        return new Response('archive');
      },
    });
    const ctx = {
      org: orgContext('org-a'),
      fetch,
      clock: { now: () => new Date('2030-01-01T00:00:00Z') },
      signal: new AbortController().signal,
    } as ProviderContext;
    const registration = collectRegistrations([github()], {
      sourceProviderContext: { runtime: 'docker', tokensFor },
    });
    const provider = registration.sourceProviders.get('github')!;
    const archive = await provider.openDist(ctx, source, {
      packageName: 'acme/lib',
      version: '1.0.0',
      distType: 'zip',
      sourceRef: sha,
      url: null,
    });
    expect(await new Response(archive.body).text()).toBe('archive');
    expect(resolved).toHaveBeenCalledExactlyOnceWith(ctx.org, source);
    expect(calls).toEqual([
      'https://api.github.com/app/installations/42/access_tokens',
      `https://api.github.com/repos/acme/lib/zipball/${sha}`,
    ]);
  });

  it('lists a fixture installation through the injected context and fake transport', async () => {
    const app = await fixtureApp();
    const credential = {
      origins: ['https://api.github.com'],
      queryParams: [],
      apply: (headers: Headers, url: URL) => ({ headers, url }),
    };
    const tokensFor: SourceProviderContext['tokensFor'] = async (org, input, create) =>
      org.orgId === 'org-a' && input === credential ? create(app, '42') : null;
    const calls: string[] = [];
    const grants: unknown[] = [];
    const fetch = createPolicyFetch({
      userAgent: 'fixture',
      policy: createOutboundPolicy({
        runtime: 'cloudflare',
        allowPrivateHosts: [],
        selfOrigins: [],
      }),
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname.endsWith('/access_tokens')) {
          const grant = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
            repositories?: string[];
            permissions: Record<string, string>;
          };
          grants.push(grant);
          return Response.json(
            {
              token: 'fixture-token',
              expires_at: '2030-01-01T01:00:00Z',
              permissions: grant.permissions,
              ...(grant.repositories === undefined
                ? {}
                : { repositories: grant.repositories.map((name) => ({ name })) }),
            },
            { status: 201 },
          );
        }
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token');
        if (url.pathname === '/installation/repositories') {
          expect(url.searchParams.get('page')).toBe('2');
          return Response.json({
            total_count: 120,
            repositories: [
              { owner: { login: 'acme' }, name: 'lib', archived: false, default_branch: 'main' },
              { owner: { login: 'acme' }, name: 'old', archived: true, default_branch: 'main' },
            ],
          });
        }
        return Response.json({
          name: url.pathname.endsWith('/package.json') ? '@acme/lib' : 'acme/lib',
        });
      },
    });
    const ctx = {
      org: orgContext('org-a'),
      fetch,
      clock: { now: () => new Date('2030-01-01T00:00:00Z') },
      signal: new AbortController().signal,
    } as ProviderContext;
    const provider = collectRegistrations([github()], {
      sourceProviderContext: { runtime: 'cloudflare', tokensFor },
    }).sourceProviders.get('github')!;
    expect(await provider.discoverRepositories!(ctx, credential, '2')).toEqual({
      repositories: [
        {
          id: 'acme/lib',
          name: 'acme/lib',
          url: 'https://github.com/acme/lib.git',
          archived: false,
        },
        {
          id: 'acme/old',
          name: 'acme/old',
          url: 'https://github.com/acme/old.git',
          archived: true,
        },
      ],
      next: '3',
    });
    expect(grants).toEqual([
      { permissions: { metadata: 'read' } },
      { repositories: ['lib'], permissions: { contents: 'read', metadata: 'read' } },
    ]);
    expect(calls).toEqual([
      '/app/installations/42/access_tokens',
      '/installation/repositories',
      '/app/installations/42/access_tokens',
      '/repos/acme/lib/contents/composer.json',
      '/repos/acme/lib/contents/package.json',
    ]);
    await expect(
      provider.discoverRepositories!({ ...ctx, org: orgContext('org-b') }, credential, null),
    ).rejects.toMatchObject({ name: 'DiscoveryError', code: 'invalid_request' });
    expect(calls).toHaveLength(5);
  });

  it('rejects discovery without runtime capabilities', async () => {
    const provider = github().sourceProviders()[0]!;
    const ctx = { org: orgContext('org-a') } as ProviderContext;
    const credential = {
      origins: [],
      queryParams: [],
      apply: (headers: Headers, url: URL) => ({ headers, url }),
    };
    await expect(provider.discoverRepositories!(ctx, credential, null)).rejects.toMatchObject({
      name: 'DiscoveryError',
      code: 'invalid_request',
    });
  });

  it('coalesces concurrent token mints and reuses fresh tokens across calls and sources', async () => {
    const app = await fixtureApp();
    let credentialId = 'credential-a';
    let installationId = '42';
    let currentApp = app;
    const tokensFor: SourceProviderContext['tokensFor'] = async (_org, _source, create) =>
      create(currentApp, installationId, credentialId);
    const provider = github().sourceProviders({ runtime: 'docker', tokensFor })[0]!;
    let mints = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const fetch: ProviderContext['fetch'] = async (request) => {
      if (request.url.endsWith('/access_tokens')) {
        mints += 1;
        signals.push(request.signal);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return upstreamResponse(
          Response.json(
            {
              token: 'fixture-token',
              expires_at: '2030-01-01T02:00:00Z',
              repositories: [{ name: 'lib' }],
              permissions: { contents: 'read', metadata: 'read' },
            },
            { status: 201 },
          ),
        );
      }
      request.signal?.throwIfAborted();
      return upstreamResponse(new Response('archive'));
    };
    const ctx = invocation(fetch);
    const cancelled = new AbortController();
    const first = provider.openDist({ ...ctx, signal: cancelled.signal }, source, archiveTarget);
    const second = provider.openDist(
      invocation(fetch),
      { ...source, id: 'another-source' },
      archiveTarget,
    );
    cancelled.abort();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'fulfilled']);
    expect(mints).toBe(1);
    expect(signals).toEqual([undefined]);
    await provider.openDist(invocation(fetch), source, archiveTarget);
    expect(mints).toBe(1);
    await provider.openDist({ ...ctx, org: orgContext('org-b') }, source, archiveTarget);
    expect(mints).toBe(2);
    await provider.openDist(
      { ...ctx, clock: { now: () => new Date('2030-01-01T00:51:00Z') } },
      source,
      archiveTarget,
    );
    expect(mints).toBe(3);
    credentialId = 'credential-b';
    await provider.openDist(ctx, source, archiveTarget);
    expect(mints).toBe(4);
    currentApp = { ...app, appId: '124' };
    await provider.openDist(ctx, source, archiveTarget);
    expect(mints).toBe(5);
    currentApp = { ...currentApp, privateKeyPem: (await fixtureApp()).privateKeyPem };
    await provider.openDist(ctx, source, archiveTarget);
    expect(mints).toBe(6);
    installationId = '43';
    await provider.openDist(
      ctx,
      { ...source, config: { ...source.config, installationId: 43 } } as ProviderSource,
      archiveTarget,
    );
    expect(mints).toBe(7);
  });

  for (const runtime of ['node', 'cloudflare'] as const) {
    it(`${runtime}: binds App credentials through registry fill and dist planners`, async () => {
      const h = await runtimeFixture(runtime);
      try {
        const bound = await h.deps.ingest.credential(h.org, h.record);
        expect(bound).not.toBeNull();
        expect(bound!.probe.secrets).toContain(h.app.privateKeyPem + '\n');
        expect(bound!.probe.secrets).toContain('fixture-webhook-secret');
        expect(
          bound!.credential
            .apply(new Headers(), new URL('https://api.github.com'))
            .headers.has('authorization'),
        ).toBe(false);
        const fillSpy = vi.spyOn(onDemand, 'createOnDemandFill');
        const distSpy = vi.spyOn(distService, 'createDistService');
        registryModule.createRegistryModule({
          ...h.deps,
          policyFetch: () => h.fetch,
          catalogue: {
            ...h.deps.catalogue,
            versionById: async () => ({ packageName: 'acme/lib', version: '1.0.0' }),
          },
        });
        const fill = await fillSpy.mock.calls.at(-1)![0].planFill(h.org, h.record.id, 'acme/lib');
        expect(fill).not.toBeNull();
        const described = await fill!.describe({}, new AbortController().signal);
        expect(described.kind).toBe('found');
        if (described.kind === 'found') {
          const members = [];
          for await (const member of described.description.members) members.push(member);
          expect(members).toEqual([]);
          expect(described.description.upstreamComplete).toBe(true);
          expect(described.description.snapshot.id).toMatch(/^sha256:[a-f0-9]{64}$/);
        }
        const dist = await distSpy.mock.calls.at(-1)![0].planFetch(h.org, {
          sourceId: h.record.id,
          packageId: 'package',
          versionId: 'version',
        } as Parameters<distService.DistServiceDeps['planFetch']>[1]);
        expect(dist).not.toBeNull();
        const archive = await dist!.deps.provider.openDist(
          dist!.deps.providerContext,
          dist!.deps.source,
          archiveTarget,
        );
        expect(await new Response(archive.body).text()).toBe('archive');
        expect(h.calls).toContain('https://api.github.com/repos/acme/lib');
        expect(h.calls).toContain(`https://api.github.com/repos/acme/lib/zipball/${sha}`);
        expect(h.calls.filter((url) => url.endsWith('/access_tokens'))).toHaveLength(1);
        const forge = {
          ...source,
          id: h.record.id,
          config: { ...source.config, installationId: 99 },
        } as ProviderSource;
        expect(await h.context.tokensFor(h.org, forge, () => true)).toBeNull();
        expect(await h.deps.ingest.credential(orgContext('foreign'), h.record)).toBeNull();
      } finally {
        await h.close();
        vi.restoreAllMocks();
      }
    });

    it(`${runtime}: resolves discovery before a source exists and rejects foreign or forged bindings`, async () => {
      const h = await runtimeFixture(runtime);
      try {
        await h.executor.all({ sql: 'DELETE FROM source WHERE org_id = ?', params: [h.org.orgId] });
        const context = h.context as SourceProviderContext & {
          discoveryCredential?: (
            org: ProviderContext['org'],
            credentialId: string,
            installationId: string,
          ) => Promise<ProviderContext['credential']>;
        };
        expect(context.discoveryCredential).toBeTypeOf('function');
        const credential = await context.discoveryCredential!(h.org, h.credentialId, '42');
        expect(credential).not.toBeNull();
        const provider = github().sourceProviders(context)[0]!;
        const ctx = { ...invocation(h.fetch), org: h.org, clock: systemClock };
        expect(await provider.discoverRepositories!(ctx, credential!, null)).toEqual({
          repositories: [],
          next: null,
        });
        expect(
          await context.discoveryCredential!(orgContext('foreign'), h.credentialId, '42'),
        ).toBeNull();
        expect(await context.discoveryCredential!(h.org, h.credentialId, '0')).toBeNull();
        for (const [org, input] of [
          [orgContext('foreign'), credential!],
          [h.org, { ...credential! }],
        ] as const) {
          await expect(
            provider.discoverRepositories!({ ...ctx, org }, input, null),
          ).rejects.toMatchObject({ code: 'invalid_request' });
        }
        await h.executor.all({
          sql: 'DELETE FROM credential WHERE id = ? AND org_id = ?',
          params: [h.credentialId, h.org.orgId],
        });
        await expect(provider.discoverRepositories!(ctx, credential!, null)).rejects.toMatchObject({
          code: 'invalid_request',
        });
      } finally {
        await h.close();
        vi.restoreAllMocks();
      }
    });
  }

  it('refreshes a single-repository source through the source-sync job', async () => {
    const app = await fixtureApp();
    const provider = github().sourceProviders({
      runtime: 'docker',
      tokensFor: async (_org, _source, create) => create(app, '42'),
    })[0]!;
    const enqueue = vi.fn(async () => ({ id: 'job', deduplicated: false }));
    const pollState = vi.fn(async () => 'written' as const);
    const finalize = vi.fn(async () => ({
      status: 'complete' as const,
      empty: true,
      validatorsPublished: 0,
    }));
    const abandon = vi.fn(async () => true);
    const ctx = invocation(async (request) => {
      if (request.url.endsWith('/access_tokens'))
        return upstreamResponse(
          Response.json(
            {
              token: 'fixture-token',
              expires_at: '2030-01-01T01:00:00Z',
              repositories: [{ name: 'lib' }],
              permissions: { contents: 'read', metadata: 'read' },
            },
            { status: 201 },
          ),
        );
      expect(request.url).toBe('https://api.github.com/repos/acme/lib/contents/composer.json');
      return upstreamResponse(Response.json({ name: 'vendor/package' }));
    });
    const session = {
      id: 'session',
      generation: 1,
      stamp: null,
      cursor: null,
      snapshotId: null,
      pagesSoFar: 0,
      seenCount: 0,
    } as IngestSessionHandle;
    const deps = {
      sources: {
        get: async () => ({ ...source, credentialId: 'credential', status: 'active' }),
        pollState,
      },
      providers: { forSource: () => provider },
      toProviderSource: () => source,
      loadCredential: async () => ({
        origins: [],
        queryParams: [],
        apply: (headers: Headers, url: URL) => ({ headers, url }),
      }),
      providerContext: () => ctx,
      sessions: {
        acquire: async () => session,
        start: async () => true,
        advance: async () => ({ seenCount: 0, pagesSoFar: 1 }),
        abandon,
        release: async () => true,
      },
      writer: { openListing: async () => ({ stamp: 'stamp' }), markListing: async () => ({}) },
      finalizer: { finalize },
      writeGuard: () => [],
      jobGuard: () => ({}),
      markedCount: async () => 0,
      unseenExistingCount: async () => 0,
      existingKeys: async () => new Set(),
    } as unknown as SourceSyncDeps;
    const job = {
      org: ctx.org,
      signal: ctx.signal,
      ports: { platform: { jobs: { enqueue } } },
      observability: noopObservability,
    } as unknown as JobContext;
    await createSourceSyncJob(deps).handler({ sourceId: source.id, reason: 'admin' }, job);
    expect(enqueue).toHaveBeenCalledWith(
      ctx.org,
      'core:package-sync:v1',
      { sourceId: source.id, key: 'vendor/package' },
      expect.anything(),
    );
    expect(finalize).toHaveBeenCalledOnce();
    expect(abandon).not.toHaveBeenCalled();
    expect(pollState).toHaveBeenCalledWith(
      ctx.org,
      expect.anything(),
      expect.objectContaining({ outcome: 'success' }),
    );
  });

  it('abandons a changed snapshot between package-sync chunks and recovers on a fresh sync', async () => {
    const h = await releaseFixture();
    const fresh = (generation: number): IngestSessionHandle => ({
      id: `session-${generation}`,
      scopeKey: 'package-scope',
      owner: 'owner',
      fence: 1,
      leaseSeconds: 60,
      generation,
      stamp: null,
      snapshotId: null,
      snapshotBlobSha256: null,
      cursor: null,
      seenCount: 0,
      pagesSoFar: 0,
      pendingValidators: null,
    });
    let held = fresh(1);
    const abandon = vi.fn(async () => {
      held = fresh(held.generation + 1);
      return true;
    });
    const release = vi.fn(async (_org, handle: IngestSessionHandle) => {
      held = handle;
      return true;
    });
    const sessions = {
      acquire: async () => held,
      start: async () => true,
      advance: async (_org: unknown, handle: IngestSessionHandle, input: { addSeen: number }) => ({
        seenCount: handle.seenCount + input.addSeen,
        pagesSoFar: handle.pagesSoFar + 1,
      }),
      setPendingValidators: async () => true,
      abandon,
      release,
      latest: async () => null,
      discard: async () => true,
    };
    const enqueue = vi.fn<PackageSyncDeps['jobs']['enqueue']>(async () => ({
      id: 'continuation',
      created: true,
    }));
    const syncPackage = vi.fn(async (_org, _guard, input) => ({
      packageId: 'package',
      refused: [],
      skippedTags: [],
      statements: 10 + input.versions.length * 300,
    }));
    const finalize = vi.fn(async () => ({
      status: 'complete',
      empty: false,
      validatorsPublished: 0,
    }));
    const writer = {
      statementBudget: { openListing: 1, markListing: 1, finalizeListing: 1, quarantine: 1 },
      syncPackageCost: ({ versions }: { versions: number }) => 10 + versions * 300,
      syncPayloadLimit: 1024 * 1024,
      syncPayloadBytes: () => 1,
      syncPackage,
      openListing: async () => ({ stamp: 'stamp' }),
      markListing: async () => ({}),
    } as unknown as CatalogueWriter;
    const deps: PackageSyncDeps = {
      sessions,
      apply: {
        sessions,
        writer,
        existing: { existingVersions: async () => ({ rows: [], next: null }) },
        finalizer: { finalize } as unknown as PackageSyncDeps['apply']['finalizer'],
      },
      jobs: { enqueue },
      upstreamState: {} as PackageSyncDeps['upstreamState'],
      executor: { batch: async () => [] },
      sourceMetadata: async () => ({ type: 'vcs' }),
      findPackageId: async () => null,
      writeGuard: () => [{ sql: 'guard', params: [] }] as unknown as CatalogueWriteGuard,
      clock: h.ctx.clock,
      planFill: async () => ({
        source: {
          id: source.id,
          key: 'vendor/package',
          type: 'vcs',
          ecosystem: 'composer',
          covered: true,
        },
        describe: (options) => h.provider.describe(h.ctx, h.source, 'vendor/package', options),
        toVersion: (candidate) => {
          const manifest = JSON.parse(candidate.raw);
          return {
            version: candidate.version,
            versionNormalized: manifest.version_normalized,
            license: null,
            distType: 'zip',
            sourceRef: manifest.source.reference,
            upstreamReleasedAt: null,
            metadata: normalizeVersionMetadata('composer', manifest),
            history: { basis: 'release_date', at: '2030-01-01T00:00:00Z' },
          };
        },
        packageDescription: null,
        validatorTtlSeconds: 300,
        publishedValidators: {},
      }),
    };
    const job = createPackageSyncJob(deps);
    const context = {
      org: h.ctx.org,
      signal: h.ctx.signal,
      fences: jobFences({ id: 'job', owner: 'owner', fence: 1 }),
      observability: noopObservability,
    } as JobContext;
    const payload = { sourceId: source.id, key: 'vendor/package' };
    try {
      await job.handler(payload, context);
      expect(held).toMatchObject({ generation: 1, pagesSoFar: 1, seenCount: 1 });
      expect(finalize).not.toHaveBeenCalled();
      const continuation = enqueue.mock.calls[0]![2];
      expect(continuation).toMatchObject({ sessionId: 'session-1', generation: 1, step: 1 });
      const obsoleteSnapshot = held.snapshotId;
      h.changeRefs();
      syncPackage.mockClear();
      release.mockClear();
      await expect(job.handler(continuation, context)).rejects.toMatchObject({
        code: 'handler_error',
      });
      expect(abandon).toHaveBeenCalledExactlyOnceWith(
        h.ctx.org,
        expect.objectContaining({
          id: 'session-1',
          snapshotId: obsoleteSnapshot,
          stamp: 'stamp',
        }),
      );
      expect(release).not.toHaveBeenCalled();
      expect(syncPackage).not.toHaveBeenCalled();
      await job.handler(payload, context);
      expect(held).toMatchObject({ generation: 2, pagesSoFar: 1, seenCount: 1 });
      expect(held.snapshotId).not.toBe(obsoleteSnapshot);
      const next = enqueue.mock.calls.at(-1)![2];
      expect(next).toMatchObject({ sessionId: 'session-2', generation: 2 });
      await job.handler(next, context);
      expect(finalize).toHaveBeenCalledExactlyOnceWith(
        h.ctx.org,
        expect.objectContaining({ generation: 2, seenCount: 2 }),
        expect.objectContaining({ upstreamComplete: true, expectedCount: 2 }),
        expect.anything(),
      );
    } finally {
      h.close();
    }
  });

  it.each(['missing', 'renamed'] as const)(
    'syncs a configured package with tagged releases and a %s default-branch manifest',
    async (defaultManifest) => {
      const h = await releaseFixture(defaultManifest);
      const enqueue = vi.fn(async () => ({ id: 'job', deduplicated: false }));
      const pollState = vi.fn(async () => 'written' as const);
      const finalize = vi.fn(async () => ({
        status: 'complete',
        empty: true,
        validatorsPublished: 0,
      }));
      const abandon = vi.fn(async () => true);
      const session = {
        id: 'listing',
        generation: 1,
        stamp: null,
        cursor: null,
        snapshotId: null,
        pagesSoFar: 0,
        seenCount: 0,
      } as IngestSessionHandle;
      const deps = {
        sources: {
          get: async () => ({ ...h.source, credentialId: null, status: 'active' }),
          pollState,
        },
        providers: { forSource: () => h.provider },
        toProviderSource: () => h.source,
        providerContext: () => h.ctx,
        sessions: {
          acquire: async () => session,
          start: async () => true,
          advance: async () => ({ seenCount: 0, pagesSoFar: 1 }),
          abandon,
          release: async () => true,
        },
        writer: { openListing: async () => ({ stamp: 'stamp' }), markListing: async () => ({}) },
        finalizer: { finalize },
        writeGuard: () => [],
        jobGuard: () => ({}),
        markedCount: async () => 0,
        unseenExistingCount: async () => 0,
        existingKeys: async () => new Set(),
      } as unknown as SourceSyncDeps;
      const context = {
        org: h.ctx.org,
        signal: h.ctx.signal,
        ports: { platform: { jobs: { enqueue } } },
        observability: noopObservability,
      } as unknown as JobContext;
      try {
        await createSourceSyncJob(deps).handler({ sourceId: source.id, reason: 'admin' }, context);
        expect(enqueue).toHaveBeenCalledWith(
          h.ctx.org,
          'core:package-sync:v1',
          { sourceId: source.id, key: 'vendor/package' },
          expect.anything(),
        );
        expect(finalize).toHaveBeenCalledOnce();
        expect(abandon).not.toHaveBeenCalled();
        expect(pollState).toHaveBeenCalledWith(
          h.ctx.org,
          expect.anything(),
          expect.objectContaining({ outcome: 'success' }),
        );
        expect(h.defaultBranchReads()).toBe(0);
        const described = await h.provider.describe(h.ctx, h.source, 'vendor/package', {});
        expect(described.kind).toBe('found');
        if (described.kind !== 'found') throw new Error('missing tagged releases');
        const versions = [];
        for await (const member of described.description.members) versions.push(member.version);
        expect(versions).toEqual(['v2.0.0', 'v1.0.0']);
        expect(described.description.upstreamComplete).toBe(true);
      } finally {
        h.close();
      }
    },
  );

  it('uses the T415 verifier through the guarded provider registry', async () => {
    const registry = createProviderRegistry();
    for (const provider of collectRegistrations([github()]).sourceProviders.values())
      registry.register(provider);
    const verifier = registry.get('vcs', 'github').webhookVerifier!;
    const headers = new Headers({
      'x-hub-signature-256':
        'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    });
    const secret = { kind: 'bearer', token: "It's a Secret to Everybody" } as BearerMaterial;
    expect(await verifier.verify(secret, headers, new TextEncoder().encode('Hello, World!'))).toBe(
      true,
    );
    expect(await verifier.verify(secret, headers, new TextEncoder().encode('tampered'))).toBe(
      false,
    );
  });
});

async function fixtureApp() {
  const key = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key.privateKey));
  return {
    appId: '123',
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`,
  };
}

const archiveTarget = {
  packageName: 'acme/lib',
  version: '1.0.0',
  distType: 'zip' as const,
  sourceRef: sha,
  url: null,
};

function invocation(fetch: ProviderContext['fetch']): ProviderContext {
  return {
    org: orgContext('org-a'),
    fetch,
    clock: { now: () => new Date('2030-01-01T00:00:00Z') },
    signal: new AbortController().signal,
  } as ProviderContext;
}

function upstreamResponse(response: Response) {
  return {
    status: response.status,
    headers: response.headers,
    body: response.body,
    url: 'https://api.github.com',
  };
}

async function runtimeFixture(runtime: 'node' | 'cloudflare') {
  // Variable imports keep runtime test-only dependencies out of this package's declaration build.
  const load = (path: string) => import(new URL(path, import.meta.url).href);
  const { openMigratedDatabase } = await load('../../db-sqlite/src/testing/migrated-database.ts');
  const { createOrganizationBootstrap } = await load(
    '../../db-sqlite/src/repositories/organization.ts',
  );
  const { createCredentialRepository } = await load(
    '../../db-sqlite/src/repositories/credential.ts',
  );
  const { createKeyringVerifierStore } = await load(
    '../../db-sqlite/src/repositories/keyring-verifier.ts',
  );
  const db = await openMigratedDatabase();
  const executor: SqlExecutor = db.executor;
  const orgRow = await createOrganizationBootstrap(executor).bootstrap({
    id: ulid(),
    slug: 'acme',
    name: 'Acme',
    now: new Date().toISOString(),
  });
  const org = orgContext(orgRow.id);
  const keyring = createKeyring([
    parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
  ]);
  await verifyKeyring(keyring, createKeyringVerifierStore(executor));
  const app = await fixtureApp();
  const store = createCredentialStore({
    repository: createCredentialRepository(executor),
    cipher: createSecretCipher(keyring, 'credential-encryption'),
    clock: systemClock,
    ids: { ulid },
  });
  const credentialId = await store.put(org, {
    kind: 'github_app',
    projectId: null,
    plaintext: new TextEncoder().encode(
      JSON.stringify({ ...app, webhookSecret: 'fixture-webhook-secret' }),
    ),
  });
  const sourceId = ulid();
  await executor.all({
    sql: "INSERT INTO source (id, org_id, name, ecosystem, type, credential_id, config_json) VALUES (?, ?, 'github', 'composer', 'vcs', ?, ?)",
    params: [sourceId, org.orgId, credentialId, JSON.stringify(source.config)],
  });
  let context: SourceProviderContext | undefined;
  const plugin = {
    ...github(),
    sourceProviders: (ctx?: SourceProviderContext) => {
      context = ctx;
      return github().sourceProviders(ctx);
    },
  };
  const moduleSpy = vi.spyOn(registryModule, 'createRegistryModule');
  let shutdown = async () => {};
  try {
    if (runtime === 'node') {
      const { createNodeServer } = await load('../../runtime-node/src/index.ts');
      const broker = createNodeServer([plugin], {
        executor,
        auth: { keyring, publicOrigin: 'https://broker.test', env: {} },
        platformServices: { blob: {}, cache: {}, jobStore: {} },
        registry: { config: resolveRegistryConfig(undefined, 'node', 'https://broker.test') },
        log: () => {},
      });
      shutdown = () => broker.close();
      await broker.ready();
    } else {
      const { createWorker } = await load('../../runtime-cloudflare/src/index.ts');
      const statements = new WeakMap<object, Statement>();
      const prepare = (sql: string) => {
        const statement = {
          bind(...params: Statement['params']) {
            statements.set(statement, { sql, params });
            return statement;
          },
          async all() {
            return {
              results: await executor.all(statements.get(statement) ?? { sql, params: [] }),
            };
          },
        };
        return statement;
      };
      const worker = createWorker([plugin], {
        registry: {},
        log: () => {},
        cacheStorage: {
          open: async () => ({
            match: async () => undefined,
            put: async () => {},
            delete: async () => false,
          }),
        },
        platformPorts: {
          blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1048576 },
          cache: { adapter: 'cache-api' },
          jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
          observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
        },
      });
      await worker.services({
        DB: {
          prepare,
          batch: async (batch: object[]) =>
            (await executor.batch(batch.map((s) => statements.get(s)!))).map((r) => ({
              results: r.rows,
              meta: { changes: r.changes },
            })),
        },
        STORAGE: {
          head: async () => null,
          get: async () => null,
          put: async () => {},
          delete: async () => {},
        },
        JOBS: { send: async () => {}, sendBatch: async () => {} },
        DEPLOYMENT_ID: 'fixture',
        PB_KEYRING_RESEED: '1',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'https://broker.test',
      });
    }
    const deps = moduleSpy.mock.calls.at(-1)![0];
    const record = (await deps.catalogue.sources.get(org, sourceId))!;
    const calls: string[] = [];
    const fetch: ProviderContext['fetch'] = async (request) => {
      calls.push(request.url);
      if (request.url.endsWith('/access_tokens')) {
        const grant = JSON.parse(new TextDecoder().decode(request.body as Uint8Array));
        return upstreamResponse(
          Response.json(
            {
              token: 'fixture-token',
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              permissions: grant.permissions,
              ...(grant.repositories === undefined
                ? {}
                : { repositories: grant.repositories.map((name: string) => ({ name })) }),
            },
            { status: 201 },
          ),
        );
      }
      if (request.url.includes('/zipball/')) return upstreamResponse(new Response('archive'));
      if (request.url.includes('/installation/repositories'))
        return upstreamResponse(Response.json({ total_count: 0, repositories: [] }));
      if (request.url.endsWith('/repos/acme/lib'))
        return upstreamResponse(
          Response.json({ archived: false, default_branch: 'main', full_name: 'acme/lib' }),
        );
      if (request.url.includes('/info/refs'))
        return upstreamResponse(
          new Response('000eversion 2\n000cls-refs\n0000', {
            headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          }),
        );
      if (request.url.endsWith('/git-upload-pack'))
        return upstreamResponse(
          new Response('0000', {
            headers: { 'content-type': 'application/x-git-upload-pack-result' },
          }),
        );
      return upstreamResponse(new Response('{}', { status: 404 }));
    };
    return {
      executor,
      org,
      app,
      credentialId,
      record,
      context: context!,
      deps,
      calls,
      fetch,
      close: async () => {
        await shutdown();
        await db.close();
      },
    };
  } catch (error) {
    await shutdown();
    await db.close();
    throw error;
  }
}

async function releaseFixture(defaultManifest: 'missing' | 'renamed' = 'missing') {
  const app = await fixtureApp();
  if (source.type !== 'vcs') throw new Error('expected VCS source');
  const configuredSource: ProviderSource = {
    ...source,
    config: { ...source.config, packageName: 'vendor/package' },
  };
  const provider = github().sourceProviders({
    runtime: 'docker',
    tokensFor: async (_org, _source, create) => create(app, '42'),
  })[0]!;
  let changed = false;
  let defaultBranchReads = 0;
  const ctx = invocation(async (request) => {
    if (request.url.endsWith('/access_tokens'))
      return upstreamResponse(
        Response.json(
          {
            token: 'fixture-token',
            expires_at: '2030-01-01T01:00:00Z',
            repositories: [{ name: 'lib' }],
            permissions: { contents: 'read', metadata: 'read' },
          },
          { status: 201 },
        ),
      );
    if (request.url.endsWith('/contents/composer.json')) {
      defaultBranchReads++;
      return upstreamResponse(
        defaultManifest === 'missing'
          ? new Response(null, { status: 404 })
          : Response.json({ name: 'vendor/renamed' }),
      );
    }
    if (request.url.endsWith('/repos/acme/lib'))
      return upstreamResponse(
        Response.json({ archived: false, default_branch: 'main', full_name: 'acme/lib' }),
      );
    if (request.url.includes('/info/refs'))
      return upstreamResponse(
        new Response('000eversion 2\n000cls-refs\n0000', {
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
        }),
      );
    expect(request.url).toBe('https://github.com/acme/lib.git/git-upload-pack');
    const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;
    const refs =
      pkt(`${changed ? 'b'.repeat(40) : sha} refs/tags/v2.0.0\n`) +
      pkt(`${sha} refs/tags/v1.0.0\n`) +
      '0000';
    return upstreamResponse(
      new Response(refs, {
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
      }),
    );
  });
  const files = vi
    .spyOn(gitFetch, 'readFileAtRefs')
    .mockImplementation(async (_options, _url, refs) =>
      refs.map((ref) => ({
        ref: ref.name,
        commit: ref.oid,
        committedAt: null,
        text: JSON.stringify({ name: 'vendor/package' }),
      })),
    );
  return {
    provider,
    source: configuredSource,
    ctx,
    changeRefs: () => {
      changed = true;
    },
    defaultBranchReads: () => defaultBranchReads,
    close: () => files.mockRestore(),
  };
}
