import { describe, expect, it, vi } from 'vitest';
import type { ProjectActor } from '../../authz/project-actor.js';
import { createPackageAccess } from '../../catalogue/package-access.js';
import { validateVersion } from '../../catalogue/versions.js';
import type { CatalogueReader, CatalogueVersion, ResolvedPackage } from '../../db/catalogue.js';
import type { OrgId } from '../../db/port.js';
import type { RepresentationClock } from '../conditional.js';
import { parseComposerDistPath } from './dist-url.js';
import { expandVersions } from './minify.js';
import { renderComposerP2 } from './render.js';
import { versionsFromRefs } from './version-rules.js';

const actor: ProjectActor = {
  kind: 'project',
  userId: 'user',
  orgId: 'org' as OrgId,
  projectId: 'project',
  permissions: new Set(['project:packages:read']),
};
const pkg: ResolvedPackage = {
  projectId: actor.projectId,
  ecosystem: 'composer',
  key: 'acme/lib',
  packageId: 'package',
  sourceId: 'source',
  rev: 7,
  modifiedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  listingComplete: true,
  cacheEpoch: '1',
};
const pairs = [
  ['v1.2.3', '1.2.3.0'],
  ['1.2.4.0', '1.2.4.0'],
  ['2.0.0-alpha1', '2.0.0.0-alpha1'],
  ['2.0.0-beta2', '2.0.0.0-beta2'],
  ['2.0.0-RC1', '2.0.0.0-RC1'],
  ['dev-main', 'dev-main'],
  ['dev-feature/topic', 'dev-feature/topic'],
  ['1.x-dev', '1.9999999.9999999.9999999-dev'],
  ['v2.4.x-dev', '2.4.9999999.9999999-dev'],
] as const;
const extra = { 'branch-alias': { 'dev-main': '3.0.x-dev' }, custom: { keep: true } };

function seed(version: string, versionNormalized: string, index: number): CatalogueVersion {
  return {
    versionId: `01ARZ3NDEKTSV4RRFFQ69G5FA${index}`,
    revision: index + 1,
    version,
    versionNormalized,
    stability: validateVersion({ ecosystem: 'composer', version, versionNormalized }).stability,
    status: 'active',
    publishedAt: pkg.createdAt,
    upstreamReleasedAt: null,
    license: null,
    distType: 'zip',
    composerShasum: null,
    npmIntegrity: null,
    deprecatedMessage: null,
    metadataJson: JSON.stringify({
      name: pkg.key,
      dist: { url: 'https://upstream.invalid/archive.zip', reference: `ref-${index}` },
      ...(version === 'dev-main' ? { extra, 'default-branch': true } : {}),
    }),
  };
}

function corpus(rows = pairs.map(([pretty, normalized], i) => seed(pretty, normalized, i))) {
  const resolveVersions = vi.fn<CatalogueReader['resolveVersions']>(async (ctx, query) => {
    if (
      ctx.orgId !== actor.orgId ||
      query.projectId !== pkg.projectId ||
      query.ecosystem !== pkg.ecosystem ||
      query.key !== pkg.key
    ) {
      return null;
    }
    return {
      pkg,
      versions: rows,
      next: null,
      binding: { packageId: pkg.packageId, sourceId: pkg.sourceId, rev: pkg.rev },
    };
  });
  const access = createPackageAccess({ resolveVersions } as unknown as CatalogueReader);
  const clock: RepresentationClock = {
    advance: async (_ctx, input) => ({
      stale: false,
      validator: input.validator,
      lastModified: pkg.modifiedAt,
    }),
  };
  const render = (dev = false, name = pkg.key, who = actor) =>
    renderComposerP2({
      actor: who,
      access,
      clock,
      projectSlug: 'project',
      publicUrl: 'https://broker.invalid',
      name,
      dev,
      request: new Request(`https://broker.invalid/project/p2/${name}${dev ? '~dev' : ''}.json`),
    });
  return { render, resolveVersions };
}

async function expanded(response: Response) {
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    minified: string;
    packages: Record<string, Record<string, unknown>[]>;
  };
  expect(body.minified).toBe('composer/2.0');
  expect(Object.keys(body.packages)).toEqual([pkg.key]);
  return expandVersions(body.packages[pkg.key]!, { maxVersions: 20 });
}

