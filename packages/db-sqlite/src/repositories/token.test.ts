import { auditEvent, type AuditAction } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import type { IdempotencyRecord } from '@package-broker/core/api/idempotency';
import type { IssueServiceTokenInput } from './token.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutationFence } from '@package-broker/core/authz/fence';
import type { AuthenticatedActor, MutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { assertGuard } from '../kysely.js';
import { sql } from 'kysely';
import { createTokenRepository, type MintedToken, type TokenRepository } from './token.js';

const USER = '01J0USER000000000000000001';
const OTHER_USER = '01J0USER000000000000000002';
const SESSION = '01J0SESSION0000000000000001';
const SSO_SESSION = '01J0SESSION0000000000000002';
const ADMIN_ROLE = '01J0ROLE000000000000000001';
const WRITER_ROLE = '01J0ROLE000000000000000002';
const READER_ROLE = '01J0ROLE000000000000000003';
const ANCHORS = [
  {
    provider: 'idp',
    anchor: 'anchor-1',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const OTHER_SSO_SESSION = '01J0SESSION0000000000000003';
const IDENTITY = '01J0IDENTITY00000000000001';
const OTHER_IDENTITY = '01J0IDENTITY00000000000002';
const SECOND_IDENTITY = '01J0IDENTITY00000000000003';
const TOKEN = '01J0TOKEN0000000000000000A';
const OP_PATTERN = /^[0-9A-Z]{26}$/;

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let repository: TokenRepository;

function insert(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fence(userId = USER, sessionId = SESSION): MutationFence {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, {});
}

function projectId(n: number, prefix = 'P'): string {
  return `01J0${prefix}${String(n).padStart(21, '0')}`;
}

async function addProjects(org: OrgContext, count: number, prefix = 'P'): Promise<string[]> {
  const ids = Array.from({ length: count }, (_, index) => projectId(index + 1, prefix));
  await executor.batch(
    ids.map((id, index) =>
      insert(
        'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
        id,
        org.orgId,
        `${prefix.toLowerCase()}-${index + 1}`,
        `Project ${index + 1}`,
      ),
    ),
  );
  return ids;
}

function secret(n: number): string {
  return `s${n}`.padEnd(43, 'x');
}

function plain(selector: string, n: number): string {
  return `pb_pat_${selector}_${secret(n)}`;
}

function hashOf(n: number): string {
  return `${n}`.padStart(64, 'a');
}

function minter(...selectors: string[]): { mint: () => MintedToken; calls: () => number } {
  let calls = 0;
  return {
    mint: () => {
      const selector = selectors[Math.min(calls, selectors.length - 1)] as string;
      calls += 1;
      return {
        selector,
        hash: hashOf(calls),
        pepperVersion: 1,
        plaintext: plain(selector, calls),
      };
    },
    calls: () => calls,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: TOKEN,
    audit: mutationAudit(),
    name: 'laptop',
    scope: 'read' as const,
    expiresAt: iso(86_400_000),
    now: iso(0),
    validation: { kind: 'local' as const },
    projectMode: 'all' as const,
    projectIds: [] as string[],
    providerAnchors: ANCHORS,
    ...overrides,
  };
}

async function one<R>(sql: string, ...params: Statement['params']): Promise<R | undefined> {
  return (await executor.all<R>({ sql, params }))[0];
}

async function tokenCount(): Promise<number> {
  return (await one<{ n: number }>('SELECT count(*) AS n FROM token'))?.n ?? -1;
}

async function bindingCount(): Promise<number> {
  return (await one<{ n: number }>('SELECT count(*) AS n FROM token_project'))?.n ?? -1;
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  a = database.orgs.a;
  b = database.orgs.b;
  executor = database.executor;
  repository = createTokenRepository(executor);
  await executor.batch([
    insert(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      USER,
      a.orgId,
      'user@example.test',
      'active',
    ),
    insert(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      OTHER_USER,
      a.orgId,
      'other@example.test',
      'active',
    ),
    insert(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      IDENTITY,
      a.orgId,
      USER,
      'idp',
      'subject-1',
      'user@example.test',
      iso(-3_600_000),
    ),
    insert(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 1)',
      ADMIN_ROLE,
      a.orgId,
      'organization_admin',
      'Admin',
      'organization',
    ),
    insert(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'project:packages:read'), (?, ?, 'project:packages:write')",
      a.orgId,
      ADMIN_ROLE,
      a.orgId,
      ADMIN_ROLE,
    ),
    insert(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'writer', 'Writer', 'project', 0), (?, ?, 'reader', 'Reader', 'project', 0)",
      WRITER_ROLE,
      a.orgId,
      READER_ROLE,
      a.orgId,
    ),
    insert(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'project:packages:read'), (?, ?, 'project:packages:write'), (?, ?, 'project:packages:read')",
      a.orgId,
      WRITER_ROLE,
      a.orgId,
      WRITER_ROLE,
      a.orgId,
      READER_ROLE,
    ),
    insert(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'idp', 'anchor-1')",
      a.orgId,
    ),
    insert(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('01J0CREDENTIAL000000000001', ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
      a.orgId,
    ),
    insert(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, 'email', ?, NULL, 'organization', NULL, ?)",
      '01J0GRANT000000000000000001',
      a.orgId,
      'user@example.test',
      ADMIN_ROLE,
    ),
    insert(
      "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, 'pbkdf2-sha256$i=1$v=1$c2FsdA$aGFzaA', '01J0CREDENTIAL000000000001', ?, ?)",
      USER,
      a.orgId,
      iso(-3_600_000),
      iso(-3_600_000),
    ),
    insert(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      SECOND_IDENTITY,
      a.orgId,
      USER,
      'idp2',
      'subject-1b',
      'user@example.test',
      iso(-3_600_000),
    ),
    insert(
      'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      SSO_SESSION,
      a.orgId,
      USER,
      IDENTITY,
      'c'.repeat(64),
      'd'.repeat(64),
      iso(3_600_000),
      iso(-60_000),
    ),
    insert(
      'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      OTHER_SSO_SESSION,
      a.orgId,
      USER,
      SECOND_IDENTITY,
      'e'.repeat(64),
      'f'.repeat(64),
      iso(3_600_000),
      iso(-60_000),
    ),
    insert(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified) VALUES (?, ?, ?, ?, ?, ?, 1)',
      OTHER_IDENTITY,
      a.orgId,
      OTHER_USER,
      'idp',
      'subject-2',
      'other@example.test',
    ),
    insert(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      SESSION,
      a.orgId,
      USER,
      'a'.repeat(64),
      'b'.repeat(64),
      iso(3_600_000),
      iso(-60_000),
    ),
  ]);
});

afterEach(async () => {
  await database.close();
});

