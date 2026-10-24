import { auditEvent, type AuditAction } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import { readdirSync, readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DefaultRoleKey } from '@package-broker/core/authz/permissions';
import type { CredentialRecord } from '@package-broker/core/db/credentials';
import type { LocalLoginSnapshot } from '@package-broker/core/db/local-login';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { NewSession } from '@package-broker/core/db/sessions';
import type { LoginPlan } from '@package-broker/core/db/users';
import { classifySqliteError } from '@package-broker/core/db/errors';
import type { GrantRepository } from '@package-broker/core/db/grants';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { credentialAad } from '@package-broker/core/secrets/cipher';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { bootstrapAdmin, resetLocalLogin } from '../repositories/admin-bootstrap.js';
import { createGrantRepository, type ProtectedHolderInput } from '../repositories/grant.js';
import { createLocalLoginReader } from '../repositories/local-login.js';
import { createLocalLoginSetupWriter } from '../repositories/local-login-setup.js';
import { createLocalLoginSuccessWriter } from '../repositories/local-login-success.js';
import { createLoginWriter } from '../repositories/login.js';
import { createSessionRepository } from '../repositories/session.js';
import { seedDefaultsStatements } from '../repositories/role.js';
import { assertGuard, newOpId } from '../kysely.js';
import { seedTwoOrganizations } from './two-organizations.js';

export interface OpenedAuthDatabase {
  readonly executor: SqlExecutor;
  second(): Promise<SqlExecutor>;
  close(): Promise<void>;
}

type Open = () => Promise<OpenedAuthDatabase>;
type Wrap = (executor: SqlExecutor) => SqlExecutor;
type Case = (open: Open, wrap?: Wrap) => Promise<void>;

const RUNS = 20;
const INDETERMINATE_ATTEMPTS = 3;
const NOW = '2026-10-15T12:00:00.000Z';
const LATER = '2026-10-15T12:05:00.000Z';
const LOCK_UNTIL = '2026-10-15T12:15:00.000Z';
const PAST = '2026-10-15T11:00:00.000Z';
const FUTURE = '2026-10-15T20:00:00.000Z';
const SETUP_EXPIRES = '2026-10-16T12:00:00.000Z';

const STEP = 57_000_002;
const LAST_STEP = 57_000_001;
const PASSWORD_HASH = 'pbkdf2-sha256$i=100000$v=1$c2FsdA$aGFzaA';
const SETUP_HASH = 'ab'.repeat(32);
const RESET_HASH = 'c3'.repeat(32);
const EMAIL = 'admin@example.test';
const PROVIDER = 'dex';
const ANCHOR = 'oidc:https://dex.example.test';
const SUBJECT = 'sub-1';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulidOf(n: number): string {
  let rest = n;
  let body = '';
  while (rest > 0) {
    body = CROCKFORD.charAt(rest % 32) + body;
    rest = Math.floor(rest / 32);
  }
  return `01J0${body.padStart(22, '0')}`;
}

let minted = 0;
function mint(): string {
  minted += 1;
  return ulidOf(minted);
}

const OP_RESET = 1000;
const OP_RESET_RACE = 2000;
const OP_BOOTSTRAP = 5000;

const ADMIN = mint();
const USER_X = mint();
const U1 = mint();
const U2 = mint();
const U3 = mint();
const BOOT_USER = mint();
const CREDENTIAL = mint();
const NEW_CREDENTIAL = mint();
const OLD_SESSION = mint();
const NEW_SESSION = mint();
const OTHER_SESSION = mint();
const IDENTITY_X = mint();
const IDENTITY_Y = mint();
const IDENTITY_Z = mint();
const IDENTITY_LINKED = mint();
const G1 = mint();
const G2 = mint();
const GROUP_GRANT = mint();
const GROUP_GRANT_2 = mint();
const ADMIN_GRANT = mint();
const RESET_GRANT = mint();
const BOOT_GRANT = mint();

const ROLE_IDS: Readonly<Record<DefaultRoleKey, string>> = {
  organization_admin: mint(),
  organization_auditor: mint(),
  project_owner: mint(),
  project_developer: mint(),
  project_auditor: mint(),
};

interface World {
  readonly pair: OpenedAuthDatabase;
  readonly a: OrgContext;
  readonly b: OrgContext;
}

function st(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function hash(label: string): string {
  const hex = Array.from(new TextEncoder().encode(label), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return hex.padEnd(64, '0').slice(0, 64);
}

function opOf(base: number, run: number): string {
  return ulidOf(base + run);
}

export function weakenStatements(
  executor: SqlExecutor,
  rewrite: (statement: Statement) => Statement,
): SqlExecutor {
  return {
    driver: executor.driver,
    all: (statement) => executor.all(rewrite(statement)),
    batch: (statements) => executor.batch(statements.map(rewrite)),
  };
}

async function loadSources(): Promise<MigrationSource[]> {
  const directory = new URL('../../migrations/', import.meta.url);
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return Promise.all(
    names.map((name) =>
      loadMigrationSource('core', name, readFileSync(new URL(name, directory), 'utf8')),
    ),
  );
}

async function withDatabase(
  open: Open,
  body: (pair: OpenedAuthDatabase) => Promise<void>,
): Promise<void> {
  const pair = await open();
  try {
    await body(pair);
  } finally {
    await pair.close();
  }
}

async function withWorld(open: Open, body: (world: World) => Promise<void>): Promise<void> {
  await withDatabase(open, async (pair) => {
    await migrate(pair.executor, await loadSources(), { holder: 'auth-contract' });
    const { a, b } = await seedTwoOrganizations(pair.executor);
    await pair.executor.batch(seedDefaultsStatements(a, { now: NOW, ids: ROLE_IDS }));
    await body({ pair, a, b });
  });
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

function arrivals(count: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === count) release();
    await ready;
  };
}

function gated(
  executor: SqlExecutor,
  arrive: () => Promise<void>,
  on: 'all' | 'batch' = 'batch',
): SqlExecutor {
  let waited = false;
  const once = async (): Promise<void> => {
    if (waited) return;
    waited = true;
    await arrive();
  };
  return {
    driver: executor.driver,
    all: async (statement) => {
      if (on === 'all') await once();
      return executor.all(statement);
    },
    batch: async (statements) => {
      if (on === 'batch') await once();
      return executor.batch(statements);
    },
  };
}

function gatedPair(first: SqlExecutor, second: SqlExecutor): [SqlExecutor, SqlExecutor] {
  const arrive = arrivals(2);
  return [gated(first, arrive), gated(second, arrive)];
}

async function clearWorld({ pair, a }: World): Promise<void> {
  await pair.executor.batch(
    [
      'audit_pending',
      'session',
      'user_group',
      'identity',
      'identity_provider_binding',
      'local_login',
      'credential',
      'access_grant',
      'user_account',
    ].map((table) => st(`DELETE FROM ${table} WHERE org_id = ?`, a.orgId)),
  );
}

const HOLDER_PROVIDER = 'oidc';

function currentHolderInput(): ProtectedHolderInput {
  return {
    kind: 'fresh',
    now: new Date().toISOString(),
    providers: [
      {
        provider: HOLDER_PROVIDER,
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test', 'actor.test'],
      },
    ],
    exclude: { identityId: ACTOR_IDENTITY },
  };
}

const ACTOR_USER = '01J0ACTORUSER00000000000AA';
const ACTOR_IDENTITY = '01J0ACTORIDEN00000000000AA';
const ACTOR_SESSION = '01J0ACTORSESS00000000000AA';
const ACTOR_GRANT = '01J0ACTORGRNT00000000000AA';

function actorRows(a: OrgContext, roleId: string): Statement[] {
  const hash = 'ac'.repeat(32);
  return [
    st(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      ACTOR_USER,
      a.orgId,
      'actor@actor.test',
    ),
    st(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      ACTOR_IDENTITY,
      a.orgId,
      ACTOR_USER,
      HOLDER_PROVIDER,
      'holder-actor',
      'actor@actor.test',
      new Date().toISOString(),
    ),
    emailGrant(a, ACTOR_GRANT, 'actor@actor.test', roleId),
    st(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ACTOR_SESSION,
      a.orgId,
      ACTOR_USER,
      hash,
      hash,
      new Date().toISOString(),
      new Date(Date.now() + 3_600_000).toISOString(),
    ),
  ];
}

function holderEvidence(a: OrgContext, users: readonly (readonly [string, string])[]): Statement[] {
  return [
    st(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      a.orgId,
      HOLDER_PROVIDER,
      ANCHOR,
    ),
    ...users.map(([userId, email], index) =>
      st(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        mint(),
        a.orgId,
        userId,
        HOLDER_PROVIDER,
        `holder-${index}`,
        email,
        new Date().toISOString(),
      ),
    ),
  ];
}

function userRow(a: OrgContext, id: string, email: string, status = 'active'): Statement {
  return st(
    'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
    id,
    a.orgId,
    email,
    status,
  );
}

function emailGrant(a: OrgContext, id: string, email: string, roleId: string): Statement {
  return st(
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, 'email', ?, 'organization', NULL, ?)",
    id,
    a.orgId,
    email,
    roleId,
  );
}

