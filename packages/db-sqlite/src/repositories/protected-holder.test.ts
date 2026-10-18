import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  type AuthenticatedActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createGrantRepository,
  type ProtectedGrantRepository,
  type ProtectedHolderExclusion,
  type ProtectedHolderInput,
  type ProtectedHolderProvider,
} from './grant.js';

const NOW = '2026-10-15T12:00:00.000Z';
const HOUR = 3600_000;

const ADMIN = '01J0ROLEADMIN00000000000AA';
const VIEWER = '01J0ROLEVIEWER0000000000AA';
const ADMIN_B = '01J0ROLEADMIN00000000000BB';

const U1 = '01J0USER000000000000000001';
const U2 = '01J0USER000000000000000002';
const U3 = '01J0USER000000000000000003';
const UB = '01J0USER00000000000000000B';

const G_EMAIL = '01J0GRANT000000000000000A1';
const G_GROUP = '01J0GRANT000000000000000A2';
const G_GROUP_TWO = '01J0GRANT000000000000000A3';
const G_B = '01J0GRANT000000000000000B1';

const ANCHOR = 'https://idp.example.test';
const SSO: ProtectedHolderProvider = {
  provider: 'oidc',
  anchor: ANCHOR,
  emailAuthoritative: false,
};
const AUTHORITATIVE: ProtectedHolderProvider = {
  provider: 'oidc',
  anchor: ANCHOR,
  emailAuthoritative: true,
  emailAuthoritativeDomains: ['example.test', 'actor.test'],
};

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let grants: ProtectedGrantRepository;
let counter = 0;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function ago(ms: number): string {
  return new Date(Date.parse(NOW) - ms).toISOString();
}

function fresh(
  providers: readonly ProtectedHolderProvider[],
  exclude?: ProtectedHolderExclusion,
): ProtectedHolderInput {
  return exclude === undefined
    ? { kind: 'fresh', now: NOW, providers }
    : { kind: 'fresh', now: NOW, providers, exclude };
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

function role(org: OrgContext, id: string, key: string, protects: number): Statement {
  return stmt(
    'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    key,
    key,
    'organization',
    protects,
  );
}

function grant(
  org: OrgContext,
  id: string,
  type: 'email' | 'group',
  value: string,
  roleId: string,
  provider: string | null = null,
): Statement {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
    id,
    org.orgId,
    type,
    value,
    provider,
    'organization',
    roleId,
    NOW,
    NOW,
  );
}

function member(
  org: OrgContext,
  userId: string,
  group: string,
  refreshedAt: string = ago(HOUR),
  provider = 'oidc',
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

function identity(
  org: OrgContext,
  userId: string,
  email: string,
  options: {
    readonly provider?: string;
    readonly verified?: number;
    readonly validatedAt?: string | null;
    readonly id?: string;
  } = {},
): Statement {
  counter += 1;
  return stmt(
    'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    options.id ?? `01J0IDENT${String(counter).padStart(17, '0')}`,
    org.orgId,
    userId,
    options.provider ?? 'oidc',
    `subject-${counter}`,
    email,
    options.verified ?? 1,
    options.validatedAt === undefined ? ago(HOUR) : options.validatedAt,
  );
}

function localLogin(org: OrgContext, userId: string, totp = true): Statement[] {
  const credentialId = `01J0CRED${userId.slice(-8)}0000000000000000`;
  return [
    ...(totp
      ? [
          stmt(
            "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
            credentialId,
            org.orgId,
          ),
        ]
      : []),
    stmt(
      'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?, ?)',
      userId,
      org.orgId,
      'pbkdf2-sha256$test',
      totp ? credentialId : null,
      totp ? NOW : null,
    ),
  ];
}

function binding(org: OrgContext, provider: string, anchor: string): Statement {
  return stmt(
    'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    org.orgId,
    provider,
    anchor,
  );
}

const ACTOR_IDENTITY = '01J0ACTORIDEN00000000000AA';
const ACTOR = {
  user: '01J0ACTORUSER00000000000AA',
  role: '01J0ACTORROLE00000000000AA',
  session: '01J0ACTORSESS00000000000AA',
};

function actorStatements(org: OrgContext): Statement[] {
  const now = new Date().toISOString();
  const hash = 'a'.repeat(64);
  return [
    user(org, ACTOR.user, 'actor@actor.test'),
    stmt(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      ACTOR_IDENTITY,
      org.orgId,
      ACTOR.user,
      'oidc',
      'subject-actor',
      'actor@actor.test',
      now,
    ),
    role(org, ACTOR.role, 'test_actor', 1),
    stmt(
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      org.orgId,
      ACTOR.role,
      'org:grants:write',
    ),
    stmt(
      'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
      org.orgId,
      ACTOR.role,
      'org:users:write',
    ),
    grant(org, '01J0ACTORGRNT00000000000AA', 'email', 'actor@actor.test', ACTOR.role),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ACTOR.session,
      org.orgId,
      ACTOR.user,
      hash,
      hash,
      now,
      new Date(Date.now() + 3_600_000).toISOString(),
    ),
  ];
}

