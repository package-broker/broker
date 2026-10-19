import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { catalogueCacheKey, createCatalogueCache } from '@package-broker/core/catalogue/cache-keys';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import type {
  CatalogueDocKind,
  CatalogueReader,
  CatalogueWriter,
  PackageResolution,
  ResolvedPackage,
  VersionInput,
  VisibilityStore,
} from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import {
  defaultEntry,
  type BoundCacheKey,
  type Cache,
  type CacheEnvelope,
} from '@package-broker/core/platform/cache';
import { createCatalogueReader } from '../repositories/catalogue.js';
import { createCatalogueEpochReader } from '../repositories/catalogue-epoch.js';
import { createCatalogueWriteGuard } from '../repositories/catalogue-write-package.js';
import { createCatalogueWriter, createVisibilityStore } from '../repositories/catalogue-writer.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';

const ORIGIN = { status: 200, authenticated: true, authorized: true };
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const fence = () =>
  mutationFence({ userId: 'admin', sessionId: 'session' } as AuthenticatedActor, {});

let database: MigratedDatabase;
let org: OrgContext;
let reader: CatalogueReader;
let writer: CatalogueWriter;
let store: VisibilityStore;
let guard: ReturnType<typeof createCatalogueWriteGuard>;
let raw: Cache & { readonly entries: Map<string, CacheEnvelope> };

const input = (n: number): VersionInput => ({
  version: `1.0.${String(n)}`,
  versionNormalized: `1.0.${String(n)}`,
  license: null,
  distType: null,
  sourceRef: null,
  upstreamReleasedAt: null,
  history: { at: '2020-01-01T00:00:00.000Z', basis: 'release_date' },
  metadata: normalizeVersionMetadata('npm', { name: 'widget' }),
});
const sync = (
  sourceId = 'source',
  versions = [input(0), input(1)],
  description: string | null = null,
) =>
  writer.syncPackage(org, guard, {
    sourceId,
    ecosystem: 'npm',
    key: 'widget',
    description,
    versions,
  });
async function scalar(sql: string, ...params: Statement['params']) {
  return (await database.executor.batch([stmt(sql, ...params)]))[0]?.rows[0]?.['value'];
}
const versionId = () =>
  scalar(
    "SELECT id AS value FROM version WHERE org_id = ? AND version = '1.0.0' LIMIT 1",
    org.orgId,
  ) as Promise<string>;

async function resolve(projectId = 'project'): Promise<ResolvedPackage> {
  const result = await reader.resolveVersions(org, {
    projectId,
    ecosystem: 'npm',
    key: 'widget',
    limit: 10,
  });
  if (result === null || 'changed' in result) throw new Error('package not visible');
  return result.pkg;
}

const scopedFor = (pkg: ResolvedPackage) =>
  createCatalogueCache(raw, pkg, createCatalogueEpochReader(database.executor, pkg.packageId), {
    deploymentId: 'deployment',
  });
const entry = () => defaultEntry('metadata', new Uint8Array([1]), new Date());

