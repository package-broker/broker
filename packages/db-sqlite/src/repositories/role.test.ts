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
import {
  mutationFence,
  type AuthenticatedActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { ProtectedHolderProvider } from './access.js';
import { orgContext, type OrgContext, type ScalarSqlExecutor } from '@package-broker/core/db/port';
import { ROLE_KEY_PATTERN, type Role, type RoleRepository } from '@package-broker/core/db/roles';
import { countCalls } from '../contract/count-calls.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { bootstrapAdmin } from './admin-bootstrap.js';
import {
  createRoleRepository as createFencedRoleRepository,
  seedDefaultsStatements,
} from './role.js';

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

const ACTOR_ROLE_KEY = 'test_actor';
const NOT_ACTOR_ROLE = `key NOT LIKE 'test\\_actor%' ESCAPE '\\'`;
const ANCHOR = 'https://idp.example.test';
const OIDC: ProtectedHolderProvider = {
  provider: 'oidc',
  anchor: ANCHOR,
  emailAuthoritative: true,
  emailAuthoritativeDomains: ['example.test', 'actor.test'],
};
const OTHER: ProtectedHolderProvider = {
  provider: 'other',
  anchor: 'https://other.example.test',
  emailAuthoritative: false,
};
const PROVIDERS = [OIDC, OTHER];

interface TestActor {
  readonly userId: string;
  readonly sessionId: string;
}

function actorIds(ctx: OrgContext, name: string): { user: string; session: string; role: string } {
  const tag = `${name}${ctx.orgId.slice(-4)}`.toUpperCase().padEnd(10, '0');
  return { user: `01J0U${tag}`, session: `01J0S${tag}`, role: `01J0R${tag}` };
}

interface ActorOptions {
  readonly name?: string;
  readonly permissions?: readonly string[];
  readonly protects?: boolean;
  readonly session?: Partial<
    Record<'created_at' | 'expires_at' | 'last_seen_at' | 'revoked_at', string | null>
  >;
  readonly status?: string;
  readonly group?: {
    readonly name: string;
    readonly grantProvider: string;
    readonly memberProvider: string;
    readonly refreshedAt?: string;
    readonly identityValidatedAt?: string;
  };
  readonly projectGrant?: boolean;
}

async function actorFor(ctx: OrgContext, options: ActorOptions = {}): Promise<TestActor> {
  const name = options.name ?? 'ADMIN';
  const ids = actorIds(ctx, name);
  const permissions =
    options.permissions ??
    DEFAULT_ROLES.find((role) => role.key === 'organization_admin')?.permissions ??
    [];
  const created = new Date(Date.now() - 60_000).toISOString();
  const session = {
    created_at: created,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    last_seen_at: null,
    revoked_at: null,
    ...options.session,
  };
  const key = name === 'ADMIN' ? ACTOR_ROLE_KEY : `${ACTOR_ROLE_KEY}_${name.toLowerCase()}`;
  const email = `${name.toLowerCase()}@actor.test`;
  const exists = await database.executor.all({
    sql: 'SELECT 1 FROM user_account WHERE id = ?',
    params: [ids.user],
  });
  if (exists.length > 0) return { userId: ids.user, sessionId: ids.session };

  const projectId = `01J0P${ids.user.slice(5)}`;
  const group = options.group;
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const memberProvider = group?.memberProvider ?? 'oidc';
  await database.executor.batch([
    {
      sql: 'INSERT OR IGNORE INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      params: [ctx.orgId, 'oidc', ANCHOR],
    },
    {
      sql: 'INSERT OR IGNORE INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      params: [ctx.orgId, 'other', OTHER.anchor],
    },
    {
      sql: 'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      params: [ids.user, ctx.orgId, email, options.status ?? 'active'],
    },
    {
      sql: `INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      params: [
        `01J0I${ids.user.slice(5)}`,
        ctx.orgId,
        ids.user,
        memberProvider,
        `subject-${ids.user}`,
        email,
        group?.identityValidatedAt ?? hourAgo,
      ],
    },
    ...(options.projectGrant === true
      ? [
          {
            sql: 'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
            params: [projectId, ctx.orgId, name.toLowerCase(), name],
          },
        ]
      : []),
    {
      sql: `INSERT INTO role (id, org_id, key, name, scope, protects_last_holder)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        ids.role,
        ctx.orgId,
        key,
        key,
        options.projectGrant === true ? 'project' : 'organization',
        options.protects === false ? 0 : 1,
      ],
    },
    ...permissions.map((permission) => ({
      sql: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      params: [ctx.orgId, ids.role, permission],
    })),
    ...(group === undefined
      ? []
      : [
          {
            sql: `INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at)
                  VALUES (?, ?, ?, ?, ?)`,
            params: [
              ctx.orgId,
              ids.user,
              group.memberProvider,
              group.name,
              group.refreshedAt ?? hourAgo,
            ],
          },
        ]),
    {
      sql: `INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        ids.role,
        ctx.orgId,
        group === undefined ? 'email' : 'group',
        group === undefined ? email : group.name,
        group === undefined ? null : group.grantProvider,
        options.projectGrant === true ? 'project' : 'organization',
        options.projectGrant === true ? projectId : null,
        ids.role,
      ],
    },
    {
      sql: `INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at, last_seen_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        ids.session,
        ctx.orgId,
        ids.user,
        Buffer.from(ids.session).toString('hex').padEnd(64, '0'),
        'b'.repeat(64),
        session.created_at,
        session.expires_at,
        session.last_seen_at,
        session.revoked_at,
      ],
    },
  ]);
  return { userId: ids.user, sessionId: ids.session };
}

