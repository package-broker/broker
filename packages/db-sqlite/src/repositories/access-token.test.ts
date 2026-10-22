import { describeTokenContract } from '../contract/token-contract.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { createAuthorizationEngine, patValidationGate } from '@package-broker/core/authz/engine';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { formatToken } from '@package-broker/core/secrets/token-format';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createAccessRepository,
  lookupTokenStatement,
  tokenProjectMode,
  type ProtectedHolderProvider,
  type TokenLookupInput,
} from './access.js';
import { batchInChunks } from '../testing/chunked-batch.js';

const HOUR = 3600_000;

const ROLE_ORG = '01J0ROLEORG0000000000000AA';
const ROLE_DEV = '01J0ROLEDEV0000000000000AA';
const ROLE_HOLDER = '01J0ROLEHOLDER000000000AA';
const ROLE_ORG_B = '01J0ROLEORG0000000000000BB';

const U1 = '01J0USER000000000000000001';
const U2 = '01J0USER000000000000000002';
const U3 = '01J0USER000000000000000003';
const UB = '01J0USER00000000000000000B';

const P1 = '01J0PROJECT0000000000000P1';
const P2 = '01J0PROJECT0000000000000P2';
const PB = '01J0PROJECT0000000000000PB';

const SP1 = '01J0SERVICE00000000000000P1';
const SPW = '01J0SERVICE00000000000000PW';

const IDENTITY_U1 = '01J0IDENT000000000000000U1';

const ANCHOR = 'https://idp.example.test';
const OIDC: ProtectedHolderProvider = {
  provider: 'oidc',
  anchor: ANCHOR,
  emailAuthoritative: true,
  emailAuthoritativeDomains: ['example.test'],
};

const ORG_PERMISSIONS = ['org:read', 'org:users:write', 'project:read', 'project:packages:read'];
const DEV_PERMISSIONS = [
  'project:read',
  'project:packages:write',
  'project:settings:write',
  'project:grants:write',
];

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

// The same allow-list as access-session.test.ts: the constant JSON row, the aggregate over the
// permission rows, the bound values CTE, the JSON anchors table and the role table, which holds a
// handful of rows and is scanned only when the planner has statistics saying so.
const ALLOWED_SCAN =
  /^SCAN (CONSTANT ROW|pr|guard_role|guard_values|json_each VIRTUAL TABLE INDEX \d+:)$/;

