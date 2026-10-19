import { describe, expect, it, vi } from 'vitest';
import type { ProjectActor } from '../../authz/project-actor.js';
import { createPackageAccess } from '../../catalogue/package-access.js';
import type { CatalogueReader, CatalogueVersion, PackageResolution } from '../../db/catalogue.js';
import type { OrgId } from '../../db/port.js';
import { ABBREVIATED_VERSION_FIELDS, renderPackument, renderVersionDocument } from './render.js';

const actor: ProjectActor = {
  kind: 'project',
  userId: 'u',
  orgId: 'org' as OrgId,
  projectId: 'project',
  permissions: new Set(['project:packages:read']),
};
const version: CatalogueVersion = {
  versionId: 'v',
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
  npmIntegrity: 'sha512-catalogue',
  deprecatedMessage: 'use another version',
  metadataJson: JSON.stringify({
    name: '@scope/pkg',
    version: '1.0.0',
    scripts: { install: 'do work' },
    readme: 'hidden',
    bundledDependencies: ['dep'],
    dependencies: { dep: '1' },
    dist: {
      tarball: 'https://upstream.invalid/pkg.tgz',
      integrity: 'old',
      shasum: 'a'.repeat(40),
      signatures: [{ sig: 'upstream' }],
      attestations: { url: 'https://upstream.invalid' },
    },
  }),
};
const page: PackageResolution = {
  pkg: {
    projectId: 'project',
    ecosystem: 'npm',
    key: '@scope/pkg',
    packageId: 'pkg',
    sourceId: 'src',
    rev: 1,
    createdAt: '2020-01-01T00:00:00Z',
    modifiedAt: '2020-01-03T00:00:00Z',
    listingComplete: true,
    cacheEpoch: null,
  },
  versions: [version],
  next: null,
  binding: { packageId: 'pkg', sourceId: 'src', rev: 1 },
};
function harness(overrides: Partial<CatalogueReader> = {}) {
  const reader = {
    resolveVersions: vi.fn(async () => page),
    distTags: vi.fn(async () => ({ pkg: page.pkg, tags: { latest: '1.0.0' } })),
    lookupTag: vi.fn(async () => ({ pkg: page.pkg, version })),
    lookupVersion: vi.fn(async () => ({ pkg: page.pkg, version })),
    ...overrides,
  } as unknown as CatalogueReader;
  return {
    reader,
    options: {
      requestId: crypto.randomUUID(),
      access: createPackageAccess(reader),
      actor,
      projectSlug: 'project',
      name: '@scope/pkg',
      publicUrl: 'https://broker.invalid/base/',
    },
  };
}
async function document(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

describe('npm rendering', () => {
  it.each(['full', 'abbreviated', 'version', 'tag'] as const)(
    'uses the project slug in %s tarball URLs and the project ID for catalogue reads',
    async (kind) => {
      const projectId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      const pkg = { ...page.pkg, projectId };
      const { options, reader } = harness({
        resolveVersions: vi.fn(async () => ({ ...page, pkg })),
        distTags: vi.fn(async () => ({ pkg, tags: { latest: '1.0.0' } })),
        lookupVersion: vi.fn(async () => ({ pkg, version })),
        lookupTag: vi.fn(async () => ({ pkg, version })),
      });
      const renderOptions = {
        ...options,
        actor: { ...actor, projectId },
        projectSlug: 'my-project',
        abbreviated: kind === 'abbreviated',
      };
      const packument = kind === 'full' || kind === 'abbreviated';
      const response = packument
        ? await renderPackument(renderOptions)
        : await renderVersionDocument(renderOptions, kind === 'tag' ? 'latest' : '1.0.0');
      expect(response.status).toBe(200);
      const body = await document(response);
      const manifest = packument
        ? (body.versions as Record<string, Record<string, unknown>>)['1.0.0']!
        : body;
      expect(manifest.dist).toMatchObject({
        tarball: 'https://broker.invalid/base/my-project/npm/@scope/pkg/-/pkg-1.0.0.tgz',
      });
      const reads = packument
        ? [reader.resolveVersions, reader.distTags]
        : [kind === 'tag' ? reader.lookupTag : reader.lookupVersion];
      for (const read of reads) {
        expect(read).toHaveBeenCalledWith(
          { orgId: actor.orgId },
          expect.objectContaining({ projectId, ecosystem: 'npm', key: '@scope/pkg' }),
        );
      }
    },
  );
  it('pins the corgi version allowlist', () => {
    expect(ABBREVIATED_VERSION_FIELDS).toEqual([
      'name',
      'version',
      'deprecated',
      'dependencies',
      'optionalDependencies',
      'devDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
      'bundleDependencies',
      'bin',
      'directories',
      'engines',
      'os',
      'cpu',
      'libc',
      '_hasShrinkwrap',
      'hasInstallScript',
      'dist',
    ]);
  });
  it('renders full metadata with broker dist URLs, catalogue dates and deprecation', async () => {
    const { options, reader } = harness();
    const response = await renderPackument(options);
    expect(response.status).toBe(200);
    expect(response.headers.get('vary')).toBe('Accept, Authorization');
    const text = await response.text();
    expect(text).not.toContain('upstream.invalid');
    expect(text).not.toContain('readme');
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject({
      _id: '@scope/pkg',
      name: '@scope/pkg',
      'dist-tags': { latest: '1.0.0' },
      time: {
        created: page.pkg.createdAt,
        modified: page.pkg.modifiedAt,
        '1.0.0': version.publishedAt,
      },
      versions: {
        '1.0.0': {
          deprecated: version.deprecatedMessage,
          scripts: { install: 'do work' },
          dist: {
            tarball: 'https://broker.invalid/base/project/npm/@scope/pkg/-/pkg-1.0.0.tgz',
            integrity: version.npmIntegrity,
            shasum: 'a'.repeat(40),
          },
        },
      },
    });
    expect(reader.distTags).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      { projectId: actor.projectId, ecosystem: 'npm', key: '@scope/pkg' },
    );
  });
  it('emits only install keys and three dist fields in abbreviated output', async () => {
    const { options } = harness();
    const response = await renderPackument({ ...options, abbreviated: true });
    expect(response.headers.get('content-type')).toBe('application/vnd.npm.install-v1+json');
    const body = await document(response);
    expect(Object.keys(body).sort()).toEqual(['dist-tags', 'modified', 'name', 'versions']);
    const versions = body.versions as Record<string, Record<string, unknown>>;
    const manifest = versions['1.0.0']!;
    expect(
      Object.keys(manifest).every((key) =>
        (ABBREVIATED_VERSION_FIELDS as readonly string[]).includes(key),
      ),
    ).toBe(true);
    expect(manifest).toMatchObject({
      bundleDependencies: ['dep'],
      deprecated: version.deprecatedMessage,
    });
    for (const key of ['scripts', 'readme', 'bundledDependencies'])
      expect(manifest).not.toHaveProperty(key);
    expect(Object.keys(manifest.dist as object).sort()).toEqual(['integrity', 'shasum', 'tarball']);
  });
  it('uses the tag lookup, and returns 404 when it excludes a quarantined target', async () => {
    const lookupTag = vi
      .fn()
      .mockResolvedValueOnce({ pkg: page.pkg, version })
      .mockResolvedValueOnce(null);
    const { options, reader } = harness({ lookupTag });
    expect((await renderVersionDocument(options, 'latest')).status).toBe(200);
    expect((await renderVersionDocument(options, 'latest')).status).toBe(404);
    expect(lookupTag).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      { projectId: actor.projectId, ecosystem: 'npm', key: '@scope/pkg', tag: 'latest' },
    );
    expect(reader.lookupVersion).not.toHaveBeenCalled();
  });
  it('uses an exact version lookup and rewrites legacy shasum-only documents', async () => {
    const { options, reader } = harness({
      lookupVersion: vi.fn(async () => ({
        pkg: page.pkg,
        version: { ...version, npmIntegrity: null, deprecatedMessage: null },
      })),
    });
    const body = await document(await renderVersionDocument(options, '1.0.0'));
    expect(body).not.toHaveProperty('deprecated');
    expect(body.dist).not.toHaveProperty('integrity');
    expect(JSON.stringify(body)).not.toContain('upstream.invalid');
    expect(reader.lookupVersion).toHaveBeenCalled();
  });
  it('returns uniform 404 for missing, denied and empty packages before the completion check', async () => {
    for (const result of [
      null,
      { ...page, versions: [], pkg: { ...page.pkg, listingComplete: false } },
    ]) {
      const { options } = harness({ resolveVersions: vi.fn(async () => result) });
      expect((await renderPackument(options)).status).toBe(404);
    }
    const { options, reader } = harness();
    expect(
      (await renderPackument({ ...options, actor: { ...actor, permissions: new Set() } })).status,
    ).toBe(404);
    expect(reader.resolveVersions).not.toHaveBeenCalled();
  });
  it('refuses a partial first ingest', async () => {
    const { options } = harness({
      resolveVersions: vi.fn(async () => ({
        ...page,
        pkg: { ...page.pkg, listingComplete: false },
      })),
    });
    const response = await renderPackument(options);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('10');
  });
  it('restarts once on changed before sending, then returns 503', async () => {
    const resolveVersions = vi
      .fn()
      .mockResolvedValueOnce({ changed: true })
      .mockResolvedValueOnce(page);
    const { options } = harness({ resolveVersions });
    expect((await renderPackument(options)).status).toBe(200);
    expect(resolveVersions).toHaveBeenCalledTimes(2);
    resolveVersions.mockReset().mockResolvedValue({ changed: true });
    expect((await renderPackument(options)).status).toBe(503);
    expect(resolveVersions).toHaveBeenCalledTimes(2);
  });
  it('restarts when the pre-read tags belong to a different revision', async () => {
    const distTags = vi
      .fn()
      .mockResolvedValueOnce({ pkg: { ...page.pkg, rev: 2 }, tags: {} })
      .mockResolvedValueOnce({ pkg: page.pkg, tags: { latest: '1.0.0' } });
    const { options } = harness({ distTags });
    expect((await renderPackument(options)).status).toBe(200);
    expect(distTags).toHaveBeenCalledTimes(2);
  });
  it('binds subsequent pages and buffers small documents before returning', async () => {
    const cursor = { publishedAt: version.publishedAt, id: 'v' };
    const resolveVersions = vi
      .fn()
      .mockResolvedValueOnce({ ...page, next: cursor })
      .mockResolvedValueOnce({ ...page, versions: [{ ...version, version: '2.0.0' }] });
    const { options } = harness({ resolveVersions });
    const response = await renderPackument(options);
    expect(resolveVersions).toHaveBeenCalledTimes(2);
    expect(resolveVersions.mock.calls[1]?.[1]).toMatchObject({
      binding: page.binding,
      after: cursor,
    });
    expect((await document(response)).versions).toHaveProperty('2.0.0');
  });
  it('streams large documents and aborts on changed after bytes have been sent', async () => {
    const versions = Array.from({ length: 6 }, (_, index) => ({
      ...version,
      version: `${index}.0.0`,
      metadataJson: JSON.stringify({ name: '@scope/pkg', description: 'é'.repeat(110000) }),
    }));
    const resolveVersions = vi
      .fn()
      .mockResolvedValueOnce({
        ...page,
        versions,
        next: { publishedAt: version.publishedAt, id: 'last' },
      })
      .mockResolvedValueOnce({ changed: true });
    const { options, reader } = harness({ resolveVersions });
    const response = await renderPackument(options);
    expect(response.status).toBe(200);
    expect(reader.distTags).toHaveBeenCalledTimes(1);
    expect(resolveVersions).toHaveBeenCalledTimes(1);
    const stream = response.body!.getReader();
    expect((await stream.read()).value?.length).toBeGreaterThan(0);
    await expect(
      (async () => {
        while (!(await stream.read()).done) {
          /* consume */
        }
      })(),
    ).rejects.toThrow('catalogue changed');
    expect(resolveVersions).toHaveBeenCalledTimes(2);
  });
});