function groupGrant(a: OrgContext, id: string, group: string, roleId: string): Statement {
  return st(
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, 'group', ?, 'oidc', 'organization', NULL, ?)",
    id,
    a.orgId,
    group,
    roleId,
  );
}

function membership(a: OrgContext, userId: string, group: string, provider = 'oidc'): Statement {
  return st(
    'INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, ?, ?)',
    a.orgId,
    userId,
    provider,
    group,
  );
}

function credentialRow(a: OrgContext, id: string): Statement {
  return st(
    "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, ?)",
    id,
    a.orgId,
    credentialAad({ id, orgId: a.orgId, kind: 'totp' }),
  );
}

function sessionRow(
  a: OrgContext,
  id: string,
  userId: string,
  secret = hash('old-session'),
): Statement {
  return st(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    a.orgId,
    userId,
    secret,
    hash('csrf'),
    FUTURE,
  );
}

function enabledLogin(a: OrgContext, userId: string, lastStep: number | null): Statement[] {
  return [
    credentialRow(a, CREDENTIAL),
    st(
      'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, totp_last_step, credential_rev) VALUES (?, ?, ?, ?, ?, ?, 3)',
      userId,
      a.orgId,
      PASSWORD_HASH,
      CREDENTIAL,
      NOW,
      lastStep,
    ),
  ];
}

function adminAccount(a: OrgContext): Statement[] {
  return [userRow(a, ADMIN, EMAIL), emailGrant(a, ADMIN_GRANT, EMAIL, ROLE_IDS.organization_admin)];
}

async function rowsOf<R = Record<string, unknown>>(
  executor: SqlExecutor,
  sql: string,
  ...params: Statement['params'][number][]
): Promise<R[]> {
  return executor.all<R>(st(sql, ...params));
}

async function countOf(executor: SqlExecutor, sql: string, ...params: string[]): Promise<number> {
  const [row] = await rowsOf<{ n: number }>(executor, sql, ...params);
  return row?.n ?? -1;
}

function newSession(id: string, userId = ADMIN, now = NOW): NewSession {
  return {
    id,
    userId,
    identityId: null,
    secretHash: hash(id),
    csrfHash: hash('csrf-new'),
    expiresAt: FUTURE,
    ip: null,
    userAgent: null,
    now,
  };
}

function successInput(snapshot: LocalLoginSnapshot, session: NewSession) {
  return {
    audit: mutationAudit('session.login', session.id),
    snapshot,
    step: STEP,
    rehash: null,
    session,
    previousSecretHash: null,
    reauthSessionId: null,
    now: NOW,
  };
}

async function snapshotOf(executor: SqlExecutor, a: OrgContext): Promise<LocalLoginSnapshot> {
  const found = await createLocalLoginReader(executor).findByEmail(a, EMAIL);
  if (found === null) throw new Error('local login snapshot not found');
  return found;
}

const UPGRADE_PRINCIPAL = '01J0000000000000000000SVCP';
const UPGRADE_PAT = '01J00000000000000000000PAT';
const UPGRADE_SVC = '01J00000000000000000000SVC';

