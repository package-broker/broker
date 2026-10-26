import { describe, expect, it, vi } from 'vitest';
import { setAccessContext } from '../authz/access-context.js';
import type { CatalogueReader, PackageVisibility, ResolvedPackage } from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import { createOnDemandFill } from '../ingest/on-demand.js';
import { createPackageSyncJob } from '../ingest/package-sync-job.js';
import { applyChunk, type ApplyDeps, type ApplyOutcome } from '../ingest/apply-description.js';
import type { IngestSessionHandle } from '../ingest/session.js';
import { narrowPackageActor, setContextPackageActor } from '../internal/package-actor.js';
import { setResolvedPackage } from '../internal/package-context.js';
import { systemClock } from '../ids.js';
import { createPolicyFetch } from '../sources/policy-fetch.js';
import type { PlatformPorts, RequestContext } from '../plugin.js';
import { PlatformUnavailableError } from '../platform/errors.js';
import type { SourceRecord } from '../db/source.js';
import type { AuthorizedNpmAudit, NpmAuditAuthorizer } from '../db/vulnerability.js';
import type { PolicyFetch } from '../sources/policy-fetch.js';
import { PACKAGES_READ, createPackageAccess } from '../catalogue/package-access.js';
import { packageSyncEnqueueInput } from '../ingest/package-sync-job.js';
import { createRegistryModule, type RegistryModuleDeps } from './module.js';
import { resolveRegistryConfig } from './registry-config.js';
import type { RegistryJobsDeps } from './jobs.js';

vi.mock('../catalogue/package-access.js', async (original) => {
  const actual = await original<typeof import('../catalogue/package-access.js')>();
  return { ...actual, createPackageAccess: vi.fn(actual.createPackageAccess) };
});
vi.mock('../ingest/on-demand.js', async (original) => {
  const actual = await original<typeof import('../ingest/on-demand.js')>();
  return { ...actual, createOnDemandFill: vi.fn(actual.createOnDemandFill) };
});
vi.mock('../ingest/package-sync-job.js', async (original) => {
  const actual = await original<typeof import('../ingest/package-sync-job.js')>();
  return { ...actual, createPackageSyncJob: vi.fn(actual.createPackageSyncJob) };
});
vi.mock('../ingest/apply-description.js', async (original) => ({
  ...(await original<typeof import('../ingest/apply-description.js')>()),
  applyChunk: vi.fn(),
}));

const VERSION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const READ = 'project:packages:read';
const org = orgContext('org-1');
const handle: IngestSessionHandle = {
  id: 'session-1',
  scopeKey: 'scope',
  owner: 'owner',
  fence: 1,
  leaseSeconds: 60,
  generation: 1,
  stamp: null,
  snapshotId: null,
  snapshotBlobSha256: null,
  cursor: null,
  seenCount: 0,
  pagesSoFar: 0,
  pendingValidators: null,
};
const progress: ApplyOutcome = {
  done: false,
  status: 'progress',
  session: { ...handle, pagesSoFar: 1 },
  cursor: 'cursor',
  skipped: [],
  refused: [],
  duplicates: [],
  tagsSkipped: false,
  skippedTags: [],
  planned: 1,
};
const npmjsSource = {
  id: 'src-1',
  projectId: null,
  name: 'npmjs',
  ecosystem: 'npm',
  type: 'npmjs_proxy',
  url: 'https://registry.npmjs.org',
  credentialId: null,
  configJson: '{}',
  userAgent: null,
  status: 'active',
} as unknown as SourceRecord;
const visibleNpm = (over: Partial<ResolvedPackage> = {}): PackageVisibility => ({
  kind: 'visible',
  pkg: {
    projectId: 'proj-1',
    ecosystem: 'composer',
    key: 'acme/lib',
    packageId: 'pk',
    sourceId: 'src-1',
    rev: 1,
    modifiedAt: '2026-10-01T00:00:00Z',
    createdAt: '2026-10-01T00:00:00Z',
    listingComplete: true,
    cacheEpoch: '1',
    ...over,
  },
  cacheKey: () => {
    throw new Error('unused');
  },
  epochReader: { read: async () => null },
});

const time = { at: Date.parse('2026-10-20T00:00:00Z') };

