import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLES,
  missingCatalogue,
  type DefaultRoleKey,
} from '@package-broker/core/authz/permissions';
import { orgContext, type OrgContext } from '@package-broker/core/db/port';
import { ROLE_KEY_PATTERN, type Role } from '@package-broker/core/db/roles';
import { countCalls } from '../contract/count-calls.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { bootstrapAdmin } from './admin-bootstrap.js';
import { createRoleRepository, seedDefaultsStatements } from './role.js';

const NOW = '2026-10-15T12:00:00.000Z';
const LATER = '2026-10-16T08:00:00.000Z';
const NEW_ORG = '01J0NEWORG0000000000000000';

function idsWith(prefix: string): Record<DefaultRoleKey, string> {
  return {
    organization_admin: `${prefix}ADMIN0000000000000000`.slice(0, 26),
    organization_auditor: `${prefix}ORGAUD000000000000000`.slice(0, 26),
    project_owner: `${prefix}OWNER00000000000000000`.slice(0, 26),
    project_developer: `${prefix}DEV0000000000000000000`.slice(0, 26),
    project_auditor: `${prefix}PRJAUD000000000000000`.slice(0, 26),
  };
}

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  const orgs = database.orgs;
  if (orgs === null) throw new Error('two organizations expected');
  a = orgs.a;
  b = orgs.b;
});

afterEach(async () => {
  await database.close();
});

async function seed(ctx: OrgContext, prefix: string, now = NOW): Promise<void> {
  await database.executor.batch(seedDefaultsStatements(ctx, { now, ids: idsWith(prefix) }));
}

async function byKey(ctx: OrgContext, key: string): Promise<Role> {
  const roles = await createRoleRepository(database.executor).list(ctx);
  const found = roles.find((role) => role.key === key);
  if (found === undefined) throw new Error(`role ${key} missing`);
  return found;
}

async function permissionRows(roleId: string): Promise<string[]> {
  const rows = await database.executor.all<{ permission: string }>({
    sql: 'SELECT permission FROM role_permission WHERE role_id = ? ORDER BY permission',
    params: [roleId],
  });
  return rows.map((row) => row.permission);
}

async function count(table: 'role' | 'role_permission'): Promise<number> {
  const rows = await database.executor.all<{ n: number }>({
    sql: `SELECT count(*) AS n FROM ${table}`,
    params: [],
  });
  return rows[0]?.n ?? -1;
}

const CUSTOM = {
  id: '01J0CUSTOM00000000000000AA',
  key: 'release_manager',
  name: 'Release Manager',
  scope: 'project' as const,
  permissions: ['project:read', 'project:packages:read'],
  now: NOW,
};

describe('seedDefaultsStatements', () => {
  it('1: seeds five roles whose stored permissions equal DEFAULT_ROLES', async () => {
    await seed(a, 'S1');
    const roles = await createRoleRepository(database.executor).list(a);
    expect(roles).toHaveLength(5);
    for (const expected of DEFAULT_ROLES) {
      const stored = roles.find((role) => role.key === expected.key);
      expect(stored).toMatchObject({
        name: expected.name,
        scope: expected.scope,
        isSystem: true,
        protectsLastHolder: expected.protectsLastHolder,
      });
      expect([...(stored?.permissions ?? [])].sort()).toEqual([...expected.permissions].sort());
    }
  });

  it('1: seeding again with the same now and new ids adds nothing', async () => {
    await seed(a, 'S1');
    const before = [await count('role'), await count('role_permission')];
    await seed(a, 'S2');
    expect([await count('role'), await count('role_permission')]).toEqual(before);
    const admin = await byKey(a, 'organization_admin');
    expect(admin.id).toBe(idsWith('S1').organization_admin);
  });

  it('1: re-seeding leaves an edited project_auditor set alone', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    const auditor = await byKey(a, 'project_auditor');
    expect(await repository.setPermissions(a, auditor.id, ['project:read'], LATER)).toBe('updated');
    await seed(a, 'S2', LATER);
    expect((await byKey(a, 'project_auditor')).permissions).toEqual(['project:read']);
  });

  it('1: re-seeding does not restore a permission removed from a role', async () => {
    await seed(a, 'S1');
    const owner = await byKey(a, 'project_owner');
    await database.executor.all({
      sql: 'DELETE FROM role_permission WHERE role_id = ? AND permission = ?',
      params: [owner.id, 'project:tokens:revoke'],
    });
    await seed(a, 'S2');
    expect((await byKey(a, 'project_owner')).permissions).not.toContain('project:tokens:revoke');
  });

  it('1: produces only scalar parameters and stamps timestamps from now', async () => {
    const statements = seedDefaultsStatements(a, { now: NOW, ids: idsWith('S1') });
    expect(statements).toHaveLength(10);
    for (const statement of statements) {
      for (const param of statement.params) {
        expect(['string', 'number']).toContain(typeof param);
      }
    }
    await database.executor.batch(statements);
    const rows = await database.executor.all<{ created_at: string; updated_at: string }>({
      sql: 'SELECT created_at, updated_at FROM role',
      params: [],
    });
    expect(rows.every((row) => row.created_at === NOW && row.updated_at === NOW)).toBe(true);
  });
});

