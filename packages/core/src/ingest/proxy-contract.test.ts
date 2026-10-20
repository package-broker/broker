import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessContext } from '../authz/access-context.js';
import { PACKAGES_READ } from '../catalogue/package-access.js';
import type { CatalogueReader, CatalogueWriteGuard } from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import type { SourceRecord } from '../db/source.js';
import type { UpstreamState } from '../db/upstream-state.js';
import { systemClock } from '../ids.js';
import { setContextPackageActor } from '../internal/package-actor.js';
import { setResolvedPackage } from '../internal/package-context.js';
import { setWaitUntil } from '../kernel/execution.js';
import type { JobContext } from '../platform/jobs.js';
import type { PlatformPorts, RequestContext } from '../plugin.js';
import { createRegistryModule, type RegistryModule } from '../registry/module.js';
import { resolveRegistryConfig } from '../registry/registry-config.js';
import { createOutboundPolicy } from '../sources/url-policy.js';
import { createPolicyFetch } from '../sources/policy-fetch.js';
import type { ProviderContext, ProviderSource } from '../sources/provider.js';
import { applyChunk, type ApplyDeps, type ApplyOutcome } from './apply-description.js';
import { describePackagist, PackagistBusyError } from './composer/packagist-proxy.js';
import { createNpmjsProxyProvider } from './npm/npmjs-proxy.js';
import { COALESCE_POLL_MS } from './coalesce.js';
import { createPackageSyncJob, PACKAGE_SYNC_JOB_TYPE } from './package-sync-job.js';
import type { IngestSessionHandle } from './session.js';

vi.mock('./apply-description.js', async (original) => ({
  ...(await original<typeof import('./apply-description.js')>()),
  applyChunk: vi.fn(),
}));

const org = orgContext('org-1');
const NOW = '2026-10-20T00:00:00Z';
const NPMJS = 'https://registry.npmjs.org';
const PACKAGIST = 'https://repo.packagist.org';
const SECOND_AGENT = 'second-source/1.0';
const base: IngestSessionHandle = {
  id: 'session',
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
const complete: ApplyOutcome = {
  done: true,
  status: 'complete',
  session: base,
  cursor: null,
  skipped: [],
  refused: [],
  duplicates: [],
  tagsSkipped: false,
  skippedTags: [],
  planned: 1,
};

const source = (over: Record<string, unknown>) =>
  ({
    projectId: null,
    credentialId: null,
    configJson: '{}',
    userAgent: null,
    status: 'active',
    ...over,
  }) as unknown as SourceRecord;
const SOURCES: Record<string, SourceRecord> = {
  'src-1': source({
    id: 'src-1',
    name: 'npmjs',
    ecosystem: 'npm',
    type: 'npmjs_proxy',
    url: NPMJS,
  }),
  'src-2': source({
    id: 'src-2',
    name: 'npmjs-two',
    ecosystem: 'npm',
    type: 'npmjs_proxy',
    url: NPMJS,
    userAgent: SECOND_AGENT,
  }),
  'src-c': source({
    id: 'src-c',
    name: 'packagist',
    ecosystem: 'composer',
    type: 'packagist_proxy',
    url: PACKAGIST,
  }),
  'src-h': source({
    id: 'src-h',
    name: 'hosted',
    ecosystem: 'npm',
    type: 'vcs',
    url: 'https://example.test/repo.git',
  }),
};

interface Deferred {
  readonly promise: Promise<void>;
  open(): void;
}
function deferred(): Deferred {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

interface UpstreamCall {
  readonly url: string;
  readonly headers: Headers;
}
type Reply = () => Response;

function createUpstream() {
  const calls: UpstreamCall[] = [];
  const replies = new Map<string, Reply>();
  const arrived = deferred();
  let gate: Deferred | null = null;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    arrived.open();
    if (gate !== null) await gate.promise;
    const reply = replies.get(url);
    if (reply === undefined) throw new Error('unexpected upstream request');
    return reply();
  };
  return {
    calls,
    fetchImpl,
    arrived: arrived.promise,
    on(url: string, reply: Reply) {
      replies.set(url, reply);
    },
    hold(): Deferred {
      gate = deferred();
      return gate;
    },
    count: (url: string) => calls.filter((call) => call.url === url).length,
  };
}
type Upstream = ReturnType<typeof createUpstream>;

const packument =
  (name: string, etag = '"v1"') =>
  (): Response =>
    new Response(
      JSON.stringify({
        name,
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name,
            version: '1.0.0',
            dist: { tarball: `${NPMJS}/${name}/-/${name}-1.0.0.tgz`, integrity: 'sha512-AAAA' },
          },
        },
        time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
      }),
      { status: 200, headers: { etag, 'content-type': 'application/json' } },
    );
