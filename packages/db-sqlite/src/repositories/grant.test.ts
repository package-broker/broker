import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GrantRepository } from '@package-broker/core/db/grants';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { compile, db, protectedHolder } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createGrantRepository, type ProtectedHolderInput } from './grant.js';

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
    })),
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
let grants: GrantRepository;

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
  grants = createGrantRepository(executor, { holderInput });
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
    await rows('SELECT id, revoked_at FROM session ORDER BY id'),
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
      },
      {
        id: G1,
        subject: { type: 'email', value: 'u1@example.test' },
        roleId: ADMIN,
        createdBy: U1,
        createdAt: NOW,
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
    await createGrantRepository(counted.executor, { holderInput }).listOrganization(a);
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
      },
      {
        id: G2,
        subject: { type: 'group', provider: 'oidc', value: 'Admins' },
        roleId: AUDITOR,
        createdBy: null,
        createdAt: NOW,
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
    expect(await rows('SELECT id FROM access_grant')).toEqual([]);
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
    const repository = createGrantRepository(counted.executor, { holderInput });
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
    expect(await rows('SELECT id, created_by FROM access_grant')).toEqual([
      { id: G1, created_by: U1 },
    ]);
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
    await createGrantRepository(counted.executor, { holderInput }).createOrganization(
      a,
      email(G1, 'x@example.test'),
    );
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
    expect(await rows('SELECT id FROM access_grant')).toEqual([{ id: G1 }]);
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
    await createGrantRepository(counted.executor, { holderInput }).deleteOrganization(a, G1);
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
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
    expect(await rows('SELECT role_id FROM access_grant')).toEqual([
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
    await createGrantRepository(counted.executor, { holderInput }).changeRole(a, G1, ADMIN, LATER);
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
      await createGrantRepository(counted.executor, { holderInput }).suspendUser(a, U2, LATER),
    ).toBe('suspended');
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
    expect(await statusOf(U2)).toBe('suspended');
    expect(await rows('SELECT id, revoked_at FROM session ORDER BY id')).toEqual([
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
    expect(await rows('SELECT revoked_at FROM session')).toEqual([{ revoked_at: null }]);
  });

  it('5: reactivation restores active and leaves the revoked sessions revoked', async () => {
    await seed([session(a, '01J0SESSION0000000000000001', U2)]);
    expect(await grants.suspendUser(a, U2, LATER)).toBe('suspended');
    expect(await grants.reactivateUser(a, U2, '2026-10-15T14:00:00.000Z')).toBe(true);
    expect(await rows('SELECT status, email FROM user_account WHERE id = ?', U2)).toEqual([
      { status: 'active', email: 'u2@example.test' },
    ]);
    expect(await rows('SELECT revoked_at FROM session')).toEqual([{ revoked_at: LATER }]);
    expect(await grants.reactivateUser(a, U2, '2026-10-15T15:00:00.000Z')).toBe(false);
  });

  it('suspending a suspended user answers suspended and does not rewrite updated_at', async () => {
    expect(await grants.suspendUser(a, U2, NOW)).toBe('suspended');
    expect(await grants.suspendUser(a, U2, LATER)).toBe('suspended');
    expect(await rows('SELECT updated_at FROM user_account WHERE id = ?', U2)).toEqual([
      { updated_at: NOW },
    ]);
  });

  it('a user suspended by a rival connection answers suspended, not last_holder', async () => {
    await seed([emailGrant(a, G1, 'u1@example.test', ADMIN)]);
    await executor.all(stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U1));
    expect(await grants.suspendUser(a, U1, LATER)).toBe('suspended');
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
    expect(await grants.reactivateUser(a, UB, LATER)).toBe(false);
    expect(await grants.reactivateUser(a, '01J0USER00000000000000ZZZZ', LATER)).toBe(false);
    expect(await snapshot()).toBe(before);
  });

  it('reactivateUser is false for an active user and one statement', async () => {
    const counted = countCalls(executor);
    expect(
      await createGrantRepository(counted.executor, { holderInput }).reactivateUser(a, U1, LATER),
    ).toBe(false);
    expect(counted.counts().all + counted.counts().batch).toBe(1);
  });

  it('rejects a malformed timestamp before SQL', async () => {
    await expect(grants.suspendUser(a, U1, 'now')).rejects.toThrow(TypeError);
    await expect(grants.reactivateUser(a, U1, 'now')).rejects.toThrow(TypeError);
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
  let first: GrantRepository;
  let second: GrantRepository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-grants-'));
    shared = await openMigratedDatabase({
      file: join(directory, 'store.sqlite'),
      twoOrganizations: true,
    });
    if (shared.orgs === null) throw new Error('two organizations expected');
    org = shared.orgs.a;
    await shared.executor.batch([...rolesFor(org, ADMIN, true), ...bindings(org)]);
    first = createGrantRepository(shared.executor, { holderInput });
    second = createGrantRepository(await shared.second(), { holderInput });
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
          .where((eb) => protectedHolder(org, eb.ref('holder.id'), holderInput()))
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