function fenceFor(actor: TestActor, revision?: number): MutationFence {
  return mutationFence(
    actor as unknown as AuthenticatedActor,
    revision === undefined ? {} : { role: revision },
  );
}

async function revisionOf(id: string): Promise<number> {
  const rows = await database.executor.all<{ revision: number }>({
    sql: 'SELECT revision FROM role WHERE id = ?',
    params: [id],
  });
  return rows[0]?.revision ?? 1;
}

let operation = 0;
function opId(): string {
  operation += 1;
  return `01J0OP${String(operation).padStart(20, '0')}`;
}

type CreateInput = Parameters<RoleRepository['create']>[2];

interface UnfencedRoles {
  readonly list: RoleRepository['list'];
  readonly get: RoleRepository['get'];
  create(ctx: OrgContext, input: Omit<CreateInput, 'opId'>): ReturnType<RoleRepository['create']>;
  rename(
    ctx: OrgContext,
    id: string,
    name: string,
    now: string,
  ): ReturnType<RoleRepository['rename']>;
  setPermissions(
    ctx: OrgContext,
    id: string,
    permissions: readonly string[],
    now: string,
  ): ReturnType<RoleRepository['setPermissions']>;
  delete(ctx: OrgContext, id: string): ReturnType<RoleRepository['delete']>;
}

