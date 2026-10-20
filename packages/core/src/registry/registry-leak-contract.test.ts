import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { createAuthorizationEngine, patValidationGate } from '../authz/engine.js';
import type { EngineSessionAccess, EngineTokenAccess } from '../authz/engine.js';
import { displayName } from '../catalogue/names.js';
import { catalogueCacheKey } from '../catalogue/cache-keys.js';
import { createPackageAccess } from '../catalogue/package-access.js';
import type {
  CatalogueReader,
  CatalogueVersion,
  PackageResolution,
  ResolvedPackage,
} from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { OnDemandFill } from '../ingest/on-demand.js';
import { contextPackageActorOf } from '../internal/package-actor.js';
import { createKernel } from '../kernel/kernel.js';
import type { Cache, CacheEnvelope } from '../platform/cache.js';
import { createScopedCache } from '../platform/cache.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import type { RepresentationClock } from './conditional.js';
import { composerRoutes } from './composer/routes.js';
import type { DistService } from './dist-service.js';
import { parseNpmPath } from './npm/paths.js';
import { npmRoutes } from './npm/routes.js';

const org = orgContext('org-1');
const VERSION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const REVALIDATE = 'private, no-cache';
const ABBREVIATED = 'application/vnd.npm.install-v1+json';
const cookie = { cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` };
const PERMISSIONS = ['project:read', 'project:packages:read'];
const PROJECTS: Record<string, { id: string; permissions: readonly string[] }> = {
  alpha: { id: 'proj-a', permissions: PERMISSIONS },
  beta: { id: 'proj-b', permissions: PERMISSIONS },
  gamma: { id: 'proj-g', permissions: [] },
};

const projectAccess = (slug: string | null) => {
  const project = slug === null ? undefined : PROJECTS[slug];
  return {
    project: project === undefined ? null : { id: project.id },
    projectPermissions: [...(project?.permissions ?? [])],
  };
};

const key = (projectId: string, ecosystem: string, name: string) =>
  `${projectId}|${ecosystem}|${name}`;

function resolved(projectId: string, ecosystem: 'composer' | 'npm', name: string): ResolvedPackage {
  return {
    projectId,
    ecosystem,
    key: name,
    packageId: `pkg-${projectId}-${name}`,
    sourceId: `src-${projectId}`,
    rev: 1,
    modifiedAt: '2026-10-01T00:00:00Z',
    createdAt: '2026-10-01T00:00:00Z',
    listingComplete: true,
    cacheEpoch: '1',
  };
}

const ALPHA_IDS = [VERSION_ID, '01ARZ3NDEKTSV4RRFFQ69G5FAW'] as const;
const BETA_IDS = [
  '01ARZ3NDEKTSV4RRFFQ69G5FBV',
  '01ARZ3NDEKTSV4RRFFQ69G5FBW',
  '01ARZ3NDEKTSV4RRFFQ69G5FBX',
] as const;
const BETA_MARKERS = [
  '2.0.0',
  ...BETA_IDS,
  'b'.repeat(40),
  'beta-ref',
  'beta-sha',
  'sha512-beta',
  'beta-marker',
];

interface VersionSpec {
  id: string;
  version: string;
  stability?: 'stable' | 'dev';
  beta?: boolean;
}

function versionOf(
  ecosystem: 'composer' | 'npm',
  name: string,
  { id, version, stability = 'stable', beta = false }: VersionSpec,
): CatalogueVersion {
  return {
    versionId: id,
    revision: 2,
    version,
    versionNormalized: version,
    stability,
    status: 'active',
    publishedAt: '2026-10-01T00:00:00Z',
    upstreamReleasedAt: null,
    license: null,
    distType: ecosystem === 'npm' ? 'tgz' : 'zip',
    composerShasum: ecosystem === 'composer' && beta ? 'beta-sha' : null,
    npmIntegrity: ecosystem === 'npm' ? (beta ? 'sha512-beta' : 'sha512-x') : null,
    deprecatedMessage: null,
    metadataJson: JSON.stringify(
      ecosystem === 'npm'
        ? {
            name,
            version,
            dist: { shasum: (beta ? 'b' : 'a').repeat(40) },
            ...(beta ? { description: 'beta-marker' } : {}),
          }
        : { name, dist: { reference: beta ? 'beta-ref' : 'abc' } },
    ),
  };
}

interface Seed {
  projectId: string;
  ecosystem: 'composer' | 'npm';
  name: string;
  versions: CatalogueVersion[];
  tags: Record<string, string>;
}

function seed(projectId: string, ecosystem: 'composer' | 'npm', name: string, extra = false): Seed {
  const beta = projectId === 'proj-b';
  const ids = beta ? BETA_IDS : ALPHA_IDS;
  const versions = [versionOf(ecosystem, name, { id: ids[0], version: '1.0.0', beta })];
  if (ecosystem === 'composer') {
    versions.push(
      versionOf(ecosystem, name, { id: ids[1], version: 'dev-main', stability: 'dev', beta }),
    );
  }
  if (extra) {
    versions.push(versionOf(ecosystem, name, { id: BETA_IDS[2], version: '2.0.0', beta }));
  }
  return { projectId, ecosystem, name, versions, tags: { latest: extra ? '2.0.0' : '1.0.0' } };
}

const SEEDS = [
  seed('proj-a', 'composer', 'acme/own'),
  seed('proj-a', 'npm', 'own-pkg'),
  seed('proj-a', 'composer', 'acme/shared'),
  seed('proj-a', 'npm', 'shared-pkg'),
  seed('proj-a', 'npm', '@scope/shared'),
  seed('proj-b', 'composer', 'acme/secret'),
  seed('proj-b', 'npm', 'secret-pkg'),
  seed('proj-b', 'npm', '@scope/secret'),
  seed('proj-b', 'composer', 'acme/shared', true),
  seed('proj-b', 'npm', 'shared-pkg', true),
  seed('proj-b', 'npm', '@scope/shared', true),
];

function fixture() {
  const entries = new Map<
    string,
    { resolution: PackageResolution; tags: Record<string, string> }
  >();
  for (const item of SEEDS) {
    const pkg = resolved(item.projectId, item.ecosystem, item.name);
    entries.set(key(item.projectId, item.ecosystem, item.name), {
      resolution: {
        pkg,
        versions: item.versions,
        next: null,
        binding: { packageId: pkg.packageId, sourceId: pkg.sourceId, rev: pkg.rev },
      },
      tags: item.tags,
    });
  }
  const admissible = new Set([
    key('proj-b', 'composer', 'acme/proxied'),
    key('proj-b', 'npm', 'proxied-pkg'),
    key('proj-a', 'npm', 'ownproxy-pkg'),
  ]);
  const projectsQueried = new Set<string>();
  const seen = <T extends { projectId: string }>(query: T): T => {
    projectsQueried.add(query.projectId);
    return query;
  };
  const find = (query: { projectId: string; ecosystem: string; key: string }) =>
    entries.get(key(seen(query).projectId, query.ecosystem, query.key));
  const listed = (projectId: string, ecosystem: string) =>
    [...entries.values()]
      .map(({ resolution }) => resolution.pkg)
      .filter((pkg) => pkg.projectId === projectId && pkg.ecosystem === ecosystem)
      .map((pkg) => ({
        key: pkg.key,
        packageId: pkg.packageId,
        sourceId: pkg.sourceId,
        description: null,
      }));
  const reader: CatalogueReader = {
    resolveVersions: async (_ctx, query) => find(query)?.resolution ?? null,
    lookupVersion: async (_ctx, query) => {
      const found = find(query);
      const version = found?.resolution.versions.find(
        (candidate) => candidate.versionNormalized === query.versionNormalized,
      );
      return found === undefined || version === undefined
        ? null
        : { pkg: found.resolution.pkg, version };
    },
    lookupTag: async (_ctx, query) => {
      const found = find(query);
      const target = found?.tags[query.tag];
      const version = found?.resolution.versions.find(
        (candidate) => candidate.versionNormalized === target,
      );
      return found === undefined || version === undefined
        ? null
        : { pkg: found.resolution.pkg, version };
    },
    distTags: async (_ctx, query) => {
      const found = find(query);
      return found === undefined ? null : { pkg: found.resolution.pkg, tags: found.tags };
    },
    listVisible: async (_ctx, query) => ({
      items: listed(seen(query).projectId, query.ecosystem),
      next: null,
      openNamespace: false,
    }),
    search: async (_ctx, query) =>
      listed(seen(query).projectId, query.ecosystem).filter((item) =>
        item.key.includes(query.text),
      ),
    resolveDist: async (_ctx, query) => {
      seen(query);
      return null;
    },
    admitProxy: async (_ctx, query) =>
      admissible.has(key(seen(query).projectId, query.ecosystem, query.key))
        ? [`src-${query.projectId}`]
        : [],
    pageEdges: async () => ({ items: [], next: null }) as never,
    classify: async () => [],
    classifyWinners: async () => [],
    previewWinners: async () => [],
  };
  return { reader, projectsQueried, admissible };
}

const store = () => {
  const entries = new Map<string, CacheEnvelope>();
  const writes: string[] = [];
  const raw: Cache = {
    get: async (_ctx, bound) => {
      const entry = entries.get(bound.digest);
      return entry === undefined ? null : { entry, state: 'fresh' };
    },
    set: async (_ctx, bound, entry) => {
      writes.push(bound.projectId);
      entries.set(bound.digest, entry);
    },
    delete: async () => undefined,
  };
  return { raw, writes };
};

type Auth = 'cookie' | 'bearer';
const AUTHS: Auth[] = ['cookie', 'bearer'];

async function harness(auth: Auth = 'cookie') {
  const { reader, projectsQueried, admissible } = fixture();
  const access = createPackageAccess(reader);
  const ensure = vi.fn<OnDemandFill['ensure']>(async (_actor, request) =>
    request.outcome.kind === 'visible' ? { kind: 'serve', stale: false } : { kind: 'not_found' },
  );
  const serve = vi.fn<DistService['serve']>(async () => ({ kind: 'not_found' }));
  const clock: RepresentationClock = {
    advance: async (_ctx, input) => ({
      stale: false,
      validator: input.validator,
      lastModified: input.projectId === 'proj-b' ? '2026-10-02T00:00:00Z' : '2026-10-01T00:00:00Z',
    }),
  };
  const { raw, writes } = store();
  const cache = createScopedCache(raw, { read: async () => '1' }, { deploymentId: 'test' });
  const routes = [
    ...composerRoutes({
      access,
      fill: { ensure },
      dist: { serve },
      clock,
      publicUrl: 'https://broker.test',
      cache,
    }),
    ...npmRoutes({
      access,
      dist: { serve },
      onDemand: { ensure },
      reresolve: async (ctx) => {
        const actor = contextPackageActorOf(ctx);
        const parsed = parseNpmPath(new URL(ctx.request.url).pathname.split('/').slice(3));
        if (actor === null || !('key' in parsed)) return { kind: 'absent' };
        return access.resolve(actor, 'npm', displayName(parsed.key));
      },
      handleOf: () => 'alice',
      publicUrl: 'https://broker.test',
      codecs: { gunzip: () => new TransformStream() },
    }),
  ];
  const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
  const token = formatToken('pat', 'abcdefghijkl', new Uint8Array(32).fill(9));
  const tokenAccess = Object.defineProperty(
    {
      token: {
        id: 'token-1',
        kind: 'pat',
        expired: false,
        revoked: false,
        lastUsedAt: null,
        userId: 'user-1',
        servicePrincipalId: null,
      },
      principalStatus: 'active',
      validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
      organizationPermissions: [],
    },
    'verifier',
    { value: { secretHash: await hashToken(keyring, 1, token), pepperVersion: 1 } },
  ) as unknown as EngineTokenAccess;
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-20T00:00:00Z'),
      ids: { ulid: () => VERSION_ID },
    },
    ecosystemRoutes: routes,
    packageResolver: access,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_ctx, input) =>
          ({
            session: { id: 'session-1', csrfHash: '' },
            user: { id: 'user-1' },
            identity: null,
            protectedHolder: false,
            organizationPermissions: [],
            ...projectAccess(input.projectSlug),
          }) satisfies EngineSessionAccess,
        lookupToken: async (_ctx, input) =>
          Object.defineProperty(
            { ...tokenAccess, ...projectAccess(input.projectSlug) },
            'verifier',
            Object.getOwnPropertyDescriptor(tokenAccess, 'verifier')!,
          ),
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: { keyring, nowMs: () => 0, dispatch: () => undefined, log: () => undefined },
      patValidation: patValidationGate,
      publicOrigin: 'https://broker.test',
      providerAnchors: async () => [],
    }),
    resolveOrg: async () => org,
    health: async () => true,
    log: () => undefined,
  });
  const credential = auth === 'cookie' ? cookie : { authorization: `Bearer ${token}` };
  const call = (path: string, init: RequestInit = {}) =>
    kernel.fetch(
      new Request(`https://broker.test${path}`, {
        ...init,
        headers: { ...credential, ...(init.headers as Record<string, string> | undefined) },
      }),
    );
  return {
    call,
    ensure,
    serve,
    projectsQueried,
    admissible,
    cache,
    writes,
  };
}

