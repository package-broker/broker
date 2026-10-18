import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectAdministration } from '@package-broker/core/authz/project-administration';
import { fixedClock } from '@package-broker/core/ids';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import type { ProtectedHolderProvider } from '../kysely.js';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createProjectGrantRepository,
  projectGrantKey,
  projectGrantRoleKey,
} from './project-grant.js';
import type { ProjectGrantRepository } from './project-grant.js';
import { createGrantRepository } from './grant.js';

const ANCHORS: readonly ProtectedHolderProvider[] = [
  { provider: 'oidc', anchor: 'oidc:https://idp.example.test', emailAuthoritative: true },
  { provider: 'okta', anchor: 'oidc:https://okta.example.test', emailAuthoritative: true },
];
const HOUR = 3_600_000;
const SEED_AT = Date.now();
const ago = (ms: number) => new Date(SEED_AT - ms).toISOString();

const NOW = '2026-10-15T12:00:00.000Z';
const LATER = '2026-10-15T13:00:00.000Z';

const OWNER = '01J0ROLEOWNER0000000000AA';
const VIEWER = '01J0ROLEVIEWER000000000AA';
const BROAD = '01J0ROLEBROAD0000000000AA';
const ORG_ADMIN = '01J0ROLEORGADMIN00000000AA';
const ORG_PLAIN = '01J0ROLEORGPLAIN00000000AA';
const ROLE_B = '01J0ROLEPROJECT000000000BB';

const P1 = '01J0PROJECT00000000000000A1';
const P2 = '01J0PROJECT00000000000000A2';
const P_ARCHIVED = '01J0PROJECT00000000000000A3';
const P_B = '01J0PROJECT00000000000000B1';

const ACTOR = '01J0USER000000000000000001';
const OTHER = '01J0USER000000000000000002';
const ORG_ACTOR = '01J0USER000000000000000003';
const B_USER = '01J0USER00000000000000000B';

const S_ACTOR = '01J0SESSION000000000000001';
const S_OTHER = '01J0SESSION000000000000002';
const S_ORG = '01J0SESSION000000000000003';

const G_ACTOR = '01J0GRANT000000000000000A1';
const G_TARGET = '01J0GRANT000000000000000A2';
const G_ORG = '01J0GRANT000000000000000A3';
const G_ARCH_ACTOR = '01J0GRANT000000000000000A4';
const G_ARCH_TARGET = '01J0GRANT000000000000000A5';
const G_P2_TARGET = '01J0GRANT000000000000000A6';
const G_B = '01J0GRANT000000000000000B1';
const S_B = '01J0SESSION00000000000000B1';
const G_NEW = '01J0GRANT000000000000000A7';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let repository: ProjectGrantRepository;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function role(org: OrgContext, id: string, key: string, scope: string, ...permissions: string[]) {
  return [
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0)',
      id,
      org.orgId,
      key,
      key,
      scope,
    ),
    ...permissions.map((permission) =>
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        org.orgId,
        id,
        permission,
      ),
    ),
  ];
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

function project(org: OrgContext, id: string, slug: string, status = 'active'): Statement {
  return stmt(
    'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
    id,
    org.orgId,
    slug,
    slug,
    status,
  );
}

function session(org: OrgContext, id: string, userId: string): Statement {
  const hash = id
    .toLowerCase()
    .replace(/[^0-9a-f]/g, 'a')
    .padEnd(64, '0')
    .slice(0, 64);
  return stmt(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    userId,
    hash,
    hash,
    new Date().toISOString(),
    new Date().toISOString(),
    '2999-01-01T00:00:00.000Z',
  );
}

function grant(
  org: OrgContext,
  id: string,
  email: string,
  roleId: string,
  projectId: string | null,
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

function identity(
  org: OrgContext,
  id: string,
  userId: string,
  email: string,
  options: { provider?: string; verified?: number; validatedAt?: string } = {},
): Statement {
  return stmt(
    'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `01J0IDENT0000000000000${id}`,
    org.orgId,
    userId,
    options.provider ?? 'oidc',
    `subject-${id}`,
    email,
    options.verified ?? 1,
    options.validatedAt ?? ago(60_000),
  );
}

function member(
  userId: string,
  provider: string,
  group: string,
  refreshedAt = ago(60_000),
  org = a,
): Statement {
  return stmt(
    'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
    org.orgId,
    userId,
    provider,
    group,
    refreshedAt,
  );
}

function groupGrant(id: string, provider: string, group: string, roleId = OWNER): Statement {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    a.orgId,
    'group',
    group,
    provider,
    'project',
    P1,
    roleId,
    NOW,
    NOW,
  );
}

function fenceFor(
  userId: string,
  sessionId: string,
  expected: Record<string, number> = {},
): MutationFence {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, expected);
}

const actorFence = (expected: Record<string, number> = {}) => fenceFor(ACTOR, S_ACTOR, expected);

async function rows<R = Record<string, unknown>>(sql: string, ...params: Statement['params']) {
  return executor.all<R>(stmt(sql, ...params));
}

async function grantRow(id: string) {
  return (
    await rows<{
      role_id: string;
      revision: number;
      updated_at: string;
      last_op_id: string | null;
    }>('SELECT role_id, revision, updated_at, last_op_id FROM access_grant WHERE id = ?', id)
  )[0];
}