const composerBody = (name: string) => (): Response =>
  new Response(
    JSON.stringify({
      minified: 'composer/2.0',
      packages: {
        [name]: [
          {
            name,
            version: '1.0.0',
            dist: { type: 'zip', url: 'https://example.test/a.zip', reference: 'abc' },
          },
        ],
      },
    }),
    { status: 200, headers: { etag: '"c1"', 'content-type': 'application/json' } },
  );
const status =
  (code: number, body = '', headers: Record<string, string> = {}): Reply =>
  () =>
    new Response(body === '' ? null : body, { status: code, headers });
const NPM_NOT_FOUND = '{"error":"Not found"}';
const COMPOSER_NOT_FOUND = '{"packages":[]}';

function versionOf(ecosystem: 'npm' | 'composer', key: string) {
  return {
    versionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    revision: 1,
    version: '1.0.0',
    versionNormalized: '1.0.0.0',
    stability: 'stable',
    status: 'active',
    publishedAt: NOW,
    upstreamReleasedAt: null,
    license: null,
    distType: ecosystem === 'npm' ? 'tgz' : 'zip',
    composerShasum: null,
    npmIntegrity: null,
    deprecatedMessage: null,
    metadataJson: JSON.stringify({ name: key, dist: { reference: 'abc' } }),
  };
}

interface Catalogue {
  readonly filled: Set<string>;
  readonly held: Set<string>;
  readonly admitted: Map<string, readonly string[]>;
  upstreamState: UpstreamState | null;
}

interface SharedPorts {
  readonly leases: Map<string, string>;
  readonly cache: Map<string, unknown>;
  readonly jobs: ReturnType<typeof vi.fn>;
  readonly sessions: ReturnType<typeof createSessions>;
  readonly negativeReads: ReturnType<typeof createBarrier>;
}

function createBarrier() {
  let pending: { size: number; arrived: number; gate: Deferred } | null = null;
  return {
    expect(size: number) {
      pending = { size, arrived: 0, gate: deferred() };
    },
    async pass() {
      const current = pending;
      if (current === null) return;
      current.arrived += 1;
      if (current.arrived === current.size) {
        pending = null;
        current.gate.open();
      }
      await current.gate.promise;
    },
  };
}

function createSessions(leases: Map<string, string>) {
  let sequence = 0;
  const held = deferred();
  const released = deferred();
  const scopeKey = (scope: { sourceId?: string; packageKey?: string }) =>
    `${scope.sourceId}\u0000${scope.packageKey}`;
  const drop = async (_ctx: unknown, handle: IngestSessionHandle) => {
    if (leases.get(handle.scopeKey) === handle.id) leases.delete(handle.scopeKey);
    if (leases.size === 0) released.open();
    return true;
  };
  return {
    held: held.promise,
    released: released.promise,
    scopeKey,
    acquire: vi.fn(async (_ctx: unknown, scope: object, owner: string) => {
      const key = scopeKey(scope);
      if (leases.has(key)) {
        held.open();
        return 'held' as const;
      }
      sequence += 1;
      const id = `session-${sequence}`;
      leases.set(key, id);
      return { ...base, id, owner, scopeKey: key };
    }),
    latest: vi.fn(async (_ctx: unknown, scope: object) => {
      const id = leases.get(scopeKey(scope));
      return id === undefined
        ? null
        : { id, state: 'running' as const, generation: 1, fence: 1, seenCount: 0, pagesSoFar: 0 };
    }),
    start: vi.fn(async () => true),
    advance: vi.fn(async () => null),
    setPendingValidators: vi.fn(async () => true),
    abandon: vi.fn(drop),
    discard: vi.fn(drop),
    release: vi.fn(drop),
  };
}

function createShared(): SharedPorts {
  const leases = new Map<string, string>();
  return {
    leases,
    cache: new Map(),
    jobs: vi.fn(async () => ({ id: 'job', created: true })),
    sessions: createSessions(leases),
    negativeReads: createBarrier(),
  };
}

function createCatalogue(): Catalogue {
  return {
    filled: new Set(),
    held: new Set(),
    admitted: new Map(),
    upstreamState: null,
  };
}

function admit(catalogue: Catalogue, project: string, key: string, sourceIds: readonly string[]) {
  catalogue.admitted.set(`${project}|${key}`, sourceIds);
}

interface Mounted {
  readonly module: RegistryModule;
  readonly deferred: Promise<unknown>[];
  readonly backgrounds: (() => Promise<void>)[];
}

