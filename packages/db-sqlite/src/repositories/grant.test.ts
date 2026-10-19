import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  type AuthenticatedActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import { createAdministration } from '@package-broker/core/authz/administration';
import { DbError } from '@package-broker/core/db/errors';
import type { GrantRepository } from '@package-broker/core/db/grants';
import { fixedClock } from '@package-broker/core/ids';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { compile, db, protectedHolder } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createRoleRepository } from './role.js';
import { createUnlinkRepository } from './unlink.js';
import {
  createGrantRepository as createFencedGrantRepository,
  type GrantRepositoryOptions,
  type ProtectedHolderInput,
} from './grant.js';

const apiCall = {
  audit: {
    opId: '01K00000000000000000000001',
    requestId: '01K00000000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};

const NOW = '2026-10-15T12:00:00.000Z';
const LATER = '2026-10-15T13:00:00.000Z';

const ADMIN = '01J0ROLEADMIN00000000000AA';
const ADMIN_TWO = '01J0ROLEADMIN00000000000AB';
const AUDITOR = '01J0ROLEAUDITOR000000000AA';
const PROJECT_ROLE = '01J0ROLEPROJECT0000000000AA';
const ADMIN_B = '01J0ROLEADMIN00000000000BB';
const PROJECT = '01J0PROJECT00000000000000AA';

const U1 = '01J0USER000000000000000001';
const U2 = '01J0USER000000000000000002';
const U3 = '01J0USER000000000000000003';
const UB = '01J0USER00000000000000000B';

const G1 = '01J0GRANT000000000000000A1';
const G2 = '01J0GRANT000000000000000A2';
const G3 = '01J0GRANT000000000000000A3';
const GB = '01J0GRANT000000000000000B1';

const ANCHOR = 'https://idp.example.test';
const HOLDER_PROVIDERS = ['oidc', 'access'] as const;

function holderInput(): ProtectedHolderInput {
  return {
    kind: 'fresh',
    now: new Date().toISOString(),
    providers: HOLDER_PROVIDERS.map((provider) => ({
      provider,
      anchor: ANCHOR,
      emailAuthoritative: true,
      emailAuthoritativeDomains: ['example.test', 'actor.test'],
    })),
  };
}

type UnfencedGrants = Pick<GrantRepository, 'listOrganization' | 'countProtectedHolders'> & {
  suspendUser(
    ctx: OrgContext,
    userId: string,
    now: string,
  ): ReturnType<GrantRepository['suspendUser']>;
  reactivateUser(
    ctx: OrgContext,
    userId: string,
    now: string,
  ): ReturnType<GrantRepository['reactivateUser']>;
  createOrganization(
    ctx: OrgContext,
    input: Omit<Parameters<GrantRepository['createOrganization']>[2], 'opId'>,
  ): ReturnType<GrantRepository['createOrganization']>;
  deleteOrganization(ctx: OrgContext, id: string): Promise<string>;
  revoke(ctx: OrgContext, id: string): ReturnType<GrantRepository['deleteOrganization']>;
  changeRole(
    ctx: OrgContext,
    id: string,
    roleId: string,
    now: string,
  ): ReturnType<GrantRepository['changeRole']>;
};

const ACTOR_PERMISSION = 'org:grants:write';
let storage: SqlExecutor;
let operations = 0;

function actorOf(org: OrgContext) {
  const tag = org.orgId.slice(-8);
  return {
    user: `01J0ACTORUSER${tag}`,
    identity: `01J0ACTORIDEN${tag}`,
    role: `01J0ACTORROLE${tag}`,
    grant: `01J0ACTORGRNT${tag}`,
    session: `01J0ACTORSESS${tag}`,
  };
}

function actorStatements(org: OrgContext): Statement[] {
  const ids = actorOf(org);
  const now = new Date().toISOString();
  const hash = Buffer.from(ids.session).toString('hex').padEnd(64, '0');
  return [
    stmt(
      'INSERT OR IGNORE INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      ids.user,
      org.orgId,
      'actor@actor.test',
    ),
    stmt(
      'INSERT OR IGNORE INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      ids.identity,
      org.orgId,
      ids.user,
      'oidc',
      `subject-${ids.user}`,
      'actor@actor.test',
      now,
    ),
    stmt(
      'INSERT OR IGNORE INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 1)',
      ids.role,
      org.orgId,
      'test_actor',
      'test_actor',
      'organization',
    ),
    stmt(
      'INSERT OR IGNORE INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      org.orgId,
      ids.role,
      ACTOR_PERMISSION,
    ),
    stmt(
      'INSERT OR IGNORE INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      org.orgId,
      ids.role,
      'org:users:write',
    ),
    stmt(
      'INSERT OR IGNORE INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?)',
      ids.grant,
      org.orgId,
      'email',
      'actor@actor.test',
      'organization',
      ids.role,
      NOW,
      NOW,
    ),
    stmt(
      'INSERT OR IGNORE INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ids.session,
      org.orgId,
      ids.user,
      hash,
      hash,
      now,
      new Date(Date.now() + 3_600_000).toISOString(),
    ),
  ];
}

async function revisionOf(id: string): Promise<number> {
  const found = await storage.all<{ revision: number }>(
    stmt('SELECT revision FROM access_grant WHERE id = ?', id),
  );
  return found[0]?.revision ?? 1;
}

async function fenceFor(org: OrgContext, id?: string): Promise<MutationFence> {
  const ids = actorOf(org);
  return mutationFence(
    { userId: ids.user, sessionId: ids.session } as unknown as AuthenticatedActor,
    id === undefined ? {} : { grant: await revisionOf(id) },
  );
}

function outcomeOf(result: Awaited<ReturnType<GrantRepository['deleteOrganization']>>): string {
  return typeof result === 'string' ? result : result.outcome;
}

function nextOp(): string {
  operations += 1;
  return `OP${String(operations).padStart(24, '0')}`;
}

/** Keeps the pre-fence call shapes: a seeded organization admin acts, and its own evidence is not counted as a holder. */
function createGrantRepository(
  target: Parameters<typeof createFencedGrantRepository>[0],
  options: GrantRepositoryOptions,
): UnfencedGrants {
  const fenced = createFencedGrantRepository(target, {
    providerAnchors: options.providerAnchors,
    holderInput: async (ctx) => ({
      ...(await options.holderInput(ctx)),
      exclude: { identityId: actorOf(ctx).identity },
    }),
  });
  return {
    listOrganization: async (ctx) =>
      (await fenced.listOrganization(ctx)).filter((grant) => grant.id !== actorOf(ctx).grant),
    suspendUser: async (ctx, userId, now) =>
      fenced.suspendUser(ctx, await fenceFor(ctx), { userId: userId, now: now }),
    reactivateUser: async (ctx, userId, now) =>
      fenced.reactivateUser(ctx, await fenceFor(ctx), { userId: userId, now: now }),
    countProtectedHolders: (ctx) => fenced.countProtectedHolders(ctx),
    createOrganization: async (ctx, input) =>
      fenced.createOrganization(ctx, await fenceFor(ctx), { ...input, opId: nextOp() }),
    deleteOrganization: async (ctx, id) => {
      return outcomeOf(
        await fenced.deleteOrganization(ctx, await fenceFor(ctx, id), { id: id, opId: nextOp() }),
      );
    },
    revoke: async (ctx, id) =>
      fenced.deleteOrganization(ctx, await fenceFor(ctx, id), { id: id, opId: nextOp() }),
    changeRole: async (ctx, id, roleId, now) =>
      fenced.changeRole(ctx, await fenceFor(ctx, id), {
        id: id,
        roleId: roleId,
        now: now,
        opId: nextOp(),
      }),
  };
}

function bindings(org: OrgContext): Statement[] {
  return HOLDER_PROVIDERS.map((provider) =>
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      org.orgId,
      provider,
      ANCHOR,
    ),
  );
}

function identities(
  org: OrgContext,
  users: readonly (readonly [string, string])[],
  providers: readonly string[] = HOLDER_PROVIDERS,
): Statement[] {
  return users.flatMap(([userId, email]) =>
    providers.map((provider) =>
      stmt(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        `ID-${provider}-${userId}`,
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

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let grants: UnfencedGrants;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function user(org: OrgContext, id: string, email: string, status = 'active'): Statement {
  return stmt(
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
  return stmt(
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
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)',
    id,
    org.orgId,
    'email',
    email,
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
    NOW,
    NOW,
  );
}

function groupGrant(
  org: OrgContext,
  id: string,
  provider: string,
  group: string,
  roleId: string,
): Statement {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
    id,
    org.orgId,
    'group',
    group,
    provider,
    'organization',
    roleId,
    NOW,
    NOW,
  );
}

function membership(org: OrgContext, userId: string, provider: string, group: string): Statement {
  return stmt(
    'INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, ?, ?)',
    org.orgId,
    userId,
    provider,
    group,
  );
}

function session(org: OrgContext, id: string, userId: string): Statement {
  const hash = id
    .toLowerCase()
    .replace(/[^0-9a-f]/g, 'a')
    .padEnd(64, '0')
    .slice(0, 64);
  return stmt(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    userId,
    hash,
    hash,
    NOW,
    '2026-10-16T12:00:00.000Z',
  );
}

function rolesFor(org: OrgContext, admin: string, extra: boolean): Statement[] {
  const rows = [role(org, admin, 'organization_admin', 'organization', 1)];
  if (extra) {
    rows.push(
      role(org, AUDITOR, 'org_auditor', 'organization', 0),
      role(org, PROJECT_ROLE, 'project_admin', 'project', 1),
      role(org, ADMIN_TWO, 'org_owner', 'organization', 1),
      stmt(
        'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
        PROJECT,
        org.orgId,
        'alpha',
        'alpha',
      ),
    );
  }
  return rows;
}

async function seed(statements: readonly Statement[]): Promise<void> {
  await executor.batch(statements);
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  grants = createGrantRepository(executor, {
    providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
      provider,
      anchor: ANCHOR,
      emailAuthoritative: true,
      emailAuthoritativeDomains: ['example.test', 'actor.test'],
    })),
    holderInput,
  });
  storage = executor;
  await seed([
    ...rolesFor(a, ADMIN, true),
    ...rolesFor(b, ADMIN_B, false),
    user(a, U1, 'u1@example.test'),
    user(a, U2, 'u2@example.test'),
    user(a, U3, 'u3@example.test'),
    user(b, UB, 'b@example.test'),
    ...bindings(a),
    ...bindings(b),
    ...identities(b, [[UB, 'b@example.test']]),
    ...identities(a, [
      [U1, 'u1@example.test'],
      [U2, 'u2@example.test'],
      [U3, 'u3@example.test'],
    ]),
    ...actorStatements(a),
    ...actorStatements(b),
  ]);
});

afterEach(async () => {
  await database.close();
});

async function rows(sql: string, ...params: Statement['params']): Promise<unknown[]> {
  return executor.all(stmt(sql, ...params));
}

async function snapshot(): Promise<string> {
  return JSON.stringify([
    await rows('SELECT * FROM access_grant ORDER BY id'),
    await rows('SELECT id, status, updated_at FROM user_account ORDER BY id'),
    await rows("SELECT id, revoked_at FROM session WHERE id NOT LIKE '01J0ACTOR%' ORDER BY id"),
  ]);
}

async function statusOf(userId: string): Promise<string | undefined> {
  const found = await executor.all<{ status: string }>(
    stmt('SELECT status FROM user_account WHERE id = ?', userId),
  );
  return found[0]?.status;
}

async function padWithUnrelatedRows(): Promise<void> {
  const statements: Statement[] = [];
  for (let i = 0; i < 300; i += 1) {
    const id = `01J0PAD${String(i).padStart(19, '0')}`;
    statements.push(user(a, id, `pad${i}@example.test`));
    statements.push(
      emailGrant(a, `01J0PADGRANT${String(i).padStart(14, '0')}`, `pad${i}@example.test`, AUDITOR),
    );
    statements.push(membership(a, id, 'oidc', `pad-group-${i % 20}`));
  }
  for (let g = 0; g < 20; g += 1) {
    statements.push(
      groupGrant(
        a,
        `01J0PADGROUP${String(g).padStart(14, '0')}`,
        'oidc',
        `pad-group-${g}`,
        AUDITOR,
      ),
    );
  }
  statements.push(
    groupGrant(a, '01J0PADBIGGROUP00000000000', 'oidc', 'pad-protected', ADMIN),
    groupGrant(a, '01J0PADBIGGROUP00000000001', 'oidc', 'pad-protected-live', ADMIN_TWO),
  );
  for (let i = 0; i < 300; i += 1) {
    const id = `01J0PADSUSP${String(i).padStart(15, '0')}`;
    statements.push(user(a, id, `susp${i}@example.test`, 'suspended'));
    statements.push(membership(a, id, 'oidc', 'pad-protected'));
  }
  statements.push(
    groupGrant(b, '01J0PADBIGGROUP00000000002', 'oidc', 'admins', ADMIN_B),
    groupGrant(b, '01J0PADBIGGROUP00000000003', 'oidc', 'pad-protected-live', ADMIN_B),
  );
  for (let i = 0; i < 300; i += 1) {
    const id = `01J0PADOTHER${String(i).padStart(14, '0')}`;
    statements.push(user(b, id, `other${i}@example.test`));
    statements.push(membership(b, id, 'oidc', 'admins'));
    statements.push(membership(b, id, 'oidc', 'pad-protected-live'));
  }
  await seed(statements);
}