async function fenceFor(grantId: string): Promise<MutationFence> {
  const found = await executor.all<{ revision: number }>(
    stmt('SELECT revision FROM access_grant WHERE id = ?', grantId),
  );
  return mutationFence(
    { userId: ACTOR.user, sessionId: ACTOR.session } as unknown as AuthenticatedActor,
    { grant: found[0]?.revision ?? 1 },
  );
}

let actorSeeded = false;

async function ensureActor(): Promise<void> {
  if (actorSeeded) return;
  actorSeeded = true;
  await seed(...actorStatements(a));
}

async function deleteGrant(id: string) {
  await ensureActor();
  counter += 1;
  return grants.deleteOrganization(a, await fenceFor(id), id, `OP${counter}`);
}

async function suspend(userId: string, now: string) {
  await ensureActor();
  return grants.suspendUser(a, await fenceFor(userId), userId, now);
}

async function changeGrantRole(id: string, roleId: string, now: string) {
  await ensureActor();
  counter += 1;
  return grants.changeRole(a, await fenceFor(id), id, roleId, now, `OP${counter}`);
}

async function seed(...statements: Statement[]): Promise<void> {
  await executor.batch(statements);
}

async function countUsers(input: ProtectedHolderInput): Promise<number> {
  const ids = await executor.all<{ id: string }>(
    stmt('SELECT id FROM user_account WHERE org_id = ? ORDER BY id', a.orgId),
  );
  let held = 0;
  for (const { id } of ids) {
    if (await grants.isProtectedHolder(a, id, input)) held += 1;
  }
  return held;
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  actorSeeded = false;
  grants = createGrantRepository(executor, {
    providerAnchors: [AUTHORITATIVE],
    holderInput: () =>
      fresh([AUTHORITATIVE], actorSeeded ? { identityId: ACTOR_IDENTITY } : undefined),
  });
  await seed(
    role(a, ADMIN, 'organization_admin', 1),
    role(a, VIEWER, 'org_viewer', 0),
    role(b, ADMIN_B, 'organization_admin', 1),
    user(a, U1, 'u1@example.test'),
    user(a, U2, 'u2@example.test'),
    user(a, U3, 'u3@example.test'),
    user(b, UB, 'b@example.test'),
    binding(a, 'oidc', ANCHOR),
    binding(b, 'oidc', ANCHOR),
  );
});

afterEach(async () => {
  await database.close();
});