function mount(fixture: {
  upstream: Upstream;
  catalogue: Catalogue;
  shared: SharedPorts;
}): Mounted {
  const { upstream, catalogue, shared } = fixture;
  const backgrounds: (() => Promise<void>)[] = [];
  const packageOf = (projectId: string, key: string) => ({
    projectId,
    ecosystem: key.includes('/') ? ('composer' as const) : ('npm' as const),
    key,
    packageId: `pk-${key}`,
    sourceId: catalogue.held.has(key) ? 'src-h' : key.includes('/') ? 'src-c' : 'src-1',
    rev: 1,
    createdAt: NOW,
    modifiedAt: NOW,
    listingComplete: true,
    cacheEpoch: '1',
  });
  const visibleTo = (query: { projectId: string; key: string }) =>
    (catalogue.filled.has(query.key) || catalogue.held.has(query.key)) &&
    catalogue.admitted.has(`${query.projectId}|${query.key}`);
  const reader = {
    resolveVersions: vi.fn(async (_ctx: unknown, query: { projectId: string; key: string }) => {
      if (!visibleTo(query)) return null;
      const pkg = packageOf(query.projectId, query.key);
      return {
        pkg,
        versions: [versionOf(pkg.ecosystem, query.key)],
        next: null,
        binding: { packageId: pkg.packageId, sourceId: pkg.sourceId, rev: pkg.rev },
      };
    }),
    admitProxy: vi.fn(async (_ctx: unknown, query: { projectId: string; key: string }) => [
      ...(catalogue.filled.has(query.key)
        ? []
        : (catalogue.admitted.get(`${query.projectId}|${query.key}`) ?? [])),
    ]),
    distTags: vi.fn(async (_ctx: unknown, query: { projectId: string; key: string }) =>
      visibleTo(query)
        ? { pkg: packageOf(query.projectId, query.key), tags: { latest: '1.0.0' } }
        : null,
    ),
    search: vi.fn(async () => []),
    resolveDist: vi.fn(async () => null),
  };
  const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
  const ports = {
    blob: { get: vi.fn(async () => null), head: vi.fn(async () => null) },
    cache: {
      get: async (_ctx: unknown, key: { kind: string }) => {
        if (key.kind === 'negative') await shared.negativeReads.pass();
        return shared.cache.get(JSON.stringify(key)) ?? null;
      },
      set: async (_ctx: unknown, key: unknown, entry: unknown) => {
        shared.cache.set(JSON.stringify(key), { entry, state: 'fresh' });
      },
      delete: async (_ctx: unknown, key: unknown) => {
        shared.cache.delete(JSON.stringify(key));
      },
    },
    observability: { log: vi.fn() },
    jobs: { enqueue: shared.jobs, get: vi.fn(async () => null) },
  } as unknown as Partial<PlatformPorts>;
  const module = createRegistryModule({
    runtime: 'node',
    ports,
    clock: systemClock,
    codecs: {} as never,
    publicUrl: 'https://broker.test',
    registry: resolveRegistryConfig(undefined, 'node', 'https://broker.test'),
    outboundPolicy: policy,
    policyFetch: (userAgent) =>
      createPolicyFetch({ fetchImpl: upstream.fetchImpl, policy, userAgent }),
    deploymentId: 'dep-1',
    defer: (thunk) => {
      backgrounds.push(thunk);
    },
    catalogue: {
      reader: reader as unknown as CatalogueReader,
      scopedAdmission: { admitScoped: vi.fn(async () => []) },
      epoch: { read: async () => '1' },
      representationClock: {
        advance: vi.fn(async (_ctx: unknown, input: { validator: string }) => ({
          stale: false,
          validator: input.validator,
          lastModified: NOW,
        })),
      } as never,
      upstreamState: { get: vi.fn(async () => catalogue.upstreamState) },
      sources: { get: vi.fn(async (_ctx: unknown, id: string) => SOURCES[id] ?? null) },
      covers: vi.fn(async () => false),
      versionById: vi.fn(async () => null),
    },
    ingest: {
      sessions: shared.sessions as never,
      apply: { sessions: shared.sessions } as unknown as ApplyDeps,
      writeGuard: vi.fn(() => [] as unknown as CatalogueWriteGuard),
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
      writeGuard: vi.fn(() => [] as unknown as CatalogueWriteGuard),
      writer: { attachDist: vi.fn(), quarantine: vi.fn() } as never,
      blobReplacer: { replaceBlob: vi.fn() },
      recorder: { record: vi.fn() },
    },
  });
  return { module, deferred: [], backgrounds };
}

interface Target {
  readonly ecosystem: 'npm' | 'composer';
  readonly name: string;
  readonly sourceId: string;
  readonly urls: readonly string[];
  readonly ok: Reply;
  readonly missing: Reply;
}
const NPM: Target = {
  ecosystem: 'npm',
  name: 'left-pad',
  sourceId: 'src-1',
  urls: [`${NPMJS}/left-pad`],
  ok: packument('left-pad'),
  missing: status(404, NPM_NOT_FOUND),
};
const COMPOSER: Target = {
  ecosystem: 'composer',
  name: 'acme/lib',
  sourceId: 'src-c',
  urls: [`${PACKAGIST}/p2/acme/lib.json`, `${PACKAGIST}/p2/acme/lib~dev.json`],
  ok: composerBody('acme/lib'),
  missing: status(404, COMPOSER_NOT_FOUND),
};
const TARGETS = [NPM, COMPOSER] as const;