describe('issuePersonal', () => {
  it('stores an all-project token with project_mode all and no bindings', async () => {
    const { mint } = minter('abcdefghijkl');
    const result = await repository.issuePersonal(a, fence(), baseInput(), mint);

    expect(result).toEqual({
      status: 'issued',
      id: TOKEN,
      plaintext: plain('abcdefghijkl', 1),
    });
    const row = await one<Record<string, unknown>>(
      'SELECT kind, selector, project_mode, user_id, created_by_user_id, scopes_json, read_only, validation_kind, validation_identity_id, last_op_id, revoked_at FROM token WHERE id = ?',
      TOKEN,
    );
    expect(row).toMatchObject({
      kind: 'pat',
      selector: 'abcdefghijkl',
      project_mode: 'all',
      user_id: USER,
      created_by_user_id: USER,
      scopes_json: '["read"]',
      read_only: 1,
      validation_kind: 'local',
      validation_identity_id: null,
      revoked_at: null,
    });
    expect(row?.last_op_id).toMatch(OP_PATTERN);
    expect(await bindingCount()).toBe(0);
  });

  it('stores a selected token with its bindings and an sso validation identity', async () => {
    const ids = await addProjects(a, 3);
    const { mint } = minter('abcdefghijkl');
    const result = await repository.issuePersonal(
      a,
      fence(USER, SSO_SESSION),
      baseInput({
        scope: 'write',
        projectMode: 'selected',
        projectIds: ids,
        validation: { kind: 'sso', identityId: IDENTITY },
      }),
      mint,
    );

    expect(result.status).toBe('issued');
    const row = await one<Record<string, unknown>>(
      'SELECT project_mode, read_only, scopes_json, validation_kind, validation_identity_id FROM token WHERE id = ?',
      TOKEN,
    );
    expect(row).toMatchObject({
      project_mode: 'selected',
      read_only: 0,
      scopes_json: '["write"]',
      validation_kind: 'sso',
      validation_identity_id: IDENTITY,
    });
    const bound = await executor.all<{ project_id: string; org_id: string }>({
      sql: 'SELECT project_id, org_id FROM token_project WHERE token_id = ? ORDER BY project_id',
      params: [TOKEN],
    });
    expect(bound.map((r) => r.project_id)).toEqual(ids);
    expect(bound.every((r) => r.org_id === a.orgId)).toBe(true);
  });

  it('binds exactly 200 selected projects through one JSON parameter', async () => {
    const ids = await addProjects(a, 200);
    const { mint } = minter('abcdefghijkl');
    const seen: Statement[] = [];
    const spy: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: executor.all.bind(executor),
      batch: (statements) => {
        seen.push(...statements);
        return executor.batch(statements);
      },
    };
    const result = await createTokenRepository(spy).issuePersonal(
      a,
      fence(),
      baseInput({ projectMode: 'selected', projectIds: ids }),
      mint,
    );

    expect(result.status).toBe('issued');
    expect(await bindingCount()).toBe(200);
    const bindingInsert = seen.find((s) => /insert into "token_project"/i.test(s.sql));
    expect(bindingInsert?.sql).toMatch(/json_each\(\?\)/);
    expect(
      bindingInsert?.params.filter((p) => typeof p === 'string' && p.startsWith('[')),
    ).toHaveLength(1);
    expect(bindingInsert?.params.length).toBeLessThan(10);
  });

  it.each([
    ['no ids', () => []],
    ['201 ids', () => Array.from({ length: 201 }, (_, i) => projectId(i + 1))],
    ['duplicate ids', () => [projectId(1), projectId(1)]],
    ['an empty id', () => ['']],
  ])('refuses a selected token with %s before any SQL', async (_label, ids) => {
    const { mint, calls } = minter('abcdefghijkl');
    await expect(
      repository.issuePersonal(
        a,
        fence(),
        baseInput({ projectMode: 'selected', projectIds: ids() }),
        mint,
      ),
    ).rejects.toThrow(TypeError);
    expect(calls()).toBe(0);
    expect(await tokenCount()).toBe(0);
  });

  it('refuses an all-project token that carries project ids', async () => {
    const { mint } = minter('abcdefghijkl');
    await expect(
      repository.issuePersonal(a, fence(), baseInput({ projectIds: [projectId(1)] }), mint),
    ).rejects.toThrow(TypeError);
  });

  it.each([
    ['uppercase selector', { selector: 'ABCDEFGHIJKL', plaintext: plain('ABCDEFGHIJKL', 1) }],
    ['short selector', { selector: 'abc', plaintext: `pb_pat_abc_${secret(1)}` }],
    ['hash', { hash: 'xyz' }],
    ['pepper version', { pepperVersion: 0 }],
    ['plaintext prefix', { plaintext: `pb_svc_abcdefghijkl_${secret(1)}` }],
    ['plaintext secret length', { plaintext: 'pb_pat_abcdefghijkl_short' }],
    ['plaintext selector', { plaintext: plain('mnopqrstuvwx', 1) }],
  ])('refuses a minted token with a bad %s', async (_label, patch) => {
    const mint = (): MintedToken => ({
      selector: 'abcdefghijkl',
      hash: hashOf(1),
      pepperVersion: 1,
      plaintext: plain('abcdefghijkl', 1),
      ...patch,
    });
    await expect(repository.issuePersonal(a, fence(), baseInput(), mint)).rejects.toThrow(
      TypeError,
    );
    expect(await tokenCount()).toBe(0);
  });

  it('accepts the valid pair the malformed cases start from', async () => {
    const result = await repository.issuePersonal(a, fence(), baseInput(), () => ({
      selector: 'abcdefghijkl',
      hash: hashOf(1),
      pepperVersion: 1,
      plaintext: plain('abcdefghijkl', 1),
    }));

    expect(result.status).toBe('issued');
  });

  it('refuses a selected project outside the organization and stores nothing', async () => {
    const own = await addProjects(a, 1);
    const foreign = await addProjects(b, 1, 'Q');
    const { mint, calls } = minter('abcdefghijkl');
    const result = await repository.issuePersonal(
      a,
      fence(),
      baseInput({ projectMode: 'selected', projectIds: [...own, ...foreign] }),
      mint,
    );

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
    expect(calls()).toBe(1);
    expect(await tokenCount()).toBe(0);
    expect(await bindingCount()).toBe(0);
  });

  it('refuses an archived selected project and an unknown one', async () => {
    const ids = await addProjects(a, 2);
    await executor.all({
      sql: "UPDATE project SET status = 'archived' WHERE id = ?",
      params: [ids[1] as string],
    });
    const { mint } = minter('abcdefghijkl');
    const archived = await repository.issuePersonal(
      a,
      fence(),
      baseInput({ projectMode: 'selected', projectIds: ids }),
      mint,
    );
    const unknown = await repository.issuePersonal(
      a,
      fence(),
      baseInput({ projectMode: 'selected', projectIds: [projectId(99)] }),
      mint,
    );

    expect(archived).toEqual({ status: 'refused', reason: 'authority' });
    expect(unknown).toEqual({ status: 'refused', reason: 'authority' });
    expect(await tokenCount()).toBe(0);
  });

  it('fails the count assertion and leaves no token when the binding insert is truncated', async () => {
    const ids = await addProjects(a, 5);
    const truncating: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: executor.all.bind(executor),
      batch: (statements) =>
        executor.batch(
          statements.map((statement) =>
            /insert into "token_project"/i.test(statement.sql)
              ? {
                  sql: statement.sql,
                  params: statement.params.map((param) =>
                    typeof param === 'string' && param.startsWith('[')
                      ? JSON.stringify((JSON.parse(param) as string[]).slice(0, 3))
                      : param,
                  ),
                }
              : statement,
          ),
        ),
    };
    const { mint } = minter('abcdefghijkl');
    const result = await createTokenRepository(truncating).issuePersonal(
      a,
      fence(),
      baseInput({ projectMode: 'selected', projectIds: ids }),
      mint,
    );

    expect(result).toEqual({ status: 'refused', reason: 'unclassified' });
    expect(await tokenCount()).toBe(0);
    expect(await bindingCount()).toBe(0);
  });

  it('retries a selector collision with a fresh pair and returns the plaintext of the stored one', async () => {
    await repository.issuePersonal(
      a,
      fence(),
      baseInput({ id: '01J0TOKEN0000000000000000B' }),
      minter('abcdefghijkl').mint,
    );
    const { mint, calls } = minter('abcdefghijkl', 'abcdefghijkl', 'mnopqrstuvwx');
    const result = await repository.issuePersonal(a, fence(), baseInput(), mint);

    expect(calls()).toBe(3);
    expect(result).toEqual({
      status: 'issued',
      id: TOKEN,
      plaintext: plain('mnopqrstuvwx', 3),
    });
    expect(
      (await one<{ selector: string }>('SELECT selector FROM token WHERE id = ?', TOKEN))?.selector,
    ).toBe('mnopqrstuvwx');
  });

  it('refuses after three colliding pairs and keeps the existing token', async () => {
    await repository.issuePersonal(
      a,
      fence(),
      baseInput({ id: '01J0TOKEN0000000000000000B' }),
      minter('abcdefghijkl').mint,
    );
    const { mint, calls } = minter('abcdefghijkl');
    const result = await repository.issuePersonal(a, fence(), baseInput(), mint);

    expect(calls()).toBe(3);
    expect(result).toEqual({ status: 'refused', reason: 'selector_collision' });
    expect(await tokenCount()).toBe(1);
  });

  it('refuses an id clash immediately, also when the selector collides at the same time', async () => {
    await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint);
    const { mint, calls } = minter('abcdefghijkl', 'yzabcdefghij');
    const result = await repository.issuePersonal(a, fence(), baseInput(), mint);

    expect(calls()).toBe(1);
    expect(result).toEqual({ status: 'refused', reason: 'id_conflict' });
    expect(await tokenCount()).toBe(1);
  });

  it.each([
    [
      'revoked session',
      "UPDATE session SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ],
    ['expired session', "UPDATE session SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?"],
    ['missing reauth', 'UPDATE session SET reauth_at = NULL WHERE id = ?'],
    ['stale reauth', "UPDATE session SET reauth_at = '2020-01-01T00:00:00.000Z' WHERE id = ?"],
    [
      'future reauth',
      "UPDATE session SET reauth_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour') WHERE id = ?",
    ],
  ])('refuses a %s without storing anything', async (_label, statement) => {
    await executor.all({ sql: statement, params: [SESSION] });
    const { mint } = minter('abcdefghijkl');
    const result = await repository.issuePersonal(a, fence(), baseInput(), mint);

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
    expect(await tokenCount()).toBe(0);
  });

  it('refuses a suspended user, another organization and a foreign session', async () => {
    const { mint } = minter('abcdefghijkl');
    const foreignSession = await repository.issuePersonal(
      a,
      fence(OTHER_USER, SESSION),
      baseInput(),
      mint,
    );
    const otherOrg = await repository.issuePersonal(b, fence(), baseInput(), mint);
    await executor.all({
      sql: "UPDATE user_account SET status = 'suspended' WHERE id = ?",
      params: [USER],
    });
    const suspended = await repository.issuePersonal(a, fence(), baseInput(), mint);

    for (const result of [foreignSession, otherOrg, suspended]) {
      expect(result).toEqual({ status: 'refused', reason: 'authority' });
    }
    expect(await tokenCount()).toBe(0);
  });

  it('refuses an sso identity that belongs to another user', async () => {
    const { mint } = minter('abcdefghijkl');
    const result = await repository.issuePersonal(
      a,
      fence(USER, SSO_SESSION),
      baseInput({ validation: { kind: 'sso', identityId: OTHER_IDENTITY } }),
      mint,
    );

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
    expect(await tokenCount()).toBe(0);
  });

  it('refuses an expiry that is missing, malformed or already past', async () => {
    const { mint } = minter('abcdefghijkl');
    for (const expiresAt of [null, 'tomorrow', '2020-01-01T00:00:00.000Z']) {
      await expect(
        repository.issuePersonal(a, fence(), baseInput({ expiresAt }), mint),
      ).rejects.toThrow(TypeError);
    }
    expect(await tokenCount()).toBe(0);
  });

  it('never exposes the stored hash in the result', async () => {
    const { mint } = minter('abcdefghijkl');
    const result = await repository.issuePersonal(a, fence(), baseInput(), mint);

    expect(JSON.stringify(result)).not.toContain(hashOf(1));
  });
});

