import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import { countCalls } from '../contract/count-calls.js';
import { assertGuard, compile, db, existsGuard } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createAccessRepository,
  holdsPermission,
  lookupSessionStatement,
  permissionRows,
  type ProtectedHolderProvider,
  type SessionLookupInput,
} from './access.js';

const HOUR = 3600_000;
const MINUTE = 60_000;

const ROLE_ADMIN = '01J0ROLEADMIN00000000000AA';
const ROLE_VIEWER = '01J0ROLEVIEWER0000000000AA';
const ROLE_OWNER = '01J0ROLEOWNER00000000000AA';
const ROLE_BAD_OWNER = '01J0ROLEBADOWNER000000000A';
const ROLE_ADMIN_B = '01J0ROLEADMIN00000000000BB';

const U1 = '01J0USER000000000000000001';
const U2 = '01J0USER000000000000000002';
const U3 = '01J0USER000000000000000003';
const UB = '01J0USER00000000000000000B';

const P1 = '01J0PROJECT0000000000000P1';
const P2 = '01J0PROJECT0000000000000P2';
const PB = '01J0PROJECT0000000000000PB';

const ANCHOR = 'https://idp.example.test';
const OIDC: ProtectedHolderProvider = {
  provider: 'oidc',
  anchor: ANCHOR,
  emailAuthoritative: true,
};
const OIDC_PLAIN: ProtectedHolderProvider = { ...OIDC, emailAuthoritative: false };
const OTHER: ProtectedHolderProvider = {
  provider: 'other',
  anchor: 'https://other.example.test',
  emailAuthoritative: false,
};
const OTHER_AUTH: ProtectedHolderProvider = { ...OTHER, emailAuthoritative: true };

const ADMIN_PERMISSIONS = ['org:read', 'org:users:read', 'project:read', 'project:packages:read'];
const OWNER_PERMISSIONS = ['project:read', 'project:grants:write'];

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let counter = 0;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function hash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