function stubUpstream(upstream: Upstream, target: Target, reply: Reply) {
  for (const url of target.urls) upstream.on(url, reply);
}

function requestContext(target: Target, project: string, orgId: string): RequestContext {
  const [vendor, rest] = target.name.split('/');
  const url =
    target.ecosystem === 'npm'
      ? `https://broker.test/demo/npm/${target.name}`
      : `https://broker.test/demo/p2/${vendor}/${rest}.json`;
  const params =
    target.ecosystem === 'npm'
      ? { project: 'demo', a: target.name }
      : { project: 'demo', vendor: vendor ?? '', file: `${rest}.json` };
  const ctx = {
    request: new Request(url),
    requestId: 'req-1',
    org: orgContext(orgId),
    principal: { kind: 'user', id: 'user-1' },
    projectId: project,
    params,
    ports: { clock: systemClock },
  } as unknown as RequestContext;
  setAccessContext(ctx, {
    principal: { kind: 'user', id: 'user-1' },
    projectId: project,
    boundary: 'project',
    sessionId: null,
    token: { kind: 'pat', scope: null, readOnly: true },
    actor: null,
    rateKey: {
      stage: 'authenticated',
      tokenSelector: 'sel',
      principalId: 'user-1',
      routeClass: 'project',
    },
  });
  setContextPackageActor(
    ctx,
    Object.freeze({
      kind: 'project',
      userId: 'user-1',
      orgId: orgContext(orgId).orgId,
      projectId: project,
      permissions: new Set([PACKAGES_READ]),
    }),
  );
  return ctx;
}

async function get(
  mounted: Mounted,
  target: Target,
  project = 'proj-1',
  orgId = 'org-1',
): Promise<Response> {
  const ctx = requestContext(target, project, orgId);
  setWaitUntil(ctx, (work) => {
    mounted.deferred.push(work);
  });
  const outcome = await mounted.module.visibilityPort.resolve(
    {
      kind: 'project',
      userId: 'user-1',
      orgId: orgContext(orgId).orgId,
      projectId: project,
      permissions: new Set([PACKAGES_READ]),
    },
    target.ecosystem,
    target.name,
  );
  if (outcome.kind !== 'absent') setResolvedPackage(ctx, outcome);
  const path = target.ecosystem === 'npm' ? '/:project/npm/:a' : '/:project/p2/:vendor/:file';
  const route = mounted.module.ecosystemRoutes.find((entry) => entry.path === path);
  if (route === undefined) throw new Error('route not mounted');
  return route.handler(ctx);
}

async function settleBackground(mounted: Mounted): Promise<void> {
  const results = await Promise.allSettled([
    ...mounted.backgrounds.map((thunk) => thunk()),
    ...mounted.deferred,
  ]);
  expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
}

const scheduled = (mounted: Mounted) => mounted.backgrounds.length + mounted.deferred.length;

function fixture() {
  const upstream = createUpstream();
  const catalogue = createCatalogue();
  const shared = createShared();
  vi.mocked(applyChunk)
    .mockReset()
    .mockImplementation(async (_ctx, _deps, input) => {
      catalogue.filled.add(input.source.key);
      return complete;
    });
  return { upstream, catalogue, shared, mount: () => mount({ upstream, catalogue, shared }) };
}