function liveSession(org: OrgContext = a, sessionId = SESSION) {
  return assertGuard(
    sql<boolean>`exists (select 1 from session where id = ${sessionId} and org_id = ${org.orgId} and revoked_at is null and unixepoch(expires_at) > unixepoch('now'))`,
    org,
  );
}

describe('revoke', () => {
  async function issue(): Promise<void> {
    await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint);
  }

  it('revokes a live token once and reports the operation marker', async () => {
    await issue();
    const stamp = '2026-10-16T10:00:00.000Z';
    const result = await repository.revoke(a, fence(), liveSession(), {
      audit: mutationAudit('token.revoke'),
      tokenId: TOKEN,
      now: stamp,
    });

    expect(result.status).toBe('revoked');
    if (result.status !== 'revoked') throw new Error('unreachable');
    expect(result.opId).toMatch(OP_PATTERN);
    expect(await one('SELECT revoked_at, last_op_id FROM token WHERE id = ?', TOKEN)).toEqual({
      revoked_at: stamp,
      last_op_id: result.opId,
    });
  });

  it('is idempotent: the second revoke changes nothing and carries no marker', async () => {
    await issue();
    const first = await repository.revoke(a, fence(), liveSession(), {
      audit: mutationAudit('token.revoke'),
      tokenId: TOKEN,
      now: '2026-10-16T10:00:00.000Z',
    });
    const before = await one('SELECT revoked_at, last_op_id FROM token WHERE id = ?', TOKEN);
    const second = await repository.revoke(a, fence(), liveSession(), {
      audit: mutationAudit('token.revoke'),
      tokenId: TOKEN,
      now: '2026-10-16T11:00:00.000Z',
    });

    expect(first.status).toBe('revoked');
    expect(second).toEqual({ status: 'already_revoked' });
    expect(await one('SELECT revoked_at, last_op_id FROM token WHERE id = ?', TOKEN)).toEqual(
      before,
    );
  });

  it('answers not_found for an unknown id and for another organization', async () => {
    await issue();

    expect(
      await repository.revoke(a, fence(), liveSession(), {
        audit: mutationAudit('token.revoke'),
        tokenId: '01J0TOKENMISSING00000000000',
        now: iso(0),
      }),
    ).toEqual({
      status: 'not_found',
    });
    await executor.batch([
      insert(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        '01J0USER00000000000000000B',
        b.orgId,
        'b@example.test',
      ),
      insert(
        'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        '01J0SESSION000000000000000B',
        b.orgId,
        '01J0USER00000000000000000B',
        '1'.repeat(64),
        '2'.repeat(64),
        iso(3_600_000),
      ),
    ]);
    expect(
      await repository.revoke(
        b,
        fence('01J0USER00000000000000000B', '01J0SESSION000000000000000B'),
        assertGuard(sql<boolean>`1`, b),
        { audit: mutationAudit('token.revoke'), tokenId: TOKEN, now: iso(0) },
      ),
    ).toEqual({ status: 'not_found' });
    expect(
      await repository.revoke(b, fence(), assertGuard(sql<boolean>`1`, b), {
        audit: mutationAudit('token.revoke'),
        tokenId: TOKEN,
        now: iso(0),
      }),
    ).toEqual({ status: 'refused', reason: 'authority' });
    expect(
      (await one<{ revoked_at: string | null }>('SELECT revoked_at FROM token WHERE id = ?', TOKEN))
        ?.revoked_at,
    ).toBeNull();
  });

  it('refuses a malformed timestamp before SQL', async () => {
    await issue();
    await expect(
      repository.revoke(a, fence(), liveSession(), {
        audit: mutationAudit('token.revoke'),
        tokenId: TOKEN,
        now: 'now',
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('issuance policy', () => {
  async function capProject(id: string, cap: string): Promise<void> {
    await executor.all({
      sql: 'UPDATE project SET token_max_scope = ? WHERE id = ?',
      params: [cap, id],
    });
  }

  it('refuses a scope above the cap of any selected project', async () => {
    const ids = await addProjects(a, 3);
    await capProject(ids[2] as string, 'read');
    const { mint } = minter('abcdefghijkl');
    const refused = await repository.issuePersonal(
      a,
      fence(),
      baseInput({ scope: 'write', projectMode: 'selected', projectIds: ids }),
      mint,
    );
    const allowed = await repository.issuePersonal(
      a,
      fence(),
      baseInput({ scope: 'read', projectMode: 'selected', projectIds: ids }),
      mint,
    );

    expect(refused).toEqual({ status: 'refused', reason: 'authority' });
    expect(allowed.status).toBe('issued');
  });

  it('refuses an all-project scope above the cap of any active project, ignoring archived ones', async () => {
    const ids = await addProjects(a, 2);
    await capProject(ids[0] as string, 'write');
    const { mint } = minter('abcdefghijkl');

    expect(await repository.issuePersonal(a, fence(), baseInput({ scope: 'full' }), mint)).toEqual({
      status: 'refused',
      reason: 'authority',
    });

    await executor.all({
      sql: "UPDATE project SET status = 'archived' WHERE id = ?",
      params: [ids[0] as string],
    });
    expect(
      (await repository.issuePersonal(a, fence(), baseInput({ scope: 'full' }), mint)).status,
    ).toBe('issued');
  });

  it('refuses a local token from an sso session and an sso token from a local session', async () => {
    const { mint } = minter('abcdefghijkl');
    const local = await repository.issuePersonal(a, fence(USER, SSO_SESSION), baseInput(), mint);
    const sso = await repository.issuePersonal(
      a,
      fence(),
      baseInput({ validation: { kind: 'sso', identityId: IDENTITY } }),
      mint,
    );

    expect(local).toEqual({ status: 'refused', reason: 'authority' });
    expect(sso).toEqual({ status: 'refused', reason: 'authority' });
    expect(await tokenCount()).toBe(0);
  });

  it('refuses another identity of the same user than the one the session signed in with', async () => {
    const { mint } = minter('abcdefghijkl');
    const result = await repository.issuePersonal(
      a,
      fence(USER, SSO_SESSION),
      baseInput({ validation: { kind: 'sso', identityId: SECOND_IDENTITY } }),
      mint,
    );

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
  });

  it('refuses an identity of another organization', async () => {
    await executor.batch([
      insert(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        '01J0USER000000000000000009',
        b.orgId,
        'user@example.test',
      ),
      insert(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        '01J0IDENTITY00000000000009',
        b.orgId,
        '01J0USER000000000000000009',
        'idp',
        'subject-9',
        'user@example.test',
        iso(-1000),
      ),
    ]);
    const { mint } = minter('abcdefghijkl');
    const result = await repository.issuePersonal(
      a,
      fence(USER, SSO_SESSION),
      baseInput({ validation: { kind: 'sso', identityId: '01J0IDENTITY00000000000009' } }),
      mint,
    );

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
  });

  it.each([
    ['unverified', 'UPDATE identity SET email_verified = 0 WHERE id = ?'],
    ['stale', "UPDATE identity SET validated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?"],
    ['never validated', 'UPDATE identity SET validated_at = NULL WHERE id = ?'],
    ['email changed', "UPDATE identity SET email = 'moved@example.test' WHERE id = ?"],
  ])('refuses an sso identity that is %s', async (_label, statement) => {
    await executor.all({ sql: statement, params: [IDENTITY] });
    const { mint } = minter('abcdefghijkl');
    const result = await repository.issuePersonal(
      a,
      fence(USER, SSO_SESSION),
      baseInput({ validation: { kind: 'sso', identityId: IDENTITY } }),
      mint,
    );

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
  });

  it.each([
    [
      'stale',
      "UPDATE local_login SET last_login_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?",
    ],
    ['never', 'UPDATE local_login SET last_login_at = NULL WHERE user_id = ?'],
    ['missing', 'DELETE FROM local_login WHERE user_id = ?'],
  ])('refuses a local token when the local login is %s', async (_label, statement) => {
    await executor.all({ sql: statement, params: [USER] });
    const { mint } = minter('abcdefghijkl');

    expect(await repository.issuePersonal(a, fence(), baseInput(), mint)).toEqual({
      status: 'refused',
      reason: 'authority',
    });
  });

  it('refuses an expiry beyond the organization default, capped at 90 days', async () => {
    const { mint } = minter('abcdefghijkl');
    const tooLong = await repository.issuePersonal(
      a,
      fence(),
      baseInput({ expiresAt: iso(91 * 86_400_000) }),
      mint,
    );
    const atCap = await repository.issuePersonal(
      a,
      fence(),
      baseInput({ expiresAt: iso(89 * 86_400_000) }),
      mint,
    );
    await executor.all({
      sql: 'UPDATE organization SET token_default_expiry_days = 7 WHERE id = ?',
      params: [a.orgId],
    });
    const orgCap = await repository.issuePersonal(
      a,
      fence(),
      baseInput({ id: '01J0TOKEN0000000000000000B', expiresAt: iso(8 * 86_400_000) }),
      minter('mnopqrstuvwx').mint,
    );

    expect(tooLong).toEqual({ status: 'refused', reason: 'authority' });
    expect(atCap.status).toBe('issued');
    expect(orgCap).toEqual({ status: 'refused', reason: 'authority' });
  });

  it('refuses an expiry that the database clock already considers past', async () => {
    const result = await repository.issuePersonal(
      a,
      fence(),
      baseInput({ now: '2020-01-01T00:00:00.000Z', expiresAt: '2020-06-01T00:00:00.000Z' }),
      minter('abcdefghijkl').mint,
    );

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
  });

  it('aborts when the session is revoked inside the mint callback', async () => {
    const result = await repository.issuePersonal(a, fence(), baseInput(), async () => {
      await executor.all({
        sql: "UPDATE session SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
        params: [SESSION],
      });
      return minter('abcdefghijkl').mint();
    });

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
    expect(await tokenCount()).toBe(0);
  });

  it('refuses a local token when the user is not a current organization admin', async () => {
    await executor.all({ sql: 'DELETE FROM access_grant WHERE org_id = ?', params: [a.orgId] });

    expect(
      await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint),
    ).toEqual({
      status: 'refused',
      reason: 'authority',
    });
  });

  it('aborts when local admin eligibility is removed inside the mint callback', async () => {
    const result = await repository.issuePersonal(a, fence(), baseInput(), async () => {
      await executor.all({ sql: 'DELETE FROM access_grant WHERE org_id = ?', params: [a.orgId] });
      return minter('abcdefghijkl').mint();
    });

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
    expect(await tokenCount()).toBe(0);
  });

  it('aborts when the reauth window closes inside the mint callback', async () => {
    const result = await repository.issuePersonal(a, fence(), baseInput(), async () => {
      await executor.all({
        sql: "UPDATE session SET reauth_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
        params: [SESSION],
      });
      return minter('abcdefghijkl').mint();
    });

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
    expect(await tokenCount()).toBe(0);
  });

  it('treats a selector held by a token of another organization as a collision', async () => {
    await executor.batch([
      insert(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        '01J0USER000000000000000008',
        b.orgId,
        'b@example.test',
      ),
      insert(
        "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at) VALUES (?, ?, 'pat', ?, ?, 1, 'x', '[\"read\"]', ?, ?)",
        '01J0TOKEN0000000000000000Z',
        b.orgId,
        'abcdefghijkl',
        'c'.repeat(64),
        '01J0USER000000000000000008',
        iso(86_400_000),
      ),
    ]);
    const { mint, calls } = minter('abcdefghijkl', 'mnopqrstuvwx');
    const result = await repository.issuePersonal(a, fence(), baseInput(), mint);

    expect(calls()).toBe(2);
    expect(result.status).toBe('issued');
  });

  it('refuses a minted pair whose plaintext is not pb_pat_<selector>_<secret>', async () => {
    for (const plaintext of [
      '',
      'pb_pat_abcdefghijkl',
      plain('mnopqrstuvwx', 1),
      `pb_svc_abcdefghijkl_${secret(1)}`,
    ]) {
      await expect(
        repository.issuePersonal(a, fence(), baseInput(), () => ({
          selector: 'abcdefghijkl',
          hash: hashOf(1),
          pepperVersion: 1,
          plaintext,
        })),
      ).rejects.toThrow(TypeError);
    }
    expect(await tokenCount()).toBe(0);
  });

  it('answers indeterminate, not refused, when the response may have been lost', async () => {
    const lost: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: executor.all.bind(executor),
      batch: async (statements) => {
        await executor.batch(statements);
        const { DbError } = await import('@package-broker/core/db/errors');
        throw new DbError('unknown', 'unknown: network lost');
      },
    };
    const result = await createTokenRepository(lost).issuePersonal(
      a,
      fence(),
      baseInput(),
      minter('abcdefghijkl').mint,
    );

    expect(result).toEqual({ status: 'indeterminate' });
  });
});

describe('fenced revoke', () => {
  async function issue(): Promise<void> {
    await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint);
  }

  it('refuses when the caller guard fails because the session was revoked', async () => {
    await issue();
    await executor.all({
      sql: "UPDATE session SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      params: [SESSION],
    });
    const result = await repository.revoke(a, fence(), liveSession(), {
      audit: mutationAudit('token.revoke'),
      tokenId: TOKEN,
      now: iso(0),
    });

    expect(result.status).toBe('refused');
    expect(
      (await one<{ revoked_at: string | null }>('SELECT revoked_at FROM token WHERE id = ?', TOKEN))
        ?.revoked_at,
    ).toBeNull();
  });

  it('refuses an empty token id', async () => {
    await expect(
      repository.revoke(a, fence(), liveSession(), {
        audit: mutationAudit('token.revoke'),
        tokenId: '',
        now: iso(0),
      }),
    ).rejects.toThrow(TypeError);
  });

  it('lets one of two concurrent revokes win', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pb-token-'));
    const file = await openMigratedDatabase({
      twoOrganizations: true,
      file: join(dir, 'd.sqlite'),
    });
    try {
      const first = file.executor;
      const second = await file.second();
      const org = file.orgs?.a as OrgContext;
      await first.batch([
        insert(
          'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
          USER,
          org.orgId,
          'u@example.test',
        ),
        insert(
          "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at) VALUES (?, ?, 'pat', ?, ?, 1, 'x', '[\"read\"]', ?, ?)",
          TOKEN,
          org.orgId,
          'abcdefghijkl',
          'c'.repeat(64),
          USER,
          iso(86_400_000),
        ),
        insert(
          'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
          SESSION,
          org.orgId,
          USER,
          'a'.repeat(64),
          'b'.repeat(64),
          iso(3_600_000),
        ),
      ]);
      const results = await Promise.all(
        [first, second].map((e) =>
          createTokenRepository(e).revoke(org, fence(), liveSession(org), {
            audit: mutationAudit('token.revoke'),
            tokenId: TOKEN,
            now: iso(0),
          }),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual(['already_revoked', 'revoked']);
    } finally {
      await file.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function epoch(): Promise<string | undefined> {
  return (
    await one<{ version: string }>('SELECT version FROM cache_epoch WHERE org_id = ?', a.orgId)
  )?.version;
}

async function projectGrants(ids: string[], roleId: string, offset = 0): Promise<void> {
  await executor.all({
    sql: 'DELETE FROM role_permission WHERE role_id = ?',
    params: [ADMIN_ROLE],
  });
  await executor.batch(
    ids.map((id, index) =>
      insert(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, 'email', 'user@example.test', NULL, 'project', ?, ?)",
        `01J0PGRANT${String(index + offset).padStart(16, '0')}`,
        a.orgId,
        id,
        roleId,
      ),
    ),
  );
}

describe('issuer authority per project', () => {
  const ssoFence = () => fence(USER, SSO_SESSION);
  const ssoInput = (overrides: Record<string, unknown>) =>
    baseInput({ validation: { kind: 'sso', identityId: IDENTITY }, ...overrides });

  it('refuses a write token when the issuer cannot write one of the selected projects', async () => {
    const ids = await addProjects(a, 3);
    await projectGrants(ids.slice(0, 2), WRITER_ROLE);
    await projectGrants([ids[2] as string], READER_ROLE, 2);
    const { mint } = minter('abcdefghijkl');
    const input = ssoInput({ scope: 'write', projectMode: 'selected', projectIds: ids });

    expect(await repository.issuePersonal(a, ssoFence(), input, mint)).toEqual({
      status: 'refused',
      reason: 'authority',
    });
    expect(
      (await repository.issuePersonal(a, ssoFence(), { ...input, scope: 'read' as const }, mint))
        .status,
    ).toBe('issued');
  });

  it('refuses when the grant is removed inside the mint callback', async () => {
    const ids = await addProjects(a, 2);
    await projectGrants(ids, WRITER_ROLE);
    const result = await repository.issuePersonal(
      a,
      ssoFence(),
      ssoInput({ scope: 'write', projectMode: 'selected', projectIds: ids }),
      async () => {
        await executor.all({
          sql: 'DELETE FROM access_grant WHERE project_id = ?',
          params: [ids[1] as string],
        });
        return minter('abcdefghijkl').mint();
      },
    );

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
    expect(await tokenCount()).toBe(0);
  });

  it('refuses a user with no grant on a selected project', async () => {
    const ids = await addProjects(a, 2);
    await projectGrants([ids[0] as string], WRITER_ROLE);
    const result = await repository.issuePersonal(
      a,
      ssoFence(),
      ssoInput({ projectMode: 'selected', projectIds: ids }),
      minter('abcdefghijkl').mint,
    );

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
  });

  it('refuses stale group evidence and accepts it once refreshed', async () => {
    const ids = await addProjects(a, 1);
    await executor.all({
      sql: 'DELETE FROM role_permission WHERE role_id = ?',
      params: [ADMIN_ROLE],
    });
    await executor.batch([
      insert(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES ('01J0GGRANT0000000000000001', ?, 'group', 'devs', 'idp', 'project', ?, ?)",
        a.orgId,
        ids[0] as string,
        WRITER_ROLE,
      ),
      insert(
        "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, 'idp', 'devs', '2020-01-01T00:00:00.000Z')",
        a.orgId,
        USER,
      ),
    ]);
    const { mint } = minter('abcdefghijkl');
    const input = ssoInput({ scope: 'write', projectMode: 'selected', projectIds: ids });

    expect(await repository.issuePersonal(a, ssoFence(), input, mint)).toEqual({
      status: 'refused',
      reason: 'authority',
    });
    await executor.all({
      sql: "UPDATE user_group SET refreshed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?",
      params: [USER],
    });
    expect((await repository.issuePersonal(a, ssoFence(), input, mint)).status).toBe('issued');
  });

  it('limits an all-project token to what the issuer holds on accessible projects', async () => {
    const ids = await addProjects(a, 2);
    await projectGrants([ids[0] as string], READER_ROLE);
    const { mint } = minter('abcdefghijkl');

    expect(
      await repository.issuePersonal(a, ssoFence(), ssoInput({ scope: 'write' }), mint),
    ).toEqual({ status: 'refused', reason: 'authority' });
    expect(
      (await repository.issuePersonal(a, ssoFence(), ssoInput({ scope: 'read' }), mint)).status,
    ).toBe('issued');
  });

  it('ignores a project the issuer cannot access for an all-project token', async () => {
    const ids = await addProjects(a, 2);
    await projectGrants([ids[0] as string], WRITER_ROLE);
    await executor.all({
      sql: "UPDATE project SET token_max_scope = 'read' WHERE id = ?",
      params: [ids[1] as string],
    });
    const result = await repository.issuePersonal(
      a,
      ssoFence(),
      ssoInput({ scope: 'write' }),
      minter('abcdefghijkl').mint,
    );

    expect(result.status).toBe('issued');
  });
});

describe('cache epoch', () => {
  function counting() {
    const seen: string[] = [];
    const spy: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: executor.all.bind(executor),
      batch: (statements) => {
        seen.push(...statements.map((s) => s.sql));
        return executor.batch(statements);
      },
    };
    return { spy, bumps: () => seen.filter((q) => /update "cache_epoch"/.test(q)).length };
  }

  it('bumps once per successful issuance and not on refusal', async () => {
    const { spy, bumps } = counting();
    const before = await epoch();
    const refused = await createTokenRepository(spy).issuePersonal(
      a,
      fence(),
      baseInput({ expiresAt: iso(400 * 86_400_000) }),
      minter('abcdefghijkl').mint,
    );

    expect(refused).toEqual({ status: 'refused', reason: 'authority' });
    expect(await epoch()).toBe(before);

    const issued = await createTokenRepository(spy).issuePersonal(
      a,
      fence(),
      baseInput(),
      minter('abcdefghijkl').mint,
    );
    expect(issued.status).toBe('issued');
    expect(bumps()).toBe(2);
    expect(await epoch()).not.toBe(before);
  });

  it('bumps once per successful revoke and not when the guard refuses', async () => {
    await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint);
    const before = await epoch();
    await repository.revoke(a, fence(), liveSession(), {
      audit: mutationAudit('token.revoke'),
      tokenId: TOKEN,
      now: iso(0),
    });
    const after = await epoch();
    await executor.all({
      sql: "UPDATE session SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      params: [SESSION],
    });
    const refused = await repository.revoke(a, fence(), liveSession(), {
      audit: mutationAudit('token.revoke'),
      tokenId: TOKEN,
      now: iso(0),
    });

    expect(after).not.toBe(before);
    expect(refused.status).toBe('refused');
    expect(await epoch()).toBe(after);
  });
});

describe('issuing session idle deadline and provider binding', () => {
  const iso2 = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  it('refuses a session idle beyond the default window', async () => {
    await executor.all({
      sql: 'UPDATE session SET last_seen_at = ? WHERE id = ?',
      params: [iso2(-2 * 3_600_000), SESSION],
    });

    expect(
      await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint),
    ).toEqual({ status: 'refused', reason: 'authority' });
    expect(await tokenCount()).toBe(0);
  });

  it('measures idleness from created_at when the session was never seen again', async () => {
    await executor.all({
      sql: 'UPDATE session SET created_at = ?, last_seen_at = NULL WHERE id = ?',
      params: [iso2(-2 * 3_600_000), SESSION],
    });

    expect(
      (await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint)).status,
    ).toBe('refused');
  });

  it('honours a configured idle window and validates it', async () => {
    await executor.all({
      sql: 'UPDATE session SET last_seen_at = ? WHERE id = ?',
      params: [iso2(-5 * 60_000), SESSION],
    });

    expect(
      (
        await createTokenRepository(executor, { idleSeconds: 60 }).issuePersonal(
          a,
          fence(),
          baseInput(),
          minter('abcdefghijkl').mint,
        )
      ).status,
    ).toBe('refused');
    expect(
      (
        await createTokenRepository(executor, { idleSeconds: 600 }).issuePersonal(
          a,
          fence(),
          baseInput(),
          minter('abcdefghijkl').mint,
        )
      ).status,
    ).toBe('issued');
    for (const idleSeconds of [59, 86_401, 1.5]) {
      expect(() => createTokenRepository(executor, { idleSeconds })).toThrow(RangeError);
    }
  });

  it('aborts when the session goes idle inside the mint callback', async () => {
    const result = await repository.issuePersonal(a, fence(), baseInput(), async () => {
      await executor.all({
        sql: 'UPDATE session SET last_seen_at = ? WHERE id = ?',
        params: [iso2(-2 * 3_600_000), SESSION],
      });
      return minter('abcdefghijkl').mint();
    });

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
  });

  const ssoInput = () => baseInput({ validation: { kind: 'sso', identityId: IDENTITY } });

  it('refuses an sso token when the identity provider binding was removed', async () => {
    await executor.all({
      sql: 'DELETE FROM identity_provider_binding WHERE org_id = ?',
      params: [a.orgId],
    });

    expect(
      await repository.issuePersonal(
        a,
        fence(USER, SSO_SESSION),
        ssoInput(),
        minter('abcdefghijkl').mint,
      ),
    ).toEqual({ status: 'refused', reason: 'authority' });
  });

  it('refuses an sso token when the provider anchor was rebound', async () => {
    await executor.all({
      sql: "UPDATE identity_provider_binding SET anchor = 'anchor-2' WHERE org_id = ?",
      params: [a.orgId],
    });

    expect(
      await repository.issuePersonal(
        a,
        fence(USER, SSO_SESSION),
        ssoInput(),
        minter('abcdefghijkl').mint,
      ),
    ).toEqual({ status: 'refused', reason: 'authority' });
  });

  it('refuses an sso token when no configured anchor is supplied', async () => {
    expect(
      await repository.issuePersonal(
        a,
        fence(USER, SSO_SESSION),
        baseInput({ validation: { kind: 'sso', identityId: IDENTITY }, providerAnchors: [] }),
        minter('abcdefghijkl').mint,
      ),
    ).toEqual({ status: 'refused', reason: 'authority' });
  });
});

describe('round 6 hardening', () => {
  const ssoFence = () => fence(USER, SSO_SESSION);
  const ssoInput = (overrides: Record<string, unknown> = {}) =>
    baseInput({ validation: { kind: 'sso', identityId: IDENTITY }, ...overrides });
  const alwaysTrue = () => assertGuard(sql<boolean>`1`, a);

  it('refuses a future-dated sso validated_at and a future-dated local login', async () => {
    await executor.all({
      sql: 'UPDATE identity SET validated_at = ? WHERE id = ?',
      params: [iso(3_600_000), IDENTITY],
    });
    expect(
      await repository.issuePersonal(a, ssoFence(), ssoInput(), minter('abcdefghijkl').mint),
    ).toEqual({ status: 'refused', reason: 'authority' });

    await executor.all({
      sql: 'UPDATE local_login SET last_login_at = ? WHERE user_id = ?',
      params: [iso(3_600_000), USER],
    });
    expect(
      await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint),
    ).toEqual({ status: 'refused', reason: 'authority' });
  });

  it('rejects malformed provider anchors before SQL', async () => {
    await expect(
      repository.issuePersonal(
        a,
        fence(),
        baseInput({
          providerAnchors: [
            {
              provider: '',
              anchor: '',
              emailAuthoritative: true,
              emailAuthoritativeDomains: ['example.test'],
            },
          ],
        }),
        minter('abcdefghijkl').mint,
      ),
    ).rejects.toThrow(TypeError);
  });

  it('counts a project where the issuer can write but not read in an all-project token', async () => {
    await executor.batch([
      insert(
        "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('01J0ROLE000000000000000009', ?, 'wonly', 'Write only', 'project', 0)",
        a.orgId,
      ),
      insert(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, '01J0ROLE000000000000000009', 'project:packages:write')",
        a.orgId,
      ),
    ]);
    const ids = await addProjects(a, 1);
    await projectGrants(ids, '01J0ROLE000000000000000009');
    await executor.all({
      sql: "UPDATE project SET token_max_scope = 'read' WHERE id = ?",
      params: [ids[0] as string],
    });
    const { mint } = minter('abcdefghijkl');

    for (const scope of ['write', 'read'] as const) {
      expect(await repository.issuePersonal(a, ssoFence(), ssoInput({ scope }), mint)).toEqual({
        status: 'refused',
        reason: 'authority',
      });
    }
  });

  it('refuses a revoke from a dead session even when the caller guard passes', async () => {
    await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint);
    await executor.all({
      sql: "UPDATE session SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      params: [SESSION],
    });
    const result = await repository.revoke(a, fence(), alwaysTrue(), {
      audit: mutationAudit('token.revoke'),
      tokenId: TOKEN,
      now: iso(0),
    });

    expect(result).toEqual({ status: 'refused', reason: 'authority' });
    expect(
      (await one<{ revoked_at: string | null }>('SELECT revoked_at FROM token WHERE id = ?', TOKEN))
        ?.revoked_at,
    ).toBeNull();
  });

  it('does not bump the cache epoch for an already revoked or an unknown token', async () => {
    await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint);
    expect(
      (
        await repository.revoke(a, fence(), alwaysTrue(), {
          audit: mutationAudit('token.revoke'),
          tokenId: TOKEN,
          now: iso(0),
        })
      ).status,
    ).toBe('revoked');
    const before = await epoch();

    expect(
      await repository.revoke(a, fence(), alwaysTrue(), {
        audit: mutationAudit('token.revoke'),
        tokenId: TOKEN,
        now: iso(0),
      }),
    ).toEqual({
      status: 'already_revoked',
    });
    expect(
      await repository.revoke(a, fence(), alwaysTrue(), {
        audit: mutationAudit('token.revoke'),
        tokenId: '01J0TOKENMISSING00000000000',
        now: iso(0),
      }),
    ).toEqual({ status: 'not_found' });
    expect(await epoch()).toBe(before);
  });
});