async function fill(pkg: ResolvedPackage, docKind: CatalogueDocKind) {
  const cache = scopedFor(pkg);
  const key = catalogueCacheKey(pkg, docKind);
  const { version } = await cache.get(org, key);
  expect(version).toBe(pkg.cacheEpoch);
  const result = await cache.set(org, key, entry(), {
    expectedVersion: pkg.cacheEpoch ?? '',
    origin: ORIGIN,
  });
  return { result, digests: [...raw.entries.keys()] };
}
const hit = async (pkg: ResolvedPackage, docKind: CatalogueDocKind) =>
  (await scopedFor(pkg).get(org, catalogueCacheKey(pkg, docKind))).hit !== null;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  org = database.orgs!.a;
  const now = new Date().toISOString();
  const address = ['admin', 'example.test'].join('@');
  await database.executor.batch([
    stmt(
      "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('job', ?, 'sync', 'sync', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
      org.orgId,
    ),
    ...['source', 'source2'].map((id) =>
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, 'npm', 'npm_registry')",
        id,
        org.orgId,
        id,
      ),
    ),
    ...['project', 'project2'].map((id) =>
      stmt(
        'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
        id,
        org.orgId,
        id,
        id,
      ),
    ),
    stmt(
      "INSERT INTO user_account (id, org_id, email, status) VALUES ('admin', ?, ?, 'active')",
      org.orgId,
      address,
    ),
    stmt(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
      org.orgId,
    ),
    stmt(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'admin', 'oidc', 'subject', ?, 1, ?)",
      org.orgId,
      address,
      now,
    ),
    stmt(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES ('session', ?, 'admin', ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
      org.orgId,
      'a'.repeat(64),
      'b'.repeat(64),
      now,
      now,
    ),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('role', ?, 'admin', 'Admin', 'organization', 0)",
      org.orgId,
    ),
    ...['org:sources:write', 'project:sources:write', 'project:packages:manage'].map((p) =>
      stmt(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'role', ?)",
        org.orgId,
        p,
      ),
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id, created_at, updated_at) VALUES ('grant', ?, 'email', ?, 'organization', 'role', ?, ?)",
      org.orgId,
      address,
      now,
      now,
    ),
  ]);
  guard = createCatalogueWriteGuard(org, { id: 'job', owner: 'worker', fence: 1 });
  reader = createCatalogueReader(database.executor);
  writer = createCatalogueWriter(database.executor);
  store = createVisibilityStore(database.executor, {
    providerAnchors: [
      {
        provider: 'oidc',
        anchor: 'oidc:https://idp.example.test',
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ],
  });
  const entries = new Map<string, CacheEnvelope>();
  const id = (k: BoundCacheKey): string => k.digest;
  raw = {
    entries,
    get: (_c, k) => {
      const found = entries.get(id(k));
      return Promise.resolve(
        found === undefined ? null : { entry: found, state: 'fresh' as const },
      );
    },
    set: (_c, k, e) => {
      entries.set(id(k), e);
      return Promise.resolve();
    },
    delete: (_c, k) => {
      entries.delete(id(k));
      return Promise.resolve();
    },
  };
  await sync();
  for (const projectId of ['project', 'project2'])
    await store.attachSource(org, fence(), { projectId, sourceId: 'source' });
});

afterEach(async () => {
  await database.close();
});

describe('catalogue cache isolation', () => {
  it('a project-B fill misses for project A and cannot be read through A', async () => {
    const a = await resolve('project');
    const b = await resolve('project2');
    expect(b).toMatchObject({ packageId: a.packageId, sourceId: a.sourceId, rev: a.rev });
    expect(b.cacheEpoch).toBe(a.cacheEpoch);

    expect((await fill(b, 'npm-full')).result).toBe('stored');

    expect(await hit(b, 'npm-full')).toBe(true);
    expect(await hit(a, 'npm-full')).toBe(false);
    expect((await fill(a, 'npm-full')).digests).toHaveLength(2);
  });

  it('a winner change changes the key', async () => {
    const before = await resolve();
    expect((await fill(before, 'npm-full')).result).toBe('stored');
    await sync('source2');
    await store.attachSource(org, fence(), { projectId: 'project', sourceId: 'source2' });
    await store.setPrecedence(org, fence(), {
      projectId: 'project',
      sourceId: 'source2',
      precedence: 1,
    });
    await store.setPrecedence(org, fence(), {
      projectId: 'project',
      sourceId: 'source',
      precedence: 1000,
    });
    const after = await resolve();

    expect(after.sourceId).toBe('source2');
    expect(after.packageId).not.toBe(before.packageId);
    const keys = [before, after].map((p) => catalogueCacheKey(p, 'npm-full'));
    expect(keys[0]).not.toEqual(keys[1]);
    expect(keys[0]!.sourceId).not.toBe(keys[1]!.sourceId);
    expect(await hit(after, 'npm-full')).toBe(false);
  });

  it.each([
    ['description-only change', () => sync('source', [], 'changed')],
    ['new version', () => sync('source', [input(0), input(1), input(2)])],
  ])('a %s changes the key without bumping the epoch', async (_name, change) => {
    const before = await resolve();
    await fill(before, 'npm-full');

    await change();
    const after = await resolve();

    expect(after.rev).toBeGreaterThan(before.rev);
    expect(after.cacheEpoch).toBe(before.cacheEpoch);
    expect(catalogueCacheKey(after, 'npm-full').resource).not.toBe(
      catalogueCacheKey(before, 'npm-full').resource,
    );
    expect(await hit(after, 'npm-full')).toBe(false);
    expect(await hit(before, 'npm-full')).toBe(true);
  });

  it('keeps separate entries per doc kind', async () => {
    const pkg = await resolve();
    const kinds: CatalogueDocKind[] = [
      'npm-full',
      'npm-abbreviated',
      'composer-p2',
      'composer-p2-dev',
    ];
    const keys = kinds.map((kind) => JSON.stringify(catalogueCacheKey(pkg, kind)));
    expect(new Set(keys).size).toBe(kinds.length);

    await fill(pkg, 'npm-full');
    await fill(pkg, 'composer-p2');

    expect(await hit(pkg, 'npm-full')).toBe(true);
    expect(await hit(pkg, 'npm-abbreviated')).toBe(false);
    expect(await hit(pkg, 'composer-p2')).toBe(true);
    expect(await hit(pkg, 'composer-p2-dev')).toBe(false);
    expect(raw.entries.size).toBe(2);
  });

  it('exposes no cache key for a publishedAtMost read', async () => {
    const result = (await reader.resolveVersions(org, {
      projectId: 'project',
      ecosystem: 'npm',
      key: 'widget',
      publishedAtMost: '2030-01-01T00:00:00.000Z',
      limit: 10,
    })) as PackageResolution;

    expect(result.versions.length).toBeGreaterThan(0);
    expect(Object.keys(result).sort()).toEqual(['binding', 'next', 'pkg', 'versions']);
    expect('cacheKey' in result || 'epochReader' in result).toBe(false);
  });

  it('bypasses the cache when the epoch is null', async () => {
    await database.executor.batch([stmt('DELETE FROM cache_epoch WHERE org_id = ?', org.orgId)]);
    const pkg = await resolve();
    expect(pkg.cacheEpoch).toBeNull();
    const cache = scopedFor(pkg);
    const key = catalogueCacheKey(pkg, 'npm-full');

    expect(await cache.get(org, key)).toEqual({ hit: null, version: null });
    expect(await cache.set(org, key, entry(), { expectedVersion: 'x', origin: ORIGIN })).toBe(
      'bypassed',
    );
    expect(raw.entries.size).toBe(0);
  });
});

