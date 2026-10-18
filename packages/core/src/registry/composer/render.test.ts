import { describe, expect, it, vi } from 'vitest';
import type { ProjectActor } from '../../authz/project-actor.js';
import type { PackageAccess } from '../../catalogue/package-access.js';
import type { CatalogueVersion, PackageResolution, ResolvedPackage } from '../../db/catalogue.js';
import type { OrgId } from '../../db/port.js';
import { catalogueCacheKey } from '../../catalogue/cache-keys.js';
import type { ScopedCache } from '../../platform/cache.js';
import type { RepresentationClock } from '../conditional.js';
import { expandVersions } from './minify.js';
import { renderComposerP2, renderPackagesJson } from './render.js';

const actor: ProjectActor = {
  kind: 'project',
  userId: 'u',
  orgId: 'o' as OrgId,
  projectId: 'p',
  permissions: new Set(['project:packages:read']),
};
const pkg: ResolvedPackage = {
  projectId: 'p',
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
function version(over: Partial<CatalogueVersion> = {}): CatalogueVersion {
  return {
    versionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
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
    metadataJson: JSON.stringify({
      name: 'Acme/Lib',
      description: 'library',
      dist: { reference: 'abc', url: 'https://upstream.invalid/archive' },
      source: { type: 'git', url: 'https://upstream.invalid/repo' },
    }),
    ...over,
  };
}
function page(versions = [version()], over: Partial<PackageResolution> = {}): PackageResolution {
  return {
    pkg,
    versions,
    next: null,
    binding: { packageId: 'pk', sourceId: 's', rev: 1 },
    ...over,
  };
}
function harness() {
  const versions = vi.fn<PackageAccess['versions']>().mockResolvedValue(page());
  const list = vi
    .fn<PackageAccess['list']>()
    .mockResolvedValue({ items: [], next: null, openNamespace: false });
  const access = { versions, list } as unknown as PackageAccess;
  const clock: RepresentationClock = {
    advance: vi.fn(async (_ctx, input) => ({
      stale: false,
      validator: input.validator,
      lastModified: '2026-10-01T00:00:00Z',
    })),
  };
  const options = {
    actor,
    access,
    clock,
    projectSlug: 'project',
    publicUrl: 'https://broker.invalid',
    name: 'Acme/Lib',
    request: new Request('https://broker.invalid/project/p2/acme/lib.json'),
  };
  return { versions, list, clock, options };
}

describe('Composer documents', () => {
  it('preserves dependency-only metapackages in a successful p2 document', async () => {
    const h = harness();
    const metadata = {
      name: 'Acme/Lib',
      type: 'metapackage',
      require: { 'acme/dependency': '^2.0', php: '^8.2' },
      conflict: { 'acme/incompatible': '<1.0' },
    };
    h.versions.mockResolvedValue(
      page([version({ distType: null, metadataJson: JSON.stringify(metadata) })]),
    );
    const response = await renderComposerP2(h.options);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      packages: Record<string, Record<string, unknown>[]>;
      minified: string;
    };
    expect(body.minified).toBe('composer/2.0');
    const expanded = expandVersions(body.packages['Acme/Lib']!, { maxVersions: 10 });
    expect(expanded).toEqual([
      {
        ...metadata,
        version: '1.0.0',
        version_normalized: '1.0.0.0',
        time: '2026-10-01T00:00:00Z',
      },
    ]);
  });
  it.each(['p2 permission denied', 'p2 package hidden', 'p2 empty', 'root permission denied'])(
    'varies private 404 responses by Authorization: %s',
    async (scenario) => {
      const h = harness();
      const denied = { ...h.options, actor: { ...actor, permissions: new Set<string>() } };
      if (scenario === 'p2 package hidden') h.versions.mockResolvedValue(null);
      if (scenario === 'p2 empty') h.versions.mockResolvedValue(page([]));
      const response =
        scenario === 'root permission denied'
          ? await renderPackagesJson(denied)
          : await renderComposerP2(scenario === 'p2 permission denied' ? denied : h.options);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
      expect(response.headers.get('Vary')).toBe('Authorization');
    },
  );
  it('stores a fully buffered document with the epoch captured before the catalogue read', async () => {
    const h = harness();
    const currentVersion = vi.fn(async () => '1');
    const set = vi.fn<ScopedCache['set']>().mockResolvedValue('stored');
    const cache = { currentVersion, set } as unknown as ScopedCache;
    const response = await renderComposerP2({ ...h.options, cache });
    expect(currentVersion.mock.invocationCallOrder[0]).toBeLessThan(
      h.versions.mock.invocationCallOrder[0]!,
    );
    expect(set).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      catalogueCacheKey(pkg, 'composer-p2'),
      expect.objectContaining({
        value: new Uint8Array(await response.arrayBuffer()),
        negative: false,
      }),
      { expectedVersion: '1', origin: { status: 200, authenticated: true, authorized: true } },
    );
  });
  it('reads at most 200 names per page and includes exactly 1000 visible names', async () => {
    const h = harness();
    h.list.mockImplementation(async (_actor, _ecosystem, query) => {
      expect(query.limit).toBe(200);
      const start = Number(query.after ?? 0);
      return {
        items: Array.from({ length: 200 }, (_, i) => ({
          key: `acme/lib${start + i}`,
          packageId: 'pk',
          sourceId: 's',
          description: null,
        })),
        next: start === 800 ? null : String(start + 200),
        openNamespace: false,
      };
    });
    const body = (await (await renderPackagesJson(h.options)).json()) as Record<string, string[]>;
    expect(body['available-packages']).toHaveLength(1000);
    expect(h.list).toHaveBeenCalledTimes(5);
  });
  it('expands minified versions in reader order with broker dists and release times', async () => {
    const h = harness();
    h.versions.mockResolvedValue(
      page([
        version(),
        version({
          version: '2.0.0',
          versionNormalized: '2.0.0.0',
          upstreamReleasedAt: '2026-09-01T00:00:00Z',
        }),
      ]),
    );
    const response = await renderComposerP2(h.options);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      packages: Record<string, Record<string, unknown>[]>;
      minified: string;
    };
    expect(body.minified).toBe('composer/2.0');
    const expanded = expandVersions(body.packages['Acme/Lib']!, { maxVersions: 10 });
    expect(expanded.map((v) => v.version)).toEqual(['1.0.0', '2.0.0']);
    expect(expanded[0]).toMatchObject({
      version_normalized: '1.0.0.0',
      time: '2026-10-01T00:00:00Z',
      dist: {
        type: 'zip',
        url: 'https://broker.invalid/project/dist/acme/lib/01ARZ3NDEKTSV4RRFFQ69G5FAV.1.zip',
        reference: 'abc',
        shasum: '',
      },
    });
    expect(expanded[0]).not.toHaveProperty('source');
    expect(expanded[1]?.time).toBe('2026-09-01T00:00:00Z');
  });
  it('separates dev from release versions including prereleases', async () => {
    const h = harness();
    h.versions.mockResolvedValue(
      page([
        version({ stability: 'beta' }),
        version({ stability: 'dev', version: 'dev-main', versionNormalized: 'dev-main' }),
      ]),
    );
    const body = await (await renderComposerP2({ ...h.options, dev: true })).text();
    expect(body).toContain('dev-main');
    expect(body).not.toContain('1.0.0');
  });
  it('returns private 404 for zero renderable versions before incomplete-listing refusal', async () => {
    const h = harness();
    h.versions.mockResolvedValue(page([], { pkg: { ...pkg, listingComplete: false } }));
    const response = await renderComposerP2(h.options);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(h.clock.advance).not.toHaveBeenCalled();
  });
  it('refuses a nonempty incomplete listing', async () => {
    const h = harness();
    h.versions.mockResolvedValue(page([version()], { pkg: { ...pkg, listingComplete: false } }));
    expect((await renderComposerP2(h.options)).status).toBe(503);
  });
  it.each([{ 'If-None-Match': '*' }, { 'If-Modified-Since': 'Thu, 01 Oct 2026 00:00:00 GMT' }])(
    'authorizes before validators for %j',
    async (headers) => {
      const h = harness();
      const options = { ...h.options, request: new Request(h.options.request, { headers }) };
      h.versions.mockResolvedValue(null);
      expect((await renderComposerP2(options)).status).toBe(404);
      expect(h.clock.advance).not.toHaveBeenCalled();
      expect(
        (await renderComposerP2({ ...options, actor: { ...actor, permissions: new Set() } }))
          .status,
      ).toBe(404);
    },
  );
  it('preserves cache headers on 304 and uses the canonical package in the clock', async () => {
    const h = harness();
    const response = await renderComposerP2({
      ...h.options,
      request: new Request(h.options.request, {
        headers: { 'If-Modified-Since': 'Thu, 01 Oct 2026 00:00:00 GMT' },
      }),
    });
    expect(response.status).toBe(304);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(response.headers.has('Expires')).toBe(true);
    expect(h.clock.advance).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      expect.objectContaining({ packageId: pkg.packageId, keyHash: expect.any(String) }),
    );
  });
  it('restarts once before bytes, then returns 503 on another change', async () => {
    const h = harness();
    const first = page([version()], { next: { publishedAt: '2026-10-01', id: 'v' } });
    h.versions
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ changed: true })
      .mockResolvedValueOnce(page());
    expect((await renderComposerP2(h.options)).status).toBe(200);
    expect(h.versions).toHaveBeenCalledTimes(3);
    h.versions
      .mockReset()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ changed: true })
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ changed: true });
    expect((await renderComposerP2(h.options)).status).toBe(503);
  });
  it('aborts a large stream after bytes on a bound page change', async () => {
    const h = harness();
    const large = Array.from({ length: 7 }, (_, i) =>
      version({
        version: `${i}.0.0`,
        metadataJson: JSON.stringify({ name: 'Acme/Lib', description: String(i).repeat(200000) }),
      }),
    );
    const first = page(large, { next: { publishedAt: '2026-10-01', id: 'v' } });
    h.versions.mockResolvedValueOnce(first).mockResolvedValueOnce({ changed: true });
    const response = await renderComposerP2(h.options);
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.byteLength).toBeGreaterThan(0);
    await expect(
      (async () => {
        while (!(await reader.read()).done) {
          /* drain */
        }
      })(),
    ).rejects.toThrow('catalogue changed');
    expect(h.versions.mock.calls[1]?.[3].binding).toEqual(first.binding);
  });
  it('omits upstream dist for unsupported archive types', async () => {
    const h = harness();
    h.versions.mockResolvedValue(page([version({ distType: 'tgz' })]));
    const body = await (await renderComposerP2(h.options)).text();
    expect(body).not.toContain('archive');
  });
  it.each([true, false])(
    'lists available packages only for a closed namespace (%s)',
    async (openNamespace) => {
      const h = harness();
      h.list.mockResolvedValue({
        items: [{ key: 'acme/lib', packageId: 'pk', sourceId: 's', description: null }],
        next: null,
        openNamespace,
      });
      const body = await (await renderPackagesJson(h.options)).json();
      expect(body).toEqual({
        packages: [],
        'metadata-url': '/project/p2/%package%.json',
        ...(openNamespace ? {} : { 'available-packages': ['acme/lib'] }),
      });
    },
  );
  it('omits available packages when more than 1000 names are visible', async () => {
    const h = harness();
    h.list.mockResolvedValue({
      items: Array.from({ length: 1000 }, (_, i) => ({
        key: `acme/lib${i}`,
        packageId: 'pk',
        sourceId: 's',
        description: null,
      })),
      next: 'more',
      openNamespace: false,
    });
    expect(await (await renderPackagesJson(h.options)).json()).not.toHaveProperty(
      'available-packages',
    );
  });
});