describe('bound parameter budget', () => {
  const MANY = Array.from({ length: 8 }, (_, index) => ({
    provider: `idp${index}`,
    anchor: `anchor-${index}`,
    emailAuthoritative: index % 2 === 0,
    emailAuthoritativeDomains: ['example.test'],
  }));

  function recorder() {
    const seen: Statement[] = [];
    const spy: SqlExecutor = {
      ...executor,
      driver: executor.driver,
      all: executor.all.bind(executor),
      batch: (statements) => {
        seen.push(...statements);
        return executor.batch(statements);
      },
    };
    return { spy, seen };
  }

  let captures = 0;

  async function capture(overrides: Record<string, unknown>) {
    const { spy, seen } = recorder();
    const ids = await addProjects(a, 3, String.fromCharCode(71 + captures));
    captures += 1;
    const sso = overrides.validation !== undefined;
    await createTokenRepository(spy).issuePersonal(
      a,
      fence(USER, sso ? SSO_SESSION : SESSION),
      baseInput({
        providerAnchors: MANY,
        projectIds: overrides.projectMode === 'selected' ? ids : [],
        ...overrides,
      }),
      minter('abcdefghijkl').mint,
    );
    return seen;
  }

  const sso = { validation: { kind: 'sso', identityId: IDENTITY } };

  it('keeps every statement that does not use the shared permission builders at 100 or fewer', async () => {
    for (const overrides of [{}, sso, { projectMode: 'selected' }]) {
      const seen = await capture(overrides);
      const own = seen.filter((statement) => !/hp_|json_extract/.test(statement.sql));
      expect(own.length).toBeGreaterThan(0);
      for (const statement of own) expect(statement.params.length).toBeLessThanOrEqual(100);
    }
  });

  it('keeps every issuance statement at 100 or fewer', async () => {
    for (const overrides of [{}, sso, { projectMode: 'selected', ...sso }]) {
      for (const statement of await capture(overrides)) {
        expect(statement.params.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it('keeps the revoke batch at 100 or fewer', async () => {
    await repository.issuePersonal(a, fence(), baseInput(), minter('abcdefghijkl').mint);
    const { spy, seen } = recorder();
    await createTokenRepository(spy).revoke(a, fence(), assertGuard(sql<boolean>`1`, a), {
      audit: mutationAudit('token.revoke'),
      tokenId: TOKEN,
      now: iso(0),
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const statement of seen) expect(statement.params.length).toBeLessThanOrEqual(100);
  });
});

function mutationAudit(action: AuditAction = 'token.issue', target = TOKEN) {
  const result = auditEvent({
    id: ulid(),
    now: iso(0),
    action,
    actor: { type: 'user', id: USER },
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    target: { type: 'token', id: target },
  });
  if (!result.ok) throw new Error('Invalid test audit');
  return result.event;
}

function mutationIdempotency(key = 'issue'): IdempotencyRecord {
  return {
    principalKey: USER,
    key,
    route: 'POST /tokens',
    requestHash: 'a'.repeat(64),
    status: 201,
    responseJson: JSON.stringify({ code: 'already_issued', id: TOKEN }),
    createdAt: iso(0),
    expiresAt: iso(86_400_000),
  };
}

async function stagedCounts() {
  return Promise.all(
    ['token', 'audit_pending', 'api_idempotency'].map(
      async (table) => (await one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n,
    ),
  );
}

async function serviceAuditInput(): Promise<IssueServiceTokenInput> {
  await executor.batch([
    insert(
      "INSERT INTO service_principal (id, org_id, name, created_by_user_id, created_at, updated_at) VALUES ('audit-principal', ?, 'ci', ?, ?, ?)",
      a.orgId,
      USER,
      iso(0),
      iso(0),
    ),
  ]);
  await executor.batch([
    insert(
      "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, 'audit-principal', 'project:packages:read')",
      a.orgId,
    ),
    insert(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, 'org:service-principals:write')",
      a.orgId,
      ADMIN_ROLE,
    ),
  ]);
  return {
    id: TOKEN,
    name: 'ci',
    servicePrincipalId: 'audit-principal',
    projectId: null,
    principalRevision: 1,
    scope: 'read',
    readOnly: true,
    expiresAt: iso(86_400_000),
    now: iso(0),
    authority: {
      permission: 'org:service-principals:write',
      organizationAdmin: true,
      covers: ['project:packages:read'],
    },
    providerAnchors: ANCHORS,
    audit: mutationAudit(),
    idempotency: mutationIdempotency(),
  };
}

function serviceAuditMinter(...selectors: string[]) {
  const source = minter(...selectors);
  return {
    calls: source.calls,
    mint: () => {
      const minted = source.mint();
      return { ...minted, plaintext: minted.plaintext.replace('pb_pat_', 'pb_svc_') };
    },
  };
}

describe('atomic token audit', () => {
  it.each(['personal', 'service', 'revoke'] as const)(
    'stages exactly one event for %s',
    async (kind) => {
      const audit = mutationAudit(kind === 'revoke' ? 'token.revoke' : 'token.issue');
      if (kind === 'service') {
        const input = { ...(await serviceAuditInput()), audit };
        expect(
          (
            await repository.issueService(
              a,
              fence(),
              input,
              serviceAuditMinter('aaaaaaaaaaaa').mint,
            )
          ).status,
        ).toBe('issued');
      } else {
        expect(
          (
            await repository.issuePersonal(
              a,
              fence(),
              baseInput({ audit: mutationAudit() }),
              minter('aaaaaaaaaaaa').mint,
            )
          ).status,
        ).toBe('issued');
        await executor.batch([insert('DELETE FROM audit_pending')]);
        if (kind === 'revoke') {
          expect(
            (
              await repository.revoke(a, fence(), liveSession(), {
                tokenId: TOKEN,
                now: iso(0),
                audit,
              })
            ).status,
          ).toBe('revoked');
        } else {
          await executor.batch([insert('DELETE FROM token')]);
          expect(
            (
              await repository.issuePersonal(
                a,
                fence(),
                baseInput({ audit }),
                minter('bbbbbbbbbbbb').mint,
              )
            ).status,
          ).toBe('issued');
        }
      }
      expect(
        await executor.all({
          sql: 'SELECT action, target_type, target_id FROM audit_pending',
          params: [],
        }),
      ).toEqual([{ action: audit.action, target_type: audit.target.type, target_id: TOKEN }]);
    },
  );

  it('stages nothing for a second revoke', async () => {
    await repository.issuePersonal(
      a,
      fence(),
      baseInput({ audit: mutationAudit() }),
      minter('aaaaaaaaaaaa').mint,
    );
    await repository.revoke(a, fence(), liveSession(), {
      tokenId: TOKEN,
      now: iso(0),
      audit: mutationAudit('token.revoke'),
      idempotency: mutationIdempotency('first'),
    });
    const before = await stagedCounts();
    expect(
      await repository.revoke(a, fence(), liveSession(), {
        tokenId: TOKEN,
        now: iso(0),
        audit: mutationAudit('token.revoke'),
        idempotency: mutationIdempotency('second'),
      }),
    ).toEqual({ status: 'already_revoked' });
    expect(await stagedCounts()).toEqual(before);
  });

  it('stages nothing for an absent token', async () => {
    expect(
      await repository.revoke(a, fence(), liveSession(), {
        tokenId: TOKEN,
        now: iso(0),
        audit: mutationAudit('token.revoke'),
        idempotency: mutationIdempotency(),
      }),
    ).toEqual({ status: 'not_found' });
    expect(await stagedCounts()).toEqual([0, 0, 0]);
  });

  it('stages nothing for a foreign token', async () => {
    await repository.issuePersonal(
      a,
      fence(),
      baseInput({ audit: mutationAudit() }),
      minter('aaaaaaaaaaaa').mint,
    );
    await executor.batch([insert('DELETE FROM audit_pending')]);
    expect(
      (
        await repository.revoke(b, fence(), assertGuard(sql<boolean>`1`, b), {
          tokenId: TOKEN,
          now: iso(0),
          audit: mutationAudit('token.revoke'),
          idempotency: mutationIdempotency(),
        })
      ).status,
    ).not.toBe('revoked');
    expect(await stagedCounts()).toEqual([1, 0, 0]);
  });

  it.each([
    ['stale session', "UPDATE session SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?"],
    ['missing permission', 'DELETE FROM role_permission WHERE role_id = ?'],
    ['expired reauth', "UPDATE session SET reauth_at = '2020-01-01T00:00:00.000Z' WHERE id = ?"],
  ])('rolls back all rows for %s', async (name, statement) => {
    const projects = await addProjects(a, 1);
    await executor.batch([insert(statement, name === 'missing permission' ? ADMIN_ROLE : SESSION)]);
    const result = await repository.issuePersonal(
      a,
      fence(),
      baseInput({
        projectMode: 'selected',
        projectIds: projects,
        audit: mutationAudit(),
        idempotency: mutationIdempotency(),
      }),
      minter('aaaaaaaaaaaa').mint,
    );
    expect(result).toEqual({ status: 'refused', reason: 'authority' });
    expect(await stagedCounts()).toEqual([0, 0, 0]);
  });

  it.each(['personal', 'service'] as const)(
    'stages only the committed %s collision attempt',
    async (kind) => {
      await repository.issuePersonal(
        a,
        fence(),
        baseInput({ id: 'occupied', audit: mutationAudit() }),
        minter('aaaaaaaaaaaa').mint,
      );
      await executor.batch([insert('DELETE FROM audit_pending')]);
      const minted =
        kind === 'personal'
          ? minter('aaaaaaaaaaaa', 'bbbbbbbbbbbb')
          : serviceAuditMinter('aaaaaaaaaaaa', 'bbbbbbbbbbbb');
      const result =
        kind === 'personal'
          ? await repository.issuePersonal(
              a,
              fence(),
              baseInput({ audit: mutationAudit(), idempotency: mutationIdempotency() }),
              minted.mint,
            )
          : await repository.issueService(a, fence(), await serviceAuditInput(), minted.mint);
      expect(result.status).toBe('issued');
      expect(minted.calls()).toBe(2);
      expect(await stagedCounts()).toEqual([2, 1, 1]);
    },
  );

  it('stores the supplied service replay response without plaintext', async () => {
    const input = await serviceAuditInput();
    const minted = serviceAuditMinter('aaaaaaaaaaaa');
    const result = await repository.issueService(a, fence(), input, minted.mint);
    expect(result.status).toBe('issued');
    if (result.status !== 'issued') throw new Error('Issue failed');
    const row = await one<{ response_json: string }>('SELECT * FROM api_idempotency');
    expect(JSON.parse(row?.response_json ?? 'null')).toEqual({ code: 'already_issued', id: TOKEN });
    expect(JSON.stringify(row).includes(result.plaintext)).toBe(false);
  });

  it.each(['personal', 'service'] as const)(
    'does not retry a %s idempotency unique-key failure even with a colliding selector',
    async (kind) => {
      const input =
        kind === 'service'
          ? await serviceAuditInput()
          : baseInput({ audit: mutationAudit(), idempotency: mutationIdempotency() });
      await repository.issuePersonal(
        a,
        fence(),
        baseInput({ id: 'occupied', audit: mutationAudit() }),
        minter('aaaaaaaaaaaa').mint,
      );
      await executor.batch([
        insert('DELETE FROM audit_pending'),
        insert(
          "INSERT INTO api_idempotency (org_id, principal_key, key, route, request_hash, status, response_json, created_at, expires_at) VALUES (?, ?, 'issue', 'POST /tokens', ?, 201, '{}', ?, ?)",
          a.orgId,
          USER,
          'a'.repeat(64),
          iso(0),
          iso(86_400_000),
        ),
      ]);
      const minted =
        kind === 'personal'
          ? minter('bbbbbbbbbbbb', 'aaaaaaaaaaaa')
          : serviceAuditMinter('bbbbbbbbbbbb', 'aaaaaaaaaaaa');
      // The selector becomes occupied before the failure probes, after the idempotency failure.
      const wrapped: SqlExecutor = {
        driver: executor.driver,
        all: (statement) => executor.all(statement),
        async batch(statements) {
          try {
            return await executor.batch(statements);
          } catch (error) {
            await executor.batch([
              insert("UPDATE token SET selector = 'bbbbbbbbbbbb' WHERE id = 'occupied'"),
            ]);
            throw error;
          }
        },
      };
      const tokens = createTokenRepository(wrapped);
      const result =
        kind === 'personal'
          ? await tokens.issuePersonal(
              a,
              fence(),
              input as ReturnType<typeof baseInput>,
              minted.mint,
            )
          : await tokens.issueService(a, fence(), input as IssueServiceTokenInput, minted.mint);
      expect(result.status).not.toBe('issued');
      expect(minted.calls()).toBe(1);
      expect(await stagedCounts()).toEqual([1, 0, 1]);
      expect(await one('SELECT id FROM token WHERE id = ?', TOKEN)).toBeUndefined();
    },
  );

  it('measures the issue batch with 200 projects, audit and idempotency', async () => {
    const projects = await addProjects(a, 200);
    let count = 0;
    const measured: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch(statements) {
        count = statements.length;
        return executor.batch(statements);
      },
    };
    expect(
      (
        await createTokenRepository(measured).issuePersonal(
          a,
          fence(),
          baseInput({
            projectMode: 'selected',
            projectIds: projects,
            audit: mutationAudit(),
            idempotency: mutationIdempotency(),
          }),
          minter('aaaaaaaaaaaa').mint,
        )
      ).status,
    ).toBe('issued');
    expect(count).toBeLessThanOrEqual(100);
    console.info('T508 maximum-project issue batch statements:', count);
  });
});