async function snapshot(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers].filter(([name]) => name !== 'x-request-id'),
    body: [...new Uint8Array(await response.arrayBuffer())],
  };
}

const distRef = (project: string) => `${project === 'beta' ? BETA_IDS[0] : VERSION_ID}.2.zip`;

interface Surface {
  name: string;
  path: (project: string, subject: string) => string;
  init?: RequestInit;
  fills?: boolean;
  serves?: boolean;
  validator?: 'etag' | 'last-modified';
}

const SURFACES: Surface[] = [
  {
    name: 'composer p2',
    path: (p, s) => `/${p}/p2/${s}.json`,
    fills: true,
    validator: 'last-modified',
  },
  {
    name: 'composer p2 ~dev',
    path: (p, s) => `/${p}/p2/${s}~dev.json`,
    fills: true,
    validator: 'last-modified',
  },
  {
    name: 'composer dist',
    path: (p, s) => `/${p}/dist/${s}/${distRef(p)}`,
    serves: true,
  },
  {
    name: 'npm packument full',
    path: (p, s) => `/${p}/npm/${s}`,
    fills: true,
    validator: 'etag',
  },
  {
    name: 'npm packument abbreviated',
    path: (p, s) => `/${p}/npm/${s}`,
    init: { headers: { accept: ABBREVIATED } },
    fills: true,
    validator: 'etag',
  },
  { name: 'npm version', path: (p, s) => `/${p}/npm/${s}/1.0.0`, fills: true },
  { name: 'npm tag', path: (p, s) => `/${p}/npm/${s}/latest`, fills: true },
  {
    name: 'npm tarball',
    path: (p, s) => `/${p}/npm/${s}/-/${s}-1.0.0.tgz`,
    fills: true,
    serves: true,
  },
  { name: 'npm dist-tags', path: (p, s) => `/${p}/npm/-/package/${s}/dist-tags` },
];