function seq(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(26 - prefix.length, '0')}`;
}

async function seed(...statements: Statement[]): Promise<void> {
  await executor.batch(statements);
}

function role(
  org: OrgContext,
  id: string,
  key: string,
  scope: 'organization' | 'project',
  protects: number,
  permissions: readonly string[],
): Statement[] {
  return [
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      org.orgId,
      key,
      key,
      scope,
      protects,
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

function binding(org: OrgContext, provider: string, anchor: string): Statement {
  return stmt(
    'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    org.orgId,
    provider,
    anchor,
  );
}

function grant(
  org: OrgContext,
  type: 'email' | 'group',
  value: string,
  roleId: string,
  options: { readonly provider?: string; readonly projectId?: string } = {},
): Statement {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    seq('01J0GRANT'),
    org.orgId,
    type,
    value,
    type === 'group' ? (options.provider ?? 'oidc') : null,
    options.projectId === undefined ? 'organization' : 'project',
    options.projectId ?? null,
    roleId,
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
  } = {},
): Statement {
  const id = seq('01J0IDENT');
  return stmt(
    'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    userId,
    options.provider ?? 'oidc',
    `subject-${id}`,
    email,
    options.verified ?? 1,
    options.validatedAt === undefined ? at(-HOUR) : options.validatedAt,
  );
}

function member(
  org: OrgContext,
  userId: string,
  group: string,
  options: { readonly provider?: string; readonly refreshedAt?: string } = {},
): Statement {
  return stmt(
    'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
    org.orgId,
    userId,
    options.provider ?? 'oidc',
    group,
    options.refreshedAt ?? at(-HOUR),
  );
}

function session(
  org: OrgContext,
  userId: string,
  label: string,
  options: {
    readonly identityId?: string | null;
    readonly createdAt?: string;
    readonly expiresAt?: string;
    readonly lastSeenAt?: string | null;
    readonly revokedAt?: string | null;
  } = {},
): Statement {
  return stmt(
    'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    seq('01J0SESSION'),
    org.orgId,
    userId,
    options.identityId ?? null,
    hash(label),
    hash('csrf'),
    options.createdAt ?? at(-2 * MINUTE),
    options.expiresAt ?? at(8 * HOUR),
    options.lastSeenAt === undefined ? null : options.lastSeenAt,
    options.revokedAt ?? null,
  );
}

function input(label: string, overrides: Partial<SessionLookupInput> = {}): SessionLookupInput {
  return {
    secretHash: hash(label),
    boundary: 'project',
    projectSlug: 'alpha',
    providerAnchors: [OIDC],
    ...overrides,
  };
}

async function lookup(label: string, overrides: Partial<SessionLookupInput> = {}, org = a) {
  const repository = createAccessRepository(executor);
  return repository.lookupSession(org, input(label, overrides));
}

async function lastSeen(label: string): Promise<string | null> {
  const rows = await executor.all<{ last_seen_at: string | null }>(
    stmt('SELECT last_seen_at FROM session WHERE secret_hash = ?', hash(label)),
  );
  return rows[0]?.last_seen_at ?? null;
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  await seed(
    ...role(a, ROLE_ADMIN, 'organization_admin', 'organization', 1, ADMIN_PERMISSIONS),
    ...role(a, ROLE_VIEWER, 'org_viewer', 'organization', 0, ['org:read']),
    ...role(a, ROLE_OWNER, 'project_owner', 'project', 0, OWNER_PERMISSIONS),
    ...role(a, ROLE_BAD_OWNER, 'bad_owner', 'project', 0, [
      'org:read',
      'org:users:read',
      'project:read',
      'project:packages:write',
      'not:a-permission',
    ]),
    ...role(b, ROLE_ADMIN_B, 'organization_admin', 'organization', 1, ADMIN_PERMISSIONS),
    user(a, U1, 'u1@example.test'),
    user(a, U2, 'u2@example.test'),
    user(a, U3, 'u3@example.test', 'suspended'),
    user(b, UB, 'b@example.test'),
    project(a, P1, 'alpha'),
    project(a, P2, 'beta'),
    project(b, PB, 'alpha'),
    binding(a, 'oidc', ANCHOR),
    binding(a, 'other', 'https://other.example.test'),
    binding(b, 'oidc', ANCHOR),
  );
});

afterEach(async () => {
  await database.close();
});

interface OracleGrant {
  readonly type: 'email' | 'group';
  readonly subject: string;
  readonly scope: 'organization' | 'project';
  readonly projectId: string | null;
  readonly permissions: readonly string[];
}

interface OracleFacts {
  readonly email: string;
  readonly emailEvidence: boolean;
  readonly freshGroups: ReadonlySet<string>;
}

function oracle(
  grants: readonly OracleGrant[],
  facts: OracleFacts,
  projectId: string | null,
): { organization: string[]; project: string[] } {
  const known = new Set(PERMISSIONS.map((entry) => entry.name));
  const organization = new Set<string>();
  const project = new Set<string>();
  for (const entry of grants) {
    const applies =
      entry.type === 'email'
        ? facts.emailEvidence && entry.subject === facts.email
        : facts.freshGroups.has(entry.subject);
    if (!applies) continue;
    if (entry.scope === 'organization') {
      for (const name of entry.permissions) if (known.has(name)) organization.add(name);
    } else if (entry.projectId === projectId) {
      for (const name of entry.permissions) {
        if (known.has(name) && name.startsWith('project:')) project.add(name);
      }
    }
  }
  return { organization: [...organization].sort(), project: [...project].sort() };
}

describe('lookupSession envelope and oracle', () => {
  it('returns organization and project arrays equal to the in-memory oracle', async () => {
    await seed(
      identity(a, U1, 'u1@example.test'),
      member(a, U1, 'admins'),
      member(a, U1, 'stale', { refreshedAt: at(-30 * HOUR) }),
      session(a, U1, 'oracle'),
      grant(a, 'email', 'u1@example.test', ROLE_VIEWER),
      grant(a, 'group', 'admins', ROLE_ADMIN),
      grant(a, 'group', 'stale', ROLE_ADMIN),
      grant(a, 'email', 'u1@example.test', ROLE_OWNER, { projectId: P1 }),
      grant(a, 'group', 'admins', ROLE_BAD_OWNER, { projectId: P1 }),
      grant(a, 'email', 'u1@example.test', ROLE_OWNER, { projectId: P2 }),
      grant(a, 'email', 'someone@example.test', ROLE_ADMIN),
    );
    const grants: OracleGrant[] = [
      {
        type: 'email',
        subject: 'u1@example.test',
        scope: 'organization',
        projectId: null,
        permissions: ['org:read'],
      },
      {
        type: 'group',
        subject: 'admins',
        scope: 'organization',
        projectId: null,
        permissions: ADMIN_PERMISSIONS,
      },
      {
        type: 'group',
        subject: 'stale',
        scope: 'organization',
        projectId: null,
        permissions: ADMIN_PERMISSIONS,
      },
      {
        type: 'email',
        subject: 'u1@example.test',
        scope: 'project',
        projectId: P1,
        permissions: OWNER_PERMISSIONS,
      },
      {
        type: 'group',
        subject: 'admins',
        scope: 'project',
        projectId: P1,
        permissions: [
          'org:read',
          'org:users:read',
          'project:read',
          'project:packages:write',
          'not:a-permission',
        ],
      },
      {
        type: 'email',
        subject: 'u1@example.test',
        scope: 'project',
        projectId: P2,
        permissions: OWNER_PERMISSIONS,
      },
      {
        type: 'email',
        subject: 'someone@example.test',
        scope: 'organization',
        projectId: null,
        permissions: ADMIN_PERMISSIONS,
      },
    ];
    const expected = oracle(
      grants,
      { email: 'u1@example.test', emailEvidence: true, freshGroups: new Set(['admins']) },
      P1,
    );

    const result = await lookup('oracle');

    expect(result?.organizationPermissions).toEqual(expected.organization);
    expect(result?.projectPermissions).toEqual(expected.project);
    expect(result?.projectPermissions).toEqual([
      'project:grants:write',
      'project:packages:write',
      'project:read',
    ]);
    expect(result?.project).toMatchObject({ id: P1, slug: 'alpha', status: 'active' });
    expect(result?.session).toMatchObject({ userId: U1, identityId: null });
    expect(result?.user).toEqual({ id: U1, email: 'u1@example.test', displayName: null });
    expect(result?.protectedHolder).toBe(true);
  });

  it('keeps a known user authenticated with empty sets when no permission row matches', async () => {
    await seed(session(a, U2, 'nobody'));

    const result = await lookup('nobody');

    expect(result).not.toBeNull();
    expect(result?.user.id).toBe(U2);
    expect(result?.organizationPermissions).toEqual([]);
    expect(result?.projectPermissions).toEqual([]);
    expect(result?.protectedHolder).toBe(false);
  });

  it('returns null for an unknown, revoked, expired, idle or foreign session and a suspended user', async () => {
    await seed(
      session(a, U1, 'revoked', { revokedAt: at(-MINUTE) }),
      session(a, U1, 'expired', { createdAt: at(-3 * HOUR), expiresAt: at(-MINUTE) }),
      session(a, U1, 'idle', { createdAt: at(-5 * HOUR), lastSeenAt: at(-2 * HOUR) }),
      session(a, U3, 'suspended'),
      session(b, UB, 'foreign'),
      session(a, U1, 'live'),
    );

    for (const label of ['missing', 'revoked', 'expired', 'idle', 'suspended', 'foreign']) {
      expect(await lookup(label), label).toBeNull();
    }
    expect(await lookup('live')).not.toBeNull();
    expect(await lookup('live', {}, b)).toBeNull();
  });

  it('authenticates before resolving the project: unknown, archived and foreign slugs give no project', async () => {
    await seed(
      session(a, U1, 'slug'),
      project(a, '01J0PROJECT0000000000ARCH1', 'archived', 'archived'),
      grant(a, 'email', 'u1@example.test', ROLE_OWNER, { projectId: P1 }),
      grant(a, 'email', 'u1@example.test', ROLE_OWNER, { projectId: '01J0PROJECT0000000000ARCH1' }),
      grant(a, 'email', 'u1@example.test', ROLE_VIEWER),
      identity(a, U1, 'u1@example.test'),
    );

    for (const projectSlug of ['nope', 'archived', 'Alpha', null]) {
      const result = await lookup('slug', { projectSlug });
      expect(result?.user.id, String(projectSlug)).toBe(U1);
      expect(result?.project).toBeNull();
      expect(result?.projectPermissions).toEqual([]);
      expect(result?.organizationPermissions).toEqual(['org:read']);
    }
  });

  it('ignores the slug on an organization boundary and never returns project-scope rows', async () => {
    await seed(
      identity(a, U1, 'u1@example.test'),
      session(a, U1, 'orgb'),
      grant(a, 'email', 'u1@example.test', ROLE_OWNER, { projectId: P1 }),
    );

    const result = await lookup('orgb', { boundary: 'organization' });

    expect(result?.project).toBeNull();
    expect(result?.organizationPermissions).toEqual([]);
    expect(result?.projectPermissions).toEqual([]);
  });

  it('reports identity freshness from database time', async () => {
    await seed(
      identity(a, U1, 'u1@example.test', { validatedAt: at(-HOUR) }),
      identity(a, U2, 'u2@example.test', { validatedAt: at(-30 * HOUR) }),
    );
    const ids = await executor.all<{ id: string; user_id: string }>(
      stmt('SELECT id, user_id FROM identity WHERE org_id = ?', a.orgId),
    );
    const of = (userId: string) => ids.find((row) => row.user_id === userId)?.id ?? null;
    await seed(
      session(a, U1, 'freshid', { identityId: of(U1) }),
      session(a, U2, 'staleid', { identityId: of(U2) }),
    );

    expect((await lookup('freshid'))?.identity).toMatchObject({ provider: 'oidc', fresh: true });
    expect((await lookup('staleid'))?.identity).toMatchObject({ provider: 'oidc', fresh: false });
  });
});

describe('evidence rules', () => {
  beforeEach(async () => {
    await seed(
      session(a, U1, 'ev'),
      grant(a, 'email', 'u1@example.test', ROLE_VIEWER),
      grant(a, 'group', 'admins', ROLE_ADMIN),
    );
  });

  async function organization(
    overrides: Partial<SessionLookupInput> = {},
  ): Promise<readonly string[]> {
    return (await lookup('ev', overrides))?.organizationPermissions ?? ['missing'];
  }

  it('counts a fresh group and drops it when the membership is older than 24 h', async () => {
    await seed(
      identity(a, U1, 'u1@example.test'),
      member(a, U1, 'admins', { refreshedAt: at(-25 * HOUR) }),
    );
    expect(await organization()).toEqual(['org:read']);
  });

  it('drops the group when the identity evidence is older than 24 h or missing', async () => {
    await seed(
      identity(a, U1, 'u1@example.test', { validatedAt: at(-25 * HOUR) }),
      member(a, U1, 'admins'),
    );
    expect(await organization()).toEqual(['org:read']);
  });

  it('keeps a group that is 23 h old', async () => {
    await seed(
      identity(a, U1, 'u1@example.test', { validatedAt: at(-23 * HOUR) }),
      member(a, U1, 'admins', { refreshedAt: at(-23 * HOUR) }),
    );
    expect(await organization()).toEqual([...ADMIN_PERMISSIONS].sort());
  });

  it('removes only the group contribution when the trust anchor changed', async () => {
    await seed(
      identity(a, U1, 'u1@example.test'),
      identity(a, U1, 'u1@example.test', { provider: 'other' }),
      member(a, U1, 'admins'),
    );
    expect(
      await organization({
        providerAnchors: [{ ...OIDC, anchor: 'https://rebound.example.test' }, OTHER_AUTH],
      }),
    ).toEqual(['org:read']);
    expect(await organization({ providerAnchors: [OTHER_AUTH] })).toEqual(['org:read']);
    expect((await organization({ providerAnchors: [OIDC, OTHER_AUTH] })).length).toBeGreaterThan(1);
  });

  it('removes only the group contribution when the identity email is unverified or changed', async () => {
    await seed(
      identity(a, U1, 'u1@example.test', { verified: 0 }),
      identity(a, U1, 'moved@example.test', { provider: 'unlisted' }),
      identity(a, U1, 'u1@example.test', { provider: 'other' }),
      member(a, U1, 'admins'),
    );
    expect(await organization({ providerAnchors: [OIDC, OTHER_AUTH] })).toEqual(['org:read']);
    await seed(stmt("UPDATE identity SET email_verified = 1 WHERE provider = 'oidc'"));
    expect(await organization({ providerAnchors: [OIDC, OTHER_AUTH] })).toEqual(
      [...ADMIN_PERMISSIONS].sort(),
    );
  });

  it('does not satisfy an email grant through a non-authoritative provider', async () => {
    await seed(identity(a, U1, 'u1@example.test'));
    expect(await organization({ providerAnchors: [OIDC_PLAIN] })).toEqual([]);
    expect(await organization({ providerAnchors: [OIDC] })).toEqual(['org:read']);
  });

  it('lets a non-authoritative provider carry a group but not an email grant', async () => {
    await seed(identity(a, U1, 'u1@example.test'), member(a, U1, 'admins'));
    const permissions = await organization({ providerAnchors: [OIDC_PLAIN] });
    expect(permissions).toEqual([...ADMIN_PERMISSIONS].sort());
  });

  it('does not merge the same group name under two providers', async () => {
    await seed(
      identity(a, U1, 'u1@example.test'),
      member(a, U1, 'admins', { provider: 'other' }),
      identity(a, U1, 'u1@example.test', { provider: 'other' }),
    );
    expect(await organization({ providerAnchors: [OIDC, OTHER] })).toEqual(['org:read']);
    await seed(grant(a, 'group', 'admins', ROLE_ADMIN, { provider: 'other' }));
    expect(await organization({ providerAnchors: [OIDC, OTHER] })).toEqual(
      [...ADMIN_PERMISSIONS].sort(),
    );
  });

  it('gives no group authority while the provider has no binding', async () => {
    await seed(
      identity(a, U1, 'u1@example.test', { provider: 'unbound' }),
      member(a, U1, 'admins', { provider: 'unbound' }),
      grant(a, 'group', 'admins', ROLE_VIEWER, { provider: 'unbound' }),
    );
    expect(
      await organization({
        providerAnchors: [{ provider: 'unbound', anchor: 'x', emailAuthoritative: true }],
      }),
    ).toEqual([]);
  });

  it('lets the local-admin path carry an email grant on a protected role', async () => {
    await seed(
      grant(a, 'email', 'u2@example.test', ROLE_ADMIN),
      stmt(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDLOCAL0000000000U2', ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
        a.orgId,
      ),
      stmt(
        "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, 'pbkdf2-sha256$test', '01J0CREDLOCAL0000000000U2', ?)",
        U2,
        a.orgId,
        at(-HOUR),
      ),
      session(a, U2, 'local'),
    );
    const result = await lookup('local');
    expect(result?.organizationPermissions).toEqual([...ADMIN_PERMISSIONS].sort());
    expect(result?.protectedHolder).toBe(true);
  });

  it('omits unknown permissions and filters project roles to project names', async () => {
    await seed(
      identity(a, U1, 'u1@example.test'),
      grant(a, 'email', 'u1@example.test', ROLE_BAD_OWNER, { projectId: P1 }),
    );
    const result = await lookup('ev');
    expect(result?.projectPermissions).toEqual(['project:packages:write', 'project:read']);
    expect(result?.organizationPermissions).toEqual(['org:read']);
  });
});

const ALLOWED_SCAN = /^SCAN (CONSTANT ROW|pr|guard_role)$/;

function unindexedScans(details: readonly string[]): string[] {
  return details.filter((detail) => /^SCAN /.test(detail) && !ALLOWED_SCAN.test(detail));
}

describe('one indexed read', () => {
  it('flags a deliberately unindexed query', async () => {
    const plan = await executor.all<{ detail: string }>({
      sql: 'EXPLAIN QUERY PLAN SELECT id FROM session WHERE csrf_hash = ?',
      params: [hash('x')],
    });
    expect(unindexedScans(plan.map((row) => row.detail))).toEqual(['SCAN session']);
  });

  async function populate(): Promise<void> {
    const statements: Statement[] = [];
    for (let projectIndex = 0; projectIndex < 50; projectIndex += 1) {
      statements.push(
        project(
          a,
          `01J0PROJECTBULK${String(projectIndex).padStart(11, '0')}`,
          `bulk-${projectIndex}`,
        ),
      );
    }
    for (let index = 0; index < 600; index += 1) {
      const userId = `01J0USERBULK${String(index).padStart(14, '0')}`;
      statements.push(user(a, userId, `bulk${index}@example.test`));
      statements.push(identity(a, userId, `bulk${index}@example.test`));
      statements.push(grant(a, 'email', `bulk${index}@example.test`, ROLE_VIEWER));
      statements.push(
        grant(a, 'email', `bulk${index}@example.test`, ROLE_OWNER, {
          projectId: `01J0PROJECTBULK${String(index % 50).padStart(11, '0')}`,
        }),
      );
      statements.push(member(a, userId, `group-${index % 40}`));
      statements.push(member(a, userId, `group-${(index + 1) % 40}`));
      statements.push(session(a, userId, `bulk${index}`));
    }
    await seed(...statements);
  }

  it('issues exactly one executor.all and no batch', async () => {
    await seed(session(a, U1, 'count'), identity(a, U1, 'u1@example.test'));
    const counted = countCalls(executor);
    const repository = createAccessRepository(counted.executor);

    const result = await repository.lookupSession(a, input('count'));

    expect(result?.user.id).toBe(U1);
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    await repository.lookupSession(a, input('missing'));
    await repository.lookupSession(a, input('count', { projectSlug: 'nope' }));
    expect(counted.counts()).toEqual({ all: 3, batch: 0 });
  });

  it('does not write on lookup', async () => {
    await seed(session(a, U1, 'nowrite'));
    await lookup('nowrite');
    expect(await lastSeen('nowrite')).toBeNull();
  });

  for (const phase of ['before ANALYZE', 'after ANALYZE'] as const) {
    it(`searches by index only ${phase}`, async () => {
      await populate();
      if (phase === 'after ANALYZE') await database.analyze();
      for (const boundary of ['project', 'organization'] as const) {
        const statement = lookupSessionStatement(
          a,
          input('bulk17', { boundary, projectSlug: 'bulk-17' }),
        );
        const plan = await executor.all<{ detail: string }>({
          sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
          params: statement.params,
        });
        const details = plan.map((row) => row.detail);
        expect(unindexedScans(details), details.join('\n')).toEqual([]);
        expect(details.some((detail) => detail.includes('session_secret'))).toBe(true);
      }
      const result = await lookup('bulk17', { projectSlug: 'bulk-17' });
      expect(result?.organizationPermissions).toEqual(['org:read']);
      expect(result?.projectPermissions).toEqual(['project:grants:write', 'project:read']);
    });
  }
});

describe('lazy idle touch', () => {
  it('touches a stale session once and not again within five minutes', async () => {
    await seed(
      session(a, U1, 'touch', { createdAt: at(-30 * MINUTE), lastSeenAt: at(-10 * MINUTE) }),
    );
    const repository = createAccessRepository(executor);
    const before = await lastSeen('touch');
    expect(await repository.touchSession(a, 'unknown-session')).toBe(false);

    const id = (
      await executor.all<{ id: string }>(
        stmt('SELECT id FROM session WHERE secret_hash = ?', hash('touch')),
      )
    )[0]?.id;
    if (id === undefined) throw new Error('session missing');

    expect(await repository.touchSession(a, id)).toBe(true);
    const after = await lastSeen('touch');
    expect(Date.parse(after ?? '')).toBeGreaterThan(Date.parse(before ?? ''));
    expect(await repository.touchSession(a, id)).toBe(false);
    expect(await lastSeen('touch')).toBe(after);
  });

  it('does not touch a fresh, revoked, expired or foreign session', async () => {
    await seed(
      session(a, U1, 'fresh', { lastSeenAt: at(-MINUTE) }),
      session(a, U1, 'rev', { lastSeenAt: at(-10 * MINUTE), revokedAt: at(-MINUTE) }),
      session(a, U1, 'exp', {
        createdAt: at(-3 * HOUR),
        lastSeenAt: at(-10 * MINUTE),
        expiresAt: at(-MINUTE),
      }),
      session(a, U1, 'other', { lastSeenAt: at(-10 * MINUTE) }),
    );
    const repository = createAccessRepository(executor);
    const ids = await executor.all<{ id: string; secret_hash: string }>(
      stmt('SELECT id, secret_hash FROM session WHERE org_id = ?', a.orgId),
    );
    for (const label of ['fresh', 'rev', 'exp']) {
      const id = ids.find((row) => row.secret_hash === hash(label))?.id ?? '';
      expect(await repository.touchSession(a, id), label).toBe(false);
    }
    const foreign = ids.find((row) => row.secret_hash === hash('other'))?.id ?? '';
    expect(await repository.touchSession(b, foreign)).toBe(false);
  });
});

describe('permissionRows and holdsPermission', () => {
  async function rows(userId: string, projectId: string | null, anchors = [OIDC]) {
    const statement = compile(permissionRows(a, userId, projectId, anchors));
    return executor.all<{ scope: string; permission: string }>(statement);
  }

  async function holds(
    userId: string,
    permission: string,
    projectId: string | null,
  ): Promise<boolean> {
    const guarded = compile(
      db
        .selectFrom('organization')
        .select('organization.id')
        .where(
          holdsPermission(a, {
            userId,
            permission,
            projectId,
            providerAnchors: [OIDC],
            projectState: 'any',
          }),
        ),
    );
    return (await executor.all(guarded)).length > 0;
  }

  it('returns scope and permission for the user and requested project only', async () => {
    await seed(
      identity(a, U1, 'u1@example.test'),
      grant(a, 'email', 'u1@example.test', ROLE_VIEWER),
      grant(a, 'email', 'u1@example.test', ROLE_OWNER, { projectId: P1 }),
      grant(a, 'email', 'u1@example.test', ROLE_OWNER, { projectId: P2 }),
    );
    const result = await rows(U1, P1);
    expect(result.map((row) => `${row.scope}:${row.permission}`).sort()).toEqual([
      'organization:org:read',
      'project:project:grants:write',
      'project:project:read',
    ]);
    expect((await rows(U1, null)).map((row) => row.scope)).toEqual(['organization']);
  });

  it('answers a permission existence condition per user, permission and project', async () => {
    await seed(
      identity(a, U1, 'u1@example.test'),
      grant(a, 'email', 'u1@example.test', ROLE_OWNER, { projectId: P1 }),
    );
    expect(await holds(U1, 'project:grants:write', P1)).toBe(true);
    expect(await holds(U1, 'project:grants:write', P2)).toBe(false);
    expect(await holds(U2, 'project:grants:write', P1)).toBe(false);
    expect(await holds(U1, 'org:read', P1)).toBe(false);
  });

  it('works inside assertGuard: a held permission passes and a missing one rolls the batch back', async () => {
    await seed(
      identity(a, U1, 'u1@example.test'),
      grant(a, 'email', 'u1@example.test', ROLE_OWNER, { projectId: P1 }),
    );
    const guard = (userId: string, permission: string) =>
      assertGuard(
        holdsPermission(a, {
          userId,
          permission,
          projectId: P1,
          providerAnchors: [OIDC],
          projectState: 'active',
        }),
        a,
      );

    await expect(executor.batch([...guard(U1, 'project:grants:write')])).resolves.toBeDefined();
    await expect(executor.batch([...guard(U2, 'project:grants:write')])).rejects.toThrow();
    await expect(executor.batch([...guard(U1, 'project:settings:write')])).rejects.toThrow();
  });

  it('never lets a project-scope row grant an organization permission', async () => {
    await seed(
      identity(a, U1, 'u1@example.test'),
      grant(a, 'email', 'u1@example.test', ROLE_BAD_OWNER, { projectId: P1 }),
    );
    expect(await holds(U1, 'org:read', P1)).toBe(false);
    expect(await holds(U1, 'org:users:read', null)).toBe(false);
    expect(await holds(U1, 'project:read', P1)).toBe(true);
  });

  it('rejects a malformed provider descriptor', () => {
    expect(() =>
      permissionRows(a, U1, P1, [{ provider: '', anchor: '', emailAuthoritative: true }]),
    ).toThrow(TypeError);
  });
});

describe('round 2', () => {
  const OWNER_GRANT = () => grant(a, 'email', 'u1@example.test', ROLE_OWNER, { projectId: P1 });

  async function holdsWith(
    state: 'active' | 'any',
    userId: string,
    permission: string,
    projectId: string | null,
  ): Promise<boolean> {
    const guarded = compile(
      db
        .selectFrom('organization')
        .select('organization.id')
        .where(
          holdsPermission(a, {
            userId,
            permission,
            projectId,
            providerAnchors: [OIDC],
            projectState: state,
          }),
        ),
    );
    return (await executor.all(guarded)).length > 0;
  }

  async function ids(): Promise<Record<string, string>> {
    const rows = await executor.all<{ id: string; user_id: string }>(
      stmt('SELECT id, user_id FROM identity WHERE org_id = ?', a.orgId),
    );
    return Object.fromEntries(rows.map((row) => [row.user_id, row.id]));
  }

  describe('one clock', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('ignores the JavaScript clock: the whole lookup uses database time', async () => {
      await seed(
        identity(a, U1, 'u1@example.test'),
        member(a, U1, 'admins'),
        grant(a, 'group', 'admins', ROLE_ADMIN),
        session(a, U1, 'skew'),
      );
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2041-01-01T00:00:00.000Z'));

      const result = await lookup('skew');

      expect(result?.organizationPermissions).toEqual([...ADMIN_PERMISSIONS].sort());
      expect(result?.protectedHolder).toBe(true);
    });
  });

  describe('protected holder bit', () => {
    it('is false for a stale group and for an e-mail grant via a non-authoritative provider', async () => {
      await seed(
        identity(a, U1, 'u1@example.test'),
        member(a, U1, 'admins', { refreshedAt: at(-25 * HOUR) }),
        grant(a, 'group', 'admins', ROLE_ADMIN),
        session(a, U1, 'holder-stale'),
        identity(a, U2, 'u2@example.test'),
        grant(a, 'email', 'u2@example.test', ROLE_ADMIN),
        session(a, U2, 'holder-plain'),
      );

      expect((await lookup('holder-stale'))?.protectedHolder).toBe(false);
      const plain = await lookup('holder-plain', { providerAnchors: [OIDC_PLAIN] });
      expect(plain?.protectedHolder).toBe(false);
      expect((await lookup('holder-plain'))?.protectedHolder).toBe(true);
    });
  });

  describe('evidence in the future and cross-organization', () => {
    beforeEach(async () => {
      await seed(
        identity(a, U1, 'u1@example.test'),
        grant(a, 'group', 'admins', ROLE_ADMIN),
        session(a, U1, 'future'),
      );
    });

    it('rejects membership dated more than 60 s ahead and keeps one dated 30 s ahead', async () => {
      await seed(member(a, U1, 'admins', { refreshedAt: at(2 * MINUTE) }));
      expect((await lookup('future'))?.organizationPermissions).toEqual([]);
      await seed(stmt('UPDATE user_group SET refreshed_at = ?', at(30_000)));
      expect((await lookup('future'))?.organizationPermissions).toEqual(
        [...ADMIN_PERMISSIONS].sort(),
      );
    });

    it('does not leak an organization B grant on the same e-mail or group into organization A', async () => {
      await seed(
        grant(b, 'email', 'u1@example.test', ROLE_ADMIN_B),
        grant(b, 'group', 'admins', ROLE_ADMIN_B),
        member(a, U1, 'other-group'),
      );
      expect((await lookup('future'))?.organizationPermissions).toEqual([]);
    });
  });

  describe('role and grant scope agreement', () => {
    it('ignores a project grant on an organization role and an organization grant on a project role', async () => {
      await seed(
        identity(a, U1, 'u1@example.test'),
        session(a, U1, 'mismatch'),
        grant(a, 'email', 'u1@example.test', ROLE_VIEWER, { projectId: P1 }),
        grant(a, 'group', 'owners', ROLE_OWNER),
        member(a, U1, 'owners'),
      );
      const result = await lookup('mismatch');
      expect(result?.organizationPermissions).toEqual([]);
      expect(result?.projectPermissions).toEqual([]);
    });
  });

  describe('session identity', () => {
    it('denies a session whose identity belongs to another user', async () => {
      await seed(identity(a, U2, 'u2@example.test'));
      const other = (await ids())[U2] ?? null;
      await seed(session(a, U1, 'borrowed', { identityId: other }));
      expect(await lookup('borrowed')).toBeNull();
    });

    it('denies a session whose identity row is gone', async () => {
      await seed(session(a, U1, 'dangling'));
      await executor.all(stmt('PRAGMA foreign_keys = OFF'));
      await seed(
        stmt(
          'UPDATE session SET identity_id = ? WHERE secret_hash = ?',
          'missing-identity',
          hash('dangling'),
        ),
      );
      await executor.all(stmt('PRAGMA foreign_keys = ON'));
      expect(await lookup('dangling')).toBeNull();
    });

    it('requires the provider binding with the configured anchor for identity.fresh', async () => {
      await seed(identity(a, U1, 'u1@example.test'));
      const id = (await ids())[U1] ?? null;
      await seed(session(a, U1, 'fresh-id', { identityId: id }));
      expect((await lookup('fresh-id'))?.identity?.fresh).toBe(true);
      const rebound = { providerAnchors: [{ ...OIDC, anchor: 'https://rebound.example.test' }] };
      expect((await lookup('fresh-id', rebound))?.identity?.fresh).toBe(false);
      expect((await lookup('fresh-id', { providerAnchors: [] }))?.identity?.fresh).toBe(false);
    });
  });

  describe('local-admin eligibility', () => {
    async function localAdmin(): Promise<void> {
      await seed(
        grant(a, 'email', 'u2@example.test', ROLE_ADMIN),
        stmt(
          "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDLOCAL0000000000U2', ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
          a.orgId,
        ),
        stmt(
          "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, 'pbkdf2-sha256$test', '01J0CREDLOCAL0000000000U2', ?)",
          U2,
          a.orgId,
          at(-HOUR),
        ),
        identity(a, U2, 'u2@example.test', { provider: 'unlisted' }),
      );
    }

    it('applies only to a session without an identity', async () => {
      await localAdmin();
      const id = (await ids())[U2] ?? null;
      await seed(session(a, U2, 'local-null'), session(a, U2, 'local-sso', { identityId: id }));

      expect((await lookup('local-null'))?.organizationPermissions).toEqual(
        [...ADMIN_PERMISSIONS].sort(),
      );
      expect((await lookup('local-sso'))?.organizationPermissions).toEqual([]);
      expect((await lookup('local-sso'))?.protectedHolder).toBe(false);
    });

    it('never carries a project-scope grant', async () => {
      await seed(
        stmt('UPDATE role SET protects_last_holder = 1 WHERE id = ?', ROLE_OWNER),
        grant(a, 'email', 'u2@example.test', ROLE_OWNER, { projectId: P1 }),
        stmt(
          "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDLOCAL0000000000U2', ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
          a.orgId,
        ),
        stmt(
          "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, 'pbkdf2-sha256$test', '01J0CREDLOCAL0000000000U2', ?)",
          U2,
          a.orgId,
          at(-HOUR),
        ),
        session(a, U2, 'local-project'),
      );
      const result = await lookup('local-project');
      expect(result?.projectPermissions).toEqual([]);
    });
  });

  describe('holdsPermission', () => {
    it('refuses an archived project with active and passes with any', async () => {
      await seed(
        identity(a, U1, 'u1@example.test'),
        project(a, '01J0PROJECT0000000000ARCH2', 'old', 'archived'),
        grant(a, 'email', 'u1@example.test', ROLE_OWNER, {
          projectId: '01J0PROJECT0000000000ARCH2',
        }),
        OWNER_GRANT(),
      );
      const archived = '01J0PROJECT0000000000ARCH2';
      expect(await holdsWith('active', U1, 'project:grants:write', archived)).toBe(false);
      expect(await holdsWith('any', U1, 'project:grants:write', archived)).toBe(true);
      expect(await holdsWith('active', U1, 'project:grants:write', P1)).toBe(true);
    });

    it('grants local-admin eligibility only through a live session without an identity', async () => {
      await seed(
        grant(a, 'email', 'u2@example.test', ROLE_ADMIN),
        stmt(
          "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDLOCAL0000000000U2', ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
          a.orgId,
        ),
        stmt(
          "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, 'pbkdf2-sha256$test', '01J0CREDLOCAL0000000000U2', ?)",
          U2,
          a.orgId,
          at(-HOUR),
        ),
        identity(a, U2, 'u2@example.test', { provider: 'unlisted' }),
        session(a, U2, 'hp-local'),
        session(a, U2, 'hp-revoked', { revokedAt: at(-MINUTE) }),
      );
      const identityId = (await ids())[U2] ?? null;
      await seed(session(a, U2, 'hp-sso', { identityId }), session(b, UB, 'hp-foreign'));
      const sessionId = async (label: string) =>
        (
          await executor.all<{ id: string }>(
            stmt('SELECT id FROM session WHERE secret_hash = ?', hash(label)),
          )
        )[0]?.id ?? 'none';
      const held = async (session: string | undefined): Promise<boolean> =>
        (
          await executor.all(
            compile(
              db
                .selectFrom('organization')
                .select('organization.id')
                .where(
                  holdsPermission(a, {
                    userId: U2,
                    permission: 'org:read',
                    projectId: null,
                    providerAnchors: [OIDC],
                    projectState: 'any',
                    ...(session === undefined ? {} : { session }),
                  }),
                ),
            ),
          )
        ).length > 0;

      expect(await held(await sessionId('hp-local'))).toBe(true);
      expect(await held(undefined)).toBe(false);
      expect(await held(await sessionId('hp-sso'))).toBe(false);
      expect(await held(await sessionId('hp-revoked'))).toBe(false);
      expect(await held(await sessionId('hp-foreign'))).toBe(false);
      expect(await held('unknown-session')).toBe(false);
    });

    it('refuses a suspended user', async () => {
      await seed(
        user(a, '01J0USER000000000000000004', 'u4@example.test', 'suspended'),
        identity(a, '01J0USER000000000000000004', 'u4@example.test'),
        grant(a, 'email', 'u4@example.test', ROLE_VIEWER),
      );
      expect(await holdsWith('any', '01J0USER000000000000000004', 'org:read', null)).toBe(false);
    });

    it('accepts a correlated column operand inside assertGuard', async () => {
      await seed(identity(a, U1, 'u1@example.test'), OWNER_GRANT());
      const guard = (email: string) =>
        assertGuard(
          existsGuard((database) =>
            database
              .selectFrom('user_account')
              .select('user_account.id')
              .where('user_account.email', '=', email)
              .where((eb) =>
                holdsPermission(a, {
                  userId: eb.ref('user_account.id'),
                  permission: 'project:grants:write',
                  projectId: P1,
                  providerAnchors: [OIDC],
                  projectState: 'active',
                }),
              ),
          ),
          a,
        );
      await expect(executor.batch([...guard('u1@example.test')])).resolves.toBeDefined();
      await expect(executor.batch([...guard('u2@example.test')])).rejects.toThrow();
    });
  });

  describe('touchSession idle and user checks', () => {
    async function idOf(label: string): Promise<string> {
      const rows = await executor.all<{ id: string }>(
        stmt('SELECT id FROM session WHERE secret_hash = ?', hash(label)),
      );
      return rows[0]?.id ?? '';
    }

    it('does not touch an idle session or one of a suspended user', async () => {
      await seed(
        session(a, U1, 'idle-touch', { createdAt: at(-5 * HOUR), lastSeenAt: at(-2 * HOUR) }),
        session(a, U3, 'susp-touch', { lastSeenAt: at(-10 * MINUTE) }),
      );
      const repository = createAccessRepository(executor);
      expect(await repository.touchSession(a, await idOf('idle-touch'))).toBe(false);
      expect(await repository.touchSession(a, await idOf('susp-touch'))).toBe(false);
    });

    it('validates idleSeconds as an integer from 60 to 86400', () => {
      for (const idleSeconds of [59, 86401, 1.5, Number.NaN]) {
        expect(() => createAccessRepository(executor, { idleSeconds })).toThrow(RangeError);
      }
      expect(() => createAccessRepository(executor, { idleSeconds: 60 })).not.toThrow();
    });
  });
});
