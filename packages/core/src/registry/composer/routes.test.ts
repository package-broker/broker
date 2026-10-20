import { describe, expect, it, vi } from 'vitest';
import type { PackageAccess } from '../../catalogue/package-access.js';
import type {
  CatalogueVersion,
  PackageResolution,
  PackageVisibility,
  ResolvedPackage,
} from '../../db/catalogue.js';
import { orgContext } from '../../db/port.js';
import { fixedClock } from '../../ids.js';
import type { OnDemandFill, OnDemandResult } from '../../ingest/on-demand.js';
import { contextPackageActorOf, setContextPackageActor } from '../../internal/package-actor.js';
import { setResolvedPackage } from '../../internal/package-context.js';
import { setWaitUntil } from '../../kernel/execution.js';
import { createKernel } from '../../kernel/kernel.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import type { DistService, DistServeResult } from '../dist-service.js';
import type { RepresentationClock } from '../conditional.js';
import { composerRoutes } from './routes.js';

const VERSION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const org = orgContext('org-1');
const pkg: ResolvedPackage = {
  projectId: 'proj-1',
  ecosystem: 'composer',
  key: 'acme/lib',
  packageId: 'pk',
  sourceId: 's',
  rev: 1,
  modifiedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  listingComplete: true,
  cacheEpoch: '1',
};
const visible: PackageVisibility = {
  kind: 'visible',
  pkg,
  cacheKey: () => {
    throw new Error('unused');
  },
  epochReader: { read: async () => null },
};
const admissible: PackageVisibility = {
  kind: 'proxy_admissible',
  projectId: 'proj-1',
  ecosystem: 'composer',
  key: 'acme/lib',
  sourceIds: ['s'],
};

function version(over: Partial<CatalogueVersion> = {}): CatalogueVersion {
  return {
    versionId: VERSION_ID,
    revision: 1,
    version: '1.0.0',
    versionNormalized: '1.0.0.0',
    stability: 'stable',
    status: 'active',
    publishedAt: '2026-10-01T00:00:00Z',
    upstreamReleasedAt: null,
    license: null,
    distType: 'zip',
    composerShasum: null,
    npmIntegrity: null,
    deprecatedMessage: null,
    metadataJson: JSON.stringify({ name: 'acme/lib', dist: { reference: 'abc' } }),
    ...over,
  };
}
function page(versions = [version()]): PackageResolution {
  return { pkg, versions, next: null, binding: { packageId: 'pk', sourceId: 's', rev: 1 } };
}

function harness() {
  const versions = vi.fn<PackageAccess['versions']>().mockResolvedValue(page());
  const list = vi
    .fn<PackageAccess['list']>()
    .mockResolvedValue({ items: [], next: null, openNamespace: false });
  const access = { versions, list } as unknown as PackageAccess;
  const ensure = vi
    .fn<OnDemandFill['ensure']>()
    .mockResolvedValue({ kind: 'serve', stale: false } satisfies OnDemandResult);
  const serve = vi
    .fn<DistService['serve']>()
    .mockResolvedValue({ kind: 'not_found' } satisfies DistServeResult);
  const clock: RepresentationClock = {
    advance: vi.fn(async (_ctx, input) => ({
      stale: false,
      validator: input.validator,
      lastModified: '2026-10-01T00:00:00Z',
    })),
  };
  const routes = composerRoutes({
    access,
    fill: { ensure },
    dist: { serve },
    clock,
    publicUrl: 'https://broker.test',
  });
  const find = (path: string): RouteDefinition => {
    const route = routes.find((entry) => entry.path === path);
    if (route === undefined) throw new Error(`missing route ${path}`);
    return route;
  };
  return { versions, list, ensure, serve, routes, find };
}

function context(
  url: string,
  params: Record<string, string>,
  outcome: PackageVisibility | null,
  headers: Record<string, string> = {},
  withActor = true,
): RequestContext {
  const ctx = {
    request: new Request(url, { headers }),
    requestId: 'req-1',
    org,
    principal: { kind: 'user', id: 'user-1' },
    projectId: 'proj-1',
    params,
    ports: {},
  } as unknown as RequestContext;
  if (withActor) {
    setContextPackageActor(ctx, {
      kind: 'project',
      userId: 'user-1',
      orgId: org.orgId,
      projectId: 'proj-1',
      permissions: new Set(['project:packages:read']),
    });
  }
  if (outcome !== null && outcome.kind !== 'absent') setResolvedPackage(ctx, outcome);
  return ctx;
}
const p2 = (file: string, outcome: PackageVisibility | null, headers = {}) =>
  context(
    `https://broker.test/demo/p2/acme/${file}`,
    { project: 'demo', vendor: 'acme', file },
    outcome,
    headers,
  );