describe('registry job attachment', () => {
  const registryJobs: RegistryJobsDeps = {
    sourceSync: {
      sources: {
        get: vi.fn<RegistryJobsDeps['sourceSync']['sources']['get']>(),
        pollState: vi.fn<RegistryJobsDeps['sourceSync']['sources']['pollState']>(),
      },
      providers: { forSource: vi.fn<RegistryJobsDeps['sourceSync']['providers']['forSource']>() },
      toProviderSource: vi.fn<RegistryJobsDeps['sourceSync']['toProviderSource']>(),
      loadCredential: vi.fn<RegistryJobsDeps['sourceSync']['loadCredential']>(),
      providerContext: vi.fn<RegistryJobsDeps['sourceSync']['providerContext']>(),
      sessions: {
        acquire: vi.fn<RegistryJobsDeps['sourceSync']['sessions']['acquire']>(),
        start: vi.fn<RegistryJobsDeps['sourceSync']['sessions']['start']>(),
        advance: vi.fn<RegistryJobsDeps['sourceSync']['sessions']['advance']>(),
        abandon: vi.fn<RegistryJobsDeps['sourceSync']['sessions']['abandon']>(),
        release: vi.fn<RegistryJobsDeps['sourceSync']['sessions']['release']>(),
      },
      writer: {
        openListing: vi.fn<RegistryJobsDeps['sourceSync']['writer']['openListing']>(),
        markListing: vi.fn<RegistryJobsDeps['sourceSync']['writer']['markListing']>(),
      },
      finalizer: { finalize: vi.fn<RegistryJobsDeps['sourceSync']['finalizer']['finalize']>() },
      writeGuard: vi.fn<RegistryJobsDeps['sourceSync']['writeGuard']>(),
      jobGuard: vi.fn<RegistryJobsDeps['sourceSync']['jobGuard']>(),
      markedCount: vi.fn<RegistryJobsDeps['sourceSync']['markedCount']>(),
      unseenExistingCount: vi.fn<RegistryJobsDeps['sourceSync']['unseenExistingCount']>(),
      existingKeys: vi.fn<RegistryJobsDeps['sourceSync']['existingKeys']>(),
      staleHeldKeys: vi.fn<RegistryJobsDeps['sourceSync']['staleHeldKeys']>(),
    },
    sourcePoll: {
      sources: {
        listDue: vi.fn<RegistryJobsDeps['sourcePoll']['sources']['listDue']>(),
        deferPoll: vi.fn<RegistryJobsDeps['sourcePoll']['sources']['deferPoll']>(),
      },
    },
    webhook: {
      loadCredential: vi.fn<RegistryJobsDeps['webhook']['loadCredential']>(),
      verifier: { verify: vi.fn<RegistryJobsDeps['webhook']['verifier']['verify']>() },
      deliveries: {
        record: vi.fn<RegistryJobsDeps['webhook']['deliveries']['record']>(),
        sourcesFor: vi.fn<RegistryJobsDeps['webhook']['deliveries']['sourcesFor']>(),
        settle: vi.fn<RegistryJobsDeps['webhook']['deliveries']['settle']>(),
      },
    },
  };

  it('attaches the webhook and each source job once when jobs are enabled', () => {
    const h = harness();
    const built = createRegistryModule({ ...h.deps, registryJobs });
    expect(built.coreRoutes?.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/_pb/hooks/github/:credentialId'],
    ]);
    expect(built.coreJobs?.map(({ qualifiedName }) => qualifiedName)).toEqual([
      'core:source-sync:v1',
      'core:source-poll:v1',
    ]);
    expect(built.coreJobs?.[1]?.definition.schedule).toEqual({ everySeconds: 60 });
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('ignores job dependencies without the job port', () => {
    const h = harness({ jobs: false });
    const built = createRegistryModule({ ...h.deps, registryJobs });
    expect(Object.keys(built).sort()).toEqual(['ecosystemRoutes', 'visibilityPort']);
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });
});

function harness(options: { jobs?: boolean; ports?: Partial<PlatformPorts> } = {}) {
  const reader = {
    resolveVersions: vi.fn(async () => null),
    admitProxy: vi.fn(async () => [] as string[]),
    search: vi.fn(async () => []),
    distTags: vi.fn(async () => ({ pkg: incomplete(), tags: { latest: '1.0.0' } })),
    resolveDist: vi.fn(async () => null),
  };
  const jobs = {
    enqueue: vi.fn((async () => ({ id: 'job-1', created: true })) as (
      ...args: unknown[]
    ) => Promise<{ id: string; created: boolean }>),
    get: vi.fn(async () => null),
  };
  const events: string[] = [];
  const sessions = {
    acquire: vi.fn(async (_ctx: unknown, _scope: unknown, owner: string) => ({
      ...handle,
      owner,
    })),
    latest: vi.fn(async () => ({
      state: 'running' as const,
      generation: 1,
      fence: 1,
      seenCount: 0,
      pagesSoFar: 0,
    })),
    start: vi.fn(async () => true),
    advance: vi.fn(async () => null),
    setPendingValidators: vi.fn(async () => true),
    abandon: vi.fn(async () => true),
    release: vi.fn(async () => {
      events.push('release');
      return true;
    }),
  };
  jobs.enqueue.mockImplementation(async () => {
    events.push('enqueue');
    return { id: 'job-1', created: true };
  });
  const scopedAdmission = {
    admitScoped: vi.fn(async (_ctx: unknown, query: { key: string }) =>
      query.key.startsWith('@acme/') ? ['src-9'] : [],
    ),
  };
  const policyFetch = vi.fn(async () => ({
    status: 200,
    headers: new Headers({ etag: '"v1"', 'content-type': 'application/json' }),
    body: new Response(
      JSON.stringify({
        name: 'left-pad',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'left-pad',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
              integrity: 'sha512-AAAA',
            },
          },
        },
        time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
      }),
    ).body,
  }));
  const versionById = vi.fn(async () => null);
  const blob = { get: vi.fn(async () => null), head: vi.fn(async () => null) };
  const ports = {
    blob,
    cache: {},
    observability: { log: vi.fn() },
    ...(options.jobs === false ? {} : { jobs }),
    ...options.ports,
  } as unknown as RegistryModuleDeps['ports'];
  const deps: RegistryModuleDeps = {
    runtime: 'node',
    ports,
    clock: { now: () => new Date(time.at) },
    codecs: {} as never,
    publicUrl: 'https://broker.test',
    registry: resolveRegistryConfig(undefined, 'node', 'https://broker.test'),
    outboundPolicy: { allowPrivateHosts: [], runtime: 'node', selfOrigins: [] },
    policyFetch: () => policyFetch as never,
    deploymentId: 'dep-1',
    catalogue: {
      reader: reader as unknown as CatalogueReader,
      scopedAdmission,
      epoch: { read: async () => '1' },
      representationClock: { advance: vi.fn() } as never,
      upstreamState: { get: vi.fn(async () => null) },
      sources: { get: vi.fn(async () => npmjsSource) },
      covers: vi.fn(async () => false),
      versionById,
    },
    ingest: {
      sessions: sessions as never,
      apply: { sessions } as unknown as ApplyDeps,
      writeGuard: vi.fn(() => [] as never),
      credential: vi.fn(async () => null),
    },
    dist: {
      leases: {
        acquire: vi.fn(async (_ctx: unknown, key: string, owner: string) => ({
          key,
          owner,
          fence: 1,
        })),
        renew: vi.fn(async () => true),
        release: vi.fn(async () => undefined),
      },
      leaseKey: async (parts) => parts.join(':'),
      writeGuard: vi.fn(() => [] as never),
      writer: { attachDist: vi.fn(), quarantine: vi.fn() } as never,
      blobReplacer: { replaceBlob: vi.fn() },
      recorder: { record: vi.fn() },
    },
  };
  time.at = Date.parse('2026-10-20T00:00:00Z');
  vi.mocked(applyChunk)
    .mockReset()
    .mockImplementation(async () => progress);
  return {
    get deps() {
      return deps;
    },
    set deps(value: RegistryModuleDeps) {
      Object.assign(deps, value);
    },
    reader,
    jobs,
    sessions,
    events,
    scopedAdmission,
    policyFetch,
    versionById,
    blob,
    module: () => createRegistryModule(deps),
  };
}