describe.each([false, true])(
  'last-holder guards, padded with 300 extra rows and ANALYZE: %s',
  (padded) => {
    async function prepare(statements: readonly Statement[]): Promise<void> {
      await seed(statements);
      if (padded) {
        await padWithUnrelatedRows();
        await database.analyze();
      }
    }

    it('1: the only admin, through an e-mail grant, cannot be deleted, demoted or suspended', async () => {
      await prepare([
        emailGrant(a, G1, 'u1@example.test', ADMIN),
        session(a, '01J0SESSION0000000000000001', U1),
      ]);
      const before = await snapshot();

      expect(await grants.deleteOrganization(a, G1)).toBe('last_holder');
      expect(await grants.changeRole(a, G1, AUDITOR, LATER)).toBe('last_holder');
      expect(await grants.suspendUser(a, U1, LATER)).toBe('last_holder');
      expect(await snapshot()).toBe(before);
      expect(await grants.countProtectedHolders(a)).toBe(1);
    });

    it('2: an e-mail admin and a group-only admin: the e-mail grant goes, then the group grant is protected', async () => {
      await prepare([
        emailGrant(a, G1, 'u1@example.test', ADMIN),
        groupGrant(a, G2, 'oidc', 'admins', ADMIN),
        membership(a, U2, 'oidc', 'admins'),
      ]);
      expect(await grants.countProtectedHolders(a)).toBe(2);

      expect(await grants.deleteOrganization(a, G1)).toBe('deleted');
      expect(await grants.countProtectedHolders(a)).toBe(1);
      expect(await grants.deleteOrganization(a, G2)).toBe('last_holder');
      expect(await grants.changeRole(a, G2, AUDITOR, LATER)).toBe('last_holder');
      expect(await grants.suspendUser(a, U2, LATER)).toBe('last_holder');
      expect(await statusOf(U2)).toBe('active');
      expect(await grants.countProtectedHolders(a)).toBe(1);
    });

    it('2: the group-only admin can be suspended while an e-mail admin remains', async () => {
      await prepare([
        emailGrant(a, G1, 'u1@example.test', ADMIN),
        groupGrant(a, G2, 'oidc', 'admins', ADMIN),
        membership(a, U2, 'oidc', 'admins'),
      ]);
      expect(await grants.suspendUser(a, U2, LATER)).toBe('suspended');
      expect(await grants.countProtectedHolders(a)).toBe(1);
      expect(await grants.suspendUser(a, U1, LATER)).toBe('last_holder');
    });

    it('3: a group grant without members and a suspended user are not holders', async () => {
      await prepare([
        emailGrant(a, G1, 'u1@example.test', ADMIN),
        groupGrant(a, G2, 'oidc', 'empty-group', ADMIN),
        emailGrant(a, G3, 'u3@example.test', ADMIN),
        user(a, '01J0USER000000000000000004', 'u4@example.test', 'suspended'),
        emailGrant(a, '01J0GRANT000000000000000A4', 'u4@example.test', ADMIN),
        membership(a, '01J0USER000000000000000004', 'oidc', 'empty-group'),
      ]);
      expect(await grants.countProtectedHolders(a)).toBe(2);
      expect(await grants.suspendUser(a, U3, LATER)).toBe('suspended');
      expect(await grants.countProtectedHolders(a)).toBe(1);
      expect(await grants.deleteOrganization(a, G1)).toBe('last_holder');
      expect(await grants.suspendUser(a, U1, LATER)).toBe('last_holder');
    });

    it('3: a group grant of the wrong provider or an unprotected role does not count', async () => {
      await prepare([
        groupGrant(a, G1, 'access', 'admins', ADMIN),
        membership(a, U1, 'oidc', 'admins'),
        groupGrant(a, G2, 'oidc', 'readers', AUDITOR),
        membership(a, U2, 'oidc', 'readers'),
        emailGrant(a, G3, 'u3@example.test', AUDITOR),
      ]);
      expect(await grants.countProtectedHolders(a)).toBe(0);
    });
  },
);

describe('listOrganization', () => {
  it('lists organization grants oldest first with subject, role and creator', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      groupGrant(a, G2, 'oidc', 'admins', AUDITOR),
      emailGrant(a, G3, 'u3@example.test', PROJECT_ROLE, PROJECT),
      emailGrant(b, GB, 'b@example.test', ADMIN_B),
    ]);
    await executor.all(
      stmt("UPDATE access_grant SET created_at = '2026-10-15T11:00:00.000Z' WHERE id = ?", G2),
    );
    await executor.all(stmt('UPDATE access_grant SET created_by = ? WHERE id = ?', U1, G1));

    expect(await grants.listOrganization(a)).toEqual([
      {
        id: G2,
        subject: { type: 'group', provider: 'oidc', value: 'admins' },
        roleId: AUDITOR,
        createdBy: null,
        createdAt: '2026-10-15T11:00:00.000Z',
        revision: 1,
      },
      {
        id: G1,
        subject: { type: 'email', value: 'u1@example.test' },
        roleId: ADMIN,
        createdBy: U1,
        createdAt: NOW,
        revision: 1,
      },
    ]);
    expect(await grants.listOrganization(b)).toHaveLength(1);
  });

  it('throws on a stored subject it cannot represent', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    await executor.all(stmt('PRAGMA ignore_check_constraints = 1'));
    try {
      await executor.all(
        stmt(
          "UPDATE access_grant SET subject_type = 'group', subject_provider = NULL WHERE id = ?",
          G1,
        ),
      );
      await expect(grants.listOrganization(a)).rejects.toThrow('unexpected subject');
      await executor.all(stmt("UPDATE access_grant SET subject_type = 'token' WHERE id = ?", G1));
      await expect(grants.listOrganization(a)).rejects.toThrow('unexpected subject');
    } finally {
      await executor.all(stmt('PRAGMA ignore_check_constraints = 0'));
    }
  });

  it('is one statement', async () => {
    const counted = countCalls(executor);
    await createGrantRepository(counted.executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    }).listOrganization(a);
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
  });
});

describe('createOrganization', () => {
  const email = (id: string, value: string, roleId = ADMIN) => ({
    id,
    subject: { type: 'email', value } as const,
    roleId,
    createdBy: U1,
    now: NOW,
  });

  it('creates an e-mail grant and a group grant', async () => {
    expect(await grants.createOrganization(a, email(G1, 'new@example.test'))).toBe('created');
    expect(
      await grants.createOrganization(a, {
        id: G2,
        subject: { type: 'group', provider: 'oidc', value: 'Admins' },
        roleId: AUDITOR,
        createdBy: null,
        now: NOW,
      }),
    ).toBe('created');
    expect(await grants.listOrganization(a)).toEqual([
      {
        id: G1,
        subject: { type: 'email', value: 'new@example.test' },
        roleId: ADMIN,
        createdBy: U1,
        createdAt: NOW,
        revision: 1,
      },
      {
        id: G2,
        subject: { type: 'group', provider: 'oidc', value: 'Admins' },
        roleId: AUDITOR,
        createdBy: null,
        createdAt: NOW,
        revision: 1,
      },
    ]);
    const stored = await rows(
      'SELECT scope, project_id, updated_at FROM access_grant WHERE id = ?',
      G1,
    );
    expect(stored).toEqual([{ scope: 'organization', project_id: null, updated_at: NOW }]);
  });

  it('6: a project-scope, missing or foreign role gives role_scope_mismatch and stores nothing', async () => {
    expect(await grants.createOrganization(a, email(G1, 'x@example.test', PROJECT_ROLE))).toBe(
      'role_scope_mismatch',
    );
    expect(
      await grants.createOrganization(a, email(G1, 'x@example.test', '01J0ROLEMISSING000000000AA')),
    ).toBe('role_scope_mismatch');
    expect(await grants.createOrganization(a, email(G1, 'x@example.test', ADMIN_B))).toBe(
      'role_scope_mismatch',
    );
    expect(
      await grants.createOrganization(a, {
        ...email(G1, 'x@example.test'),
        subject: { type: 'group', provider: 'oidc', value: 'g' },
        roleId: PROJECT_ROLE,
      }),
    ).toBe('role_scope_mismatch');
    expect(await rows("SELECT id FROM access_grant WHERE id NOT LIKE '01J0ACTOR%'")).toEqual([]);
  });

  it('6: a second grant for the same subject is a duplicate, in either subject kind', async () => {
    expect(await grants.createOrganization(a, email(G1, 'x@example.test'))).toBe('created');
    expect(await grants.createOrganization(a, email(G2, 'x@example.test', AUDITOR))).toBe(
      'duplicate',
    );
    const group = {
      subject: { type: 'group', provider: 'oidc', value: 'g' } as const,
      roleId: AUDITOR,
      createdBy: null,
      now: NOW,
    };
    expect(await grants.createOrganization(a, { id: G2, ...group })).toBe('created');
    expect(await grants.createOrganization(a, { id: G3, ...group })).toBe('duplicate');
    expect(
      await grants.createOrganization(a, {
        id: G3,
        ...group,
        subject: { type: 'group', provider: 'access', value: 'g' },
      }),
    ).toBe('created');
    expect(await grants.createOrganization(a, email(G1, 'other@example.test'))).toBe('duplicate');
    expect(await grants.listOrganization(a)).toHaveLength(3);
  });

  it('6: a project grant of the same e-mail does not make an organization grant a duplicate', async () => {
    await seed([emailGrant(a, G1, 'x@example.test', PROJECT_ROLE, PROJECT)]);
    expect(await grants.createOrganization(a, email(G2, 'x@example.test'))).toBe('created');
  });

  it('6: organizations are isolated', async () => {
    expect(await grants.createOrganization(a, email(G1, 'x@example.test'))).toBe('created');
    await expect(
      grants.createOrganization(b, email(GB, 'x@example.test', ADMIN_B)),
    ).rejects.toThrow(TypeError);
    expect(
      await grants.createOrganization(b, {
        ...email(GB, 'x@example.test', ADMIN_B),
        createdBy: UB,
      }),
    ).toBe('created');
    expect(await grants.createOrganization(b, email(G2, 'y@example.test', ADMIN))).toBe(
      'role_scope_mismatch',
    );
    expect(await grants.listOrganization(a)).toHaveLength(1);
    expect(await grants.listOrganization(b)).toHaveLength(1);
    expect(await rows('SELECT org_id, role_id FROM access_grant WHERE id = ?', GB)).toEqual([
      { org_id: b.orgId, role_id: ADMIN_B },
    ]);
  });

  it('rejects malformed input before any SQL', async () => {
    const counted = countCalls(executor);
    const repository = createGrantRepository(counted.executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    await expect(repository.createOrganization(a, email(G1, 'Upper@example.test'))).rejects.toThrow(
      TypeError,
    );
    await expect(repository.createOrganization(a, email(G1, ''))).rejects.toThrow(TypeError);
    for (const value of [
      ' x@example.test',
      'x@example.test ',
      'x@@example.test',
      'x@example',
      '@example.test',
      'x y@example.test',
      'ü@example.test',
      'x@exämple.test',
      'x@example.test\n',
      `${'x'.repeat(250)}@example.test`,
    ]) {
      await expect(repository.createOrganization(a, email(G1, value))).rejects.toThrow(TypeError);
    }
    for (const provider of ['', 'OIDC', 'oidc ', 'a_b', '-oidc', 'x'.repeat(65)]) {
      await expect(
        repository.createOrganization(a, {
          ...email(G1, 'x@example.test'),
          subject: { type: 'group', provider, value: 'g' },
        }),
      ).rejects.toThrow(TypeError);
    }
    for (const value of [
      ' g',
      'g ',
      'g\u0000h',
      'g\nh',
      'g\u200bh',
      'g\u202eh',
      '\u00a0',
      'g'.repeat(257),
    ]) {
      await expect(
        repository.createOrganization(a, {
          ...email(G1, 'x@example.test'),
          subject: { type: 'group', provider: 'oidc', value },
        }),
      ).rejects.toThrow(TypeError);
    }
    await expect(
      repository.createOrganization(a, {
        ...email(G1, 'x@example.test'),
        subject: { type: 'group', provider: ' oidc', value: 'g' },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createOrganization(a, {
        ...email(G1, 'x@example.test'),
        subject: { type: 'group', provider: 'oidc', value: '' },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.createOrganization(a, { ...email(G1, 'x@example.test'), now: '2026-10-15' }),
    ).rejects.toThrow(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('accepts a group of 256 code points and a normalized e-mail', async () => {
    const group = '\u{1f600}'.repeat(256);
    expect(
      await grants.createOrganization(a, {
        ...email(G1, 'first.last+tag@sub.example.test'),
        subject: { type: 'group', provider: 'oidc', value: group },
      }),
    ).toBe('created');
    expect(await grants.createOrganization(a, email(G2, 'first.last+tag@sub.example.test'))).toBe(
      'created',
    );
    expect((await grants.listOrganization(a)).map((grant) => grant.subject)).toContainEqual({
      type: 'group',
      provider: 'oidc',
      value: group,
    });
  });

  it('stores createdBy only for a user of the same organization', async () => {
    expect(await grants.createOrganization(a, email(G1, 'x@example.test'))).toBe('created');
    await expect(
      grants.createOrganization(a, { ...email(G2, 'y@example.test'), createdBy: UB }),
    ).rejects.toThrow(TypeError);
    await expect(
      grants.createOrganization(a, {
        ...email(G2, 'y@example.test'),
        createdBy: '01J0USER00000000000000ZZZZ',
      }),
    ).rejects.toThrow(TypeError);
    expect(
      await rows("SELECT id, created_by FROM access_grant WHERE id NOT LIKE '01J0ACTOR%'"),
    ).toEqual([{ id: G1, created_by: U1 }]);
    expect(
      await grants.createOrganization(a, { ...email(G2, 'y@example.test'), createdBy: null }),
    ).toBe('created');
  });

  it('a missing role is reported before a createdBy problem', async () => {
    expect(
      await grants.createOrganization(a, {
        ...email(G1, 'x@example.test', PROJECT_ROLE),
        createdBy: UB,
      }),
    ).toBe('role_scope_mismatch');
  });

  it('is one statement', async () => {
    const counted = countCalls(executor);
    await createGrantRepository(counted.executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    }).createOrganization(a, email(G1, 'x@example.test'));
    expect(counted.counts().all + counted.counts().batch).toBe(1);
  });
});

describe('deleteOrganization', () => {
  it('deletes an unprotected grant even when it is the only grant', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', AUDITOR)]);
    expect(await grants.deleteOrganization(a, G1)).toBe('deleted');
    expect(await grants.listOrganization(a)).toEqual([]);
  });

  it('is not_found for an unknown id, a project grant and another organization', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', PROJECT_ROLE, PROJECT),
      emailGrant(b, GB, 'b@example.test', ADMIN_B),
    ]);
    const before = await snapshot();
    expect(await grants.deleteOrganization(a, '01J0GRANT000000000000000ZZ')).toBe('not_found');
    expect(await grants.deleteOrganization(a, G1)).toBe('not_found');
    expect(await grants.deleteOrganization(a, GB)).toBe('not_found');
    expect(await snapshot()).toBe(before);
  });

  it('leaves a project grant of an unprotected project role alone', async () => {
    await seed([
      role(a, '01J0ROLEVIEWER00000000000AA', 'project_viewer', 'project', 0),
      emailGrant(a, G1, 'u1@example.test', '01J0ROLEVIEWER00000000000AA', PROJECT),
    ]);
    expect(await grants.deleteOrganization(a, G1)).toBe('not_found');
    expect(await rows("SELECT id FROM access_grant WHERE id NOT LIKE '01J0ACTOR%'")).toEqual([
      { id: G1 },
    ]);
  });

  it('a grant that points at a protected role of another organization is not protected', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', ADMIN_B)]);
    expect(await grants.countProtectedHolders(a)).toBe(0);
    expect(await grants.deleteOrganization(a, G1)).toBe('deleted');
  });

  it('a holder of two protected grants loses one without being refused', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      groupGrant(a, G2, 'oidc', 'admins', ADMIN_TWO),
      membership(a, U1, 'oidc', 'admins'),
    ]);
    expect(await grants.countProtectedHolders(a)).toBe(1);
    expect(await grants.deleteOrganization(a, G1)).toBe('deleted');
    expect(await grants.deleteOrganization(a, G2)).toBe('last_holder');
  });

  it('another organization holder does not satisfy the guard', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      emailGrant(b, GB, 'b@example.test', ADMIN_B),
    ]);
    expect(await grants.deleteOrganization(a, G1)).toBe('last_holder');
    expect(await grants.countProtectedHolders(b)).toBe(1);
  });

  it('is one batch', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', AUDITOR)]);
    const counted = countCalls(executor);
    await createGrantRepository(counted.executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    }).deleteOrganization(a, G1);
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
  });
});