const upgrade: Case = async (open) => {
  await withDatabase(open, async ({ executor }) => {
    const [init] = await loadSources();
    if (init === undefined) throw new Error('core baseline expected');
    await migrate(executor, [init], { holder: 'auth-contract' });
    const org = '01J00000000000000000000A0A';
    await executor.batch([
      st('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', org, 'acme', 'Acme'),
      st('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', ADMIN, org, EMAIL),
      st(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        U2,
        org,
        'u2@example.test',
      ),
      st(
        "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'organization_admin', 'Admin', 'organization', 1)",
        ROLE_IDS.organization_admin,
        org,
      ),
      st(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', ?)",
        ADMIN_GRANT,
        org,
        EMAIL,
        ROLE_IDS.organization_admin,
      ),
      st(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
        CREDENTIAL,
        org,
      ),
      st(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES (?, ?, ?, 'dex', 'sub-1', ?)",
        IDENTITY_X,
        org,
        ADMIN,
        EMAIL,
      ),
      st(
        'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        OLD_SESSION,
        org,
        ADMIN,
        IDENTITY_X,
        hash('old-session'),
        hash('csrf'),
        FUTURE,
      ),
      st(
        'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
        UPGRADE_PRINCIPAL,
        org,
        'ci',
        ADMIN,
      ),
      st(
        "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at) VALUES (?, ?, 'pat', 'patselector1', ?, 1, 'pat', '[]', ?, ?)",
        UPGRADE_PAT,
        org,
        hash('pat'),
        ADMIN,
        FUTURE,
      ),
      st(
        "INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, service_principal_id, expires_at) VALUES (?, ?, 'svc', 'svcselector1', ?, 1, 'svc', '[]', ?, ?)",
        UPGRADE_SVC,
        org,
        hash('svc'),
        UPGRADE_PRINCIPAL,
        FUTURE,
      ),
    ]);
    const queries = [
      'SELECT id, slug, name FROM organization ORDER BY id',
      'SELECT id, org_id, email, status FROM user_account ORDER BY id',
      'SELECT id, key, scope, protects_last_holder FROM role ORDER BY id',
      'SELECT id, subject_type, subject_value, role_id FROM access_grant ORDER BY id',
      'SELECT id, kind, key_version, aad FROM credential ORDER BY id',
      'SELECT id, user_id, provider, subject, email FROM identity ORDER BY id',
      'SELECT id, user_id, identity_id, secret_hash, revoked_at FROM session ORDER BY id',
    ];
    const read = async () => Promise.all(queries.map((sql) => rowsOf(executor, sql)));
    const before = await read();
    expect(before.every((rows) => rows.length > 0)).toBe(true);

    const result = await migrate(executor, [init], { holder: 'auth-contract' });

    expect(result.applied).toEqual([]);
    expect(await read()).toEqual(before);
    expect(
      await countOf(
        executor,
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      ),
    ).toBe(55);
    expect(
      await rowsOf(
        executor,
        'SELECT id, project_mode, validation_kind, validation_identity_id FROM token ORDER BY id',
      ),
    ).toEqual(
      [UPGRADE_PAT, UPGRADE_SVC].sort().map((id) => ({
        id,
        project_mode: 'selected',
        validation_kind: null,
        validation_identity_id: null,
      })),
    );
    expect(await countOf(executor, 'SELECT count(*) AS n FROM service_principal_permission')).toBe(
      0,
    );
    expect(await rowsOf(executor, 'SELECT validated_at FROM identity')).toEqual([
      { validated_at: null },
    ]);
    expect(await rowsOf(executor, 'SELECT user_id FROM local_login')).toEqual([]);
    await executor.batch([
      st(
        'INSERT INTO local_login (user_id, org_id, totp_credential_id, totp_enabled_at) VALUES (?, ?, ?, ?)',
        ADMIN,
        org,
        CREDENTIAL,
        NOW,
      ),
    ]);
    expect(await countOf(executor, 'SELECT count(*) AS n FROM local_login')).toBe(1);
  });
};

const resetCleanup: Case = async (open) => {
  await withWorld(open, async ({ pair, a }) => {
    const { executor } = pair;
    await executor.batch([
      ...adminAccount(a),
      ...enabledLogin(a, ADMIN, LAST_STEP),
      sessionRow(a, OLD_SESSION, ADMIN),
    ]);

    const outcome = await resetLocalLogin(executor, a, {
      email: EMAIL,
      setupHash: RESET_HASH,
      setupExpiresAt: SETUP_EXPIRES,
      grantId: RESET_GRANT,
      roleIds: ROLE_IDS,
      opId: opOf(OP_RESET, 1),
      now: LATER,
    });

    expect(outcome).toBe('reset');
    expect(await rowsOf(executor, 'SELECT id FROM credential')).toEqual([]);
    expect(
      await rowsOf(
        executor,
        'SELECT password_hash, totp_credential_id, totp_enabled_at, totp_last_step, credential_rev, setup_hash FROM local_login',
      ),
    ).toEqual([
      {
        password_hash: null,
        totp_credential_id: null,
        totp_enabled_at: null,
        totp_last_step: null,
        credential_rev: 4,
        setup_hash: RESET_HASH,
      },
    ]);
    expect(await rowsOf(executor, 'SELECT revoked_at FROM session')).toEqual([
      { revoked_at: LATER },
    ]);
  });
};

const totpReplay: Case = async (open, wrap = (executor) => executor) => {
  await withWorld(open, async (world) => {
    const { pair, a } = world;
    const other = await pair.second();
    for (let run = 0; run < RUNS; run += 1) {
      await clearWorld(world);
      await pair.executor.batch([...adminAccount(a), ...enabledLogin(a, ADMIN, LAST_STEP)]);
      const snapshot = await snapshotOf(pair.executor, a);
      const [first, second] = gatedPair(pair.executor, other);
      const writers = [
        createLocalLoginSuccessWriter(wrap(first)),
        createLocalLoginSuccessWriter(wrap(second)),
      ] as const;

      const results = await race(
        run,
        () => writers[0].succeed(a, successInput(snapshot, newSession(NEW_SESSION))),
        () => writers[1].succeed(a, successInput(snapshot, newSession(OTHER_SESSION))),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await countOf(pair.executor, 'SELECT count(*) AS n FROM session')).toBe(1);
      expect(
        await countOf(
          pair.executor,
          'SELECT count(*) AS n FROM audit_pending WHERE org_id = ?',
          a.orgId,
        ),
      ).toBe(1);
      expect(
        await rowsOf(pair.executor, 'SELECT totp_last_step, failed_count FROM local_login'),
      ).toEqual([{ totp_last_step: STEP, failed_count: 0 }]);
    }
  });
};

const localReauthForeignSession: Case = async (open, wrap = (executor) => executor) => {
  await withWorld(open, async (world) => {
    const { pair, a, b } = world;
    await pair.executor.batch([
      ...adminAccount(a),
      ...enabledLogin(a, ADMIN, LAST_STEP),
      userRow(b, U2, 'foreign@example.test'),
      sessionRow(b, OTHER_SESSION, U2),
    ]);
    const snapshot = await snapshotOf(pair.executor, a);
    const input = {
      ...successInput(snapshot, newSession(NEW_SESSION)),
      audit: mutationAudit('session.reauth', OTHER_SESSION),
      session: null,
      reauthSessionId: OTHER_SESSION,
    };
    expect(await createLocalLoginSuccessWriter(wrap(pair.executor)).succeed(a, input)).toBe(false);
    expect(
      await countOf(
        pair.executor,
        'SELECT count(*) AS n FROM audit_pending WHERE org_id = ?',
        a.orgId,
      ),
    ).toBe(0);
    expect(
      await rowsOf(
        pair.executor,
        'SELECT totp_last_step FROM local_login WHERE org_id = ?',
        a.orgId,
      ),
    ).toEqual([{ totp_last_step: LAST_STEP }]);
    expect(
      await rowsOf(
        pair.executor,
        'SELECT reauth_at FROM session WHERE org_id = ? AND id = ?',
        b.orgId,
        OTHER_SESSION,
      ),
    ).toEqual([{ reauth_at: null }]);
  });
};