describe('isProtectedHolder through a group', () => {
  it('counts a fresh group holder and not one whose membership is older than 24 h', async () => {
    await seed(
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U1, 'admins', ago(23 * HOUR)),
      identity(a, U1, 'u1@example.test'),
      member(a, U2, 'admins', ago(25 * HOUR)),
      identity(a, U2, 'u2@example.test'),
    );

    expect(await grants.isProtectedHolder(a, U1, fresh([SSO]))).toBe(true);
    expect(await grants.isProtectedHolder(a, U2, fresh([SSO]))).toBe(false);
  });

  it('keeps the 24 h boundary exact to the second', async () => {
    await seed(
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U1, 'admins', ago(24 * HOUR)),
      identity(a, U1, 'u1@example.test'),
      member(a, U2, 'admins', ago(24 * HOUR + 1000)),
      identity(a, U2, 'u2@example.test'),
    );

    expect(await grants.isProtectedHolder(a, U1, fresh([SSO]))).toBe(true);
    expect(await grants.isProtectedHolder(a, U2, fresh([SSO]))).toBe(false);
  });

  it('requires the identity evidence to be fresh as well', async () => {
    await seed(
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U1, 'admins'),
      identity(a, U1, 'u1@example.test', { validatedAt: ago(25 * HOUR) }),
      member(a, U2, 'admins'),
      identity(a, U2, 'u2@example.test', { validatedAt: null }),
      member(a, U3, 'admins'),
      identity(a, U3, 'u3@example.test', { validatedAt: 'not a time' }),
    );

    expect(await countUsers(fresh([SSO]))).toBe(0);
  });

  it('requires a verified identity whose e-mail still matches the user', async () => {
    await seed(
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U1, 'admins'),
      identity(a, U1, 'u1@example.test', { verified: 0 }),
      member(a, U2, 'admins'),
      identity(a, U2, 'changed@example.test'),
      member(a, U3, 'admins'),
    );

    expect(await countUsers(fresh([SSO]))).toBe(0);
  });

  it('requires the provider to be configured with the stored trust anchor', async () => {
    await seed(
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U1, 'admins'),
      identity(a, U1, 'u1@example.test'),
    );

    expect(await grants.isProtectedHolder(a, U1, fresh([SSO]))).toBe(true);
    expect(await grants.isProtectedHolder(a, U1, fresh([]))).toBe(false);
    expect(
      await grants.isProtectedHolder(a, U1, fresh([{ ...SSO, anchor: 'https://other' }])),
    ).toBe(false);
    expect(await grants.isProtectedHolder(a, U1, fresh([{ ...SSO, provider: 'access' }]))).toBe(
      false,
    );
    await seed(stmt('DELETE FROM identity_provider_binding WHERE org_id = ?', a.orgId));
    expect(await grants.isProtectedHolder(a, U1, fresh([SSO]))).toBe(false);
  });

  it('does not let a group of one provider protect a member of another provider', async () => {
    await seed(
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'access'),
      member(a, U1, 'admins'),
      identity(a, U1, 'u1@example.test'),
    );

    expect(await grants.isProtectedHolder(a, U1, fresh([SSO]))).toBe(false);
  });

  it('does not count a user of another organization', async () => {
    await seed(
      grant(b, G_B, 'group', 'admins', ADMIN_B, 'oidc'),
      member(b, UB, 'admins'),
      identity(b, UB, 'b@example.test'),
    );

    expect(await grants.isProtectedHolder(b, UB, fresh([SSO]))).toBe(true);
    expect(await grants.isProtectedHolder(a, UB, fresh([SSO]))).toBe(false);
  });
});

describe('isProtectedHolder through an e-mail grant', () => {
  it('counts a verified identity of an e-mail authoritative provider only', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      identity(a, U1, 'u1@example.test'),
    );

    expect(await grants.isProtectedHolder(a, U1, fresh([AUTHORITATIVE]))).toBe(true);
    expect(await grants.isProtectedHolder(a, U1, fresh([SSO]))).toBe(false);
  });

  it('does not count a user without a verified identity matching the e-mail', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      grant(a, G_GROUP, 'email', 'u2@example.test', ADMIN),
      identity(a, U2, 'u2@example.test', { verified: 0 }),
      grant(a, G_GROUP_TWO, 'email', 'u3@example.test', ADMIN),
      identity(a, U3, 'other@example.test'),
    );

    expect(await countUsers(fresh([AUTHORITATIVE]))).toBe(0);
  });
});

