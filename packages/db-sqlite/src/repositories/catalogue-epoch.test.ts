import { visibilityAudit } from '../testing/visibility-audit.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgContext } from '@package-broker/core/db/port';
import type { Cache, EpochReader } from '@package-broker/core/platform/cache';
import { defaultEntry } from '@package-broker/core/platform/cache';
import { catalogueCacheKey, createCatalogueCache } from '@package-broker/core/catalogue/cache-keys';
import { assertGuard, runOrgFenced } from '../kysely.js';
import { versionStatusStatements } from '../internal/catalogue-status-statements.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { seeder, type CaseContext } from '../testing/mutation-table/harness.js';
import {
  ANCHORS,
  A_JOB,
  FUTURE,
  OWNER,
  fenceOf,
  seedBindings,
  seedPackage,
  seedProject,
  seedSource,
  seedSubject,
  seedVersion,
} from '../testing/mutation-table/fixtures.js';
import { actorHolds } from './actor-authority.js';
import { createCatalogueEpochReader } from './catalogue-epoch.js';
import { createVersionReader as createCatalogueReader } from './catalogue-read.js';
import { quarantineStatements } from './catalogue-status.js';
import { createCatalogueWriteGuard } from './catalogue-write-package.js';
import { createVisibilityAttachRepository } from './visibility-attach.js';
import { createVisibilitySubsetRepository } from './visibility-subset.js';

let database: MigratedDatabase;
let context: CaseContext;
let org: OrgContext;
let other: OrgContext;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations missing');
  org = database.orgs.a;
  other = database.orgs.b;
  context = {
    executor: database.executor,
    orgs: database.orgs,
    mutate: (statement) => statement,
    mutateBatch: (statements) => statements,
  };
  const seed = seeder(database.executor);
  await seedProject(seed, 'P', org.orgId);
  await seedSource(seed, 'S', org.orgId, 'vcs');
  await seedPackage(seed, 'K', org.orgId, 'S', 'acme/widget');
  await seedVersion(seed, 'V', org.orgId, 'K', '1.0.0');
  await seed(
    'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
    org.orgId,
    'P',
    'S',
  );
  await seed(
    "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'subscription')",
    org.orgId,
    'P',
    'K',
  );
});

afterEach(async () => {
  await database.close();
});

function resolve() {
  return createCatalogueReader(database.executor).resolveVersions(org, {
    projectId: 'P',
    ecosystem: 'composer',
    key: 'acme/widget',
    limit: 10,
  });
}

const origin = { status: 200, authenticated: true, authorized: true };

function rawCache() {
  return {
    get: vi.fn<Cache['get']>().mockResolvedValue(null),
    set: vi.fn<Cache['set']>().mockResolvedValue(undefined),
    delete: vi.fn<Cache['delete']>().mockResolvedValue(undefined),
  };
}

async function narrowingWrite(kind: string) {
  const seed = seeder(database.executor);
  if (kind === 'job quarantine') {
    await seed(
      `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
      VALUES (?, ?, 'catalogue:sync:v1', 'test', 'running', ?, ?, 3)`,
      A_JOB,
      org.orgId,
      OWNER,
      FUTURE,
    );
    const guard = createCatalogueWriteGuard(org, { id: A_JOB, owner: OWNER, fence: 3 });
    const plan = quarantineStatements(org, guard, { versionId: 'V', reason: 'digest_mismatch' });
    expect(plan.result(await database.executor.batch(plan.statements)).changed).toBe(true);
    return;
  }
  await seedBindings(context);
  const subject = await seedSubject(
    context,
    'admin',
    kind === 'flag 1->0' ? {} : { projectId: 'P' },
  );
  const fence = fenceOf(subject);
  const permission =
    kind === 'flag 1->0'
      ? 'org:sources:write'
      : kind === 'detach'
        ? 'project:sources:write'
        : 'project:packages:manage';
  await seed(
    'UPDATE role_permission SET permission = ? WHERE org_id = ? AND role_id = ?',
    permission,
    org.orgId,
    'R-admin',
  );
  if (kind === 'detach' || kind === 'flag 1->0') {
    const repo = createVisibilityAttachRepository(database.executor, { providerAnchors: ANCHORS });
    expect(
      kind === 'detach'
        ? await repo.detachSource(org, fence, {
            audit: visibilityAudit(),
            projectId: 'P',
            sourceId: 'S',
          })
        : await repo.setPackageFlag(org, fence, { packageId: 'K', visibleToNewProjects: false }),
    ).toMatchObject({ ok: true });
  } else if (kind === 'exclude') {
    expect(
      await createVisibilitySubsetRepository(database.executor).addPattern(org, fence, {
        audit: visibilityAudit(),
        projectId: 'P',
        sourceId: 'S',
        pattern: 'acme/*',
        effect: 'exclude',
        providerAnchors: ANCHORS,
      }),
    ).toBe('added');
  } else {
    // Admin status plans rely on the enclosing organization fence to bump the epoch.
    const plan = versionStatusStatements(org, {
      versionId: 'V',
      to: kind === 'tombstone' ? 'tombstoned' : 'quarantined',
      reason: kind === 'tombstone' ? 'admin_tombstone' : 'admin_quarantine',
    });
    const outcome = await runOrgFenced(
      database.executor,
      org,
      fence,
      assertGuard(
        actorHolds(org, fence, {
          permission,
          projectId: 'P',
          providerAnchors: ANCHORS,
        }),
        org,
      ),
      plan.statements,
      {},
    );
    expect(outcome.ok).toBe(true);
  }
}