const resetRace: Case = async (open, wrap = (executor) => executor) => {
  await withWorld(open, async (world) => {
    const { pair, a } = world;
    const other = await pair.second();
    for (let run = 0; run < RUNS; run += 1) {
      await clearWorld(world);
      await pair.executor.batch([
        ...adminAccount(a),
        ...enabledLogin(a, ADMIN, LAST_STEP),
        sessionRow(a, OLD_SESSION, ADMIN),
      ]);
      const snapshot = await snapshotOf(pair.executor, a);
      const reset = (executor: SqlExecutor) =>
        resetLocalLogin(executor, a, {
          email: EMAIL,
          setupHash: RESET_HASH,
          setupExpiresAt: SETUP_EXPIRES,
          grantId: RESET_GRANT,
          roleIds: ROLE_IDS,
          opId: opOf(OP_RESET_RACE, run),
          now: LATER,
        });
      const succeed = (executor: SqlExecutor) =>
        createLocalLoginSuccessWriter(wrap(executor)).succeed(
          a,
          successInput(snapshot, newSession(NEW_SESSION)),
        );

      let succeeded: boolean;
      if (run % 2 === 0) {
        expect(await reset(pair.executor)).toBe('reset');
        succeeded = await succeed(other);
        expect(succeeded, 'success after reset').toBe(false);
      } else {
        const [first, second] = gatedPair(pair.executor, other);
        const [outcome, result] = await race(
          run,
          () => reset(first),
          () => succeed(second),
        );
        expect(outcome).toBe('reset');
        succeeded = result;
      }

      expect(
        await countOf(pair.executor, 'SELECT count(*) AS n FROM session WHERE id = ?', NEW_SESSION),
        'success result matches the session rows',
      ).toBe(succeeded ? 1 : 0);
      expect(
        await countOf(pair.executor, 'SELECT count(*) AS n FROM session WHERE revoked_at IS NULL'),
      ).toBe(0);
      expect(
        await rowsOf(
          pair.executor,
          'SELECT password_hash, totp_credential_id, totp_enabled_at, credential_rev FROM local_login',
        ),
      ).toEqual([
        { password_hash: null, totp_credential_id: null, totp_enabled_at: null, credential_rev: 4 },
      ]);
    }
  });
};

const setupRestage: Case = async (open, wrap = (executor) => executor) => {
  await withWorld(open, async (world) => {
    const { pair, a } = world;
    const other = await pair.second();
    const staged = (id: string): CredentialRecord & { readonly now: string } => ({
      id,
      projectId: null,
      kind: 'totp',
      sealed: {
        ciphertext: Uint8Array.from({ length: 33 }, (_, index) => (id.length + index) % 256),
        nonce: Uint8Array.from({ length: 12 }, (_, index) => (index * 5 + 1) % 256),
        keyVersion: 1,
      },
      aad: credentialAad({ id, orgId: a.orgId, kind: 'totp' }),
      rotatedAt: null,
      now: NOW,
    });
    for (let run = 0; run < RUNS; run += 1) {
      await clearWorld(world);
      await pair.executor.batch([
        ...adminAccount(a),
        credentialRow(a, CREDENTIAL),
        st(
          'INSERT INTO local_login (user_id, org_id, totp_credential_id, setup_hash, setup_expires_at, credential_rev) VALUES (?, ?, ?, ?, ?, 3)',
          ADMIN,
          a.orgId,
          CREDENTIAL,
          SETUP_HASH,
          SETUP_EXPIRES,
        ),
        sessionRow(a, OLD_SESSION, ADMIN),
      ]);
      const [first, second] = gatedPair(pair.executor, other);
      const completing = createLocalLoginSetupWriter(wrap(first));
      const restaging = createLocalLoginSetupWriter(wrap(second));

      const [completed, restaged] = await race(
        run,
        () =>
          completing.completeSetup(a, {
            userId: ADMIN,
            setupHash: SETUP_HASH,
            expectedCredentialId: CREDENTIAL,
            credentialRev: 3,
            passwordHash: PASSWORD_HASH,
            step: STEP,
            session: newSession(NEW_SESSION, ADMIN, LATER),
            previousSecretHash: hash('old-session'),
            now: LATER,
          }),
        () =>
          restaging.stagePendingTotp(a, {
            userId: ADMIN,
            setupHash: SETUP_HASH,
            credential: staged(NEW_CREDENTIAL),
            now: NOW,
          }),
      );

      expect([completed, restaged].filter(Boolean)).toHaveLength(1);
      const [login] = await rowsOf<{
        password_hash: string | null;
        totp_credential_id: string | null;
        totp_enabled_at: string | null;
      }>(
        pair.executor,
        'SELECT password_hash, totp_credential_id, totp_enabled_at FROM local_login',
      );
      const credentials = await rowsOf(pair.executor, 'SELECT id FROM credential');
      const sessions = await rowsOf(
        pair.executor,
        'SELECT id, revoked_at FROM session ORDER BY id',
      );
      if (completed) {
        expect(login).toEqual({
          password_hash: PASSWORD_HASH,
          totp_credential_id: CREDENTIAL,
          totp_enabled_at: LATER,
        });
        expect(credentials).toEqual([{ id: CREDENTIAL }]);
        expect(sessions).toEqual(
          [
            { id: NEW_SESSION, revoked_at: null },
            { id: OLD_SESSION, revoked_at: LATER },
          ].sort((left, right) => (left.id < right.id ? -1 : 1)),
        );
      } else {
        expect(login).toEqual({
          password_hash: null,
          totp_credential_id: NEW_CREDENTIAL,
          totp_enabled_at: null,
        });
        expect(credentials).toEqual([{ id: NEW_CREDENTIAL }]);
        expect(sessions).toEqual([{ id: OLD_SESSION, revoked_at: null }]);
      }
    }
  });
};

const bootstrapPromotion: Case = async (open) => {
  await withWorld(open, async ({ pair, a }) => {
    const { executor } = pair;
    await executor.batch([
      userRow(a, ADMIN, EMAIL),
      emailGrant(a, ADMIN_GRANT, EMAIL, ROLE_IDS.organization_auditor),
    ]);

    const outcome = await bootstrapAdmin(executor, a, {
      email: EMAIL,
      userId: BOOT_USER,
      setupHash: SETUP_HASH,
      setupExpiresAt: SETUP_EXPIRES,
      grantId: BOOT_GRANT,
      roleIds: ROLE_IDS,
      opId: opOf(OP_BOOTSTRAP, 1),
      now: NOW,
    });

    expect(outcome).toBe('created');
    expect(
      await rowsOf(
        executor,
        'SELECT id, role_id, scope FROM access_grant WHERE org_id = ?',
        a.orgId,
      ),
    ).toEqual([{ id: ADMIN_GRANT, role_id: ROLE_IDS.organization_admin, scope: 'organization' }]);
    expect(await rowsOf(executor, 'SELECT id FROM user_account')).toEqual([{ id: ADMIN }]);
    expect(await snapshotOf(executor, a)).toMatchObject({
      userId: ADMIN,
      adminEligible: true,
      totpState: 'none',
    });
  });
};

interface GrantOperation {
  readonly kind: 'delete' | 'suspend' | 'demote';
  readonly target: string;
}

