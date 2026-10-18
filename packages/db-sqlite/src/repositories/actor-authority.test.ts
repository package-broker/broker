import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { assertGuard, compile, db, runOrgFenced, type ProtectedHolderProvider } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { actorHolds, type ActorHoldsInput } from './actor-authority.js';

const NOW = '2026-10-15T12:00:00.000Z';
const WRITER = '01J0ROLEWRITER00000000000AA';
const ORG_WRITER = '01J0ROLEORGWRITER000000000AA';
const PA = '01J0PROJECT00000000000000A1';
const PB = '01J0PROJECT00000000000000B1';
const PX = '01J0PROJECT00000000000000X1';
const USER = '01J0USER000000000000000001';
const USER_B = '01J0USER000000000000000002';
const SESSION = '01J0SESSION000000000000001';
const SESSION_B = '01J0SESSION000000000000002';
const USER_FOREIGN = '01J0USER000000000000000009';
const SESSION_FOREIGN = '01J0SESSION000000000000009';
const P_FOREIGN = '01J0PROJECT00000000000000F1';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

const ANCHORS: readonly ProtectedHolderProvider[] = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const PERMISSION = 'project:packages:write';
const ORG_PERMISSION = 'org:settings:write';

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function hashFor(id: string) {
  return id
    .toLowerCase()
    .replace(/[^0-9a-f]/g, 'a')
    .padEnd(64, '0')
    .slice(0, 64);
}

function seedSession(id: string, userId: string, expiresAt = '2999-01-01T00:00:00.000Z') {
  const hash = hashFor(id);
  const now = new Date().toISOString();
  return stmt(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    a.orgId,
    userId,
    hash,
    hash,
    now,
    now,
    expiresAt,
  );
}

function seedGrant(id: string, email: string, roleId: string, projectId: string | null) {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
    id,
    a.orgId,
    'email',
    email,
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
    NOW,
    NOW,
  );
}

function seedRole(id: string, scope: string, permission: string) {
  return [
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)',
      id,
      a.orgId,
      id.toLowerCase(),
      id,
      scope,
    ),
    stmt(
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      a.orgId,
      id,
      permission,
    ),
  ];
}

function seedForeignSession() {
  const hash = hashFor(SESSION_FOREIGN);
  const now = new Date().toISOString();
  return stmt(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    SESSION_FOREIGN,
    b.orgId,
    USER_FOREIGN,
    hash,
    hash,
    now,
    now,
    '2999-01-01T00:00:00.000Z',
  );
}

async function epoch(): Promise<string> {
  const [row] = await executor.all<{ version: string }>(
    stmt('SELECT version FROM cache_epoch WHERE org_id = ?', a.orgId),
  );
  return row?.version ?? '';
}

async function projectName(): Promise<string | undefined> {
  const [row] = await executor.all<{ name: string }>(
    stmt('SELECT name FROM project WHERE id = ?', PA),
  );
  return row?.name;
}

const fence = (userId = USER, sessionId = SESSION): MutationFence =>
  mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});

async function commits(
  input: Omit<ActorHoldsInput, 'providerAnchors'> & Partial<ActorHoldsInput>,
  actor: MutationFence = fence(),
) {
  const guard = assertGuard(actorHolds(a, actor, { providerAnchors: ANCHORS, ...input }), a);
  const outcome = await runOrgFenced(
    executor,
    a,
    actor,
    guard,
    [stmt('UPDATE project SET name = ? WHERE org_id = ? AND id = ?', 'touched', a.orgId, PA)],
    {},
  );
  return outcome.ok;
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  await executor.batch([
    ...seedRole(WRITER, 'project', PERMISSION),
    ...seedRole(ORG_WRITER, 'organization', ORG_PERMISSION),
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      USER,
      a.orgId,
      'holder@example.test',
      'active',
    ),
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      USER_B,
      a.orgId,
      'other@example.test',
      'active',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
      PA,
      a.orgId,
      'pa',
      'pa',
      'active',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
      PB,
      a.orgId,
      'pb',
      'pb',
      'active',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
      PX,
      a.orgId,
      'px',
      'px',
      'archived',
    ),
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      a.orgId,
      'oidc',
      'oidc:https://idp.example.test',
    ),
    ...(
      [
        ['01J0IDENT00000000000000001', USER, 'holder@example.test'],
        ['01J0IDENT00000000000000002', USER_B, 'other@example.test'],
      ] as const
    ).map(([id, userId, email]) =>
      stmt(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        id,
        a.orgId,
        userId,
        'oidc',
        `subject-${id}`,
        email,
        new Date(Date.now() - 60_000).toISOString(),
      ),
    ),
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      USER_FOREIGN,
      b.orgId,
      'foreign@example.test',
      'active',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
      P_FOREIGN,
      b.orgId,
      'pf',
      'pf',
      'active',
    ),
    seedForeignSession(),
    stmt(
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      a.orgId,
      WRITER,
      ORG_PERMISSION,
    ),
    seedSession(SESSION, USER),
    seedSession(SESSION_B, USER_B),
    seedGrant('01J0GRANT000000000000000A1', 'holder@example.test', WRITER, PA),
    seedGrant('01J0GRANT000000000000000A2', 'holder@example.test', WRITER, PX),
    seedGrant('01J0GRANT000000000000000A3', 'other@example.test', WRITER, PB),
  ]);
});