const ADMIN_PERMISSIONS_AT_0001 = [
  'org:read',
  'org:settings:write',
  'org:users:read',
  'org:users:write',
  'org:roles:read',
  'org:roles:write',
  'org:grants:read',
  'org:grants:write',
  'org:projects:create',
  'org:sources:read',
  'org:sources:write',
  'org:tokens:read',
  'org:tokens:revoke',
  'org:service-principals:write',
  'org:audit:read',
  'project:read',
  'project:settings:write',
  'project:grants:read',
  'project:grants:write',
  'project:packages:read',
  'project:packages:write',
  'project:packages:manage',
  'project:sources:read',
  'project:sources:write',
  'project:tokens:create',
  'project:tokens:read',
  'project:tokens:revoke',
  'project:audit:read',
] as const;

const migrationsUrl = new URL('../../migrations/', import.meta.url);

async function coreSources(): Promise<MigrationSource[]> {
  const names = readdirSync(migrationsUrl)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return Promise.all(
    names.map((name) =>
      loadMigrationSource('core', name, readFileSync(new URL(name, migrationsUrl), 'utf8')),
    ),
  );
}

describe('admin completeness', () => {
  it('2: an organization seeded as of migration 0001 has every catalogue permission on organization_admin after all migrations and the bootstrap top-up', async () => {
    const opened = openNodeSqliteExecutor();
    try {
      const [init, ...later] = await coreSources();
      if (init === undefined) throw new Error('migration 0001 missing');
      await migrate(opened.executor, [init], { holder: 't155' });
      const orgId = '01J0UPGRADE0000000000000AA';
      const adminId = '01J0UPGRADEADMIN00000000AA';
      const ownerId = '01J0UPGRADEOWNER00000000AA';
      await opened.executor.batch([
        {
          sql: 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)',
          params: [orgId, 'upgrade', 'Upgrade'],
        },
        {
          sql: `INSERT INTO role (id, org_id, key, name, scope, is_system, protects_last_holder)
                VALUES (?, ?, 'organization_admin', 'Organization Admin', 'organization', 1, 1)`,
          params: [adminId, orgId],
        },
        {
          sql: `INSERT INTO role (id, org_id, key, name, scope, is_system, protects_last_holder)
                VALUES (?, ?, 'project_owner', 'Project Owner', 'project', 1, 0)`,
          params: [ownerId, orgId],
        },
        {
          sql: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          params: [orgId, ownerId, 'project:read'],
        },
        ...ADMIN_PERMISSIONS_AT_0001.map((permission) => ({
          sql: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          params: [orgId, adminId, permission],
        })),
      ]);
      await migrate(opened.executor, [init, ...later], { holder: 't155' });

      const ctx = orgContext(orgId);
      const adminPermissions = async () => {
        const roles = await createRoleRepository(opened.executor).list(ctx);
        return roles.find((role) => role.key === 'organization_admin')?.permissions ?? [];
      };
      expect(missingCatalogue(await adminPermissions()).length).toBeGreaterThan(0);

      const bootstrap = (prefix: string, tag: string) =>
        bootstrapAdmin(opened.executor, ctx, {
          email: 'admin@example.test',
          userId: `01J0UPGRADEUSER${tag}`,
          setupHash: 'a1'.repeat(32),
          setupExpiresAt: '2026-10-16T12:00:00.000Z',
          grantId: `01J0UPGRADEGRANT${tag}`,
          roleIds: idsWith(prefix),
          opId: `01J0UPGRADEOP${tag}`,
          now: NOW,
        });
      await bootstrap('01J0FRA', 'AA');
      const topped = await adminPermissions();
      expect(missingCatalogue(topped)).toEqual([]);

      await bootstrap('01J0FRB', 'AA');
      expect([...(await adminPermissions())].sort()).toEqual([...topped].sort());

      const roles = await createRoleRepository(opened.executor).list(ctx);
      expect(roles.find((role) => role.id === ownerId)?.permissions).toEqual(['project:read']);
    } finally {
      await opened.close();
    }
  });

  it('2: a database seeded from DEFAULT_ROLES has no catalogue permission missing on organization_admin', async () => {
    await seed(a, 'S1');
    const admin = await byKey(a, 'organization_admin');
    expect(missingCatalogue(admin.permissions)).toEqual([]);
  });

  it('2: the check reports a permission missing from the stored admin set', async () => {
    await seed(a, 'S1');
    const admin = await byKey(a, 'organization_admin');
    await database.executor.all({
      sql: 'DELETE FROM role_permission WHERE role_id = ? AND permission = ?',
      params: [admin.id, 'org:audit:read'],
    });
    const stored = await byKey(a, 'organization_admin');
    expect(missingCatalogue(stored.permissions)).toEqual(['org:audit:read']);
  });
});

