import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { OrgContext, ScalarStatement, Statement } from '@package-broker/core/db/port';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import {
  assertGuard,
  compile,
  db,
  existsGuard,
  protectedHolder,
  type Guard,
  type ProtectedHolderInput,
  type ProtectedHolderProvider,
} from '@package-broker/db-sqlite/kysely';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import {
  createAccessRepository,
  holdsPermission,
  lookupSessionStatement,
  type SessionLookupInput,
} from '@package-broker/db-sqlite/repositories/access';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['DB'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function loadSources(): Promise<MigrationSource[]> {
  return Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
}

const HOUR = 3600_000;
const ROLE_ADMIN = '01J0ROLEADMIN00000000000AA';
const ROLE_OWNER = '01J0ROLEOWNER00000000000AA';
const U1 = '01J0USER000000000000000001';
const P1 = '01J0PROJECT0000000000000P1';
const EMAIL_IDENTITY = '01J0IDENT00000000000000001';
const GROUP_IDENTITY = '01J0IDENT00000000000000002';
const SESSION = '01J0SESSION000000000000001';
const SECRET = 'ab'.repeat(32);
const U2 = '01J0USER000000000000000002';
const U3 = '01J0USER000000000000000003';
const ADMIN_GRANT_U1 = '01J0GRANT00000000000000001';
const ADMIN_GRANT_U2 = '01J0GRANT00000000000000003';
const ADMIN_GRANT_GROUP = '01J0GRANT00000000000000004';
const U1_IDENTITY_UNUSED = '01J0IDENT00000000000000009';
const U3_IDENTITY = '01J0IDENT00000000000000003';
const TOTP = '01J0CRED000000000000000001';

const ANCHORS: readonly ProtectedHolderProvider[] = Array.from({ length: 8 }, (_, index) => ({
  provider: `idp${index}`,
  anchor: `https://idp${index}.example.test/"quoted"/'single'/\\`,
  emailAuthoritative: index % 2 === 0,
}));

function st(sql: string, ...params: ScalarStatement['params']): ScalarStatement {
  return { sql, params };
}

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

let executor: ReturnType<typeof createD1Executor>;
let a: OrgContext;

beforeAll(async () => {
  executor = createD1Executor((await mf.getD1Database('DB')) as unknown as D1DatabaseLike);
  await migrate(executor, await loadSources(), { holder: 'access-params' });
  ({ a } = await seedTwoOrganizations(executor));
  const identity = (id: string, provider: string) =>
    st(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      id,
      a.orgId,
      U1,
      provider,
      `subject-${id}`,
      'u1@example.test',
      at(-HOUR),
    );
  await executor.batch([
    ...ANCHORS.map((entry) =>
      st(
        'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        a.orgId,
        entry.provider,
        entry.anchor,
      ),
    ),
    st(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'admin', 'admin', 'organization', 1)",
      ROLE_ADMIN,
      a.orgId,
    ),
    st(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'owner', 'owner', 'project', 0)",
      ROLE_OWNER,
      a.orgId,
    ),
    ...['org:read', 'project:read'].map((permission) =>
      st(
        'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        a.orgId,
        ROLE_ADMIN,
        permission,
      ),
    ),
    st(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'project:packages:write')",
      a.orgId,
      ROLE_OWNER,
    ),
    st(
      "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'u1@example.test', 'active')",
      U1,
      a.orgId,
    ),
    st(
      "INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, 'alpha', 'alpha', 'active')",
      P1,
      a.orgId,
    ),
    identity(EMAIL_IDENTITY, 'idp2'),
    identity(GROUP_IDENTITY, 'idp3'),
    st(
      "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, 'idp3', 'devs', ?)",
      a.orgId,
      U1,
      at(-HOUR),
    ),
    st(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES ('01J0GRANT00000000000000001', ?, 'email', 'u1@example.test', NULL, 'organization', NULL, ?)",
      a.orgId,
      ROLE_ADMIN,
    ),
    st(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES ('01J0GRANT00000000000000002', ?, 'group', 'devs', 'idp3', 'project', ?, ?)",
      a.orgId,
      P1,
      ROLE_OWNER,
    ),
    st(
      'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      SESSION,
      a.orgId,
      U1,
      EMAIL_IDENTITY,
      SECRET,
      'cd'.repeat(32),
      at(-60_000),
      at(8 * HOUR),
    ),
  ]);
  await executor.batch([
    st(
      "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'u2@example.test', 'active')",
      U2,
      a.orgId,
    ),
    st(
      "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'u3@example.test', 'active')",
      U3,
      a.orgId,
    ),
    st(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, 'email', 'u2@example.test', NULL, 'organization', NULL, ?)",
      ADMIN_GRANT_U2,
      a.orgId,
      ROLE_ADMIN,
    ),
    st(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, 'group', 'admins', 'idp5', 'organization', NULL, ?)",
      ADMIN_GRANT_GROUP,
      a.orgId,
      ROLE_ADMIN,
    ),
    st(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
      TOTP,
      a.orgId,
    ),
    st(
      'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?, ?)',
      U2,
      a.orgId,
      'pbkdf2-sha256$i=100000$v=1$c2FsdA$aGFzaA',
      TOTP,
      at(-HOUR),
    ),
    st(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      U3_IDENTITY,
      a.orgId,
      U3,
      'idp5',
      `subject-${U3_IDENTITY}`,
      'u3@example.test',
      at(-HOUR),
    ),
    st(
      "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, 'idp5', 'admins', ?)",
      a.orgId,
      U3,
      at(-HOUR),
    ),
  ]);
}, 60_000);