const lastAdminRaces: Case = async (open, wrap = (executor) => executor) => {
  const admin = ROLE_IDS.organization_admin;
  const auditor = ROLE_IDS.organization_auditor;
  const del = (target: string): GrantOperation => ({ kind: 'delete', target });
  const suspend = (target: string): GrantOperation => ({ kind: 'suspend', target });
  const demote = (target: string): GrantOperation => ({ kind: 'demote', target });
  await withWorld(open, async (world) => {
    const { pair, a } = world;
    const other = await pair.second();
    const emails = (): Statement[] => [
      emailGrant(a, G1, 'u1@example.test', admin),
      emailGrant(a, G2, 'u2@example.test', admin),
    ];
    const throughGroup = (): Statement[] => [
      emailGrant(a, G1, 'u1@example.test', admin),
      groupGrant(a, GROUP_GRANT, 'admins', admin),
      membership(a, U2, 'admins'),
    ];
    const oneWithTwoGrants = (): Statement[] => [
      emailGrant(a, G1, 'u1@example.test', admin),
      groupGrant(a, GROUP_GRANT, 'admins', admin),
      membership(a, U1, 'admins'),
    ];
    const sharedGroups = (): Statement[] => [
      groupGrant(a, GROUP_GRANT, 'admins', admin),
      groupGrant(a, GROUP_GRANT_2, 'ops', admin),
      membership(a, U1, 'admins'),
      membership(a, U2, 'admins'),
      membership(a, U2, 'ops'),
    ];
    const inTwoGroups = (): Statement[] => [
      emailGrant(a, G1, 'u2@example.test', admin),
      groupGrant(a, GROUP_GRANT, 'admins', admin),
      groupGrant(a, GROUP_GRANT_2, 'ops', admin),
      membership(a, U1, 'admins'),
      membership(a, U1, 'ops'),
    ];
    const onlyThroughGroups = (): Statement[] => [
      groupGrant(a, GROUP_GRANT, 'admins', admin),
      groupGrant(a, GROUP_GRANT_2, 'ops', admin),
      membership(a, U1, 'admins'),
      membership(a, U1, 'ops'),
    ];
    const alternating = (run: number): Statement[] => (run % 4 < 2 ? emails() : throughGroup());
    const oneOfTwo = (outcomes: [string, string], holders: number) => ({ outcomes, holders });
    const scenarios: {
      name: string;
      seed: (run: number) => Statement[];
      left: GrantOperation;
      right: GrantOperation;
      expected: { outcomes: [string, string]; holders: number }[];
    }[] = [
      {
        name: 'delete against delete',
        seed: emails,
        left: del(G1),
        right: del(G2),
        expected: [
          oneOfTwo(['deleted', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'deleted'], 1),
        ],
      },
      {
        name: 'delete against delete with a holder only through a group',
        seed: throughGroup,
        left: del(G1),
        right: del(GROUP_GRANT),
        expected: [
          oneOfTwo(['deleted', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'deleted'], 1),
        ],
      },
      {
        name: 'delete against delete of the two grants of one person',
        seed: oneWithTwoGrants,
        left: del(G1),
        right: del(GROUP_GRANT),
        expected: [
          oneOfTwo(['deleted', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'deleted'], 1),
        ],
      },
      {
        name: 'suspend against suspend',
        seed: alternating,
        left: suspend(U1),
        right: suspend(U2),
        expected: [
          oneOfTwo(['suspended', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'suspended'], 1),
        ],
      },
      {
        name: 'delete against suspend',
        seed: alternating,
        left: del(G1),
        right: suspend(U2),
        expected: [
          oneOfTwo(['deleted', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'suspended'], 1),
        ],
      },
      {
        name: 'delete against suspend of a person with a second grant',
        seed: () => [...oneWithTwoGrants(), emailGrant(a, G2, 'u2@example.test', admin)],
        left: del(G1),
        right: suspend(U2),
        expected: [oneOfTwo(['deleted', 'suspended'], 1)],
      },
      {
        name: 'delete against delete, two groups sharing a holder',
        seed: sharedGroups,
        left: del(GROUP_GRANT),
        right: del(GROUP_GRANT_2),
        expected: [
          oneOfTwo(['deleted', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'deleted'], 2),
        ],
      },
      {
        name: 'suspend against suspend, two groups sharing a holder',
        seed: sharedGroups,
        left: suspend(U1),
        right: suspend(U2),
        expected: [
          oneOfTwo(['suspended', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'suspended'], 1),
        ],
      },
      {
        name: 'delete against suspend, two groups sharing a holder',
        seed: sharedGroups,
        left: del(GROUP_GRANT),
        right: suspend(U2),
        expected: [
          oneOfTwo(['deleted', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'suspended'], 1),
        ],
      },
      {
        name: 'delete against delete, a holder in two groups with a second holder (positive control)',
        seed: inTwoGroups,
        left: del(GROUP_GRANT),
        right: del(GROUP_GRANT_2),
        expected: [oneOfTwo(['deleted', 'deleted'], 1)],
      },
      {
        name: 'suspend against suspend, a holder in two groups',
        seed: inTwoGroups,
        left: suspend(U1),
        right: suspend(U2),
        expected: [
          oneOfTwo(['suspended', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'suspended'], 1),
        ],
      },
      {
        name: 'delete against suspend, a holder in two groups',
        seed: inTwoGroups,
        left: del(G1),
        right: suspend(U1),
        expected: [
          oneOfTwo(['deleted', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'suspended'], 1),
        ],
      },
      {
        name: 'delete against delete, the only holder through two group grants',
        seed: onlyThroughGroups,
        left: del(GROUP_GRANT),
        right: del(GROUP_GRANT_2),
        expected: [
          oneOfTwo(['deleted', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'deleted'], 1),
        ],
      },
      {
        name: 'demotion against delete',
        seed: emails,
        left: demote(G1),
        right: del(G2),
        expected: [
          oneOfTwo(['updated', 'last_holder'], 1),
          oneOfTwo(['last_holder', 'deleted'], 1),
        ],
      },
    ];

    const fenceFor = async (target: string) => {
      const found = await pair.executor.all<{ revision: number }>(
        st('SELECT revision FROM access_grant WHERE id = ?', target),
      );
      return mutationFence(
        { userId: ACTOR_USER, sessionId: ACTOR_SESSION } as unknown as AuthenticatedActor,
        { grant: found[0]?.revision ?? 1 },
      );
    };
    const perform = async (
      repository: GrantRepository,
      operation: GrantOperation,
    ): Promise<string> => {
      if (operation.kind === 'suspend') {
        return repository.suspendUser(a, await fenceFor(operation.target), {
          audit: mutationAudit('user.suspend', operation.target),
          userId: operation.target,
          now: LATER,
        });
      }
      const fence = await fenceFor(operation.target);
      if (operation.kind !== 'delete') {
        return repository.changeRole(a, fence, {
          audit: mutationAudit('grant.role_change', operation.target),
          id: operation.target,
          roleId: auditor,
          now: LATER,
          opId: newOpId(),
        });
      }
      const result = await repository.deleteOrganization(a, fence, {
        audit: mutationAudit('grant.revoke', operation.target),
        id: operation.target,
        opId: newOpId(),
      });
      return typeof result === 'string' ? result : result.outcome;
    };
    const rowOf = (operation: GrantOperation) =>
      rowsOf(
        pair.executor,
        operation.kind === 'suspend'
          ? 'SELECT * FROM user_account WHERE id = ?'
          : 'SELECT * FROM access_grant WHERE id = ?',
        operation.target,
      );
    const verify = async (
      operation: GrantOperation,
      outcome: string,
      before: Record<string, unknown>[],
      label: string,
    ): Promise<void> => {
      const after = await rowOf(operation);
      if (outcome === 'last_holder') {
        expect(after, `${label}: refused row`).toEqual(before);
      } else if (outcome === 'deleted') {
        expect(after, `${label}: deleted grant`).toEqual([]);
      } else if (outcome === 'suspended') {
        expect(after, `${label}: suspended user`).toMatchObject([{ status: 'suspended' }]);
      } else if (outcome === 'updated') {
        expect(after, `${label}: demoted grant`).toMatchObject([{ role_id: auditor }]);
      } else {
        throw new Error(`${label}: unexpected outcome ${outcome}`);
      }
    };

    const attemptRace = async (scenario: (typeof scenarios)[number], run: number) => {
      await clearWorld(world);
      await pair.executor.batch([
        userRow(a, U1, 'u1@example.test'),
        userRow(a, U2, 'u2@example.test'),
        ...holderEvidence(a, [
          [U1, 'u1@example.test'],
          [U2, 'u2@example.test'],
        ]),
        ...actorRows(a, admin),
        ...scenario.seed(run),
      ]);
      const beforeLeft = await rowOf(scenario.left);
      const beforeRight = await rowOf(scenario.right);
      const [firstExecutor, secondExecutor] = gatedPair(pair.executor, other);
      const options = {
        holderInput: currentHolderInput,
        providerAnchors: [
          {
            provider: HOLDER_PROVIDER,
            anchor: ANCHOR,
            emailAuthoritative: true,
            emailAuthoritativeDomains: ['example.test', 'actor.test'],
          },
        ],
      };
      const first = createGrantRepository(wrap(firstExecutor), options);
      const second = createGrantRepository(wrap(secondExecutor), options);
      const outcomes = await race(
        run,
        () => perform(first, scenario.left),
        () => perform(second, scenario.right),
      );
      return { outcomes, beforeLeft, beforeRight, first };
    };

    for (const scenario of scenarios) {
      for (let run = 0; run < RUNS; run += 1) {
        let settled: Awaited<ReturnType<typeof attemptRace>> | undefined;
        const seen: string[] = [];
        for (
          let attempt = 0;
          attempt < INDETERMINATE_ATTEMPTS && settled === undefined;
          attempt += 1
        ) {
          const result = await attemptRace(scenario, run);
          if (result.outcomes.includes('indeterminate')) {
            seen.push(result.outcomes.join('/'));
            expect(
              await result.first.countProtectedHolders(a),
              `${scenario.name}: holders after an indeterminate attempt`,
            ).toBeGreaterThanOrEqual(1);
          } else {
            settled = result;
          }
        }
        if (settled === undefined) {
          throw new Error(
            `${scenario.name}: every one of ${INDETERMINATE_ATTEMPTS} attempts was indeterminate (${seen.join(', ')}); the race never completed`,
          );
        }
        const { outcomes, beforeLeft, beforeRight, first } = settled;

        expect(
          scenario.expected.map((entry) => entry.outcomes),
          scenario.name,
        ).toContainEqual(outcomes);
        await verify(scenario.left, outcomes[0], beforeLeft, scenario.name);
        await verify(scenario.right, outcomes[1], beforeRight, scenario.name);
        const expected = scenario.expected.find(
          (entry) => entry.outcomes[0] === outcomes[0] && entry.outcomes[1] === outcomes[1],
        );
        expect(await first.countProtectedHolders(a), `${scenario.name}: holders`).toBe(
          expected?.holders,
        );
      }
    }
  });
};