describe('list and get', () => {
  it('5: list is one executor call and get returns one role or null', async () => {
    await seed(a, 'S1');
    const counted = countCalls(database.executor);
    const repository = createRoleRepository(counted.executor);
    const roles = await repository.list(a);
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    expect(roles).toHaveLength(5);

    const admin = roles.find((role) => role.key === 'organization_admin');
    expect(await repository.get(a, admin?.id ?? '')).toEqual(admin);
    expect(counted.counts()).toEqual({ all: 2, batch: 0 });
    expect(await repository.get(a, '01J0UNKNOWN0000000000000000')).toBeNull();
  });

  it('5: a role without permissions is listed with an empty set', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, { ...CUSTOM, permissions: [] });
    expect((await repository.get(a, CUSTOM.id))?.permissions).toEqual([]);
  });

  it('5: a role of another organization is invisible and untouchable', async () => {
    await seed(a, 'S1');
    await seed(b, 'S2');
    const repository = createRoleRepository(database.executor);
    const mine = await repository.list(a);
    const theirs = await repository.list(b);
    expect(mine.map((role) => role.id).sort()).toEqual(Object.values(idsWith('S1')).sort());
    expect(theirs.map((role) => role.id).sort()).toEqual(Object.values(idsWith('S2')).sort());

    const foreign = idsWith('S2').project_auditor;
    expect(await repository.get(a, foreign)).toBeNull();
    expect(await repository.rename(a, foreign, 'Hijacked', LATER)).toBe('not_found');
    expect(await repository.setPermissions(a, foreign, ['project:read'], LATER)).toBe('not_found');
    expect(await repository.delete(a, foreign)).toBe('not_found');
    const intact = await repository.get(b, foreign);
    const expected = DEFAULT_ROLES.find((role) => role.key === 'project_auditor');
    expect(intact?.name).toBe('Project Auditor');
    expect([...(intact?.permissions ?? [])].sort()).toEqual(
      [...(expected?.permissions ?? [])].sort(),
    );
  });

  it('5: the same custom key can exist in two organizations', async () => {
    const repository = createRoleRepository(database.executor);
    expect(await repository.create(a, CUSTOM)).toBe('created');
    expect(await repository.create(b, { ...CUSTOM, id: '01J0CUSTOM00000000000000BB' })).toBe(
      'created',
    );
  });
});

