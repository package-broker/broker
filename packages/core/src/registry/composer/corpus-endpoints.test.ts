import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectActor } from '../../authz/project-actor.js';
import { createPackageAccess, type PackageAccess } from '../../catalogue/package-access.js';
import type {
  CatalogueReader,
  CatalogueVersion,
  DistTarget,
  PackageVisibility,
  ResolvedPackage,
} from '../../db/catalogue.js';
import { orgContext, type OrgId } from '../../db/port.js';
import { setContextPackageActor } from '../../internal/package-actor.js';
import { setResolvedPackage } from '../../internal/package-context.js';
import type { RequestContext } from '../../plugin.js';
import { parseSha256, type CoreBlobStore as BlobStore, type Sha256 } from '../../platform/blob.js';
import type { FetchLeases } from '../../ingest/coalesce.js';
import { systemClock } from '../../ids.js';
import type { OnDemandFill } from '../../ingest/on-demand.js';
import type { ClockReading, RepresentationClock } from '../conditional.js';
import { createDistService } from '../dist-service.js';
import { parseComposerDistPath } from './dist-url.js';
import { expandVersions } from './minify.js';
import { renderComposerP2 } from './render.js';
import { composerRoutes } from './routes.js';
import { composerVersionInput } from './version-object.js';

const org = orgContext('org-1');
const actor: ProjectActor = {
  kind: 'project',
  userId: 'user-1',
  orgId: org.orgId as OrgId,
  projectId: 'proj-1',
  permissions: new Set(['project:packages:read']),
};
const BASE_PKG: ResolvedPackage = {
  projectId: actor.projectId,
  ecosystem: 'composer',
  key: 'acme/lib',
  packageId: 'pk-1',
  sourceId: 'src-1',
  rev: 7,
  modifiedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  listingComplete: true,
  cacheEpoch: '1',
};
const IDS = ['01ARZ3NDEKTSV4RRFFQ69G5FA1', '01ARZ3NDEKTSV4RRFFQ69G5FA2'] as const;
const ORIGIN = {
  probe: { secrets: ['s3cr3t-token-value'], queryParams: ['access_token'] },
  importedAt: '2026-10-16T08:00:00.000Z',
};
const WHEN = Date.parse('2026-10-16T12:00:00Z');

function row(index: number, over: Partial<CatalogueVersion> = {}): CatalogueVersion {
  return {
    versionId: IDS[index]!,
    revision: 1,
    version: `1.${index}.0`,
    versionNormalized: `1.${index}.0.0`,
    stability: 'stable',
    status: 'active',
    publishedAt: BASE_PKG.createdAt,
    upstreamReleasedAt: null,
    license: null,
    distType: 'zip',
    composerShasum: null,
    npmIntegrity: null,
    deprecatedMessage: null,
    metadataJson: JSON.stringify({
      name: BASE_PKG.key,
      dist: { url: 'https://upstream.invalid/a.zip', reference: `ref-${index}` },
    }),
    ...over,
  };
}

function world(initial: CatalogueVersion[] = [row(0), row(1)]) {
  const state = { pkg: { ...BASE_PKG }, rows: initial, now: WHEN };
  const stored = new Map<string, { validator: string; at: number }>();
  const reader = {
    resolveVersions: async (_ctx: unknown, query: { key: string }) =>
      query.key !== state.pkg.key
        ? null
        : {
            pkg: state.pkg,
            versions: state.rows,
            next: null,
            binding: {
              packageId: state.pkg.packageId,
              sourceId: state.pkg.sourceId,
              rev: state.pkg.rev,
            },
          },
  } as unknown as CatalogueReader;
  const access = createPackageAccess(reader);
  const clock: RepresentationClock = {
    advance: async (_ctx, input): Promise<ClockReading> => {
      const slot = `${input.projectId}|${input.keyHash}|${input.form}`;
      const previous = stored.get(slot);
      if (previous === undefined || previous.validator !== input.validator) {
        const at = Math.max(Math.floor(state.now / 1000) * 1000, (previous?.at ?? 0) + 1000);
        stored.set(slot, { validator: input.validator, at });
      }
      const current = stored.get(slot)!;
      return {
        stale: false,
        validator: current.validator,
        lastModified: new Date(current.at).toISOString().replace('.000Z', 'Z'),
      };
    },
  };
  const render = (headers: Record<string, string> = {}, dev = false, name = BASE_PKG.key) =>
    renderComposerP2({
      requestId: 'req-1',
      actor,
      access,
      clock,
      projectSlug: 'demo',
      publicUrl: 'https://broker.invalid',
      name,
      dev,
      request: new Request('https://broker.invalid/demo/p2/acme/lib.json', { headers }),
    });
  return { state, access, clock, render };
}

