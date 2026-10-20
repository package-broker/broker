import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizationEngine, patValidationGate } from '../../authz/engine.js';
import type { EngineSessionAccess } from '../../authz/engine.js';
import type { ProjectActor } from '../../authz/project-actor.js';
import { packageKey } from '../../catalogue/names.js';
import type { PackageAccess } from '../../catalogue/package-access.js';
import type {
  CatalogueVersion,
  PackageResolution,
  PackageVisibility,
  ResolvedPackage,
} from '../../db/catalogue.js';
import { orgContext, type OrgId } from '../../db/port.js';
import type { DistServeResult } from '../dist-service.js';
import type { OnDemandResult } from '../../ingest/on-demand.js';
import { fixedClock } from '../../ids.js';
import { setResolvedPackage } from '../../internal/package-context.js';
import { setAccessContext } from '../../authz/access-context.js';
import type { RequestContext } from '../../plugin.js';
import { createKernel } from '../../kernel/kernel.js';
import { createKeyring } from '../../secrets/keyring.js';
import { formatToken } from '../../secrets/token-format.js';
import { hashToken } from '../../secrets/token-hash.js';
import type { EngineTokenAccess } from '../../authz/engine.js';
import { npmRoutes, type NpmRouteDeps } from './routes.js';

const org = orgContext('org-1');
const ABBREVIATED = 'application/vnd.npm.install-v1+json';
const pkg: ResolvedPackage = {
  projectId: 'proj-1',
  ecosystem: 'npm',
  key: 'x',
  packageId: 'pkg-1',
  sourceId: 'src-1',
  rev: 3,
  createdAt: '2020-01-01T00:00:00Z',
  modifiedAt: '2020-01-03T00:00:00Z',
  listingComplete: true,
  cacheEpoch: null,
};
const version: CatalogueVersion = {
  versionId: 'ver1',
  revision: 2,
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
  metadataJson: JSON.stringify({ name: 'x', version: '1.0.0', dist: { shasum: 'a'.repeat(40) } }),
};
const page: PackageResolution = {
  pkg,
  versions: [version],
  next: null,
  binding: { packageId: 'pkg-1', sourceId: 'src-1', rev: 3 },
};
const visible = (overrides: Partial<ResolvedPackage> = {}): PackageVisibility => ({
  kind: 'visible',
  pkg: { ...pkg, ...overrides },
  cacheKey: () => {
    throw new Error('unused');
  },
  epochReader: { read: async () => null },
});
const admission: PackageVisibility = {
  kind: 'proxy_admissible',
  projectId: 'proj-1',
  ecosystem: 'npm',
  key: 'x',
  sourceIds: ['src-1'],
};
const actor: ProjectActor = {
  kind: 'project',
  userId: 'user-1',
  orgId: 'org-1' as OrgId,
  projectId: 'proj-1',
  permissions: new Set(['project:packages:read']),
};

interface Setup {
  outcome?: PackageVisibility;
  reresolved?: PackageVisibility;
  ensure?: OnDemandResult;
  dist?: DistServeResult;
  handle?: string | null;
  actor?: ProjectActor | null;
  kernelActor?: boolean;
}