const dist = (file: string, name = 'lib', headers = {}) =>
  context(
    `https://broker.test/demo/dist/acme/${name}/${file}`,
    { project: 'demo', vendor: 'acme', name, file },
    visible,
    headers,
  );

const P2 = '/:project/p2/:vendor/:file';
const DIST = '/:project/dist/:vendor/:name/:file';
const ROOT = '/:project/packages.json';

describe('composerRoutes registration', () => {
  it('declares the three Composer routes with their boundaries', () => {
    const { routes } = harness();
    expect(
      routes.map(({ method, path, boundary, permission }) => ({
        method,
        path,
        boundary,
        permission,
      })),
    ).toEqual([
      { method: 'GET', path: ROOT, boundary: 'project', permission: 'project:packages:read' },
      { method: 'GET', path: P2, boundary: 'package', permission: 'project:packages:read' },
      { method: 'GET', path: DIST, boundary: 'package', permission: 'project:packages:read' },
    ]);
    const { find } = harness();
    expect(find(P2).package?.fetchOnAdmission).toBe(true);
    expect(find(P2).package?.ecosystem).toBe('composer');
    expect(find(DIST).package?.fetchOnAdmission).not.toBe(true);
  });

  it('is accepted by the kernel', async () => {
    const { routes } = harness();
    const kernel = await createKernel({
      platform: 'node',
      plugins: [],
      ecosystemRoutes: routes,
      packageResolver: { resolve: async () => ({ kind: 'absent' }) },
      ports: {
        organizations: { get: async () => null },
        clock: fixedClock('2026-10-18T00:00:00Z'),
        ids: { ulid: () => VERSION_ID },
      },
      resolveOrg: async () => org,
      health: async () => true,
      log: () => undefined,
    });
    for (const path of [ROOT, P2, DIST]) expect(kernel.routeTemplates.has(path)).toBe(true);
  });

  it.each([
    ['lib.json', 'acme/lib'],
    ['lib~dev.json', 'acme/lib'],
    ['lib.txt', null],
    ['lib', null],
    ['lib.json.bak', null],
    ['lib~dev', null],
    ['.json', null],
    ['~dev.json', null],
  ])('extracts the package name from p2 file %s', (file, expected) => {
    const binding = harness().find(P2).package!;
    expect(binding.name({ vendor: 'acme', file })).toBe(expected);
  });

  it('extracts the package name from the dist path', () => {
    const binding = harness().find(DIST).package!;
    expect(binding.name({ vendor: 'acme', name: 'lib' })).toBe('acme/lib');
  });
});

describe('GET /:project/packages.json', () => {
  const root = (ua?: string) =>
    context(
      'https://broker.test/demo/packages.json',
      { project: 'demo' },
      null,
      ua === undefined ? {} : { 'user-agent': ua },
    );

  it('answers Composer 1 with 406 and reads no catalogue', async () => {
    const h = harness();
    const response = await h.find(ROOT).handler(root('Composer/1.10.26 (Linux; PHP 8.1)'));
    expect(response.status).toBe(406);
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: 'not_acceptable', message: 'Not acceptable', requestId: 'req-1' },
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(h.list).not.toHaveBeenCalled();
  });

  it.each(['Composer/2.7.1 (Linux; PHP 8.2)', 'Composer/2.0.0', undefined, 'curl/8.0'])(
    'serves the root to %s',
    async (ua) => {
      const h = harness();
      const response = await h.find(ROOT).handler(root(ua));
      expect(response.status).toBe(200);
      expect((await response.json()) as unknown).toMatchObject({
        'metadata-url': '/demo/p2/%package%.json',
      });
    },
  );
});

