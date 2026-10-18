import { describe, expect, it } from 'vitest';
import type { ProjectActor } from '../authz/project-actor.js';
import type {
  CatalogueReader,
  DistTarget,
  PackageResolution,
  ResolvedPackage,
} from '../db/catalogue.js';
import type { OrgId } from '../db/port.js';
import { createPackageAccess } from './package-access.js';

const pkg: ResolvedPackage = {
  projectId: 'p1',
  ecosystem: 'composer',
  key: 'acme/lib',
  packageId: 'pk1',
  sourceId: 's1',
  rev: 4,
  modifiedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  listingComplete: true,
  cacheEpoch: '7',
};

const resolution: PackageResolution = {
  pkg,
  versions: [],
  next: null,
  binding: { packageId: 'pk1', sourceId: 's1', rev: 4 },
};

const actor = (permissions: string[] = ['project:packages:read']): ProjectActor => ({
  kind: 'project',
  userId: 'u1',
  orgId: 'o1' as OrgId,
  projectId: 'p1',
  permissions: new Set(permissions),
});

interface Harness {
  reader: CatalogueReader;
  calls: { method: string; args: unknown[] }[];
}

function harness(over: Partial<Record<keyof CatalogueReader, unknown>> = {}): Harness {
  const calls: Harness['calls'] = [];
  const handler = {
    get(_t: unknown, method: string) {
      return (...args: unknown[]) => {
        calls.push({ method, args });
        const custom = over[method as keyof CatalogueReader];
        if (typeof custom === 'function') return Promise.resolve(custom(...args));
        if (method === 'admitProxy') return Promise.resolve([]);
        if (method === 'listVisible') {
          return Promise.resolve({ items: [], next: null, openNamespace: false });
        }
        if (method === 'search') return Promise.resolve([]);
        return Promise.resolve(null);
      };
    },
  };
  return { reader: new Proxy({}, handler) as CatalogueReader, calls };
}

const ABSENT = { kind: 'absent' };

describe('resolve', () => {
  it('returns visible with a cache key and the statement-bound epoch', async () => {
    const h = harness({ resolveVersions: () => resolution });
    const out = await createPackageAccess(h.reader).resolve(actor(), 'composer', 'Acme/Lib');
    if (out.kind !== 'visible') throw new Error('expected visible');
    expect(out.pkg).toBe(pkg);
    expect(out.cacheKey('composer-p2')).toEqual({
      projectId: 'p1',
      sourceId: 's1',
      kind: 'metadata',
      resource: 'composer/composer-p2/pk1:4',
    });
    await expect(out.epochReader.read({ orgId: 'o1' as OrgId })).resolves.toBe('7');
    expect(h.calls.map((c) => c.method)).toEqual(['resolveVersions']);
    expect(h.calls[0]?.args[1]).toMatchObject({
      projectId: 'p1',
      ecosystem: 'composer',
      key: 'acme/lib',
    });
    expect(h.calls[0]?.args[0]).toEqual({ orgId: 'o1' });
  });

  it('uses legacy-case parsing for npm reads', async () => {
    const h = harness({ resolveVersions: () => resolution });
    await createPackageAccess(h.reader).resolve(actor(), 'npm', 'JSONStream');
    expect(h.calls[0]?.args[1]).toMatchObject({ ecosystem: 'npm', key: '!j!s!o!n!stream' });
  });

  it('makes invisible, absent, unparseable, unauthorized and non-project names identical', async () => {
    const absent = harness();
    const access = createPackageAccess(absent.reader);
    const outcomes = [
      await access.resolve(actor(), 'composer', 'acme/lib'),
      await access.resolve(actor(), 'composer', 'not a name'),
      await access.resolve(actor([]), 'composer', 'acme/lib'),
      await access.resolve(
        { ...actor(), kind: 'user' } as unknown as ProjectActor,
        'composer',
        'acme/lib',
      ),
    ];
    for (const o of outcomes) {
      expect(JSON.stringify(o)).toBe(JSON.stringify(ABSENT));
      expect(o).toEqual(ABSENT);
    }
    expect(absent.calls.map((c) => c.method)).toEqual(['resolveVersions', 'admitProxy']);
  });

  it('makes no reader call without project:packages:read or for an unparseable name', async () => {
    const h = harness();
    const access = createPackageAccess(h.reader);
    await access.resolve(actor(['project:read']), 'npm', 'acme');
    await access.resolve(actor(), 'composer', '');
    await access.versions(actor([]), 'composer', 'acme/lib', { limit: 10 });
    await access.version(actor([]), 'composer', 'acme/lib', '1.0.0.0');
    await access.tag(actor([]), 'npm', 'acme', 'latest');
    await access.distTags(actor([]), 'npm', 'acme');
    await access.dist(actor([]), 'composer', 'acme/lib', { by: 'version', versionNormalized: '1' });
    expect(h.calls).toEqual([]);
  });

  it('returns proxy_admissible only for an unseen name the reader admits', async () => {
    const h = harness({ admitProxy: () => ['px1', 'px2'] });
    const out = await createPackageAccess(h.reader).resolve(actor(), 'npm', 'left-pad');
    expect(out).toEqual({
      kind: 'proxy_admissible',
      projectId: 'p1',
      ecosystem: 'npm',
      key: 'left-pad',
      sourceIds: ['px1', 'px2'],
    });
    expect(h.calls.map((c) => c.method)).toEqual(['resolveVersions', 'admitProxy']);
  });

  it('does not admit a proxy when the name is visible', async () => {
    const h = harness({ resolveVersions: () => resolution, admitProxy: () => ['px1'] });
    await createPackageAccess(h.reader).resolve(actor(), 'composer', 'acme/lib');
    expect(h.calls.map((c) => c.method)).not.toContain('admitProxy');
  });

  it('treats a page-changed answer on the first page as absent without admission', async () => {
    const h = harness({ resolveVersions: () => ({ changed: true }), admitProxy: () => ['px1'] });
    const out = await createPackageAccess(h.reader).resolve(actor(), 'composer', 'acme/lib');
    expect(out).toEqual(ABSENT);
    expect(h.calls.map((c) => c.method)).toEqual(['resolveVersions']);
  });
});