describe('deleteOrganization reports the user it offboards', () => {
  const deleted = (offboardedUserId: string | null) => ({ outcome: 'deleted', offboardedUserId });

  it('reports the user of an e-mail grant that was their only organization grant', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', AUDITOR)]);
    expect(await grants.revoke(a, G1)).toEqual(deleted(U1));
  });

  it('reports no one for an e-mail grant without a user account', async () => {
    await seed([emailGrant(a, G1, 'nobody@example.test', AUDITOR)]);
    expect(await grants.revoke(a, G1)).toEqual(deleted(null));
  });

  it('reports no one while a group grant still reaches the user, nor for the group grant itself', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', AUDITOR),
      groupGrant(a, G2, 'oidc', 'auditors', AUDITOR),
      membership(a, U1, 'oidc', 'auditors'),
    ]);
    expect(await grants.revoke(a, G1)).toEqual(deleted(null));
    expect(await grants.revoke(a, G2)).toEqual(deleted(null));
  });

  it('reports no one when the user keeps their e-mail grant and loses a group grant', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', AUDITOR),
      groupGrant(a, G2, 'oidc', 'auditors', AUDITOR),
      membership(a, U1, 'oidc', 'auditors'),
    ]);
    expect(await grants.revoke(a, G2)).toEqual(deleted(null));
  });

  it('a project grant does not keep the organization membership', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', AUDITOR),
      emailGrant(a, G2, 'u1@example.test', PROJECT_ROLE, PROJECT),
    ]);
    expect(await grants.revoke(a, G1)).toEqual(deleted(U1));
  });

  it('another organization with the same e-mail neither reports nor keeps the user', async () => {
    await seed([
      user(b, '01J0USER0000000000000000B2', 'u1@example.test'),
      emailGrant(a, G1, 'u1@example.test', AUDITOR),
      emailGrant(b, GB, 'u1@example.test', ADMIN_B),
    ]);
    expect(await grants.revoke(a, G1)).toEqual(deleted(U1));
  });

  it('a refused revoke reports no user', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    expect(await grants.revoke(a, G1)).toBe('last_holder');
  });

  it('keeps every statement of the batch within the 100 bound-parameter limit', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', AUDITOR)]);
    const statements: Statement[] = [];
    const recording: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: (batch) => {
        statements.push(...batch);
        return executor.batch(batch);
      },
    };
    expect(
      await createFencedGrantRepository(recording, {
        providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
          provider,
          anchor: ANCHOR,
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test', 'actor.test'],
        })),
        holderInput,
      }).deleteOrganization(a, await fenceFor(a, G1), { id: G1, opId: nextOp() }),
    ).toEqual(deleted(U1));
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) expect(statement.params.length).toBeLessThanOrEqual(100);
  });
});

describe('changeRole', () => {
  it('moves a grant between protected roles, and from an unprotected to a protected role', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      emailGrant(a, G2, 'u2@example.test', AUDITOR),
    ]);
    expect(await grants.changeRole(a, G1, ADMIN_TWO, LATER)).toBe('updated');
    expect(await grants.changeRole(a, G2, ADMIN, LATER)).toBe('updated');
    expect(await grants.countProtectedHolders(a)).toBe(2);
    expect(
      await rows('SELECT role_id, updated_at, created_at FROM access_grant WHERE id = ?', G1),
    ).toEqual([{ role_id: ADMIN_TWO, updated_at: LATER, created_at: NOW }]);
  });

  it('demotes one of two admins and refuses to demote the other', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      emailGrant(a, G2, 'u2@example.test', ADMIN),
    ]);
    expect(await grants.changeRole(a, G1, AUDITOR, LATER)).toBe('updated');
    expect(await grants.changeRole(a, G2, AUDITOR, LATER)).toBe('last_holder');
    expect(await rows('SELECT role_id FROM access_grant WHERE id = ?', G2)).toEqual([
      { role_id: ADMIN },
    ]);
  });

  it('refuses a project, missing or foreign role and leaves the grant alone', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      emailGrant(a, G2, 'u2@example.test', ADMIN),
    ]);
    const before = await snapshot();
    expect(await grants.changeRole(a, G1, PROJECT_ROLE, LATER)).toBe('role_scope_mismatch');
    expect(await grants.changeRole(a, G1, ADMIN_B, LATER)).toBe('role_scope_mismatch');
    expect(await grants.changeRole(a, G1, '01J0ROLEMISSING000000000AA', LATER)).toBe(
      'role_scope_mismatch',
    );
    expect(await snapshot()).toBe(before);
  });

  it('answers not_found before any role problem, for unknown, project and foreign grants', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', PROJECT_ROLE, PROJECT),
      emailGrant(b, GB, 'b@example.test', ADMIN_B),
    ]);
    const before = await snapshot();
    expect(await grants.changeRole(a, '01J0GRANT000000000000000ZZ', AUDITOR, LATER)).toBe(
      'not_found',
    );
    expect(await grants.changeRole(a, G1, AUDITOR, LATER)).toBe('not_found');
    expect(await grants.changeRole(a, G1, PROJECT_ROLE, LATER)).toBe('not_found');
    expect(await grants.changeRole(a, GB, AUDITOR, LATER)).toBe('not_found');
    expect(await grants.changeRole(a, GB, ADMIN_B, LATER)).toBe('not_found');
    expect(await snapshot()).toBe(before);
  });

  it('leaves a project grant of an unprotected project role alone', async () => {
    await seed([
      role(a, '01J0ROLEVIEWER00000000000AA', 'project_viewer', 'project', 0),
      emailGrant(a, G1, 'u1@example.test', '01J0ROLEVIEWER00000000000AA', PROJECT),
    ]);
    expect(await grants.changeRole(a, G1, ADMIN, LATER)).toBe('not_found');
    expect(await rows("SELECT role_id FROM access_grant WHERE id NOT LIKE '01J0ACTOR%'")).toEqual([
      { role_id: '01J0ROLEVIEWER00000000000AA' },
    ]);
  });

  it('demoting a grant that points at a protected role of another organization is allowed', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', ADMIN_B)]);
    expect(await grants.changeRole(a, G1, AUDITOR, LATER)).toBe('updated');
  });

  it('a role mismatch outranks last_holder', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    expect(await grants.changeRole(a, G1, PROJECT_ROLE, LATER)).toBe('role_scope_mismatch');
  });

  it('keeping the same protected role on the last holder is allowed', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    expect(await grants.changeRole(a, G1, ADMIN, LATER)).toBe('updated');
  });

  it('rejects a malformed timestamp before SQL', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', AUDITOR)]);
    await expect(grants.changeRole(a, G1, ADMIN, 'yesterday')).rejects.toThrow(TypeError);
  });

  it('is one batch', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', AUDITOR)]);
    const counted = countCalls(executor);
    await createGrantRepository(counted.executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    }).changeRole(a, G1, ADMIN, LATER);
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
  });
});

describe('suspendUser and reactivateUser', () => {
  it('5: suspension revokes the live sessions of that user only, in one batch', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      session(a, '01J0SESSION0000000000000001', U2),
      session(a, '01J0SESSION0000000000000002', U2),
      session(a, '01J0SESSION0000000000000003', U1),
      session(b, '01J0SESSION0000000000000004', UB),
    ]);
    await executor.all(
      stmt(
        "UPDATE session SET revoked_at = '2026-10-15T09:00:00.000Z' WHERE id = '01J0SESSION0000000000000002'",
      ),
    );
    const counted = countCalls(executor);
    expect(
      await createGrantRepository(counted.executor, {
        providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
          provider,
          anchor: ANCHOR,
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test', 'actor.test'],
        })),
        holderInput,
      }).suspendUser(a, U2, LATER),
    ).toBe('suspended');
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
    expect(await statusOf(U2)).toBe('suspended');
    expect(
      await rows("SELECT id, revoked_at FROM session WHERE id NOT LIKE '01J0ACTOR%' ORDER BY id"),
    ).toEqual([
      { id: '01J0SESSION0000000000000001', revoked_at: LATER },
      { id: '01J0SESSION0000000000000002', revoked_at: '2026-10-15T09:00:00.000Z' },
      { id: '01J0SESSION0000000000000003', revoked_at: null },
      { id: '01J0SESSION0000000000000004', revoked_at: null },
    ]);
  });

  it('5: a refused suspension keeps the status and the sessions', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      session(a, '01J0SESSION0000000000000001', U1),
    ]);
    expect(await grants.suspendUser(a, U1, LATER)).toBe('last_holder');
    expect(await statusOf(U1)).toBe('active');
    expect(await rows("SELECT revoked_at FROM session WHERE id NOT LIKE '01J0ACTOR%'")).toEqual([
      { revoked_at: null },
    ]);
  });

  it('5: reactivation restores active and leaves the revoked sessions revoked', async () => {
    await seed([session(a, '01J0SESSION0000000000000001', U2)]);
    expect(await grants.suspendUser(a, U2, LATER)).toBe('suspended');
    expect(await grants.reactivateUser(a, U2, '2026-10-15T14:00:00.000Z')).toBe('reactivated');
    expect(await rows('SELECT status, email FROM user_account WHERE id = ?', U2)).toEqual([
      { status: 'active', email: 'u2@example.test' },
    ]);
    expect(await rows("SELECT revoked_at FROM session WHERE id NOT LIKE '01J0ACTOR%'")).toEqual([
      { revoked_at: LATER },
    ]);
    expect(await grants.reactivateUser(a, U2, '2026-10-15T15:00:00.000Z')).toBe('unchanged');
  });

  it('suspending a suspended user answers unchanged and does not rewrite updated_at', async () => {
    expect(await grants.suspendUser(a, U2, NOW)).toBe('suspended');
    expect(await grants.suspendUser(a, U2, LATER)).toBe('unchanged');
    expect(await rows('SELECT updated_at FROM user_account WHERE id = ?', U2)).toEqual([
      { updated_at: NOW },
    ]);
  });

  it('a user suspended by a rival connection answers unchanged, not last_holder', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    await executor.all(stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U1));
    expect(await grants.suspendUser(a, U1, LATER)).toBe('unchanged');
  });

  it('a holder of a protected role in another organization does not let the last holder go', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      user(b, '01J0USER00000000000000000C', 'u1@example.test'),
      ...identities(b, [['01J0USER00000000000000000C', 'u1@example.test']]),
      emailGrant(b, GB, 'u1@example.test', ADMIN_B),
      emailGrant(b, '01J0GRANT000000000000000B2', 'b@example.test', ADMIN_B),
      groupGrant(b, '01J0GRANT000000000000000B3', 'oidc', 'admins', ADMIN_B),
      membership(a, U1, 'oidc', 'admins'),
      membership(b, UB, 'oidc', 'admins'),
    ]);
    expect(await grants.countProtectedHolders(b)).toBe(2);
    expect(await grants.suspendUser(a, U1, LATER)).toBe('last_holder');
    expect(await statusOf(U1)).toBe('active');
  });

  it('suspending a user who is not a holder is allowed when no holder exists', async () => {
    expect(await grants.countProtectedHolders(a)).toBe(0);
    expect(await grants.suspendUser(a, U3, LATER)).toBe('suspended');
  });

  it('is not_found for an unknown user and for a user of another organization', async () => {
    const before = await snapshot();
    expect(await grants.suspendUser(a, '01J0USER00000000000000ZZZZ', LATER)).toBe('not_found');
    expect(await grants.suspendUser(a, UB, LATER)).toBe('not_found');
    expect(await grants.reactivateUser(a, UB, LATER)).toBe('not_found');
    expect(await grants.reactivateUser(a, '01J0USER00000000000000ZZZZ', LATER)).toBe('not_found');
    expect(await snapshot()).toBe(before);
  });

  it('reactivateUser is unchanged for an active user: one batch and four reads', async () => {
    const counted = countCalls(executor);
    expect(
      await createGrantRepository(counted.executor, {
        providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
          provider,
          anchor: ANCHOR,
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test', 'actor.test'],
        })),
        holderInput,
      }).reactivateUser(a, U1, LATER),
    ).toBe('unchanged');
    expect(counted.counts()).toEqual({ all: 4, batch: 1 });
  });

  it('rejects a malformed timestamp before SQL', async () => {
    await expect(grants.suspendUser(a, U1, 'now')).rejects.toThrow(TypeError);
    await expect(grants.reactivateUser(a, U1, 'now')).rejects.toThrow(TypeError);
  });
});