async function versionsOf(response: Response) {
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    packages: Record<string, Record<string, unknown>[]>;
  };
  return expandVersions(body.packages[BASE_PKG.key]!, { maxVersions: 20 });
}

function without(object: Record<string, unknown>, ...keys: string[]) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

function ingest(raw: Record<string, unknown>): CatalogueVersion {
  const result = composerVersionInput(BASE_PKG.key, raw, ORIGIN);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  const { input } = result;
  return row(0, {
    version: input.version,
    versionNormalized: input.versionNormalized,
    upstreamReleasedAt: input.upstreamReleasedAt,
    license: input.license,
    distType: input.distType,
    metadataJson: input.metadata.json,
  });
}

describe('PB-109 full metadata', () => {
  const upstream = {
    name: 'acme/lib',
    version: '1.0.0',
    version_normalized: '1.0.0.0',
    description: 'A library',
    keywords: ['a', 'b'],
    homepage: 'https://example.test/lib',
    readme: 'README.md',
    time: '2024-05-06T07:08:09+00:00',
    license: ['MIT'],
    authors: [{ name: 'Ann', homepage: 'https://example.test/ann' }],
    support: { issues: 'https://example.test/issues' },
    funding: [{ type: 'github', url: 'https://github.com/sponsors/ann' }],
    type: 'library',
    autoload: { 'psr-4': { 'Acme\\': 'src/' } },
    'autoload-dev': { 'psr-4': { 'Acme\\Tests\\': 'tests/' } },
    'include-path': ['lib/'],
    'target-dir': 'Acme/Lib',
    bin: ['bin/lib'],
    require: { php: '>=8.1' },
    'require-dev': { 'phpunit/phpunit': '^10' },
    conflict: { 'acme/old': '*' },
    replace: { 'acme/legacy': 'self.version' },
    provide: { 'psr/log-implementation': '1.0' },
    suggest: { 'acme/extra': 'more' },
    extra: { 'branch-alias': { 'dev-main': '1.x-dev' }, custom: { keep: true } },
    archive: { exclude: ['/tests'] },
    abandoned: 'acme/other',
    'default-branch': false,
    dist: {
      type: 'zip',
      url: 'https://upstream.invalid/lib.zip',
      reference: 'abc123',
      shasum: '',
    },
    source: { type: 'git', url: 'https://example.test/lib.git', reference: 'abc123' },
  };
  const dropped = {
    uid: 12345,
    'notification-url': 'https://packagist.invalid/downloads/',
    'installation-source': 'dist',
    config: { x: 1 },
    scripts: { post: 'x' },
    repositories: [],
    'minimum-stability': 'dev',
    'prefer-stable': true,
  };

  it('serves every preserved key unchanged and drops only the documented keys', async () => {
    const h = world([ingest({ ...upstream, ...dropped })]);
    const [rendered] = await versionsOf(await h.render());
    const preserved = without(upstream, 'dist', 'source', 'time');
    expect(rendered).toMatchObject({ ...preserved, time: '2024-05-06T07:08:09.000Z' });
    for (const key of Object.keys(dropped)) expect(rendered).not.toHaveProperty(key);
    expect(rendered).not.toHaveProperty('source');
    expect(rendered!.dist).toEqual({
      type: 'zip',
      url: `https://broker.invalid/demo/dist/acme/lib/${IDS[0]}.1.zip`,
      reference: upstream.dist.reference,
      shasum: '',
    });
    expect(JSON.stringify(rendered)).not.toContain('upstream.invalid');
    expect(JSON.stringify(rendered)).not.toContain('s3cr3t');
  });

  it('keeps source when the upstream object has no usable dist', async () => {
    const h = world([ingest(without(upstream, 'dist'))]);
    const [rendered] = await versionsOf(await h.render());
    expect(rendered).not.toHaveProperty('dist');
    expect(rendered!.source).toEqual(upstream.source);
  });

  it('serves the stored composer shasum in the rewritten dist block', async () => {
    const shasum = 'a'.repeat(40);
    const h = world([ingest(upstream)]);
    h.state.rows = [{ ...h.state.rows[0]!, composerShasum: shasum }];
    const [rendered] = await versionsOf(await h.render());
    expect((rendered!.dist as { shasum: string }).shasum).toBe(shasum);
  });
});

