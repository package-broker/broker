import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createPackageDetailRepository } from '../repositories/package-detail.js';
import { createPackageAdminReader } from '../repositories/package-admin-read.js';
import { createVisibilityAttachRepository } from '../repositories/visibility-attach.js';
import { accessFixture } from './package-access-requests-fixture.js';
import { createCatalogueWriter } from '../repositories/catalogue-writer.js';
import { createCatalogueWriteGuard } from '../repositories/catalogue-write-package.js';
import { seedSource, seedPackage } from '../testing/mutation-table/fixtures.js';
import { ANCHORS } from '../testing/mutation-table/fixtures.js';

export function describePackageDetail(
  name: string,
  open: () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>,
) {
  describe(`package detail: ${name}`, () => {
    let database: Awaited<ReturnType<typeof open>>;
    let f: Awaited<ReturnType<typeof accessFixture>>;
    let repo: ReturnType<typeof createPackageDetailRepository>;
    beforeEach(async () => {
      database = await open();
      f = await accessFixture(database.executor);
      repo = createPackageDetailRepository(database.executor, ANCHORS);
      await f.seed(
        "UPDATE source SET project_id = 'PROJECT' WHERE org_id = ? AND id = 'SOURCE'",
        f.org.orgId,
      );
      await f.seed(
        "UPDATE role_permission SET permission = 'project:sources:write' WHERE role_id = 'R-requester'",
      );
    });
    afterEach(async () => {
      await database.close();
    });
    const detail = (projectId: string | null = 'PROJECT') =>
      repo.detail(f.org, { packageId: 'PACKAGE', projectId });
    const write = (revision = 1) =>
      repo.setAccess(f.org, f.requestFence, {
        packageId: 'PACKAGE',
        revision,
        visibleToNewProjects: false,
        newProjectAccessMode: 'none',
        audit: { ...f.event('package.access_request'), action: 'package.access_update' },
      });
    it('reads owned packages without visibility, with settings initialized independently of catalogue revision', async () => {
      await f.seed('UPDATE package SET rev = 42 WHERE org_id = ?', f.org.orgId);
      expect(await detail()).toMatchObject({
        id: 'PACKAGE',
        revision: 1,
        visibleToNewProjects: false,
        newProjectAccessMode: 'request',
      });
      expect(await detail(null)).toMatchObject({ revision: 1 });
      expect(await repo.detail(f.orgs.b, { packageId: 'PACKAGE', projectId: null })).toBeNull();
      expect(await repo.detail(f.org, { packageId: 'missing', projectId: null })).toBeNull();
      expect(await detail('missing')).toBeNull();
    });
    it('reads Composer package settings through the same scoped detail contract', async () => {
      await seedSource(f.seed, 'COMPOSER_SOURCE', f.org.orgId, 'hosted', 'composer');
      await f.seed(
        "UPDATE source SET project_id = 'PROJECT' WHERE org_id = ? AND id = 'COMPOSER_SOURCE'",
        f.org.orgId,
      );
      await seedPackage(
        f.seed,
        'COMPOSER_PACKAGE',
        f.org.orgId,
        'COMPOSER_SOURCE',
        'vendor/widget',
        'composer',
      );
      expect(
        await repo.detail(f.org, { packageId: 'COMPOSER_PACKAGE', projectId: 'PROJECT' }),
      ).toMatchObject({ ecosystem: 'composer', name: 'vendor/widget', revision: 1 });
    });
    it('excludes held packages and archived owners', async () => {
      await f.seed('UPDATE package SET held_until_active = 1 WHERE org_id = ?', f.org.orgId);
      expect(await detail()).toBeNull();
      expect(await detail(null)).toBeNull();
      await f.seed('UPDATE package SET held_until_active = 0 WHERE org_id = ?', f.org.orgId);
      await f.seed(
        "UPDATE project SET status = 'archived' WHERE org_id = ? AND id = 'PROJECT'",
        f.org.orgId,
      );
      expect(await detail()).toBeNull();
    });
    it('reads only the visible winner from a shared source, independently of owner access', async () => {
      await f.seed('UPDATE source SET project_id = NULL WHERE org_id = ?', f.org.orgId);
      expect(await detail()).toBeNull();
      await f.seed(
        "INSERT INTO project_package (org_id, project_id, package_id, ecosystem, name, origin) VALUES (?, 'PROJECT', 'PACKAGE', 'npm', 'widget', 'explicit')",
        f.org.orgId,
      );
      expect(await detail()).toMatchObject({ id: 'PACKAGE', revision: 1 });
      await seedSource(f.seed, 'S2', f.org.orgId, 'hosted', 'npm');
      await seedPackage(f.seed, 'K2', f.org.orgId, 'S2', 'widget', 'npm');
      await f.seed(
        "UPDATE project_source SET precedence = 1 WHERE org_id = ? AND source_id = 'SOURCE'",
        f.org.orgId,
      );
      await f.seed(
        "INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, 'PROJECT', 'S2', 0)",
        f.org.orgId,
      );
      await f.seed(
        "INSERT INTO project_package (org_id, project_id, package_id, ecosystem, name, origin) VALUES (?, 'PROJECT', 'K2', 'npm', 'widget', 'explicit')",
        f.org.orgId,
      );
      expect(await detail()).toBeNull();
      expect(await repo.detail(f.org, { packageId: 'K2', projectId: 'PROJECT' })).toMatchObject({
        id: 'K2',
      });
      await f.seed('DELETE FROM project_source WHERE org_id = ?', f.org.orgId);
      expect(await detail()).toBeNull();
    });
    it('allows catalogue churn, rejects stale settings and advances only settings revision', async () => {
      await f.seed(
        "INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence) VALUES ('SYNC', ?, 'sync', 'sync', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
        f.org.orgId,
      );
      const guard = createCatalogueWriteGuard(f.org, { id: 'SYNC', owner: 'worker', fence: 1 });
      await createCatalogueWriter(database.executor).syncPackage(f.org, guard, {
        sourceId: 'SOURCE',
        ecosystem: 'npm',
        key: 'widget',
        description: 'Updated upstream',
        versions: [],
      });
      expect(await write()).toEqual({ ok: true });
      expect(await detail()).toMatchObject({ revision: 2, newProjectAccessMode: 'none' });
      expect(await write()).toEqual({ ok: false, error: 'conflict' });
      expect(
        await database.executor.all({
          sql: 'SELECT rev, settings_revision FROM package WHERE org_id = ?',
          params: [f.org.orgId],
        }),
      ).toEqual([{ rev: 2, settings_revision: 2 }]);
      expect(
        (await createPackageAdminReader(database.executor).listOrganization(f.org, { limit: 1 }))
          .items[0],
      ).toMatchObject({ revision: 2 });
    });
    it('refuses revoked owner authority without changing settings', async () => {
      await f.seed("DELETE FROM role_permission WHERE role_id = 'R-requester'");
      expect(await write()).toEqual({ ok: false, error: 'forbidden' });
      expect(await detail()).toMatchObject({ revision: 1 });
    });
    it('rolls back the settings revision when a later audit insert fails', async () => {
      await f.seed(
        "CREATE TRIGGER reject_settings_audit BEFORE INSERT ON audit_pending BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
      );
      expect(await write()).toEqual({ ok: false, error: 'unavailable' });
      expect(await detail()).toMatchObject({ revision: 1, newProjectAccessMode: 'request' });
    });
    it('requires a positive revision in the persisted schema', async () => {
      await expect(
        f.seed('UPDATE package SET settings_revision = 0 WHERE org_id = ?', f.org.orgId),
      ).rejects.toThrow();
      expect(await detail()).toMatchObject({ revision: 1 });
    });
    it('legacy flag writes invalidate settings editors atomically', async () => {
      const legacy = createVisibilityAttachRepository(database.executor, {
        providerAnchors: ANCHORS,
      });
      expect(
        await legacy.setPackageFlag(f.org, f.requestFence, {
          packageId: 'PACKAGE',
          visibleToNewProjects: true,
        }),
      ).toMatchObject({ ok: true });
      expect(await detail()).toMatchObject({ revision: 2, visibleToNewProjects: true });
      expect(await write()).toEqual({ ok: false, error: 'conflict' });
    });
  });
}