const LIMITED = {
  user: '01J0LIMITEDUSER00000000AA',
  identity: '01J0LIMITEDIDEN00000000AA',
  role: '01J0LIMITEDROLE00000000AA',
  grant: '01J0LIMITEDGRNT00000000AA',
  session: '01J0LIMITEDSESS00000000AA',
};

function limitedActor(org: OrgContext, permission = 'org:users:write'): Statement[] {
  const now = new Date().toISOString();
  const hash = 'b'.repeat(64);
  return [
    user(org, LIMITED.user, 'limited@actor.test'),
    stmt(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      LIMITED.identity,
      org.orgId,
      LIMITED.user,
      'oidc',
      'subject-limited',
      'limited@actor.test',
      now,
    ),
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)',
      LIMITED.role,
      org.orgId,
      'limited_actor',
      'limited_actor',
      'organization',
    ),
    stmt(
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      org.orgId,
      LIMITED.role,
      permission,
    ),
    emailGrant(org, LIMITED.grant, 'limited@actor.test', LIMITED.role),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      LIMITED.session,
      org.orgId,
      LIMITED.user,
      hash,
      hash,
      now,
      new Date(Date.now() + 3_600_000).toISOString(),
    ),
  ];
}

function limitedFence(): MutationFence {
  return mutationFence(
    { userId: LIMITED.user, sessionId: LIMITED.session } as unknown as AuthenticatedActor,
    {},
  );
}

async function epochOf(org: OrgContext): Promise<unknown> {
  const found = await executor.all<{ version: string }>(
    stmt('SELECT version FROM cache_epoch WHERE org_id = ?', org.orgId),
  );
  return found[0]?.version;
}