function context(
  url: string,
  params: Record<string, string>,
  options: {
    snapshot?: boolean;
    outcome?: PackageVisibility;
    actor?: unknown;
    packageActor?: boolean;
  } = {},
): RequestContext {
  const ctx = {
    request: new Request(url),
    requestId: 'req-1',
    org,
    principal: { kind: 'user', id: 'user-1' },
    projectId: 'proj-1',
    params,
    ports: { clock: systemClock },
  } as unknown as RequestContext;
  if (options.snapshot !== false) {
    setAccessContext(ctx, {
      principal: { kind: 'user', id: 'user-1' },
      projectId: 'proj-1',
      boundary: 'project',
      sessionId: options.actor === undefined ? null : 's',
      token: options.actor === undefined ? { kind: 'pat', scope: null, readOnly: true } : null,
      actor: (options.actor ?? null) as never,
      rateKey: {
        stage: 'authenticated',
        tokenSelector: options.actor === undefined ? 'sel' : null,
        principalId: 'user-1',
        routeClass: 'project',
      },
    });
  }
  if (options.snapshot !== false && options.packageActor !== false) {
    const held = options.actor as
      { organizationPermissions: string[]; projectPermissions: string[] } | undefined;
    setContextPackageActor(
      ctx,
      narrowPackageActor(
        {
          kind: 'project',
          userId: 'user-1',
          orgId: org.orgId,
          projectId: 'proj-1',
          permissions: new Set(
            held === undefined
              ? [PACKAGES_READ]
              : [...held.organizationPermissions, ...held.projectPermissions],
          ),
        } as never,
        PACKAGES_READ,
      ),
    );
  }
  if (options.outcome !== undefined && options.outcome.kind !== 'absent') {
    setResolvedPackage(ctx, options.outcome);
  }
  return ctx;
}

const SEARCH = '/:project/npm/-/v1/search';
const routeOf = (
  routes: readonly { method: string; path: string }[],
  method: string,
  path: string,
) =>
  routes.find((route) => route.method === method && route.path === path) as unknown as {
    handler: (ctx: RequestContext) => Promise<Response> | Response;
  };

describe('createRegistryModule assembly', () => {
  it.each(['blob', 'cache', 'observability'] as const)(
    'refuses assembly without the %s port',
    (name) => {
      const h = harness({ ports: { [name]: undefined } });
      expect(h.module).toThrow(PlatformUnavailableError);
    },
  );

  it('assembles without the job port', () => {
    const h = harness({ jobs: false });
    expect(h.module().ecosystemRoutes.length).toBeGreaterThan(0);
  });

  it('registers no job and calls the job port zero times during assembly', () => {
    const h = harness();
    const built = h.module();
    expect(Object.keys(built).sort()).toEqual(['ecosystemRoutes', 'visibilityPort']);
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
    expect(h.jobs.get).not.toHaveBeenCalled();
  });

  it('exposes every Composer and npm route exactly once', () => {
    const { ecosystemRoutes } = harness().module();
    const seen = ecosystemRoutes.map((route) => `${route.method} ${route.path}`);
    expect(new Set(seen).size).toBe(seen.length);
    const shapes = [
      '/:project/npm/:a',
      '/:project/npm/:a/:b',
      '/:project/npm/:a/:b/:c',
      '/:project/npm/:a/:b/:c/:d',
    ];
    expect([...seen].sort()).toEqual(
      [
        'GET /:project/packages.json',
        'GET /:project/p2/:vendor/:file',
        'GET /:project/dist/:vendor/:name/:file',
        'GET /:project/npm/-/whoami',
        'GET /:project/npm/-/ping',
        `GET ${SEARCH}`,
        'POST /:project/npm/-/npm/v1/security/advisories/bulk',
        'POST /:project/npm/-/npm/v1/security/audits/quick',
        'POST /:project/npm/-/npm/v1/security/audits',
        'GET /:project/npm/-/package/:a/dist-tags',
        ...shapes.flatMap((path) => ['GET', 'PUT', 'POST', 'DELETE'].map((m) => `${m} ${path}`)),
      ].sort(),
    );
  });
});