describe('distinct active users', () => {
  it('counts one user once across duplicate identities, groups and an e-mail grant', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      grant(a, G_GROUP_TWO, 'group', 'owners', ADMIN, 'oidc'),
      member(a, U1, 'admins'),
      member(a, U1, 'owners'),
      identity(a, U1, 'u1@example.test'),
      identity(a, U1, 'u1@example.test'),
    );

    expect(await countUsers(fresh([AUTHORITATIVE]))).toBe(1);
    expect(await grants.countProtectedHoldersFor(a, fresh([AUTHORITATIVE]))).toBe(1);
  });

  it('ignores a group without members and a suspended user', async () => {
    await seed(
      grant(a, G_GROUP, 'group', 'empty', ADMIN, 'oidc'),
      grant(a, G_GROUP_TWO, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U2, 'admins'),
      identity(a, U2, 'u2@example.test'),
      stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U2),
    );

    expect(await grants.isProtectedHolder(a, U2, fresh([SSO]))).toBe(false);
    expect(await grants.countProtectedHoldersFor(a, fresh([SSO]))).toBe(0);
  });

  it('counts holders per user across the organization', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      identity(a, U1, 'u1@example.test'),
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U2, 'admins'),
      identity(a, U2, 'u2@example.test'),
      member(a, U3, 'admins', ago(48 * HOUR)),
      identity(a, U3, 'u3@example.test'),
    );

    expect(await grants.countProtectedHoldersFor(a, fresh([AUTHORITATIVE]))).toBe(2);
  });

  it('does not count an unprotected role', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', VIEWER),
      identity(a, U1, 'u1@example.test'),
    );

    expect(await grants.isProtectedHolder(a, U1, fresh([AUTHORITATIVE]))).toBe(false);
  });
});

describe('exclusion', () => {
  beforeEach(async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      identity(a, U1, 'u1@example.test'),
      member(a, U1, 'admins'),
      identity(a, U2, 'u2@example.test'),
      member(a, U2, 'admins'),
    );
  });

  it('keeps a user who holds the role through the other overlapping contribution', async () => {
    const providers = [AUTHORITATIVE];

    expect(await grants.isProtectedHolder(a, U1, fresh(providers, { grantId: G_EMAIL }))).toBe(
      true,
    );
    expect(await grants.isProtectedHolder(a, U1, fresh(providers, { grantId: G_GROUP }))).toBe(
      true,
    );
    expect(await grants.isProtectedHolder(a, U2, fresh(providers, { grantId: G_EMAIL }))).toBe(
      true,
    );
    expect(await grants.isProtectedHolder(a, U2, fresh(providers, { grantId: G_GROUP }))).toBe(
      false,
    );
  });

  it('detects the removal of the last holder', async () => {
    const providers = [AUTHORITATIVE];
    const other = fresh(providers, { userId: U1 });

    expect(await grants.isProtectedHolder(a, U2, other)).toBe(true);
    expect(await grants.isProtectedHolder(a, U1, other)).toBe(false);
    expect(
      await grants.isProtectedHolder(a, U2, fresh(providers, { userId: U1, grantId: G_GROUP })),
    ).toBe(false);
  });
});