describe('user status fence', () => {
  it('a non-admin cannot suspend a holder reached through an e-mail grant', async () => {
    await seed([
      ...limitedActor(a),
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      emailGrant(a, G2, 'u2@example.test', ADMIN),
      session(a, '01J0SESSION0000000000000001', U2),
    ]);
    const repository = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    const epoch = await epochOf(a);
    expect(await repository.suspendUser(a, limitedFence(), { userId: U2, now: LATER })).toBe(
      'authority',
    );
    expect(await statusOf(U2)).toBe('active');
    expect(await rows("SELECT revoked_at FROM session WHERE id LIKE '01J0SESSION%'")).toEqual([
      { revoked_at: null },
    ]);
    expect(await epochOf(a)).toBe(epoch);
  });

  it('a non-admin cannot suspend a holder reached only through a group', async () => {
    await seed([
      ...limitedActor(a),
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      groupGrant(a, G2, 'oidc', 'admins', ADMIN),
      membership(a, U2, 'oidc', 'admins'),
    ]);
    const repository = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    expect(await repository.suspendUser(a, limitedFence(), { userId: U2, now: LATER })).toBe(
      'authority',
    );
    expect(await statusOf(U2)).toBe('active');
  });

  it('a non-admin may suspend a user whose group evidence is stale and who is no holder', async () => {
    await seed([
      ...limitedActor(a),
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      groupGrant(a, G2, 'oidc', 'admins', ADMIN),
      membership(a, U2, 'oidc', 'admins'),
    ]);
    await executor.all(stmt("UPDATE user_group SET refreshed_at = '2020-01-01T00:00:00.000Z'"));
    const repository = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    expect(await repository.suspendUser(a, limitedFence(), { userId: U2, now: LATER })).toBe(
      'suspended',
    );
  });

  it('a non-admin may suspend a user who is no holder', async () => {
    await seed([...limitedActor(a), emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    const repository = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    expect(await repository.suspendUser(a, limitedFence(), { userId: U3, now: LATER })).toBe(
      'suspended',
    );
  });

  it('an actor without org:users:write is refused by the batch', async () => {
    await seed([...limitedActor(a, 'org:read'), emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    const repository = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    expect(await repository.suspendUser(a, limitedFence(), { userId: U3, now: LATER })).toBe(
      'authority',
    );
    expect(await statusOf(U3)).toBe('active');
    await executor.all(stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U3));
    expect(await repository.reactivateUser(a, limitedFence(), { userId: U3, now: LATER })).toBe(
      'authority',
    );
    expect(await statusOf(U3)).toBe('suspended');
  });

  it('an actor whose session was revoked is refused by the batch', async () => {
    await seed([...limitedActor(a), emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    await executor.all(
      stmt('UPDATE session SET revoked_at = ? WHERE id = ?', NOW, LIMITED.session),
    );
    const repository = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    expect(await repository.suspendUser(a, limitedFence(), { userId: U3, now: LATER })).toBe(
      'authority',
    );
    expect(await statusOf(U3)).toBe('active');
  });

  it('a suspended actor is refused by the batch', async () => {
    await seed([...limitedActor(a), emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    await executor.all(
      stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", LIMITED.user),
    );
    const repository = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    expect(await repository.suspendUser(a, limitedFence(), { userId: U3, now: LATER })).toBe(
      'authority',
    );
  });

  it('reactivating a user who is not suspended writes nothing', async () => {
    const before = await snapshot();
    const epoch = await epochOf(a);
    expect(await grants.reactivateUser(a, U1, LATER)).toBe('unchanged');
    expect(await grants.reactivateUser(a, '01J0USER00000000000000ZZZZ', LATER)).toBe('not_found');
    expect(await snapshot()).toBe(before);
    expect(await epochOf(a)).toBe(epoch);
  });

  it('a repeated suspension changes nothing the second time', async () => {
    await seed([session(a, '01J0SESSION0000000000000001', U2)]);
    const first = await epochOf(a);
    expect(await grants.suspendUser(a, U2, NOW)).toBe('suspended');
    const afterFirst = await epochOf(a);
    expect(afterFirst).not.toBe(first);
    const before = await snapshot();
    expect(await grants.suspendUser(a, U2, LATER)).toBe('unchanged');
    expect(await snapshot()).toBe(before);
    expect(await epochOf(a)).toBe(afterFirst);
  });

  it('a reactivation bumps the epoch once and a second one does not', async () => {
    await executor.all(stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U3));
    const first = await epochOf(a);
    expect(await grants.reactivateUser(a, U3, LATER)).toBe('reactivated');
    const afterFirst = await epochOf(a);
    expect(afterFirst).not.toBe(first);
    expect(await grants.reactivateUser(a, U3, LATER)).toBe('unchanged');
    expect(await epochOf(a)).toBe(afterFirst);
  });

  it('a non-admin cannot reactivate a suspended admin holding through an e-mail grant', async () => {
    await seed([
      ...limitedActor(a),
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      emailGrant(a, G2, 'u2@example.test', ADMIN),
    ]);
    await executor.all(stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U2));
    const repository = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    const before = await snapshot();
    const epoch = await epochOf(a);
    expect(await repository.reactivateUser(a, limitedFence(), { userId: U2, now: LATER })).toBe(
      'authority',
    );
    expect(await snapshot()).toBe(before);
    expect(await epochOf(a)).toBe(epoch);
    expect(await grants.reactivateUser(a, U2, LATER)).toBe('reactivated');
    expect(await statusOf(U2)).toBe('active');
  });

  it('a non-admin cannot reactivate a suspended admin holding through a group', async () => {
    await seed([
      ...limitedActor(a),
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      groupGrant(a, G2, 'oidc', 'admins', ADMIN),
      membership(a, U2, 'oidc', 'admins'),
    ]);
    await executor.all(stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U2));
    const repository = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    const before = await snapshot();
    expect(await repository.reactivateUser(a, limitedFence(), { userId: U2, now: LATER })).toBe(
      'authority',
    );
    expect(await snapshot()).toBe(before);
    expect(await grants.reactivateUser(a, U2, LATER)).toBe('reactivated');
  });

  it('a non-admin may reactivate a suspended user who would hold no protected role', async () => {
    await seed([...limitedActor(a), emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    await executor.all(stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U3));
    const repository = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    expect(await repository.reactivateUser(a, limitedFence(), { userId: U3, now: LATER })).toBe(
      'reactivated',
    );
  });

  it('a refusal whose cause is gone by the time it is classified is a retryable conflict', async () => {
    await seed([
      ...limitedActor(a),
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      emailGrant(a, G2, 'u2@example.test', ADMIN),
    ]);
    let promoted = false;
    const promoting: SqlExecutor = {
      driver: executor.driver,
      all: async (statement) => {
        if (!promoted) {
          promoted = true;
          await executor.all(
            stmt('UPDATE role SET protects_last_holder = 1 WHERE id = ?', LIMITED.role),
          );
        }
        return executor.all(statement);
      },
      batch: (statements) => executor.batch(statements),
    };
    const repository = createFencedGrantRepository(promoting, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    expect(await repository.suspendUser(a, limitedFence(), { userId: U2, now: LATER })).toBe(
      'conflict',
    );
    expect(await statusOf(U2)).toBe('active');
  });

  it('no field of an injected holder input makes the guards count suspended users', async () => {
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      emailGrant(a, G2, 'u2@example.test', ADMIN),
    ]);
    await executor.all(stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U2));
    const injected = createGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput: async () =>
        ({ ...(await holderInput()), includeSuspended: true }) as unknown as ProtectedHolderInput,
    });
    expect(await injected.suspendUser(a, U1, LATER)).toBe('last_holder');
    expect(await statusOf(U1)).toBe('active');
    const protectedInjected = createFencedGrantRepository(executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput: () =>
        ({
          ...holderInput(),
          includeSuspended: true,
          exclude: { identityId: actorOf(a).identity },
        }) as unknown as ProtectedHolderInput,
    });
    expect(await protectedInjected.countProtectedHolders(a)).toBe(1);
  });

  it('a busy database is a retryable conflict and an oversized statement is a programming error', async () => {
    await seed([...limitedActor(a), emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    const failing = (kind: 'busy' | 'too_big'): SqlExecutor => ({
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async () => {
        throw new DbError(kind, `${kind}: injected`);
      },
    });
    const busy = createFencedGrantRepository(failing('busy'), {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    expect(await busy.suspendUser(a, limitedFence(), { userId: U3, now: LATER })).toBe('conflict');
    expect(await busy.reactivateUser(a, limitedFence(), { userId: U3, now: LATER })).toBe(
      'conflict',
    );
    const big = createFencedGrantRepository(failing('too_big'), {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    await expect(
      big.suspendUser(a, limitedFence(), { userId: U3, now: LATER }),
    ).rejects.toMatchObject({
      kind: 'too_big',
    });
    await expect(
      big.reactivateUser(a, limitedFence(), { userId: U3, now: LATER }),
    ).rejects.toMatchObject({
      kind: 'too_big',
    });
  });

  it('a user of another organization is not touched by a fence of this one', async () => {
    const epochB = await epochOf(b);
    expect(await grants.suspendUser(a, UB, LATER)).toBe('not_found');
    expect(await statusOf(UB)).toBe('active');
    expect(await epochOf(b)).toBe(epochB);
  });
});

describe('two organizations', () => {
  it('guards in one organization ignore holders and grants of the other', async () => {
    await seed([
      emailGrant(a, G1, 'shared@example.test', ADMIN),
      user(a, '01J0USER000000000000000009', 'shared@example.test'),
      user(b, '01J0USER00000000000000000C', 'shared@example.test'),
      ...identities(a, [['01J0USER000000000000000009', 'shared@example.test']]),
      ...identities(b, [['01J0USER00000000000000000C', 'shared@example.test']]),
      emailGrant(b, GB, 'shared@example.test', ADMIN_B),
      groupGrant(b, '01J0GRANT000000000000000B2', 'oidc', 'admins', ADMIN_B),
      membership(a, U1, 'oidc', 'admins'),
      membership(b, UB, 'oidc', 'admins'),
    ]);
    expect(await grants.countProtectedHolders(a)).toBe(1);
    expect(await grants.countProtectedHolders(b)).toBe(2);
    expect(await grants.deleteOrganization(a, G1)).toBe('last_holder');
    expect(await grants.deleteOrganization(b, GB)).toBe('deleted');
    expect(await grants.deleteOrganization(b, '01J0GRANT000000000000000B2')).toBe('last_holder');
    expect(await grants.countProtectedHolders(a)).toBe(1);
  });
});

describe('concurrent guarded operations on one file database', () => {
  const RUNS = 20;
  const GROUP_GRANT = '01J0GRANT000000000000000A9';
  let directory: string;
  let shared: MigratedDatabase;
  let org: OrgContext;
  let first: UnfencedGrants;
  let second: UnfencedGrants;
  let secondExecutor: SqlExecutor;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-grants-'));
    shared = await openMigratedDatabase({
      file: join(directory, 'store.sqlite'),
      twoOrganizations: true,
    });
    if (shared.orgs === null) throw new Error('two organizations expected');
    org = shared.orgs.a;
    storage = shared.executor;
    await shared.executor.batch([
      ...rolesFor(org, ADMIN, true),
      ...bindings(org),
      ...actorStatements(org),
    ]);
    first = createGrantRepository(shared.executor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
    secondExecutor = await shared.second();
    second = createGrantRepository(secondExecutor, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput,
    });
  });

  afterEach(async () => {
    await shared.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function reset(statements: readonly Statement[]): Promise<void> {
    await shared.executor.batch([
      stmt('DELETE FROM session'),
      stmt('DELETE FROM user_group'),
      stmt('DELETE FROM access_grant'),
      stmt('DELETE FROM identity'),
      stmt('DELETE FROM user_account'),
      user(org, U1, 'u1@example.test'),
      user(org, U2, 'u2@example.test'),
      ...identities(org, [
        [U1, 'u1@example.test'],
        [U2, 'u2@example.test'],
      ]),
      ...actorStatements(org),
      ...statements,
    ]);
  }

  async function race<L, R>(
    run: number,
    left: () => Promise<L>,
    right: () => Promise<R>,
  ): Promise<[L, R]> {
    if (run % 2 === 0) return Promise.all([left(), right()]);
    const [r, l] = await Promise.all([right(), left()]);
    return [l, r];
  }

  const byEmail = (): Statement[] => [
    emailGrant(org, G1, 'u1@example.test', ADMIN),
    emailGrant(org, G2, 'u2@example.test', ADMIN),
  ];

  const withGroup = (): Statement[] => [
    emailGrant(org, G1, 'u1@example.test', ADMIN),
    groupGrant(org, GROUP_GRANT, 'oidc', 'admins', ADMIN),
    membership(org, U2, 'oidc', 'admins'),
  ];

  const personWithTwoGrants = (): Statement[] => [
    emailGrant(org, G1, 'u1@example.test', ADMIN),
    groupGrant(org, GROUP_GRANT, 'oidc', 'admins', ADMIN),
    membership(org, U1, 'oidc', 'admins'),
  ];

  it('7: delete against delete never removes the last holder', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      await reset(byEmail());
      const outcomes = await race(
        run,
        () => first.deleteOrganization(org, G1),
        () => second.deleteOrganization(org, G2),
      );
      expect(outcomes.slice().sort()).toEqual(['deleted', 'last_holder']);
      expect(await first.countProtectedHolders(org)).toBe(1);
    }
  });

  it('7: delete against delete with a holder only through a group', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      await reset(withGroup());
      const outcomes = await race(
        run,
        () => first.deleteOrganization(org, G1),
        () => second.deleteOrganization(org, GROUP_GRANT),
      );
      expect(outcomes.slice().sort()).toEqual(['deleted', 'last_holder']);
      expect(await first.countProtectedHolders(org)).toBe(1);
    }
  });

  it('7: delete against delete of the two grants of one person', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      await reset(personWithTwoGrants());
      const outcomes = await race(
        run,
        () => first.deleteOrganization(org, G1),
        () => second.deleteOrganization(org, GROUP_GRANT),
      );
      expect(outcomes.slice().sort()).toEqual(['deleted', 'last_holder']);
      expect(await first.countProtectedHolders(org)).toBe(1);
    }
  });

  it('7: suspend against suspend never suspends both holders', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      await reset(run % 4 < 2 ? byEmail() : withGroup());
      const outcomes = await race(
        run,
        () => first.suspendUser(org, U1, LATER),
        () => second.suspendUser(org, U2, LATER),
      );
      expect(outcomes.slice().sort()).toEqual(['last_holder', 'suspended']);
      expect(await first.countProtectedHolders(org)).toBe(1);
    }
  });

  it('7: delete against suspend never removes the last holder', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      await reset(run % 4 < 2 ? byEmail() : withGroup());
      const outcomes = await race(
        run,
        () => first.deleteOrganization(org, G1),
        () => second.suspendUser(org, U2, LATER),
      );
      expect([
        ['deleted', 'last_holder'],
        ['last_holder', 'suspended'],
      ]).toContainEqual(outcomes);
      expect(await first.countProtectedHolders(org)).toBe(1);
    }
  });

  const UNLINK_ANCHOR = `oidc:${ANCHOR}`;

  function boundHolderInput(): ProtectedHolderInput {
    const holders = holderInput();
    if (holders.kind !== 'fresh') throw new Error('fresh holder input expected');
    return {
      ...holders,
      providers: holders.providers.map((entry) =>
        entry.provider === 'oidc' ? { ...entry, anchor: UNLINK_ANCHOR } : entry,
      ),
    };
  }

  async function unlinkHolderEvidence(
    userId: string,
    through: SqlExecutor = secondExecutor,
  ): Promise<'unlinked' | 'last_holder'> {
    const outcome = await createUnlinkRepository(through, {
      holderInput: async (ctx) => ({
        ...boundHolderInput(),
        exclude: { userId: actorOf(ctx).user },
      }),
    }).unlinkIdentity(org, await fenceFor(org), {
      identityId: `ID-oidc-${userId}`,
      userId,
      provider: 'oidc',
      subject: `oidc-${userId}`,
      anchor: UNLINK_ANCHOR,
      now: LATER,
    });
    if (outcome !== 'unlinked' && outcome !== 'last_holder') {
      throw new Error(`unexpected unlink outcome ${outcome}`);
    }
    return outcome;
  }

  function held(executor: SqlExecutor, on: 'all' | 'batch') {
    let release!: () => void;
    let arrive!: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    let waited = false;
    const wait = async (): Promise<void> => {
      if (waited) return;
      waited = true;
      arrive();
      await open;
    };
    const gated: SqlExecutor = {
      driver: executor.driver,
      all: async (statement) => {
        if (on === 'all') await wait();
        return executor.all(statement);
      },
      batch: async (statements) => {
        if (on === 'batch') await wait();
        return executor.batch(statements);
      },
    };
    return { executor: gated, reached, release };
  }

  const worlds: [string, () => Statement[]][] = [
    ['e-mail grants', byEmail],
    ['a group holder', withGroup],
  ];

  for (const [label, world] of worlds) {
    for (const order of ['suspend first', 'unlink first'] as const) {
      it(`7: latched suspend against unlink of the other holder, ${label}, ${order}`, async () => {
        await reset(world());
        await shared.executor.batch([
          stmt('DELETE FROM identity WHERE id = ?', `ID-access-${U1}`),
          stmt(
            'INSERT OR REPLACE INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
            org.orgId,
            'oidc',
            UNLINK_ANCHOR,
          ),
        ]);
        const suspendGate = held(shared.executor, 'batch');
        const unlinkGate = held(secondExecutor, 'batch');
        const suspending = createGrantRepository(suspendGate.executor, {
          providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
            provider,
            anchor: provider === 'oidc' ? UNLINK_ANCHOR : ANCHOR,
            emailAuthoritative: true,
            emailAuthoritativeDomains: ['example.test', 'actor.test'],
          })),
          holderInput: boundHolderInput,
        }).suspendUser(org, U2, LATER);
        const unlinking = unlinkHolderEvidence(U1, unlinkGate.executor);
        await Promise.all([suspendGate.reached, unlinkGate.reached]);
        const suspendFirst = order === 'suspend first';
        (suspendFirst ? suspendGate : unlinkGate).release();
        await (suspendFirst ? suspending : unlinking);
        (suspendFirst ? unlinkGate : suspendGate).release();
        const outcomes = await Promise.all([suspending, unlinking]);
        expect(outcomes).toEqual(
          suspendFirst ? ['suspended', 'last_holder'] : ['last_holder', 'unlinked'],
        );
        const counter = createGrantRepository(shared.executor, {
          providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
            provider,
            anchor: provider === 'oidc' ? UNLINK_ANCHOR : ANCHOR,
            emailAuthoritative: true,
            emailAuthoritativeDomains: ['example.test', 'actor.test'],
          })),
          holderInput: boundHolderInput,
        });
        expect(await counter.countProtectedHolders(org)).toBe(1);
      });
    }
  }

  for (const order of ['first connection', 'second connection'] as const) {
    it(`7: two concurrent suspensions of one user record exactly one event, ${order} wins`, async () => {
      await reset(byEmail());
      const events: { event?: string }[] = [];
      const gates = [held(shared.executor, 'batch'), held(secondExecutor, 'batch')] as const;
      const administrators = gates.map((gate) =>
        createAdministration({
          roles: { list: async () => [], get: async () => null } as never,
          grants: createFencedGrantRepository(gate.executor, {
            providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
              provider,
              anchor: ANCHOR,
              emailAuthoritative: true,
              emailAuthoritativeDomains: ['example.test', 'actor.test'],
            })),
            holderInput: async (ctx) => ({
              ...holderInput(),
              exclude: { identityId: actorOf(ctx).identity },
            }),
          }),
          users: {
            get: async () => ({ id: U2, email: 'u2@example.test', status: 'active' }) as never,
          },
          providers: new Map(),
          clock: fixedClock(LATER),
          ids: { ulid: () => 'ID' },
          log: (entry) => events.push(entry as { event?: string }),
        }),
      );
      const admin = {
        kind: 'organization' as const,
        userId: actorOf(org).user,
        permissions: new Set(['org:users:write']),
        isOrganizationAdmin: true,
      };
      const fence = await fenceFor(org);
      const calls = administrators.map((administration) =>
        administration.suspendUser(org, admin, fence, U2, apiCall),
      );
      await Promise.all(gates.map((gate) => gate.reached));
      const winner = order === 'first connection' ? 0 : 1;
      gates[winner]?.release();
      await calls[winner];
      gates[1 - winner]?.release();
      const results = await Promise.all(calls);
      expect(results).toEqual([
        { ok: true, value: null },
        { ok: true, value: null },
      ]);
      expect(events.filter((entry) => entry.event === 'user.changed')).toHaveLength(1);
      expect(
        await shared.executor.all(stmt('SELECT status FROM user_account WHERE id = ?', U2)),
      ).toEqual([{ status: 'suspended' }]);
    });
  }

  it('7: delete against suspend when the person keeps a second grant', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      await reset([...personWithTwoGrants(), emailGrant(org, G2, 'u2@example.test', ADMIN)]);
      const outcomes = await race(
        run,
        () => first.deleteOrganization(org, G1),
        () => second.suspendUser(org, U2, LATER),
      );
      expect(outcomes).toEqual(['deleted', 'suspended']);
      expect(await first.countProtectedHolders(org)).toBe(1);
    }
  });

  it('7: demotion against deletion never removes the last holder', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      await reset(byEmail());
      const outcomes = await race(
        run,
        () => first.changeRole(org, G1, AUDITOR, LATER),
        () => second.deleteOrganization(org, G2),
      );
      expect([
        ['updated', 'last_holder'],
        ['last_holder', 'deleted'],
      ]).toContainEqual(outcomes);
      expect(await first.countProtectedHolders(org)).toBe(1);
    }
  });
});

