import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAccessRepository, type ProtectedHolderProvider } from './access.js';

const ANCHOR = 'https://idp.example.test';
const OIDC: ProtectedHolderProvider = {
  provider: 'oidc',
  anchor: ANCHOR,
  emailAuthoritative: true,
  emailAuthoritativeDomains: ['example.test'],
};
const OTHER: ProtectedHolderProvider = {
  provider: 'github',
  anchor: 'https://github.example.test',
  emailAuthoritative: true,
  emailAuthoritativeDomains: ['example.test'],
};

const ROLE = '01J0ROLEORG0000000000000AA';
const USER = '01J0USER000000000000000001';
const PROJECT = '01J0PROJECT0000000000000P1';
const IDENTITY_A = '01J0IDENT000000000000000A1';
const IDENTITY_B = '01J0IDENT000000000000000B1';
const SELECTOR = 'abcdefghijkl';
const DAY = 86_400;
const SKEW = 60;

let database: MigratedDatabase;
let org: OrgContext;
let executor: SqlExecutor;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

async function seed(...statements: Statement[]): Promise<void> {
  await executor.batch(statements);
}

const STAMP = (offset: number) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${offset >= 0 ? '+' : '-'}${Math.abs(offset)} seconds')`;

function identity(id: string, provider: string, validatedOffset: number): Statement {
  return stmt(
    `INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, 'u1@example.test', 1, ${STAMP(validatedOffset)})`,
    id,
    org.orgId,
    USER,
    provider,
    `subject-${id}`,
  );
}

function pat(identityId: string | null): Statement {
  return stmt(
    `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, user_id, project_mode, validation_kind, validation_identity_id, expires_at) VALUES ('tok1', ?, 'pat', ?, ?, 1, 'pat', '["full"]', 0, ?, 'all', 'sso', ?, ${STAMP(3600)})`,
    org.orgId,
    SELECTOR,
    'a'.repeat(64),
    USER,
    identityId,
  );
}

async function lookup(anchors: readonly ProtectedHolderProvider[] = [OIDC, OTHER]) {
  return createAccessRepository(executor).lookupToken(org, {
    selector: SELECTOR,
    boundary: 'project',
    projectSlug: 'alpha',
    providerAnchors: anchors,
  });
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
  executor = database.executor;
  await seed(
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'r', 'r', 'organization', 0)",
      ROLE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'project:read')",
      org.orgId,
      ROLE,
    ),
    stmt(
      "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'u1@example.test', 'active')",
      USER,
      org.orgId,
    ),
    stmt(
      "INSERT INTO project (id, org_id, slug, name, status, token_max_scope) VALUES (?, ?, 'alpha', 'alpha', 'active', 'full')",
      PROJECT,
      org.orgId,
    ),
    stmt(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', ?)",
      org.orgId,
      ANCHOR,
    ),
    stmt(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'github', 'https://github.example.test')",
      org.orgId,
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES ('01J0GRANT000000000000000A1', ?, 'email', 'u1@example.test', NULL, 'organization', NULL, ?)",
      org.orgId,
      ROLE,
    ),
  );
});

afterEach(async () => {
  await database.close();
});

const MARGIN = 5;

async function setIdentityAge(offsetSeconds: number): Promise<void> {
  await seed(
    stmt(`UPDATE identity SET validated_at = ${STAMP(offsetSeconds)} WHERE id = ?`, IDENTITY_A),
  );
}