describe('create', () => {
  it('4: stores a custom role that never protects the last holder and is not a system role', async () => {
    const repository = createRoleRepository(database.executor);
    expect(await repository.create(a, CUSTOM)).toBe('created');
    const stored = await repository.get(a, CUSTOM.id);
    expect(stored).toEqual({
      id: CUSTOM.id,
      key: CUSTOM.key,
      name: CUSTOM.name,
      scope: 'project',
      isSystem: false,
      protectsLastHolder: false,
      permissions: ['project:packages:read', 'project:read'],
    });
  });

  it('4: an existing key answers duplicate_key and stores nothing', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    const before = [await count('role'), await count('role_permission')];
    expect(
      await repository.create(a, {
        ...CUSTOM,
        id: '01J0CUSTOM00000000000000DD',
        key: 'organization_admin',
        scope: 'organization',
        permissions: ['org:read'],
      }),
    ).toBe('duplicate_key');
    expect([await count('role'), await count('role_permission')]).toEqual(before);
    expect(missingCatalogue((await byKey(a, 'organization_admin')).permissions)).toEqual([]);
  });

  it('4: a second custom role with the same key answers duplicate_key', async () => {
    const repository = createRoleRepository(database.executor);
    expect(await repository.create(a, CUSTOM)).toBe('created');
    expect(await repository.create(a, { ...CUSTOM, id: '01J0CUSTOM00000000000000CC' })).toBe(
      'duplicate_key',
    );
    expect(await repository.get(a, '01J0CUSTOM00000000000000CC')).toBeNull();
  });

  it('4: duplicate permissions in the input are stored once', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, { ...CUSTOM, permissions: ['project:read', 'project:read'] });
    expect((await repository.get(a, CUSTOM.id))?.permissions).toEqual(['project:read']);
  });

  it('4: rejects a key outside ROLE_KEY_PATTERN before any SQL', async () => {
    const counted = countCalls(database.executor);
    const repository = createRoleRepository(counted.executor);
    for (const key of ['', 'Admin', '1abc', 'a-b', 'a b', 'a'.repeat(65)]) {
      expect(ROLE_KEY_PATTERN.test(key)).toBe(false);
      await expect(repository.create(a, { ...CUSTOM, key })).rejects.toBeInstanceOf(TypeError);
    }
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('4: a role in an organization that does not exist is refused by the foreign key', async () => {
    const repository = createRoleRepository(database.executor);
    await expect(repository.create(orgContext(NEW_ORG), CUSTOM)).rejects.toMatchObject({
      name: 'DbError',
      kind: 'foreign_key',
    });
  });
});

describe('rename', () => {
  it('renames a system and a custom role and stamps updated_at', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    const auditor = await byKey(a, 'project_auditor');
    expect(await repository.rename(a, auditor.id, 'Reader', LATER)).toBe('renamed');
    expect(await repository.rename(a, CUSTOM.id, 'Releaser', LATER)).toBe('renamed');
    expect((await repository.get(a, auditor.id))?.name).toBe('Reader');
    const rows = await database.executor.all<{ updated_at: string }>({
      sql: 'SELECT updated_at FROM role WHERE id = ?',
      params: [auditor.id],
    });
    expect(rows[0]?.updated_at).toBe(LATER);
  });

  it('returns not_found for an unknown role', async () => {
    const repository = createRoleRepository(database.executor);
    expect(await repository.rename(a, '01J0UNKNOWN0000000000000000', 'x', LATER)).toBe('not_found');
  });
});