const lookupInput: SessionLookupInput = {
  secretHash: SECRET,
  boundary: 'project',
  projectSlug: 'alpha',
  providerAnchors: ANCHORS,
};

describe('d1 authorization statements with 8 provider anchors', () => {
  it('lookupSession resolves the session, both grant paths and the protected holder', async () => {
    expect(lookupSessionStatement(a, lookupInput).params.length).toBeLessThanOrEqual(100);
    const access = await createAccessRepository(executor).lookupSession(a, lookupInput);
    expect(access?.session.id).toBe(SESSION);
    expect(access?.identity?.fresh).toBe(true);
    expect(access?.organizationPermissions).toEqual(['org:read', 'project:read']);
    expect(access?.projectPermissions).toEqual(['project:packages:write']);
    expect(access?.protectedHolder).toBe(true);
  });

  it('lookupSession drops the group contribution when its anchor no longer matches', async () => {
    const access = await createAccessRepository(executor).lookupSession(a, {
      ...lookupInput,
      providerAnchors: ANCHORS.map((entry) =>
        entry.provider === 'idp3' ? { ...entry, anchor: 'https://moved.example.test' } : entry,
      ),
    });
    expect(access?.organizationPermissions).toEqual(['org:read', 'project:read']);
    expect(access?.projectPermissions).toEqual([]);
  });

  function guard(permission: string): readonly Statement[] {
    return assertGuard(
      holdsPermission(a, {
        userId: U1,
        permission,
        projectId: P1,
        providerAnchors: ANCHORS,
        projectState: 'active',
        session: SESSION,
      }),
      a,
    ) as unknown as readonly Statement[];
  }

  it('a holdsPermission guard passes for a held permission', async () => {
    const statements = guard('project:packages:write');
    for (const statement of statements) {
      expect(statement.params.length).toBeLessThanOrEqual(100);
    }
    await expect(executor.batch(statements)).resolves.toBeDefined();
  });

  it('two correlated holdsPermission conditions over selected projects share one statement', async () => {
    const condition = (second: string): Guard =>
      existsGuard((database) =>
        database
          .selectFrom('user_account as issuing_user')
          .select('issuing_user.id')
          .where('issuing_user.id', '=', U1)
          .where((outer) =>
            outer.not(
              outer.exists(
                database
                  .selectFrom('project as selected_project')
                  .select('selected_project.id')
                  .where('selected_project.id', 'in', [P1])
                  .where((inner) => {
                    const holds = (permission: string) =>
                      holdsPermission(a, {
                        userId: outer.ref('issuing_user.id'),
                        permission,
                        projectId: inner.ref('selected_project.id'),
                        providerAnchors: ANCHORS,
                        projectState: 'active',
                        session: SESSION,
                      });
                    return inner.or([inner.not(holds('project:read')), inner.not(holds(second))]);
                  }),
              ),
            ),
          ),
      );
    const held = assertGuard(condition('project:packages:write'), a) as unknown as Statement[];
    for (const statement of held) {
      expect(statement.params.length).toBeLessThanOrEqual(100);
    }
    await expect(executor.batch(held)).resolves.toBeDefined();
    await expect(
      executor.batch(assertGuard(condition('project:settings:write'), a) as unknown as Statement[]),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('a holdsPermission guard fails the batch for a permission not held', async () => {
    await expect(executor.batch(guard('project:settings:write'))).rejects.toThrow(/UNIQUE/i);
  });
});

describe('d1 protectedHolder with 8 provider anchors', () => {
  const now = () => new Date().toISOString();
  const fresh = (exclude?: ProtectedHolderInput['exclude']): ProtectedHolderInput => ({
    kind: 'fresh',
    now: now(),
    providers: ANCHORS,
    ...(exclude === undefined ? {} : { exclude }),
  });

  async function holders(input: ProtectedHolderInput): Promise<Record<string, boolean>> {
    const statement = compile(
      db
        .selectFrom('user_account as candidate')
        .select((eb) => [
          'candidate.id as id',
          eb
            .case()
            .when(protectedHolder(a, eb.ref('candidate.id'), input))
            .then(1)
            .else(0)
            .end()
            .as('held'),
          eb
            .case()
            .when(eb.not(protectedHolder(a, eb.ref('candidate.id'), input)))
            .then(1)
            .else(0)
            .end()
            .as('negated'),
        ])
        .where('candidate.org_id', '=', a.orgId)
        .where('candidate.id', 'in', [U1, U2, U3])
        .orderBy('candidate.id'),
    );
    expect(statement.params.length).toBeLessThanOrEqual(100);
    const rows = await executor.all<{ id: string; held: number; negated: number }>(statement);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.negated, row.id).toBe(1 - row.held);
    }
    return Object.fromEntries(rows.map((row) => [row.id, row.held === 1]));
  }

  it('counts an e-mail holder, a local admin and a group holder when fresh', async () => {
    expect(await holders(fresh())).toEqual({ [U1]: true, [U2]: true, [U3]: true });
  });

  it('counts only the local admin for local recovery', async () => {
    expect(await holders({ kind: 'local_recovery' })).toEqual({
      [U1]: false,
      [U2]: true,
      [U3]: false,
    });
  });

  it('drops exactly the excluded contribution', async () => {
    expect(await holders(fresh({ identityId: EMAIL_IDENTITY }))).toEqual({
      [U1]: false,
      [U2]: true,
      [U3]: true,
    });
    expect(await holders(fresh({ identityId: U1_IDENTITY_UNUSED }))).toEqual({
      [U1]: true,
      [U2]: true,
      [U3]: true,
    });
    expect(await holders(fresh({ grantId: ADMIN_GRANT_U1 }))).toEqual({
      [U1]: false,
      [U2]: true,
      [U3]: true,
    });
    expect(await holders(fresh({ grantId: ADMIN_GRANT_GROUP }))).toEqual({
      [U1]: true,
      [U2]: true,
      [U3]: false,
    });
    expect(await holders(fresh({ userId: U2 }))).toEqual({ [U1]: true, [U2]: false, [U3]: true });
    expect(
      await holders(fresh({ membership: { userId: U3, provider: 'idp5', groupName: 'admins' } })),
    ).toEqual({ [U1]: true, [U2]: true, [U3]: false });
  });

  it('drops the group holder when its anchor moved', async () => {
    expect(
      await holders({
        kind: 'fresh',
        now: now(),
        providers: ANCHORS.map((entry) =>
          entry.provider === 'idp5' ? { ...entry, anchor: 'https://moved.example.test' } : entry,
        ),
      }),
    ).toEqual({ [U1]: true, [U2]: true, [U3]: false });
  });
});