const STEP_MS = 250;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function elapse(ms: number): Promise<void> {
  await flush();
  for (let spent = 0; spent < ms; spent += STEP_MS) {
    await vi.advanceTimersByTimeAsync(Math.min(STEP_MS, ms - spent));
    await flush();
  }
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(TARGETS)('$ecosystem proxy: coalescing', (target) => {
  function gated(reply: Reply, mounts: number) {
    const f = fixture();
    admit(f.catalogue, 'proj-1', target.name, [target.sourceId]);
    stubUpstream(f.upstream, target, reply);
    const gate = f.upstream.hold();
    const mounted = Array.from({ length: mounts }, () => f.mount());
    f.shared.negativeReads.expect(20);
    const pending = Array.from({ length: 20 }, (_, index) => get(mounted[index % mounts]!, target));
    return { f, gate, pending };
  }

  async function overSecondCoalescer(reply: Reply) {
    const { f, gate, pending } = gated(reply, 2);
    await Promise.all([f.upstream.arrived, f.shared.sessions.held]);
    // The waiting coalescer arms its poll timer in the microtasks that follow the 'held' answer.
    await flush();
    gate.open();
    await f.shared.sessions.released;
    await vi.advanceTimersByTimeAsync(COALESCE_POLL_MS);
    return { f, responses: await Promise.all(pending) };
  }

  it('collapses 20 concurrent misses on one coalescer into one fetch per upstream document', async () => {
    const { f, gate, pending } = gated(target.ok, 1);
    await f.upstream.arrived;
    gate.open();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
    for (const url of target.urls) expect(f.upstream.count(url)).toBe(1);
  });

  it('answers 404, never 503, to every waiter of a definitive 404', async () => {
    const { f, gate, pending } = gated(target.missing, 1);
    await f.upstream.arrived;
    gate.open();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(404));
    for (const url of target.urls) expect(f.upstream.count(url)).toBe(1);
  });

  it('answers 404 to waiters of a second coalescer on a definitive 404', async () => {
    const { f, responses } = await overSecondCoalescer(target.missing);
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(404));
    for (const url of target.urls) expect(f.upstream.count(url)).toBe(1);
    expect(f.shared.leases.size).toBe(0);
  });

  it('fetches once across two coalescers that share the database lease', async () => {
    const { f, responses } = await overSecondCoalescer(target.ok);
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
    for (const url of target.urls) expect(f.upstream.count(url)).toBe(1);
    expect(f.shared.leases.size).toBe(0);
  });

  it('answers 503 with Retry-After when another holder keeps the lease past the wait budget', async () => {
    const f = fixture();
    admit(f.catalogue, 'proj-1', target.name, [target.sourceId]);
    stubUpstream(f.upstream, target, target.ok);
    const leaseKey = f.shared.sessions.scopeKey({
      sourceId: target.sourceId,
      packageKey: target.name,
    });
    f.shared.leases.set(leaseKey, 'other-instance');
    const blocked = get(f.mount(), target);
    await f.shared.sessions.held;
    await flush();
    await vi.advanceTimersByTimeAsync(26_000);
    const response = await blocked;
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('10');
    expect(f.upstream.calls).toEqual([]);
    expect(f.shared.leases.get(leaseKey)).toBe('other-instance');
  });
});

describe.each(TARGETS)('$ecosystem proxy: negative cache', (target) => {
  it('caches a definitive 404 for 30 s and asks upstream again afterwards', async () => {
    const f = fixture();
    admit(f.catalogue, 'proj-1', target.name, [target.sourceId]);
    stubUpstream(f.upstream, target, target.missing);
    const mounted = f.mount();
    const total = () => target.urls.reduce((sum, url) => sum + f.upstream.count(url), 0);
    expect((await get(mounted, target)).status).toBe(404);
    const afterFirst = total();
    expect(afterFirst).toBeGreaterThan(0);
    await elapse(29_000);
    expect((await get(mounted, target)).status).toBe(404);
    expect(total()).toBe(afterFirst);
    await elapse(2_000);
    expect((await get(mounted, target)).status).toBe(404);
    expect(total()).toBe(afterFirst * 2);
  });

  it('does not let one project negative entry answer for another project', async () => {
    const f = fixture();
    admit(f.catalogue, 'proj-1', target.name, [target.sourceId]);
    admit(f.catalogue, 'proj-2', target.name, [target.sourceId]);
    stubUpstream(f.upstream, target, target.missing);
    const mounted = f.mount();
    expect((await get(mounted, target, 'proj-1')).status).toBe(404);
    const afterFirst = f.upstream.calls.length;
    expect((await get(mounted, target, 'proj-2')).status).toBe(404);
    expect(f.upstream.calls.length).toBe(afterFirst * 2);
  });

  it('does not let one organization negative entry answer for another organization', async () => {
    const f = fixture();
    admit(f.catalogue, 'proj-1', target.name, [target.sourceId]);
    stubUpstream(f.upstream, target, target.missing);
    const mounted = f.mount();
    expect((await get(mounted, target, 'proj-1', 'org-1')).status).toBe(404);
    const afterFirst = f.upstream.calls.length;
    expect((await get(mounted, target, 'proj-1', 'org-2')).status).toBe(404);
    expect(f.upstream.calls.length).toBe(afterFirst * 2);
  });

  it('never asks upstream for a name the project is not admitted to, whatever other projects cached', async () => {
    const f = fixture();
    admit(f.catalogue, 'proj-1', target.name, [target.sourceId]);
    stubUpstream(f.upstream, target, target.missing);
    const mounted = f.mount();
    await get(mounted, target, 'proj-1');
    const afterFirst = f.upstream.calls.length;
    expect((await get(mounted, target, 'proj-3')).status).toBe(404);
    expect(f.upstream.calls.length).toBe(afterFirst);
  });
});

describe('npm proxy: not-found evidence', () => {
  it('does not cache a 404 whose body is not the registry not-found shape', async () => {
    const f = fixture();
    admit(f.catalogue, 'proj-1', NPM.name, ['src-1']);
    f.upstream.on(`${NPMJS}/left-pad`, status(404, '<html>nope</html>'));
    const mounted = f.mount();
    expect((await get(mounted, NPM)).status).toBe(502);
    expect((await get(mounted, NPM)).status).toBe(502);
    expect(f.upstream.count(`${NPMJS}/left-pad`)).toBe(2);
  });
});