describe('kernel-provided actor', () => {
  it.each([
    [
      'packages.json',
      ROOT,
      () => context('https://broker.test/demo/packages.json', { project: 'demo' }, null, {}, false),
    ],
    [
      'p2',
      P2,
      () =>
        context(
          'https://broker.test/demo/p2/acme/lib.json',
          { project: 'demo', vendor: 'acme', file: 'lib.json' },
          visible,
          {},
          false,
        ),
    ],
    [
      'dist',
      DIST,
      () =>
        context(
          'https://broker.test/demo/dist/acme/lib/x.zip',
          { project: 'demo', vendor: 'acme', name: 'lib', file: 'x.zip' },
          visible,
          {},
          false,
        ),
    ],
  ])('answers 404 and reads nothing without a kernel actor on %s', async (_name, path, build) => {
    const h = harness();
    const response = await h.find(path).handler(build());
    expect(response.status).toBe(404);
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.versions).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.serve).not.toHaveBeenCalled();
  });

  it('passes the kernel actor object itself to the fill and the dist service', async () => {
    const h = harness();
    const ctx = p2('lib.json', visible);
    await h.find(P2).handler(ctx);
    const kernelActor = contextPackageActorOf(ctx);
    expect(h.ensure.mock.calls[0]![0]).toBe(kernelActor);
    const distCtx = dist(`${VERSION_ID}.2.zip`);
    await h.find(DIST).handler(distCtx);
    expect(h.serve.mock.calls[0]![0]).toBe(contextPackageActorOf(distCtx));
  });

  it('schedules a stale-serve background through the kernel waitUntil', async () => {
    const h = harness();
    const background = vi.fn(async () => undefined);
    h.ensure.mockResolvedValue({ kind: 'serve', stale: true, background });
    const scheduled: Promise<unknown>[] = [];
    const ctx = p2('lib.json', visible);
    setWaitUntil(ctx, (promise) => scheduled.push(promise));
    await h.find(P2).handler(ctx);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(background).toHaveBeenCalledTimes(1);
  });

  it('passes the request signal to the dist service', async () => {
    const h = harness();
    const ctx = dist(`${VERSION_ID}.2.zip`);
    await h.find(DIST).handler(ctx);
    expect(h.serve.mock.calls[0]![2]).toEqual({ signal: ctx.request.signal });
  });
});