describe('setPermissions', () => {
  it('replaces the whole set of a custom role and stamps updated_at', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    expect(
      await repository.setPermissions(a, CUSTOM.id, ['project:audit:read', 'project:read'], LATER),
    ).toBe('updated');
    expect((await repository.get(a, CUSTOM.id))?.permissions).toEqual([
      'project:audit:read',
      'project:read',
    ]);
    const rows = await database.executor.all<{ updated_at: string }>({
      sql: 'SELECT updated_at FROM role WHERE id = ?',
      params: [CUSTOM.id],
    });
    expect(rows[0]?.updated_at).toBe(LATER);
  });

  it('can empty a role, and duplicates in the input are stored once', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    expect(
      await repository.setPermissions(a, CUSTOM.id, ['project:read', 'project:read'], LATER),
    ).toBe('updated');
    expect((await repository.get(a, CUSTOM.id))?.permissions).toEqual(['project:read']);
    expect(await repository.setPermissions(a, CUSTOM.id, [], LATER)).toBe('updated');
    expect((await repository.get(a, CUSTOM.id))?.permissions).toEqual([]);
  });

  it('3: organization_admin is locked and its rows stay unchanged', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    const admin = await byKey(a, 'organization_admin');
    const before = await permissionRows(admin.id);
    const updated = await database.executor.all<{ updated_at: string }>({
      sql: 'SELECT updated_at FROM role WHERE id = ?',
      params: [admin.id],
    });

    expect(await repository.setPermissions(a, admin.id, ['org:read'], LATER)).toBe('locked');
    expect(await repository.setPermissions(a, admin.id, [], LATER)).toBe('locked');
    expect(await permissionRows(admin.id)).toEqual(before);
    const after = await database.executor.all<{ updated_at: string }>({
      sql: 'SELECT updated_at FROM role WHERE id = ?',
      params: [admin.id],
    });
    expect(after).toEqual(updated);
  });

  it('answers not_found for an unknown role and changes nothing', async () => {
    await seed(a, 'S1');
    const before = await count('role_permission');
    const repository = createRoleRepository(database.executor);
    expect(
      await repository.setPermissions(a, '01J0UNKNOWN0000000000000000', ['org:read'], LATER),
    ).toBe('not_found');
    expect(await count('role_permission')).toBe(before);
  });

  it('is one batch and no other call', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    const counted = countCalls(database.executor);
    await createRoleRepository(counted.executor).setPermissions(
      a,
      CUSTOM.id,
      ['project:read'],
      LATER,
    );
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
  });

  it('other system roles are re-permissionable', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    const developer = await byKey(a, 'project_developer');
    expect(await repository.setPermissions(a, developer.id, ['project:read'], LATER)).toBe(
      'updated',
    );
    expect((await repository.get(a, developer.id))?.permissions).toEqual(['project:read']);
  });
});

describe('delete', () => {
  it('4: a system role answers system and stays with its permissions', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    const admin = await byKey(a, 'organization_admin');
    const auditor = await byKey(a, 'project_auditor');
    expect(await repository.delete(a, admin.id)).toBe('system');
    expect(await repository.delete(a, auditor.id)).toBe('system');
    expect(await count('role')).toBe(5);
    expect(missingCatalogue((await byKey(a, 'organization_admin')).permissions)).toEqual([]);
  });

  it('4: a custom role used by a grant answers in_use and keeps its permissions', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, { ...CUSTOM, scope: 'organization', permissions: ['org:read'] });
    await database.executor.all({
      sql: `INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id)
            VALUES (?, ?, 'email', ?, 'organization', ?)`,
      params: ['01J0GRANT00000000000000000', a.orgId, 'person@example.test', CUSTOM.id],
    });
    expect(await repository.delete(a, CUSTOM.id)).toBe('in_use');
    expect((await repository.get(a, CUSTOM.id))?.permissions).toEqual(['org:read']);
  });

  it('4: an unused custom role is deleted and its permissions cascade', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    expect(await permissionRows(CUSTOM.id)).toHaveLength(2);
    expect(await repository.delete(a, CUSTOM.id)).toBe('deleted');
    expect(await repository.get(a, CUSTOM.id)).toBeNull();
    expect(await permissionRows(CUSTOM.id)).toEqual([]);
    expect(await count('role_permission')).toBe(0);
  });

  it('4: an unknown role answers not_found', async () => {
    const repository = createRoleRepository(database.executor);
    expect(await repository.delete(a, '01J0UNKNOWN0000000000000000')).toBe('not_found');
  });

  it('4: a successful delete is one call, a refusal at most two', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    const counted = countCalls(database.executor);
    const counting = createRoleRepository(counted.executor);
    expect(await counting.delete(a, CUSTOM.id)).toBe('deleted');
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    const admin = await byKey(a, 'organization_admin');
    expect(await counting.delete(a, admin.id)).toBe('system');
    expect(counted.counts()).toEqual({ all: 3, batch: 0 });
  });
});

async function snapshot(): Promise<string> {
  const roles = await database.executor.all({ sql: 'SELECT * FROM role ORDER BY id', params: [] });
  const permissions = await database.executor.all({
    sql: 'SELECT * FROM role_permission ORDER BY role_id, permission',
    params: [],
  });
  return JSON.stringify({ roles, permissions });
}