describe('PAT sso freshness against database time', () => {
  it('is fresh just inside the 24 h window and stale just outside', async () => {
    await seed(identity(IDENTITY_A, 'oidc', -(DAY - MARGIN)), pat(IDENTITY_A));
    expect((await lookup())?.validation?.fresh).toBe(true);

    await setIdentityAge(-(DAY + MARGIN));
    expect((await lookup())?.validation?.fresh).toBe(false);
  });

  it('bounds future evidence at one minute of skew', async () => {
    await seed(identity(IDENTITY_A, 'oidc', SKEW - MARGIN), pat(IDENTITY_A));
    expect((await lookup())?.validation?.fresh).toBe(true);

    await setIdentityAge(SKEW + MARGIN);
    expect((await lookup())?.validation?.fresh).toBe(false);
  });

  it('is refreshed by a new login of the same identity', async () => {
    await seed(identity(IDENTITY_A, 'oidc', -(DAY + MARGIN)), pat(IDENTITY_A));
    expect((await lookup())?.validation?.fresh).toBe(false);

    await setIdentityAge(0);
    expect((await lookup())?.validation?.fresh).toBe(true);
  });

  it('is not refreshed by a login through another provider', async () => {
    await seed(
      identity(IDENTITY_A, 'oidc', -(DAY + MARGIN)),
      identity(IDENTITY_B, 'github', 0),
      pat(IDENTITY_A),
    );

    const result = await lookup();

    expect(result?.validation?.identityId).toBe(IDENTITY_A);
    expect(result?.validation?.fresh).toBe(false);
    expect(result?.projectPermissions).toEqual([]);
  });

  it('follows its own identity when another identity of the user is stale', async () => {
    await seed(
      identity(IDENTITY_A, 'oidc', -(DAY + MARGIN)),
      identity(IDENTITY_B, 'github', 0),
      pat(IDENTITY_B),
    );

    const result = await lookup();

    expect(result?.validation?.identityId).toBe(IDENTITY_B);
    expect(result?.validation?.fresh).toBe(true);
  });

  it('reports the stored identity timestamp unchanged, fresh or stale', async () => {
    await seed(identity(IDENTITY_A, 'oidc', -(DAY + MARGIN)), pat(IDENTITY_A));
    const stored = await executor.all<{ validated_at: string }>(
      stmt('SELECT validated_at FROM identity WHERE id = ?', IDENTITY_A),
    );

    const result = await lookup();

    expect(result?.validation?.evidenceAt).toBe(stored[0]?.validated_at);
    expect(result?.validation?.evidenceAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('reports a null evidence timestamp for an orphaned sso PAT', async () => {
    await seed(identity(IDENTITY_A, 'oidc', 0), pat(null));

    const result = await lookup();

    expect(result?.validation).toEqual({
      kind: 'sso',
      identityId: null,
      fresh: false,
      evidenceAt: null,
    });
  });
});

describe('PAT local freshness against database time', () => {
  const LOCAL_USER = '01J0USER000000000000000002';
  const HOLDER_ROLE = '01J0ROLEHOLDER000000000AA';

  async function localAdmin(loginOffset: number | null): Promise<void> {
    await seed(
      stmt(
        "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'u2@example.test', 'active')",
        LOCAL_USER,
        org.orgId,
      ),
      stmt(
        "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'holder', 'holder', 'organization', 1)",
        HOLDER_ROLE,
        org.orgId,
      ),
      stmt(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'project:read')",
        org.orgId,
        HOLDER_ROLE,
      ),
      stmt(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES ('01J0GRANT000000000000000A2', ?, 'email', 'u2@example.test', NULL, 'organization', NULL, ?)",
        org.orgId,
        HOLDER_ROLE,
      ),
      stmt(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDLOCAL0000000000U2', ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
        org.orgId,
      ),
      stmt(
        `INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, 'pbkdf2-sha256$test', '01J0CREDLOCAL0000000000U2', ${STAMP(-3600)}, ${loginOffset === null ? 'NULL' : STAMP(loginOffset)})`,
        LOCAL_USER,
        org.orgId,
      ),
      stmt(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, user_id, project_mode, validation_kind, validation_identity_id, expires_at) VALUES ('tok1', ?, 'pat', ?, ?, 1, 'pat', '["full"]', 0, ?, 'all', 'local', NULL, ${STAMP(3600)})`,
        org.orgId,
        SELECTOR,
        'a'.repeat(64),
        LOCAL_USER,
      ),
    );
  }

  async function setLoginAge(offsetSeconds: number): Promise<void> {
    await seed(
      stmt(
        `UPDATE local_login SET last_login_at = ${STAMP(offsetSeconds)} WHERE user_id = ?`,
        LOCAL_USER,
      ),
    );
  }

  it('is fresh just inside the 24 h window and stale just outside', async () => {
    await localAdmin(-(DAY - MARGIN));
    expect((await lookup())?.validation?.fresh).toBe(true);

    await setLoginAge(-(DAY + MARGIN));
    expect((await lookup())?.validation?.fresh).toBe(false);
  });

  it('bounds a future login time at one minute of skew', async () => {
    await localAdmin(SKEW - MARGIN);
    expect((await lookup())?.validation?.fresh).toBe(true);

    await setLoginAge(SKEW + MARGIN);
    expect((await lookup())?.validation?.fresh).toBe(false);
  });

  it('is stale without a login time and reports null evidence', async () => {
    await localAdmin(null);

    expect((await lookup())?.validation).toEqual({
      kind: 'local',
      identityId: null,
      fresh: false,
      evidenceAt: null,
    });
  });

  it('is refreshed by a new local login', async () => {
    await localAdmin(-(DAY + MARGIN));
    expect((await lookup())?.validation?.fresh).toBe(false);

    await setLoginAge(0);
    expect((await lookup())?.validation?.fresh).toBe(true);
  });

  it('reports last_login_at exactly as stored', async () => {
    await localAdmin(-(DAY + MARGIN));
    const stored = await executor.all<{ last_login_at: string }>(
      stmt('SELECT last_login_at FROM local_login WHERE user_id = ?', LOCAL_USER),
    );

    expect((await lookup())?.validation?.evidenceAt).toBe(stored[0]?.last_login_at);
  });

  it('is not refreshed by a fresh sso identity of the same user', async () => {
    await localAdmin(-(DAY + MARGIN));
    await seed(
      stmt(
        `INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, 'oidc', 'subject-l', 'u2@example.test', 1, ${STAMP(0)})`,
        IDENTITY_A,
        org.orgId,
        LOCAL_USER,
      ),
    );

    expect((await lookup())?.validation?.fresh).toBe(false);
  });
});