describe('PB-109 conditional requests (renderer output)', () => {
  const lastModified = async (response: Response) => response.headers.get('Last-Modified')!;

  it('emits Last-Modified and answers an exact If-Modified-Since with an empty 304', async () => {
    const h = world();
    const first = await h.render();
    const stamp = await lastModified(first);
    expect(stamp).toBe('Fri, 16 Oct 2026 12:00:00 GMT');
    expect(first.headers.get('Vary')).toBe('Authorization');
    const second = await h.render({ 'If-Modified-Since': stamp });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(second.headers.get('Last-Modified')).toBe(stamp);
    expect(second.headers.get('Vary')).toBe('Authorization');
  });

  const STAMP = 'Fri, 16 Oct 2026 12:00:00 GMT';
  it.each([
    ['a later date', { 'If-Modified-Since': 'Fri, 16 Oct 2026 12:00:01 GMT' }],
    ['an earlier date', { 'If-Modified-Since': 'Fri, 16 Oct 2026 11:59:59 GMT' }],
    ['another format', { 'If-Modified-Since': '2026-10-16T12:00:00Z' }],
    ['a different case', { 'If-Modified-Since': 'fri, 16 oct 2026 12:00:00 gmt' }],
    ['an empty value', { 'If-Modified-Since': '' }],
    [
      'a non-matching If-None-Match beside an exact If-Modified-Since',
      { 'If-None-Match': '"x"', 'If-Modified-Since': STAMP },
    ],
  ])('answers 200 for %s', async (_name, headers) => {
    const h = world();
    await h.render();
    const response = await h.render(headers);
    expect(response.status).toBe(200);
    expect((await versionsOf(response)).length).toBe(2);
  });

  it('keeps Last-Modified stable while the representation is unchanged', async () => {
    const h = world();
    const stamp = await lastModified(await h.render());
    h.state.now += 3_600_000;
    expect(await lastModified(await h.render())).toBe(stamp);
    expect((await h.render({ 'If-Modified-Since': stamp })).status).toBe(304);
  });

  it('does not answer 304 to a stale clock reading and omits Last-Modified', async () => {
    const h = world();
    const stamp = await lastModified(await h.render());
    const stale = vi.spyOn(h.clock, 'advance').mockResolvedValue({
      stale: true,
      validator: 'x',
      lastModified: '2026-10-16T12:00:00Z',
    });
    const response = await h.render({ 'If-Modified-Since': stamp });
    expect(response.status).toBe(200);
    expect(response.headers.has('Last-Modified')).toBe(false);
    stale.mockRestore();
  });

  it('invalidates the old stamp on a winner swap with an equal modified timestamp', async () => {
    const h = world();
    const before = await lastModified(await h.render());
    h.state.pkg = { ...h.state.pkg, packageId: 'pk-2', sourceId: 'src-2' };
    const response = await h.render({ 'If-Modified-Since': before });
    expect(response.status).toBe(200);
    expect(response.headers.get('Last-Modified')).toBe('Fri, 16 Oct 2026 12:00:01 GMT');
    expect(h.state.pkg.modifiedAt).toBe(BASE_PKG.modifiedAt);
  });

  it('invalidates the old stamp on a cache epoch change', async () => {
    const h = world();
    const before = await lastModified(await h.render());
    h.state.pkg = { ...h.state.pkg, cacheEpoch: '2' };
    const response = await h.render({ 'If-Modified-Since': before });
    expect(response.status).toBe(200);
    expect(await lastModified(response)).not.toBe(before);
  });

  it('a rev change changes the validator, and the fake clock advances Last-Modified by 1 s within the same second', async () => {
    const h = world();
    const first = await lastModified(await h.render());
    h.state.pkg = { ...h.state.pkg, rev: h.state.pkg.rev + 1 };
    const second = await h.render({ 'If-Modified-Since': first });
    expect(second.status).toBe(200);
    const advanced = await lastModified(second);
    expect(Date.parse(advanced) - Date.parse(first)).toBe(1000);
    h.state.pkg = { ...h.state.pkg, rev: h.state.pkg.rev + 1 };
    expect(Date.parse(await lastModified(await h.render())) - Date.parse(advanced)).toBe(1000);
  });
});

