import { beforeEach, describe, expect, it } from 'vitest';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { DbError } from '@package-broker/core/db/errors';
import type { Organization } from '@package-broker/core/db/organization';
import { fixedClock } from '@package-broker/core/ids';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { verifyToken } from '@package-broker/core/secrets/token-hash';
import type { ActorContext } from '@package-broker/core/authz/administration';
import type { AuthenticatedSession } from '@package-broker/core/auth/session';
import {
  createServiceTokenService,
  type ServiceTokenStore,
} from '@package-broker/core/authz/service-token-service';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createTokenRepository,
  type IssueServiceTokenInput,
  type MintedToken,
  type TokenRepository,
} from './token.js';

const USER = '01J0USER000000000000000001';
const OTHER_USER = '01J0USER000000000000000002';
const SESSION = '01J0SESSION0000000000000001';
const ADMIN_ROLE = '01J0ROLE000000000000000001';
const PROJECT = '01J0PROJECT000000000000001';
const OTHER_PROJECT = '01J0PROJECT000000000000002';
const SP = '01J0SERVICE000000000000001';
const SP_WIDE = '01J0SERVICE000000000000002';
const SP_OTHER_ORG = '01J0SERVICE000000000000003';
const TOKEN = '01J0TOKEN0000000000000000A';
const ANCHORS = [
  {
    provider: 'idp',
    anchor: 'anchor-1',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const DAY = 86_400_000;
const ISSUER_PERMISSIONS = [
  'org:service-principals:write',
  'project:audit:read',
  'project:packages:read',
  'project:packages:write',
  'project:read',
  'project:tokens:create',
];

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let repository: TokenRepository;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fence(userId = USER, sessionId = SESSION): MutationFence {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
}

function minter(...selectors: string[]): { mint: () => MintedToken; calls: () => number } {
  let calls = 0;
  return {
    mint: () => {
      const selector = selectors[Math.min(calls, selectors.length - 1)] as string;
      calls += 1;
      return {
        selector,
        hash: `${calls}`.padStart(64, 'a'),
        pepperVersion: 1,
        plaintext: `pb_svc_${selector}_${`s${calls}`.padEnd(43, 'x')}`,
      };
    },
    calls: () => calls,
  };
}

function input(overrides: Partial<IssueServiceTokenInput> = {}): IssueServiceTokenInput {
  return {
    id: TOKEN,
    name: 'deploy',
    servicePrincipalId: SP,
    projectId: PROJECT,
    principalRevision: 1,
    scope: 'read',
    readOnly: true,
    expiresAt: iso(30 * DAY),
    now: iso(0),
    authority: {
      permission: 'project:tokens:create',
      organizationAdmin: false,
      covers: ['project:packages:read', 'project:read'],
    },
    providerAnchors: ANCHORS,
    ...overrides,
  };
}

const wideInput = (overrides: Partial<IssueServiceTokenInput> = {}) =>
  input({
    servicePrincipalId: SP_WIDE,
    projectId: null,
    scope: 'full',
    readOnly: false,
    expiresAt: iso(7 * DAY),
    authority: {
      permission: 'org:service-principals:write',
      organizationAdmin: true,
      covers: ['project:read'],
    },
    ...overrides,
  });

const writeInput = (overrides: Partial<IssueServiceTokenInput> = {}) =>
  input({
    scope: 'write',
    readOnly: false,
    expiresAt: iso(7 * DAY),
    authority: {
      permission: 'project:tokens:create',
      organizationAdmin: false,
      covers: ['project:packages:read', 'project:packages:write', 'project:read'],
    },
    ...overrides,
  });

async function issue(
  overrides: Partial<IssueServiceTokenInput> = {},
  mint = minter('aaaaaaaaaaaa'),
) {
  return repository.issueService(a, fence(), input(overrides), mint.mint);
}

async function one<R>(sql: string, ...params: Statement['params']): Promise<R | undefined> {
  return (await executor.all<R>({ sql, params }))[0];
}

async function count(table: string): Promise<number> {
  return (await one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n ?? -1;
}

async function seed(...statements: Statement[]): Promise<void> {
  await executor.batch(statements);
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  a = database.orgs.a;
  b = database.orgs.b;
  executor = database.executor;
  repository = createTokenRepository(executor);
  await seed(
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      USER,
      a.orgId,
      'user@example.test',
      'active',
    ),
    stmt(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      OTHER_USER,
      a.orgId,
      'other@example.test',
      'active',
    ),
    stmt(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 1)',
      ADMIN_ROLE,
      a.orgId,
      'organization_admin',
      'Admin',
      'organization',
    ),
    ...ISSUER_PERMISSIONS.map((permission) =>
      stmt(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        a.orgId,
        ADMIN_ROLE,
        permission,
      ),
    ),
    stmt(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'idp', 'anchor-1')",
      a.orgId,
    ),
    stmt(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDENTIAL000000000001', ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
      a.orgId,
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, 'email', ?, NULL, 'organization', NULL, ?)",
      '01J0GRANT000000000000000001',
      a.orgId,
      'user@example.test',
      ADMIN_ROLE,
    ),
    stmt(
      "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, 'pbkdf2-sha256$i=1$v=1$c2FsdA$aGFzaA', '01J0CREDENTIAL000000000001', ?, ?)",
      USER,
      a.orgId,
      iso(-3_600_000),
      iso(-3_600_000),
    ),
    stmt(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      SESSION,
      a.orgId,
      USER,
      'a'.repeat(64),
      'b'.repeat(64),
      iso(3_600_000),
      iso(-60_000),
    ),
    stmt(
      "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'alpha', 'Alpha'), (?, ?, 'beta', 'Beta')",
      PROJECT,
      a.orgId,
      OTHER_PROJECT,
      a.orgId,
    ),
    stmt(
      "INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id) VALUES (?, ?, 'ci', ?, ?), (?, ?, 'wide', NULL, ?)",
      SP,
      a.orgId,
      PROJECT,
      USER,
      SP_WIDE,
      a.orgId,
      USER,
    ),
    stmt(
      "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, 'project:packages:read'), (?, ?, 'project:packages:write'), (?, ?, 'project:read'), (?, ?, 'project:read')",
      a.orgId,
      SP,
      a.orgId,
      SP,
      a.orgId,
      SP,
      a.orgId,
      SP_WIDE,
    ),
  );
});