const loginBatchRace: Case = async (open, wrap = (executor) => executor) => {
  await withWorld(open, async (world) => {
    const { pair, a } = world;
    const other = await pair.second();
    const plan = (
      overrides: {
        subject?: string;
        identityId?: string;
        sessionId?: string;
        previous?: boolean;
      } = {},
    ): LoginPlan => {
      const identityId = overrides.identityId ?? IDENTITY_Y;
      return {
        userId: U1,
        createUser: false,
        email: 'u1@example.test',
        displayName: null,
        identityId,
        provider: PROVIDER,
        trustAnchor: ANCHOR,
        subject: overrides.subject ?? SUBJECT,
        emailVerified: true,
        groups: ['admins', 'readers'],
        evidenceTime: '2026-10-15T11:59:00.000Z',
        session: { ...newSession(overrides.sessionId ?? NEW_SESSION, U1), identityId },
        previousSecretHash: overrides.previous === false ? null : hash('old-session'),
        now: NOW,
        autoJoin: false,
      };
    };
    const identityRow = (id: string, userId: string, subject: string): Statement =>
      st(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        a.orgId,
        userId,
        PROVIDER,
        subject,
        'x@example.test',
      );
    const foreignIdentity = identityRow(IDENTITY_X, USER_X, SUBJECT);
    const state = async () => ({
      groups: await rowsOf(
        pair.executor,
        'SELECT user_id, provider, group_name FROM user_group ORDER BY 2, 3',
      ),
      sessions: await rowsOf(
        pair.executor,
        'SELECT id, user_id, revoked_at FROM session ORDER BY id',
      ),
      identities: await rowsOf(pair.executor, 'SELECT id, user_id FROM identity ORDER BY id'),
    });
    const existingGroup = { user_id: U1, provider: PROVIDER, group_name: 'old-group' };
    const liveOldSession = { id: OLD_SESSION, user_id: U1, revoked_at: null };
    const seed = async (...extra: Statement[]): Promise<void> => {
      await clearWorld(world);
      await pair.executor.batch([
        userRow(a, U1, 'u1@example.test'),
        userRow(a, USER_X, 'x@example.test'),
        st(
          'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
          a.orgId,
          PROVIDER,
          ANCHOR,
        ),
        membership(a, U1, 'old-group', PROVIDER),
        sessionRow(a, OLD_SESSION, U1),
        ...extra,
      ]);
    };

    for (let run = 0; run < RUNS; run += 1) {
      await seed(foreignIdentity);
      const before = await state();
      expect(before.groups).toEqual([existingGroup]);

      const result = await createLoginWriter(wrap(pair.executor)).commit(a, plan());

      expect(result, 'identity owned by another user').toBe('refused');
      expect(await state(), 'refused login leaves state').toEqual(before);
      expect(before.sessions).toEqual([liveOldSession]);
    }

    for (let run = 0; run < RUNS; run += 1) {
      await seed();
      const [firstExecutor, secondExecutor] = gatedPair(pair.executor, other);
      const claim = () =>
        secondExecutor.batch([foreignIdentity]).then(
          () => 'claimed',
          (error: unknown) => {
            if (classifySqliteError(error).kind !== 'unique') throw error;
            return 'conflict';
          },
        );

      const [result, claimed] = await race(
        run,
        () => createLoginWriter(wrap(firstExecutor)).commit(a, plan()),
        claim,
      );

      const after = await state();
      if (result === 'created') {
        expect(claimed).toBe('conflict');
        expect(after.identities).toEqual([{ id: IDENTITY_Y, user_id: U1 }]);
        expect(after.groups).toEqual([
          { user_id: U1, provider: PROVIDER, group_name: 'admins' },
          { user_id: U1, provider: PROVIDER, group_name: 'readers' },
        ]);
        expect(after.sessions).toContainEqual({ id: NEW_SESSION, user_id: U1, revoked_at: null });
        expect(after.sessions).toContainEqual({ id: OLD_SESSION, user_id: U1, revoked_at: NOW });
      } else {
        expect(claimed).toBe('claimed');
        expect(after.identities).toEqual([{ id: IDENTITY_X, user_id: USER_X }]);
        expect(after.groups).toEqual([existingGroup]);
        expect(after.sessions).toEqual([liveOldSession]);
      }
    }

    for (let run = 0; run < RUNS; run += 1) {
      await seed(identityRow(IDENTITY_LINKED, U1, 'sub-0'));
      const before = await state();

      const result = await createLoginWriter(wrap(pair.executor)).commit(a, plan());

      expect(result, 'user already linked at the provider').toBe('refused');
      expect(await state()).toEqual(before);
      expect(before.identities).toEqual([{ id: IDENTITY_LINKED, user_id: U1 }]);
    }

    for (let run = 0; run < RUNS; run += 1) {
      await seed();
      const [firstExecutor, secondExecutor] = gatedPair(pair.executor, other);
      const results = await race(
        run,
        () =>
          createLoginWriter(wrap(firstExecutor)).commit(
            a,
            plan({ subject: 'sub-1', identityId: IDENTITY_Y, previous: false }),
          ),
        () =>
          createLoginWriter(wrap(secondExecutor)).commit(
            a,
            plan({
              subject: 'sub-2',
              identityId: IDENTITY_Z,
              sessionId: OTHER_SESSION,
              previous: false,
            }),
          ),
      );

      expect(results.slice().sort(), 'two subjects at one provider').toEqual([
        'created',
        'refused',
      ]);
      const winner =
        results[0] === 'created'
          ? { identity: IDENTITY_Y, session: NEW_SESSION }
          : { identity: IDENTITY_Z, session: OTHER_SESSION };
      const after = await state();
      expect(after.identities, 'two subjects at one provider').toEqual([
        { id: winner.identity, user_id: U1 },
      ]);
      expect(after.sessions.filter((row) => row.id !== OLD_SESSION)).toEqual([
        { id: winner.session, user_id: U1, revoked_at: null },
      ]);
      expect(after.groups).toHaveLength(2);
    }
  });
};