describe('local-admin eligibility', () => {
  it('local_recovery counts only a usable local login with an organization e-mail grant', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      ...localLogin(a, U1),
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U2, 'admins'),
      identity(a, U2, 'u2@example.test'),
      grant(a, G_GROUP_TWO, 'email', 'u3@example.test', ADMIN),
      identity(a, U3, 'u3@example.test'),
    );
    const input: ProtectedHolderInput = { kind: 'local_recovery' };

    expect(await grants.isProtectedHolder(a, U1, input)).toBe(true);
    expect(await grants.isProtectedHolder(a, U2, input)).toBe(false);
    expect(await grants.isProtectedHolder(a, U3, input)).toBe(false);
    expect(await grants.countProtectedHoldersFor(a, input)).toBe(1);
  });

  it('needs both a password and an enabled TOTP', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      ...localLogin(a, U1, false),
      grant(a, G_GROUP, 'email', 'u2@example.test', ADMIN),
      stmt(
        'INSERT INTO local_login (user_id, org_id, totp_enabled_at) VALUES (?, ?, ?)',
        U2,
        a.orgId,
        NOW,
      ),
    );

    expect(await grants.isProtectedHolder(a, U1, { kind: 'local_recovery' })).toBe(false);
    expect(await grants.isProtectedHolder(a, U2, { kind: 'local_recovery' })).toBe(false);
    expect(await grants.isProtectedHolder(a, U1, fresh([]))).toBe(false);
  });

  it('does not count a local login whose TOTP credential is missing or dangling', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      grant(a, G_GROUP, 'email', 'u2@example.test', ADMIN),
      ...localLogin(a, U1),
      ...localLogin(a, U2),
    );
    expect(await grants.countProtectedHoldersFor(a, { kind: 'local_recovery' })).toBe(2);

    await seed(
      stmt('UPDATE local_login SET totp_credential_id = NULL WHERE user_id = ?', U2),
      stmt('DELETE FROM credential WHERE org_id = ? AND id LIKE ?', a.orgId, `%${U1.slice(-8)}%`),
    );

    for (const input of [{ kind: 'local_recovery' } as const, fresh([])]) {
      expect(await grants.isProtectedHolder(a, U1, input)).toBe(false);
      expect(await grants.isProtectedHolder(a, U2, input)).toBe(false);
    }
  });

  it('refuses to remove the last local admin once its credential is gone', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      ...localLogin(a, U1),
      grant(a, G_GROUP, 'email', 'u2@example.test', ADMIN),
      ...localLogin(a, U2),
    );
    await seed(stmt('UPDATE local_login SET totp_credential_id = NULL WHERE user_id = ?', U2));

    expect(await deleteGrant(G_EMAIL)).toBe('last_holder');
    expect(await suspend(U1, NOW)).toBe('last_holder');
  });

  it('fresh also counts the bootstrap local admin without any provider', async () => {
    await seed(grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN), ...localLogin(a, U1));

    expect(await grants.isProtectedHolder(a, U1, fresh([]))).toBe(true);
  });

  it('skips a suspended user and honours exclusion', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      ...localLogin(a, U1),
      grant(a, G_GROUP, 'email', 'u2@example.test', ADMIN),
      ...localLogin(a, U2),
      stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U2),
    );

    expect(await grants.isProtectedHolder(a, U2, { kind: 'local_recovery' })).toBe(false);
    expect(
      await grants.isProtectedHolder(a, U1, {
        kind: 'local_recovery',
        exclude: { grantId: G_EMAIL },
      }),
    ).toBe(false);
    expect(
      await grants.isProtectedHolder(a, U1, { kind: 'local_recovery', exclude: { userId: U1 } }),
    ).toBe(false);
  });
});

describe('provider mutants', () => {
  const ACCESS: ProtectedHolderProvider = {
    provider: 'access',
    anchor: ANCHOR,
    emailAuthoritative: false,
  };

  it('an identity at a non-authoritative or unbound provider does not satisfy an e-mail grant', async () => {
    await seed(
      binding(a, 'access', ANCHOR),
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      identity(a, U1, 'u1@example.test', { provider: 'access' }),
      grant(a, G_GROUP, 'email', 'u2@example.test', ADMIN),
      identity(a, U2, 'u2@example.test', { provider: 'unbound' }),
    );
    const providers = [
      AUTHORITATIVE,
      ACCESS,
      {
        ...ACCESS,
        provider: 'unbound',
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      },
    ];

    expect(await grants.isProtectedHolder(a, U1, fresh(providers))).toBe(false);
    expect(await grants.isProtectedHolder(a, U2, fresh(providers))).toBe(false);
  });

  it('a membership at one provider backed only by an identity at another is not a holder', async () => {
    await seed(
      binding(a, 'access', ANCHOR),
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U1, 'admins'),
      identity(a, U1, 'u1@example.test', { provider: 'access' }),
    );

    expect(
      await grants.isProtectedHolder(
        a,
        U1,
        fresh([
          AUTHORITATIVE,
          {
            ...ACCESS,
            emailAuthoritative: true,
            emailAuthoritativeDomains: ['example.test', 'actor.test'],
          },
        ]),
      ),
    ).toBe(false);
  });

  it('a project-scope grant on a protecting role does not count', async () => {
    await seed(
      stmt(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('01J0PROJECT00000000000000AA', ?, 'alpha', 'alpha')",
        a.orgId,
      ),
      stmt(
        "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('01J0ROLEPROJECT0000000000AA', ?, 'project_admin', 'project_admin', 'project', 1)",
        a.orgId,
      ),
      stmt(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at, updated_at) VALUES (?, ?, 'email', 'u1@example.test', NULL, 'project', '01J0PROJECT00000000000000AA', '01J0ROLEPROJECT0000000000AA', ?, ?)",
        G_EMAIL,
        a.orgId,
        NOW,
        NOW,
      ),
      identity(a, U1, 'u1@example.test'),
      ...localLogin(a, U1),
    );

    expect(await grants.isProtectedHolder(a, U1, fresh([AUTHORITATIVE]))).toBe(false);
    expect(await grants.isProtectedHolder(a, U1, { kind: 'local_recovery' })).toBe(false);
  });
});