describe('spike scale', () => {
  const USERS = 1000;
  const MEMBERSHIPS = 1200;
  const PROVIDERS = ['oidc', 'access'] as const;
  const GROUPS = 30;

  interface ModelGrant {
    id: string;
    type: 'email' | 'group';
    value: string;
    provider: string | null;
    roleProtected: boolean;
    organizationScope: boolean;
  }

  interface World {
    statements: Statement[];
    emails: Map<string, string>;
    active: Set<string>;
    groupsOf: Map<string, Set<string>>;
    grants: ModelGrant[];
    memberships: number;
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

  function build(): World {
    const random = prng(20261016);
    const pick = (n: number): number => Math.floor(random() * n);
    const statements: Statement[] = [];
    const emails = new Map<string, string>();
    const active = new Set<string>();
    for (let i = 0; i < USERS; i += 1) {
      const id = pad('USER', i);
      const suspended = i % 10 === 3;
      emails.set(id, `user${i}@example.test`);
      if (!suspended) active.add(id);
      statements.push(user(a, id, `user${i}@example.test`, suspended ? 'suspended' : 'active'));
      statements.push(...identities(a, [[id, `user${i}@example.test`]]));
    }
    const groupsOf = new Map<string, Set<string>>();
    const seen = new Set<string>();
    while (seen.size < MEMBERSHIPS) {
      const userId = pad('USER', pick(USERS));
      const provider = PROVIDERS[pick(PROVIDERS.length)] ?? 'oidc';
      const group = `group-${pick(GROUPS)}`;
      const key = `${userId}|${provider}|${group}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const set = groupsOf.get(userId) ?? new Set<string>();
      set.add(`${provider}|${group}`);
      groupsOf.set(userId, set);
      statements.push(membership(a, userId, provider, group));
    }
    const modelGrants: ModelGrant[] = [];
    let counter = 0;
    const nextId = (): string => pad('GRANT', (counter += 1));
    const chooseRole = (): { id: string; roleProtected: boolean } =>
      random() < 0.2 ? { id: ADMIN, roleProtected: true } : { id: AUDITOR, roleProtected: false };
    for (let i = 0; i < 420; i += 1) {
      const id = nextId();
      const chosen = chooseRole();
      const value = i < 400 ? `user${i * 2}@example.test` : `outsider${i}@example.test`;
      modelGrants.push({
        id,
        type: 'email',
        value,
        provider: null,
        roleProtected: chosen.roleProtected,
        organizationScope: true,
      });
      statements.push(emailGrant(a, id, value, chosen.id));
    }
    for (const provider of PROVIDERS) {
      for (let g = 0; g < GROUPS - 3; g += 1) {
        const id = nextId();
        const chosen = chooseRole();
        modelGrants.push({
          id,
          type: 'group',
          value: `group-${g}`,
          provider,
          roleProtected: chosen.roleProtected,
          organizationScope: true,
        });
        statements.push(groupGrant(a, id, provider, `group-${g}`, chosen.id));
      }
    }
    for (let i = 0; i < 200; i += 1) {
      const id = nextId();
      const value = `user${i * 5}@example.test`;
      modelGrants.push({
        id,
        type: 'email',
        value,
        provider: null,
        roleProtected: true,
        organizationScope: false,
      });
      statements.push(emailGrant(a, id, value, PROJECT_ROLE, PROJECT));
    }
    return { statements, emails, active, groupsOf, grants: modelGrants, memberships: seen.size };
  }

  function holders(world: World, exclude?: { grantId?: string; userId?: string }): string[] {
    const relevant = world.grants.filter(
      (grant) => grant.organizationScope && grant.roleProtected && grant.id !== exclude?.grantId,
    );
    const ids: string[] = [];
    for (const [userId, email] of world.emails) {
      if (!world.active.has(userId) || userId === exclude?.userId) continue;
      const groups = world.groupsOf.get(userId) ?? new Set<string>();
      const holds = relevant.some((grant) =>
        grant.type === 'email'
          ? grant.value === email
          : groups.has(`${grant.provider ?? ''}|${grant.value}`),
      );
      if (holds) ids.push(userId);
    }
    return ids;
  }

  async function holderIds(org: OrgContext): Promise<string[]> {
    const found = await executor.all<{ id: string }>(
      compile(
        db
          .selectFrom('user_account as holder')
          .select('holder.id')
          .where('holder.org_id', '=', org.orgId)
          .where((eb) =>
            protectedHolder(org, eb.ref('holder.id'), {
              ...holderInput(),
              exclude: { identityId: actorOf(org).identity },
            }),
          )
          .orderBy('holder.id'),
      ),
    );
    return found.map((row) => row.id);
  }

  async function expectHolders(world: World): Promise<void> {
    expect(await holderIds(a)).toEqual(holders(world).sort());
    expect(await grants.countProtectedHolders(a)).toBe(holders(world).length);
  }

  async function exercise(world: World, rounds: number, offset: number): Promise<void> {
    const organizationGrants = world.grants.filter((grant) => grant.organizationScope);
    for (let step = 0; step < rounds; step += 1) {
      const grant = organizationGrants[(offset + step * 13) % organizationGrants.length];
      if (grant === undefined) continue;
      const expected =
        !grant.roleProtected || holders(world, { grantId: grant.id }).length > 0
          ? 'deleted'
          : 'last_holder';
      expect(await grants.deleteOrganization(a, grant.id)).toBe(expected);
      if (expected === 'deleted') world.grants.splice(world.grants.indexOf(grant), 1);
      await expectHolders(world);

      const holder = holders(world)[(offset + step * 7) % Math.max(1, holders(world).length)];
      if (holder === undefined) continue;
      const suspendExpected =
        holders(world, { userId: holder }).length > 0 ? 'suspended' : 'last_holder';
      expect(await grants.suspendUser(a, holder, LATER)).toBe(suspendExpected);
      if (suspendExpected === 'suspended') world.active.delete(holder);
      await expectHolders(world);
    }
  }

  async function drain(world: World): Promise<void> {
    while (holders(world).length > 1) {
      const holder = holders(world)[0] ?? '';
      expect(await grants.suspendUser(a, holder, LATER)).toBe('suspended');
      world.active.delete(holder);
    }
    await expectHolders(world);
    const last = holders(world)[0] ?? '';
    expect(await grants.suspendUser(a, last, LATER)).toBe('last_holder');

    const outcomes = new Set<string>();
    for (const grant of world.grants.filter((g) => g.organizationScope && g.roleProtected)) {
      const expected = holders(world, { grantId: grant.id }).length > 0 ? 'deleted' : 'last_holder';
      const actual = await grants.deleteOrganization(a, grant.id);
      expect(actual).toBe(expected);
      outcomes.add(actual);
      if (actual === 'deleted') world.grants.splice(world.grants.indexOf(grant), 1);
    }
    expect([...outcomes].sort()).toEqual(['deleted', 'last_holder']);
    await expectHolders(world);
    expect(holders(world)).toHaveLength(1);
  }

  async function smallOrganization(): Promise<void> {
    expect(await holderIds(b)).toEqual([UB]);
    expect(await grants.deleteOrganization(b, GB)).toBe('last_holder');
    expect(await grants.suspendUser(b, UB, LATER)).toBe('last_holder');
    expect(await grants.changeRole(b, GB, ADMIN_B, LATER)).toBe('updated');
    expect(await holderIds(b)).toEqual([UB]);
  }

  it('8: holder ids and the guarded answers match a JavaScript model, before and after ANALYZE', async () => {
    const world = build();
    await executor.batch(world.statements);
    expect(world.memberships).toBeGreaterThanOrEqual(1000);
    expect(world.grants.length).toBeGreaterThanOrEqual(600);
    await expectHolders(world);
    expect(holders(world).length).toBeGreaterThan(50);

    await seed([emailGrant(b, GB, 'b@example.test', ADMIN_B)]);
    await smallOrganization();
    await exercise(world, 12, 0);
    await database.analyze();
    await expectHolders(world);
    await smallOrganization();
    await exercise(world, 12, 5);
    await drain(world);
  }, 180_000);
});

describe('fenced grant mutators', () => {
  const LOW = '01J0ROLELOW00000000000000A';
  const HIGH = '01J0ROLEHIGH0000000000000A';

  let fenced: ReturnType<typeof createFencedGrantRepository>;
  let statements: Statement[];
  let uncounted = '01J0NONE';

  interface Acting {
    readonly userId: string;
    readonly sessionId: string;
    readonly grantId: string;
    readonly roleId: string;
  }

  function fenceOfActing(acting: Acting, grant?: number): MutationFence {
    return mutationFence(
      { userId: acting.userId, sessionId: acting.sessionId } as unknown as AuthenticatedActor,
      grant === undefined ? {} : { grant },
    );
  }

  async function actingAs(
    name: string,
    permissions: readonly string[],
    admin = false,
  ): Promise<Acting> {
    const tag = name.toUpperCase().padEnd(10, '0');
    const acting: Acting = {
      userId: `01J0ACTORU${tag}000000`,
      sessionId: `01J0ACTORS${tag}000000`,
      grantId: `01J0ACTORG${tag}000000`,
      roleId: `01J0ACTORR${tag}000000`,
    };
    const email = `${name}@actor.test`;
    const now = new Date().toISOString();
    const hash = Buffer.from(acting.sessionId).toString('hex').padEnd(64, '0');
    await seed([
      user(a, acting.userId, email),
      stmt(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        `01J0ACTORI${tag}000000`,
        a.orgId,
        acting.userId,
        'oidc',
        `subject-${name}`,
        email,
        now,
      ),
      role(a, acting.roleId, `actor_${name}`, 'organization', admin ? 1 : 0),
      ...permissions.map((permission) =>
        stmt(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          a.orgId,
          acting.roleId,
          permission,
        ),
      ),
      stmt(
        'INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        acting.grantId,
        a.orgId,
        'email',
        email,
        'organization',
        acting.roleId,
        NOW,
        NOW,
      ),
      stmt(
        'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        acting.sessionId,
        a.orgId,
        acting.userId,
        hash,
        hash,
        now,
        new Date(Date.now() + 3_600_000).toISOString(),
      ),
    ]);
    return acting;
  }

  const WRITER = ['org:grants:write', 'org:read'];

  beforeEach(async () => {
    statements = [];
    const recording: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => {
        statements.push(statement);
        return executor.all(statement);
      },
      batch: (batch) => {
        statements.push(...batch);
        return executor.batch(batch);
      },
    };
    fenced = createFencedGrantRepository(recording, {
      providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
        provider,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
      holderInput: () => ({ ...holderInput(), exclude: { identityId: uncounted } }),
    });
    uncounted = '01J0NONE';
    await seed([
      role(a, LOW, 'low', 'organization', 0),
      role(a, HIGH, 'high', 'organization', 0),
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
        a.orgId,
        LOW,
        'org:read',
        a.orgId,
        HIGH,
        'org:read',
        a.orgId,
        HIGH,
        'org:users:write',
      ),
    ]);
  });

  async function worldState(): Promise<string> {
    return JSON.stringify([
      await rows('SELECT * FROM access_grant ORDER BY id'),
      await rows('SELECT * FROM cache_epoch ORDER BY org_id'),
    ]);
  }

  const create = (acting: Acting, roleId: string, id = G1, email = 'new@example.test') =>
    fenced.createOrganization(a, fenceOfActing(acting), {
      id,
      subject: { type: 'email', value: email },
      roleId,
      createdBy: acting.userId,
      now: NOW,
      opId: `OP${id}`,
    });

  describe.each(['create', 'delete', 'changeRole', 'suspend', 'reactivate'] as const)(
    '%s actor authority in local recovery',
    (operation) => {
      it.each([
        { recovery: true, local: false, allowed: false },
        { recovery: false, local: false, allowed: true },
        { recovery: true, local: true, allowed: true },
      ])(
        'recovery=$recovery local=$local allowed=$allowed',
        async ({ recovery, local, allowed }) => {
          const actor = await actingAs('recovery', [...WRITER, 'org:users:write'], true);
          if (local) {
            await seed([
              stmt('DELETE FROM identity WHERE user_id = ?', actor.userId),
              stmt(
                "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
                'recovery-totp',
                a.orgId,
              ),
              stmt(
                'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?, ?)',
                actor.userId,
                a.orgId,
                'pbkdf2-sha256$test',
                'recovery-totp',
                NOW,
              ),
            ]);
          }
          fenced = createFencedGrantRepository(executor, {
            providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
              provider,
              anchor: ANCHOR,
              emailAuthoritative: true,
              emailAuthoritativeDomains: ['example.test', 'actor.test'],
            })),
            holderInput: () =>
              recovery ? { kind: 'local_recovery' } : { ...holderInput(), providers: [] },
          });
          await seed([
            stmt(
              'UPDATE user_account SET status = ? WHERE id = ?',
              operation === 'reactivate' ? 'suspended' : 'active',
              U1,
            ),
            emailGrant(a, G2, 'u1@example.test', LOW),
          ]);
          const before = JSON.stringify([
            await worldState(),
            await rows('SELECT * FROM user_account ORDER BY id'),
          ]);
          const fence = fenceOfActing(actor, 1);
          let result: string;
          let success: string;
          switch (operation) {
            case 'create':
              result = await create(actor, LOW);
              success = 'created';
              break;
            case 'delete':
              result = outcomeOf(
                await fenced.deleteOrganization(a, fence, { id: G2, opId: 'OPRECOVERY' }),
              );
              success = 'deleted';
              break;
            case 'changeRole':
              result = await fenced.changeRole(a, fence, {
                id: G2,
                roleId: HIGH,
                now: LATER,
                opId: 'OPRECOVERY',
              });
              success = 'updated';
              break;
            case 'suspend':
              result = await fenced.suspendUser(a, fence, { userId: U1, now: LATER });
              success = 'suspended';
              break;
            case 'reactivate':
              result = await fenced.reactivateUser(a, fence, { userId: U1, now: LATER });
              success = 'reactivated';
              break;
          }
          expect(result).toBe(allowed ? success : 'authority');
          if (!allowed) {
            expect(
              JSON.stringify([
                await worldState(),
                await rows('SELECT * FROM user_account ORDER BY id'),
              ]),
            ).toBe(before);
          }
        },
      );
    },
  );

  it('1: a non-admin cannot grant a role with a permission it lacks, nor a protected role', async () => {
    const writer = await actingAs('writer', WRITER);
    const before = await worldState();
    expect(await create(writer, HIGH)).toBe('authority');
    expect(await create(writer, ADMIN)).toBe('authority');
    expect(await worldState()).toBe(before);
    expect(await create(writer, LOW)).toBe('created');
  });

  it('1: an organization admin grants any role, protected included', async () => {
    const admin = await actingAs('boss', WRITER, true);
    expect(await create(admin, HIGH)).toBe('created');
    expect(await create(admin, ADMIN, G2, 'second@example.test')).toBe('created');
  });

  it('1: the T157 probe is forbidden: a non-admin cannot demote a superior, or promote to one', async () => {
    const writer = await actingAs('writer', WRITER);
    await seed([
      emailGrant(a, G1, 'superior@example.test', HIGH),
      emailGrant(a, G2, 'peer@example.test', LOW),
    ]);
    const before = await worldState();
    expect(
      await fenced.changeRole(a, fenceOfActing(writer, 1), {
        id: G1,
        roleId: LOW,
        now: LATER,
        opId: 'OP1',
      }),
    ).toBe('authority');
    expect(
      await fenced.changeRole(a, fenceOfActing(writer, 1), {
        id: G2,
        roleId: HIGH,
        now: LATER,
        opId: 'OP2',
      }),
    ).toBe('authority');
    expect(
      await fenced.changeRole(a, fenceOfActing(writer, 1), {
        id: G2,
        roleId: ADMIN,
        now: LATER,
        opId: 'OP3',
      }),
    ).toBe('authority');
    expect(await worldState()).toBe(before);
    expect(
      await fenced.changeRole(a, fenceOfActing(writer, 1), {
        id: G2,
        roleId: LOW,
        now: LATER,
        opId: 'OP4',
      }),
    ).toBe('updated');
  });

  it('1: the subset is read inside the batch: a permission lost after the fence was built refuses', async () => {
    const writer = await actingAs('writer', [...WRITER, 'org:users:write']);
    const fence = fenceOfActing(writer);
    await seed([
      stmt(
        'DELETE FROM role_permission WHERE role_id = ? AND permission = ?',
        writer.roleId,
        'org:users:write',
      ),
    ]);
    expect(
      await fenced.createOrganization(a, fence, {
        id: G1,
        subject: { type: 'email', value: 'new@example.test' },
        roleId: HIGH,
        createdBy: writer.userId,
        now: NOW,
        opId: 'OPX',
      }),
    ).toBe('authority');
    expect(await rows('SELECT id FROM access_grant WHERE id = ?', G1)).toEqual([]);
  });

  it('1: a suspended actor, a revoked session and an actor of another organization refuse', async () => {
    const writer = await actingAs('writer', WRITER);
    await seed([emailGrant(a, G1, 'x@example.test', LOW)]);
    await seed([stmt('UPDATE session SET revoked_at = ? WHERE id = ?', NOW, writer.sessionId)]);
    expect(
      await fenced.deleteOrganization(a, fenceOfActing(writer, 1), { id: G1, opId: 'OP1' }),
    ).toBe('authority');
    const other = await actingAs('other', WRITER);
    await seed([
      stmt('UPDATE user_account SET status = ? WHERE id = ?', 'suspended', other.userId),
    ]);
    expect(
      await fenced.deleteOrganization(a, fenceOfActing(other, 1), { id: G1, opId: 'OP2' }),
    ).toBe('authority');
    const foreign = await actingAs('foreign', WRITER);
    expect(
      await fenced.deleteOrganization(b, fenceOfActing(foreign, 1), { id: G1, opId: 'OP3' }),
    ).toBe('authority');
    expect(await rows('SELECT id FROM access_grant WHERE id = ?', G1)).toEqual([{ id: G1 }]);
  });

  it('2: a non-admin revokes a grant whose role holds permissions it lacks', async () => {
    const writer = await actingAs('writer', WRITER);
    await seed([emailGrant(a, G1, 'departing@example.test', HIGH)]);
    expect(
      await fenced.deleteOrganization(a, fenceOfActing(writer, 1), { id: G1, opId: 'OP1' }),
    ).toMatchObject({
      outcome: 'deleted',
    });
    expect(await rows('SELECT id FROM access_grant WHERE id = ?', G1)).toEqual([]);
  });

  it('2: only an admin revokes or moves a grant of a protected role', async () => {
    const writer = await actingAs('writer', WRITER);
    const admin = await actingAs('boss', WRITER, true);
    await seed([
      emailGrant(a, G1, 'u1@example.test', ADMIN),
      emailGrant(a, G2, 'u2@example.test', ADMIN),
    ]);
    const before = await worldState();
    expect(
      await fenced.deleteOrganization(a, fenceOfActing(writer, 1), { id: G1, opId: 'OP1' }),
    ).toBe('authority');
    expect(
      await fenced.changeRole(a, fenceOfActing(writer, 1), {
        id: G1,
        roleId: LOW,
        now: LATER,
        opId: 'OP2',
      }),
    ).toBe('authority');
    expect(await worldState()).toBe(before);
    expect(
      await fenced.deleteOrganization(a, fenceOfActing(admin, 1), { id: G1, opId: 'OP3' }),
    ).toMatchObject({
      outcome: 'deleted',
    });
  });

  it('2: removing or demoting the last protected holder is refused inside the batch', async () => {
    const admin = await actingAs('boss', WRITER, true);
    uncounted =
      (await rows('SELECT id FROM identity WHERE user_id = ?', admin.userId)).map(
        (row) => (row as { id: string }).id,
      )[0] ?? uncounted;
    await seed([
      stmt('DELETE FROM access_grant WHERE id = ?', actorOf(a).grant),
      emailGrant(a, G1, 'u1@example.test', ADMIN),
    ]);
    const before = await worldState();
    expect(
      await fenced.deleteOrganization(a, fenceOfActing(admin, 1), { id: G1, opId: 'OP1' }),
    ).toBe('last_holder');
    expect(
      await fenced.changeRole(a, fenceOfActing(admin, 1), {
        id: G1,
        roleId: LOW,
        now: LATER,
        opId: 'OP2',
      }),
    ).toBe('last_holder');
    expect(await worldState()).toBe(before);
  });

  it('3: a stale grant revision answers conflict and leaves no delta', async () => {
    const writer = await actingAs('writer', WRITER);
    await seed([emailGrant(a, G1, 'x@example.test', LOW)]);
    const before = await worldState();
    expect(
      await fenced.deleteOrganization(a, fenceOfActing(writer, 7), { id: G1, opId: 'OP1' }),
    ).toBe('conflict');
    expect(
      await fenced.changeRole(a, fenceOfActing(writer, 7), {
        id: G1,
        roleId: LOW,
        now: LATER,
        opId: 'OP2',
      }),
    ).toBe('conflict');
    expect(await worldState()).toBe(before);
  });

  it('3: a change bumps the revision once and records the op id; the old fence then conflicts', async () => {
    const writer = await actingAs('writer', WRITER);
    await seed([emailGrant(a, G1, 'x@example.test', LOW)]);
    const stale = fenceOfActing(writer, 1);
    expect(
      await fenced.changeRole(a, stale, { id: G1, roleId: LOW, now: LATER, opId: 'OPCHANGE' }),
    ).toBe('updated');
    expect(await rows('SELECT revision, last_op_id FROM access_grant WHERE id = ?', G1)).toEqual([
      { revision: 2, last_op_id: 'OPCHANGE' },
    ]);
    expect(
      await fenced.changeRole(a, stale, { id: G1, roleId: LOW, now: LATER, opId: 'OPAGAIN' }),
    ).toBe('conflict');
    expect(await fenced.deleteOrganization(a, stale, { id: G1, opId: 'OPDELETE' })).toBe(
      'conflict',
    );
    expect(
      await fenced.deleteOrganization(a, fenceOfActing(writer, 2), { id: G1, opId: 'OPDELETE' }),
    ).toMatchObject({ outcome: 'deleted' });
  });

  it('3: an unknown grant is not_found and a missing role is role_scope_mismatch', async () => {
    const writer = await actingAs('writer', WRITER);
    await seed([emailGrant(a, G1, 'x@example.test', LOW)]);
    expect(
      await fenced.deleteOrganization(a, fenceOfActing(writer, 1), { id: G3, opId: 'OP1' }),
    ).toBe('not_found');
    expect(
      await fenced.changeRole(a, fenceOfActing(writer, 1), {
        id: G3,
        roleId: LOW,
        now: LATER,
        opId: 'OP2',
      }),
    ).toBe('not_found');
    await seed([role(a, '01J0ROLEPROJECTOPEN000000', 'open_project', 'project', 0)]);
    expect(
      await fenced.changeRole(a, fenceOfActing(writer, 1), {
        id: G1,
        roleId: '01J0ROLEPROJECTOPEN000000',
        now: LATER,
        opId: 'OP3',
      }),
    ).toBe('role_scope_mismatch');
    expect(await create(writer, '01J0ROLEMISSING000000000A')).toBe('role_scope_mismatch');
  });

  it('refuses a fence without a grant revision and an empty op id before any SQL', async () => {
    const writer = await actingAs('writer', WRITER);
    statements.length = 0;
    await expect(
      fenced.deleteOrganization(a, fenceOfActing(writer), { id: G1, opId: 'OP1' }),
    ).rejects.toThrow(TypeError);
    await expect(
      fenced.changeRole(a, fenceOfActing(writer), { id: G1, roleId: LOW, now: LATER, opId: 'OP1' }),
    ).rejects.toThrow(TypeError);
    await expect(
      fenced.deleteOrganization(a, fenceOfActing(writer, 1), { id: G1, opId: '' }),
    ).rejects.toThrow(TypeError);
    expect(statements).toEqual([]);
  });

  it('keeps every statement of the fenced batches and failure probes within 100 bound parameters', async () => {
    const writer = await actingAs('writer', WRITER);
    await seed([
      emailGrant(a, G1, 'x@example.test', HIGH),
      emailGrant(a, G2, 'y@example.test', LOW),
    ]);
    statements.length = 0;
    await create(writer, HIGH, G3, 'z@example.test');
    await create(writer, LOW, G3, 'z@example.test');
    await fenced.changeRole(a, fenceOfActing(writer, 1), {
      id: G2,
      roleId: HIGH,
      now: LATER,
      opId: 'OP1',
    });
    await fenced.changeRole(a, fenceOfActing(writer, 9), {
      id: G2,
      roleId: LOW,
      now: LATER,
      opId: 'OP2',
    });
    await fenced.changeRole(a, fenceOfActing(writer, 1), {
      id: G2,
      roleId: LOW,
      now: LATER,
      opId: 'OP3',
    });
    await fenced.deleteOrganization(a, fenceOfActing(writer, 9), { id: G1, opId: 'OP4' });
    await fenced.deleteOrganization(a, fenceOfActing(writer, 1), { id: G1, opId: 'OP5' });
    const manager = await actingAs('manager', ['org:users:write', 'org:read']);
    const lowManager = await actingAs('lowmanager', ['org:read']);
    await fenced.suspendUser(a, fenceOfActing(manager), { userId: U1, now: LATER });
    await fenced.suspendUser(a, fenceOfActing(manager), { userId: U1, now: LATER });
    await fenced.suspendUser(a, fenceOfActing(lowManager), { userId: U2, now: LATER });
    await fenced.reactivateUser(a, fenceOfActing(lowManager), { userId: U1, now: LATER });
    await fenced.reactivateUser(a, fenceOfActing(manager), { userId: U1, now: LATER });
    await fenced.reactivateUser(a, fenceOfActing(manager), { userId: U1, now: LATER });
    expect(statements.length).toBeGreaterThan(20);
    expect(Math.max(...statements.map((statement) => statement.params.length))).toBeLessThanOrEqual(
      100,
    );
  });

  it('a lost-in-flight concurrent change from one revision gives one winner and one conflict', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pb-grant-fence-'));
    const shared = await openMigratedDatabase({
      file: join(directory, 'store.sqlite'),
      twoOrganizations: true,
    });
    try {
      if (shared.orgs === null) throw new Error('two organizations expected');
      const org = shared.orgs.a;
      const second = await shared.second();
      const sharedActor = {
        user: '01J0ACTORUSHARED00000000AA',
        session: '01J0ACTORSSHARED0000000AA',
      };
      const hash = Buffer.from(sharedActor.session).toString('hex').padEnd(64, '0');
      await shared.executor.batch([
        ...rolesFor(org, ADMIN, true),
        ...bindings(org),
        user(org, sharedActor.user, 'shared@actor.test'),
        stmt(
          'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
          '01J0ACTORISHARED00000000AA',
          org.orgId,
          sharedActor.user,
          'oidc',
          'subject-shared',
          'shared@actor.test',
          new Date().toISOString(),
        ),
        stmt(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          org.orgId,
          ADMIN,
          'org:grants:write',
        ),
        emailGrant(org, G3, 'shared@actor.test', ADMIN),
        emailGrant(org, G1, 'target@example.test', AUDITOR),
        emailGrant(org, G2, 'keeper@example.test', ADMIN),
        user(org, U1, 'keeper@example.test'),
        stmt(
          'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          sharedActor.session,
          org.orgId,
          sharedActor.user,
          hash,
          hash,
          new Date().toISOString(),
          new Date(Date.now() + 3_600_000).toISOString(),
        ),
      ]);
      const options = {
        providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
          provider,
          anchor: ANCHOR,
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test', 'actor.test'],
        })),
        holderInput: () => ({ ...holderInput(), exclude: { identityId: '01J0NONE' } }),
      };
      const one = createFencedGrantRepository(shared.executor, options);
      const two = createFencedGrantRepository(second, options);
      const fence = mutationFence(
        {
          userId: sharedActor.user,
          sessionId: sharedActor.session,
        } as unknown as AuthenticatedActor,
        { grant: 1 },
      );
      const outcomes = await Promise.all([
        one.changeRole(org, fence, { id: G1, roleId: ADMIN_TWO, now: LATER, opId: 'OPONE' }),
        two.changeRole(org, fence, { id: G1, roleId: ADMIN, now: LATER, opId: 'OPTWO' }),
      ]);
      expect([...outcomes].sort()).toEqual(['conflict', 'updated']);
      expect(
        await shared.executor.all({
          sql: 'SELECT revision FROM access_grant WHERE id = ?',
          params: [G1],
        }),
      ).toEqual([{ revision: 2 }]);
    } finally {
      await shared.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('a busy or too-big database error surfaces and is never answered as a duplicate', async () => {
    const writer = await actingAs('writer', WRITER);
    for (const kind of ['busy', 'too_big'] as const) {
      const failing: SqlExecutor = {
        driver: executor.driver,
        all: (statement) => executor.all(statement),
        batch: () => Promise.reject(new DbError(kind, `simulated ${kind}`)),
      };
      const repository = createFencedGrantRepository(failing, {
        providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
          provider,
          anchor: ANCHOR,
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test', 'actor.test'],
        })),
        holderInput,
      });
      await expect(
        repository.createOrganization(a, fenceOfActing(writer), {
          id: G1,
          subject: { type: 'email', value: 'new@example.test' },
          roleId: LOW,
          createdBy: writer.userId,
          now: NOW,
          opId: 'OPBUSY',
        }),
      ).rejects.toThrow(/failed unclassified/);
    }
  });

  it('a real duplicate subject or id is still answered duplicate', async () => {
    const writer = await actingAs('writer', WRITER);
    expect(await create(writer, LOW)).toBe('created');
    expect(await create(writer, LOW, G2)).toBe('duplicate');
    expect(await create(writer, LOW, G1, 'other@example.test')).toBe('duplicate');
  });

  it('an id that exists in another organization is answered duplicate and nothing is stored', async () => {
    const writer = await actingAs('writer', WRITER);
    await seed([emailGrant(b, G1, 'elsewhere@example.test', ADMIN_B)]);
    const before = await worldState();
    expect(await create(writer, LOW)).toBe('duplicate');
    expect(await worldState()).toBe(before);
    expect(await rows('SELECT org_id FROM access_grant WHERE id = ?', G1)).toEqual([
      { org_id: b.orgId },
    ]);
  });

  it('exposes the grant revision: read after a change gives the new one and a fence built from it works', async () => {
    const writer = await actingAs('writer', WRITER);
    await seed([emailGrant(a, G1, 'x@example.test', LOW)]);
    const revisionOfListed = async () =>
      (await fenced.listOrganization(a)).find((grant) => grant.id === G1)?.revision;
    expect(await revisionOfListed()).toBe(1);
    expect(
      await fenced.changeRole(a, fenceOfActing(writer, 1), {
        id: G1,
        roleId: HIGH,
        now: LATER,
        opId: 'OP1',
      }),
    ).toBe('authority');
    expect(
      await fenced.changeRole(a, fenceOfActing(writer, 1), {
        id: G1,
        roleId: LOW,
        now: LATER,
        opId: 'OP2',
      }),
    ).toBe('updated');
    const revision = await revisionOfListed();
    expect(revision).toBe(2);
    expect(
      await fenced.deleteOrganization(a, fenceOfActing(writer, revision), { id: G1, opId: 'OP3' }),
    ).toMatchObject({ outcome: 'deleted' });
  });

  it('a createdBy outside the organization is refused inside the batch: nothing commits, then it throws', async () => {
    const writer = await actingAs('writer', WRITER);
    const before = await worldState();
    await expect(
      fenced.createOrganization(a, fenceOfActing(writer), {
        id: G1,
        subject: { type: 'email', value: 'new@example.test' },
        roleId: LOW,
        createdBy: UB,
        now: NOW,
        opId: 'OPCREATOR',
      }),
    ).rejects.toThrow(TypeError);
    expect(await worldState()).toBe(before);
  });

  describe('authority changing between the service reads and the batch', () => {
    let directory: string;
    let shared: MigratedDatabase;
    let org: OrgContext;
    let other: SqlExecutor;
    let beforeBatch: (() => Promise<void>) | null;
    let admin: ReturnType<typeof createAdministration>;
    const actorIds = {
      user: '01J0ACTORUSTALE00000000AA',
      session: '01J0ACTORSSTALE0000000AA',
      role: '01J0ACTORRSTALE0000000AA',
    };
    const staleActor = {
      kind: 'organization' as const,
      userId: actorIds.user,
      permissions: new Set(['org:grants:write', 'org:read', 'org:users:write']),
      isOrganizationAdmin: false,
    };

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'pb-grant-stale-'));
      shared = await openMigratedDatabase({
        file: join(directory, 'store.sqlite'),
        twoOrganizations: true,
      });
      if (shared.orgs === null) throw new Error('two organizations expected');
      org = shared.orgs.a;
      other = await shared.second();
      beforeBatch = null;
      const hash = Buffer.from(actorIds.session).toString('hex').padEnd(64, '0');
      await shared.executor.batch([
        ...rolesFor(org, ADMIN, true),
        ...bindings(org),
        user(org, actorIds.user, 'stale@actor.test'),
        stmt(
          'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
          '01J0ACTORISTALE00000000AA',
          org.orgId,
          actorIds.user,
          'oidc',
          'subject-stale',
          'stale@actor.test',
          new Date().toISOString(),
        ),
        role(org, actorIds.role, 'stale_actor', 'organization', 0),
        ...['org:grants:write', 'org:read', 'org:users:write'].map((permission) =>
          stmt(
            'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
            org.orgId,
            actorIds.role,
            permission,
          ),
        ),
        stmt(
          'INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          G3,
          org.orgId,
          'email',
          'stale@actor.test',
          'organization',
          actorIds.role,
          NOW,
          NOW,
        ),
        stmt(
          'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          actorIds.session,
          org.orgId,
          actorIds.user,
          hash,
          hash,
          new Date().toISOString(),
          new Date(Date.now() + 3_600_000).toISOString(),
        ),
        role(org, LOW, 'low', 'organization', 0),
        role(org, HIGH, 'high', 'organization', 0),
        stmt(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?), (?, ?, ?)',
          org.orgId,
          LOW,
          'org:read',
          org.orgId,
          HIGH,
          'org:users:write',
        ),
      ]);
      const barrier: SqlExecutor = {
        driver: shared.executor.driver,
        all: (statement) => shared.executor.all(statement),
        batch: async (batch) => {
          const hook = beforeBatch;
          beforeBatch = null;
          if (hook !== null) await hook();
          return shared.executor.batch(batch);
        },
      };
      let next = 0;
      admin = createAdministration({
        roles: createRoleRepository(shared.executor, { providerAnchors: [] }),
        grants: createFencedGrantRepository(barrier, {
          providerAnchors: HOLDER_PROVIDERS.map((provider) => ({
            provider,
            anchor: ANCHOR,
            emailAuthoritative: true,
            emailAuthoritativeDomains: ['example.test', 'actor.test'],
          })),
          holderInput,
        }),
        users: { get: async () => ({ id: actorIds.user }) as never },
        providers: new Map(),
        clock: fixedClock(LATER),
        ids: { ulid: () => `01J0STALEID${String(next++).padStart(15, '0')}` },
        log: () => undefined,
      });
    });

    afterEach(async () => {
      await shared.close();
      await rm(directory, { recursive: true, force: true });
    });

    const fence = (grant?: number) =>
      mutationFence(
        { userId: actorIds.user, sessionId: actorIds.session } as unknown as AuthenticatedActor,
        grant === undefined ? {} : { grant },
      );
    const grantRows = () =>
      shared.executor.all({
        sql: 'SELECT id, role_id, revision FROM access_grant ORDER BY id',
        params: [],
      });
    const dropPermission = () =>
      other
        .batch([
          stmt(
            'DELETE FROM role_permission WHERE role_id = ? AND permission = ?',
            actorIds.role,
            'org:users:write',
          ),
        ])
        .then(() => undefined);

    it('create: the actor loses a permission after the service authorized it', async () => {
      const before = JSON.stringify(await grantRows());
      beforeBatch = dropPermission;
      const result = await admin.grantOrganization(
        org,
        staleActor,
        fence(),
        {
          subject: { type: 'email', value: 'new@example.test' },
          roleId: HIGH,
        },
        apiCall,
      );
      expect(result).toEqual({ ok: false, error: 'forbidden' });
      expect(JSON.stringify(await grantRows())).toBe(before);
    });

    it('change: the actor loses a permission after the service authorized it', async () => {
      await shared.executor.batch([emailGrant(org, G1, 'x@example.test', LOW)]);
      const before = JSON.stringify(await grantRows());
      beforeBatch = dropPermission;
      expect(await admin.changeGrantRole(org, staleActor, fence(1), G1, HIGH, apiCall)).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(JSON.stringify(await grantRows())).toBe(before);
    });

    it('change: the replacement role gains a permission the actor lacks after the service read it', async () => {
      await shared.executor.batch([emailGrant(org, G1, 'x@example.test', LOW)]);
      const before = JSON.stringify(await grantRows());
      beforeBatch = () =>
        other
          .batch([
            stmt(
              'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
              org.orgId,
              HIGH,
              'org:roles:write',
            ),
          ])
          .then(() => undefined);
      expect(await admin.changeGrantRole(org, staleActor, fence(1), G1, HIGH, apiCall)).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(JSON.stringify(await grantRows())).toBe(before);
    });

    it('change: the current role gains a permission the actor lacks after the service read it', async () => {
      await shared.executor.batch([emailGrant(org, G1, 'x@example.test', LOW)]);
      const before = JSON.stringify(await grantRows());
      beforeBatch = () =>
        other
          .batch([
            stmt(
              'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
              org.orgId,
              LOW,
              'org:roles:write',
            ),
          ])
          .then(() => undefined);
      expect(await admin.changeGrantRole(org, staleActor, fence(1), G1, LOW, apiCall)).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(JSON.stringify(await grantRows())).toBe(before);
    });
  });
});

it('requires explicit grant provider anchors at construction', () => {
  // @ts-expect-error provider anchors are required
  expect(() => createFencedGrantRepository(executor, { holderInput })).toThrow(TypeError);
  expect(() =>
    createFencedGrantRepository(executor, { holderInput, providerAnchors: [] }),
  ).not.toThrow();
});

it('checks holders with database time, matching anchors and at most 100 parameters', async () => {
  await seed([
    groupGrant(a, G1, 'oidc', 'admins', ADMIN),
    membership(a, U1, 'oidc', 'admins'),
    membership(a, U2, 'oidc', 'admins'),
  ]);
  const statements: Statement[] = [];
  const providers = HOLDER_PROVIDERS.map((provider) => ({
    provider,
    anchor: ANCHOR,
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test', 'actor.test'],
  }));
  const recording = {
    ...executor,
    all: <T>(statement: Statement) => {
      statements.push(statement);
      return executor.all<T>(statement);
    },
  };
  const repository = createFencedGrantRepository(recording, {
    holderInput,
    providerAnchors: [
      ...providers,
      ...Array.from({ length: 6 }, (_, i) => ({
        provider: `extra${i}`,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      })),
    ],
  });
  expect(await repository.isProtectedHolder(a, U1)).toBe(true);
  expect(statements).toHaveLength(1);
  expect(statements[0]?.params.length).toBeLessThanOrEqual(100);
  expect(statements[0]?.sql).toContain("unixepoch('now', 'subsec')");
  await executor.batch([
    stmt(
      'UPDATE user_group SET refreshed_at = ? WHERE user_id = ?',
      new Date(Date.now() - 25 * 3600_000).toISOString(),
      U1,
    ),
  ]);
  expect(await repository.isProtectedHolder(a, U1)).toBe(false);
  const wrong = createFencedGrantRepository(executor, {
    holderInput,
    providerAnchors: providers.map((p) => ({ ...p, anchor: 'https://wrong.example.test' })),
  });
  expect(await wrong.isProtectedHolder(a, U2)).toBe(false);
});