describe('visibilityPort', () => {
  const actor = {
    kind: 'project' as const,
    userId: 'user-1',
    orgId: org.orgId,
    projectId: 'proj-1',
    permissions: new Set([READ]),
  };

  it('resolves an absent scoped npm name covered by an attached npm_registry source to proxy_admissible', async () => {
    const h = harness();
    const outcome = await h.module().visibilityPort.resolve(actor, 'npm', '@acme/widget');
    expect(outcome).toEqual({
      kind: 'proxy_admissible',
      projectId: 'proj-1',
      ecosystem: 'npm',
      key: '@acme/widget',
      sourceIds: ['src-9'],
    });
  });

  it.each([
    ['an unscoped name', 'npm', 'left-pad'],
    ['an uncovered scope', 'npm', '@other/widget'],
    ['a Composer name', 'composer', 'acme/widget'],
  ] as const)('stays absent for %s', async (_label, ecosystem, name) => {
    const h = harness();
    const outcome = await h.module().visibilityPort.resolve(actor, ecosystem, name);
    expect(outcome).toEqual({ kind: 'absent' });
  });
});

describe('npm route seams', () => {
  const bulk = '/:project/npm/-/npm/v1/security/advisories/bulk';
  const auditContext = () => ({
    ...context('https://broker.test/request-project/npm/-/npm/v1/security/advisories/bulk', {}),
    org: orgContext('request-org'),
    projectId: 'request-project',
    request: new Request(
      'https://broker.test/request-project/npm/-/npm/v1/security/advisories/bulk',
      {
        method: 'POST',
        body: JSON.stringify({ lodash: ['4.17.20'] }),
      },
    ),
  });

  it.each([false, true])(
    'assembles audit forwarding with request org/project and request observability=%s',
    async (scoped) => {
      const h = harness();
      const ctx = auditContext();
      const requestObservability = { log: vi.fn() };
      if (scoped)
        Object.assign(ctx, {
          ports: { ...ctx.ports, platform: { observability: requestObservability } },
        });
      const observability = scoped ? requestObservability : h.deps.ports.observability;
      const classifyWinners = vi.fn<CatalogueReader['classifyWinners']>(async () => [
        {
          key: 'lodash',
          winner: { sourceId: 'npmjs', sourceType: 'npmjs_proxy' },
        },
      ]);
      const hasAttachedProxy = vi.fn(async () => true);
      const authorizeNpmAudit = vi.fn<NpmAuditAuthorizer['authorizeNpmAudit']>(
        async (org) =>
          ({
            orgId: org.orgId,
            tuples: [{ name: 'lodash', version: '4.17.20' }],
          }) as unknown as AuthorizedNpmAudit,
      );
      const advisory = {
        id: 1,
        title: 'Public advisory',
        severity: 'high',
        vulnerable_versions: '<4.17.21',
      };
      const fetch = vi.fn<PolicyFetch>(async () => ({
        status: 200,
        headers: new Headers(),
        body: new Response(JSON.stringify({ lodash: [advisory] })).body,
      }));
      const policyFetch = vi.fn<RegistryModuleDeps['policyFetch']>(() => fetch);
      const module = createRegistryModule({
        ...h.deps,
        registry: { ...h.deps.registry, npmAudit: { enabled: true } },
        catalogue: { ...h.deps.catalogue, reader: { ...h.deps.catalogue.reader, classifyWinners } },
        npmAudit: { sources: { hasAttachedProxy }, provenance: { authorizeNpmAudit } },
        policyFetch,
      });
      const response = await routeOf(module.ecosystemRoutes, 'POST', bulk).handler(ctx);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ lodash: [advisory] });
      expect(hasAttachedProxy).toHaveBeenCalledExactlyOnceWith(ctx.org, 'request-project', 'npm');
      expect(classifyWinners).toHaveBeenCalledExactlyOnceWith(ctx.org, {
        projectId: 'request-project',
        ecosystem: 'npm',
        keys: ['lodash'],
      });
      expect(authorizeNpmAudit).toHaveBeenCalledExactlyOnceWith(ctx.org, [
        { sourceId: 'npmjs', key: 'lodash', version: '4.17.20' },
      ]);
      expect(policyFetch).toHaveBeenCalledExactlyOnceWith(h.deps.registry.userAgent.default, {
        observability,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(fetch.mock.calls[0]![0].body)).toBe('{"lodash":["4.17.20"]}');
      expect(observability!.log).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses audit with 501 when enabled without npmAudit dependencies', async () => {
    const h = harness();
    const module = createRegistryModule({
      ...h.deps,
      registry: { ...h.deps.registry, npmAudit: { enabled: true } },
    });
    const response = await routeOf(module.ecosystemRoutes, 'POST', bulk).handler(auditContext());
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: 'npm audit is unavailable on this broker',
      code: 'unsupported',
      requestId: 'req-1',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(h.policyFetch).not.toHaveBeenCalled();
  });

  it('builds the actor from the access context with exactly the read permission', async () => {
    const h = harness();
    const { ecosystemRoutes } = h.module();
    const ctx = context('https://broker.test/demo/npm/-/v1/search?text=x', { project: 'demo' });
    const response = await routeOf(ecosystemRoutes, 'GET', SEARCH).handler(ctx);
    expect(response.status).toBe(200);
    const [, query] = h.reader.search.mock.calls[0] as unknown as [
      { orgId: string },
      { projectId: string },
    ];
    expect(query.projectId).toBe('proj-1');
  });

  it('answers 503 and reads nothing when the request has no access context', async () => {
    const h = harness();
    const { ecosystemRoutes } = h.module();
    const ctx = context(
      'https://broker.test/demo/npm/-/v1/search?text=x',
      { project: 'demo' },
      {
        snapshot: false,
      },
    );
    const response = await routeOf(ecosystemRoutes, 'GET', SEARCH).handler(ctx);
    expect(response.status).toBe(503);
    expect(h.reader.search).not.toHaveBeenCalled();
  });

  it('answers 503 when a session holder lacks the read permission', async () => {
    const h = harness();
    const { ecosystemRoutes } = h.module();
    const ctx = context(
      'https://broker.test/demo/npm/-/v1/search?text=x',
      { project: 'demo' },
      {
        actor: {
          session: { id: 's' },
          user: { id: 'user-1' },
          organizationPermissions: ['org:admin'],
          projectPermissions: ['project:admin'],
          protectedHolder: false,
        },
      },
    );
    const response = await routeOf(ecosystemRoutes, 'GET', SEARCH).handler(ctx);
    expect(response.status).toBe(503);
    expect(h.reader.search).not.toHaveBeenCalled();
  });

  it('answers whoami with a 404 when no handle is bound', async () => {
    const h = harness();
    const { ecosystemRoutes } = h.module();
    const ctx = context('https://broker.test/demo/npm/-/whoami', { project: 'demo' });
    const response = await routeOf(ecosystemRoutes, 'GET', '/:project/npm/-/whoami').handler(ctx);
    expect(response.status).toBe(404);
  });
});

