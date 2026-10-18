import { seedStatements } from './testing/seed-statements.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql, type Expression, type SqlBool } from 'kysely';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import {
  adminEligibility,
  anchorMatches,
  compile,
  db,
  existsGuard,
  opGuard,
  ownsIdentity,
  protectedHolder,
  type ProtectedHolderExclusion,
  type ProtectedHolderInput,
} from './kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from './testing/migrated-database.js';

interface Fixture {
  readonly database: MigratedDatabase;
  readonly a: OrgContext;
  readonly b: OrgContext;
}

let fixture: Fixture;

beforeEach(async () => {
  const database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  fixture = { database, a: database.orgs.a, b: database.orgs.b };
});

afterEach(async () => {
  await fixture.database.close();
});

function insert(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function user(org: OrgContext, id: string, email: string, status = 'active'): Statement {
  return insert(
    'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
    id,
    org.orgId,
    email,
    status,
  );
}

function role(
  org: OrgContext,
  id: string,
  key: string,
  scope: string,
  protectsLastHolder: number,
): Statement {
  return insert(
    'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    key,
    key,
    scope,
    protectsLastHolder,
  );
}

function emailGrant(
  org: OrgContext,
  id: string,
  email: string,
  roleId: string,
  projectId: string | null = null,
): Statement {
  return insert(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
    id,
    org.orgId,
    'email',
    email,
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
  );
}

function groupGrant(
  org: OrgContext,
  id: string,
  provider: string,
  group: string,
  roleId: string,
  projectId: string | null = null,
): Statement {
  return insert(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    'group',
    group,
    provider,
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
  );
}

function membership(org: OrgContext, userId: string, provider: string, group: string): Statement {
  return insert(
    'INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, ?, ?)',
    org.orgId,
    userId,
    provider,
    group,
  );
}

function project(org: OrgContext, id: string, slug: string): Statement {
  return insert(
    'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
    id,
    org.orgId,
    slug,
    slug,
  );
}

function identity(
  org: OrgContext,
  id: string,
  userId: string,
  provider: string,
  subject: string,
  email: string,
): Statement {
  return insert(
    'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    id,
    org.orgId,
    userId,
    provider,
    subject,
    email,
    new Date().toISOString(),
  );
}

async function seed(statements: readonly Statement[]): Promise<void> {
  await seedStatements(fixture.database.executor, statements);
}

async function holds(guard: Expression<SqlBool>, org: OrgContext = fixture.a): Promise<boolean> {
  const rows = await fixture.database.executor.all<{ id: string }>(
    compile(db.selectFrom('organization').select('id').where('id', '=', org.orgId).where(guard)),
  );
  return rows.length === 1;
}

const HOLDER_PROVIDERS = ['oidc', 'access'] as const;
const HOLDER_ANCHOR = 'https://idp.example.test';

function holderInput(exclude?: ProtectedHolderExclusion): ProtectedHolderInput {
  const providers = HOLDER_PROVIDERS.map((provider) => ({
    provider,
    anchor: HOLDER_ANCHOR,
    emailAuthoritative: true,
  }));
  const now = new Date().toISOString();
  return exclude === undefined
    ? { kind: 'fresh', now, providers }
    : { kind: 'fresh', now, providers, exclude };
}

function holderBindings(org: OrgContext): Statement[] {
  return HOLDER_PROVIDERS.map((provider) =>
    insert(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      org.orgId,
      provider,
      HOLDER_ANCHOR,
    ),
  );
}

function holderIdentities(
  org: OrgContext,
  users: readonly (readonly [string, string])[],
): Statement[] {
  return users.flatMap(([userId, email]) =>
    HOLDER_PROVIDERS.map((provider) =>
      insert(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        `HID-${provider}-${userId}`,
        org.orgId,
        userId,
        provider,
        `${provider}-${userId}`,
        email,
        new Date().toISOString(),
      ),
    ),
  );
}

async function holders(
  org: OrgContext,
  exclude?: { readonly grantId?: string; readonly userId?: string },
): Promise<string[]> {
  const rows = await fixture.database.executor.all<{ id: string }>(
    compile(
      db
        .selectFrom('user_account as u')
        .select('u.id')
        .where('u.org_id', '=', org.orgId)
        .where((eb) => protectedHolder(org, eb.ref('u.id'), holderInput(exclude)))
        .orderBy('u.id'),
    ),
  );
  return rows.map((row) => row.id);
}

const ADMIN_ROLE = '01J0ROLEADMIN00000000000AA';
const VIEW_ROLE = '01J0ROLEVIEW000000000000AA';
const PROJECT_ROLE = '01J0ROLEPROJECT0000000000AA';
const PROJECT = '01J0PROJECT00000000000000AA';

const rolesAndProject = (org: OrgContext): Statement[] => [
  role(org, ADMIN_ROLE, 'organization_admin', 'organization', 1),
  role(org, VIEW_ROLE, 'viewer', 'organization', 0),
  role(org, PROJECT_ROLE, 'project_admin', 'project', 1),
  project(org, PROJECT, 'alpha'),
];

describe('opGuard', () => {
  const USER = '01J0USER000000000000000001';

  beforeEach(async () => {
    await seed([
      user(fixture.a, USER, 'op@example.test'),
      insert(
        'INSERT INTO local_login (user_id, org_id, last_op_id) VALUES (?, ?, ?)',
        USER,
        fixture.a.orgId,
        'op-1',
      ),
    ]);
  });

  it('is true when the marker equals the operation id', async () => {
    expect(await holds(opGuard(fixture.a, 'local_login', { userId: USER }, 'op-1'))).toBe(true);
  });

  it('is false for another operation id', async () => {
    expect(await holds(opGuard(fixture.a, 'local_login', { userId: USER }, 'op-2'))).toBe(false);
  });

  it('is false for another user', async () => {
    expect(await holds(opGuard(fixture.a, 'local_login', { userId: 'someone-else' }, 'op-1'))).toBe(
      false,
    );
  });

  it('is false while no operation was recorded', async () => {
    await fixture.database.executor.all({
      sql: 'UPDATE local_login SET last_op_id = NULL',
      params: [],
    });

    expect(await holds(opGuard(fixture.a, 'local_login', { userId: USER }, 'op-1'))).toBe(false);
  });

  it('is false from another organization', async () => {
    expect(await holds(opGuard(fixture.b, 'local_login', { userId: USER }, 'op-1'))).toBe(false);
  });

  it('refuses an empty operation id', () => {
    expect(() => opGuard(fixture.a, 'local_login', { userId: USER }, '')).toThrow(TypeError);
  });

  it('binds the operation id as a parameter', () => {
    const statement = compile(
      db
        .selectFrom('organization')
        .select('id')
        .where(opGuard(fixture.a, 'local_login', { userId: USER }, 'op-9')),
    );

    expect(statement.params).toContain('op-9');
    expect(statement.sql).not.toContain('op-9');
  });
});

describe('existsGuard', () => {
  it('is true when the subquery returns a row', async () => {
    await seed([user(fixture.a, '01J0USER000000000000000001', 'one@example.test')]);

    const guard = existsGuard((builder) =>
      builder.selectFrom('user_account').select('id').where('email', '=', 'one@example.test'),
    );

    expect(await holds(guard)).toBe(true);
  });

  it('is false when the subquery returns no row', async () => {
    const guard = existsGuard((builder) =>
      builder.selectFrom('user_account').select('id').where('email', '=', 'none@example.test'),
    );

    expect(await holds(guard)).toBe(false);
  });
});

describe('ownsIdentity', () => {
  const OWNER = '01J0USER000000000000000001';
  const OTHER = '01J0USER000000000000000002';

  beforeEach(async () => {
    await seed([
      user(fixture.a, OWNER, 'owner@example.test'),
      user(fixture.a, OTHER, 'other@example.test'),
      identity(
        fixture.a,
        '01J0IDENT000000000000000A1',
        OWNER,
        'oidc',
        'sub-1',
        'owner@example.test',
      ),
    ]);
  });

  it('is true for the user the identity belongs to', async () => {
    const guard = ownsIdentity(fixture.a, { provider: 'oidc', subject: 'sub-1', userId: OWNER });

    expect(await holds(guard)).toBe(true);
  });

  it('is false when another user owns the identity', async () => {
    const guard = ownsIdentity(fixture.a, { provider: 'oidc', subject: 'sub-1', userId: OTHER });

    expect(await holds(guard)).toBe(false);
  });

  it('is false for another subject or provider', async () => {
    expect(
      await holds(ownsIdentity(fixture.a, { provider: 'oidc', subject: 'sub-2', userId: OWNER })),
    ).toBe(false);
    expect(
      await holds(ownsIdentity(fixture.a, { provider: 'access', subject: 'sub-1', userId: OWNER })),
    ).toBe(false);
  });

  it('is false from another organization', async () => {
    const guard = ownsIdentity(fixture.b, { provider: 'oidc', subject: 'sub-1', userId: OWNER });

    expect(await holds(guard)).toBe(false);
  });

  it('accepts the user id as an expression', async () => {
    const rows = await fixture.database.executor.all<{ id: string }>(
      compile(
        db
          .selectFrom('user_account as u')
          .select('u.id')
          .where('u.org_id', '=', fixture.a.orgId)
          .where((eb) =>
            ownsIdentity(fixture.a, { provider: 'oidc', subject: 'sub-1', userId: eb.ref('u.id') }),
          ),
      ),
    );

    expect(rows).toEqual([{ id: OWNER }]);
  });
});

describe('anchorMatches', () => {
  beforeEach(async () => {
    await seed([
      insert(
        'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        fixture.a.orgId,
        'oidc',
        'https://issuer.example.test',
      ),
    ]);
  });

  it('is true for the recorded anchor', async () => {
    expect(await holds(anchorMatches(fixture.a, 'oidc', 'https://issuer.example.test'))).toBe(true);
  });

  it('is false for a different anchor', async () => {
    expect(await holds(anchorMatches(fixture.a, 'oidc', 'https://rebound.example.test'))).toBe(
      false,
    );
  });

  it('is false for another provider or organization, or without a binding', async () => {
    expect(await holds(anchorMatches(fixture.a, 'access', 'https://issuer.example.test'))).toBe(
      false,
    );
    expect(await holds(anchorMatches(fixture.b, 'oidc', 'https://issuer.example.test'))).toBe(
      false,
    );
  });
});

describe('adminEligibility', () => {
  const BY_EMAIL = '01J0USER000000000000000001';
  const BY_PROJECT = '01J0USER000000000000000002';
  const SUSPENDED = '01J0USER000000000000000003';
  const UNPROTECTED = '01J0USER000000000000000004';
  const BY_GROUP = '01J0USER000000000000000005';
  const NO_GRANT = '01J0USER000000000000000006';

  beforeEach(async () => {
    await seed([
      ...rolesAndProject(fixture.a),
      user(fixture.a, BY_EMAIL, 'admin@example.test'),
      user(fixture.a, BY_PROJECT, 'project@example.test'),
      user(fixture.a, SUSPENDED, 'suspended@example.test', 'suspended'),
      user(fixture.a, UNPROTECTED, 'viewer@example.test'),
      user(fixture.a, BY_GROUP, 'group@example.test'),
      user(fixture.a, NO_GRANT, 'nobody@example.test'),
      emailGrant(fixture.a, '01J0GRANT000000000000000A1', 'admin@example.test', ADMIN_ROLE),
      emailGrant(
        fixture.a,
        '01J0GRANT000000000000000A2',
        'project@example.test',
        PROJECT_ROLE,
        PROJECT,
      ),
      emailGrant(fixture.a, '01J0GRANT000000000000000A3', 'suspended@example.test', ADMIN_ROLE),
      emailGrant(fixture.a, '01J0GRANT000000000000000A4', 'viewer@example.test', VIEW_ROLE),
      membership(fixture.a, BY_GROUP, 'oidc', 'admins'),
      groupGrant(fixture.a, '01J0GRANT000000000000000A5', 'oidc', 'admins', ADMIN_ROLE),
    ]);
  });

  it('is true for an active user with an organization e-mail grant of a protected role', async () => {
    expect(await holds(adminEligibility(fixture.a, BY_EMAIL))).toBe(true);
  });

  it('is false when the grant is a project grant', async () => {
    expect(await holds(adminEligibility(fixture.a, BY_PROJECT))).toBe(false);
  });

  it('is false for a suspended user', async () => {
    expect(await holds(adminEligibility(fixture.a, SUSPENDED))).toBe(false);
  });

  it('is false for a role that does not protect the last holder', async () => {
    expect(await holds(adminEligibility(fixture.a, UNPROTECTED))).toBe(false);
  });

  it('is false for a group grant and for a user without a grant', async () => {
    expect(await holds(adminEligibility(fixture.a, BY_GROUP))).toBe(false);
    expect(await holds(adminEligibility(fixture.a, NO_GRANT))).toBe(false);
  });

  it('is false for an unknown user and from another organization', async () => {
    expect(await holds(adminEligibility(fixture.a, 'unknown'))).toBe(false);
    expect(await holds(adminEligibility(fixture.b, BY_EMAIL))).toBe(false);
  });

  it('accepts the user id as an expression', async () => {
    const rows = await fixture.database.executor.all<{ id: string }>(
      compile(
        db
          .selectFrom('user_account as u')
          .select('u.id')
          .where('u.org_id', '=', fixture.a.orgId)
          .where((eb) => adminEligibility(fixture.a, eb.ref('u.id'))),
      ),
    );

    expect(rows).toEqual([{ id: BY_EMAIL }]);
  });
});

describe('protectedHolder', () => {
  const EMAIL_HOLDER = '01J0USER000000000000000001';
  const GROUP_HOLDER = '01J0USER000000000000000002';
  const BOTH = '01J0USER000000000000000003';
  const SUSPENDED = '01J0USER000000000000000004';
  const VIEWER = '01J0USER000000000000000005';
  const PROJECT_ONLY = '01J0USER000000000000000006';
  const OTHER_PROVIDER = '01J0USER000000000000000007';
  const G_EMAIL = '01J0GRANT000000000000000A1';
  const G_GROUP = '01J0GRANT000000000000000A2';
  const G_BOTH_EMAIL = '01J0GRANT000000000000000A3';
  const G_SUSPENDED = '01J0GRANT000000000000000A4';
  const G_VIEWER = '01J0GRANT000000000000000A5';
  const G_PROJECT = '01J0GRANT000000000000000A6';
  const G_VIEW_GROUP = '01J0GRANT000000000000000A7';

  beforeEach(async () => {
    await seed([
      ...rolesAndProject(fixture.a),
      user(fixture.a, EMAIL_HOLDER, 'email@example.test'),
      user(fixture.a, GROUP_HOLDER, 'group@example.test'),
      user(fixture.a, BOTH, 'both@example.test'),
      user(fixture.a, SUSPENDED, 'suspended@example.test', 'suspended'),
      user(fixture.a, VIEWER, 'viewer@example.test'),
      user(fixture.a, PROJECT_ONLY, 'project@example.test'),
      user(fixture.a, OTHER_PROVIDER, 'other@example.test'),
      emailGrant(fixture.a, G_EMAIL, 'email@example.test', ADMIN_ROLE),
      groupGrant(fixture.a, G_GROUP, 'oidc', 'admins', ADMIN_ROLE),
      emailGrant(fixture.a, G_BOTH_EMAIL, 'both@example.test', ADMIN_ROLE),
      emailGrant(fixture.a, G_SUSPENDED, 'suspended@example.test', ADMIN_ROLE),
      emailGrant(fixture.a, G_VIEWER, 'viewer@example.test', VIEW_ROLE),
      emailGrant(fixture.a, G_PROJECT, 'project@example.test', PROJECT_ROLE, PROJECT),
      groupGrant(fixture.a, G_VIEW_GROUP, 'oidc', 'readers', VIEW_ROLE),
      membership(fixture.a, GROUP_HOLDER, 'oidc', 'admins'),
      membership(fixture.a, BOTH, 'oidc', 'admins'),
      membership(fixture.a, SUSPENDED, 'oidc', 'admins'),
      membership(fixture.a, VIEWER, 'oidc', 'readers'),
      membership(fixture.a, OTHER_PROVIDER, 'access', 'admins'),
      ...holderBindings(fixture.a),
      ...holderIdentities(fixture.a, [
        [EMAIL_HOLDER, 'email@example.test'],
        [GROUP_HOLDER, 'group@example.test'],
        [BOTH, 'both@example.test'],
        [SUSPENDED, 'suspended@example.test'],
        [VIEWER, 'viewer@example.test'],
        [PROJECT_ONLY, 'project@example.test'],
        [OTHER_PROVIDER, 'other@example.test'],
      ]),
    ]);
  });

  it('holds through an e-mail grant', async () => {
    expect(await holders(fixture.a)).toContain(EMAIL_HOLDER);
  });

  it('holds through a group grant matching a membership', async () => {
    expect(await holders(fixture.a)).toContain(GROUP_HOLDER);
  });

  it('does not hold for a suspended user, an unprotected role, a project grant or a group of another provider', async () => {
    expect(await holders(fixture.a)).toEqual([EMAIL_HOLDER, GROUP_HOLDER, BOTH]);
  });

  it('does not count a grant of another organization', async () => {
    expect(await holders(fixture.b)).toEqual([]);
  });

  it('stops counting an excluded e-mail grant but keeps users with another path', async () => {
    expect(await holders(fixture.a, { grantId: G_EMAIL })).toEqual([GROUP_HOLDER, BOTH]);
    expect(await holders(fixture.a, { grantId: G_BOTH_EMAIL })).toEqual([
      EMAIL_HOLDER,
      GROUP_HOLDER,
      BOTH,
    ]);
  });

  it('stops counting an excluded group grant', async () => {
    expect(await holders(fixture.a, { grantId: G_GROUP })).toEqual([EMAIL_HOLDER, BOTH]);
  });

  it('excludes one user', async () => {
    expect(await holders(fixture.a, { userId: EMAIL_HOLDER })).toEqual([GROUP_HOLDER, BOTH]);
    expect(await holders(fixture.a, { userId: BOTH })).toEqual([EMAIL_HOLDER, GROUP_HOLDER]);
  });

  it('applies both exclusions together', async () => {
    expect(await holders(fixture.a, { grantId: G_GROUP, userId: EMAIL_HOLDER })).toEqual([BOTH]);
  });

  it('answers whether another holder remains after removing a grant', async () => {
    const remaining = async (grantId: string): Promise<boolean> => {
      const rows = await fixture.database.executor.all<{ id: string }>(
        compile(
          db
            .selectFrom('user_account as u')
            .select('u.id')
            .where('u.org_id', '=', fixture.a.orgId)
            .where((eb) => protectedHolder(fixture.a, eb.ref('u.id'), holderInput({ grantId })))
            .limit(1),
        ),
      );
      return rows.length === 1;
    };

    expect(await remaining(G_EMAIL)).toBe(true);
    await fixture.database.executor.batch([
      insert('DELETE FROM access_grant WHERE id IN (?, ?)', G_GROUP, G_BOTH_EMAIL),
    ]);
    expect(await remaining(G_EMAIL)).toBe(false);
    expect(await remaining(G_PROJECT)).toBe(true);
  });

  it('compiles to a union of three branches without an OR', () => {
    const statement = compile(
      db
        .selectFrom('user_account as u')
        .select('u.id')
        .where((eb) =>
          protectedHolder(
            fixture.a,
            eb.ref('u.id'),
            holderInput({ grantId: G_EMAIL, userId: BOTH }),
          ),
        ),
    );

    expect(statement.sql).toMatch(/union all/i);
    expect(statement.sql).not.toMatch(/\bor\b/i);
    expect(statement.sql.match(/union all/gi)).toHaveLength(2);
  });
});

describe('protectedHolder at spike scale', () => {
  const USERS = 1000;
  const MEMBERSHIPS = 1200;
  const PROVIDERS = ['oidc', 'access'] as const;
  const GROUPS_PER_PROVIDER = 30;
  const ROLE_ADMIN = '01J0ROLEADMIN00000000000AA';
  const ROLE_VIEW = '01J0ROLEVIEW000000000000AA';
  const ROLE_PROJECT = '01J0ROLEPROJECT0000000000AA';
  const PROJECT_ID = '01J0PROJECT00000000000000AA';

  interface World {
    readonly statements: Statement[];
    readonly emailOf: ReadonlyMap<string, string>;
    readonly activeUsers: ReadonlySet<string>;
    readonly groupsOf: ReadonlyMap<string, ReadonlySet<string>>;
    readonly grants: readonly {
      readonly id: string;
      readonly type: 'email' | 'group';
      readonly value: string;
      readonly provider: string | null;
      readonly protectedRole: boolean;
      readonly organizationScope: boolean;
    }[];
    readonly memberships: number;
  }

  function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pad = (prefix: string, n: number): string => `${prefix}${String(n).padStart(8, '0')}`;

  function buildWorld(org: OrgContext): World {
    const random = prng(20261015);
    const pick = (n: number): number => Math.floor(random() * n);
    const statements: Statement[] = [
      role(org, ROLE_ADMIN, 'organization_admin', 'organization', 1),
      role(org, ROLE_VIEW, 'viewer', 'organization', 0),
      role(org, ROLE_PROJECT, 'project_admin', 'project', 1),
      project(org, PROJECT_ID, 'alpha'),
      ...holderBindings(org),
    ];
    const emailOf = new Map<string, string>();
    const activeUsers = new Set<string>();
    for (let i = 0; i < USERS; i += 1) {
      const id = pad('USER', i);
      const email = `user${i}@example.test`;
      const suspended = i % 10 === 3;
      emailOf.set(id, email);
      if (!suspended) activeUsers.add(id);
      statements.push(user(org, id, email, suspended ? 'suspended' : 'active'));
      statements.push(...holderIdentities(org, [[id, email]]));
    }

    const groupsOf = new Map<string, Set<string>>();
    const seen = new Set<string>();
    while (seen.size < MEMBERSHIPS) {
      const userId = pad('USER', pick(USERS));
      const provider = PROVIDERS[pick(PROVIDERS.length)] ?? 'oidc';
      const group = `group-${pick(GROUPS_PER_PROVIDER)}`;
      const key = `${userId}|${provider}|${group}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const set = groupsOf.get(userId) ?? new Set<string>();
      set.add(`${provider}|${group}`);
      groupsOf.set(userId, set);
      statements.push(membership(org, userId, provider, group));
    }

    const grants: World['grants'][number][] = [];
    let counter = 0;
    const nextId = (): string => pad('GRANT', (counter += 1));
    const roleFor = (): { id: string; protectedRole: boolean } =>
      random() < 0.3
        ? { id: ROLE_ADMIN, protectedRole: true }
        : { id: ROLE_VIEW, protectedRole: false };

    for (let i = 0; i < 300; i += 1) {
      const id = nextId();
      const value = i < 270 ? `user${i * 3}@example.test` : `outsider${i}@example.test`;
      const chosen = roleFor();
      grants.push({
        id,
        type: 'email',
        value,
        provider: null,
        protectedRole: chosen.protectedRole,
        organizationScope: true,
      });
      statements.push(emailGrant(org, id, value, chosen.id));
    }
    for (const provider of PROVIDERS) {
      for (let g = 0; g < GROUPS_PER_PROVIDER - 3; g += 1) {
        const id = nextId();
        const chosen = roleFor();
        grants.push({
          id,
          type: 'group',
          value: `group-${g}`,
          provider,
          protectedRole: chosen.protectedRole,
          organizationScope: true,
        });
        statements.push(groupGrant(org, id, provider, `group-${g}`, chosen.id));
      }
    }
    for (let i = 0; i < 200; i += 1) {
      const id = nextId();
      const value = `user${i * 5}@example.test`;
      grants.push({
        id,
        type: 'email',
        value,
        provider: null,
        protectedRole: true,
        organizationScope: false,
      });
      statements.push(emailGrant(org, id, value, ROLE_PROJECT, PROJECT_ID));
    }
    for (const provider of PROVIDERS) {
      for (let g = 0; g < GROUPS_PER_PROVIDER; g += 1) {
        const id = nextId();
        grants.push({
          id,
          type: 'group',
          value: `group-${g}`,
          provider,
          protectedRole: true,
          organizationScope: false,
        });
        statements.push(groupGrant(org, id, provider, `group-${g}`, ROLE_PROJECT, PROJECT_ID));
      }
    }

    return { statements, emailOf, activeUsers, groupsOf, grants, memberships: seen.size };
  }

  function groundTruth(
    world: World,
    exclude?: { readonly grantId?: string; readonly userId?: string },
  ): string[] {
    const relevant = world.grants.filter(
      (grant) => grant.organizationScope && grant.protectedRole && grant.id !== exclude?.grantId,
    );
    const ids: string[] = [];
    for (const [userId, email] of world.emailOf) {
      if (!world.activeUsers.has(userId) || userId === exclude?.userId) continue;
      const groups = world.groupsOf.get(userId) ?? new Set<string>();
      const holder = relevant.some((grant) =>
        grant.type === 'email'
          ? grant.value === email
          : groups.has(`${grant.provider ?? ''}|${grant.value}`),
      );
      if (holder) ids.push(userId);
    }
    return ids.sort();
  }

  async function compareAll(world: World): Promise<void> {
    const protectedGrants = world.grants.filter(
      (grant) => grant.organizationScope && grant.protectedRole,
    );
    const exclusions: { grantId?: string; userId?: string }[] = [{}];
    for (let i = 0; i < protectedGrants.length; i += 7) {
      const grant = protectedGrants[i];
      if (grant !== undefined) exclusions.push({ grantId: grant.id });
    }
    const truth = groundTruth(world);
    for (let i = 0; i < truth.length; i += 23) {
      const userId = truth[i];
      if (userId !== undefined) exclusions.push({ userId });
    }
    exclusions.push({ grantId: protectedGrants[0]?.id ?? '', userId: truth[0] ?? '' });

    for (const exclude of exclusions) {
      expect(await holders(fixture.a, exclude)).toEqual(groundTruth(world, exclude));
    }
  }

  it('matches a JavaScript ground truth before and after ANALYZE', async () => {
    const world = buildWorld(fixture.a);
    await seed(world.statements);

    expect(world.memberships).toBeGreaterThanOrEqual(1000);
    expect(world.grants.length).toBeGreaterThanOrEqual(600);
    const truth = groundTruth(world);
    expect(truth.length).toBeGreaterThan(100);
    expect(truth.length).toBeLessThan(world.activeUsers.size);

    await compareAll(world);
    await fixture.database.analyze();
    await compareAll(world);
  }, 60_000);
});

describe('correlation with the calling query', () => {
  const U1 = '01J0USER000000000000000001';
  const U2 = '01J0USER000000000000000002';
  const ATTACKER = '01J0USER000000000000000003';

  beforeEach(async () => {
    await seed([
      ...rolesAndProject(fixture.a),
      user(fixture.a, U1, 'u1@example.test'),
      user(fixture.a, U2, 'u2@example.test'),
      user(fixture.a, ATTACKER, 'attacker@example.test'),
      membership(fixture.a, U1, 'oidc', 'admins'),
      membership(fixture.a, U2, 'oidc', 'readers'),
      groupGrant(fixture.a, '01J0GRANT000000000000000A1', 'oidc', 'admins', ADMIN_ROLE),
      groupGrant(fixture.a, '01J0GRANT000000000000000A2', 'oidc', 'readers', VIEW_ROLE),
      identity(fixture.a, '01J0IDENT000000000000000A1', U1, 'oidc', 'sub-1', 'u1@example.test'),
      identity(fixture.a, '01J0IDENT000000000000000A2', U2, 'oidc', 'sub-2', 'u2@example.test'),
      insert('INSERT INTO local_login (user_id, org_id) VALUES (?, ?)', ATTACKER, fixture.a.orgId),
      ...holderBindings(fixture.a),
    ]);
  });

  it('refuses an unqualified column reference as the user id', () => {
    const query = (): unknown =>
      db
        .selectFrom('local_login')
        .select('local_login.user_id')
        .where((eb) =>
          ownsIdentity(fixture.a, {
            provider: 'oidc',
            subject: 'sub-1',
            userId: eb.ref('user_id'),
          }),
        );

    expect(query).toThrow(TypeError);
    expect(() => adminEligibility(fixture.a, sql.ref<string>('user_id'))).toThrow(TypeError);
    expect(() => protectedHolder(fixture.a, sql.ref<string>('user_id'), holderInput())).toThrow(
      TypeError,
    );
  });

  it('refuses an expression that is not a column reference', () => {
    expect(() => adminEligibility(fixture.a, sql<string>`'x'`)).toThrow(TypeError);
    expect(() => protectedHolder(fixture.a, sql<string>`'x'`, holderInput())).toThrow(TypeError);
  });

  it('answers per outer row for a qualified column of a table the guard also reads', async () => {
    const rows = await fixture.database.executor.all<{ user_id: string }>(
      compile(
        db
          .selectFrom('identity')
          .select('identity.user_id')
          .where((eb) =>
            ownsIdentity(fixture.a, {
              provider: 'oidc',
              subject: 'sub-1',
              userId: eb.ref('identity.user_id'),
            }),
          ),
      ),
    );

    expect(rows).toEqual([{ user_id: U1 }]);
  });

  it('marks only the member of the protected group when the outer query reads user_group', async () => {
    const rows = await fixture.database.executor.all<{ user_id: string }>(
      compile(
        db
          .selectFrom('user_group')
          .select('user_group.user_id')
          .where((eb) => protectedHolder(fixture.a, eb.ref('user_group.user_id'), holderInput())),
      ),
    );

    expect(rows).toEqual([{ user_id: U1 }]);
  });

  it('answers per outer row for a qualified user_account column', async () => {
    const rows = await fixture.database.executor.all<{ id: string }>(
      compile(
        db
          .selectFrom('user_account')
          .select('user_account.id')
          .where((eb) => protectedHolder(fixture.a, eb.ref('user_account.id'), holderInput())),
      ),
    );

    expect(rows).toEqual([{ id: U1 }]);
  });

  const casings: readonly [string, (name: string) => string][] = [
    ['lower', (name) => name],
    ['upper', (name) => name.toUpperCase()],
    [
      'mixed',
      (name) =>
        name.replace(/(^|_)([a-z])/g, (_, lead: string, c: string) => lead + c.toUpperCase()),
    ],
  ];

  for (const [label, casing] of casings) {
    it(`is not captured by an outer alias equal to the identity guard alias (${label} case)`, async () => {
      const alias = casing('guard_identity');
      const rows = await fixture.database.executor.all<{ id: string }>(
        compile(
          db
            .selectFrom(`identity as ${alias}` as 'identity')
            .select(`${alias}.id` as 'identity.id')
            .where((eb) =>
              ownsIdentity(fixture.a, {
                provider: 'oidc',
                subject: 'sub-1',
                userId: eb.ref(`${alias}.user_id` as 'identity.user_id'),
              }),
            ),
        ),
      );

      expect(rows).toEqual([{ id: '01J0IDENT000000000000000A1' }]);
    });

    for (const name of ['user', 'grant', 'role', 'member']) {
      it(`is not captured by an outer alias equal to the ${name} guard alias (${label} case)`, async () => {
        const alias = casing(`guard_${name}`);
        const rows = await fixture.database.executor.all<{ id: string }>(
          compile(
            db
              .selectFrom(`user_account as ${alias}` as 'user_account')
              .select(`${alias}.id` as 'user_account.id')
              .where((eb) =>
                protectedHolder(
                  fixture.a,
                  eb.ref(`${alias}.id` as 'user_account.id'),
                  holderInput(),
                ),
              ),
          ),
        );

        expect(rows).toEqual([{ id: U1 }]);
      });
    }

    it(`is not captured by an outer user_group alias equal to the member guard alias (${label} case)`, async () => {
      const alias = casing('guard_member');
      const rows = await fixture.database.executor.all<{ user_id: string }>(
        compile(
          db
            .selectFrom(`user_group as ${alias}` as 'user_group')
            .select(`${alias}.user_id` as 'user_group.user_id')
            .where((eb) =>
              protectedHolder(
                fixture.a,
                eb.ref(`${alias}.user_id` as 'user_group.user_id'),
                holderInput(),
              ),
            ),
        ),
      );

      expect(rows).toEqual([{ user_id: U1 }]);
    });
  }

  it('compiles identical calls to byte-identical SQL', () => {
    const compileAll = (): string[] => {
      const guards = [
        opGuard(fixture.a, 'local_login', { userId: U1 }, 'op-1'),
        ownsIdentity(fixture.a, { provider: 'oidc', subject: 'sub-1', userId: U1 }),
        anchorMatches(fixture.a, 'oidc', 'anchor'),
        adminEligibility(fixture.a, U1),
      ];
      const sqls = guards.map(
        (guard) => compile(db.selectFrom('organization').select('id').where(guard)).sql,
      );
      sqls.push(
        compile(
          db
            .selectFrom('user_account as x')
            .select('x.id')
            .where((eb) =>
              protectedHolder(
                fixture.a,
                eb.ref('x.id'),
                holderInput({ grantId: 'g', userId: 'u' }),
              ),
            ),
        ).sql,
        compile(
          db
            .selectFrom('user_account as GUARD_USER')
            .select('GUARD_USER.id')
            .where((eb) => protectedHolder(fixture.a, eb.ref('GUARD_USER.id'), holderInput())),
        ).sql,
      );
      return sqls;
    };

    expect(compileAll()).toEqual(compileAll());
  });

  it('keeps the default alias names when nothing collides and suffixes them on a collision', () => {
    const plain = compile(
      db
        .selectFrom('user_account as x')
        .select('x.id')
        .where((eb) => protectedHolder(fixture.a, eb.ref('x.id'), holderInput())),
    ).sql;
    const collided = compile(
      db
        .selectFrom('user_account as Guard_User')
        .select('Guard_User.id')
        .where((eb) => protectedHolder(fixture.a, eb.ref('Guard_User.id'), holderInput())),
    ).sql;

    expect(plain).toContain('guard_user');
    expect(plain).not.toMatch(/guard_\w+_2/);
    expect(collided).toContain('guard_user_2');
  });

  it('runs every guard through EXPLAIN against the migrated schema', async () => {
    const outerAliases = ['x', 'guard_user', 'GUARD_GRANT', 'Guard_Role', 'guard_member'];
    const statements: Statement[] = [
      compile(
        db
          .selectFrom('organization')
          .select('id')
          .where(opGuard(fixture.a, 'local_login', { userId: U1 }, 'op-1')),
      ),
      compile(
        db
          .selectFrom('organization')
          .select('id')
          .where(ownsIdentity(fixture.a, { provider: 'oidc', subject: 'sub-1', userId: U1 })),
      ),
      compile(
        db
          .selectFrom('organization')
          .select('id')
          .where(anchorMatches(fixture.a, 'oidc', 'anchor')),
      ),
      compile(db.selectFrom('organization').select('id').where(adminEligibility(fixture.a, U1))),
    ];
    for (const alias of [...outerAliases, 'guard_identity', 'GUARD_IDENTITY', 'guard_user_2']) {
      const ref = `${alias}.id` as 'user_account.id';
      const from = `user_account as ${alias}` as 'user_account';
      statements.push(
        compile(
          db
            .selectFrom(from)
            .select(ref)
            .where((eb) => adminEligibility(fixture.a, eb.ref(ref))),
        ),
        compile(
          db
            .selectFrom(from)
            .select(ref)
            .where((eb) =>
              protectedHolder(fixture.a, eb.ref(ref), holderInput({ grantId: 'g', userId: 'u' })),
            ),
        ),
        compile(
          db
            .selectFrom(from)
            .select(ref)
            .where((eb) =>
              ownsIdentity(fixture.a, { provider: 'oidc', subject: 's', userId: eb.ref(ref) }),
            ),
        ),
      );
    }

    for (const statement of statements) {
      const plan = await fixture.database.executor.all({
        sql: `EXPLAIN ${statement.sql}`,
        params: statement.params,
      });
      expect(plan.length).toBeGreaterThan(0);
    }
  });
});

describe('organization predicates', () => {
  const A_USER = '01J0USER000000000000000001';
  const B_USER = '01J0USER000000000000000002';
  const A_OTHER = '01J0USER000000000000000003';
  const B_ADMIN = '01J0ROLEADMIN00000000000BB';
  const A_ADMIN = '01J0ROLEADMIN00000000000AA';

  beforeEach(async () => {
    await seed([
      role(fixture.a, A_ADMIN, 'organization_admin', 'organization', 1),
      role(fixture.b, B_ADMIN, 'organization_admin', 'organization', 1),
    ]);
  });

  it('ignores an organization-b e-mail grant for an organization-a e-mail', async () => {
    await seed([
      user(fixture.a, A_USER, 'shared@example.test'),
      emailGrant(fixture.b, '01J0GRANT000000000000000B1', 'shared@example.test', B_ADMIN),
    ]);

    expect(await holders(fixture.a)).toEqual([]);
    expect(await holds(adminEligibility(fixture.a, A_USER))).toBe(false);
  });

  it('ignores an organization-b group grant matching an organization-a membership', async () => {
    await seed([
      user(fixture.a, A_USER, 'member@example.test'),
      membership(fixture.a, A_USER, 'oidc', 'admins'),
      groupGrant(fixture.b, '01J0GRANT000000000000000B1', 'oidc', 'admins', B_ADMIN),
    ]);

    expect(await holders(fixture.a)).toEqual([]);
  });

  it('ignores a role of another organization referenced by an e-mail grant', async () => {
    await seed([
      user(fixture.a, A_USER, 'member@example.test'),
      emailGrant(fixture.a, '01J0GRANT000000000000000A1', 'member@example.test', B_ADMIN),
    ]);

    expect(await holders(fixture.a)).toEqual([]);
    expect(await holds(adminEligibility(fixture.a, A_USER))).toBe(false);
  });

  it('ignores a role of another organization referenced by a group grant', async () => {
    await seed([
      user(fixture.a, A_USER, 'member@example.test'),
      membership(fixture.a, A_USER, 'oidc', 'admins'),
      groupGrant(fixture.a, '01J0GRANT000000000000000A1', 'oidc', 'admins', B_ADMIN),
    ]);

    expect(await holders(fixture.a)).toEqual([]);
  });

  it('does not answer for a user of another organization', async () => {
    await seed([
      user(fixture.b, B_USER, 'admin@example.test'),
      emailGrant(fixture.b, '01J0GRANT000000000000000B1', 'admin@example.test', B_ADMIN),
      membership(fixture.b, B_USER, 'oidc', 'admins'),
      groupGrant(fixture.b, '01J0GRANT000000000000000B2', 'oidc', 'admins', B_ADMIN),
      ...holderBindings(fixture.b),
      ...holderIdentities(fixture.b, [[B_USER, 'admin@example.test']]),
    ]);

    expect(await holders(fixture.b)).toEqual([B_USER]);
    expect(await holds(adminEligibility(fixture.b, B_USER), fixture.b)).toBe(true);
    expect(await holds(adminEligibility(fixture.a, B_USER))).toBe(false);
    expect(await holders(fixture.a)).toEqual([]);

    const crossOrganization = await fixture.database.executor.all<{ id: string }>(
      compile(
        db
          .selectFrom('user_account as x')
          .select('x.id')
          .where('x.id', '=', B_USER)
          .where((eb) => protectedHolder(fixture.a, eb.ref('x.id'), holderInput())),
      ),
    );
    expect(crossOrganization).toEqual([]);
  });

  it('does not count a user of another organization reached through a membership row', async () => {
    await seed([
      user(fixture.b, B_USER, 'admin@example.test'),
      membership(fixture.a, B_USER, 'oidc', 'admins'),
      groupGrant(fixture.a, '01J0GRANT000000000000000A1', 'oidc', 'admins', A_ADMIN),
    ]);

    const rows = await fixture.database.executor.all<{ id: string }>(
      compile(
        db
          .selectFrom('user_account as x')
          .select('x.id')
          .where('x.id', '=', B_USER)
          .where((eb) => protectedHolder(fixture.a, eb.ref('x.id'), holderInput())),
      ),
    );
    expect(rows).toEqual([]);
  });

  it('does not count a membership row of another organization', async () => {
    await seed([
      user(fixture.a, A_USER, 'member@example.test'),
      insert(
        'INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, ?, ?)',
        fixture.b.orgId,
        A_USER,
        'oidc',
        'admins',
      ),
      groupGrant(fixture.b, '01J0GRANT000000000000000B1', 'oidc', 'admins', B_ADMIN),
      user(fixture.a, A_OTHER, 'other@example.test'),
    ]);

    const rows = await fixture.database.executor.all<{ id: string }>(
      compile(
        db
          .selectFrom('user_account as x')
          .select('x.id')
          .where('x.id', '=', A_USER)
          .where((eb) => protectedHolder(fixture.a, eb.ref('x.id'), holderInput())),
      ),
    );
    expect(rows).toEqual([]);
  });
});