describe('npm proxy: no fallback to another source', () => {
  it.each([401, 403, 500, 503])(
    'answers 502 and sends no request for the second source after upstream %i',
    async (code) => {
      const f = fixture();
      admit(f.catalogue, 'proj-1', NPM.name, ['src-1', 'src-2']);
      f.upstream.on(`${NPMJS}/left-pad`, status(code));
      const response = await get(f.mount(), NPM);
      expect(response.status).toBe(502);
      expect(f.upstream.calls).toHaveLength(1);
      expect(f.upstream.calls[0]?.headers.get('user-agent') ?? '').not.toContain(SECOND_AGENT);
      expect(f.catalogue.filled.size).toBe(0);
    },
  );

  it('does not turn an upstream failure into a cached absence', async () => {
    const f = fixture();
    admit(f.catalogue, 'proj-1', NPM.name, ['src-1', 'src-2']);
    f.upstream.on(`${NPMJS}/left-pad`, status(401));
    const mounted = f.mount();
    await get(mounted, NPM);
    await get(mounted, NPM);
    expect(f.upstream.count(`${NPMJS}/left-pad`)).toBe(2);
  });
});

describe('composer proxy: busy upstream', () => {
  async function busyRequest() {
    const f = fixture();
    admit(f.catalogue, 'proj-1', COMPOSER.name, ['src-c']);
    stubUpstream(f.upstream, COMPOSER, status(429, '', { 'retry-after': '5' }));
    const pending = get(f.mount(), COMPOSER);
    await elapse(0);
    return { f, response: await pending };
  }

  it('never sleeps on Retry-After in the request and never retries', async () => {
    const { f, response } = await busyRequest();
    for (const url of COMPOSER.urls) expect(f.upstream.count(url)).toBe(1);
    expect(f.catalogue.filled.size).toBe(0);
    expect(response.status).toBe(502);
  });

  it.fails('answers 503 unavailable carrying the upstream Retry-After', async () => {
    const { response } = await busyRequest();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
  });
});

describe.each(TARGETS)('$ecosystem proxy: admission', (target) => {
  it('makes zero upstream calls when no source is admitted to the project', async () => {
    const f = fixture();
    stubUpstream(f.upstream, target, target.ok);
    const response = await get(f.mount(), target);
    expect(response.status).toBe(404);
    expect(f.upstream.calls).toHaveLength(0);
  });
});

describe.each(TARGETS)('$ecosystem proxy: held package freshness', (target) => {
  const heldState = (over: Partial<UpstreamState> = {}): UpstreamState => ({
    etag: '"v1"',
    lastModified: null,
    contentSha256: null,
    checkedAt: '2026-10-19T00:00:00.000Z',
    freshUntil: '2026-10-20T00:05:00.000Z',
    notFoundCount: 0,
    firstNotFoundAt: null,
    ...over,
  });
  const proxied = (f: ReturnType<typeof fixture>, state: UpstreamState) => {
    admit(f.catalogue, 'proj-1', target.name, [target.sourceId]);
    f.catalogue.filled.add(target.name);
    f.catalogue.upstreamState = state;
  };

  it('serves a package held from a hosted source without an upstream call or stale mark', async () => {
    const f = fixture();
    admit(f.catalogue, 'proj-1', target.name, ['src-h']);
    f.catalogue.held.add(target.name);
    const mounted = f.mount();
    const response = await get(mounted, target);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-broker-stale')).toBeNull();
    expect(f.upstream.calls).toHaveLength(0);
    expect(scheduled(mounted)).toBe(0);
    expect(f.shared.jobs).not.toHaveBeenCalled();
  });

  it('serves a fresh proxied package with no upstream call, no job and no stale mark', async () => {
    const f = fixture();
    proxied(f, heldState());
    const mounted = f.mount();
    const response = await get(mounted, target);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-broker-stale')).toBeNull();
    expect(scheduled(mounted)).toBe(0);
    expect(f.upstream.calls).toHaveLength(0);
  });

  it.each([
    ['one second past the TTL', '2026-10-19T23:59:59.000Z', 0],
    ['years past the TTL', '2020-01-01T00:00:00.000Z', 0],
    ['a recorded upstream 404', '2026-10-20T00:05:00.000Z', 1],
  ])(
    'serves stale with the header %s and refreshes only in the background',
    async (_label, freshUntil, notFoundCount) => {
      const f = fixture();
      proxied(f, heldState({ freshUntil, notFoundCount }));
      const mounted = f.mount();
      const response = await get(mounted, target);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-broker-stale')).toBe('1');
      expect(f.upstream.calls).toHaveLength(0);
      expect(scheduled(mounted)).toBe(1);
      await settleBackground(mounted);
      expect(f.shared.jobs).toHaveBeenCalledTimes(1);
      expect(f.shared.jobs.mock.calls[0]?.[1]).toBe(PACKAGE_SYNC_JOB_TYPE);
      expect(f.shared.jobs.mock.calls[0]?.[2]).toEqual({
        sourceId: target.sourceId,
        key: target.name,
      });
    },
  );

  it('uses one refresh job key for every stale request in the same TTL window', async () => {
    const f = fixture();
    proxied(f, heldState({ freshUntil: '2020-01-01T00:00:00.000Z' }));
    const mounted = f.mount();
    for (let each = 0; each < 5; each += 1) await get(mounted, target);
    await settleBackground(mounted);
    const keys = new Set(
      f.shared.jobs.mock.calls.map(
        (call) => (call[3] as { idempotencyKey: string }).idempotencyKey,
      ),
    );
    expect(f.shared.jobs).toHaveBeenCalledTimes(5);
    expect(keys.size).toBe(1);
  });

  it('keeps serving stale when enqueueing the refresh fails', async () => {
    const f = fixture();
    proxied(f, heldState({ freshUntil: '2020-01-01T00:00:00.000Z' }));
    f.shared.jobs.mockRejectedValue(new Error('queue down'));
    const mounted = f.mount();
    const response = await get(mounted, target);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-broker-stale')).toBe('1');
    expect(scheduled(mounted)).toBe(1);
    await settleBackground(mounted);
    expect(f.shared.jobs).toHaveBeenCalledTimes(1);
  });
});