describe('catalogue fills validate the live database epoch', () => {
  it.each([
    'none',
    'detach',
    'exclude',
    'flag 1->0',
    'job quarantine',
    'admin quarantine',
    'tombstone',
  ])('resolve, %s, set', async (write) => {
    const resolved = await resolve();
    if (resolved === null || 'changed' in resolved) throw new Error('package missing');
    expect(resolved.versions).toHaveLength(1);
    const { pkg } = resolved;
    const live = createCatalogueEpochReader(database.executor, pkg.packageId);
    const raw = rawCache();
    const cache = createCatalogueCache(raw, pkg, live, { deploymentId: 'test' });
    const key = catalogueCacheKey(pkg, 'composer-p2');
    if (write !== 'none') await narrowingWrite(write);
    if (write === 'none') expect(await live.read(org)).toBe(pkg.cacheEpoch);
    else expect(await live.read(org)).not.toBe(pkg.cacheEpoch);
    expect(await cache.get(org, key)).toEqual({ hit: null, version: pkg.cacheEpoch });
    expect(
      await cache.set(
        org,
        key,
        defaultEntry('metadata', new TextEncoder().encode('{}'), new Date()),
        {
          expectedVersion: pkg.cacheEpoch!,
          origin,
        },
      ),
    ).toBe(write === 'none' ? 'stored' : 'discarded');
    expect(raw.set).toHaveBeenCalledTimes(write === 'none' ? 1 : 0);
  });

  it('returns null for a missing package or a package of another organization', async () => {
    expect(await createCatalogueEpochReader(database.executor, 'missing').read(org)).toBeNull();
    expect(await createCatalogueEpochReader(database.executor, 'K').read(other)).toBeNull();
  });

  it.each(['missing', 'invalid', 'error'] as const)(
    'bypasses fills when the live epoch is %s',
    async (failure) => {
      const resolved = await resolve();
      if (resolved === null || 'changed' in resolved) throw new Error('package missing');
      const seed = seeder(database.executor);
      if (failure === 'missing') await seed('DELETE FROM cache_epoch WHERE org_id = ?', org.orgId);
      if (failure === 'invalid')
        await seed("UPDATE cache_epoch SET version = 'invalid' WHERE org_id = ?", org.orgId);
      const live: EpochReader =
        failure === 'error'
          ? { read: () => Promise.reject(new Error('database unavailable')) }
          : createCatalogueEpochReader(database.executor, 'K');
      const raw = rawCache();
      const cache = createCatalogueCache(raw, resolved.pkg, live, { deploymentId: 'test' });
      expect(
        await cache.set(
          org,
          catalogueCacheKey(resolved.pkg, 'composer-p2'),
          defaultEntry('metadata', new TextEncoder().encode('{}'), new Date()),
          {
            expectedVersion: resolved.pkg.cacheEpoch!,
            origin,
          },
        ),
      ).toBe('bypassed');
      expect(raw.set).not.toHaveBeenCalled();
    },
  );
});