describe('issueService', () => {
  it('stores one svc row bound to the principal and its project, with no token_project rows', async () => {
    const result = await issue();
    expect(result).toEqual({
      status: 'issued',
      id: TOKEN,
      plaintext: `pb_svc_aaaaaaaaaaaa_${'s1'.padEnd(43, 'x')}`,
    });
    const row = await one<Record<string, unknown>>('SELECT * FROM token WHERE id = ?', TOKEN);
    expect(row).toMatchObject({
      org_id: a.orgId,
      kind: 'svc',
      selector: 'aaaaaaaaaaaa',
      hash: '1'.padStart(64, 'a'),
      pepper_version: 1,
      scopes_json: '["read"]',
      read_only: 1,
      user_id: null,
      service_principal_id: SP,
      customer_id: null,
      project_id: PROJECT,
      created_by_user_id: USER,
      project_mode: 'selected',
      validation_kind: null,
      validation_identity_id: null,
      revoked_at: null,
    });
    expect(row?.['last_op_id']).toMatch(/^[0-9A-Z]{26}$/);
    expect(await count('token_project')).toBe(0);
  });

  it('issues a write token within the stored and live sets', async () => {
    const result = await repository.issueService(
      a,
      fence(),
      writeInput(),
      minter('aaaaaaaaaaaa').mint,
    );
    expect(result.status).toBe('issued');
    expect((await one<{ s: string }>('SELECT scopes_json AS s FROM token'))?.s).toBe('["write"]');
  });

  it('binds an organization-wide principal with no project', async () => {
    const result = await issue({
      servicePrincipalId: SP_WIDE,
      projectId: null,
      scope: 'full',
      readOnly: false,
      expiresAt: iso(7 * DAY),
      authority: {
        permission: 'org:service-principals:write',
        organizationAdmin: true,
        covers: ['project:read'],
      },
    });
    expect(result.status).toBe('issued');
    const row = await one<Record<string, unknown>>('SELECT * FROM token WHERE id = ?', TOKEN);
    expect(row).toMatchObject({
      service_principal_id: SP_WIDE,
      project_id: null,
      project_mode: 'all',
    });
    expect(await count('token_project')).toBe(0);
  });

  describe('refuses as authority and stores nothing', () => {
    const cases: [string, () => Promise<unknown>, () => Partial<IssueServiceTokenInput>][] = [
      [
        'a covered permission the principal does not store',
        async () => undefined,
        () => ({
          scope: 'full',
          readOnly: false,
          expiresAt: iso(7 * DAY),
          authority: {
            permission: 'project:tokens:create',
            organizationAdmin: false,
            covers: ['project:audit:read', 'project:read'],
          },
        }),
      ],
      [
        'a covered permission the issuer no longer holds',
        () =>
          seed(
            stmt(
              "DELETE FROM role_permission WHERE role_id = ? AND permission = 'project:packages:read'",
              ADMIN_ROLE,
            ),
          ),
        () => ({}),
      ],
      [
        'an issuer without project:tokens:create',
        () =>
          seed(
            stmt(
              "DELETE FROM role_permission WHERE role_id = ? AND permission = 'project:tokens:create'",
              ADMIN_ROLE,
            ),
          ),
        () => ({}),
      ],
      [
        'a suspended principal',
        () => seed(stmt("UPDATE service_principal SET status = 'suspended' WHERE id = ?", SP)),
        () => ({}),
      ],
      [
        'a principal bound to another project',
        async () => undefined,
        () => ({ projectId: OTHER_PROJECT }),
      ],
      [
        'an organization-wide principal claimed for a project',
        async () => undefined,
        () => ({ servicePrincipalId: SP_WIDE }),
      ],
      [
        'an archived project',
        () => seed(stmt("UPDATE project SET status = 'archived' WHERE id = ?", PROJECT)),
        () => ({}),
      ],
      [
        'a stale reauth',
        () =>
          seed(stmt('UPDATE session SET reauth_at = ? WHERE id = ?', iso(-11 * 60_000), SESSION)),
        () => ({}),
      ],
      [
        'a revoked session',
        () => seed(stmt('UPDATE session SET revoked_at = ? WHERE id = ?', iso(-1000), SESSION)),
        () => ({}),
      ],
      [
        'a suspended issuer',
        () => seed(stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", USER)),
        () => ({}),
      ],
      [
        'a read token past min(CI setting, 365) days',
        () =>
          seed(
            stmt(
              'UPDATE organization SET token_ci_readonly_expiry_days = 400 WHERE id = ?',
              a.orgId,
            ),
          ),
        () => ({ expiresAt: iso(365 * DAY + 60_000) }),
      ],
      [
        'a read token past a lower CI setting',
        () =>
          seed(
            stmt(
              'UPDATE organization SET token_ci_readonly_expiry_days = 30 WHERE id = ?',
              a.orgId,
            ),
          ),
        () => ({ expiresAt: iso(30 * DAY + 60_000) }),
      ],
    ];

    it.each(cases)('%s', async (_name, arrange, overrides) => {
      await arrange();
      expect(await issue(overrides())).toEqual({ status: 'refused', reason: 'authority' });
      expect(await count('token')).toBe(0);
    });

    it('a write token past 90 days even with a longer default setting', async () => {
      await seed(
        stmt('UPDATE organization SET token_default_expiry_days = 365 WHERE id = ?', a.orgId),
      );
      const result = await repository.issueService(
        a,
        fence(),
        writeInput({ expiresAt: iso(90 * DAY + 60_000) }),
        minter('aaaaaaaaaaaa').mint,
      );
      expect(result).toEqual({ status: 'refused', reason: 'authority' });
      expect(await count('token')).toBe(0);
    });

    it('a write level above the project token_max_scope', async () => {
      await seed(stmt("UPDATE project SET token_max_scope = 'read' WHERE id = ?", PROJECT));
      const result = await repository.issueService(
        a,
        fence(),
        writeInput(),
        minter('aaaaaaaaaaaa').mint,
      );
      expect(result).toEqual({ status: 'refused', reason: 'authority' });
      expect(await count('token')).toBe(0);
    });

    it('an organization-wide principal for an issuer who is not an organization admin', async () => {
      await seed(stmt('UPDATE role SET protects_last_holder = 0 WHERE id = ?', ADMIN_ROLE));
      const result = await issue({
        servicePrincipalId: SP_WIDE,
        projectId: null,
        scope: 'full',
        readOnly: false,
        expiresAt: iso(7 * DAY),
        authority: {
          permission: 'org:service-principals:write',
          organizationAdmin: true,
          covers: ['project:read'],
        },
      });
      expect(result).toEqual({ status: 'refused', reason: 'authority' });
    });

    it('an organization-wide principal of another organization, otherwise identical', async () => {
      await seed(
        stmt(
          "INSERT INTO user_account (id, org_id, email, status) VALUES ('01J0USER000000000000000009', ?, 'b@example.test', 'active')",
          b.orgId,
        ),
        stmt(
          "INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id) VALUES (?, ?, 'wide', NULL, '01J0USER000000000000000009')",
          SP_OTHER_ORG,
          b.orgId,
        ),
        stmt(
          "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, 'project:read')",
          b.orgId,
          SP_OTHER_ORG,
        ),
      );
      expect(
        await repository.issueService(
          a,
          fence(),
          wideInput({ servicePrincipalId: SP_OTHER_ORG }),
          minter('aaaaaaaaaaaa').mint,
        ),
      ).toEqual({ status: 'refused', reason: 'authority' });
      expect(await count('token')).toBe(0);
      expect(
        (await repository.issueService(a, fence(), wideInput(), minter('aaaaaaaaaaaa').mint))
          .status,
      ).toBe('issued');
    });

    it('covers that omit a stored permission the scope confers', async () => {
      expect(
        await issue({
          authority: {
            permission: 'project:tokens:create',
            organizationAdmin: false,
            covers: ['project:read'],
          },
        }),
      ).toEqual({ status: 'refused', reason: 'authority' });
      expect(
        await repository.issueService(
          a,
          fence(),
          writeInput({
            authority: {
              permission: 'project:tokens:create',
              organizationAdmin: false,
              covers: ['project:packages:write', 'project:read'],
            },
          }),
          minter('aaaaaaaaaaaa').mint,
        ),
      ).toEqual({ status: 'refused', reason: 'authority' });
      expect(await count('token')).toBe(0);
    });

    it.each([
      [
        'an expired session',
        () => seed(stmt('UPDATE session SET expires_at = ? WHERE id = ?', iso(-1000), SESSION)),
      ],
      [
        'an idle session',
        () =>
          seed(
            stmt(
              'UPDATE session SET created_at = ?, last_seen_at = ? WHERE id = ?',
              iso(-2 * 3_600_000),
              iso(-2 * 3_600_000),
              SESSION,
            ),
          ),
      ],
    ])('%s', async (_name, arrange) => {
      await arrange();
      expect(await issue()).toEqual({ status: 'refused', reason: 'authority' });
      expect(await count('token')).toBe(0);
    });

    it("another user's fence on the session", async () => {
      const result = await repository.issueService(
        a,
        fence(OTHER_USER),
        input(),
        minter('aaaaaaaaaaaa').mint,
      );
      expect(result).toEqual({ status: 'refused', reason: 'authority' });
      expect(await count('token')).toBe(0);
    });
  });

  describe('expiry at one-second precision on database time', () => {
    beforeEach(() =>
      seed(
        stmt(
          'UPDATE organization SET token_ci_readonly_expiry_days = 400, token_default_expiry_days = 365 WHERE id = ?',
          a.orgId,
        ),
      ),
    );

    it('a read token one second inside 365 days is issued, one second past is refused', async () => {
      expect(await issue({ expiresAt: iso(365 * DAY + 1000) })).toEqual({
        status: 'refused',
        reason: 'authority',
      });
      expect((await issue({ expiresAt: iso(365 * DAY - 1000) })).status).toBe('issued');
    });

    it('a write token one second inside 90 days is issued, one second past is refused', async () => {
      const at = (offset: number) =>
        repository.issueService(
          a,
          fence(),
          writeInput({ expiresAt: iso(90 * DAY + offset) }),
          minter('aaaaaaaaaaaa').mint,
        );
      expect(await at(1000)).toEqual({ status: 'refused', reason: 'authority' });
      expect((await at(-1000)).status).toBe('issued');
    });

    it('refuses an expiry past the ceiling by less than one second within the same second', async () => {
      const lead = Date.now() % 1000;
      if (lead > 200) await new Promise((resolve) => setTimeout(resolve, 1010 - lead));
      const second = Math.floor(Date.now() / 1000) * 1000;
      const expiresAt = new Date(second + 365 * DAY + 700).toISOString();
      expect(await issue({ expiresAt })).toEqual({ status: 'refused', reason: 'authority' });
    });

    it('an expiry one second ahead is issued', async () => {
      expect((await issue({ expiresAt: iso(1000) })).status).toBe('issued');
    });
  });

  describe('failure classification', () => {
    it('returns unclassified for a batch failure no probe explains', async () => {
      const failing: SqlExecutor = {
        all: (statement) => executor.all(statement),
        batch: async (statements) => {
          if (statements.length > 1) throw new DbError('unique', 'UNIQUE constraint failed: x');
          return executor.batch(statements);
        },
      } as SqlExecutor;
      const result = await createTokenRepository(failing).issueService(
        a,
        fence(),
        input(),
        minter('aaaaaaaaaaaa').mint,
      );
      expect(result).toEqual({ status: 'refused', reason: 'unclassified' });
    });

    it('probes the head guard without writing', async () => {
      await seed(
        stmt(
          "DELETE FROM role_permission WHERE role_id = ? AND permission = 'project:tokens:create'",
          ADMIN_ROLE,
        ),
      );
      expect(await issue()).toEqual({ status: 'refused', reason: 'authority' });
      expect(await count('access_mutation_guard')).toBe(0);
    });
  });

  it('accepts a read token at the 365-day CI limit and a write token at 90 days', async () => {
    await seed(
      stmt(
        'UPDATE organization SET token_ci_readonly_expiry_days = 400, token_default_expiry_days = 365 WHERE id = ?',
        a.orgId,
      ),
    );
    expect((await issue({ expiresAt: iso(365 * DAY - 60_000) })).status).toBe('issued');
    const write = await repository.issueService(
      a,
      fence(),
      writeInput({ id: '01J0TOKEN0000000000000000B', expiresAt: iso(90 * DAY - 60_000) }),
      minter('bbbbbbbbbbbb').mint,
    );
    expect(write.status).toBe('issued');
  });

  it('refuses as conflict when the principal revision moved', async () => {
    await seed(stmt('UPDATE service_principal SET revision = 2 WHERE id = ?', SP));
    expect(await issue()).toEqual({ status: 'refused', reason: 'conflict' });
    expect(await count('token')).toBe(0);
  });

  it('retries a selector collision with a fresh pair and gives up after three', async () => {
    await issue();
    const retry = minter('aaaaaaaaaaaa', 'cccccccccccc');
    const second = await issue({ id: '01J0TOKEN0000000000000000B' }, retry);
    expect(second.status).toBe('issued');
    expect(retry.calls()).toBe(2);
    const stuck = minter('aaaaaaaaaaaa');
    expect(await issue({ id: '01J0TOKEN0000000000000000C' }, stuck)).toEqual({
      status: 'refused',
      reason: 'selector_collision',
    });
    expect(stuck.calls()).toBe(3);
  });

  it('refuses a reused token id as id_conflict', async () => {
    await issue();
    expect(await issue({}, minter('dddddddddddd'))).toEqual({
      status: 'refused',
      reason: 'id_conflict',
    });
  });

  it.each([
    ['a readOnly flag that contradicts the scope', { readOnly: false }],
    [
      'no covered permission',
      { authority: { permission: 'project:tokens:create', organizationAdmin: false, covers: [] } },
    ],
    ['an expiry not after now', { expiresAt: iso(-1000) }],
    ['a zero principal revision', { principalRevision: 0 }],
    ['an empty principal id', { servicePrincipalId: '' }],
  ] as [string, Partial<IssueServiceTokenInput>][])(
    'throws before SQL for %s',
    async (_name, overrides) => {
      await expect(issue(overrides)).rejects.toThrow(TypeError);
      expect(await count('token')).toBe(0);
    },
  );

  it('throws for a minted pair that is not an svc token', async () => {
    const pat = () => ({
      selector: 'aaaaaaaaaaaa',
      hash: 'a'.repeat(64),
      pepperVersion: 1,
      plaintext: `pb_pat_aaaaaaaaaaaa_${'x'.repeat(43)}`,
    });
    await expect(repository.issueService(a, fence(), input(), pat)).rejects.toThrow(TypeError);
    expect(await count('token')).toBe(0);
  });
});

describe('core service over the real repository', () => {
  const keyring = createKeyring([
    { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
  ]);

  function organization(): Organization {
    return {
      id: a.orgId,
      slug: 'a',
      name: 'A',
      settings: {
        retentionRemovedUpstreamDays: 30,
        tokenDefaultExpiryDays: 90,
        tokenCiReadonlyExpiryDays: 365,
      },
      createdAt: iso(0),
      updatedAt: iso(0),
    };
  }

  function authenticated(): AuthenticatedSession {
    return {
      session: { id: SESSION, userId: USER, identityId: null, reauthAt: iso(-60_000) },
      principal: { kind: 'user', id: USER },
    } as unknown as AuthenticatedSession;
  }

  const actor: ActorContext = {
    kind: 'organization',
    userId: USER,
    permissions: new Set<string>(),
    isOrganizationAdmin: true,
  };

  function service(tokens: ServiceTokenStore) {
    return createServiceTokenService({
      tokens,
      principals: {
        async get(_ctx, id) {
          const row = await one<{
            id: string;
            name: string;
            project_id: string | null;
            created_by_user_id: string;
            status: 'active' | 'suspended';
            revision: number;
          }>('SELECT * FROM service_principal WHERE id = ? AND org_id = ?', id, a.orgId);
          if (row === undefined) return null;
          const permissions = await executor.all<{ permission: string }>({
            sql: 'SELECT permission FROM service_principal_permission WHERE service_principal_id = ? ORDER BY permission',
            params: [id],
          });
          return {
            id: row.id,
            name: row.name,
            projectId: row.project_id,
            createdByUserId: row.created_by_user_id,
            status: row.status,
            revision: row.revision,
            permissions: permissions.map(({ permission }) => permission),
          };
        },
      },
      authority: { livePermissions: async () => new Set(ISSUER_PERMISSIONS) },
      sessions: { isReauthFresh: () => true },
      organizations: { get: async () => organization() },
      providers: { anchors: async () => ANCHORS },
      keyring,
      clock: fixedClock(iso(0)),
      ids: { ulid: () => TOKEN },
      log: () => undefined,
    });
  }

  const request = {
    servicePrincipalId: SP,
    name: 'deploy',
    scope: 'write' as const,
    expiresAt: iso(7 * DAY),
  };

  it('issues a verifiable svc token end to end', async () => {
    const result = await service(repository).issue(a, authenticated(), actor, fence(), request);
    if (!result.ok) throw new Error(result.error);
    const row = await one<{ hash: string; pepper_version: number; service_principal_id: string }>(
      'SELECT hash, pepper_version, service_principal_id FROM token WHERE id = ?',
      TOKEN,
    );
    expect(row?.service_principal_id).toBe(SP);
    expect(await verifyToken(keyring, 1, result.value.plaintext, row?.hash ?? '')).toBe(true);
  });

  it('refuses when the principal permission set shrinks between prepare and batch', async () => {
    const barrier: ServiceTokenStore = {
      async issueService(ctx, held, storeInput, mint) {
        await seed(
          stmt(
            "DELETE FROM service_principal_permission WHERE service_principal_id = ? AND permission = 'project:packages:write'",
            SP,
          ),
        );
        return repository.issueService(ctx, held, storeInput, mint);
      },
    };
    const result = await service(barrier).issue(a, authenticated(), actor, fence(), request);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(await count('token')).toBe(0);
  });

  it('refuses as conflict when the principal revision moves between prepare and batch', async () => {
    const barrier: ServiceTokenStore = {
      async issueService(ctx, held, storeInput, mint) {
        await seed(stmt('UPDATE service_principal SET revision = revision + 1 WHERE id = ?', SP));
        return repository.issueService(ctx, held, storeInput, mint);
      },
    };
    const result = await service(barrier).issue(a, authenticated(), actor, fence(), request);
    expect(result).toEqual({ ok: false, error: 'conflict' });
    expect(await count('token')).toBe(0);
  });

  it('refuses when the session is revoked between hash and issuance', async () => {
    const barrier: ServiceTokenStore = {
      issueService: (ctx, held, storeInput, mint) =>
        repository.issueService(ctx, held, storeInput, async () => {
          const pair = await mint();
          await seed(stmt('UPDATE session SET revoked_at = ? WHERE id = ?', iso(-1000), SESSION));
          return pair;
        }),
    };
    const result = await service(barrier).issue(a, authenticated(), actor, fence(), request);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(await count('token')).toBe(0);
  });
});