function unindexedScans(details: readonly string[]): string[] {
  return details.filter((detail) => /^SCAN /.test(detail) && !ALLOWED_SCAN.test(detail));
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function selector(label: string): string {
  return Array.from(
    label.padEnd(12, 'a').slice(0, 12),
    (char) => ALPHABET[char.charCodeAt(0) % 32],
  ).join('');
}

function seq(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(26 - prefix.length, '0')}`;
}

async function seed(...statements: Statement[]): Promise<void> {
  await batchInChunks(executor, statements);
}

function role(
  org: OrgContext,
  id: string,
  key: string,
  scope: 'organization' | 'project',
  permissions: readonly string[],
  protects = 0,
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

function project(
  org: OrgContext,
  id: string,
  slug: string,
  options: { readonly status?: string; readonly maxScope?: string } = {},
): Statement {
  return stmt(
    'INSERT INTO project (id, org_id, slug, name, status, token_max_scope) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    slug,
    slug,
    options.status ?? 'active',
    options.maxScope ?? 'full',
  );
}

function grant(
  org: OrgContext,
  email: string,
  roleId: string,
  projectId: string | null = null,
): Statement {
  return stmt(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
    seq('01J0GRANT'),
    org.orgId,
    'email',
    email,
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
  );
}

function identity(
  org: OrgContext,
  id: string,
  userId: string,
  email: string,
  validatedAt: string,
): Statement {
  return stmt(
    'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    id,
    org.orgId,
    userId,
    'oidc',
    `subject-${id}`,
    email,
    validatedAt,
  );
}

interface TokenOptions {
  readonly org?: OrgContext;
  readonly userId?: string;
  readonly projectId?: string | null;
  readonly mode?: 'all' | 'selected' | null;
  readonly scopes?: string;
  readonly readOnly?: number;
  readonly validationKind?: 'sso' | 'local' | null;
  readonly validationIdentityId?: string | null;
  readonly expiresAt?: string;
  readonly revokedAt?: string | null;
}

function pat(label: string, options: TokenOptions = {}): Statement {
  const validationKind = options.validationKind === undefined ? 'sso' : options.validationKind;
  const identityId =
    options.validationIdentityId === undefined ? IDENTITY_U1 : options.validationIdentityId;
  return stmt(
    'INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, user_id, project_id, project_mode, validation_kind, validation_identity_id, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    `tok-${label}`,
    (options.org ?? a).orgId,
    'pat',
    selector(label),
    'a'.repeat(64),
    label,
    options.scopes ?? '["full"]',
    options.readOnly ?? 0,
    options.userId ?? U1,
    options.projectId ?? null,
    options.mode === undefined ? 'all' : options.mode,
    validationKind,
    validationKind === 'sso' ? identityId : null,
    options.expiresAt ?? at(HOUR),
    options.revokedAt ?? null,
  );
}

function bind(label: string, projectId: string, org: OrgContext = a): Statement {
  return stmt(
    'INSERT INTO token_project (org_id, token_id, project_id) VALUES (?, ?, ?)',
    org.orgId,
    `tok-${label}`,
    projectId,
  );
}

function principal(
  id: string,
  name: string,
  projectId: string | null,
  creator: string,
  status = 'active',
): Statement {
  return stmt(
    'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id, status) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    a.orgId,
    name,
    projectId,
    creator,
    status,
  );
}

function principalPermission(principalId: string, permission: string): Statement {
  return stmt(
    'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
    a.orgId,
    principalId,
    permission,
  );
}

function svc(
  label: string,
  principalId: string,
  options: {
    readonly projectId?: string | null;
    readonly scopes?: string;
    readonly readOnly?: number;
    readonly expiresAt?: string;
    readonly revokedAt?: string | null;
  } = {},
): Statement {
  return stmt(
    'INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, service_principal_id, project_id, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
    `tok-${label}`,
    a.orgId,
    'svc',
    selector(label),
    'b'.repeat(64),
    label,
    options.scopes ?? '["full"]',
    options.readOnly ?? 0,
    principalId,
    options.projectId ?? null,
    options.expiresAt ?? at(HOUR),
    options.revokedAt ?? null,
  );
}

function input(label: string, overrides: Partial<TokenLookupInput> = {}): TokenLookupInput {
  return {
    selector: selector(label),
    boundary: 'project',
    projectSlug: 'alpha',
    providerAnchors: [OIDC],
    ...overrides,
  };
}

async function lookup(label: string, overrides: Partial<TokenLookupInput> = {}, org = a) {
  return createAccessRepository(executor).lookupToken(org, input(label, overrides));
}

async function projectPermissions(label: string, overrides: Partial<TokenLookupInput> = {}) {
  const result = await lookup(label, overrides);
  return result?.projectPermissions ?? ['<no envelope>'];
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  await seed(
    ...role(a, ROLE_ORG, 'org_role', 'organization', ORG_PERMISSIONS),
    ...role(a, ROLE_HOLDER, 'holder_role', 'organization', ['org:read', 'project:read'], 1),
    ...role(a, ROLE_DEV, 'dev_role', 'project', DEV_PERMISSIONS),
    ...role(b, ROLE_ORG_B, 'org_role', 'organization', ORG_PERMISSIONS),
    user(a, U1, 'u1@example.test'),
    user(a, U2, 'u2@example.test'),
    user(a, U3, 'u3@example.test', 'suspended'),
    user(b, UB, 'b@example.test'),
    project(a, P1, 'alpha'),
    project(a, P2, 'beta'),
    project(b, PB, 'alpha'),
    stmt(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      a.orgId,
      'oidc',
      ANCHOR,
    ),
    identity(a, IDENTITY_U1, U1, 'u1@example.test', at(-HOUR)),
    grant(a, 'u1@example.test', ROLE_ORG),
    grant(a, 'u1@example.test', ROLE_DEV, P1),
  );
});

afterEach(async () => {
  await database.close();
});

describe('lookupToken personal access tokens', () => {
  it('resolves the live user grants through the scope mask', async () => {
    await seed(pat('pat-all'));

    const result = await lookup('pat-all');

    expect(result?.token).toMatchObject({
      id: 'tok-pat-all',
      kind: 'pat',
      userId: U1,
      projectMode: 'all',
      scope: { level: 'full', readOnly: false },
      expired: false,
      revoked: false,
    });
    expect(result?.project?.slug).toBe('alpha');
    expect(result?.validation).toEqual({
      kind: 'sso',
      identityId: IDENTITY_U1,
      fresh: true,
      evidenceAt: expect.any(String),
    });
    expect(result?.principalStatus).toBe('active');
    expect(result?.projectPermissions).toEqual([
      'project:packages:read',
      'project:packages:write',
      'project:read',
    ]);
    expect(result?.organizationPermissions).toEqual([]);
  });

  it('drops a permission on the next read once its grant is removed', async () => {
    await seed(pat('pat-rm'));
    expect(await projectPermissions('pat-rm')).toContain('project:packages:write');

    await seed(stmt('DELETE FROM access_grant WHERE role_id = ?', ROLE_DEV));

    expect(await projectPermissions('pat-rm')).toEqual(['project:packages:read', 'project:read']);
    await seed(stmt('DELETE FROM access_grant WHERE role_id = ?', ROLE_ORG));
    const result = await lookup('pat-rm');
    expect(result).not.toBeNull();
    expect(result?.projectPermissions).toEqual([]);
    expect(result?.principalStatus).toBe('active');
  });

  it('applies the scope level, read_only and the project token_max_scope', async () => {
    await seed(
      pat('pat-read', { scopes: '["read"]', readOnly: 1 }),
      pat('pat-write', { scopes: '["write"]' }),
      pat('pat-bad', { scopes: '["write"]', readOnly: 1 }),
      pat('pat-junk', { scopes: '["write","read"]' }),
    );

    expect(await projectPermissions('pat-read')).toEqual(['project:packages:read', 'project:read']);
    expect(await projectPermissions('pat-write')).toEqual([
      'project:packages:read',
      'project:packages:write',
      'project:read',
    ]);
    expect(await projectPermissions('pat-bad')).toEqual([]);
    expect(await projectPermissions('pat-junk')).toEqual([]);
    expect((await lookup('pat-bad'))?.token.scope).toBeNull();

    await seed(stmt('UPDATE project SET token_max_scope = ? WHERE id = ?', 'read', P1));
    expect(await projectPermissions('pat-write')).toEqual([
      'project:packages:read',
      'project:read',
    ]);
    expect(await projectPermissions('pat-read')).toEqual(['project:packages:read', 'project:read']);
  });

  it('gives a selected PAT only its bound projects and a uniform 404 envelope elsewhere', async () => {
    await seed(
      grant(a, 'u1@example.test', ROLE_DEV, P2),
      pat('pat-sel', { mode: 'selected' }),
      bind('pat-sel', P1),
    );

    expect((await projectPermissions('pat-sel')).length).toBeGreaterThan(0);

    const unbound = await lookup('pat-sel', { projectSlug: 'beta' });
    const unknown = await lookup('pat-sel', { projectSlug: 'nope' });
    expect(unbound).not.toBeNull();
    expect(unbound?.project).toBeNull();
    expect(unbound?.projectPermissions).toEqual([]);
    expect(unbound?.organizationPermissions).toEqual([]);
    expect(unbound).toHaveProperty('projectVisible', true);
    expect(Object.keys(unbound ?? {})).toContain('projectVisible');
    const { projectVisible: unboundVisible, ...unboundEnvelope } = unbound!;
    expect(unboundVisible).toBe(true);
    await seed(
      project(a, '01J0PROJECT0000000000000P3', 'gone', { status: 'archived' }),
      project(b, '01J0PROJECT0000000000000PG', 'gamma'),
    );
    for (const hidden of [
      unknown,
      await lookup('pat-sel', { projectSlug: 'gone' }),
      await lookup('pat-sel', { projectSlug: 'gamma' }),
    ]) {
      const { projectVisible, ...envelope } = hidden!;
      expect(projectVisible).toBe(false);
      expect(envelope).toEqual(unboundEnvelope);
    }
  });

  it('denies every project for a selected PAT with no live binding', async () => {
    await seed(pat('pat-none', { mode: 'selected' }));

    for (const slug of ['alpha', 'beta']) {
      const result = await lookup('pat-none', { projectSlug: slug });
      expect(result).not.toBeNull();
      expect(result?.project).toBeNull();
      expect(result?.projectPermissions).toEqual([]);
    }
    const orgBoundary = await lookup('pat-none', { boundary: 'organization', projectSlug: null });
    expect(orgBoundary?.organizationPermissions).toEqual([]);
  });

  it('does not leak permissions of a project bound on another token', async () => {
    await seed(
      pat('pat-a', { mode: 'selected' }),
      pat('pat-b', { mode: 'selected' }),
      bind('pat-b', P1),
    );

    expect(await projectPermissions('pat-a')).toEqual([]);
    expect((await projectPermissions('pat-b')).length).toBeGreaterThan(0);
  });

  it('limits an organization boundary to an all-project full PAT', async () => {
    await seed(
      pat('pat-org', { mode: 'all' }),
      pat('pat-orgw', { mode: 'all', scopes: '["write"]' }),
      pat('pat-orgs', { mode: 'selected' }),
      bind('pat-orgs', P1),
    );
    const org = { boundary: 'organization', projectSlug: null } as const;

    const full = await lookup('pat-org', org);
    expect(full?.project).toBeNull();
    expect(full?.organizationPermissions).toEqual(['org:read']);
    expect(full?.projectPermissions).toEqual([]);
    expect((await lookup('pat-orgw', org))?.organizationPermissions).toEqual([]);
    expect((await lookup('pat-orgs', org))?.organizationPermissions).toEqual([]);
  });

  it('keeps a known principal with no permissions when the user holds nothing', async () => {
    await seed(
      user(a, '01J0USER000000000000000004', 'u4@example.test'),
      identity(
        a,
        '01J0IDENT000000000000000U4',
        '01J0USER000000000000000004',
        'u4@example.test',
        at(-HOUR),
      ),
      pat('pat-empty', {
        userId: '01J0USER000000000000000004',
        validationIdentityId: '01J0IDENT000000000000000U4',
      }),
    );

    const result = await lookup('pat-empty');

    expect(result?.token.userId).toBe('01J0USER000000000000000004');
    expect(result?.projectPermissions).toEqual([]);
  });

  it('returns the envelope for expired and revoked tokens with no authority', async () => {
    await seed(pat('pat-exp', { expiresAt: at(-1000) }), pat('pat-rev', { revokedAt: at(-1000) }));

    const expired = await lookup('pat-exp');
    const revoked = await lookup('pat-rev');

    expect(expired?.token).toMatchObject({ expired: true, revoked: false });
    expect(revoked?.token).toMatchObject({ expired: false, revoked: true });
    expect(expired?.projectPermissions).toEqual([]);
    expect(revoked?.projectPermissions).toEqual([]);
  });

  it('denies when the user is suspended or the validation evidence is stale or missing', async () => {
    await seed(
      identity(a, '01J0IDENT000000000000000U3', U3, 'u3@example.test', at(-HOUR)),
      grant(a, 'u3@example.test', ROLE_ORG),
      pat('pat-susp', { userId: U3, validationIdentityId: '01J0IDENT000000000000000U3' }),
      pat('pat-nokind', { validationKind: null }),
      pat('pat-orphan', { validationIdentityId: null }),
    );

    const suspended = await lookup('pat-susp');
    expect(suspended?.principalStatus).toBe('suspended');
    expect(suspended?.projectPermissions).toEqual([]);
    expect(await projectPermissions('pat-nokind')).toEqual([]);
    expect(await projectPermissions('pat-orphan')).toEqual([]);

    await seed(pat('pat-fresh'));
    expect((await lookup('pat-fresh'))?.validation?.fresh).toBe(true);
    const staleAt = at(-30 * HOUR);
    await seed(stmt('UPDATE identity SET validated_at = ? WHERE id = ?', staleAt, IDENTITY_U1));
    const stale = await lookup('pat-fresh');
    expect(stale?.validation).toEqual({
      kind: 'sso',
      identityId: IDENTITY_U1,
      fresh: false,
      evidenceAt: staleAt,
    });
    expect(stale?.projectPermissions).toEqual([]);
  });
});

describe('lookupToken project binding for listing', () => {
  const org = { boundary: 'organization', projectSlug: null } as const;

  it('reports the bound project ids of a selected PAT in id order on every boundary', async () => {
    await seed(pat('pat-ids', { mode: 'selected' }), bind('pat-ids', P2), bind('pat-ids', P1));

    expect((await lookup('pat-ids', org))?.token.boundProjectIds).toEqual([P1, P2]);
    expect((await lookup('pat-ids'))?.token.boundProjectIds).toEqual([P1, P2]);
  });

  it('reports no ids for an all-project PAT, a selected PAT without rows and a service token', async () => {
    await seed(
      pat('pat-all'),
      pat('pat-nobind', { mode: 'selected' }),
      principal(SP1, 'ci', null, U1),
      svc('svc-ids', SP1),
    );

    expect((await lookup('pat-all', org))?.token.boundProjectIds).toEqual([]);
    expect((await lookup('pat-nobind', org))?.token.boundProjectIds).toEqual([]);
    expect((await lookup('svc-ids', org))?.token.boundProjectIds).toEqual([]);
  });

  it('ignores a binding row stored for another organization and another token', async () => {
    await seed(
      pat('pat-one', { mode: 'selected' }),
      pat('pat-two', { mode: 'selected' }),
      bind('pat-one', P1),
      bind('pat-two', P2),
      stmt(
        'INSERT INTO token_project (org_id, token_id, project_id) VALUES (?, ?, ?)',
        b.orgId,
        'tok-pat-one',
        PB,
      ),
    );

    expect((await lookup('pat-one', org))?.token.boundProjectIds).toEqual([P1]);
  });

  it('reports the inherited organization project:read of a live PAT owner', async () => {
    await seed(pat('pat-inh'), pat('pat-inhr', { scopes: '["read"]', readOnly: 1 }));

    expect((await lookup('pat-inh', org))?.projectReadInherited).toBe(true);
    expect((await lookup('pat-inhr', org))?.projectReadInherited).toBe(true);
  });

  it('does not report inheritance when the owner holds no organization project:read', async () => {
    await seed(
      pat('pat-noinh', { userId: U2, validationKind: 'local' }),
      pat('pat-grant-only'),
      stmt(
        "DELETE FROM access_grant WHERE subject_value = ? AND scope = 'organization'",
        'u1@example.test',
      ),
    );

    expect((await lookup('pat-noinh', org))?.projectReadInherited).toBe(false);
    expect((await lookup('pat-grant-only', org))?.projectReadInherited).toBe(false);
  });

  it('does not report inheritance for an expired or revoked token or a suspended owner', async () => {
    await seed(
      pat('pat-exp', { expiresAt: at(-HOUR) }),
      pat('pat-rev', { revokedAt: at(-HOUR) }),
      pat('pat-susp', { userId: U3 }),
    );

    for (const label of ['pat-exp', 'pat-rev', 'pat-susp']) {
      expect((await lookup(label, org))?.projectReadInherited).toBe(false);
    }
  });
});

describe('lookupToken service tokens', () => {
  beforeEach(async () => {
    await seed(
      principal(SP1, 'ci', P1, U3),
      principalPermission(SP1, 'project:read'),
      principalPermission(SP1, 'project:packages:write'),
      principalPermission(SP1, 'project:grants:write'),
      principalPermission(SP1, 'not:a-permission'),
      principal(SPW, 'wide', null, U3),
      principalPermission(SPW, 'project:read'),
      principalPermission(SPW, 'org:read'),
      principalPermission(SPW, 'org:users:write'),
    );
  });

  it('resolves the stored service permissions, not the creator grants', async () => {
    await seed(grant(a, 'u3@example.test', ROLE_ORG), svc('svc-ci', SP1, { projectId: P1 }));

    const result = await lookup('svc-ci');

    expect(result?.token).toMatchObject({
      kind: 'svc',
      userId: null,
      servicePrincipalId: SP1,
      boundProjectId: P1,
    });
    expect(result?.validation).toBeNull();
    expect(result?.principalStatus).toBe('active');
    expect(result?.projectPermissions).toEqual(['project:packages:write', 'project:read']);
  });

  it('is unaffected by the suspended creator and follows service permission removal', async () => {
    await seed(svc('svc-ci', SP1, { projectId: P1 }));
    expect(await projectPermissions('svc-ci')).toEqual(['project:packages:write', 'project:read']);

    await seed(stmt('UPDATE user_account SET status = ? WHERE id = ?', 'suspended', U1));
    expect(await projectPermissions('svc-ci')).toEqual(['project:packages:write', 'project:read']);

    await seed(
      stmt(
        'DELETE FROM service_principal_permission WHERE service_principal_id = ? AND permission = ?',
        SP1,
        'project:packages:write',
      ),
    );
    expect(await projectPermissions('svc-ci')).toEqual(['project:read']);
  });

  it('applies the scope mask and denies a suspended principal', async () => {
    await seed(svc('svc-ro', SP1, { projectId: P1, scopes: '["read"]', readOnly: 1 }));
    expect(await projectPermissions('svc-ro')).toEqual(['project:read']);

    await seed(stmt('UPDATE service_principal SET status = ? WHERE id = ?', 'suspended', SP1));
    const result = await lookup('svc-ro');
    expect(result?.principalStatus).toBe('suspended');
    expect(result?.projectPermissions).toEqual([]);
  });

  it('does not leak a project-bound principal into another project', async () => {
    await seed(svc('svc-ci', SP1, { projectId: P1 }));

    const other = await lookup('svc-ci', { projectSlug: 'beta' });

    expect(other).not.toBeNull();
    expect(other?.project).toBeNull();
    expect(other?.projectPermissions).toEqual([]);
    expect(other).toEqual(await lookup('svc-ci', { projectSlug: 'nope' }));
  });

  it('lets an organization-wide principal pass any project and the organization boundary', async () => {
    await seed(svc('svc-wide', SPW));

    expect(await projectPermissions('svc-wide', { projectSlug: 'beta' })).toEqual(['project:read']);
    const org = await lookup('svc-wide', { boundary: 'organization', projectSlug: null });
    expect(org?.organizationPermissions).toEqual(['org:read']);

    await seed(svc('svc-bound', SP1, { projectId: P1 }));
    const bound = await lookup('svc-bound', { boundary: 'organization', projectSlug: null });
    expect(bound?.organizationPermissions).toEqual([]);
  });

  it('returns the envelope for expired and revoked service tokens with no authority', async () => {
    await seed(
      svc('svc-exp', SP1, { projectId: P1, expiresAt: at(-1000) }),
      svc('svc-rev', SP1, { projectId: P1, revokedAt: at(-1000) }),
    );

    expect((await lookup('svc-exp'))?.token.expired).toBe(true);
    expect((await lookup('svc-rev'))?.token.revoked).toBe(true);
    expect(await projectPermissions('svc-exp')).toEqual([]);
    expect(await projectPermissions('svc-rev')).toEqual([]);
  });

  it('gives a principal with no stored permission a known empty envelope', async () => {
    await seed(
      principal('01J0SERVICE00000000000000PE', 'empty', P1, U3),
      svc('svc-empty', '01J0SERVICE00000000000000PE', { projectId: P1 }),
    );

    const result = await lookup('svc-empty');

    expect(result?.token.kind).toBe('svc');
    expect(result?.projectPermissions).toEqual([]);
  });
});

describe('lookupToken boundaries', () => {
  it('returns null for unknown selectors, other organizations and customer tokens', async () => {
    await seed(
      pat('pat-a'),
      stmt(
        'INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, project_mode, expires_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
        'tok-b',
        b.orgId,
        'pat',
        selector('pat-b'),
        'c'.repeat(64),
        'pat-b',
        '["full"]',
        UB,
        'all',
        at(HOUR),
      ),
    );

    expect(await lookup('missing')).toBeNull();
    expect(await lookup('pat-b')).toBeNull();
    expect(await lookup('pat-a', {}, b)).toBeNull();
    expect((await lookup('pat-b', { projectSlug: 'alpha' }, b))?.project?.id).toBe(PB);
  });

  it('treats an archived project like an unknown slug', async () => {
    await seed(
      project(a, '01J0PROJECT0000000000000P3', 'gone', { status: 'archived' }),
      pat('pat-a'),
    );

    const result = await lookup('pat-a', { projectSlug: 'gone' });

    expect(result?.project).toBeNull();
    expect(result?.projectPermissions).toEqual([]);
  });

  it('issues exactly one executor.all and no batch', async () => {
    await seed(pat('pat-a'), pat('pat-s', { mode: 'selected' }));
    const counted = countCalls(executor);
    const repository = createAccessRepository(counted.executor);

    await repository.lookupToken(a, input('pat-a'));
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    await repository.lookupToken(a, input('pat-s', { projectSlug: 'beta' }));
    await repository.lookupToken(a, input('missing'));
    await repository.lookupToken(
      a,
      input('pat-a', { boundary: 'organization', projectSlug: null }),
    );
    expect(counted.counts()).toEqual({ all: 4, batch: 0 });
  });

  it('does not write on lookup', async () => {
    await seed(pat('pat-a'));
    const before = await executor.all(stmt('SELECT * FROM token'));

    await lookup('pat-a');

    expect(await executor.all(stmt('SELECT * FROM token'))).toEqual(before);
  });

  it('rejects a malformed selector', async () => {
    const repository = createAccessRepository(executor);

    await expect(repository.lookupToken(a, input('x', { selector: 'short' }))).rejects.toThrow(
      TypeError,
    );
    await expect(
      repository.lookupToken(a, input('x', { boundary: 'nope' as 'project' })),
    ).rejects.toThrow(TypeError);
  });
});

describe('round 2: expiry, local validation, plans, bindings', () => {
  it('treats unparseable and boundary expiry as expired', async () => {
    await seed(
      principal(SP1, 'ci', P1, U3),
      principalPermission(SP1, 'project:read'),
      pat('pat-junk', { expiresAt: 'not-a-date' }),
      svc('svc-junk', SP1, { projectId: P1, expiresAt: 'not-a-date' }),
      pat('pat-soon', { expiresAt: at(5000) }),
      pat('pat-gone', { expiresAt: at(-1000) }),
      svc('svc-soon', SP1, { projectId: P1, expiresAt: at(5000) }),
      svc('svc-gone', SP1, { projectId: P1, expiresAt: at(-1000) }),
    );

    for (const label of ['pat-junk', 'svc-junk', 'pat-gone', 'svc-gone']) {
      const result = await lookup(label);
      expect(result?.token.expired, label).toBe(true);
      expect(result?.projectPermissions, label).toEqual([]);
    }
    for (const label of ['pat-soon', 'svc-soon']) {
      const result = await lookup(label);
      expect(result?.token.expired, label).toBe(false);
      expect(result?.projectPermissions.length, label).toBeGreaterThan(0);
    }
  });

  describe('local validation', () => {
    async function localAdmin(lastLoginAt: string | null, options: { totp?: boolean } = {}) {
      await seed(
        grant(a, 'u2@example.test', ROLE_HOLDER),
        stmt(
          "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDLOCAL0000000000U2', ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
          a.orgId,
        ),
        stmt(
          "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, 'pbkdf2-sha256$test', ?, ?, ?)",
          U2,
          a.orgId,
          options.totp === false ? null : '01J0CREDLOCAL0000000000U2',
          options.totp === false ? null : at(-HOUR),
          lastLoginAt,
        ),
      );
    }
    const local = { userId: U2, validationKind: 'local', validationIdentityId: null } as const;

    it('allows a local PAT with admin eligibility and a login under 24 h', async () => {
      await localAdmin(at(-23 * HOUR));
      await seed(pat('pat-local', local));

      const result = await lookup('pat-local');

      expect(result?.validation).toEqual({
        kind: 'local',
        identityId: null,
        fresh: true,
        evidenceAt: expect.any(String),
      });
      expect(result?.projectPermissions).toEqual(['project:read']);
      expect(result?.protectedHolder).toBe(true);
    });

    it('denies a login over 24 h old, a missing login time and a missing TOTP', async () => {
      await localAdmin(at(-25 * HOUR));
      await seed(pat('pat-local', local));
      expect((await lookup('pat-local'))?.validation?.fresh).toBe(false);
      expect(await projectPermissions('pat-local')).toEqual([]);

      await seed(stmt('UPDATE local_login SET last_login_at = NULL WHERE user_id = ?', U2));
      expect((await lookup('pat-local'))?.validation?.fresh).toBe(false);

      await seed(
        stmt(
          'UPDATE local_login SET last_login_at = ?, totp_credential_id = NULL WHERE user_id = ?',
          at(-HOUR),
          U2,
        ),
      );
      expect((await lookup('pat-local'))?.validation?.fresh).toBe(false);
    });

    it('denies without a protecting organization grant', async () => {
      await localAdmin(at(-HOUR));
      await seed(
        stmt('DELETE FROM access_grant WHERE role_id = ?', ROLE_HOLDER),
        grant(a, 'u2@example.test', ROLE_ORG),
        pat('pat-local', local),
      );

      const result = await lookup('pat-local');

      expect(result?.validation?.fresh).toBe(false);
      expect(result?.projectPermissions).toEqual([]);
    });

    it('does not let a local login freshen an SSO PAT', async () => {
      const staleAt = at(-30 * HOUR);
      await seed(
        stmt(
          'DELETE FROM access_grant WHERE subject_value = ? AND scope = ?',
          'u1@example.test',
          'organization',
        ),
        grant(a, 'u1@example.test', ROLE_HOLDER),
        stmt(
          "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDLOCAL0000000000U1', ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
          a.orgId,
        ),
        stmt(
          "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, 'pbkdf2-sha256$test', '01J0CREDLOCAL0000000000U1', ?, ?)",
          U1,
          a.orgId,
          at(-HOUR),
          at(-HOUR),
        ),
        stmt('UPDATE identity SET validated_at = ? WHERE id = ?', staleAt, IDENTITY_U1),
        pat('pat-sso'),
      );

      const result = await lookup('pat-sso');

      expect(result?.validation).toEqual({
        kind: 'sso',
        identityId: IDENTITY_U1,
        fresh: false,
        evidenceAt: staleAt,
      });
      expect(result?.projectPermissions).toEqual([]);
    });
  });

  for (const phase of ['before ANALYZE', 'after ANALYZE'] as const) {
    it(`searches tokens by index only ${phase}`, async () => {
      const statements: Statement[] = [
        principal(SP1, 'ci', P1, U3),
        principalPermission(SP1, 'project:read'),
        pat('pat-plan'),
        svc('svc-plan', SP1, { projectId: P1 }),
      ];
      for (let index = 0; index < 50; index += 1) {
        statements.push(
          principal(`01J0SERVICEBULK${String(index).padStart(11, '0')}`, `bulk-${index}`, P1, U3),
        );
        statements.push(
          project(a, `01J0PROJECTBULK${String(index).padStart(11, '0')}`, `bulk-${index}`),
        );
      }
      for (let index = 0; index < 600; index += 1) {
        const userId = `01J0USERBULK${String(index).padStart(14, '0')}`;
        statements.push(user(a, userId, `bulk${index}@example.test`));
        statements.push(
          identity(
            a,
            `01J0IDENTBULK${String(index).padStart(13, '0')}`,
            userId,
            `bulk${index}@example.test`,
            at(-HOUR),
          ),
        );
        for (const group of [index % 40, (index + 1) % 40]) {
          statements.push(
            stmt(
              'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
              a.orgId,
              userId,
              'oidc',
              `group-${group}`,
              at(-HOUR),
            ),
          );
        }
        statements.push(grant(a, `bulk${index}@example.test`, ROLE_ORG));
        statements.push(
          grant(
            a,
            `bulk${index}@example.test`,
            ROLE_DEV,
            `01J0PROJECTBULK${String(index % 50).padStart(11, '0')}`,
          ),
        );
      }
      for (let index = 0; index < 3000; index += 1) {
        statements.push(
          stmt(
            "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, project_mode, expires_at) VALUES (?, ?, 'pat', ?, ?, 1, 'bulk', '[\"full\"]', ?, 'all', ?)",
            `tok-bulk-${index}`,
            a.orgId,
            `${ALPHABET[index % 32]}${ALPHABET[Math.floor(index / 32) % 32]}${ALPHABET[Math.floor(index / 1024)]}`.padEnd(
              12,
              'a',
            ),
            'd'.repeat(64),
            `01J0USERBULK${String(index % 600).padStart(14, '0')}`,
            at(HOUR),
          ),
        );
      }
      for (let from = 0; from < statements.length; from += 500) {
        await seed(...statements.slice(from, from + 500));
      }

      {
        if (phase === 'after ANALYZE') await database.analyze();
        for (const label of ['pat-plan', 'svc-plan']) {
          for (const boundary of ['project', 'organization'] as const) {
            const statement = lookupTokenStatement(
              a,
              input(label, { boundary, projectSlug: boundary === 'project' ? 'alpha' : null }),
            );
            const plan = await executor.all<{ detail: string }>({
              sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
              params: statement.params,
            });
            const details = plan.map((row) => row.detail);
            expect(unindexedScans(details), details.join('\n')).toEqual([]);
            expect(details.some((detail) => detail.includes('token_selector'))).toBe(true);
          }
        }
      }
    });
  }

  it('reports the protected-holder bit only for a full all-project PAT', async () => {
    await seed(
      stmt(
        "DELETE FROM access_grant WHERE subject_value = ? AND scope = 'organization'",
        'u1@example.test',
      ),
      grant(a, 'u1@example.test', ROLE_HOLDER),
      pat('pat-hfull'),
      pat('pat-hwrite', { scopes: '["write"]' }),
      pat('pat-hread', { scopes: '["read"]', readOnly: 1 }),
      pat('pat-hsel', { mode: 'selected' }),
      bind('pat-hsel', P1),
    );

    expect((await lookup('pat-hfull'))?.protectedHolder).toBe(true);
    expect((await lookup('pat-hwrite'))?.protectedHolder).toBe(false);
    expect((await lookup('pat-hread'))?.protectedHolder).toBe(false);
    expect((await lookup('pat-hsel'))?.protectedHolder).toBe(false);
  });

  it('refuses an unknown project_mode at the schema', async () => {
    await expect(seed(pat('pat-bogus', { mode: 'bogus' as 'all' }))).rejects.toThrow(/constraint/i);
  });

  it('hides the project when binding columns disagree', async () => {
    await seed(
      principal(SP1, 'ci', P1, U3),
      principalPermission(SP1, 'project:read'),
      svc('svc-skew', SP1, { projectId: P2 }),
      svc('svc-nobind', SP1, { projectId: null }),
      pat('pat-bound', { projectId: P1 }),
    );

    for (const label of ['svc-skew', 'svc-nobind', 'pat-bound']) {
      const result = await lookup(label);
      expect(result?.project, label).toBeNull();
      expect(result?.projectPermissions, label).toEqual([]);
    }
  });

  it('reports a failed binding check on the envelope', async () => {
    await seed(
      principal(SP1, 'ci', P1, U3),
      svc('svc-skew2', SP1, { projectId: P2 }),
      svc('svc-ok', SP1, { projectId: P1 }),
      pat('pat-bound2', { projectId: P1 }),
      pat('pat-free'),
    );

    expect((await lookup('svc-skew2'))?.token.bindingOk).toBe(false);
    expect((await lookup('pat-bound2'))?.token.bindingOk).toBe(false);
    expect((await lookup('svc-ok'))?.token.bindingOk).toBe(true);
    expect((await lookup('pat-free'))?.token.bindingOk).toBe(true);
  });

  it('refuses a PAT without a project mode at the schema and reports a stored one', async () => {
    await expect(seed(pat('pat-nomode', { mode: null }))).rejects.toThrow(/constraint/i);
    await seed(pat('pat-mode', { mode: 'selected' }));

    expect((await lookup('pat-mode'))?.token.projectMode).toBe('selected');
  });

  it('reports a null scope for a read_only flag that disagrees with the scope list', async () => {
    await seed(
      pat('pat-skew', { scopes: '["write"]', readOnly: 1 }),
      pat('pat-garbled', { scopes: '["bogus"]' }),
    );

    expect((await lookup('pat-skew'))?.token.scope).toBeNull();
    expect((await lookup('pat-garbled'))?.token.scope).toBeNull();
  });

  it('derives the project mode and denies a missing or unknown one', () => {
    expect(tokenProjectMode('pat', null, null)).toBeNull();
    expect(tokenProjectMode('pat', 'bogus', null)).toBeNull();
    expect(tokenProjectMode('pat', 'all', null)).toBe('all');
    expect(tokenProjectMode('pat', 'selected', null)).toBe('selected');
    expect(tokenProjectMode('svc', 'selected', null)).toBe('all');
    expect(tokenProjectMode('svc', 'all', P1)).toBe('selected');
  });

  it('denies a validation identity at an unlisted provider or anchor', async () => {
    await seed(pat('pat-anchor'));

    for (const anchors of [
      [],
      [
        {
          provider: 'oidc',
          anchor: 'https://changed.example.test',
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test'],
        },
      ],
      [
        {
          provider: 'other',
          anchor: ANCHOR,
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test'],
        },
      ],
    ]) {
      const result = await lookup('pat-anchor', { providerAnchors: anchors });
      expect(result?.validation?.fresh).toBe(false);
      expect(result?.projectPermissions).toEqual([]);
    }
  });

  it('denies when the validation identity e-mail changed or is unverified', async () => {
    await seed(pat('pat-mail'));
    expect((await lookup('pat-mail'))?.validation?.fresh).toBe(true);

    await seed(stmt('UPDATE identity SET email_verified = 0 WHERE id = ?', IDENTITY_U1));
    expect((await lookup('pat-mail'))?.validation?.fresh).toBe(false);

    await seed(
      stmt(
        'UPDATE identity SET email_verified = 1, email = ? WHERE id = ?',
        'moved@example.test',
        IDENTITY_U1,
      ),
    );
    const result = await lookup('pat-mail');
    expect(result?.validation?.fresh).toBe(false);
    expect(result?.projectPermissions).toEqual([]);
  });

  it('applies the project token_max_scope to a service token', async () => {
    await seed(
      principal(SP1, 'ci', P1, U3),
      principalPermission(SP1, 'project:read'),
      principalPermission(SP1, 'project:packages:write'),
      svc('svc-cap', SP1, { projectId: P1 }),
    );
    expect(await projectPermissions('svc-cap')).toEqual(['project:packages:write', 'project:read']);

    await seed(stmt('UPDATE project SET token_max_scope = ? WHERE id = ?', 'read', P1));

    expect(await projectPermissions('svc-cap')).toEqual(['project:read']);
  });

  it('ignores a token_project row stored for another organization', async () => {
    await seed(pat('pat-foreign', { mode: 'selected' }), bind('pat-foreign', P1, b));

    const result = await lookup('pat-foreign');

    expect(result?.project).toBeNull();
    expect(result?.projectPermissions).toEqual([]);
  });

  it('returns empty arrays on a project boundary without a slug', async () => {
    await seed(pat('pat-noslug'));

    const result = await lookup('pat-noslug', { projectSlug: null });

    expect(result?.project).toBeNull();
    expect(result?.projectPermissions).toEqual([]);
    expect(result?.organizationPermissions).toEqual([]);
  });

  it('denies a PAT whose user belongs to another organization', async () => {
    await seed(pat('pat-alien', { userId: UB }));

    const result = await lookup('pat-alien');

    expect(result?.principalStatus).toBe('');
    expect(result?.projectPermissions).toEqual([]);
  });

  it('reports the protected-holder bit for a PAT only and keeps the verifier hidden', async () => {
    await seed(
      stmt(
        'DELETE FROM access_grant WHERE subject_value = ? AND scope = ?',
        'u1@example.test',
        'organization',
      ),
      grant(a, 'u1@example.test', ROLE_HOLDER),
      principal(SP1, 'ci', P1, U3),
      principalPermission(SP1, 'project:read'),
      pat('pat-holder'),
      svc('svc-holder', SP1, { projectId: P1 }),
    );

    const patResult = await lookup('pat-holder');
    const svcResult = await lookup('svc-holder');

    expect(patResult?.protectedHolder).toBe(true);
    expect(svcResult?.protectedHolder).toBe(false);
    expect(patResult?.verifier).toEqual({ secretHash: 'a'.repeat(64), pepperVersion: 1 });
    expect(Object.keys(patResult ?? {})).not.toContain('verifier');
    expect(JSON.stringify(patResult)).not.toContain('a'.repeat(64));
    expect({ ...svcResult }).not.toHaveProperty('verifier');
  });

  it('rejects selectors outside a-z and 2-7', async () => {
    const repository = createAccessRepository(executor);

    for (const bad of ['ABCDEFGHIJKL', 'abcdefghij01', 'abcdefghij1a', 'abcdefghijk-']) {
      await expect(repository.lookupToken(a, input('x', { selector: bad }))).rejects.toThrow(
        TypeError,
      );
    }
  });
});

describe('bound parameters', () => {
  const D1_MAX_BOUND_PARAMETERS = 100;
  const anchors = (count: number): ProtectedHolderProvider[] =>
    Array.from({ length: count }, (_, index) => ({
      provider: `idp${index}`,
      anchor: `https://idp${index}.example.test/"quoted"/'single'/\\`,
      emailAuthoritative: index % 2 === 0,
      emailAuthoritativeDomains: ['example.test'],
    }));

  for (const boundary of ['project', 'organization'] as const) {
    it(`lookupToken on a ${boundary} boundary stays within the D1 limit with 8 anchors`, () => {
      const lookupInput = (count: number) =>
        input('pat-params', {
          boundary,
          projectSlug: boundary === 'project' ? 'alpha' : null,
          providerAnchors: anchors(count),
        });

      const eight = lookupTokenStatement(a, lookupInput(8)).params.length;

      expect(eight).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(eight).toBe(lookupTokenStatement(a, lookupInput(1)).params.length);
    });
  }
});