async function snapshot(): Promise<string> {
  return JSON.stringify([
    await rows('SELECT * FROM access_grant ORDER BY id'),
    await rows('SELECT * FROM access_mutation_guard'),
    await rows('SELECT * FROM cache_epoch ORDER BY org_id'),
    await rows('SELECT * FROM epoch_log'),
  ]);
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  repository = createProjectGrantRepository(executor);
  await executor.batch([
    ...role(
      a,
      OWNER,
      'owner',
      'project',
      'project:grants:write',
      'project:read',
      'project:packages:write',
    ),
    ...role(a, VIEWER, 'viewer', 'project', 'project:read'),
    ...role(
      a,
      BROAD,
      'broad',
      'project',
      'project:read',
      'project:packages:write',
      'project:tokens:create',
    ),
    ...role(a, ORG_ADMIN, 'org_admin', 'organization', 'project:grants:write', 'project:read'),
    ...role(a, ORG_PLAIN, 'org_plain', 'organization', 'project:read'),
    ...role(b, ROLE_B, 'owner', 'project', 'project:read', 'project:grants:write'),
    user(a, ACTOR, 'actor@example.test'),
    user(a, OTHER, 'other@example.test'),
    user(a, ORG_ACTOR, 'orgadmin@example.test'),
    user(b, B_USER, 'b@example.test'),
    project(a, P1, 'one'),
    project(a, P2, 'two'),
    project(a, P_ARCHIVED, 'archived', 'archived'),
    project(b, P_B, 'bproject'),
    session(a, S_ACTOR, ACTOR),
    session(a, S_OTHER, OTHER),
    session(a, S_ORG, ORG_ACTOR),
    session(b, S_B, B_USER),
    grant(b, G_B, 'b@example.test', ROLE_B, P_B),
    grant(b, '01J0GRANT000000000000000B2', 'victim@example.test', ROLE_B, P_B),
    stmt('CREATE TABLE epoch_log (n INTEGER)'),
    stmt(
      'CREATE TRIGGER epoch_bumped AFTER UPDATE ON cache_epoch BEGIN INSERT INTO epoch_log (n) VALUES (1); END',
    ),
    ...[a, b].flatMap((org) =>
      ANCHORS.map((entry) =>
        stmt(
          'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
          org.orgId,
          entry.provider,
          entry.anchor,
        ),
      ),
    ),
    identity(a, 'I1', ACTOR, 'actor@example.test'),
    identity(a, 'I2', OTHER, 'other@example.test'),
    identity(a, 'I3', ORG_ACTOR, 'orgadmin@example.test'),
    identity(b, 'I4', B_USER, 'b@example.test'),
    grant(a, G_ACTOR, 'actor@example.test', OWNER, P1),
    grant(a, G_TARGET, 'target@example.test', VIEWER, P1),
    grant(a, G_ORG, 'orgadmin@example.test', ORG_ADMIN, null),
    grant(a, G_ARCH_ACTOR, 'actor@example.test', OWNER, P_ARCHIVED),
    grant(a, G_ARCH_TARGET, 'target@example.test', BROAD, P_ARCHIVED),
    grant(a, G_P2_TARGET, 'target@example.test', VIEWER, P2),
  ]);
});

afterEach(async () => {
  await database.close();
});

const email = (value: string) => ({ type: 'email', value }) as const;

function createInput(overrides: Partial<Parameters<ProjectGrantRepository['create']>[2]> = {}) {
  return {
    id: G_NEW,
    projectId: P1,
    subject: email('new@example.test'),
    roleId: VIEWER,
    now: NOW,
    providerAnchors: ANCHORS,
    ...overrides,
  };
}