const reserveAttempt: Case = async (open, wrap = (executor) => executor) => {
  await withWorld(open, async (world) => {
    const { pair, a } = world;
    const raw = [pair.executor, await pair.second()] as const;
    for (let run = 0; run < RUNS; run += 1) {
      await clearWorld(world);
      await pair.executor.batch([...adminAccount(a), ...enabledLogin(a, ADMIN, LAST_STEP)]);
      const arrive = arrivals(6);
      const readers = Array.from({ length: 6 }, (_, index) =>
        createLocalLoginReader(wrap(gated(raw[index % 2] ?? pair.executor, arrive, 'all'))),
      );

      const results = await Promise.all(
        readers.map((reader) => reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL)),
      );

      const reserved = results.flatMap((result) => (result.reserved ? [result] : []));
      expect(reserved).toHaveLength(5);
      expect(reserved.map((result) => result.snapshot.failedCount).sort()).toEqual([1, 2, 3, 4, 5]);
      expect(
        reserved
          .filter((result) => result.snapshot.lockedUntil !== null)
          .map((result) => result.snapshot.failedCount),
      ).toEqual([5]);
      expect(results.filter((result) => !result.reserved)).toEqual([
        { reserved: false, reason: 'locked' },
      ]);
      expect(
        await rowsOf(pair.executor, 'SELECT failed_count, locked_until FROM local_login'),
      ).toEqual([{ failed_count: 5, locked_until: LOCK_UNTIL }]);
    }

    const reader = createLocalLoginReader(wrap(pair.executor));
    await pair.executor.batch([
      st('UPDATE local_login SET failed_count = 1, locked_until = ?', PAST),
    ]);
    expect(await reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL)).toMatchObject({
      reserved: true,
      snapshot: { failedCount: 2, lockedUntil: PAST },
    });
    expect(await reader.reserveAttempt(a, U2, NOW, LOCK_UNTIL)).toEqual({
      reserved: false,
      reason: 'missing',
    });
    await expect(reader.reserveAttempt(a, ADMIN, NOW, NOW)).rejects.toThrow(RangeError);
  });
};

const totpSetupRequired: Case = async (open) => {
  await withWorld(open, async ({ pair, a }) => {
    const { executor } = pair;
    await executor.batch([...adminAccount(a), ...enabledLogin(a, ADMIN, LAST_STEP)]);
    const enabled = await snapshotOf(executor, a);
    expect(enabled.totpState).toBe('enabled');

    await executor.batch([st('DELETE FROM credential WHERE id = ?', CREDENTIAL)]);

    expect(
      await rowsOf(executor, 'SELECT totp_credential_id, totp_enabled_at FROM local_login'),
    ).toEqual([{ totp_credential_id: null, totp_enabled_at: NOW }]);
    const orphaned = await snapshotOf(executor, a);
    expect(orphaned).toMatchObject({ totpState: 'setup_required', totpEnabled: true });
    const writer = createLocalLoginSuccessWriter(executor);
    expect(await writer.succeed(a, successInput(orphaned, newSession(NEW_SESSION)))).toBe(false);
    expect(await writer.succeed(a, successInput(enabled, newSession(NEW_SESSION)))).toBe(false);
    expect(await countOf(executor, 'SELECT count(*) AS n FROM session')).toBe(0);
    expect(await rowsOf(executor, 'SELECT totp_last_step, failed_count FROM local_login')).toEqual([
      { totp_last_step: LAST_STEP, failed_count: 0 },
    ]);
  });
};