afterEach(async () => {
  await database.close();
});

describe('actorHolds through assertGuard', () => {
  it('commits for a holder and bumps the epoch', async () => {
    const before = await epoch();
    expect(await commits({ permission: PERMISSION, projectId: PA })).toBe(true);
    expect(await projectName()).toBe('touched');
    expect(await epoch()).not.toBe(before);
  });

  it('rolls back after the grant is revoked', async () => {
    await executor.batch([
      stmt('DELETE FROM access_grant WHERE id = ?', '01J0GRANT000000000000000A1'),
    ]);
    expect(await commits({ permission: PERMISSION, projectId: PA })).toBe(false);
    const [row] = await executor.all<{ name: string }>(
      stmt('SELECT name FROM project WHERE id = ?', PA),
    );
    expect(row?.name).toBe('pa');
  });

  it('rolls back for a suspended user', async () => {
    await executor.batch([stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", USER)]);
    expect(await commits({ permission: PERMISSION, projectId: PA })).toBe(false);
  });

  it('rolls back for an expired session', async () => {
    await executor.batch([
      stmt('UPDATE session SET expires_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', SESSION),
    ]);
    expect(await commits({ permission: PERMISSION, projectId: PA })).toBe(false);
  });

  it('rolls back for a revoked session', async () => {
    await executor.batch([
      stmt('UPDATE session SET revoked_at = ? WHERE id = ?', '2026-10-15T11:00:00.000Z', SESSION),
    ]);
    expect(await commits({ permission: PERMISSION, projectId: PA })).toBe(false);
  });

  it('rolls back for a session owned by another user', async () => {
    const before = await epoch();
    expect(await commits({ permission: PERMISSION, projectId: PA }, fence(USER, SESSION_B))).toBe(
      false,
    );
    expect(await projectName()).toBe('pa');
    expect(await epoch()).toBe(before);
  });

  it('rolls back for a session of another organization', async () => {
    expect(
      await commits(
        { permission: PERMISSION, projectId: PA },
        fence(USER_FOREIGN, SESSION_FOREIGN),
      ),
    ).toBe(false);
    expect(await projectName()).toBe('pa');
  });

  it('rolls back when the session identity does not belong to the user', async () => {
    const foreignIdentity = '01J0IDENT00000000000000002';
    await executor.batch([
      stmt('UPDATE session SET identity_id = ? WHERE id = ?', foreignIdentity, SESSION),
    ]);
    expect(await commits({ permission: PERMISSION, projectId: PA })).toBe(false);
  });
});

describe('actorHolds scope', () => {
  it('never satisfies an org permission from a project-scope grant', async () => {
    expect(await commits({ permission: ORG_PERMISSION, projectId: null })).toBe(false);
    expect(await commits({ permission: ORG_PERMISSION, projectId: PA })).toBe(false);
  });

  it('counts an organization grant for an org permission', async () => {
    await executor.batch([
      seedGrant('01J0GRANT000000000000000A4', 'holder@example.test', ORG_WRITER, null),
    ]);
    expect(await commits({ permission: ORG_PERMISSION, projectId: null })).toBe(true);
  });

  it('gives nothing on project A from a grant on project B', async () => {
    expect(await commits({ permission: PERMISSION, projectId: PB }, fence(USER_B, SESSION_B))).toBe(
      true,
    );
    expect(await commits({ permission: PERMISSION, projectId: PA }, fence(USER_B, SESSION_B))).toBe(
      false,
    );
  });
});

describe('actorHolds project state', () => {
  it('refuses an archived project', async () => {
    expect(await commits({ permission: PERMISSION, projectId: PX })).toBe(false);
  });

  it('accepts an archived project with allowArchived', async () => {
    expect(await commits({ permission: PERMISSION, projectId: PX, allowArchived: true })).toBe(
      true,
    );
  });
});

describe('actorHolds allowArchived', () => {
  beforeEach(async () => {
    await executor.batch([
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        a.orgId,
        ORG_WRITER,
        PERMISSION,
      ),
      seedGrant('01J0GRANT000000000000000A6', 'holder@example.test', ORG_WRITER, null),
    ]);
  });

  it('still refuses an unknown project', async () => {
    expect(
      await commits({
        permission: PERMISSION,
        projectId: '01J0PROJECT0000000000000NONE',
        allowArchived: true,
      }),
    ).toBe(false);
  });

  it('still refuses a project of another organization', async () => {
    expect(
      await commits({ permission: PERMISSION, projectId: P_FOREIGN, allowArchived: true }),
    ).toBe(false);
  });
});

describe('actorHolds input validation', () => {
  const guardFor = (input: Partial<ActorHoldsInput>) =>
    actorHolds(a, fence(), {
      permission: PERMISSION,
      projectId: PA,
      providerAnchors: ANCHORS,
      ...input,
    });

  it('throws TypeError for a permission outside the catalogue', () => {
    expect(() => guardFor({ permission: 'nope:nothing' })).toThrow(TypeError);
  });

  it.each([59, 86401, 90.5, Number.NaN])('throws RangeError for idleSeconds %s', (idleSeconds) => {
    expect(() => guardFor({ idleSeconds })).toThrow(RangeError);
  });
});

describe('actorHolds idle timeout', () => {
  it('fails for a session past its idle timeout', async () => {
    const stale = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await executor.batch([
      stmt(
        'UPDATE session SET last_seen_at = ?, created_at = ? WHERE id = ?',
        stale,
        stale,
        SESSION,
      ),
    ]);
    expect(await commits({ permission: PERMISSION, projectId: PA })).toBe(false);
  });

  it('holds for a session seen within the idle timeout', async () => {
    const recent = new Date(Date.now() - 600_000).toISOString();
    await executor.batch([
      stmt('UPDATE session SET last_seen_at = ? WHERE id = ?', recent, SESSION),
    ]);
    expect(await commits({ permission: PERMISSION, projectId: PA })).toBe(true);
  });
});

describe('actorHolds provider anchors', () => {
  beforeEach(async () => {
    await executor.batch([
      stmt(
        'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
        a.orgId,
        USER,
        'oidc',
        'eng',
        new Date(Date.now() - 60_000).toISOString(),
      ),
      stmt(
        'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        '01J0GRANT000000000000000G1',
        a.orgId,
        'group',
        'eng',
        'oidc',
        'project',
        PB,
        WRITER,
        NOW,
        NOW,
      ),
    ]);
  });

  it('holds an SSO-backed group grant with the bound anchor', async () => {
    expect(await commits({ permission: PERMISSION, projectId: PB, providerAnchors: ANCHORS })).toBe(
      true,
    );
  });

  it('fails the same grant without the anchor', async () => {
    expect(await commits({ permission: PERMISSION, projectId: PB, providerAnchors: [] })).toBe(
      false,
    );
  });
});

describe('actorHolds bound parameters', () => {
  it('stays within the D1 limit with 8 anchors', () => {
    const eight: ProtectedHolderProvider[] = Array.from({ length: 8 }, (_, index) => ({
      provider: `idp${index}`,
      anchor: `oidc:https://idp${index}.example.test`,
      emailAuthoritative: index % 2 === 0,
      emailAuthoritativeDomains: ['example.test'],
    }));
    const count = (providerAnchors: readonly ProtectedHolderProvider[], projectId: string | null) =>
      compile(
        db
          .selectFrom('organization')
          .select('organization.id')
          .where(actorHolds(a, fence(), { permission: PERMISSION, projectId, providerAnchors })),
      ).params.length;
    for (const projectId of [PA, null]) {
      expect(count(eight, projectId)).toBeLessThanOrEqual(100);
      expect(count(eight, projectId)).toBe(count(eight.slice(0, 1), projectId));
    }
  });
});