describe('PB-109 Composer lookup and version corpus', () => {
  it('p2 includes stable, alpha, beta and RC versions and excludes all dev branches', async () => {
    const h = corpus();
    expect((await expanded(await h.render())).map((v) => v.version)).toEqual(
      pairs.slice(0, 5).map(([pretty]) => pretty),
    );
  });

  it('~dev includes named and numeric branches and excludes stable and prerelease versions', async () => {
    expect((await expanded(await corpus().render(true))).map((v) => v.version)).toEqual(
      pairs.slice(5).map(([pretty]) => pretty),
    );
  });

  it('looks up mixed-case package names through the org-scoped canonical catalogue key', async () => {
    const h = corpus();
    await expanded(await h.render(false, 'Acme/Lib'));
    expect(h.resolveVersions).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      { projectId: actor.projectId, ecosystem: 'composer', key: pkg.key, limit: 200 },
    );
  });

  it.each(pairs)(
    'preserves pretty %s and normalized %s with a revision-exact dist URL',
    async (pretty, normalized) => {
      const index = pairs.findIndex(([version]) => version === pretty);
      const rows = await expanded(await corpus().render(index >= 5));
      const rendered = rows.find((v) => v.version === pretty)!;
      expect(rendered).toMatchObject({ version: pretty, version_normalized: normalized });
      const dist = rendered.dist as { url: string; reference: string; shasum: string };
      expect(dist.url).toBe(
        `https://broker.invalid/project/dist/acme/lib/01ARZ3NDEKTSV4RRFFQ69G5FA${index}.${index + 1}.zip`,
      );
      expect(parseComposerDistPath(new URL(dist.url).pathname)).toMatchObject({
        key: pkg.key,
        versionId: `01ARZ3NDEKTSV4RRFFQ69G5FA${index}`,
        revision: index + 1,
      });
      expect(dist.reference).toBe(`ref-${index}`);
      expect(dist.shasum).toBe('');
    },
  );

  it('preserves x.y.z.0 as the pretty version without truncation', async () => {
    expect(await expanded(await corpus().render())).toContainEqual(
      expect.objectContaining({ version: '1.2.4.0', version_normalized: '1.2.4.0' }),
    );
  });

  it('renders the actual default branch without synthesizing 9999999-dev', async () => {
    const refs = versionsFromRefs([], ['main'], 'main').versions;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ defaultBranch: true });
    const rows = refs.map((ref, i) => seed(ref.version, ref.versionNormalized, i));
    expect(
      (await expanded(await corpus(rows).render(true))).map((v) => v.version_normalized),
    ).toEqual(['dev-main']);
  });

  it('passes branch-alias extra through expansion without inventing alias versions or leaking it to another branch', async () => {
    const rows = await expanded(await corpus().render(true));
    expect(rows.find((v) => v.version === 'dev-main')).toMatchObject({
      extra,
      'default-branch': true,
    });
    expect(rows.map((v) => v.version)).not.toContain('3.0.x-dev');
    for (const row of rows.filter((v) => v.version !== 'dev-main')) {
      expect(row).not.toHaveProperty('extra');
      expect(row).not.toHaveProperty('default-branch');
    }
  });

  it.each(['unknown/lib', 'invalid-name'])('returns a private 404 for lookup %s', async (name) => {
    const response = await corpus().render(false, name);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(response.headers.get('Vary')).toBe('Authorization');
    expect(await response.text()).toBe('');
  });

  it.each([
    { ...actor, permissions: new Set<string>() },
    { ...actor, orgId: 'other-org' as OrgId },
    { ...actor, projectId: 'other-project' },
  ])('returns a uniform 404 outside the authorized project scope: %j', async (who) => {
    const response = await corpus().render(false, pkg.key, who);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it.each([false, true])(
    'returns 404 when the requested dev=%s form has no versions',
    async (dev) => {
      const rows = pairs
        .map(([pretty, normalized], i) => seed(pretty, normalized, i))
        .filter((row) => (row.stability === 'dev') !== dev);
      expect((await corpus(rows).render(dev)).status).toBe(404);
    },
  );
});