describe('npm errors', () => {
  it.each(['packument', 'version', 'tag'] as const)(
    'uses a fixed npm error shape and preserves headers for %s failures',
    async (form) => {
      for (const unavailable of [false, true]) {
        const { options } = harness();
        const access = {
          ...options.access,
          versions: vi.fn(async () =>
            unavailable ? { ...page, pkg: { ...page.pkg, listingComplete: false } } : null,
          ),
          version: vi.fn(async () =>
            unavailable ? { pkg: { ...page.pkg, listingComplete: false }, version } : null,
          ),
          tag: vi.fn(async () =>
            unavailable ? { pkg: { ...page.pkg, listingComplete: false }, version } : null,
          ),
        };
        const requestId = crypto.randomUUID();
        const input = { ...options, access, requestId };
        const response =
          form === 'packument'
            ? await renderPackument(input)
            : await renderVersionDocument(input, form === 'version' ? '1.0.0' : 'latest');
        expect(response.status).toBe(unavailable ? 503 : 404);
        expect(response.headers.get('x-request-id')).toBe(requestId);
        expect(response.headers.get(unavailable ? 'retry-after' : 'cache-control')).toBe(
          unavailable ? '10' : 'private, max-age=300',
        );
        expect(await response.json()).toEqual({
          error: unavailable ? 'Service unavailable' : 'Not found',
          code: unavailable ? 'unavailable' : 'not_found',
          requestId,
        });
      }
    },
  );

  it('uses the supplied id for standalone renderer calls', async () => {
    const { options } = harness({ resolveVersions: vi.fn(async () => null) });
    const response = await renderPackument(options);
    const requestId = options.requestId;
    expect(response.headers.get('x-request-id')).toBe(requestId);
    expect(await response.json()).toEqual({
      error: 'Not found',
      code: 'not_found',
      requestId,
    });
  });
});