describe('reads', () => {
  it('returns version pages without a cache key and passes the binding through', async () => {
    const h = harness({ resolveVersions: () => resolution });
    const binding = { packageId: 'pk1', sourceId: 's1', rev: 4 };
    const after = { publishedAt: '2026-01-01T00:00:00Z', id: 'v1' };
    const out = await createPackageAccess(h.reader).versions(actor(), 'composer', 'acme/lib', {
      limit: 50,
      binding,
      after,
      stability: 'stable',
    });
    expect(out).toBe(resolution);
    expect(Object.keys(out ?? {})).not.toContain('cacheKey');
    expect(h.calls[0]?.args[1]).toEqual({
      projectId: 'p1',
      ecosystem: 'composer',
      key: 'acme/lib',
      limit: 50,
      binding,
      after,
      stability: 'stable',
    });
  });

  it('scopes lookups, listing and search to the actor project', async () => {
    const h = harness();
    const access = createPackageAccess(h.reader);
    await access.version(actor(), 'composer', 'acme/lib', '1.0.0.0');
    await access.tag(actor(), 'npm', 'acme', 'latest');
    await access.distTags(actor(), 'npm', 'acme');
    await access.list(actor(), 'composer', { limit: 20 });
    await access.search(actor(), 'composer', { text: 'acme', limit: 5 });
    expect(h.calls.map((c) => [c.method, (c.args[1] as { projectId: string }).projectId])).toEqual(
      ['lookupVersion', 'lookupTag', 'distTags', 'listVisible', 'search'].map((m) => [m, 'p1']),
    );
  });

  it('returns empty listing and search without the permission', async () => {
    const h = harness();
    const access = createPackageAccess(h.reader);
    expect(await access.list(actor([]), 'composer', { limit: 20 })).toEqual({
      items: [],
      next: null,
      openNamespace: false,
    });
    expect(await access.search(actor([]), 'composer', { text: 'a', limit: 5 })).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('passes expect through to dist and builds no digest form', async () => {
    const target = { versionId: 'v1' } as DistTarget;
    const h = harness({ resolveDist: () => target });
    const expectId = { versionId: 'v1', revision: 2 };
    const out = await createPackageAccess(h.reader).dist(actor(), 'composer', 'acme/lib', {
      by: 'version',
      versionNormalized: '1.0.0.0',
      expect: expectId,
    });
    expect(out).toBe(target);
    expect(h.calls[0]?.args[1]).toEqual({
      projectId: 'p1',
      ecosystem: 'composer',
      key: 'acme/lib',
      by: 'version',
      versionNormalized: '1.0.0.0',
      expect: expectId,
    });
    await createPackageAccess(h.reader).dist(actor(), 'composer', 'acme/lib', {
      by: 'id',
      versionId: 'v1',
      revision: 3,
    });
    expect(h.calls[1]?.args[1]).toEqual({
      projectId: 'p1',
      ecosystem: 'composer',
      key: 'acme/lib',
      by: 'id',
      versionId: 'v1',
      revision: 3,
    });
  });
});