const subjectFor = (surface: Surface, subject: 'secret' | 'absent' | 'proxied' | 'shared') =>
  surface.name.startsWith('composer') ? `acme/${subject}` : `${subject}-pkg`;

async function observe(h: Awaited<ReturnType<typeof harness>>, path: string, init?: RequestInit) {
  const response = await h.call(path, init);
  const text = await response.text();
  const served = JSON.stringify(h.serve.mock.calls.map(([, request]) => request.versionId));
  return {
    response,
    text,
    served,
    leaks: BETA_MARKERS.filter((m) => text.includes(m) || served.includes(m)),
  };
}

describe('registry cross-project leak contract', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
  });
  afterEach(() => vi.restoreAllMocks());

  describe.each(AUTHS)('with %s credentials only', (auth) => {
    describe.each(SURFACES)('$name', (surface) => {
      it('answers a project-level package of another project with the byte-identical absent 404', async () => {
        const h = await harness(auth);
        const absent = await snapshot(
          await h.call(surface.path('alpha', subjectFor(surface, 'absent')), surface.init),
        );
        const foreign = await snapshot(
          await h.call(surface.path('alpha', subjectFor(surface, 'secret')), surface.init),
        );
        expect(absent.status).toBe(404);
        expect(foreign).toEqual(absent);
        expect(h.serve).not.toHaveBeenCalled();
        expect([...h.projectsQueried]).toEqual(['proj-a']);
      });

      it('answers a project the caller cannot read with the same 404 as an unknown project', async () => {
        const h = await harness(auth);
        const unknown = await snapshot(
          await h.call(surface.path('nowhere', subjectFor(surface, 'secret')), surface.init),
        );
        const denied = await snapshot(
          await h.call(surface.path('gamma', subjectFor(surface, 'secret')), surface.init),
        );
        expect(unknown.status).toBe(404);
        expect(denied).toEqual(unknown);
        expect(h.projectsQueried.size).toBe(0);
      });

      it('does not let validators tell absent from invisible', async () => {
        const h = await harness(auth);
        const conditional = {
          ...surface.init,
          headers: {
            ...(surface.init?.headers as Record<string, string> | undefined),
            'if-none-match': '*',
            'if-modified-since': 'Wed, 01 Jan 2031 00:00:00 GMT',
          },
        };
        const absent = await h.call(
          surface.path('alpha', subjectFor(surface, 'absent')),
          conditional,
        );
        const foreign = await h.call(
          surface.path('alpha', subjectFor(surface, 'secret')),
          conditional,
        );
        for (const response of [absent, foreign]) {
          expect(response.status).toBe(404);
          expect(response.headers.get('etag')).toBeNull();
          expect(response.headers.get('last-modified')).toBeNull();
        }
        expect(await snapshot(foreign)).toEqual(await snapshot(absent));
      });

      it('answers a name only another project may proxy with the absent 404', async () => {
        const h = await harness(auth);
        const absent = await snapshot(
          await h.call(surface.path('alpha', subjectFor(surface, 'absent')), surface.init),
        );
        const foreign = await snapshot(
          await h.call(surface.path('alpha', subjectFor(surface, 'proxied')), surface.init),
        );
        expect(foreign).toEqual(absent);
      });

      it('serves project A only its own representation of a name both projects hold', async () => {
        const h = await harness(auth);
        const subject = subjectFor(surface, 'shared');
        const beta = await observe(h, surface.path('beta', subject), surface.init);
        expect(beta.leaks).not.toEqual([]);

        h.projectsQueried.clear();
        h.serve.mockClear();
        h.ensure.mockClear();
        const alpha = await observe(h, surface.path('alpha', subject), surface.init);
        expect(alpha.leaks).toEqual([]);
        expect(alpha.response.status).toBe(surface.serves === true ? 404 : 200);
        expect([...h.projectsQueried]).toEqual(['proj-a']);
        if (surface.serves === true) {
          expect(h.serve).toHaveBeenCalledTimes(1);
          const [actor, request] = h.serve.mock.calls[0]!;
          expect(actor.projectId).toBe('proj-a');
          expect(request.versionId).toBe(VERSION_ID);
        }
      });
    });

    describe.each(SURFACES.filter((s) => s.validator !== undefined))(
      '$name validators',
      (surface) => {
        it('does not answer 304 to the validators of the same name in another project', async () => {
          const h = await harness(auth);
          const subject = subjectFor(surface, 'shared');
          const header = surface.validator!;
          const validatorOf = async (project: string) => {
            const response = await h.call(surface.path(project, subject), surface.init);
            await response.arrayBuffer();
            return response.headers.get(header);
          };
          const beta = await validatorOf('beta');
          const own = await validatorOf('alpha');
          expect(beta).not.toBeNull();
          expect(own).not.toBeNull();
          expect(own).not.toBe(beta);

          const conditional = await h.call(surface.path('alpha', subject), {
            ...surface.init,
            headers: {
              ...(surface.init?.headers as Record<string, string> | undefined),
              ...(header === 'etag' ? { 'if-none-match': beta! } : { 'if-modified-since': beta! }),
            },
          });
          expect(conditional.status).toBe(200);
          expect(conditional.headers.get(header)).toBe(own);
          expect((await conditional.text()).includes('2.0.0')).toBe(false);
        });
      },
    );

    describe.each(SURFACES.filter((s) => s.fills === true))('$name fills', (surface) => {
      it('makes no fill call for names visible only in another project or admissible only there', async () => {
        const h = await harness(auth);
        await h.call(surface.path('alpha', subjectFor(surface, 'secret')), surface.init);
        await h.call(surface.path('alpha', subjectFor(surface, 'proxied')), surface.init);
        expect(h.ensure).not.toHaveBeenCalled();
      });
    });
  });

  describe('HEAD', () => {
    it.each(['composer p2', 'npm packument full'])(
      'answers %s for another project package like an absent one, without a body',
      async (name) => {
        const surface = SURFACES.find((s) => s.name === name)!;
        const h = await harness();
        const head = { ...surface.init, method: 'HEAD' };
        const absent = await snapshot(
          await h.call(surface.path('alpha', subjectFor(surface, 'absent')), head),
        );
        const foreign = await snapshot(
          await h.call(surface.path('alpha', subjectFor(surface, 'secret')), head),
        );
        expect(absent.status).toBe(404);
        expect(foreign).toEqual(absent);
        expect(foreign.body).toEqual([]);
        expect([...h.projectsQueried]).toEqual(['proj-a']);
      },
    );
  });

  describe('scoped npm names', () => {
    it('answers a scoped package of another project like an absent one', async () => {
      const h = await harness();
      const absent = await snapshot(await h.call('/alpha/npm/@scope%2fabsent'));
      const foreign = await snapshot(await h.call('/alpha/npm/@scope%2fsecret'));
      expect(absent.status).toBe(404);
      expect(foreign).toEqual(absent);
      expect(h.serve).not.toHaveBeenCalled();
      expect([...h.projectsQueried]).toEqual(['proj-a']);
    });

    it('serves project A only its own scoped package when both projects hold the name', async () => {
      const h = await harness();
      for (const path of [
        '/alpha/npm/@scope%2fshared',
        '/alpha/npm/@scope%2fshared/1.0.0',
        '/alpha/npm/@scope%2fshared/latest',
        '/alpha/npm/-/package/@scope%2fshared/dist-tags',
      ]) {
        const alpha = await observe(h, path);
        expect(alpha.response.status).toBe(200);
        expect(alpha.leaks).toEqual([]);
      }
      const tarball = await h.call('/alpha/npm/@scope%2fshared/-/shared-1.0.0.tgz');
      await tarball.arrayBuffer();
      expect(h.serve).toHaveBeenCalledTimes(1);
      const [actor, request] = h.serve.mock.calls[0]!;
      expect(actor.projectId).toBe('proj-a');
      expect(request.versionId).toBe(VERSION_ID);
      expect([...h.projectsQueried]).toEqual(['proj-a']);
    });
  });

  it('forwards only the caller project to the reader when a name is admissible elsewhere', async () => {
    const h = await harness();
    const response = await h.call('/alpha/p2/acme/proxied.json');
    expect(response.status).toBe(404);
    expect(h.ensure).not.toHaveBeenCalled();
    expect([...h.projectsQueried]).toEqual(['proj-a']);
  });

  it('refuses admission when the reader admits no source', async () => {
    const h = await harness();
    h.admissible.delete('proj-a|npm|ownproxy-pkg');
    const response = await h.call('/alpha/npm/ownproxy-pkg');
    expect(response.status).toBe(404);
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('admits a name proxied in the caller project and reaches the fill', async () => {
    const h = await harness();
    const response = await h.call('/alpha/npm/ownproxy-pkg');
    expect(response.status).toBe(404);
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.ensure.mock.calls[0]?.[0].projectId).toBe('proj-a');
  });

  describe('listing surfaces', () => {
    it('keeps another project out of packages.json available-packages', async () => {
      const h = await harness();
      const response = await h.call('/alpha/packages.json');
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(REVALIDATE);
      expect(body['available-packages']).toEqual(['acme/own', 'acme/shared']);
      expect(JSON.stringify(body)).not.toContain('secret');
      expect(BETA_MARKERS.filter((m) => JSON.stringify(body).includes(m))).toEqual([]);
      expect([...h.projectsQueried]).toEqual(['proj-a']);
    });

    it('keeps another project out of npm search', async () => {
      const h = await harness();
      const response = await h.call('/alpha/npm/-/v1/search?text=pkg');
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(REVALIDATE);
      expect(text).toContain('own-pkg');
      expect(text).not.toContain('secret');
      const empty = await h.call('/alpha/npm/-/v1/search?text=secret');
      expect(((await empty.json()) as { total: number }).total).toBe(0);
    });

    it('lists a name both projects hold once, from the caller project only', async () => {
      const h = await harness();
      const response = await h.call('/alpha/npm/-/v1/search?text=shared');
      const body = (await response.json()) as {
        objects: { package: { name: string } }[];
        total: number;
      };
      expect(body.objects.map((o) => o.package.name).sort()).toEqual([
        '@scope/shared',
        'shared-pkg',
      ]);
      expect(body.total).toBe(2);
      expect(BETA_MARKERS.filter((m) => JSON.stringify(body).includes(m))).toEqual([]);
      expect([...h.projectsQueried]).toEqual(['proj-a']);
    });

    it('does not echo or forward names in audit forwarding (placeholder until forwarding exists)', async () => {
      const h = await harness('bearer');
      const response = await h.call('/alpha/npm/-/npm/v1/security/advisories/bulk', {
        method: 'POST',
        body: JSON.stringify({ 'secret-pkg': ['1.0.0'], 'own-pkg': ['1.0.0'] }),
        headers: { 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('secret');
      expect(h.projectsQueried.size).toBe(0);
    });
  });

  describe('registry success headers', () => {
    it.each([
      ['composer p2', '/alpha/p2/acme/own.json'],
      ['composer p2 ~dev', '/alpha/p2/acme/own~dev.json'],
      ['composer packages.json', '/alpha/packages.json'],
      ['npm packument', '/alpha/npm/own-pkg'],
      ['npm version', '/alpha/npm/own-pkg/1.0.0'],
      ['npm dist-tags', '/alpha/npm/-/package/own-pkg/dist-tags'],
    ])('serves %s with %s revalidation', async (_name, path) => {
      const h = await harness();
      const response = await h.call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(REVALIDATE);
    });
  });

  describe('cache', () => {
    it('does not make an entry filled in project B readable in project A', async () => {
      const h = await harness();
      const filled = await h.call('/beta/p2/acme/secret.json');
      expect(filled.status).toBe(200);
      await filled.arrayBuffer();
      expect(h.writes.length).toBeGreaterThan(0);
      expect(new Set(h.writes)).toEqual(new Set(['proj-b']));

      const pkgB = resolved('proj-b', 'composer', 'acme/secret');
      const asA = { ...catalogueCacheKey(pkgB, 'composer-p2'), projectId: 'proj-a' };
      const miss = await h.cache.get(org, asA);
      expect(miss.hit).toBeNull();
      const own = await h.cache.get(org, catalogueCacheKey(pkgB, 'composer-p2'));
      expect(own.hit).not.toBeNull();

      const viaA = await h.call('/alpha/p2/acme/secret.json');
      expect(viaA.status).toBe(404);
    });

    it('derives different cache keys for the same name in two projects', () => {
      const a = catalogueCacheKey(resolved('proj-a', 'composer', 'acme/shared'), 'composer-p2');
      const b = catalogueCacheKey(resolved('proj-b', 'composer', 'acme/shared'), 'composer-p2');
      expect(a).not.toEqual(b);
      expect(a.projectId).toBe('proj-a');
    });
  });
});