const REGISTRY_TTL_SECONDS = resolveRegistryConfig(undefined, 'node', 'https://broker.test').timers
  .metadataTtlSeconds;

describe('revalidation job', () => {
  const npmValidators = { 'npm-full': { etag: '"v1"' } } as const;
  const composerValidators = {
    'composer-p2': { etag: '"c1"' },
    'composer-p2-dev': { etag: '"d1"' },
  } as const;
  const P2 = COMPOSER.urls[0]!;
  const DEV = COMPOSER.urls[1]!;
  const NPM_URL = NPM.urls[0]!;

  function jobHarness(upstream: Upstream, target: Target) {
    vi.mocked(applyChunk).mockReset().mockResolvedValue(complete);
    const policy = createOutboundPolicy({
      allowPrivateHosts: [],
      runtime: 'node',
      selfOrigins: [],
    });
    const fetch = createPolicyFetch({
      fetchImpl: upstream.fetchImpl,
      policy,
      userAgent: 'pb-test',
    });
    const provider = createNpmjsProxyProvider({
      store: {} as never,
      orgOf: () => org,
    });
    const npmSource: ProviderSource = {
      id: 'src-1',
      type: 'npmjs_proxy',
      ecosystem: 'npm',
      url: NPMJS,
      providerId: 'npmjs',
      config: {},
    } as unknown as ProviderSource;
    const providerContext = (signal: AbortSignal): ProviderContext => ({
      org,
      fetch,
      credential: null,
      codecs: undefined as never,
      signal,
      clock: systemClock,
      observability: undefined as never,
    });
    const shared = createShared();
    const batch = vi.fn(async () => []);
    const touch = vi.fn(() => []);
    const notFound = vi.fn(() => []);
    const reset = vi.fn(() => []);
    const markAbsent = vi.fn(async () => undefined);
    const npm = target.ecosystem === 'npm';
    const job = createPackageSyncJob({
      sessions: shared.sessions as never,
      apply: {
        sessions: shared.sessions,
        writer: { markPackageAbsent: markAbsent },
      } as unknown as ApplyDeps,
      jobs: { enqueue: vi.fn() } as never,
      upstreamState: {
        touchStatements: touch,
        notFoundStatements: notFound,
        resetNotFoundStatements: reset,
      },
      executor: { batch } as never,
      sourceMetadata: async () => ({ type: npm ? ('npmjs_proxy' as const) : 'packagist_proxy' }),
      planFill: async () => ({
        source: {
          id: target.sourceId,
          key: target.name,
          type: npm ? 'npmjs_proxy' : 'packagist_proxy',
          ecosystem: target.ecosystem,
          covered: false,
        },
        toVersion: () => null,
        packageDescription: null,
        validatorTtlSeconds: REGISTRY_TTL_SECONDS,
        publishedValidators: npm ? npmValidators : composerValidators,
        describe: async (options, signal) => {
          if (npm)
            return provider.describe(providerContext(signal), npmSource, target.name, options);
          const result = await describePackagist(fetch, target.name, {
            path: 'request',
            clock: systemClock,
            signal,
            ...(options.validators === undefined ? {} : { validators: options.validators }),
          });
          if (result.kind === 'busy') throw new PackagistBusyError(result.retryAfterSeconds);
          return result;
        },
      }),
      findPackageId: async () => `pk-${target.name}`,
      writeGuard: () => [] as unknown as CatalogueWriteGuard,
    });
    const context = {
      org,
      jobId: 'job-1',
      idempotencyKey: 'k',
      attempt: 1,
      fence: 1,
      signal: new AbortController().signal,
      ports: {},
      observability: { log: vi.fn() },
    } as unknown as JobContext;
    const payload = { sourceId: target.sourceId, key: target.name };
    return { job, context, payload, batch, touch, notFound, markAbsent, shared };
  }

  it('sends the stored validator and lets a 304 refresh the npm upstream state only', async () => {
    const upstream = createUpstream();
    upstream.on(NPM_URL, status(304));
    const h = jobHarness(upstream, NPM);
    await h.job.handler(h.payload, h.context);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.headers.get('if-none-match')).toBe('"v1"');
    expect(h.touch).toHaveBeenCalledTimes(1);
    expect(h.touch.mock.calls[0]).toEqual([
      org,
      'pk-left-pad',
      'npm-packument',
      REGISTRY_TTL_SECONDS,
    ]);
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect(applyChunk).not.toHaveBeenCalled();
    expect(h.markAbsent).not.toHaveBeenCalled();
    expect(h.shared.leases.size).toBe(0);
  });

  it('lets two 304s refresh both Packagist forms only', async () => {
    const upstream = createUpstream();
    upstream.on(P2, status(304));
    upstream.on(DEV, status(304));
    const h = jobHarness(upstream, COMPOSER);
    await h.job.handler(h.payload, h.context);
    expect(upstream.count(P2)).toBe(1);
    expect(upstream.count(DEV)).toBe(1);
    expect(upstream.calls.find((call) => call.url === P2)?.headers.get('if-none-match')).toBe(
      '"c1"',
    );
    expect(upstream.calls.find((call) => call.url === DEV)?.headers.get('if-none-match')).toBe(
      '"d1"',
    );
    expect(h.touch.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
      'composer-p2',
      'composer-p2-dev',
    ]);
    expect(applyChunk).not.toHaveBeenCalled();
    expect(h.markAbsent).not.toHaveBeenCalled();
    expect(h.shared.leases.size).toBe(0);
  });

  it.each([
    ['dev answers 200', P2, DEV, '"c1"'],
    ['p2 answers 200', DEV, P2, '"d1"'],
  ])(
    'refetches the other Packagist form unconditionally when %s',
    async (_label, unchanged, changed, validator) => {
      const upstream = createUpstream();
      let calls = 0;
      upstream.on(unchanged, () => {
        calls += 1;
        return calls === 1 ? new Response(null, { status: 304 }) : composerBody(COMPOSER.name)();
      });
      upstream.on(changed, composerBody(COMPOSER.name));
      const h = jobHarness(upstream, COMPOSER);
      await h.job.handler(h.payload, h.context);
      const sent = upstream.calls.filter((call) => call.url === unchanged);
      expect(sent).toHaveLength(2);
      expect(sent[0]?.headers.get('if-none-match')).toBe(validator);
      expect(sent[1]?.headers.get('if-none-match')).toBeNull();
      expect(upstream.count(changed)).toBe(1);
      expect(applyChunk).toHaveBeenCalledTimes(1);
      expect(h.touch).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 500, 503])(
    'leaves the catalogue and state untouched and releases the lease on upstream %i',
    async (code) => {
      const upstream = createUpstream();
      upstream.on(NPM_URL, status(code));
      const h = jobHarness(upstream, NPM);
      await expect(h.job.handler(h.payload, h.context)).rejects.toMatchObject({
        code: 'handler_error',
      });
      expect(h.touch).not.toHaveBeenCalled();
      expect(h.notFound).not.toHaveBeenCalled();
      expect(h.batch).not.toHaveBeenCalled();
      expect(applyChunk).not.toHaveBeenCalled();
      expect(h.markAbsent).not.toHaveBeenCalled();
      expect(h.shared.leases.size).toBe(0);
    },
  );

  it('does not mark a package absent for a 404 that is not definitive', async () => {
    const upstream = createUpstream();
    upstream.on(NPM_URL, status(404, '<html>nope</html>'));
    const h = jobHarness(upstream, NPM);
    await expect(h.job.handler(h.payload, h.context)).rejects.toMatchObject({
      code: 'handler_error',
    });
    expect(h.markAbsent).not.toHaveBeenCalled();
    expect(h.notFound).not.toHaveBeenCalled();
  });

  it('applies a changed document instead of touching state', async () => {
    const upstream = createUpstream();
    upstream.on(NPM_URL, packument('left-pad'));
    const h = jobHarness(upstream, NPM);
    await h.job.handler(h.payload, h.context);
    expect(applyChunk).toHaveBeenCalledTimes(1);
    expect(h.touch).not.toHaveBeenCalled();
  });
});