describeTokenContract('node:sqlite', () => openMigratedDatabase());

describe('lookupToken projectVisible', () => {
  const U4 = '01J0USER000000000000000004';
  const IDENTITY_U4 = '01J0IDENT000000000000000U4';

  async function seedProjectOnlyUser(): Promise<void> {
    await seed(
      user(a, U4, 'u4@example.test'),
      identity(a, IDENTITY_U4, U4, 'u4@example.test', at(-HOUR)),
      grant(a, 'u4@example.test', ROLE_DEV, P1),
    );
  }

  it('is true for a project the principal sees but the token binding excludes', async () => {
    await seed(pat('pat-sel', { mode: 'selected' }), bind('pat-sel', P1));

    const result = await lookup('pat-sel', { projectSlug: 'beta' });

    expect(result?.project).toBeNull();
    expect(result?.projectPermissions).toEqual([]);
    expect(result?.projectVisible).toBe(true);
  });

  it('is true when the token scope and read-only flag leave the principal grants unused', async () => {
    await seedProjectOnlyUser();
    await seed(
      pat('pat-ro', {
        userId: U4,
        scopes: '["read"]',
        readOnly: 1,
        validationIdentityId: IDENTITY_U4,
      }),
      pat('pat-junk', {
        userId: U4,
        scopes: '["write","read"]',
        validationIdentityId: IDENTITY_U4,
      }),
    );

    const junk = await lookup('pat-junk');
    expect(junk?.projectPermissions).toEqual([]);
    expect(junk?.projectVisible).toBe(true);
    expect((await lookup('pat-ro'))?.projectVisible).toBe(true);
  });

  it('is false for a project of another organization', async () => {
    await seed(project(b, '01J0PROJECT0000000000000PG', 'gamma'), pat('pat-a'));

    const result = await lookup('pat-a', { projectSlug: 'gamma' });

    expect(result?.project).toBeNull();
    expect(result?.projectVisible).toBe(false);
  });

  it('is false for an archived project even with organization-wide project read', async () => {
    await seed(
      project(a, '01J0PROJECT0000000000000P3', 'gone', { status: 'archived' }),
      pat('pat-a'),
    );

    const result = await lookup('pat-a', { projectSlug: 'gone' });

    expect(result?.project).toBeNull();
    expect(result?.projectVisible).toBe(false);
  });

  it('resolves an archived project the principal has grants on only when allowArchived is set', async () => {
    await seed(
      project(a, '01J0PROJECT0000000000000P3', 'gone', { status: 'archived' }),
      pat('pat-a'),
    );

    const hidden = await lookup('pat-a', { projectSlug: 'gone' });
    const shown = await lookup('pat-a', { projectSlug: 'gone', allowArchived: true });

    expect(hidden?.project).toBeNull();
    expect(hidden?.projectVisible).toBe(false);
    expect(shown?.project).toMatchObject({ slug: 'gone', status: 'archived' });
    expect(shown?.projectVisible).toBe(true);
  });

  it('is false for a project the principal reaches only through the token binding', async () => {
    await seedProjectOnlyUser();
    await seed(
      pat('pat-bind', { userId: U4, mode: 'selected', validationIdentityId: IDENTITY_U4 }),
      bind('pat-bind', P2),
    );

    const result = await lookup('pat-bind', { projectSlug: 'beta' });

    expect(result?.project?.id).toBe(P2);
    expect(result?.projectPermissions).toEqual([]);
    expect(result?.projectVisible).toBe(false);
    expect((await lookup('pat-bind', { projectSlug: 'alpha' }))?.projectVisible).toBe(true);
  });

  it('is false for an unknown slug, an organization boundary and a missing slug', async () => {
    await seed(pat('pat-a'));

    expect((await lookup('pat-a', { projectSlug: 'nope' }))?.projectVisible).toBe(false);
    expect(
      (await lookup('pat-a', { boundary: 'organization', projectSlug: null }))?.projectVisible,
    ).toBe(false);
    expect((await lookup('pat-a', { projectSlug: null }))?.projectVisible).toBe(false);
  });

  it('is false for a suspended user, a revoked token and an expired token', async () => {
    await seed(
      pat('pat-rev', { revokedAt: at(-1000) }),
      pat('pat-exp', { expiresAt: at(-1000) }),
      pat('pat-sus', { userId: U3, validationKind: 'local' }),
      grant(a, 'u3@example.test', ROLE_ORG),
    );

    expect((await lookup('pat-rev'))?.projectVisible).toBe(false);
    expect((await lookup('pat-exp'))?.projectVisible).toBe(false);
    expect((await lookup('pat-sus'))?.projectVisible).toBe(false);
  });

  it('follows the service principal binding and its stored project permissions', async () => {
    await seed(
      principal(SP1, 'ci', P1, U3),
      principalPermission(SP1, 'project:read'),
      principal(SPW, 'wide', null, U3),
      principalPermission(SPW, 'project:read'),
      principal('01J0SERVICE00000000000000PO', 'org-only', null, U3),
      principalPermission('01J0SERVICE00000000000000PO', 'org:read'),
      svc('svc-ci', SP1, { projectId: P1 }),
      svc('svc-wide', SPW, { scopes: '["read"]', readOnly: 1 }),
      svc('svc-org', '01J0SERVICE00000000000000PO'),
    );

    expect((await lookup('svc-ci'))?.projectVisible).toBe(true);
    expect((await lookup('svc-ci', { projectSlug: 'beta' }))?.projectVisible).toBe(false);
    expect((await lookup('svc-wide', { projectSlug: 'beta' }))?.projectVisible).toBe(true);
    expect((await lookup('svc-org'))?.projectVisible).toBe(false);

    await seed(stmt('UPDATE service_principal SET status = ? WHERE id = ?', 'suspended', SPW));
    expect((await lookup('svc-wide', { projectSlug: 'beta' }))?.projectVisible).toBe(false);
  });

  it.each(['pat', 'svc'] as const)(
    'answers 403 for an invalid %s binding on a visible project and 404 on an invisible one',
    async (kind) => {
      const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
      const label = `${kind}-invalid`;
      const presented = formatToken(kind, selector(label), new Uint8Array(32).fill(9));
      if (kind === 'pat') await seedProjectOnlyUser();
      await seed(
        principal(SP1, 'ci', P1, U3),
        principalPermission(SP1, 'project:read'),
        kind === 'pat'
          ? pat(label, { projectId: P2, userId: U4, validationIdentityId: IDENTITY_U4 })
          : svc(label, SP1, { projectId: P2 }),
        stmt(
          'UPDATE token SET hash = ? WHERE id = ?',
          await hashToken(keyring, 1, presented),
          `tok-${label}`,
        ),
      );
      const result = await lookup(label);
      expect(result?.principalStatus).toBe('active');
      expect(result?.project).toBeNull();
      expect(result?.projectPermissions).toEqual([]);
      expect(result?.projectVisible).toBe(true);
      const repository = createAccessRepository(executor);
      let dispatched = 0;
      const engine = createAuthorizationEngine({
        access: repository,
        tokenUse: {
          keyring,
          nowMs: Date.now,
          dispatch: () => {
            dispatched += 1;
          },
          log: () => undefined,
        },
        patValidation: patValidationGate,
        publicOrigin: 'https://broker.test',
        providerAnchors: () => Promise.resolve([OIDC]),
      });
      for (const [slug, status] of [
        ['alpha', 403],
        ['beta', 404],
        ['nope', 404],
      ] as const) {
        expect(
          await engine.authorize({
            request: new Request(`https://broker.test/_pb/projects/${slug}`, {
              headers: { authorization: `Bearer ${presented}` },
            }),
            org: a,
            route: {
              plugin: 'core',
              method: 'GET',
              path: '/_pb/projects/:project',
              permission: 'project:read',
              boundary: 'project',
            },
            params: { project: slug },
          }),
        ).toEqual({ allow: false, status });
      }
      expect(dispatched).toBe(0);
    },
  );

  it('keeps the statement within 100 bound parameters with 8 anchors', () => {
    const anchors = Array.from({ length: 8 }, (_, index) => ({
      provider: `idp${index}`,
      anchor: `https://idp${index}.example.test`,
      emailAuthoritative: index % 2 === 0,
      emailAuthoritativeDomains: ['example.test'],
    }));

    const statement = lookupTokenStatement(a, input('pat-params', { providerAnchors: anchors }));

    expect(statement.params.length).toBeLessThanOrEqual(100);
  });
});