const accessMutationGuard: Case = async (open) => {
  await withWorld(open, async ({ pair, a }) => {
    const { executor } = pair;
    const addUser = (id: string): Statement =>
      st(
        'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
        id,
        a.orgId,
        `${id.toLowerCase()}@example.test`,
        'active',
      );
    const guardRows = () => countOf(executor, 'SELECT count(*) AS n FROM access_mutation_guard');
    const holds = (value: 0 | 1 | null) => sql<boolean>`(select ${sql.lit(value)})`;

    await executor.batch([...assertGuard(holds(1), a), addUser(U1)]);
    expect(await countOf(executor, 'SELECT count(*) AS n FROM user_account')).toBe(1);
    expect(await guardRows()).toBe(0);

    const plan = await executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${assertGuard(holds(1), a)[0]?.sql ?? ''}`,
      params: [newOpId()],
    });
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toMatch(/MATERIALIZE guard_cond/);
    expect(details).not.toMatch(/CO-ROUTINE guard_cond/);

    for (const value of [0, null] as const) {
      await expect(
        executor.batch([addUser(U3), ...assertGuard(holds(value), a), addUser(U2)]),
      ).rejects.toMatchObject({ kind: 'unique' });
      expect(await countOf(executor, 'SELECT count(*) AS n FROM user_account')).toBe(1);
      expect(await guardRows()).toBe(0);
    }

    const epoch = async (): Promise<string[]> =>
      (
        await executor.all<{ version: string }>({
          sql: 'SELECT version FROM cache_epoch WHERE org_id = ? ORDER BY org_id',
          params: [a.orgId],
        })
      ).map((row) => row.version);
    const users = () => countOf(executor, 'SELECT count(*) AS n FROM user_account');

    const start = await epoch();
    await executor.batch([...assertGuard(holds(1), a), addUser(U2)]);
    const committed = await epoch();
    expect(committed).toHaveLength(1);
    expect(committed).not.toEqual(start);

    await expect(executor.batch([...assertGuard(holds(0), a), addUser(U3)])).rejects.toMatchObject({
      kind: 'unique',
    });
    expect(await epoch()).toEqual(committed);

    await expect(
      executor.batch([...assertGuard(holds(1), a), addUser(U3), addUser(U3)]),
    ).rejects.toMatchObject({ kind: 'unique' });
    expect(await epoch()).toEqual(committed);

    const usersBefore = await users();
    await executor.batch([{ sql: 'DELETE FROM cache_epoch WHERE org_id = ?', params: [a.orgId] }]);
    await expect(
      executor.batch([
        addUser(U3),
        ...assertGuard(holds(1), a),
        addUser('01J0USER000000000000000004'),
      ]),
    ).rejects.toMatchObject({ kind: 'unique' });
    expect(await users()).toBe(usersBefore);
    expect(await epoch()).toEqual([]);
    expect(await guardRows()).toBe(0);
  });
};

const sessionReauth: Case = async (open, wrap = (executor) => executor) => {
  await withWorld(open, async ({ pair, a }) => {
    await pair.executor.batch([
      userRow(a, ADMIN, EMAIL),
      st(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES (?, ?, ?, ?, ?, ?)',
        IDENTITY_X,
        a.orgId,
        ADMIN,
        PROVIDER,
        SUBJECT,
        EMAIL,
      ),
      sessionRow(a, OLD_SESSION, ADMIN),
      st(
        'UPDATE session SET identity_id = ?, reauth_at = ? WHERE org_id = ? AND id = ?',
        IDENTITY_X,
        PAST,
        a.orgId,
        OLD_SESSION,
      ),
    ]);
    const repository = createSessionRepository(wrap(pair.executor));
    const reauthAt = () =>
      rowsOf(
        pair.executor,
        'SELECT reauth_at FROM session WHERE org_id = ? AND id = ?',
        a.orgId,
        OLD_SESSION,
      );
    const pending = () =>
      rowsOf(
        pair.executor,
        'SELECT id, action, target_type, target_id FROM audit_pending WHERE org_id = ? AND action = ?',
        a.orgId,
        'session.reauth',
      );
    const audit = mutationAudit('session.reauth', OLD_SESSION);
    expect(
      await repository.markReauthenticatedByIdentity(a, {
        audit,
        sessionId: OLD_SESSION,
        identityId: IDENTITY_X,
        authTime: NOW,
        now: NOW,
      }),
    ).toBe(true);
    expect(await reauthAt()).toEqual([{ reauth_at: NOW }]);
    const staged = [
      { id: audit.id, action: 'session.reauth', target_type: 'session', target_id: OLD_SESSION },
    ];
    expect(await pending()).toEqual(staged);

    expect(
      await repository.markReauthenticatedByIdentity(a, {
        audit: mutationAudit('session.reauth', OLD_SESSION),
        sessionId: OLD_SESSION,
        identityId: IDENTITY_X,
        authTime: NOW,
        now: NOW,
      }),
    ).toBe(false);
    expect(await reauthAt()).toEqual([{ reauth_at: NOW }]);
    expect(await pending()).toEqual(staged);
  });
};

export const authContractCases = {
  sessionReauth,
  upgrade,
  resetCleanup,
  totpReplay,
  localReauthForeignSession,
  resetRace,
  setupRestage,
  bootstrapPromotion,
  lastAdminRaces,
  loginBatchRace,
  reserveAttempt,
  totpSetupRequired,
  accessMutationGuard,
} as const satisfies Record<string, Case>;

export function describeAuthContract(name: string, open: Open): void {
  describe(`auth contract: ${name}`, () => {
    it('SSO reauth stages one audit with the timestamp update and stages nothing on replay', () =>
      authContractCases.sessionReauth(open));
    it(
      '1. baseline rerun keeps populated rows, adds no authority and gives 55 tables',
      () => authContractCases.upgrade(open),
      30_000,
    );
    it('2. reset deletes the TOTP credential and clears its reference and enabled time together', () =>
      authContractCases.resetCleanup(open));
    it(
      '3. TOTP replay: two concurrent successes with one step leave one session',
      () => authContractCases.totpReplay(open),
      60_000,
    );
    it(
      '4. reset race: a success with a pre-reset snapshot is refused',
      () => authContractCases.resetRace(open),
      60_000,
    );
    it(
      '5. setup restage race: completion and restage never both win',
      () => authContractCases.setupRestage(open),
      60_000,
    );
    it(
      '6. bootstrap promotes an existing auditor grant',
      () => authContractCases.bootstrapPromotion(open),
      30_000,
    );
    it(
      '7. last-admin races: at least one holder always survives',
      () => authContractCases.lastAdminRaces(open),
      120_000,
    );
    it(
      '8. login batch race: an identity owned by another user is refused without side effects',
      () => authContractCases.loginBatchRace(open),
      60_000,
    );
    it(
      '9. reserveAttempt: six concurrent reservations give five reserved and one locked',
      () => authContractCases.reserveAttempt(open),
      60_000,
    );
    it('10. TOTP enabled without a credential requires setup and never passes', () =>
      authContractCases.totpSetupRequired(open));
    it('11. access mutation guard: true lands, false and NULL fail with UNIQUE and leave no row', () =>
      authContractCases.accessMutationGuard(open));
    it('12. local reauthentication refuses a foreign session without staging audit', () =>
      authContractCases.localReauthForeignSession(open));
  });
}

function mutationAudit(action: AuditAction, targetId: string | null) {
  const id = ulid();
  const result = auditEvent({
    id,
    now: '2026-10-19T00:00:00.000Z',
    action,
    actor: { type: 'system', id: null },
    context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
    target: { type: action.split('.')[0]!, id: targetId },
  });
  if (!result.ok) throw new Error('Invalid test audit event');
  return result.event;
}