describe('create never touches an existing role', () => {
  it('2: an existing system role id and key answers duplicate_key and leaves every row unchanged', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    const before = await snapshot();
    for (const role of DEFAULT_ROLES) {
      const existing = await byKey(a, role.key);
      expect(
        await repository.create(a, {
          id: existing.id,
          key: role.key,
          name: role.name,
          scope: role.scope,
          permissions: ['project:read'],
          now: NOW,
        }),
      ).toBe('duplicate_key');
    }
    expect(await snapshot()).toBe(before);
  });

  it('2: the same id and key of a custom role with no permissions and another name gains nothing', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, { ...CUSTOM, permissions: [] });
    const before = await snapshot();
    expect(
      await repository.create(a, { ...CUSTOM, name: 'Other name', permissions: ['project:read'] }),
    ).toBe('duplicate_key');
    expect(await snapshot()).toBe(before);
  });

  it('2: replaying identical input against an empty custom role fills in the requested permissions', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, { ...CUSTOM, permissions: [] });
    expect(await repository.create(a, CUSTOM)).toBe('duplicate_key');
    expect((await repository.get(a, CUSTOM.id))?.permissions).toEqual([
      'project:packages:read',
      'project:read',
    ]);
    expect(await repository.create(a, { ...CUSTOM, permissions: ['project:audit:read'] })).toBe(
      'duplicate_key',
    );
    expect((await repository.get(a, CUSTOM.id))?.permissions).toEqual([
      'project:packages:read',
      'project:read',
    ]);
  });

  it('2: the same id and key of a custom role that already has permissions gains nothing', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    const before = await snapshot();
    expect(await repository.create(a, { ...CUSTOM, permissions: ['project:audit:read'] })).toBe(
      'duplicate_key',
    );
    expect(await snapshot()).toBe(before);
  });

  it('2: an existing id with a different key is not an insert and changes nothing', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    const before = await snapshot();
    const admin = await byKey(a, 'organization_admin');
    expect(await repository.create(a, { ...CUSTOM, id: admin.id })).toBe('duplicate_key');
    expect(await snapshot()).toBe(before);
  });

  it('5: a key reserved for a default role answers duplicate_key without SQL', async () => {
    const counted = countCalls(database.executor);
    const repository = createRoleRepository(counted.executor);
    for (const role of DEFAULT_ROLES) {
      expect(await repository.create(a, { ...CUSTOM, key: role.key })).toBe('duplicate_key');
    }
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    expect(await count('role')).toBe(0);
  });
});

describe('invalid_permissions', () => {
  it('3: create refuses an unknown name and an org name on a project role, writing nothing', async () => {
    const repository = createRoleRepository(database.executor);
    for (const permissions of [
      ['project:read', 'project:nonsense'],
      ['org:read'],
      ['project:read', 'org:audit:read'],
      [''],
    ]) {
      expect(await repository.create(a, { ...CUSTOM, permissions })).toBe('invalid_permissions');
    }
    expect(await count('role')).toBe(0);
    expect(await count('role_permission')).toBe(0);
  });

  it('3: create accepts an org name on an organization role', async () => {
    const repository = createRoleRepository(database.executor);
    expect(
      await repository.create(a, {
        ...CUSTOM,
        scope: 'organization',
        permissions: ['org:read', 'project:read'],
      }),
    ).toBe('created');
  });

  it('3: setPermissions refuses an unknown name and leaves the role unchanged', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    const before = await snapshot();
    expect(await repository.setPermissions(a, CUSTOM.id, ['project:read', 'nope'], LATER)).toBe(
      'invalid_permissions',
    );
    expect(await snapshot()).toBe(before);
  });

  it('3: setPermissions refuses an org name on a project role in the same batch and writes nothing', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    const auditor = await byKey(a, 'project_auditor');
    const before = await snapshot();
    const counted = countCalls(database.executor);
    expect(
      await createRoleRepository(counted.executor).setPermissions(
        a,
        auditor.id,
        ['project:read', 'org:read'],
        LATER,
      ),
    ).toBe('invalid_permissions');
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
    expect(await snapshot()).toBe(before);
    expect(await repository.get(a, auditor.id)).toMatchObject({ name: 'Project Auditor' });
  });

  it('3: setPermissions accepts org and project names on an organization role', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, { ...CUSTOM, scope: 'organization', permissions: ['org:read'] });
    expect(
      await repository.setPermissions(a, CUSTOM.id, ['org:users:read', 'project:read'], LATER),
    ).toBe('updated');
    expect((await repository.get(a, CUSTOM.id))?.permissions).toEqual([
      'org:users:read',
      'project:read',
    ]);
  });

  it('3: the admin role stays locked even for an org-scope set', async () => {
    await seed(a, 'S1');
    const admin = await byKey(a, 'organization_admin');
    const repository = createRoleRepository(database.executor);
    expect(await repository.setPermissions(a, admin.id, ['org:read'], LATER)).toBe('locked');
  });
});