describe('lookupToken personal tokens created before the owner stamp', () => {
  const STAMP = '2026-10-20T12:00:00.000Z';

  async function stamp(userId: string, value: string | null = STAMP): Promise<void> {
    await seed(stmt('UPDATE user_account SET pat_invalid_before = ? WHERE id = ?', value, userId));
  }

  async function createdAt(label: string, value: string): Promise<void> {
    await seed(stmt('UPDATE token SET created_at = ? WHERE id = ?', value, `tok-${label}`));
  }

  it('resolves a token when the owner has no stamp', async () => {
    await seed(pat('pat-free'));
    await createdAt('pat-free', '2020-01-01T00:00:00.000Z');

    const result = await lookup('pat-free');

    expect(result?.token.revoked).toBe(false);
    expect(result?.projectPermissions).toContain('project:packages:write');
  });

  it('keeps the envelope but grants nothing to a token created before the stamp', async () => {
    await seed(pat('pat-old'));
    await createdAt('pat-old', '2026-10-20T11:59:59.999Z');
    await stamp(U1);

    const result = await lookup('pat-old');

    expect(result).not.toBeNull();
    expect(result?.token.revoked).toBe(true);
    expect(result?.token.bindingOk).toBe(true);
    expect(result?.projectVisible).toBe(false);
    expect(result?.projectPermissions).toEqual([]);
    expect(result?.organizationPermissions).toEqual([]);
    expect(
      (await lookup('pat-old', { boundary: 'organization' }))?.organizationPermissions,
    ).toEqual([]);
  });

  it('accepts a token created at the stamp instant and one created after it', async () => {
    await seed(pat('pat-at'), pat('pat-new'));
    await createdAt('pat-at', STAMP);
    await createdAt('pat-new', '2026-10-20T12:00:00.001Z');
    await stamp(U1);

    expect((await lookup('pat-at'))?.token.revoked).toBe(false);
    expect(await projectPermissions('pat-at')).toContain('project:packages:write');
    expect((await lookup('pat-new'))?.token.revoked).toBe(false);
    expect(await projectPermissions('pat-new')).toContain('project:packages:write');
  });

  it('does not revive an earlier token when the grants come back after the stamp', async () => {
    await seed(pat('pat-before'));
    await createdAt('pat-before', '2026-10-20T11:00:00.000Z');
    await stamp(U1);
    await seed(stmt('DELETE FROM access_grant WHERE org_id = ?', a.orgId));
    await seed(grant(a, 'u1@example.test', ROLE_ORG), grant(a, 'u1@example.test', ROLE_DEV, P1));
    await seed(pat('pat-after'));
    await createdAt('pat-after', '2026-10-20T13:00:00.000Z');

    expect(await projectPermissions('pat-before')).toEqual([]);
    expect(await projectPermissions('pat-after')).toContain('project:packages:write');
  });

  it('compares instants, not text', async () => {
    await seed(pat('pat-text'));
    await createdAt('pat-text', '2026-10-20T11:59:59Z');
    await stamp(U1, '2026-10-20T12:00:00.000Z');

    expect((await lookup('pat-text'))?.token.revoked).toBe(true);
  });

  it('does not touch the tokens of another user', async () => {
    await seed(user(a, '01J0USER0000000000000000X9', 'x9@example.test'));
    await seed(pat('pat-mine'));
    await createdAt('pat-mine', '2026-10-20T11:00:00.000Z');
    await stamp('01J0USER0000000000000000X9');

    expect((await lookup('pat-mine'))?.token.revoked).toBe(false);
  });

  it('leaves service tokens alone', async () => {
    await seed(principal(SP1, 'svc-one', P1, U1), principalPermission(SP1, 'project:read'));
    await seed(svc('svc-tok', SP1, { projectId: P1 }));
    await seed(
      stmt(
        'UPDATE token SET created_at = ? WHERE id = ?',
        '2020-01-01T00:00:00.000Z',
        'tok-svc-tok',
      ),
    );
    await stamp(U1);

    expect((await lookup('svc-tok'))?.token.revoked).toBe(false);
  });

  it('does not refresh last_used_at of a token created before the stamp', async () => {
    await seed(pat('pat-touch'));
    await createdAt('pat-touch', '2026-10-20T11:00:00.000Z');
    await stamp(U1);

    expect(await createAccessRepository(executor).touchToken(a, 'tok-pat-touch', 'pat')).toBe(
      false,
    );
    await stamp(U1, null);
    expect(await createAccessRepository(executor).touchToken(a, 'tok-pat-touch', 'pat')).toBe(true);
  });

  it('keeps the other bound project working when the grant of one is removed, and restores it on re-grant', async () => {
    await seed(
      grant(a, 'u1@example.test', ROLE_DEV, P2),
      pat('pat-two', { mode: 'selected' }),
      bind('pat-two', P1),
      bind('pat-two', P2),
    );
    await seed(stmt('DELETE FROM access_grant WHERE role_id = ? AND project_id = ?', ROLE_DEV, P1));
    await seed(stmt('DELETE FROM access_grant WHERE role_id = ?', ROLE_ORG));

    expect(await projectPermissions('pat-two', { projectSlug: 'alpha' })).toEqual([]);
    expect(await projectPermissions('pat-two', { projectSlug: 'beta' })).toContain(
      'project:packages:write',
    );
    expect((await lookup('pat-two'))?.token.revoked).toBe(false);

    await seed(grant(a, 'u1@example.test', ROLE_DEV, P1));
    expect(await projectPermissions('pat-two', { projectSlug: 'alpha' })).toContain(
      'project:packages:write',
    );
  });
});