describe('GET /:project/p2/:vendor/:file', () => {
  it('serves a visible package after the fill check', async () => {
    const h = harness();
    const response = await h.find(P2).handler(p2('lib.json', visible));
    expect(response.status).toBe(200);
    expect(h.ensure).toHaveBeenCalledOnce();
    const [actor, request] = h.ensure.mock.calls[0]!;
    expect(actor).toMatchObject({
      kind: 'project',
      userId: 'user-1',
      orgId: 'org-1',
      projectId: 'proj-1',
    });
    expect(actor.permissions.has('project:packages:read')).toBe(true);
    expect(request).toMatchObject({ ecosystem: 'composer', key: 'acme/lib', outcome: visible });
    expect(h.versions).toHaveBeenCalledWith(
      actor,
      'composer',
      'acme/lib',
      expect.objectContaining({}),
    );
  });

  it('fills an admitted unseen package and serves it from the catalogue on the first request', async () => {
    const h = harness();
    h.ensure.mockResolvedValue({ kind: 'filled' });
    const response = await h.find(P2).handler(p2('lib.json', admissible));
    expect(response.status).toBe(200);
    expect(h.ensure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: admissible, key: 'acme/lib' }),
    );
    expect(h.versions.mock.invocationCallOrder[0]!).toBeGreaterThan(
      h.ensure.mock.invocationCallOrder[0]!,
    );
  });

  it('answers the uniform 404 when the admitted name does not exist upstream', async () => {
    const h = harness();
    h.ensure.mockResolvedValue({ kind: 'not_found' });
    const response = await h.find(P2).handler(p2('lib.json', admissible));
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json()) as unknown).toMatchObject({ error: { code: 'not_found' } });
    expect(h.versions).not.toHaveBeenCalled();
  });

  it('answers 404 when the fill reports success but the catalogue still has nothing', async () => {
    const h = harness();
    h.ensure.mockResolvedValue({ kind: 'filled' });
    h.versions.mockResolvedValue(null);
    const response = await h.find(P2).handler(p2('lib.json', admissible));
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers 503 Retry-After 10 when the first ingest outlasts the hold', async () => {
    const h = harness();
    h.ensure.mockResolvedValue({ kind: 'busy', retryAfterSeconds: 10 });
    const response = await h.find(P2).handler(p2('lib.json', admissible));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('10');
    expect((await response.json()) as unknown).toMatchObject({ error: { code: 'unavailable' } });
    expect(h.versions).not.toHaveBeenCalled();
  });

  it('answers 502 without internals when the upstream fill failed', async () => {
    const h = harness();
    h.ensure.mockResolvedValue({ kind: 'upstream_error' });
    const response = await h.find(P2).handler(p2('lib.json', admissible));
    expect(response.status).toBe(502);
    expect((await response.clone().json()) as unknown).toMatchObject({
      error: { code: 'bad_gateway' },
    });
    expect(JSON.stringify(await response.json())).not.toMatch(/upstream/i);
  });

  it('serves the stale document and starts the background refresh', async () => {
    const h = harness();
    const background = vi.fn(async () => undefined);
    h.ensure.mockResolvedValue({ kind: 'serve', stale: true, background });
    const response = await h.find(P2).handler(p2('lib.json', visible));
    expect(response.status).toBe(200);
    expect(background).toHaveBeenCalledOnce();
  });

  it('does not fail the response when the background refresh rejects', async () => {
    const h = harness();
    h.ensure.mockResolvedValue({
      kind: 'serve',
      stale: true,
      background: async () => {
        throw new Error('boom');
      },
    });
    const response = await h.find(P2).handler(p2('lib.json', visible));
    expect(response.status).toBe(200);
  });

  it('renders only dev versions for the ~dev file', async () => {
    const h = harness();
    h.versions.mockResolvedValue(
      page([
        version({ stability: 'dev', version: 'dev-main', versionNormalized: 'dev-main' }),
        version({ versionId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' }),
      ]),
    );
    const response = await h.find(P2).handler(p2('lib~dev.json', visible));
    const body = (await response.json()) as { packages: Record<string, { version: string }[]> };
    expect(body.packages['acme/lib']!.map((entry) => entry.version)).toEqual(['dev-main']);
  });

  it('never answers 304 to a caller who cannot see the package', async () => {
    const h = harness();
    h.versions.mockResolvedValue(null);
    for (const headers of [
      { 'if-none-match': '*' },
      { 'if-modified-since': 'Thu, 01 Oct 2026 00:00:00 GMT' },
    ]) {
      const response = await h.find(P2).handler(p2('lib.json', visible, headers));
      expect(response.status).toBe(404);
    }
  });

  it('answers 304 with cache headers when the visible caller revalidates', async () => {
    const h = harness();
    const first = await h.find(P2).handler(p2('lib.json', visible));
    const lastModified = first.headers.get('Last-Modified')!;
    const response = await h
      .find(P2)
      .handler(p2('lib.json', visible, { 'if-modified-since': lastModified }));
    expect(response.status).toBe(304);
    expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(response.headers.get('Expires')).toBeNull();
    expect(first.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(first.headers.get('Expires')).toBeNull();
  });

  it('marks a stale serve', async () => {
    const h = harness();
    h.ensure.mockResolvedValue({ kind: 'serve', stale: true });
    expect((await h.find(P2).handler(p2('lib.json', visible))).headers.get('x-broker-stale')).toBe(
      '1',
    );
    h.ensure.mockResolvedValue({ kind: 'serve', stale: false });
    expect(
      (await h.find(P2).handler(p2('lib.json', visible))).headers.get('x-broker-stale'),
    ).toBeNull();
  });

  it('answers quietly when the client aborts while waiting', async () => {
    const h = harness();
    const controller = new AbortController();
    h.ensure.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    const ctx = context(
      'https://broker.test/demo/p2/acme/lib.json',
      {
        project: 'demo',
        vendor: 'acme',
        file: 'lib.json',
      },
      visible,
    );
    Object.defineProperty(ctx, 'request', {
      value: new Request('https://broker.test/demo/p2/acme/lib.json', {
        signal: controller.signal,
      }),
    });
    const response = await h.find(P2).handler(ctx);
    expect(response.status).toBe(503);
  });

  it('answers a handler 404 identically to the kernel package-boundary 404', async () => {
    const h = harness();
    h.ensure.mockResolvedValue({ kind: 'not_found' });
    const ours = await h.find(P2).handler(p2('lib.json', admissible));
    const kernel = await createKernel({
      platform: 'node',
      plugins: [],
      ports: {
        organizations: { get: async () => null },
        clock: fixedClock('2026-10-18T00:00:00Z'),
        ids: { ulid: () => VERSION_ID },
      },
      resolveOrg: async () => org,
      health: async () => true,
      log: () => undefined,
    });
    const theirs = await kernel.fetch(new Request('https://broker.test/nothing/here/at/all'));
    const normalise = async (response: Response) => ({
      status: response.status,
      body: JSON.stringify(await response.clone().json()).replace(/"requestId":"[^"]*"/, ''),
    });
    expect(await normalise(ours)).toEqual(await normalise(theirs));
    for (const [name, value] of ours.headers) {
      if (name !== 'x-request-id') expect(theirs.headers.get(name)).toBe(value);
    }
  });

  it('keys the representation clock by the canonical package key', async () => {
    const h = harness();
    const advance = vi.fn(async (_ctx: unknown, input: { validator: string }) => ({
      stale: false,
      validator: input.validator,
      lastModified: '2026-10-01T00:00:00Z',
    }));
    const routes = composerRoutes({
      access: { versions: h.versions, list: h.list } as unknown as PackageAccess,
      fill: { ensure: h.ensure },
      dist: { serve: h.serve },
      clock: { advance },
      publicUrl: 'https://broker.test',
    });
    await routes.find((entry) => entry.path === P2)!.handler(p2('Lib.json', visible));
    const { sha256Hex } = await import('../../auth/primitives.js');
    expect(advance.mock.calls[0]![1]).toMatchObject({
      keyHash: await sha256Hex(JSON.stringify(['composer', 'acme/lib'])),
    });
  });
});

describe('GET /:project/dist/:vendor/:name/:file', () => {
  const FILE = `${VERSION_ID}.2.zip`;
  const body = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

  it('serves by version id and revision from the path', async () => {
    const h = harness();
    h.serve.mockResolvedValue({
      kind: 'file',
      headers: new Headers({
        'Content-Type': 'application/zip',
        'Content-Length': '3',
        'Content-Disposition': `attachment; filename="${VERSION_ID}.2.zip"`,
      }),
      size: 3,
      body: body(),
    });
    const response = await h.find(DIST).handler(dist(FILE));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(h.serve).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', orgId: 'org-1' }),
      { ecosystem: 'composer', key: 'acme/lib', versionId: VERSION_ID, revision: 2 },
      { signal: expect.any(AbortSignal) },
    );
    expect(h.ensure).not.toHaveBeenCalled();
  });

  it('answers 404 when the stored dist type differs from the path extension', async () => {
    const h = harness();
    h.serve.mockResolvedValue({
      kind: 'file',
      headers: new Headers({
        'Content-Disposition': `attachment; filename="${VERSION_ID}.2.tar"`,
      }),
      size: 3,
      body: body(),
    });
    expect((await h.find(DIST).handler(dist(FILE))).status).toBe(404);
  });

  it('answers 404 when the service has no such revision', async () => {
    const h = harness();
    const response = await h.find(DIST).handler(dist(FILE));
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers 503 with the service retry hint when the fill is busy', async () => {
    const h = harness();
    h.serve.mockResolvedValue({ kind: 'busy', retryAfterSeconds: 5 });
    const response = await h.find(DIST).handler(dist(FILE));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
  });

  it.each([
    ['not a version id', `nope.2.zip`],
    ['revision zero', `${VERSION_ID}.0.zip`],
    ['unknown extension', `${VERSION_ID}.2.tgz`],
    ['missing revision', `${VERSION_ID}.zip`],
    ['revision beyond 2^31', `${VERSION_ID}.2147483648.zip`],
  ])('answers 404 without reaching the service: %s', async (_name, file) => {
    const h = harness();
    const response = await h.find(DIST).handler(dist(file));
    expect(response.status).toBe(404);
    expect(h.serve).not.toHaveBeenCalled();
  });

  it('answers 404 when the path names a different package than the resolved one', async () => {
    const h = harness();
    const ctx = context(
      `https://broker.test/demo/dist/acme/other/${FILE}`,
      { project: 'demo', vendor: 'acme', name: 'other', file: FILE },
      visible,
    );
    const response = await h.find(DIST).handler(ctx);
    expect(response.status).toBe(404);
    expect(h.serve).not.toHaveBeenCalled();
  });

  it('parses the raw undecoded pathname', async () => {
    const h = harness();
    const ctx = context(
      `https://broker.test/demo/dist/acme/%6Cib/${FILE}`,
      { project: 'demo', vendor: 'acme', name: 'lib', file: FILE },
      visible,
    );
    const response = await h.find(DIST).handler(ctx);
    expect(response.status).toBe(404);
    expect(h.serve).not.toHaveBeenCalled();
  });

  it('answers 404 when the path project differs from the routed project', async () => {
    const h = harness();
    const ctx = context(
      `https://broker.test/other/dist/acme/lib/${FILE}`,
      { project: 'demo', vendor: 'acme', name: 'lib', file: FILE },
      visible,
    );
    expect((await h.find(DIST).handler(ctx)).status).toBe(404);
    expect(h.serve).not.toHaveBeenCalled();
  });
});