function createRoleRepository(executor: ScalarSqlExecutor): UnfencedRoles {
  const raw = createFencedRoleRepository(executor, { providerAnchors: PROVIDERS });
  const fence = async (ctx: OrgContext, id?: string): Promise<MutationFence> => {
    const actor = await actorFor(ctx);
    return fenceFor(actor, id === undefined ? undefined : await revisionOf(id));
  };
  return {
    list: raw.list,
    get: raw.get,
    create: async (ctx, input) => raw.create(ctx, await fence(ctx), { ...input, opId: opId() }),
    rename: async (ctx, id, name, now) =>
      raw.rename(ctx, await fence(ctx, id), id, name, now, opId()),
    setPermissions: async (ctx, id, permissions, now) =>
      raw.setPermissions(ctx, await fence(ctx, id), id, permissions, now, opId()),
    delete: async (ctx, id) => raw.delete(ctx, await fence(ctx, id), id, opId()),
  };
}

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
    sql:
      table === 'role'
        ? `SELECT count(*) AS n FROM role WHERE ${NOT_ACTOR_ROLE}`
        : `SELECT count(*) AS n FROM role_permission WHERE role_id IN
           (SELECT id FROM role WHERE ${NOT_ACTOR_ROLE})`,
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
  it('2: an organization seeded as of migration 0001 has every catalogue permission on organization_admin after all migrations, before any bootstrap', async () => {
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
      expect(missingCatalogue(await adminPermissions())).toEqual([]);

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
      revision: 1,
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

  it('4: a role in an organization that does not exist is refused and stores nothing', async () => {
    const orphan = orgContext(NEW_ORG);
    await expect(
      createFencedRoleRepository(database.executor, { providerAnchors: PROVIDERS }).create(
        orphan,
        fenceFor({ userId: 'nobody', sessionId: 'none' }),
        { ...CUSTOM, opId: opId() },
      ),
    ).rejects.toThrow('cache_epoch');
    expect(await count('role')).toBe(0);
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

  it('4: a successful delete is one batch and a refusal of a system role is one batch', async () => {
    await seed(a, 'S1');
    const repository = createRoleRepository(database.executor);
    await repository.create(a, CUSTOM);
    const counted = countCalls(database.executor);
    const counting = createRoleRepository(counted.executor);
    expect(await counting.delete(a, CUSTOM.id)).toBe('deleted');
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
    const admin = await byKey(a, 'organization_admin');
    expect(await counting.delete(a, admin.id)).toBe('system');
    expect(counted.counts().batch).toBe(2);
  });
});

async function snapshot(): Promise<string> {
  const roles = await database.executor.all({
    sql: `SELECT * FROM role WHERE ${NOT_ACTOR_ROLE} ORDER BY id`,
    params: [],
  });
  const permissions = await database.executor.all({
    sql: `SELECT * FROM role_permission WHERE role_id IN
          (SELECT id FROM role WHERE ${NOT_ACTOR_ROLE}) ORDER BY role_id, permission`,
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
    expect(counted.counts().batch).toBe(1);
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

describe('fenced role mutators', () => {
  const LIMITED = ['org:roles:write', 'org:read', 'project:read', 'project:packages:read'];
  const ORG_CUSTOM = { ...CUSTOM, scope: 'organization' as const, permissions: ['org:read'] };

  async function limited(permissions: readonly string[] = LIMITED): Promise<TestActor> {
    return actorFor(a, { name: 'LIMITED', permissions, protects: false });
  }

  async function epoch(): Promise<unknown[]> {
    return database.executor.all({ sql: 'SELECT * FROM cache_epoch ORDER BY org_id', params: [] });
  }

  async function seedCustom(): Promise<void> {
    const admin = await actorFor(a);
    await createFencedRoleRepository(database.executor, { providerAnchors: PROVIDERS }).create(
      a,
      fenceFor(admin),
      {
        ...ORG_CUSTOM,
        opId: opId(),
      },
    );
  }

  it('1: a non-admin creates a role inside its live permissions and not beyond them', async () => {
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const actor = await limited();
    const before = await snapshot();
    expect(
      await repository.create(a, fenceFor(actor), {
        ...ORG_CUSTOM,
        permissions: ['org:read', 'org:users:write'],
        opId: opId(),
      }),
    ).toBe('authority');
    expect(await snapshot()).toBe(before);
    expect(await repository.create(a, fenceFor(actor), { ...ORG_CUSTOM, opId: opId() })).toBe(
      'created',
    );
  });

  it('1: a non-admin cannot rename or delete a role that exceeds its live permissions', async () => {
    await seedCustom();
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    await database.executor.all({
      sql: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      params: [a.orgId, CUSTOM.id, 'org:users:write'],
    });
    const actor = await limited();
    const revision = await revisionOf(CUSTOM.id);
    const before = await snapshot();
    expect(
      await repository.rename(a, fenceFor(actor, revision), CUSTOM.id, 'Hijack', LATER, opId()),
    ).toBe('authority');
    expect(await repository.delete(a, fenceFor(actor, revision), CUSTOM.id, opId())).toBe(
      'authority',
    );
    expect(await snapshot()).toBe(before);
  });

  it('1: a non-admin cannot widen or rewrite a superior role through setPermissions', async () => {
    await seedCustom();
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const actor = await limited();
    const revision = await revisionOf(CUSTOM.id);
    const before = await snapshot();
    expect(
      await repository.setPermissions(
        a,
        fenceFor(actor, revision),
        CUSTOM.id,
        ['org:read', 'org:users:write'],
        LATER,
        opId(),
      ),
    ).toBe('authority');
    await database.executor.all({
      sql: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      params: [a.orgId, CUSTOM.id, 'org:users:write'],
    });
    const superior = await snapshot();
    expect(
      await repository.setPermissions(
        a,
        fenceFor(actor, revision),
        CUSTOM.id,
        ['org:read'],
        LATER,
        opId(),
      ),
    ).toBe('authority');
    expect(await snapshot()).toBe(superior);
    expect(before).not.toBe(superior);
  });

  it('1: an actor stripped between fence and batch is refused inside the batch', async () => {
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const actor = await limited();
    const fence = fenceFor(actor);
    await database.executor.all({
      sql: 'DELETE FROM access_grant WHERE id = ?',
      params: [actorIds(a, 'LIMITED').role],
    });
    const before = [await snapshot(), JSON.stringify(await epoch())];
    expect(await repository.create(a, fence, { ...ORG_CUSTOM, opId: opId() })).toBe('authority');
    expect([await snapshot(), JSON.stringify(await epoch())]).toEqual(before);
  });

  it('1: a suspended user, a revoked, expired, idle or other-owner session are refused', async () => {
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const cases: Record<string, Parameters<typeof actorFor>[1]> = {
      SUSPENDED: { status: 'suspended' },
      REVOKED: { session: { revoked_at: new Date().toISOString() } },
      EXPIRED: { session: { expires_at: new Date(Date.now() - 1000).toISOString() } },
      IDLE: { session: { created_at: old, last_seen_at: old } },
      ABSOLUTE: {
        session: {
          created_at: new Date(Date.now() - 13 * 3_600_000).toISOString(),
          last_seen_at: new Date().toISOString(),
        },
      },
    };
    const before = await snapshot();
    for (const [name, options] of Object.entries(cases)) {
      const actor = await actorFor(a, { name, ...options });
      expect(
        await repository.create(a, fenceFor(actor), {
          ...ORG_CUSTOM,
          id: `01J0X${name}`.padEnd(26, '0'),
          opId: opId(),
        }),
        name,
      ).toBe('authority');
    }
    const first = await actorFor(a, { name: 'OWNER_A' });
    const second = await actorFor(a, { name: 'OWNER_B' });
    expect(
      await repository.create(a, fenceFor({ userId: first.userId, sessionId: second.sessionId }), {
        ...ORG_CUSTOM,
        opId: opId(),
      }),
    ).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('2: a stale expected revision answers conflict and changes nothing', async () => {
    await seedCustom();
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const actor = await actorFor(a);
    const before = await snapshot();
    const stale = (await revisionOf(CUSTOM.id)) + 5;
    expect(
      await repository.rename(a, fenceFor(actor, stale), CUSTOM.id, 'Late', LATER, opId()),
    ).toBe('conflict');
    expect(
      await repository.setPermissions(
        a,
        fenceFor(actor, stale),
        CUSTOM.id,
        ['org:read'],
        LATER,
        opId(),
      ),
    ).toBe('conflict');
    expect(await repository.delete(a, fenceFor(actor, stale), CUSTOM.id, opId())).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('2: every successful role or permission change increments the revision exactly once', async () => {
    await seedCustom();
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const actor = await actorFor(a);
    expect(await revisionOf(CUSTOM.id)).toBe(1);
    expect(await repository.rename(a, fenceFor(actor, 1), CUSTOM.id, 'One', LATER, opId())).toBe(
      'renamed',
    );
    expect(await revisionOf(CUSTOM.id)).toBe(2);
    expect(
      await repository.setPermissions(
        a,
        fenceFor(actor, 2),
        CUSTOM.id,
        ['org:read', 'org:users:read'],
        LATER,
        opId(),
      ),
    ).toBe('updated');
    expect(await revisionOf(CUSTOM.id)).toBe(3);
    const rows = await database.executor.all<{ last_op_id: string | null }>({
      sql: 'SELECT last_op_id FROM role WHERE id = ?',
      params: [CUSTOM.id],
    });
    expect(rows[0]?.last_op_id).toMatch(/^01J0OP/);
  });

  it('3: two permission edits from one revision cannot both pass', async () => {
    await seedCustom();
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const actor = await actorFor(a);
    const fence = fenceFor(actor, 1);
    const results = await Promise.all([
      repository.setPermissions(a, fence, CUSTOM.id, ['org:read', 'org:users:read'], LATER, opId()),
      repository.setPermissions(a, fence, CUSTOM.id, ['org:read', 'org:audit:read'], LATER, opId()),
    ]);
    expect([...results].sort()).toEqual(['conflict', 'updated']);
    expect(await revisionOf(CUSTOM.id)).toBe(2);
  });

  it('3: a refused batch changes no row and leaves the cache epoch alone', async () => {
    await seedCustom();
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const actor = await limited();
    const before = [await snapshot(), JSON.stringify(await epoch())];
    await repository.setPermissions(
      a,
      fenceFor(actor, 1),
      CUSTOM.id,
      ['org:users:write'],
      LATER,
      opId(),
    );
    await repository.delete(a, fenceFor(actor, 99), CUSTOM.id, opId());
    expect([await snapshot(), JSON.stringify(await epoch())]).toEqual(before);
  });

  it('3: a successful fenced change bumps the organization cache epoch once', async () => {
    await seedCustom();
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const actor = await actorFor(a);
    const before = JSON.stringify(await epoch());
    await repository.rename(a, fenceFor(actor, 1), CUSTOM.id, 'Epoch', LATER, opId());
    expect(JSON.stringify(await epoch())).not.toBe(before);
  });

  it('3: rename, setPermissions and delete require an expected role revision', async () => {
    await seedCustom();
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const fence = fenceFor(await actorFor(a));
    await expect(repository.rename(a, fence, CUSTOM.id, 'x', LATER, opId())).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      repository.setPermissions(a, fence, CUSTOM.id, [], LATER, opId()),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(repository.delete(a, fence, CUSTOM.id, opId())).rejects.toBeInstanceOf(TypeError);
  });

  it('3: every mutator refuses a fence that mutationFence did not issue', async () => {
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const forged = {
      userId: 'x',
      sessionId: 'y',
      expected: { role: 1 },
    } as unknown as MutationFence;
    await expect(
      repository.create(a, forged, { ...ORG_CUSTOM, opId: opId() }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      repository.rename(a, forged, CUSTOM.id, 'x', LATER, opId()),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      repository.setPermissions(a, forged, CUSTOM.id, [], LATER, opId()),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(repository.delete(a, forged, CUSTOM.id, opId())).rejects.toBeInstanceOf(TypeError);
  });

  it('3: a foreign-organization actor holds no authority in this organization', async () => {
    const repository = createFencedRoleRepository(database.executor, {
      providerAnchors: PROVIDERS,
    });
    const foreign = await actorFor(b);
    const before = await snapshot();
    expect(await repository.create(a, fenceFor(foreign), { ...ORG_CUSTOM, opId: opId() })).toBe(
      'authority',
    );
    expect(await snapshot()).toBe(before);
  });
});

describe('fenced role mutators: refusals, authority sources and races', () => {
  const ORG_CUSTOM = { ...CUSTOM, scope: 'organization' as const, permissions: ['org:read'] };
  const repo = () => createFencedRoleRepository(database.executor, { providerAnchors: PROVIDERS });

  async function epoch(): Promise<string> {
    return JSON.stringify(
      await database.executor.all({ sql: 'SELECT * FROM cache_epoch ORDER BY org_id', params: [] }),
    );
  }

  async function unchanged(run: () => Promise<unknown>): Promise<unknown> {
    const before = [await snapshot(), await epoch()];
    const result = await run();
    expect([await snapshot(), await epoch()]).toEqual(before);
    return result;
  }

  async function createCustom(): Promise<void> {
    await repo().create(a, fenceFor(await actorFor(a)), { ...ORG_CUSTOM, opId: opId() });
  }

  it('3: locked, system, invalid_permissions, in_use and duplicate_key roll back and keep the epoch', async () => {
    await seed(a, 'S1');
    const admin = await actorFor(a);
    const adminRole = await byKey(a, 'organization_admin');
    const auditor = await byKey(a, 'project_auditor');
    const f = (id: string) => fenceFor(admin, 1 + 0 * id.length);

    expect(
      await unchanged(() => repo().rename(a, f(adminRole.id), adminRole.id, 'Boss', LATER, opId())),
    ).toBe('locked');
    expect(
      await unchanged(() =>
        repo().setPermissions(a, f(adminRole.id), adminRole.id, ['org:read'], LATER, opId()),
      ),
    ).toBe('locked');
    expect(
      await unchanged(() =>
        repo().setPermissions(a, f(auditor.id), auditor.id, ['org:read'], LATER, opId()),
      ),
    ).toBe('invalid_permissions');
    expect(await unchanged(() => repo().delete(a, f(auditor.id), auditor.id, opId()))).toBe(
      'system',
    );

    await createCustom();
    await database.executor.all({
      sql: `INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id)
            VALUES (?, ?, 'email', ?, 'organization', ?)`,
      params: ['01J0GRANT00000000000000000', a.orgId, 'person@example.test', CUSTOM.id],
    });
    const revision = await revisionOf(CUSTOM.id);
    expect(
      await unchanged(() => repo().delete(a, fenceFor(admin, revision), CUSTOM.id, opId())),
    ).toBe('in_use');
    expect(
      await unchanged(() =>
        repo().create(a, fenceFor(admin), { ...ORG_CUSTOM, name: 'Other', opId: opId() }),
      ),
    ).toBe('duplicate_key');
  });

  it('2: a replay that fills in permissions bumps the revision once', async () => {
    const admin = await actorFor(a);
    await repo().create(a, fenceFor(admin), { ...ORG_CUSTOM, permissions: [], opId: opId() });
    expect(await revisionOf(CUSTOM.id)).toBe(1);
    expect(await repo().create(a, fenceFor(admin), { ...ORG_CUSTOM, opId: opId() })).toBe(
      'duplicate_key',
    );
    expect(await revisionOf(CUSTOM.id)).toBe(2);
    expect((await repo().get(a, CUSTOM.id))?.permissions).toEqual(['org:read']);
  });

  it('1: a group grant carries authority only for the same provider and fresh evidence', async () => {
    const named = { permissions: ['org:roles:write', 'org:read'], protects: false };
    const same = await actorFor(a, {
      name: 'GROUPOK',
      ...named,
      group: { name: 'ops1', grantProvider: 'oidc', memberProvider: 'oidc' },
    });
    const wrongProvider = await actorFor(a, {
      name: 'GROUPWP',
      ...named,
      group: { name: 'ops2', grantProvider: 'oidc', memberProvider: 'other' },
    });
    const staleGroup = await actorFor(a, {
      name: 'GROUPST',
      ...named,
      group: {
        name: 'ops3',
        grantProvider: 'oidc',
        memberProvider: 'oidc',
        refreshedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
    });
    const staleIdentity = await actorFor(a, {
      name: 'GROUPSI',
      ...named,
      group: {
        name: 'ops4',
        grantProvider: 'oidc',
        memberProvider: 'oidc',
        identityValidatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
    });

    const attempt = (actor: TestActor, id: string) =>
      repo().create(a, fenceFor(actor), {
        ...ORG_CUSTOM,
        id,
        key: `k${id.slice(-6).toLowerCase()}`,
        opId: opId(),
      });
    expect(await unchanged(() => attempt(wrongProvider, '01J0CUSTOM00000000000000W1'))).toBe(
      'authority',
    );
    expect(await unchanged(() => attempt(staleGroup, '01J0CUSTOM00000000000000W2'))).toBe(
      'authority',
    );
    expect(await unchanged(() => attempt(staleIdentity, '01J0CUSTOM00000000000000W3'))).toBe(
      'authority',
    );
    expect(await attempt(same, '01J0CUSTOM00000000000000W4')).toBe('created');
  });

  it('1: a project-scope grant gives no organization authority', async () => {
    const actor = await actorFor(a, {
      name: 'PROJONLY',
      permissions: ['org:roles:write', 'org:read', 'project:read'],
      protects: false,
      projectGrant: true,
    });
    expect(
      await unchanged(() => repo().create(a, fenceFor(actor), { ...ORG_CUSTOM, opId: opId() })),
    ).toBe('authority');
  });

  it('1: an actor without org:roles:write is refused even with a protected-looking role', async () => {
    const actor = await actorFor(a, {
      name: 'NOWRITE',
      permissions: ['org:read'],
      protects: false,
    });
    expect(
      await unchanged(() => repo().create(a, fenceFor(actor), { ...ORG_CUSTOM, opId: opId() })),
    ).toBe('authority');
  });

  it('1: widening a role after the pre-read is refused inside the batch for rename and delete', async () => {
    await createCustom();
    const actor = await actorFor(a, {
      name: 'NARROW',
      permissions: ['org:roles:write', 'org:read'],
      protects: false,
    });
    const revision = await revisionOf(CUSTOM.id);
    const stale = await repo().get(a, CUSTOM.id);
    expect(stale?.permissions).toEqual(['org:read']);
    await database.executor.all({
      sql: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      params: [a.orgId, CUSTOM.id, 'org:users:write'],
    });
    expect(
      await unchanged(() =>
        repo().rename(a, fenceFor(actor, revision), CUSTOM.id, 'Late', LATER, opId()),
      ),
    ).toBe('authority');
    expect(
      await unchanged(() => repo().delete(a, fenceFor(actor, revision), CUSTOM.id, opId())),
    ).toBe('authority');
  });

  it('3: two connections editing permissions from one revision give one update and one conflict', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pb-role-race-'));
    await database.close();
    database = await openMigratedDatabase({
      file: join(directory, 'store.sqlite'),
      twoOrganizations: true,
    });
    try {
      if (database.orgs === null) throw new Error('two organizations expected');
      a = database.orgs.a;
      await createCustom();
      const actor = await actorFor(a);
      const other = await database.second();
      const options = { providerAnchors: PROVIDERS };
      const results = await Promise.all([
        createFencedRoleRepository(database.executor, options).setPermissions(
          a,
          fenceFor(actor, 1),
          CUSTOM.id,
          ['org:read', 'org:users:read'],
          LATER,
          opId(),
        ),
        createFencedRoleRepository(other, options).setPermissions(
          a,
          fenceFor(actor, 1),
          CUSTOM.id,
          ['org:read', 'org:audit:read'],
          LATER,
          opId(),
        ),
      ]);
      expect([...results].sort()).toEqual(['conflict', 'updated']);
      expect(await revisionOf(CUSTOM.id)).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it('requires explicit provider anchors at construction', () => {
  // @ts-expect-error provider anchors are required
  expect(() => createFencedRoleRepository(database.executor)).toThrow(TypeError);
  // @ts-expect-error provider anchors are required
  expect(() => createFencedRoleRepository(database.executor, {})).toThrow(TypeError);
  expect(() =>
    createFencedRoleRepository(database.executor, { providerAnchors: [] }),
  ).not.toThrow();
});

it('lets a non-admin rename a role with a retired permission and preserves it', async () => {
  const repository = createFencedRoleRepository(database.executor, { providerAnchors: PROVIDERS });
  const admin = await actorFor(a);
  expect(
    await repository.create(a, fenceFor(admin), {
      ...CUSTOM,
      scope: 'organization',
      permissions: ['org:read'],
      opId: opId(),
    }),
  ).toBe('created');
  await database.executor.batch([
    {
      sql: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      params: [a.orgId, CUSTOM.id, 'retired:permission'],
    },
  ]);
  const manager = await actorFor(a, {
    name: 'RETIRED',
    protects: false,
    permissions: ['org:roles:write', 'org:read'],
  });
  expect(
    await repository.rename(a, fenceFor(manager, 1), CUSTOM.id, 'Renamed', LATER, opId()),
  ).toBe('renamed');
  expect((await repository.get(a, CUSTOM.id))?.permissions).toContain('retired:permission');
});