function routeContext(
  path: string,
  params: Record<string, string>,
  outcome: PackageVisibility | null,
  headers: Record<string, string> = {},
): RequestContext {
  const ctx = {
    request: new Request(`https://broker.test${path}`, { headers }),
    requestId: 'req-1',
    org,
    principal: { kind: 'user', id: 'user-1' },
    projectId: actor.projectId,
    params,
    ports: {},
  } as unknown as RequestContext;
  setContextPackageActor(ctx, actor);
  if (outcome !== null && outcome.kind !== 'absent') setResolvedPackage(ctx, outcome);
  return ctx;
}

const visible = (pkg: ResolvedPackage): PackageVisibility => ({
  kind: 'visible',
  pkg,
  cacheKey: () => {
    throw new Error('unused');
  },
  epochReader: { read: async () => null },
});

describe('PB-109 Composer 1, route headers and 404 headers', () => {
  const unusedAccess = {
    versions: vi.fn(),
    list: vi.fn(),
  } as unknown as PackageAccess;
  const routesFor = (access: PackageAccess, fill?: OnDemandFill, clock?: RepresentationClock) =>
    composerRoutes({
      access,
      fill: fill ?? { ensure: async () => ({ kind: 'serve', stale: false }) },
      dist: { serve: async () => ({ kind: 'not_found' }) },
      clock: clock ?? world().clock,
      publicUrl: 'https://broker.test',
    });

  it('p2 route answers an exact If-Modified-Since with an empty revalidating 304', async () => {
    const h = world();
    const p2 = routesFor(h.access, undefined, h.clock).find(
      (r) => r.path === '/:project/p2/:vendor/:file',
    )!;
    const call = (headers: Record<string, string> = {}) =>
      p2.handler(
        routeContext(
          '/demo/p2/acme/lib.json',
          { project: 'demo', vendor: 'acme', file: 'lib.json' },
          visible(h.state.pkg),
          headers,
        ),
      );
    const first = await call();
    expect(first.status).toBe(200);
    const stamp = first.headers.get('Last-Modified')!;
    const second = await call({ 'If-Modified-Since': stamp });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(second.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(second.headers.get('Vary')).toBe('Authorization');
    expect(second.headers.get('Last-Modified')).toBe(stamp);
    expect(second.headers.has('Expires')).toBe(false);
  });

  it('answers Composer 1 on packages.json with 406 before reading the catalogue', async () => {
    const root = routesFor(unusedAccess).find((r) => r.path === '/:project/packages.json')!;
    const response = await root.handler(
      routeContext('/demo/packages.json', { project: 'demo' }, null, {
        'user-agent': 'Composer/1.10.27 (Linux; PHP 8.2)',
      }),
    );
    expect(response.status).toBe(406);
    expect(await response.json()).toMatchObject({ error: { code: 'not_acceptable' } });
    expect(unusedAccess.list).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown package', ['unknown/lib']],
    ['invalid name', ['invalid-name']],
  ])(
    'renderer output (not used by the route): 404 for %s is private, cacheable for 300 s and varies on Authorization',
    async (_n, [name]) => {
      const response = await world().render({}, false, name);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
      expect(response.headers.get('Vary')).toBe('Authorization');
      expect(response.headers.get('x-request-id')).toBe('req-1');
    },
  );

  it('renderer output (not used by the route): 404 for a form without versions carries the same headers', async () => {
    const response = await world([row(0)]).render({}, true);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(response.headers.get('Vary')).toBe('Authorization');
  });

  it('p2 route 404 for a form without versions is byte-identical to the 404 for an absent package', async () => {
    const h = world([row(0)]);
    const p2 = (ensure: OnDemandFill['ensure']) =>
      routesFor(h.access, { ensure }, h.clock).find(
        (r) => r.path === '/:project/p2/:vendor/:file',
      )!;
    const call = (route: ReturnType<typeof p2>, outcome: PackageVisibility) =>
      route.handler(
        routeContext(
          '/demo/p2/acme/lib~dev.json',
          { project: 'demo', vendor: 'acme', file: 'lib~dev.json' },
          outcome,
        ),
      );
    const snapshot = async (response: Response) => ({
      status: response.status,
      headers: [...response.headers].filter(([name]) => name !== 'x-request-id'),
      body: await response.text(),
    });
    const noVersions = await call(
      p2(async () => ({ kind: 'serve', stale: false })),
      visible(h.state.pkg),
    );
    const absent = await call(
      p2(async () => ({ kind: 'not_found' })),
      {
        kind: 'proxy_admissible',
        projectId: actor.projectId,
        ecosystem: 'composer',
        key: BASE_PKG.key,
        sourceIds: ['src-1'],
      },
    );
    expect(noVersions.status).toBe(404);
    expect(noVersions.headers.get('Cache-Control')).toBe('no-store');
    expect(await snapshot(noVersions)).toEqual(await snapshot(absent));
  });
});

describe('PB-109 dist URL stability', () => {
  const urls = async (h: ReturnType<typeof world>) =>
    Object.fromEntries(
      (await versionsOf(await h.render())).map((v) => [v.version, (v.dist as { url: string }).url]),
    );

  it('keeps a version URL across package revisions and re-renders', async () => {
    const h = world();
    const before = await urls(h);
    h.state.pkg = { ...h.state.pkg, rev: 99, cacheEpoch: '5', modifiedAt: '2026-10-09T00:00:00Z' };
    expect(await urls(h)).toEqual(before);
  });

  it('changes only the republished version URL, to its new revision', async () => {
    const h = world();
    const before = await urls(h);
    h.state.rows = [h.state.rows[0]!, { ...h.state.rows[1]!, revision: 2 }];
    const after = await urls(h);
    expect(after['1.0.0']).toBe(before['1.0.0']);
    expect(after['1.1.0']).toBe(`https://broker.invalid/demo/dist/acme/lib/${IDS[1]}.2.zip`);
    expect(parseComposerDistPath(new URL(before['1.1.0']!).pathname)).toMatchObject({
      versionId: IDS[1],
      revision: 1,
    });
  });
});

describe('PB-109 old revision URLs never serve replacement bytes', () => {
  const enc = new TextEncoder();
  const digest = (bytes: Uint8Array): Sha256 =>
    parseSha256(createHash('sha256').update(bytes).digest('hex'));
  const old = enc.encode('revision one bytes');
  const replacement = enc.encode('replacement bytes');

  function distHarness(liveRevisionOne: boolean) {
    const bytes = new Map<string, Uint8Array>([[digest(replacement), replacement]]);
    if (liveRevisionOne) bytes.set(digest(old), old);
    const blobOf = (data: Uint8Array) => ({
      id: `blob-${digest(data).slice(0, 6)}`,
      sha256: digest(data),
      sizeBytes: data.length,
      mediaType: 'application/zip',
      refetchable: true,
    });
    const target = (revision: number): DistTarget | null =>
      revision !== 1 && revision !== 2
        ? null
        : {
            versionId: IDS[0],
            revision,
            current: revision === 2,
            packageId: 'pk-1',
            sourceId: 'src-1',
            status: 'active',
            blob: blobOf(revision === 1 ? old : replacement),
            fetch: {
              sourceRef: null,
              upstreamDistUrl: 'https://upstream.invalid/a.zip',
              distType: 'zip',
              composerShasum: null,
              npmIntegrity: null,
              npmShasum: null,
            },
          };
    const opened: string[] = [];
    const store: Pick<BlobStore, 'get' | 'head'> = {
      async get(_ctx, key) {
        opened.push(key);
        const found = bytes.get(key);
        return found === undefined
          ? null
          : {
              info: {
                generation: 'g',
                sha256: key,
                size: found.length,
                mediaType: 'application/zip',
                purgeAfter: null,
              },
              body: new Response(found).body!,
            };
      },
      async head() {
        return null;
      },
    };
    const leases: FetchLeases = {
      acquire: vi.fn(async () => 'held' as const),
      renew: vi.fn(),
      release: vi.fn(),
    } as unknown as FetchLeases;
    const service = createDistService({
      access: {
        dist: async (_actor, _eco, _key, request) =>
          request.by === 'id' ? target(request.revision) : null,
      },
      store,
      leases,
      clock: systemClock,
      leaseKey: async (parts) => parts.join(':'),
      writeGuard: vi.fn(),
      planFetch: vi.fn(async () => null),
      recorder: { record: vi.fn() },
    });
    const route = composerRoutes({
      access: {} as PackageAccess,
      fill: { ensure: vi.fn() },
      dist: service,
      clock: world().clock,
      publicUrl: 'https://broker.test',
    }).find((r) => r.path === '/:project/dist/:vendor/:name/:file')!;
    const get = (revision: number) =>
      route.handler(
        routeContext(
          `/demo/dist/acme/lib/${IDS[0]}.${revision}.zip`,
          { project: 'demo', vendor: 'acme', name: 'lib', file: `${IDS[0]}.${revision}.zip` },
          visible(BASE_PKG),
        ),
      );
    return { get, opened, leases };
  }

  it('answers 404 for a superseded revision whose bytes are gone, while the new one serves', async () => {
    const h = distHarness(false);
    const gone = await h.get(1);
    expect(gone.status).toBe(404);
    expect(await gone.text()).not.toContain('replacement');
    expect(h.opened).not.toContain(digest(replacement));
    expect(h.leases.acquire).not.toHaveBeenCalled();
    const current = await h.get(2);
    expect(current.status).toBe(200);
    expect(await current.text()).toBe('replacement bytes');
  });

  it('serves a superseded revision from its own live blob', async () => {
    const h = distHarness(true);
    const response = await h.get(1);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('revision one bytes');
    expect(response.headers.get('Content-Disposition')).toContain(`${IDS[0]}.1.zip`);
  });

  it('answers 404 for a revision that never existed', async () => {
    expect((await distHarness(true).get(3)).status).toBe(404);
  });
});