describe('time boundaries', () => {
  const holdsWith = async (refreshed: string, validated: string): Promise<boolean> => {
    await seed(
      stmt('DELETE FROM user_group'),
      stmt('DELETE FROM identity'),
      stmt('DELETE FROM access_grant'),
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U1, 'admins', refreshed),
      identity(a, U1, 'u1@example.test', { validatedAt: validated }),
    );
    return grants.isProtectedHolder(a, U1, fresh([SSO]));
  };

  it('identity validated_at is inclusive at exactly 24 h', async () => {
    expect(await holdsWith(ago(HOUR), ago(24 * HOUR))).toBe(true);
  });

  it('refuses identity evidence one second older than 24 h', async () => {
    expect(await holdsWith(ago(HOUR), ago(24 * HOUR + 1000))).toBe(false);
  });

  it('refuses evidence one millisecond older than 24 h', async () => {
    expect(await holdsWith(ago(24 * HOUR + 1), ago(HOUR))).toBe(false);
    expect(await holdsWith(ago(HOUR), ago(24 * HOUR + 1))).toBe(false);
  });

  it('accepts evidence dated up to 60 s ahead and refuses more', async () => {
    expect(await holdsWith(ago(-60_000), ago(-60_000))).toBe(true);
  });

  it('refuses evidence dated more than 60 s ahead', async () => {
    expect(await holdsWith(ago(-60_001), ago(HOUR))).toBe(false);
    expect(await holdsWith(ago(HOUR), ago(-61_000))).toBe(false);
  });
});

describe('identity and membership exclusion', () => {
  const I_U1 = '01J0IDENTITY000000000000U1';

  it('excluding the identity removes the group and e-mail contributions it backs', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U1, 'admins'),
      identity(a, U1, 'u1@example.test', { id: I_U1 }),
    );

    expect(await grants.isProtectedHolder(a, U1, fresh([AUTHORITATIVE]))).toBe(true);
    expect(
      await grants.isProtectedHolder(a, U1, fresh([AUTHORITATIVE], { identityId: I_U1 })),
    ).toBe(false);
  });

  it('excluding one membership leaves other contributions, and the last one is detected', async () => {
    await seed(
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      grant(a, G_GROUP_TWO, 'group', 'owners', ADMIN, 'oidc'),
      member(a, U1, 'admins'),
      member(a, U1, 'owners'),
      identity(a, U1, 'u1@example.test'),
    );
    const without = (groupName: string) =>
      fresh([SSO], { membership: { userId: U1, provider: 'oidc', groupName } });

    expect(await grants.isProtectedHolder(a, U1, without('admins'))).toBe(true);
    await seed(stmt("DELETE FROM user_group WHERE group_name = 'owners'"));
    expect(await grants.isProtectedHolder(a, U1, without('admins'))).toBe(false);
    expect(await grants.isProtectedHolder(a, U1, without('other'))).toBe(true);
  });
});