describe('rename guards', () => {
  it('5: organization_admin is not renamable and keeps its name and updated_at', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    const admin = await byKey(a, 'organization_admin');
    const before = await snapshot();
    expect(await repository.rename(a, admin.id, 'Boss', LATER)).toBe('locked');
    expect(await snapshot()).toBe(before);
  });

  it('5: an empty name, a name over 100 characters and control characters are rejected before SQL', async () => {
    const counted = countCalls(database.executor);
    const repository = createRoleRepository(counted.executor);
    for (const name of ['', 'x'.repeat(101), 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u0085b']) {
      await expect(repository.rename(a, CUSTOM.id, name, LATER)).rejects.toBeInstanceOf(TypeError);
      await expect(repository.create(a, { ...CUSTOM, name })).rejects.toBeInstanceOf(TypeError);
    }
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('5: format, line and paragraph separators and lone surrogates are rejected before SQL', async () => {
    const counted = countCalls(database.executor);
    const repository = createRoleRepository(counted.executor);
    const names = [
      'a\u200bb',
      'a\u202eb',
      'a\ufeffb',
      'a\u2028b',
      'a\u2029b',
      '\ud800',
      'a\udc00b',
    ];
    for (const name of names) {
      await expect(repository.rename(a, CUSTOM.id, name, LATER)).rejects.toBeInstanceOf(TypeError);
      await expect(repository.create(a, { ...CUSTOM, name })).rejects.toBeInstanceOf(TypeError);
    }
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('5: the length limit counts code points, not UTF-16 units', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    expect(await repository.rename(a, CUSTOM.id, '\u{1F600}'.repeat(100), LATER)).toBe('renamed');
    await expect(
      repository.rename(a, CUSTOM.id, '\u{1F600}'.repeat(101), LATER),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('5: rename is one batch and nothing else', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    const counted = countCalls(database.executor);
    expect(await createRoleRepository(counted.executor).rename(a, CUSTOM.id, 'Once', LATER)).toBe(
      'renamed',
    );
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
  });

  it('5: a name of exactly 100 characters is accepted', async () => {
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    expect(await repository.rename(a, CUSTOM.id, 'x'.repeat(100), LATER)).toBe('renamed');
  });
});

describe('concurrent seeding', () => {
  it('4: two connections seeding with different ids leave five roles and the DEFAULT_ROLES sets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pb-role-seed-'));
    const file = join(directory, 'store.sqlite');
    const shared = await openMigratedDatabase({ file, twoOrganizations: true });
    try {
      const orgs = shared.orgs;
      if (orgs === null) throw new Error('two organizations expected');
      const other = await shared.second();
      await Promise.all([
        shared.executor.batch(seedDefaultsStatements(orgs.a, { now: NOW, ids: idsWith('C1') })),
        other.batch(seedDefaultsStatements(orgs.a, { now: NOW, ids: idsWith('C2') })),
      ]);

      const roles = await createRoleRepository(shared.executor).list(orgs.a);
      expect(roles).toHaveLength(5);
      for (const expected of DEFAULT_ROLES) {
        const stored = roles.find((role) => role.key === expected.key);
        expect([...(stored?.permissions ?? [])].sort()).toEqual([...expected.permissions].sort());
      }
      const orphans = await shared.executor.all<{ n: number }>({
        sql: `SELECT count(*) AS n FROM role_permission
              WHERE role_id NOT IN (SELECT id FROM role)`,
        params: [],
      });
      expect(orphans[0]?.n).toBe(0);
      const total = await shared.executor.all<{ n: number }>({
        sql: 'SELECT count(*) AS n FROM role_permission',
        params: [],
      });
      expect(total[0]?.n).toBe(
        DEFAULT_ROLES.reduce((sum, role) => sum + role.permissions.length, 0),
      );
    } finally {
      await shared.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