const incomplete = () => {
  const outcome = visibleNpm({ ecosystem: 'npm', key: 'left-pad' });
  if (outcome.kind !== 'visible') throw new Error('unreachable');
  return outcome.pkg;
};

describe('continuation', () => {
  const admitted: PackageVisibility = {
    kind: 'proxy_admissible',
    projectId: 'proj-1',
    ecosystem: 'npm',
    key: 'left-pad',
    sourceIds: ['src-1'],
  };

  it.each(['node', 'cloudflare'] as const)(
    'rejects a streamed packument above the configured cap before applying it on %s',
    async (runtime) => {
      const h = harness();
      h.deps = {
        ...h.deps,
        runtime,
        outboundPolicy: { ...h.deps.outboundPolicy, runtime },
        registry: resolveRegistryConfig(
          { caps: { metadataBytes: 128 } },
          runtime,
          'https://broker.test',
        ),
        policyFetch: () =>
          createPolicyFetch({
            policy: h.deps.outboundPolicy,
            userAgent: 'PackageBroker/2',
            fetchImpl: async () =>
              new Response(
                JSON.stringify({ name: 'left-pad', readme: 'x'.repeat(256), versions: {} }),
              ),
          }),
      };
      const { ecosystemRoutes } = h.module();
      const ctx = context(
        'https://broker.test/demo/npm/left-pad',
        { project: 'demo', a: 'left-pad' },
        { outcome: admitted },
      );
      const response = await routeOf(ecosystemRoutes, 'GET', '/:project/npm/:a').handler(ctx);
      expect(response.status).toBe(502);
      expect(applyChunk).not.toHaveBeenCalled();
      expect(h.jobs.enqueue).not.toHaveBeenCalled();
    },
  );

  it('enqueues exactly one package-sync job with the session payload after releasing the session', async () => {
    const h = harness();
    vi.mocked(applyChunk).mockImplementation(async () => {
      h.reader.resolveVersions.mockResolvedValue({
        pkg: { ...incomplete(), listingComplete: false },
        versions: [],
        next: null,
        binding: { packageId: 'pk', sourceId: 'src-1', rev: 1 },
      } as never);
      return progress;
    });
    const { ecosystemRoutes } = h.module();
    const ctx = context(
      'https://broker.test/demo/npm/left-pad',
      { project: 'demo', a: 'left-pad' },
      { outcome: admitted },
    );
    const response = await routeOf(ecosystemRoutes, 'GET', '/:project/npm/:a').handler(ctx);
    expect(response.status).toBe(503);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
    const [, type, payload] = h.jobs.enqueue.mock.calls[0] as unknown as [unknown, string, unknown];
    expect(type).toBe('core:package-sync:v1');
    expect(payload).toEqual({
      sourceId: 'src-1',
      key: 'left-pad',
      sessionId: 'session-1',
      generation: 1,
      step: 1,
    });
    expect(h.jobs.enqueue.mock.calls[0]?.[3]).toEqual(
      await packageSyncEnqueueInput(payload as never),
    );
    expect(h.events.indexOf('release')).toBeLessThan(h.events.indexOf('enqueue'));
    expect(h.events.filter((event) => event === 'enqueue')).toHaveLength(1);
  });

  it('does not enqueue for a request that needs no continuation', async () => {
    const h = harness();
    const { ecosystemRoutes } = h.module();
    const ctx = context('https://broker.test/demo/npm/-/v1/search?text=x', { project: 'demo' });
    await routeOf(ecosystemRoutes, 'GET', SEARCH).handler(ctx);
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('answers 503 when a continuation is needed and the job port is absent', async () => {
    const h = harness({ jobs: false });
    const { ecosystemRoutes } = h.module();
    const ctx = context(
      'https://broker.test/demo/npm/left-pad',
      { project: 'demo', a: 'left-pad' },
      { outcome: admitted },
    );
    const response = await routeOf(ecosystemRoutes, 'GET', '/:project/npm/:a').handler(ctx);
    expect(response.status).toBe(503);
    expect(h.events).not.toContain('enqueue');
    expect(
      h.sessions.release.mock.calls.length + h.sessions.abandon.mock.calls.length,
    ).toBeGreaterThan(0);
  });
});

describe('dist wiring', () => {
  const distRoute = (h: ReturnType<typeof harness>) =>
    routeOf(h.module().ecosystemRoutes, 'GET', '/:project/dist/:vendor/:name/:file');
  const distContext = () =>
    context(
      `https://broker.test/demo/dist/acme/lib/${VERSION_ID}.1.zip`,
      { project: 'demo', vendor: 'acme', name: 'lib', file: `${VERSION_ID}.1.zip` },
      { outcome: visibleNpm() },
    );

  it('answers the uniform 404 when the catalogue returns no dist target for the requested ids', async () => {
    const h = harness();
    const response = await distRoute(h).handler(distContext());
    expect(response.status).toBe(404);
    expect(h.reader.resolveDist).toHaveBeenCalledTimes(1);
    expect(h.blob.get).not.toHaveBeenCalled();
    expect(h.policyFetch).not.toHaveBeenCalled();
  });

  it('plans a fetch from the catalogue row of the target ids and answers 404 when the row no longer matches', async () => {
    const h = harness();
    h.reader.resolveDist.mockResolvedValue({
      versionId: VERSION_ID,
      revision: 1,
      current: true,
      packageId: 'pk',
      sourceId: 'src-1',
      status: 'active',
      blob: null,
      fetch: {
        sourceRef: null,
        upstreamDistUrl: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
        distType: 'zip',
        composerShasum: null,
        npmIntegrity: null,
        npmShasum: null,
      },
    } as never);
    const response = await distRoute(h).handler(distContext());
    expect(response.status).toBe(404);
    expect(h.versionById).toHaveBeenCalledWith(org, { packageId: 'pk', versionId: VERSION_ID });
    expect(h.policyFetch).not.toHaveBeenCalled();
  });
});

const npmPage = (project: string, complete: boolean) => ({
  pkg: { ...incomplete(), projectId: project, listingComplete: complete },
  versions: [
    {
      versionId: 'ver1',
      revision: 1,
      version: '1.0.0',
      versionNormalized: '1.0.0',
      stability: 'stable',
      status: 'active',
      publishedAt: '2020-01-02T00:00:00Z',
      upstreamReleasedAt: null,
      license: null,
      distType: 'tgz',
      composerShasum: null,
      npmIntegrity: 'sha512-x',
      deprecatedMessage: null,
      metadataJson: JSON.stringify({ name: 'left-pad', version: '1.0.0', dist: {} }),
    },
  ],
  next: null,
  binding: { packageId: 'pk', sourceId: 'src-1', rev: 1 },
});

describe('actor and re-resolution', () => {
  const packument = (h: ReturnType<typeof harness>) =>
    routeOf(h.module().ecosystemRoutes, 'GET', '/:project/npm/:a');
  const request = (outcome: PackageVisibility) =>
    context(
      'https://broker.test/demo/npm/left-pad',
      { project: 'demo', a: 'left-pad' },
      { outcome },
    );
  const admitted: PackageVisibility = {
    kind: 'proxy_admissible',
    projectId: 'proj-1',
    ecosystem: 'npm',
    key: 'left-pad',
    sourceIds: ['src-1'],
  };

  it('hands access an actor holding exactly the read permission of the request project', async () => {
    const h = harness();
    const { ecosystemRoutes } = h.module();
    const access = vi.mocked(createPackageAccess).mock.results.at(-1)?.value as ReturnType<
      typeof createPackageAccess
    >;
    const search = vi.spyOn(access, 'search');
    const ctx = context('https://broker.test/demo/npm/-/v1/search?text=x', { project: 'demo' });
    await routeOf(ecosystemRoutes, 'GET', SEARCH).handler(ctx);
    const seen = search.mock.calls[0]?.[0];
    expect([...(seen?.permissions ?? [])]).toEqual([READ]);
    expect(seen).toMatchObject({
      kind: 'project',
      userId: 'user-1',
      orgId: org.orgId,
      projectId: 'proj-1',
    });
  });

  it('serves the package once the completed fill makes it visible to the project', async () => {
    const h = harness();
    vi.mocked(applyChunk).mockImplementation(async () => {
      h.reader.resolveVersions.mockResolvedValue(npmPage('proj-1', true) as never);
      return { ...progress, done: true, status: 'complete' };
    });
    const response = await packument(h).handler(request(admitted));
    expect(response.status).toBe(200);
  });

  it('answers 404 when the completed fill resolves to another project package', async () => {
    const h = harness();
    vi.mocked(applyChunk).mockImplementation(async () => {
      h.reader.resolveVersions.mockResolvedValue(npmPage('proj-2', true) as never);
      return { ...progress, done: true, status: 'complete' };
    });
    const response = await packument(h).handler(request(admitted));
    expect(response.status).toBe(404);
  });
});

describe('package actor requirement', () => {
  it.each([
    ['packument', 'https://broker.test/demo/npm/left-pad', '/:project/npm/:a'],
    ['search', 'https://broker.test/demo/npm/-/v1/search?text=x', SEARCH],
  ] as const)(
    'refuses a %s request that has an access snapshot but no kernel package actor',
    async (_label, url, route) => {
      const h = harness();
      const admitted: PackageVisibility = {
        kind: 'proxy_admissible',
        projectId: 'proj-1',
        ecosystem: 'npm',
        key: 'left-pad',
        sourceIds: ['src-1'],
      };
      const ctx = context(
        url,
        { project: 'demo', a: 'left-pad' },
        { outcome: admitted, packageActor: false },
      );
      const response = await routeOf(h.module().ecosystemRoutes, 'GET', route).handler(ctx);
      expect([503, 404]).toContain(response.status);
      expect(h.sessions.acquire).not.toHaveBeenCalled();
      expect(h.policyFetch).not.toHaveBeenCalled();
      expect(h.reader.resolveVersions).not.toHaveBeenCalled();
      expect(h.reader.search).not.toHaveBeenCalled();
    },
  );
});

describe('stale refresh', () => {
  it('enqueues one fresh sync through packageSyncEnqueueInput, keyed by freshness window', async () => {
    const h = harness();
    const deferred: (() => Promise<void>)[] = [];
    h.deps = { ...h.deps, defer: (thunk) => void deferred.push(thunk) };
    h.reader.resolveVersions.mockResolvedValue(npmPage('proj-1', true) as never);
    const { ecosystemRoutes } = createRegistryModule(h.deps);
    const handler = routeOf(ecosystemRoutes, 'GET', '/:project/npm/:a').handler;
    const visible = (): PackageVisibility => visibleNpm({ ecosystem: 'npm', key: 'left-pad' });
    const call = async () => {
      await handler(
        context(
          'https://broker.test/demo/npm/left-pad',
          { project: 'demo', a: 'left-pad' },
          { outcome: visible() },
        ),
      );
    };
    await call();
    expect(deferred).toHaveLength(1);
    await deferred[0]?.();
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
    const [, type, payload, input] = h.jobs.enqueue.mock.calls[0] as unknown as [
      unknown,
      string,
      { sourceId: string; key: string },
      { idempotencyKey: string; resourceKey: string },
    ];
    expect(type).toBe('core:package-sync:v1');
    expect(payload).toEqual({ sourceId: 'src-1', key: 'left-pad' });
    expect(input).toEqual(await packageSyncEnqueueInput(payload, input.idempotencyKey));
    time.at += 3600_000;
    await call();
    await deferred[1]?.();
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(2);
    const second = h.jobs.enqueue.mock.calls[1]?.[3] as unknown as { idempotencyKey: string };
    expect(second.idempotencyKey).not.toBe(input.idempotencyKey);
  });
});

describe('registry credential binding', () => {
  it.each([
    ['packagist_proxy', 'https://repo.packagist.org', '{"githubToken":true}'],
    ['composer_repository', 'https://packages.example.com', '{}'],
  ] as const)(
    'fails closed when the stored %s credential cannot be loaded',
    async (type, url, configJson) => {
      const h = harness();
      const record: SourceRecord = {
        ...npmjsSource,
        type,
        ecosystem: 'composer',
        url,
        configJson,
        credentialId: 'token',
      };
      vi.mocked(h.deps.catalogue.sources.get).mockResolvedValue(record);
      h.module();
      const { planFill } = vi.mocked(createOnDemandFill).mock.calls.at(-1)![0];
      await expect(planFill(org, record.id, 'acme/lib')).rejects.toMatchObject({
        name: 'SourceUnavailableError',
        reason: 'credential_unavailable',
      });
      expect(h.deps.ingest.credential).toHaveBeenCalledExactlyOnceWith(org, record);
      expect(h.policyFetch).not.toHaveBeenCalled();
    },
  );

  it('serves Packagist with token mode disabled without loading its stored credential', async () => {
    const h = harness();
    const record: SourceRecord = {
      ...npmjsSource,
      type: 'packagist_proxy',
      ecosystem: 'composer',
      url: 'https://repo.packagist.org',
      configJson: '{"githubToken":false}',
      credentialId: 'token',
    };
    vi.mocked(h.deps.catalogue.sources.get).mockResolvedValue(record);
    h.policyFetch.mockImplementation(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new Response(
        JSON.stringify({ packages: { 'acme/lib': [{ name: 'acme/lib', version: '1.0.0' }] } }),
      ).body,
    }));
    h.module();
    const { planFill } = vi.mocked(createOnDemandFill).mock.calls.at(-1)![0];
    const plan = await planFill(org, record.id, 'acme/lib');
    expect(plan).not.toBeNull();
    expect(await plan!.describe({}, new AbortController().signal)).toMatchObject({
      kind: 'found',
    });
    expect(h.deps.ingest.credential).not.toHaveBeenCalled();
    expect(h.policyFetch).toHaveBeenCalled();
  });
});