describe('project grant create', () => {
  it('stores a project-scope grant with the actor as creator', async () => {
    expect(await repository.create(a, actorFence(), createInput())).toBe('created');
    const stored = await rows<Record<string, unknown>>(
      'SELECT scope, project_id, role_id, subject_value, created_by, revision FROM access_grant WHERE id = ?',
      G_NEW,
    );
    expect(stored).toEqual([
      {
        scope: 'project',
        project_id: P1,
        role_id: VIEWER,
        subject_value: 'new@example.test',
        created_by: ACTOR,
        revision: 1,
      },
    ]);
    expect(await rows('SELECT * FROM access_mutation_guard')).toEqual([]);
  });

  it('stores a group subject with its provider', async () => {
    const outcome = await repository.create(
      a,
      actorFence(),
      createInput({ subject: { type: 'group', provider: 'oidc', value: 'Platform Team' } }),
    );
    expect(outcome).toBe('created');
    expect(
      await rows(
        'SELECT subject_type, subject_provider, subject_value FROM access_grant WHERE id = ?',
        G_NEW,
      ),
    ).toEqual([
      { subject_type: 'group', subject_provider: 'oidc', subject_value: 'Platform Team' },
    ]);
  });

  it('refuses a role of another organization and stores nothing', async () => {
    const before = await snapshot();
    expect(await repository.create(a, actorFence(), createInput({ roleId: ROLE_B }))).toBe(
      'role_scope_mismatch',
    );
    expect(await snapshot()).toBe(before);
  });

  it('refuses an organization-scoped role on a project grant', async () => {
    const before = await snapshot();
    expect(await repository.create(a, actorFence(), createInput({ roleId: ORG_PLAIN }))).toBe(
      'role_scope_mismatch',
    );
    expect(await snapshot()).toBe(before);
  });

  it('refuses an unknown role id', async () => {
    expect(await repository.create(a, actorFence(), createInput({ roleId: 'missing' }))).toBe(
      'role_scope_mismatch',
    );
  });

  it('refuses a project of another organization for an organization A actor', async () => {
    const before = await snapshot();
    expect(
      await repository.create(a, actorFence(), createInput({ projectId: P_B, roleId: ROLE_B })),
    ).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('refuses an organization B actor who writes into an organization A project', async () => {
    const before = await snapshot();
    const outsider = fenceFor(B_USER, S_B);
    expect(await repository.create(a, outsider, createInput())).toBe('forbidden');
    expect(
      await repository.create(b, outsider, createInput({ projectId: P1, roleId: ROLE_B })),
    ).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('grants authority through a fresh group membership of a verified provider', async () => {
    await executor.batch([
      member(OTHER, 'oidc', 'Ops'),
      groupGrant('01J0GRANT000000000000000AC', 'oidc', 'Ops'),
    ]);
    expect(await repository.create(a, fenceFor(OTHER, S_OTHER), createInput())).toBe('created');
    expect(await rows('SELECT count(*) AS n FROM epoch_log')).toEqual([{ n: 1 }]);
  });

  it('does not let a group of another provider, or of another organization, satisfy a group grant', async () => {
    await executor.batch([
      member(OTHER, 'okta', 'Ops'),
      member(OTHER, 'oidc', 'Ops', ago(60_000), b),
      groupGrant('01J0GRANT000000000000000AC', 'oidc', 'Ops'),
    ]);
    const before = await snapshot();
    expect(await repository.create(a, fenceFor(OTHER, S_OTHER), createInput())).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('stops honouring a group membership older than 24 hours', async () => {
    await executor.batch([
      member(OTHER, 'oidc', 'Ops', ago(25 * HOUR)),
      groupGrant('01J0GRANT000000000000000AC', 'oidc', 'Ops'),
    ]);
    const before = await snapshot();
    expect(await repository.create(a, fenceFor(OTHER, S_OTHER), createInput())).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('stops honouring a group grant when the identity behind it is stale', async () => {
    await executor.batch([
      member(OTHER, 'oidc', 'Ops'),
      groupGrant('01J0GRANT000000000000000AC', 'oidc', 'Ops'),
      stmt('UPDATE identity SET validated_at = ? WHERE user_id = ?', ago(25 * HOUR), OTHER),
    ]);
    const before = await snapshot();
    expect(await repository.create(a, fenceFor(OTHER, S_OTHER), createInput())).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('refuses when the provider anchor was rebound or is not configured', async () => {
    await executor.batch([
      stmt(
        "UPDATE identity_provider_binding SET anchor = 'oidc:https://other.example.test' WHERE provider = 'oidc' AND org_id = ?",
        a.orgId,
      ),
    ]);
    const rebound = await snapshot();
    expect(await repository.create(a, actorFence(), createInput())).toBe('forbidden');
    expect(await snapshot()).toBe(rebound);
    await executor.batch([
      stmt(
        "UPDATE identity_provider_binding SET anchor = 'oidc:https://idp.example.test' WHERE provider = 'oidc' AND org_id = ?",
        a.orgId,
      ),
    ]);
    expect(await repository.create(a, actorFence(), createInput({ providerAnchors: [] }))).toBe(
      'forbidden',
    );
  });

  it('refuses a changed or unverified e-mail identity', async () => {
    await executor.batch([
      stmt("UPDATE identity SET email = 'moved@example.test' WHERE user_id = ?", ACTOR),
    ]);
    const before = await snapshot();
    expect(await repository.create(a, actorFence(), createInput())).toBe('forbidden');
    expect(await snapshot()).toBe(before);
    await executor.batch([
      stmt(
        "UPDATE identity SET email = 'actor@example.test', email_verified = 0 WHERE user_id = ?",
        ACTOR,
      ),
    ]);
    const unverified = await snapshot();
    expect(await repository.create(a, actorFence(), createInput())).toBe('forbidden');
    expect(await snapshot()).toBe(unverified);
  });

  it('ignores a project grant that points at an organization-scoped role', async () => {
    await executor.batch([
      grant(a, '01J0GRANT000000000000000AD', 'other@example.test', ORG_ADMIN, P1),
    ]);
    const before = await snapshot();
    expect(await repository.create(a, fenceFor(OTHER, S_OTHER), createInput())).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('refuses an idle-expired session and leaves storage unchanged', async () => {
    const idle = new Date(Date.now() - 3_600_000 - 1000).toISOString();
    await executor.batch([
      stmt('UPDATE session SET last_seen_at = ?, created_at = ? WHERE id = ?', idle, idle, S_ACTOR),
    ]);
    const before = await snapshot();
    expect(await repository.create(a, actorFence(), createInput())).toBe('forbidden');
    expect(await snapshot()).toBe(before);
    await executor.batch([stmt('UPDATE session SET last_seen_at = NULL WHERE id = ?', S_ACTOR)]);
    expect(await repository.create(a, actorFence(), createInput())).toBe('forbidden');
    await executor.batch([
      stmt('UPDATE session SET created_at = ? WHERE id = ?', new Date().toISOString(), S_ACTOR),
    ]);
    expect(await repository.create(a, actorFence(), createInput())).toBe('created');
  });

  it('answers duplicate for the same email on the same project', async () => {
    expect(await repository.create(a, actorFence(), createInput())).toBe('created');
    const before = await snapshot();
    expect(
      await repository.create(a, actorFence(), createInput({ id: '01J0GRANT000000000000000A8' })),
    ).toBe('duplicate');
    expect(await snapshot()).toBe(before);
    expect(await rows('SELECT * FROM access_mutation_guard')).toEqual([]);
    expect(
      await rows('SELECT id FROM access_grant WHERE subject_value = ?', 'new@example.test'),
    ).toHaveLength(1);
  });

  it('answers duplicate for an existing grant id', async () => {
    const before = await snapshot();
    expect(await repository.create(a, actorFence(), createInput({ id: G_TARGET }))).toBe(
      'duplicate',
    );
    expect(await snapshot()).toBe(before);
  });

  it('answers duplicate for the same group on the same project and allows another provider', async () => {
    const group = (provider: string) => ({ type: 'group', provider, value: 'Ops' }) as const;
    expect(await repository.create(a, actorFence(), createInput({ subject: group('oidc') }))).toBe(
      'created',
    );
    expect(
      await repository.create(
        a,
        actorFence(),
        createInput({ id: '01J0GRANT000000000000000A8', subject: group('oidc') }),
      ),
    ).toBe('duplicate');
    expect(
      await repository.create(
        a,
        actorFence(),
        createInput({ id: '01J0GRANT000000000000000A9', subject: group('okta') }),
      ),
    ).toBe('created');
  });

  it('allows the same subject on two projects', async () => {
    const owner2 = '01J0GRANT000000000000000AB';
    await executor.batch([grant(a, owner2, 'actor@example.test', OWNER, P2)]);
    expect(await repository.create(a, actorFence(), createInput())).toBe('created');
    expect(
      await repository.create(
        a,
        actorFence(),
        createInput({ id: '01J0GRANT000000000000000A8', projectId: P2, providerAnchors: ANCHORS }),
      ),
    ).toBe('created');
  });

  it('refuses an actor without project:grants:write on the project', async () => {
    const before = await snapshot();
    expect(await repository.create(a, fenceFor(OTHER, S_OTHER), createInput())).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('refuses an actor whose only authority is on another project', async () => {
    expect(await repository.create(a, actorFence(), createInput({ projectId: P2 }))).toBe(
      'forbidden',
    );
  });

  it('accepts authority inherited from an organization grant', async () => {
    expect(await repository.create(a, fenceFor(ORG_ACTOR, S_ORG), createInput())).toBe('created');
  });

  it('refuses a role whose permissions exceed the actor', async () => {
    const before = await snapshot();
    expect(await repository.create(a, actorFence(), createInput({ roleId: BROAD }))).toBe(
      'forbidden',
    );
    expect(await snapshot()).toBe(before);
  });

  it('refuses when the actor session is revoked, expired, foreign or unknown', async () => {
    await executor.batch([stmt('UPDATE session SET revoked_at = ? WHERE id = ?', NOW, S_ACTOR)]);
    expect(await repository.create(a, actorFence(), createInput())).toBe('forbidden');
    await executor.batch([
      stmt(
        'UPDATE session SET revoked_at = NULL, expires_at = ? WHERE id = ?',
        '2000-01-01T00:00:00.000Z',
        S_ACTOR,
      ),
    ]);
    expect(await repository.create(a, actorFence(), createInput())).toBe('forbidden');
    expect(await repository.create(a, fenceFor(ACTOR, S_OTHER), createInput())).toBe('forbidden');
    expect(await repository.create(a, fenceFor(ACTOR, 'nope'), createInput())).toBe('forbidden');
  });

  it('refuses a suspended actor', async () => {
    await executor.batch([
      stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", ACTOR),
    ]);
    expect(await repository.create(a, actorFence(), createInput())).toBe('forbidden');
  });

  it('refuses an archived project', async () => {
    expect(await repository.create(a, actorFence(), createInput({ projectId: P_ARCHIVED }))).toBe(
      'forbidden',
    );
  });

  it('rejects a group provider that is not configured or is reserved, storing nothing', async () => {
    const before = await snapshot();
    for (const provider of ['dex', 'local']) {
      const subject = { type: 'group', provider, value: 'Ops' } as const;
      await expect(repository.create(a, actorFence(), createInput({ subject }))).rejects.toThrow(
        TypeError,
      );
    }
    const local = [...ANCHORS, { provider: 'local', anchor: 'x', emailAuthoritative: false }];
    await expect(
      repository.create(
        a,
        actorFence(),
        createInput({
          providerAnchors: local,
          subject: { type: 'group', provider: 'local', value: 'Ops' },
        }),
      ),
    ).rejects.toThrow(TypeError);
    expect(await snapshot()).toBe(before);
  });

  it('applies the configured idle window with unixepoch arithmetic', async () => {
    const short = createProjectGrantRepository(executor, { idleSeconds: 60 });
    await executor.batch([
      stmt('UPDATE session SET last_seen_at = ? WHERE id = ?', ago(120_000), S_ACTOR),
    ]);
    const before = await snapshot();
    expect(await short.create(a, actorFence(), createInput())).toBe('forbidden');
    expect(await snapshot()).toBe(before);
    expect(await repository.create(a, actorFence(), createInput())).toBe('created');
    for (const bad of [59, 86401, 1.5, Number.NaN]) {
      expect(() => createProjectGrantRepository(executor, { idleSeconds: bad })).toThrow(
        RangeError,
      );
    }
  });

  it('answers conflict when the state changes between the probe and the diagnosis', async () => {
    const racing: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      batch: (statements) => executor.batch(statements),
      all: async (statement) => {
        if (statement.sql.includes('role_current')) {
          await executor.batch([
            stmt('UPDATE access_grant SET revision = 7 WHERE id = ?', G_TARGET),
          ]);
        }
        return executor.all(statement);
      },
    } as SqlExecutor;
    const raced = createProjectGrantRepository(racing);
    const fence = actorFence({
      [projectGrantKey(G_TARGET)]: 7,
      [projectGrantRoleKey(OWNER)]: 1,
    });
    expect(
      await raced.changeRole(a, fence, {
        id: G_TARGET,
        projectId: P1,
        roleId: OWNER,
        now: LATER,
        providerAnchors: ANCHORS,
      }),
    ).toBe('conflict');
    expect((await grantRow(G_TARGET))?.role_id).toBe(VIEWER);
  });

  it('rejects malformed input before any SQL', async () => {
    await expect(
      repository.create(a, actorFence(), createInput({ subject: email('Upper@Example.test') })),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.create(a, actorFence(), createInput({ now: '2026-10-15 12:00:00' })),
    ).rejects.toThrow(TypeError);
    await expect(
      repository.create(
        a,
        actorFence(),
        createInput({ subject: { type: 'group', provider: 'oidc', value: ' padded ' } }),
      ),
    ).rejects.toThrow(TypeError);
  });

  it('requires a fence issued by mutationFence', async () => {
    await expect(
      repository.create(
        a,
        { userId: ACTOR, sessionId: S_ACTOR } as unknown as MutationFence,
        createInput(),
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe('project grant change role', () => {
  const input = (overrides: Partial<Parameters<ProjectGrantRepository['changeRole']>[2]> = {}) => ({
    id: G_TARGET,
    projectId: P1,
    roleId: OWNER,
    now: LATER,
    providerAnchors: ANCHORS,
    ...overrides,
  });
  const roleRevisions = Object.fromEntries(
    [OWNER, VIEWER, BROAD, ORG_PLAIN, ROLE_B].map((id) => [projectGrantRoleKey(id), 1]),
  );
  const fence = (revision = 1, roleRevision = 1) =>
    actorFence({
      ...roleRevisions,
      [projectGrantRoleKey(OWNER)]: roleRevision,
      [projectGrantKey(G_TARGET)]: revision,
    });

  it('changes the role, bumps the revision and stamps an operation id', async () => {
    expect(await repository.changeRole(a, fence(), input())).toBe('updated');
    const row = await grantRow(G_TARGET);
    expect(row).toMatchObject({ role_id: OWNER, revision: 2, updated_at: LATER });
    expect(row?.last_op_id).toEqual(expect.any(String));
    expect(await rows('SELECT count(*) AS n FROM epoch_log')).toEqual([{ n: 1 }]);
  });

  it('answers conflict for a stale revision and changes nothing', async () => {
    expect(await repository.changeRole(a, fence(), input())).toBe('updated');
    const before = await snapshot();
    expect(await repository.changeRole(a, fence(1), input({ roleId: VIEWER }))).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('answers conflict when the revision is ahead of the stored one', async () => {
    expect(await repository.changeRole(a, fence(5), input())).toBe('conflict');
  });

  it('answers not_found for a missing grant, an organization grant and another project', async () => {
    const unknown = actorFence({ ...roleRevisions, [projectGrantKey('missing')]: 1 });
    expect(await repository.changeRole(a, unknown, input({ id: 'missing' }))).toBe('not_found');
    const org = actorFence({ ...roleRevisions, [projectGrantKey(G_ORG)]: 1 });
    expect(await repository.changeRole(a, org, input({ id: G_ORG }))).toBe('not_found');
    const other = actorFence({ ...roleRevisions, [projectGrantKey(G_P2_TARGET)]: 1 });
    expect(await repository.changeRole(a, other, input({ id: G_P2_TARGET }))).toBe('not_found');
  });

  it('refuses a new role of another organization or of organization scope', async () => {
    const before = await snapshot();
    expect(await repository.changeRole(a, fence(), input({ roleId: ROLE_B }))).toBe(
      'role_scope_mismatch',
    );
    expect(await repository.changeRole(a, fence(), input({ roleId: ORG_PLAIN }))).toBe(
      'role_scope_mismatch',
    );
    expect(await snapshot()).toBe(before);
  });

  it('refuses a new role that exceeds the actor permissions', async () => {
    const before = await snapshot();
    expect(await repository.changeRole(a, fence(), input({ roleId: BROAD }))).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('refuses when the current role exceeds the actor permissions', async () => {
    const target = actorFence({ ...roleRevisions, [projectGrantKey(G_ARCH_TARGET)]: 1 });
    await executor.batch([stmt("UPDATE project SET status = 'active' WHERE id = ?", P_ARCHIVED)]);
    const before = await snapshot();
    expect(
      await repository.changeRole(
        a,
        target,
        input({ id: G_ARCH_TARGET, projectId: P_ARCHIVED, roleId: VIEWER }),
      ),
    ).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('refuses an actor without authority and an archived project', async () => {
    const before = await snapshot();
    const foreign = fenceFor(OTHER, S_OTHER, { ...roleRevisions, [projectGrantKey(G_TARGET)]: 1 });
    expect(await repository.changeRole(a, foreign, input())).toBe('forbidden');
    const archived = actorFence({ ...roleRevisions, [projectGrantKey(G_ARCH_TARGET)]: 1 });
    expect(
      await repository.changeRole(
        a,
        archived,
        input({ id: G_ARCH_TARGET, projectId: P_ARCHIVED, roleId: VIEWER }),
      ),
    ).toBe('forbidden');
    expect(await snapshot()).toBe(before);
  });

  it('answers conflict for a stale role revision and changes nothing', async () => {
    const before = await snapshot();
    expect(await repository.changeRole(a, fence(1, 9), input())).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('answers not_found, not forbidden, for a grant of another project holding a wider role', async () => {
    const wide = '01J0GRANT000000000000000AE';
    await executor.batch([grant(a, wide, 'wide@example.test', BROAD, P2)]);
    const target = actorFence({ ...roleRevisions, [projectGrantKey(wide)]: 1 });
    expect(await repository.changeRole(a, target, input({ id: wide, roleId: VIEWER }))).toBe(
      'not_found',
    );
  });

  it('cannot reach a grant of organization B from organization A and leaves it unchanged', async () => {
    const before = JSON.stringify(
      await rows('SELECT * FROM access_grant WHERE org_id = ?', b.orgId),
    );
    const target = actorFence({ ...roleRevisions, [projectGrantKey(G_B)]: 1 });
    expect(
      await repository.changeRole(
        a,
        target,
        input({ id: G_B, projectId: P_B, providerAnchors: ANCHORS }),
      ),
    ).toBe('forbidden');
    expect(await repository.changeRole(a, target, input({ id: G_B }))).toBe('not_found');
    expect(JSON.stringify(await rows('SELECT * FROM access_grant WHERE org_id = ?', b.orgId))).toBe(
      before,
    );
  });

  it('requires the fence to carry the target revision', async () => {
    await expect(repository.changeRole(a, actorFence(), input())).rejects.toThrow(TypeError);
  });
});

describe('project grant delete', () => {
  const fence = (revision = 1, id = G_TARGET) => actorFence({ [projectGrantKey(id)]: revision });

  async function revokeWithCallback() {
    const callback = vi.fn();
    const service = createProjectAdministration({
      grants: repository,
      providers: new Map(ANCHORS.map(({ provider }) => [provider, {}])),
      providerAnchors: ANCHORS,
      clock: fixedClock(NOW),
      ids: { ulid: () => G_NEW },
      log: vi.fn(),
      onCreatorOffboarded: callback,
    });
    const result = await service.revoke(
      a,
      {
        kind: 'project',
        userId: ACTOR,
        orgId: a.orgId,
        projectId: P1,
        permissions: new Set(['project:grants:write']),
      },
      fence(),
      P1,
      G_TARGET,
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(await grantRow(G_TARGET)).toBeUndefined();
    return callback;
  }

  it('suppresses the callback when an organization email grant retains access', async () => {
    await executor.batch([
      user(a, OTHER + 'target', 'target@example.test'),
      grant(a, G_NEW, 'target@example.test', ORG_PLAIN, null),
    ]);
    expect(await revokeWithCallback()).not.toHaveBeenCalled();
  });

  it('suppresses the callback when an organization group grant retains access', async () => {
    await executor.batch([
      user(a, OTHER + 'target', 'target@example.test'),
      groupGrant(G_NEW, 'oidc', 'team', ORG_PLAIN),
      stmt("UPDATE access_grant SET scope = 'organization', project_id = NULL WHERE id = ?", G_NEW),
      member(OTHER + 'target', 'oidc', 'team'),
      identity(a, 'T1', OTHER + 'target', 'target@example.test'),
    ]);
    expect(await revokeWithCallback()).not.toHaveBeenCalled();
  });

  it('does not retain a user through group membership in another organization', async () => {
    await executor.batch([
      user(a, OTHER + 'target', 'target@example.test'),
      groupGrant(G_NEW, 'oidc', 'team'),
      member(OTHER + 'target', 'oidc', 'team', ago(60_000), b),
      identity(a, 'T1', OTHER + 'target', 'target@example.test'),
    ]);
    expect(
      await repository.delete(a, fence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toEqual({ status: 'deleted', offboardedUserId: OTHER + 'target' });
  });

  it('does not retain a user through a group grant in another project', async () => {
    await executor.batch([
      user(a, OTHER + 'target', 'target@example.test'),
      groupGrant(G_NEW, 'oidc', 'team'),
      stmt('UPDATE access_grant SET project_id = ? WHERE id = ?', P2, G_NEW),
      member(OTHER + 'target', 'oidc', 'team'),
    ]);
    expect(
      await repository.delete(a, fence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toEqual({ status: 'deleted', offboardedUserId: OTHER + 'target' });
  });

  it('defaults a missing offboarding row to null after a committed deletion', async () => {
    await executor.batch([user(a, OTHER + 'target', 'target@example.test')]);
    const missingRow: SqlExecutor = {
      ...executor,
      batch: async (statements) => {
        const results = await executor.batch(statements);
        return results.map((result, index) =>
          statements[index]?.sql.includes('offboarded_user_id') ? { ...result, rows: [] } : result,
        );
      },
    };
    expect(
      await createProjectGrantRepository(missingRow).delete(a, fence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toEqual({ status: 'deleted', offboardedUserId: null });
    expect(await grantRow(G_TARGET)).toBeUndefined();
  });

  it('reports the last email grant user despite a grant in another project', async () => {
    await executor.batch([user(a, OTHER + 'target', 'target@example.test')]);
    const statements: Statement[] = [];
    const checked: SqlExecutor = {
      ...executor,
      all: () => {
        throw new Error('successful deletion must not read outside the batch');
      },
      batch: async (batch) => {
        statements.push(...batch);
        return executor.batch(batch);
      },
    };
    const result = await createProjectGrantRepository(checked).delete(a, fence(), {
      id: G_TARGET,
      projectId: P1,
      providerAnchors: ANCHORS,
    });
    expect(result).toEqual({ status: 'deleted', offboardedUserId: OTHER + 'target' });
    expect(statements.every((statement) => statement.params.length <= 100)).toBe(true);
  });

  it('reports null when another group grant retains project membership', async () => {
    await executor.batch([
      user(a, OTHER + 'target', 'target@example.test'),
      groupGrant(G_NEW, 'oidc', 'team'),
      member(OTHER + 'target', 'oidc', 'team'),
      identity(a, 'T1', OTHER + 'target', 'target@example.test'),
    ]);
    expect(
      await repository.delete(a, fence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toEqual({ status: 'deleted', offboardedUserId: null });
  });

  it('reports null for a group grant', async () => {
    await executor.batch([groupGrant(G_NEW, 'oidc', 'team'), member(OTHER, 'oidc', 'team')]);
    expect(
      await repository.delete(a, fence(1, G_NEW), {
        id: G_NEW,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toEqual({ status: 'deleted', offboardedUserId: null });
  });

  describe('group membership evidence', () => {
    const TARGET = OTHER + 'target';
    const hours = (count: number) => ago(count * HOUR);

    async function seedGroup(
      options: {
        refreshedAt?: string;
        identity?: Parameters<typeof identity>[4] | null;
        identityOrg?: OrgContext;
      } = {},
    ) {
      await executor.batch([
        user(a, TARGET, 'target@example.test'),
        groupGrant(G_NEW, 'okta', 'team', ORG_PLAIN),
        stmt(
          "UPDATE access_grant SET scope = 'organization', project_id = NULL WHERE id = ?",
          G_NEW,
        ),
        member(TARGET, 'okta', 'team', options.refreshedAt),
        ...(options.identity === null
          ? []
          : [
              identity(options.identityOrg ?? a, 'T1', TARGET, 'target@example.test', {
                provider: 'okta',
                ...options.identity,
              }),
            ]),
      ]);
    }

    const revoke = (anchors = ANCHORS) =>
      repository.delete(a, fence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: anchors,
      });

    it('fresh membership with a matching anchor suppresses the offboarding', async () => {
      await seedGroup();
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: null });
    });

    it('a stale membership row does not suppress the offboarding', async () => {
      await seedGroup({ refreshedAt: hours(25) });
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: TARGET });
    });

    it('a membership dated more than 60 seconds ahead does not suppress the offboarding', async () => {
      await seedGroup({ refreshedAt: new Date(SEED_AT + 5 * 60_000).toISOString() });
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: TARGET });
    });

    it('stale identity evidence does not suppress the offboarding', async () => {
      await seedGroup({ identity: { validatedAt: hours(25) } });
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: TARGET });
    });

    it('a provider whose anchor no longer matches does not suppress the offboarding', async () => {
      await seedGroup();
      const rotated = ANCHORS.map((entry) =>
        entry.provider === 'okta'
          ? { ...entry, anchor: 'oidc:https://rotated.example.test' }
          : entry,
      );
      expect(await revoke(rotated)).toEqual({ status: 'deleted', offboardedUserId: TARGET });
    });

    it('a membership without an identity of the provider does not suppress the offboarding', async () => {
      await seedGroup({ identity: null });
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: TARGET });
    });

    it('an identity of another provider does not suppress the offboarding', async () => {
      await seedGroup({ identity: { provider: 'oidc' } });
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: TARGET });
    });

    it('an unverified identity does not suppress the offboarding', async () => {
      await seedGroup({ identity: { verified: 0 } });
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: TARGET });
    });

    it('an identity row of another organization for the same user does not suppress the offboarding', async () => {
      await seedGroup({ identity: null });
      await executor.batch([
        identity(b, 'T2', TARGET, 'target@example.test', { provider: 'okta' }),
      ]);
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: TARGET });
    });

    it('a provider binding of another organization does not satisfy the anchor', async () => {
      await seedGroup();
      await executor.batch([
        stmt(
          'DELETE FROM identity_provider_binding WHERE org_id = ? AND provider = ?',
          a.orgId,
          'okta',
        ),
      ]);
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: TARGET });
    });

    it('a direct organization e-mail grant suppresses the offboarding without any evidence', async () => {
      await executor.batch([
        user(a, TARGET, 'target@example.test'),
        grant(a, G_NEW, 'target@example.test', ORG_PLAIN, null),
      ]);
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: null });
    });

    it('a project group grant in the same project follows the same evidence rule', async () => {
      await executor.batch([
        user(a, TARGET, 'target@example.test'),
        groupGrant(G_NEW, 'okta', 'team'),
        member(TARGET, 'okta', 'team', hours(25)),
        identity(a, 'T1', TARGET, 'target@example.test', { provider: 'okta' }),
      ]);
      expect(await revoke()).toEqual({ status: 'deleted', offboardedUserId: TARGET });
    });

    it('binds at most 100 parameters per statement however many providers are configured', async () => {
      await seedGroup();
      const many = Array.from({ length: 60 }, (_, index) => ({
        provider: `idp${index}`,
        anchor: `oidc:https://idp${index}.example.test`,
        emailAuthoritative: false,
      }));
      const statements: Statement[] = [];
      const recording: SqlExecutor = {
        ...executor,
        batch: async (batch) => {
          statements.push(...batch);
          return executor.batch(batch);
        },
      };
      const result = await createProjectGrantRepository(recording).delete(a, fence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: [...ANCHORS, ...many],
      });
      expect(result).toEqual({ status: 'deleted', offboardedUserId: null });
      expect(
        Math.max(...statements.map((statement) => statement.params.length)),
      ).toBeLessThanOrEqual(100);
    });

    it('decides like the protected-holder predicate for every evidence case', async () => {
      const cases = [
        { name: 'fresh', options: {}, anchors: ANCHORS },
        { name: 'stale membership', options: { refreshedAt: hours(25) }, anchors: ANCHORS },
        {
          name: 'stale identity',
          options: { identity: { validatedAt: hours(25) } },
          anchors: ANCHORS,
        },
        { name: 'no identity', options: { identity: null }, anchors: ANCHORS },
        { name: 'unverified', options: { identity: { verified: 0 } }, anchors: ANCHORS },
        {
          name: 'anchor mismatch',
          options: {},
          anchors: [ANCHORS[0]!, { ...ANCHORS[1]!, anchor: 'oidc:https://rotated.example.test' }],
        },
      ];
      const outcomes: Record<string, { protectedHolder: boolean; retained: boolean }> = {};
      for (const entry of cases) {
        await database.close();
        database = await openMigratedDatabase({ twoOrganizations: true });
        ({ a, b } = database.orgs!);
        executor = database.executor;
        repository = createProjectGrantRepository(executor);
        await executor.batch([
          ...role(a, OWNER, 'owner', 'project', 'project:grants:write', 'project:read'),
          ...role(a, VIEWER, 'viewer', 'project', 'project:read'),
          stmt(
            'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 1)',
            ORG_ADMIN,
            a.orgId,
            'org_admin',
            'org_admin',
            'organization',
          ),
          user(a, ACTOR, 'actor@example.test'),
          user(a, TARGET, 'target@example.test'),
          project(a, P1, 'one'),
          session(a, S_ACTOR, ACTOR),
          ...ANCHORS.map((anchor) =>
            stmt(
              'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
              a.orgId,
              anchor.provider,
              anchor.anchor,
            ),
          ),
          identity(a, 'I1', ACTOR, 'actor@example.test'),
          grant(a, G_ACTOR, 'actor@example.test', OWNER, P1),
          grant(a, G_TARGET, 'target@example.test', VIEWER, P1),
          groupGrant(G_NEW, 'okta', 'team', ORG_ADMIN),
          stmt(
            "UPDATE access_grant SET scope = 'organization', project_id = NULL WHERE id = ?",
            G_NEW,
          ),
          member(TARGET, 'okta', 'team', (entry.options as { refreshedAt?: string }).refreshedAt),
          ...((entry.options as { identity?: unknown }).identity === null
            ? []
            : [
                identity(a, 'T1', TARGET, 'target@example.test', {
                  provider: 'okta',
                  ...(entry.options as { identity?: Parameters<typeof identity>[4] }).identity,
                }),
              ]),
        ]);
        const now = new Date(SEED_AT).toISOString();
        const holders = createGrantRepository(executor, {
          providerAnchors: entry.anchors,
          holderInput: () => ({ kind: 'fresh', now, providers: entry.anchors }),
        });
        const holder = await holders.isProtectedHolder(a, TARGET, {
          kind: 'fresh',
          now,
          providers: entry.anchors,
        });
        const result = await repository.delete(a, fence(), {
          id: G_TARGET,
          projectId: P1,
          providerAnchors: entry.anchors,
        });
        outcomes[entry.name] = {
          protectedHolder: holder,
          retained:
            typeof result === 'object' &&
            result.status === 'deleted' &&
            result.offboardedUserId === null,
        };
      }
      for (const [name, outcome] of Object.entries(outcomes)) {
        expect(outcome.retained, name).toBe(outcome.protectedHolder);
      }
      expect(outcomes['fresh']?.retained).toBe(true);
    });
  });

  it('reports null for an email with no account in the organization', async () => {
    await executor.batch([user(b, OTHER + 'target', 'target@example.test')]);
    expect(
      await repository.delete(a, fence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toEqual({ status: 'deleted', offboardedUserId: null });
  });

  it('deletes the grant', async () => {
    expect(
      await repository.delete(a, fence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toEqual({ status: 'deleted', offboardedUserId: null });
    expect(await grantRow(G_TARGET)).toBeUndefined();
    expect(await rows('SELECT count(*) AS n FROM epoch_log')).toEqual([{ n: 1 }]);
    expect(await rows('SELECT * FROM access_mutation_guard')).toEqual([]);
  });

  it('answers conflict for a stale revision and leaves the grant', async () => {
    const before = await snapshot();
    expect(
      await repository.delete(a, fence(3), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('refuses when the batch assertion is false and leaves the grant', async () => {
    const foreign = fenceFor(OTHER, S_OTHER, { [projectGrantKey(G_TARGET)]: 1 });
    const before = await snapshot();
    expect(
      await repository.delete(a, foreign, {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(await snapshot()).toBe(before);
    await executor.batch([stmt('UPDATE session SET revoked_at = ? WHERE id = ?', NOW, S_ACTOR)]);
    const after = await snapshot();
    expect(
      await repository.delete(a, fence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(await snapshot()).toBe(after);
    expect(await grantRow(G_TARGET)).toBeDefined();
  });

  it('removes a holder whose role exceeds the actor permissions', async () => {
    const wide = actorFence({ [projectGrantKey(G_ARCH_TARGET)]: 1 });
    expect(
      await repository.delete(a, wide, {
        id: G_ARCH_TARGET,
        projectId: P_ARCHIVED,
        providerAnchors: ANCHORS,
      }),
    ).toEqual({ status: 'deleted', offboardedUserId: null });
  });

  it('answers not_found for a missing grant, an organization grant and another project', async () => {
    expect(
      await repository.delete(a, fence(1, 'missing'), {
        id: 'missing',
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toBe('not_found');
    expect(
      await repository.delete(a, fence(1, G_ORG), {
        id: G_ORG,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toBe('not_found');
    expect(
      await repository.delete(a, fence(1, G_P2_TARGET), {
        id: G_P2_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toBe('not_found');
    expect(await grantRow(G_ORG)).toBeDefined();
  });

  it('refuses a project of another organization', async () => {
    expect(
      await repository.delete(a, fence(), {
        id: G_TARGET,
        projectId: P_B,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect(await grantRow(G_TARGET)).toBeDefined();
  });

  it('requires the fence to carry the target revision', async () => {
    await expect(
      repository.delete(a, actorFence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('refuses when the actor lost authority before the batch and leaves no tombstone', async () => {
    await executor.batch([stmt('DELETE FROM access_grant WHERE id = ?', G_ACTOR)]);
    expect(
      await repository.delete(a, fence(), {
        id: G_TARGET,
        projectId: P1,
        providerAnchors: ANCHORS,
      }),
    ).toBe('forbidden');
    expect((await grantRow(G_TARGET))?.last_op_id).toBeNull();
  });
});