async function harness(setup: Setup = {}) {
  const access = {
    versions: vi.fn(async () => page),
    distTags: vi.fn(async () => ({ pkg, tags: { latest: '1.0.0' } })),
    version: vi.fn(async () => ({ pkg, version })),
    tag: vi.fn(async () => ({ pkg, version })),
    search: vi.fn(async () => [
      { key: '@s/n', packageId: 'p', sourceId: 's', description: 'found' },
    ]),
  };
  const ensure = vi.fn(async () => setup.ensure ?? ({ kind: 'filled' } as OnDemandResult));
  const reresolve = vi.fn(async () => setup.reresolved ?? visible());
  const serve = vi.fn(
    async () =>
      setup.dist ??
      ({
        kind: 'file',
        headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
        size: 3,
        body: new Response('tgz').body!,
      } as DistServeResult),
  );
  const resolve = vi.fn(
    async (_actor: ProjectActor, _ecosystem: string, name: string): Promise<PackageVisibility> =>
      setup.outcome ?? visible({ key: packageKey(name, { ecosystem: 'npm', legacyCase: true }) }),
  );
  const deps: NpmRouteDeps = {
    access: access as unknown as PackageAccess,
    dist: { serve },
    onDemand: { ensure },
    ...(setup.kernelActor === true
      ? {}
      : {
          actorOf: () => (setup.actor === undefined ? actor : setup.actor),
          defer: () => undefined,
        }),
    reresolve,
    handleOf: () => (setup.handle === undefined ? 'alice' : setup.handle),
    publicUrl: 'https://broker.test',
    codecs: { gunzip: () => new TransformStream() },
  };
  const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
  const session: EngineSessionAccess = {
    session: { id: 'session-1', csrfHash: '' },
    user: { id: 'user-1' },
    identity: null,
    protectedHolder: false,
    project: { id: 'proj-1' },
    organizationPermissions: [],
    projectPermissions: ['project:read', 'project:packages:read'],
  };
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
      project: session.project,
      organizationPermissions: [],
      projectPermissions: session.projectPermissions,
    },
    'verifier',
    { value: { secretHash: await hashToken(keyring, 1, token), pepperVersion: 1 } },
  ) as unknown as EngineTokenAccess;
  const kernel = await createKernel({
    platform: 'node',
    plugins: [],
    ports: {
      organizations: { get: async () => null },
      clock: fixedClock('2026-10-16T00:00:00Z'),
      ids: { ulid: () => '01JA0000000000000000000000' },
    },
    ecosystemRoutes: npmRoutes(deps),
    packageResolver: { resolve },
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async (_ctx, input) =>
          input.projectSlug === 'demo' ? session : { ...session, project: null },
        lookupToken: async (_ctx, input) =>
          Object.defineProperty(
            { ...tokenAccess, project: input.projectSlug === 'demo' ? tokenAccess.project : null },
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
  const call = (path: string, init: RequestInit = {}) =>
    kernel.fetch(
      new Request(`https://broker.test/demo/npm${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
      }),
    );
  return { call, access, ensure, reresolve, serve, resolve, deps, kernel };
}

afterEach(() => vi.restoreAllMocks());

describe('npm packument', () => {
  it('serves the full document with time when no Accept is sent', async () => {
    const { call } = await harness();
    const response = await call('/x');
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body['_id']).toBe('x');
    expect(body['time']).toMatchObject({ '1.0.0': '2020-01-02T00:00:00Z' });
    expect(response.headers.get('vary')).toBe('Accept, Authorization');
    expect(response.headers.get('etag')).toMatch(/^W\//);
    expect(response.headers.get('last-modified')).toBeNull();
  });

  it('serves the abbreviated document only when explicitly accepted', async () => {
    const { call } = await harness();
    const response = await call('/x', { headers: { accept: `${ABBREVIATED}; q=1.0, */*` } });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.headers.get('content-type')).toBe(ABBREVIATED);
    expect(body['modified']).toBe(pkg.modifiedAt);
    expect(body['time']).toBeUndefined();
    const other = await (await call('/x', { headers: { accept: 'application/json' } })).json();
    expect(other).toHaveProperty('time');
  });

  it('answers 304 for a matching If-None-Match and a new ETag per form', async () => {
    const { call } = await harness();
    const full = await call('/x');
    const etag = full.headers.get('etag')!;
    const abbreviated = await call('/x', { headers: { accept: ABBREVIATED } });
    expect(abbreviated.headers.get('etag')).not.toBe(etag);
    const cached = await call('/x', { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('vary')).toBe('Accept, Authorization');
  });

  it('answers pnpm /<name>/latest from the tag', async () => {
    const { call, access } = await harness();
    const response = await call('/x/latest');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { version: string }).version).toBe('1.0.0');
    expect(access.tag).toHaveBeenCalledWith(actor, 'npm', 'x', 'latest');
  });

  it('serves an exact version document', async () => {
    const { call, access } = await harness();
    expect((await call('/x/1.0.0')).status).toBe(200);
    expect(access.version).toHaveBeenCalledWith(actor, 'npm', 'x', '1.0.0');
  });

  it('answers a first ingest in progress with 503', async () => {
    const { call, access } = await harness({ outcome: visible({ listingComplete: false }) });
    access.versions.mockResolvedValue({
      ...page,
      pkg: { ...pkg, listingComplete: false },
    });
    const response = await call('/x');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('10');
  });
});

describe('npm route precedence and path hygiene', () => {
  it('serves -/whoami by its own route and /x/y by the package handler', async () => {
    const { call, access } = await harness();
    const who = await call('/-/whoami');
    expect(await who.json()).toEqual({ username: 'alice' });
    expect(access.version).not.toHaveBeenCalled();
    expect(access.tag).not.toHaveBeenCalled();
    await call('/x/y');
    expect(access.tag).toHaveBeenCalledWith(actor, 'npm', 'x', 'y');
  });

  it('never returns an e-mail address as the whoami username', async () => {
    const { call } = await harness({ handle: null });
    const response = await call('/-/whoami');
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('@');
  });

  it.each(['/x%2570', '/%2540s%252fn', '/x/%252e%252e', '/x/-/x%252d1.0.0.tgz'])(
    'refuses the double-encoded path %s with the npm 404 body',
    async (path) => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
      const { call, access, serve, ensure } = await harness();
      const response = await call(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Route not found',
        code: 'not_found',
        requestId: '00000000-0000-4000-8000-000000000000',
      });
      expect(access.versions).not.toHaveBeenCalled();
      expect(access.version).not.toHaveBeenCalled();
      expect(access.tag).not.toHaveBeenCalled();
      expect(serve).not.toHaveBeenCalled();
      expect(ensure).not.toHaveBeenCalled();
    },
  );

  it('strips the query string before parsing the path', async () => {
    const { call } = await harness();
    expect((await call('/x?write=true&a=%2570')).status).toBe(200);
  });

  it.each(['PUT', 'POST', 'DELETE'])('answers %s on package paths with 405', async (method) => {
    const { call, access } = await harness();
    for (const path of ['/x', '/x/1.0.0', '/%40s%2Fn', '/x/-/x-1.0.0.tgz']) {
      const response = await call(path, { method, body: method === 'DELETE' ? null : '{}' });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(await response.json()).toMatchObject({ code: 'method_not_allowed' });
    }
    expect(access.versions).not.toHaveBeenCalled();
  });
});

describe('npm tarballs', () => {
  it('serves the tarball by version id and revision', async () => {
    const { call, serve } = await harness();
    const response = await call('/x/-/x-1.0.0.tgz');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('tgz');
    expect(serve).toHaveBeenCalledWith(
      actor,
      {
        ecosystem: 'npm',
        key: 'x',
        versionId: 'ver1',
        revision: 2,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('answers 404 for an unknown version and 503 while the dist is filling', async () => {
    const unknown = await harness();
    unknown.access.version.mockResolvedValue(null as never);
    expect((await unknown.call('/x/-/x-9.9.9.tgz')).status).toBe(404);
    expect(unknown.serve).not.toHaveBeenCalled();
    const busy = await harness({ dist: { kind: 'busy', retryAfterSeconds: 5 } });
    const response = await busy.call('/x/-/x-1.0.0.tgz');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    const missing = await harness({ dist: { kind: 'not_found' } });
    expect((await missing.call('/x/-/x-1.0.0.tgz')).status).toBe(404);
  });
});

describe('npm on-demand fill', () => {
  it('fills an admitted package, re-resolves, then renders', async () => {
    const { call, ensure, reresolve, access } = await harness({ outcome: admission });
    const response = await call('/x');
    expect(response.status).toBe(200);
    expect(ensure).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ ecosystem: 'npm', key: 'x', outcome: admission }),
    );
    expect(reresolve).toHaveBeenCalledTimes(1);
    expect(reresolve.mock.invocationCallOrder[0]!).toBeLessThan(
      access.versions.mock.invocationCallOrder[0]!,
    );
  });

  it('answers the uniform 404 for a freshly fetched package that is now excluded', async () => {
    const { call, access, serve } = await harness({
      outcome: admission,
      reresolved: { kind: 'absent' },
    });
    for (const path of ['/x', '/x/latest', '/x/-/x-1.0.0.tgz']) {
      const response = await call(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'Route not found', code: 'not_found' });
      expect(response.headers.get('etag')).toBeNull();
    }
    expect(access.versions).not.toHaveBeenCalled();
    expect(access.tag).not.toHaveBeenCalled();
    expect(access.version).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it('refuses a re-resolution that names a different package', async () => {
    const { call, access } = await harness({
      outcome: admission,
      reresolved: visible({ key: 'other' }),
    });
    expect((await call('/x')).status).toBe(404);
    expect(access.versions).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'not_found' }, 404, null],
    [{ kind: 'busy', retryAfterSeconds: 10 }, 503, '10'],
    [{ kind: 'upstream_error' }, 502, null],
  ] as const)('maps the fill result %j to %i', async (ensure, status, retry) => {
    const { call, reresolve, access } = await harness({ outcome: admission, ensure });
    const response = await call('/x');
    expect(response.status).toBe(status);
    expect(response.headers.get('retry-after')).toBe(retry);
    expect(reresolve).not.toHaveBeenCalled();
    expect(access.versions).not.toHaveBeenCalled();
  });

  it('does not fetch for dist-tags and refuses the admission', async () => {
    const { call, ensure } = await harness({ outcome: admission });
    expect((await call('/-/package/x/dist-tags')).status).toBe(404);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('marks a stale serve and revalidates on every success', async () => {
    const background = vi.fn(async () => undefined);
    const { call } = await harness({ ensure: { kind: 'serve', stale: true, background } });
    const response = await call('/x');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-broker-stale')).toBe('1');
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    const fresh = await (await harness()).call('/x');
    expect(fresh.headers.get('x-broker-stale')).toBeNull();
    expect(fresh.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('uses the kernel actor and the kernel waitUntil when no overrides are injected', async () => {
    const background = vi.fn(async () => undefined);
    const { call, resolve, ensure, kernel } = await harness({
      kernelActor: true,
      ensure: { kind: 'serve', stale: true, background },
    });
    expect((await call('/x')).status).toBe(200);
    expect((ensure.mock.calls as unknown[][])[0]![0]).toBe(resolve.mock.calls[0]![0]);
    await kernel.idle();
    expect(background).toHaveBeenCalledTimes(1);
  });

  it('passes the request signal to the dist service for a tarball', async () => {
    const { call, serve } = await harness({ kernelActor: true });
    expect((await call('/x/-/x-1.0.0.tgz')).status).toBe(200);
    expect((serve.mock.calls as unknown[][])[0]![2]).toEqual({ signal: expect.any(AbortSignal) });
  });

  it('answers a tarball aborted by the client quietly instead of 500', async () => {
    const { call, serve } = await harness({ kernelActor: true });
    const controller = new AbortController();
    serve.mockImplementation(async () => {
      controller.abort(new Error('client gone'));
      throw controller.signal.reason;
    });
    const response = await call('/x/-/x-1.0.0.tgz', { signal: controller.signal });
    expect(response.status).toBe(499);
  });

  it('answers a fill upstream error with 502 bad_gateway', async () => {
    const { call } = await harness({ outcome: admission, ensure: { kind: 'upstream_error' } });
    const response = await call('/x');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'Bad gateway', code: 'bad_gateway' });
  });

  it('answers a handler 404 exactly like the kernel package-boundary 404', async () => {
    const kernel404 = await (await harness({ outcome: { kind: 'absent' } })).call('/x');
    const handler404 = await (
      await harness({ outcome: admission, reresolved: { kind: 'absent' } })
    ).call('/x');
    expect(handler404.status).toBe(404);
    expect(kernel404.status).toBe(404);
    expect([...handler404.headers].filter(([n]) => n !== 'x-request-id').sort()).toEqual(
      [...kernel404.headers].filter(([n]) => n !== 'x-request-id').sort(),
    );
    const bodies = [await handler404.json(), await kernel404.json()] as Record<string, string>[];
    expect(bodies[0]!['error']).toBe(bodies[1]!['error']);
    expect(Object.keys(bodies[0]!)).toEqual(Object.keys(bodies[1]!));
  });

  it('answers a client abort quietly without rendering', async () => {
    const { call, access } = await harness({ outcome: admission });
    const controller = new AbortController();
    controller.abort();
    const response = await call('/x', { signal: controller.signal }).catch(() => null);
    expect(access.versions).not.toHaveBeenCalled();
    expect(response === null || response.status !== 500).toBe(true);
  });

  it('refuses a tarball whose dist type is not tgz', async () => {
    const { call, access, serve } = await harness();
    access.version.mockResolvedValue({ pkg, version: { ...version, distType: 'zip' } } as never);
    expect((await call('/x/-/x-1.0.0.tgz')).status).toBe(404);
    expect(serve).not.toHaveBeenCalled();
  });
});

describe('npm literal routes', () => {
  it('serves dist-tags for unscoped and encoded scoped names', async () => {
    const { call, access } = await harness();
    const plain = await call('/-/package/x/dist-tags');
    expect(await plain.json()).toEqual({ latest: '1.0.0' });
    await call('/-/package/%40s%2Fn/dist-tags');
    expect(access.distTags).toHaveBeenLastCalledWith(actor, 'npm', '@s/n');
  });

  it('answers ping', async () => {
    const { call } = await harness();
    const response = await call('/-/ping');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  it('serves local search only, bounded', async () => {
    const { call, access } = await harness();
    const response = await call('/-/v1/search?text=found&size=500');
    const body = (await response.json()) as {
      objects: { package: { name: string; description: string } }[];
      total: number;
    };
    expect(body.objects[0]!.package).toMatchObject({ name: '@s/n', description: 'found' });
    expect(body.total).toBe(1);
    expect(access.search).toHaveBeenCalledWith(actor, 'npm', { text: 'found', limit: 50 });
  });

  it('answers audit from local data without any upstream call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { call } = await harness();
    const response = await call('/-/npm/v1/security/advisories/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'private-elsewhere': ['1.0.0'], lodash: ['4.17.21'] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['not json', 400, 'invalid_request'],
    ['[1]', 400, 'invalid_request'],
    [JSON.stringify({ a: 'x' }), 400, 'invalid_request'],
    [
      JSON.stringify(
        Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`p${i}`, ['1.0.0']])),
      ),
      413,
      'payload_too_large',
    ],
  ])('rejects the audit body %.20s with the npm error shape', async (body, status, code) => {
    const { call } = await harness();
    const response = await call('/-/npm/v1/security/advisories/bulk', { method: 'POST', body });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code, requestId: expect.any(String) });
  });

  it('refuses an unsupported content encoding on audit', async () => {
    const { call } = await harness();
    const response = await call('/-/npm/v1/security/advisories/bulk', {
      method: 'POST',
      headers: { 'content-encoding': 'br' },
      body: '{}',
    });
    expect(response.status).toBe(415);
  });
});

describe('npm fix round 1', () => {
  it.each([
    ['null', null],
    ['other organization', { ...actor, orgId: 'org-2' as OrgId }],
    ['other project', { ...actor, projectId: 'proj-2' }],
    ['other user', { ...actor, userId: 'user-2' }],
    ['no read permission', { ...actor, permissions: new Set<string>() }],
  ])('answers 503 for a mismatched actor: %s', async (_name, mismatched) => {
    const { call, access, ensure, serve } = await harness({ actor: mismatched });
    for (const path of [
      '/x',
      '/x/1.0.0',
      '/x/-/x-1.0.0.tgz',
      '/-/package/x/dist-tags',
      '/-/v1/search?text=a',
    ]) {
      expect((await call(path)).status).toBe(503);
    }
    expect(access.versions).not.toHaveBeenCalled();
    expect(access.search).not.toHaveBeenCalled();
    expect(access.distTags).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
  });

  it.each([
    ['another project', visible({ projectId: 'proj-2' })],
    ['another ecosystem', visible({ ecosystem: 'composer' })],
  ])('refuses a re-resolution into %s', async (_name, reresolved) => {
    const { call, access } = await harness({ outcome: admission, reresolved });
    expect((await call('/x')).status).toBe(404);
    expect(access.versions).not.toHaveBeenCalled();
  });

  it('turns every renderer 404 into the kernel package-boundary 404', async () => {
    const kernel404 = await (await harness({ outcome: { kind: 'absent' } })).call('/x');
    const reference = {
      headers: [...kernel404.headers].filter(([n]) => n !== 'x-request-id').sort(),
      body: Object.entries((await kernel404.json()) as Record<string, string>).filter(
        ([k]) => k !== 'requestId',
      ),
    };
    const unknown = await harness();
    unknown.access.tag.mockResolvedValue(null as never);
    const empty = await harness();
    empty.access.versions.mockResolvedValue({ ...page, versions: [] });
    for (const response of [await unknown.call('/x/nope'), await empty.call('/x')]) {
      expect(response.status).toBe(404);
      expect([...response.headers].filter(([n]) => n !== 'x-request-id').sort()).toEqual(
        reference.headers,
      );
      expect(
        Object.entries((await response.json()) as Record<string, string>).filter(
          ([k]) => k !== 'requestId',
        ),
      ).toEqual(reference.body);
    }
  });

  it('refuses a resolver outcome whose key differs from the requested path', async () => {
    const { deps, access, ensure } = await harness();
    const route = npmRoutes(deps).find((r) => r.method === 'GET' && r.path === '/:project/npm/:a')!;
    const ctx: RequestContext = {
      request: new Request('https://broker.test/demo/npm/x'),
      requestId: 'r',
      org,
      principal: { kind: 'user', id: 'user-1' },
      projectId: 'proj-1',
      params: { project: 'demo', a: 'x' },
      ports: {} as never,
    };
    setAccessContext(ctx, {
      principal: ctx.principal,
      projectId: 'proj-1',
      boundary: 'project',
      sessionId: null,
      token: { kind: 'pat', scope: null, readOnly: false },
      actor: null,
      rateKey: {
        stage: 'authenticated',
        tokenSelector: 't',
        principalId: 'user-1',
        routeClass: 'project',
      },
    });
    setResolvedPackage(ctx, visible({ key: 'other' }) as never);
    const response = await route.handler(ctx);
    expect(response.status).toBe(404);
    expect(ensure).not.toHaveBeenCalled();
    expect(access.versions).not.toHaveBeenCalled();
  });

  it('refuses an encoded dash in the tarball path', async () => {
    const { call, serve } = await harness();
    expect((await call('/x/%2D/x-1.0.0.tgz')).status).toBe(404);
    expect(serve).not.toHaveBeenCalled();
  });

  it('never returns an address-like handle from whoami', async () => {
    const { call } = await harness({ handle: 'a@example.test' });
    const response = await call('/-/whoami');
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('example.test');
  });

  it('varies and revalidates dist-tags, search and whoami', async () => {
    const { call } = await harness();
    for (const path of ['/-/package/x/dist-tags', '/-/v1/search?text=a', '/-/whoami']) {
      const response = await call(path);
      expect(response.headers.get('vary')).toBe('Accept, Authorization');
      expect(response.headers.get('cache-control')).toBe('private, no-cache');
    }
  });

  it('answers a client abort quietly before mapping busy', async () => {
    const { call } = await harness({
      outcome: admission,
      ensure: { kind: 'busy', retryAfterSeconds: 10 },
    });
    const controller = new AbortController();
    controller.abort();
    const response = await call('/x', { signal: controller.signal }).catch(() => null);
    expect(response === null || response.status !== 503).toBe(true);
  });

  it('cancels the dist body on HEAD', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { call } = await harness({
      dist: { kind: 'file', headers: new Headers(), size: 3, body },
    });
    const response = await call('/x/-/x-1.0.0.tgz', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalled();
  });
});

describe('npm tarball refusal', () => {
  it('answers 502 with the fixed bad_gateway message when the tarball was refused', async () => {
    const { call } = await harness({ dist: { kind: 'refused' } });
    const response = await call('/x/-/x-1.0.0.tgz');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'bad_gateway', error: 'Bad gateway' });
  });

  it('keeps the uniform 404 for an unknown version even when the service would refuse', async () => {
    const h = await harness({ dist: { kind: 'refused' } });
    h.access.version.mockResolvedValue(null as never);
    expect((await h.call('/x/-/x-9.9.9.tgz')).status).toBe(404);
    expect(h.serve).not.toHaveBeenCalled();
  });
});