describe('writers use the freshness-aware predicate', () => {
  const stale = async (): Promise<void> => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      identity(a, U1, 'u1@example.test'),
      grant(a, G_GROUP, 'group', 'admins', ADMIN, 'oidc'),
      member(a, U2, 'admins', ago(25 * HOUR)),
      identity(a, U2, 'u2@example.test'),
    );
  };

  it('a stale group holder does not keep a protected role alive', async () => {
    await stale();

    expect(await deleteGrant(G_EMAIL)).toBe('last_holder');
    expect(await changeGrantRole(G_EMAIL, VIEWER, NOW)).toBe('last_holder');
    expect(await suspend(U1, NOW)).toBe('last_holder');
    expect(await grants.countProtectedHolders(a)).toBe(1);
  });

  it('the same writers proceed when the group holder is fresh', async () => {
    await stale();
    await seed(stmt('UPDATE user_group SET refreshed_at = ? WHERE user_id = ?', ago(HOUR), U2));

    expect(await grants.countProtectedHolders(a)).toBe(2);
    expect(await deleteGrant(G_EMAIL)).toBe('deleted');
  });
});

describe('input is required', () => {
  it('accepts a call using repository anchors and database freshness', async () => {
    expect(await grants.isProtectedHolder(a, U1)).toBe(false);
  });

  it('rejects a malformed now before running SQL', async () => {
    await expect(
      grants.isProtectedHolder(a, U1, { kind: 'fresh', now: '2026-10-15', providers: [SSO] }),
    ).rejects.toThrow(TypeError);
  });
});

describe('e-mail authority by domain', () => {
  const U4 = '01J0USER000000000000000004';

  function authoritativeFor(...domains: string[]): ProtectedHolderProvider {
    return { ...AUTHORITATIVE, emailAuthoritativeDomains: domains };
  }

  it('does not count an e-mail whose domain the provider is not authoritative for', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      identity(a, U1, 'u1@example.test'),
    );

    expect(await grants.isProtectedHolder(a, U1, fresh([authoritativeFor('other.test')]))).toBe(
      false,
    );
    expect(
      await grants.isProtectedHolder(
        a,
        U1,
        fresh([authoritativeFor('other.test', 'example.test')]),
      ),
    ).toBe(true);
  });

  it('matches the domain exactly, never a parent domain', async () => {
    await seed(
      user(a, U4, 'u4@sub.example.test'),
      grant(a, G_EMAIL, 'email', 'u4@sub.example.test', ADMIN),
      identity(a, U4, 'u4@sub.example.test'),
    );

    expect(await grants.isProtectedHolder(a, U4, fresh([authoritativeFor('example.test')]))).toBe(
      false,
    );
    expect(
      await grants.isProtectedHolder(a, U4, fresh([authoritativeFor('sub.example.test')])),
    ).toBe(true);
  });

  it('does not let one provider vouch for a domain another provider is authoritative for', async () => {
    await seed(
      grant(a, G_EMAIL, 'email', 'u1@example.test', ADMIN),
      identity(a, U1, 'u1@example.test'),
    );
    const providers: ProtectedHolderProvider[] = [
      authoritativeFor('other.test'),
      {
        provider: 'second',
        anchor: 'https://second.example.test',
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ];

    expect(await grants.isProtectedHolder(a, U1, fresh(providers))).toBe(false);
  });

  it('refuses an authoritative anchor without valid lowercase domains before SQL', async () => {
    const statements: Statement[] = [];
    const recording = createGrantRepository(
      {
        ...executor,
        all: (statement) => {
          statements.push(statement);
          return executor.all(statement);
        },
      },
      { providerAnchors: [AUTHORITATIVE], holderInput: () => fresh([AUTHORITATIVE]) },
    );
    for (const anchor of [
      { provider: 'oidc', anchor: ANCHOR, emailAuthoritative: true },
      authoritativeFor(),
      authoritativeFor('Example.test'),
      authoritativeFor('example.test', ''),
      { ...AUTHORITATIVE, emailAuthoritativeDomains: 'example.test' as unknown as string[] },
    ]) {
      await expect(recording.isProtectedHolder(a, U1, fresh([anchor]))).rejects.toThrow(TypeError);
    }
    expect(statements).toEqual([]);
  });
});