describe('catalogue cache invalidation', () => {
  const narrowing: [string, () => Promise<unknown>][] = [
    [
      'detach',
      () => store.detachSource(org, fence(), { projectId: 'project', sourceId: 'source' }),
    ],
    [
      'exclude',
      () =>
        store.addPattern(org, fence(), {
          projectId: 'project',
          sourceId: 'source',
          pattern: '*',
          effect: 'exclude',
        }),
    ],
    [
      'flag flip 1 to 0',
      async () =>
        store.setPackageFlag(org, fence(), {
          packageId: (await resolve()).packageId,
          visibleToNewProjects: false,
        }),
    ],
    [
      'job quarantine',
      async () => {
        const { changed } = await writer.quarantine(org, guard, {
          versionId: await versionId(),
          reason: 'digest_mismatch',
        });
        return { ok: changed };
      },
    ],
    [
      'admin quarantine',
      async () =>
        store.quarantineVersion(org, fence(), {
          versionId: await versionId(),
          reason: 'admin_quarantine',
        }),
    ],
    [
      'tombstone',
      async () =>
        store.tombstoneVersion(org, fence(), {
          versionId: await versionId(),
          reason: 'admin_tombstone',
        }),
    ],
  ];

  async function inFlightFill(between: () => Promise<unknown>) {
    const pkg = await resolve();
    const key = catalogueCacheKey(pkg, 'npm-full');
    const cache = scopedFor(pkg);
    const { version } = await cache.get(org, key);
    expect(version).toBe(pkg.cacheEpoch);
    await between();
    const result = await cache.set(org, key, entry(), {
      expectedVersion: pkg.cacheEpoch ?? '',
      origin: ORIGIN,
    });
    return { result, key, cache };
  }

  it.each(narrowing)('%s between the resolve and the fill discards the fill', async (_n, write) => {
    const { result, key, cache } = await inFlightFill(async () => {
      expect(await write()).toMatchObject({ ok: true });
    });

    expect(result).toBe('discarded');
    expect(raw.entries.size).toBe(0);
    expect((await cache.get(org, key)).hit).toBeNull();
  });

  it('an additive write between the resolve and the fill keeps the fill', async () => {
    const { result } = await inFlightFill(() => sync('source', [input(0), input(1), input(2)]));

    expect(result).toBe('stored');
    expect(raw.entries.size).toBe(1);
  });

  it('a fill with no write in between is stored', async () => {
    expect((await inFlightFill(() => Promise.resolve())).result).toBe('stored');
  });
});