describe('unbindable source', () => {
  const admitted: PackageVisibility = {
    kind: 'proxy_admissible',
    projectId: 'proj-1',
    ecosystem: 'npm',
    key: 'left-pad',
    sourceIds: ['src-1'],
  };
  const credentialed: SourceRecord = {
    ...npmjsSource,
    type: 'npm_registry',
    url: 'https://npm.acme.test',
    configJson: '{"scopes":["@acme"]}',
    credentialId: 'cred-1',
    lastError: null,
  };
  const scoped: PackageVisibility = { ...admitted, key: '@acme/x' } as PackageVisibility;

  function setup(record: SourceRecord, options: { sync?: boolean } = {}) {
    const h = harness();
    if (options.sync === true)
      h.deps = {
        ...h.deps,
        sync: {
          packageId: vi.fn(async () => null),
          upstreamState: {} as never,
          executor: { batch: vi.fn(async () => []) },
          writeGuard: vi.fn(() => [] as never),
        },
      };
    const cache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const write = vi.fn(async () => undefined);
    h.deps = {
      ...h.deps,
      ports: { ...h.deps.ports, cache } as RegistryModuleDeps['ports'],
      ingest: { ...h.deps.ingest, credentialUnavailable: write },
    };
    vi.mocked(h.deps.catalogue.sources.get).mockResolvedValue(record);
    const { ecosystemRoutes } = h.module();
    const log = vi.mocked(h.deps.ports.observability!.log);
    const get = (outcome: PackageVisibility, name: string) =>
      routeOf(ecosystemRoutes, 'GET', '/:project/npm/:a').handler(
        context(
          `https://broker.test/demo/npm/${encodeURIComponent(name)}`,
          {
            project: 'demo',
            a: name,
          },
          { outcome },
        ),
      );
    const cacheWrites = () => cache.set.mock.calls.length;
    return { h, cache, write, log, get, cacheWrites };
  }

  it('answers a paused source with 404, no event and no negative entry', async () => {
    const t = setup({ ...npmjsSource, status: 'paused' } as SourceRecord);
    const response = await t.get(admitted, 'left-pad');
    expect(response.status).toBe(404);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(t.cacheWrites()).toBe(0);
    expect(t.h.policyFetch).not.toHaveBeenCalled();
    expect(t.log.mock.calls.map(([record]) => record.event)).not.toContain('source.unavailable');
    expect(t.write).not.toHaveBeenCalled();
  });

  it('answers an unreadable credential with 503, Retry-After and a reason-code event', async () => {
    const t = setup(credentialed);
    const response = await t.get(scoped, '@acme/x');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(t.cacheWrites()).toBe(0);
    expect(t.h.policyFetch).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith({
      level: 'warn',
      event: 'source.unavailable',
      reason_code: 'credential_unavailable',
      source_id: 'src-1',
    });
    const body = await response.text();
    expect(body).not.toContain('npm.acme.test');
    expect(body).not.toContain('cred-1');
  });

  it('answers an unparsable config with 503 and Retry-After without a credential write', async () => {
    const t = setup({ ...npmjsSource, configJson: '{' } as SourceRecord);
    const response = await t.get(admitted, 'left-pad');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(t.cacheWrites()).toBe(0);
    expect(t.write).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'source.unavailable', reason_code: 'config_invalid' }),
    );
  });

  it.each(['https://127.0.0.1', 'https://169.254.169.254', 'https://npm.acme.test:8443'])(
    'reports a configured URL the outbound policy refuses (%s) as policy_denied',
    async (url) => {
      const t = setup({ ...credentialed, url, credentialId: null });
      const response = await t.get(scoped, '@acme/x');
      expect(response.status).toBe(503);
      expect(t.log).toHaveBeenCalledWith({
        level: 'warn',
        event: 'source.unavailable',
        reason_code: 'policy_denied',
        source_id: 'src-1',
      });
      expect(JSON.stringify(t.log.mock.calls)).not.toContain(new URL(url).hostname);
      expect(await response.text()).not.toContain(new URL(url).hostname);
    },
  );

  it('refuses a source whose provider is not registered as unavailable', async () => {
    const record = {
      ...npmjsSource,
      type: 'vcs',
      ecosystem: 'composer',
      url: null,
      configJson: '{"provider":"git","repository":"https://git.example.com/a/b.git"}',
    } as SourceRecord;
    const t = setup(record);
    const { planFill } = vi.mocked(createOnDemandFill).mock.calls.at(-1)![0];
    await expect(planFill(org, record.id, 'acme/lib')).rejects.toMatchObject({
      name: 'SourceUnavailableError',
      reason: 'provider_unavailable',
    });
    expect(t.write).not.toHaveBeenCalled();
  });

  it('writes credential_unavailable once and not again while the source holds it', async () => {
    const t = setup(credentialed);
    await Promise.all([t.get(scoped, '@acme/x'), t.get(scoped, '@acme/x')]);
    expect(t.write).toHaveBeenCalledExactlyOnceWith(org, 'src-1');
    vi.mocked(t.h.deps.catalogue.sources.get).mockResolvedValue({
      ...credentialed,
      lastError: 'credential_unavailable',
    });
    for (let i = 0; i < 3; i += 1) expect((await t.get(scoped, '@acme/x')).status).toBe(503);
    expect(t.write).toHaveBeenCalledTimes(1);
    vi.mocked(t.h.deps.catalogue.sources.get).mockResolvedValue({
      ...credentialed,
      lastError: null,
    });
    expect((await t.get(scoped, '@acme/x')).status).toBe(503);
    expect(t.write).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an unreadable credential', 503, credentialed],
    ['an unparsable config', 503, { ...npmjsSource, configJson: '{' } as SourceRecord],
    ['a paused source', 404, { ...npmjsSource, status: 'paused' } as SourceRecord],
  ] as const)('answers an archive request for %s with %i', async (_label, status, record) => {
    const t = setup(record);
    t.h.reader.resolveDist.mockResolvedValue({
      versionId: VERSION_ID,
      revision: 1,
      current: true,
      packageId: 'pk',
      sourceId: 'src-1',
      status: 'active',
      blob: null,
      fetch: {
        sourceRef: null,
        upstreamDistUrl: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
        distType: 'zip',
        composerShasum: null,
        npmIntegrity: null,
        npmShasum: null,
      },
    } as never);
    t.h.versionById.mockResolvedValue({ packageName: 'acme/lib', version: '1.0.0' } as never);
    const response = await routeOf(
      t.h.module().ecosystemRoutes,
      'GET',
      '/:project/dist/:vendor/:name/:file',
    ).handler(
      context(
        `https://broker.test/demo/dist/acme/lib/${VERSION_ID}.1.zip`,
        { project: 'demo', vendor: 'acme', name: 'lib', file: `${VERSION_ID}.1.zip` },
        { outcome: visibleNpm() },
      ),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get('retry-after')).toBe(status === 503 ? '60' : null);
    expect(t.h.policyFetch).not.toHaveBeenCalled();
    const body = await response.text();
    expect(body).not.toContain('npm.acme.test');
    expect(body).not.toContain('registry.npmjs.org');
  });

  it('answers 503 when the credential write itself fails', async () => {
    const t = setup(credentialed);
    t.write.mockRejectedValue(new Error('db down'));
    expect((await t.get(scoped, '@acme/x')).status).toBe(503);
  });

  it('keeps the package-sync job outcome for an unbindable source a silent no-op', async () => {
    const t = setup(credentialed, { sync: true });
    expect(t.h.module().packageSyncJob).toBeDefined();
    const syncDeps = vi.mocked(createPackageSyncJob).mock.calls.at(-1)![0];
    expect(await syncDeps.planFill(org, 'src-1', '@acme/x')).toBeNull();
    expect(t.write).toHaveBeenCalledTimes(1);
  });
});
