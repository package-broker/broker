import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type {
  LocalLoginSnapshot,
  LocalLoginSuccessWriter,
} from '@package-broker/core/db/local-login';
import type { NewSession } from '@package-broker/core/db/sessions';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createLocalLoginReader } from './local-login.js';
import { createLocalLoginSuccessWriter } from './local-login-success.js';

const NOW = '2026-10-15T12:00:00.000Z';
const FUTURE = '2026-10-15T20:00:00.000Z';
const LOCK_UNTIL = '2026-10-15T12:15:00.000Z';
const LATER = '2026-10-15T12:05:00.000Z';
const PAST = '2026-10-15T11:00:00.000Z';

const ADMIN = '01J0USERADMIN00000000000A1';
const OTHER_ADMIN = '01J0USERADMIN00000000000A2';
const NO_TOTP = '01J0USERNOTOTP0000000000A3';
const ROLE = '01J0ROLEADMINA000000000000';
const ADMIN_GRANT = '01J0GRANT0000000000000000A';
const CREDENTIAL = '01J0CREDENTIAL000000000000A';
const IDENTITY = '01J0IDENTITY00000000000000';
const PASSWORD_HASH = 'pbkdf2-sha256$i=100000$v=1$c2FsdA$aGFzaA';
const REHASH = 'pbkdf2-sha256$i=100000$v=1$bmV3c2FsdA$bmV3aGFzaA';
const STEP = 57_000_002;
const LAST_STEP = 57_000_001;
const OP = '01J0OPERATION00000000000001';
const CREDENTIAL_2 = '01J0CREDENTIAL000000000000B';
const MINTED_OP = /^[0-9A-Z]{26}$/;

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let writer: LocalLoginSuccessWriter;

function hash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

function insert(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function user(id: string, email: string, status = 'active'): Statement {
  return insert(
    'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
    id,
    a.orgId,
    email,
    status,
  );
}

function login(
  userId: string,
  credentialId: string | null,
  enabledAt: string | null,
  lastStep: number | null,
  failed = 0,
  lockedUntil: string | null = null,
): Statement {
  return insert(
    'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, totp_last_step, credential_rev, failed_count, locked_until) VALUES (?, ?, ?, ?, ?, ?, 3, ?, ?)',
    userId,
    a.orgId,
    PASSWORD_HASH,
    credentialId,
    enabledAt,
    lastStep,
    failed,
    lockedUntil,
  );
}

async function seedSession(
  id: string,
  options: {
    userId?: string;
    identityId?: string | null;
    revokedAt?: string | null;
    expiresAt?: string;
  } = {},
): Promise<void> {
  await executor.batch([
    insert(
      'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      a.orgId,
      options.userId ?? ADMIN,
      options.identityId ?? null,
      hash(id),
      hash('csrf'),
      options.expiresAt ?? FUTURE,
      options.revokedAt ?? null,
    ),
  ]);
}

function newSession(id: string, userId = ADMIN): NewSession {
  return {
    id,
    userId,
    identityId: null,
    secretHash: hash(id),
    csrfHash: hash('csrf-new'),
    expiresAt: FUTURE,
    ip: null,
    userAgent: null,
    now: NOW,
  };
}

async function snapshotOf(email = 'admin@example.test'): Promise<LocalLoginSnapshot> {
  const found = await createLocalLoginReader(executor).findByEmail(a, email);
  if (found === null) throw new Error('snapshot not found');
  return found;
}

interface Input {
  readonly snapshot: LocalLoginSnapshot;
  readonly step: number;
  readonly rehash: string | null;
  readonly session: NewSession | null;
  readonly previousSecretHash: string | null;
  readonly reauthSessionId: string | null;
  readonly now: string;
}

function loginInput(snapshot: LocalLoginSnapshot, overrides: Partial<Input> = {}): Input {
  return {
    snapshot,
    step: STEP,
    rehash: null,
    session: newSession('01J0SESSIONNEW0000000000A1', snapshot.userId),
    previousSecretHash: null,
    reauthSessionId: null,
    now: NOW,
    ...overrides,
  };
}

function reauthInput(
  snapshot: LocalLoginSnapshot,
  sessionId: string,
  overrides: Partial<Input> = {},
): Input {
  return loginInput(snapshot, { session: null, reauthSessionId: sessionId, ...overrides });
}

async function loginRow(userId = ADMIN): Promise<Record<string, unknown>> {
  const rows = await executor.all<Record<string, unknown>>(
    insert('SELECT * FROM local_login WHERE user_id = ?', userId),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('local_login row missing');
  return row;
}

async function sessionRow(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await executor.all<Record<string, unknown>>(
    insert('SELECT * FROM session WHERE id = ?', id),
  );
  return rows[0];
}

async function sessionCount(): Promise<number> {
  const rows = await executor.all<{ n: number }>(insert('SELECT count(*) AS n FROM session'));
  return rows[0]?.n ?? -1;
}

async function exec(...statements: Statement[]): Promise<void> {
  await executor.batch(statements);
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  writer = createLocalLoginSuccessWriter(executor);
  await executor.batch([
    user(ADMIN, 'admin@example.test'),
    user(OTHER_ADMIN, 'other@example.test'),
    user(NO_TOTP, 'nototp@example.test'),
    insert(
      'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 1)',
      ROLE,
      a.orgId,
      'organization_admin',
      'organization_admin',
      'organization',
    ),
    ...['admin', 'other', 'nototp'].map((name, index) =>
      insert(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, 'email', ?, 'organization', NULL, ?)",
        `01J0GRANT${index}000000000000000A`,
        a.orgId,
        `${name}@example.test`,
        ROLE,
      ),
    ),
    insert(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
      CREDENTIAL,
      a.orgId,
    ),
    insert(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
      CREDENTIAL_2,
      a.orgId,
    ),
    login(ADMIN, CREDENTIAL, NOW, LAST_STEP),
    login(OTHER_ADMIN, null, null, null),
    login(NO_TOTP, null, null, null),
    insert(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES (?, ?, ?, ?, ?, ?)',
      IDENTITY,
      a.orgId,
      ADMIN,
      'oidc',
      'subject',
      'admin@example.test',
    ),
  ]);
});

afterEach(async () => {
  await database.close();
});

describe('login success', () => {
  it('creates the session, advances the step, resets the counter and revokes the previous session', async () => {
    await seedSession('01J0SESSIONOLD0000000000A1');
    await exec(insert('UPDATE local_login SET failed_count = 3 WHERE user_id = ?', ADMIN));
    const snapshot = await snapshotOf();

    const result = await writer.succeed(
      a,
      loginInput(snapshot, { previousSecretHash: hash('01J0SESSIONOLD0000000000A1') }),
    );

    expect(result).toBe(true);
    expect(await sessionRow('01J0SESSIONNEW0000000000A1')).toMatchObject({
      org_id: a.orgId,
      user_id: ADMIN,
      secret_hash: hash('01J0SESSIONNEW0000000000A1'),
      revoked_at: null,
    });
    expect(await loginRow()).toMatchObject({
      totp_last_step: STEP,
      failed_count: 0,
      locked_until: null,
      last_login_at: NOW,
      updated_at: NOW,
      password_hash: PASSWORD_HASH,
      credential_rev: 3,
    });
    expect((await sessionRow('01J0SESSIONOLD0000000000A1'))?.revoked_at).toBe(NOW);
    const marker = (await loginRow()).last_op_id;
    expect(marker).toMatch(MINTED_OP);
    expect(marker).not.toBe(OP);
  });

  it('replaces the password hash when a rehash is given', async () => {
    const result = await writer.succeed(a, loginInput(await snapshotOf(), { rehash: REHASH }));
    expect(result).toBe(true);
    expect((await loginRow()).password_hash).toBe(REHASH);
  });

  it('accepts the first TOTP login when the stored step is NULL', async () => {
    await exec(insert('UPDATE local_login SET totp_last_step = NULL WHERE user_id = ?', ADMIN));
    const result = await writer.succeed(a, loginInput(await snapshotOf()));
    expect(result).toBe(true);
    expect((await loginRow()).totp_last_step).toBe(STEP);
  });

  it('refuses a user without TOTP, also when the snapshot claims an enabled credential', async () => {
    const snapshot = await snapshotOf('nototp@example.test');
    expect(snapshot.totpState).toBe('none');
    const before = await loginRow(NO_TOTP);
    await expect(writer.succeed(a, loginInput(snapshot))).resolves.toBe(false);
    const forged = { ...snapshot, totpState: 'enabled' as const, totpCredentialId: CREDENTIAL_2 };
    await expect(writer.succeed(a, loginInput(forged, { step: STEP + 1 }))).resolves.toBe(false);
    expect(await loginRow(NO_TOTP)).toEqual(before);
    expect(await sessionCount()).toBe(0);
  });

  it('uses one batch and no read for a login', async () => {
    const counted = countCalls(executor);
    const countedWriter = createLocalLoginSuccessWriter(counted.executor);
    await countedWriter.succeed(a, loginInput(await snapshotOf()));
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
  });
});

describe('login refusals', () => {
  async function expectRefused(input: Input, previous?: string): Promise<void> {
    const before = await loginRow();
    const sessions = await sessionCount();
    await expect(writer.succeed(a, input)).resolves.toBe(false);
    expect(await loginRow()).toEqual(before);
    expect(await sessionCount()).toBe(sessions);
    if (previous !== undefined) {
      expect((await sessionRow(previous))?.revoked_at).toBeNull();
    }
  }

  const OLD = '01J0SESSIONOLD0000000000A1';

  beforeEach(async () => {
    await seedSession(OLD);
  });

  it('refuses after a reset changed the credential revision and cleared the step', async () => {
    const snapshot = await snapshotOf();
    await exec(
      insert(
        'UPDATE local_login SET credential_rev = credential_rev + 1, totp_last_step = NULL WHERE user_id = ?',
        ADMIN,
      ),
    );
    await expectRefused(loginInput(snapshot, { previousSecretHash: hash(OLD) }), OLD);
  });

  it('refuses when the stored password hash differs from the snapshot', async () => {
    const snapshot = await snapshotOf();
    await exec(insert('UPDATE local_login SET password_hash = ? WHERE user_id = ?', REHASH, ADMIN));
    await expectRefused(loginInput(snapshot, { previousSecretHash: hash(OLD) }), OLD);
  });

  it('refuses when the TOTP credential was rebound without a revision bump', async () => {
    const snapshot = await snapshotOf();
    await exec(
      insert(
        'UPDATE local_login SET totp_credential_id = ? WHERE user_id = ?',
        CREDENTIAL_2,
        ADMIN,
      ),
    );
    await expectRefused(loginInput(snapshot, { previousSecretHash: hash(OLD) }), OLD);
  });

  it('refuses when the TOTP credential was removed', async () => {
    const snapshot = await snapshotOf();
    await exec(insert('DELETE FROM credential WHERE id = ?', CREDENTIAL));
    await expectRefused(loginInput(snapshot, { previousSecretHash: hash(OLD) }), OLD);
  });

  it('refuses when the snapshot has no password hash', async () => {
    const snapshot = await snapshotOf();
    await expectRefused(
      loginInput({ ...snapshot, passwordHash: null }, { previousSecretHash: hash(OLD) }),
      OLD,
    );
  });

  it('refuses a replayed step, an older step and the same step twice', async () => {
    const snapshot = await snapshotOf();
    await expectRefused(
      loginInput(snapshot, { step: LAST_STEP, previousSecretHash: hash(OLD) }),
      OLD,
    );
    await expectRefused(
      loginInput(snapshot, { step: LAST_STEP - 1, previousSecretHash: hash(OLD) }),
      OLD,
    );

    await expect(writer.succeed(a, loginInput(snapshot))).resolves.toBe(true);
    const second = loginInput(snapshot, {
      session: newSession('01J0SESSIONNEW0000000000A2'),
      previousSecretHash: hash('01J0SESSIONNEW0000000000A1'),
    });
    await expect(writer.succeed(a, second)).resolves.toBe(false);
    expect(await sessionRow('01J0SESSIONNEW0000000000A2')).toBeUndefined();
    expect((await sessionRow('01J0SESSIONNEW0000000000A1'))?.revoked_at).toBeNull();
  });

  it('refuses when the admin grant was removed', async () => {
    const snapshot = await snapshotOf();
    await exec(insert('DELETE FROM access_grant WHERE id = ?', ADMIN_GRANT));
    await expectRefused(loginInput(snapshot, { previousSecretHash: hash(OLD) }), OLD);
  });

  it('refuses when the user was suspended', async () => {
    const snapshot = await snapshotOf();
    await exec(insert("UPDATE user_account SET status = 'suspended' WHERE id = ?", ADMIN));
    await expectRefused(loginInput(snapshot, { previousSecretHash: hash(OLD) }), OLD);
  });

  it('refuses when the account is locked after the snapshot was taken', async () => {
    const snapshot = await snapshotOf();
    await exec(
      insert('UPDATE local_login SET locked_until = ? WHERE user_id = ?', LOCK_UNTIL, ADMIN),
    );
    await expectRefused(loginInput(snapshot, { previousSecretHash: hash(OLD) }), OLD);
  });

  it('refuses a read snapshot of a locked account that is not a reservation', async () => {
    await exec(
      insert(
        'UPDATE local_login SET locked_until = ?, failed_count = 3 WHERE user_id = ?',
        LOCK_UNTIL,
        ADMIN,
      ),
    );
    const snapshot = await snapshotOf();
    expect(snapshot).toMatchObject({ failedCount: 3, lockedUntil: LOCK_UNTIL });
    await expectRefused(loginInput(snapshot, { previousSecretHash: hash(OLD) }), OLD);
    expect((await loginRow()).locked_until).toBe(LOCK_UNTIL);
  });

  it('refuses when the lock moved away from the snapshot value', async () => {
    await exec(
      insert(
        'UPDATE local_login SET locked_until = ?, failed_count = 5 WHERE user_id = ?',
        LOCK_UNTIL,
        ADMIN,
      ),
    );
    const snapshot = await snapshotOf();
    await exec(
      insert(
        'UPDATE local_login SET locked_until = ? WHERE user_id = ?',
        '2026-10-15T12:30:00.000Z',
        ADMIN,
      ),
    );
    await expectRefused(loginInput(snapshot, { previousSecretHash: hash(OLD) }), OLD);
  });

  it('refuses a replayed step when the caller reuses the operation id', async () => {
    const snapshot = await snapshotOf();
    await expect(writer.succeed(a, loginInput(snapshot))).resolves.toBe(true);
    const replay = loginInput(snapshot, {
      session: newSession('01J0SESSIONNEW0000000000A2'),
      previousSecretHash: hash('01J0SESSIONNEW0000000000A1'),
    });
    await expect(writer.succeed(a, replay)).resolves.toBe(false);
    expect(await sessionCount()).toBe(2);
    expect(await sessionRow('01J0SESSIONNEW0000000000A2')).toBeUndefined();
    expect((await sessionRow('01J0SESSIONNEW0000000000A1'))?.revoked_at).toBeNull();
  });

  it('revokes nothing when a refused batch names an existing session id', async () => {
    await seedSession('01J0SESSIONEXI0000000000A7');
    const snapshot = await snapshotOf();
    await exec(
      insert('UPDATE local_login SET credential_rev = credential_rev + 1 WHERE user_id = ?', ADMIN),
    );
    const input = loginInput(snapshot, {
      session: newSession('01J0SESSIONEXI0000000000A7'),
      previousSecretHash: hash(OLD),
    });
    await expectRefused(input, OLD);
  });

  it('refuses a snapshot of another organization context', async () => {
    const snapshot = await snapshotOf();
    await expect(writer.succeed(b, loginInput(snapshot))).resolves.toBe(false);
    expect(await sessionCount()).toBe(1);
  });

  it('refuses setup_required and never counts it as a passed TOTP', async () => {
    const snapshot = await snapshotOf();
    await expectRefused(
      loginInput({ ...snapshot, totpState: 'setup_required' }, { previousSecretHash: hash(OLD) }),
      OLD,
    );
  });

  it('refuses a row whose TOTP is enabled without a credential, whatever the snapshot says', async () => {
    await exec(insert('UPDATE local_login SET totp_credential_id = NULL WHERE user_id = ?', ADMIN));
    const snapshot = await snapshotOf();
    expect(snapshot).toMatchObject({ totpEnabled: true, totpState: 'setup_required' });
    await expectRefused(loginInput(snapshot, { previousSecretHash: hash(OLD) }), OLD);
    await expectRefused(
      loginInput({ ...snapshot, totpState: 'none' }, { previousSecretHash: hash(OLD) }),
      OLD,
    );
    await expectRefused(
      loginInput({ ...snapshot, totpState: 'enabled' }, { previousSecretHash: hash(OLD) }),
      OLD,
    );
  });
});

describe('lockout', () => {
  it('accepts the lock written by the fifth attempt itself and clears it with the counter', async () => {
    await exec(insert('UPDATE local_login SET failed_count = 4 WHERE user_id = ?', ADMIN));
    const reservation = await createLocalLoginReader(executor).reserveAttempt(
      a,
      ADMIN,
      NOW,
      LOCK_UNTIL,
    );
    if (!reservation.reserved) throw new Error('the fifth attempt was not reserved');
    expect(reservation.snapshot).toMatchObject({ failedCount: 5, lockedUntil: LOCK_UNTIL });

    await expect(writer.succeed(a, loginInput(reservation.snapshot))).resolves.toBe(true);
    expect(await loginRow()).toMatchObject({ failed_count: 0, locked_until: null });

    const next = await createLocalLoginReader(executor).reserveAttempt(a, ADMIN, LATER, LOCK_UNTIL);
    expect(next.reserved).toBe(true);
  });

  it('accepts a lock that expired at the commit time', async () => {
    await exec(insert('UPDATE local_login SET locked_until = ? WHERE user_id = ?', PAST, ADMIN));
    await expect(writer.succeed(a, loginInput(await snapshotOf()))).resolves.toBe(true);
    expect((await loginRow()).locked_until).toBeNull();
  });
});

describe('concurrent replay', () => {
  let directory: string;
  let file: MigratedDatabase;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'local-login-success-'));
    file = await openMigratedDatabase({
      twoOrganizations: true,
      file: join(directory, 'db.sqlite'),
    });
  });

  afterEach(async () => {
    await file.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('leaves exactly one session when the same step is committed on two connections', async () => {
    if (file.orgs === null) throw new Error('two organizations were not seeded');
    const org = file.orgs.a;
    await file.executor.batch([
      insert(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        ADMIN,
        org.orgId,
        'admin@example.test',
      ),
      insert(
        'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, 1)',
        ROLE,
        org.orgId,
        'organization_admin',
        'organization_admin',
        'organization',
      ),
      insert(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, 'email', ?, 'organization', NULL, ?)",
        ADMIN_GRANT,
        org.orgId,
        'admin@example.test',
        ROLE,
      ),
      insert(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
        CREDENTIAL,
        org.orgId,
      ),
      insert(
        'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, credential_rev) VALUES (?, ?, ?, ?, ?, 3)',
        ADMIN,
        org.orgId,
        PASSWORD_HASH,
        CREDENTIAL,
        NOW,
      ),
    ]);
    const second = await file.second();
    const snapshot = await createLocalLoginReader(file.executor).findByEmail(
      org,
      'admin@example.test',
    );
    if (snapshot === null) throw new Error('snapshot not found');

    const results = await Promise.all([
      createLocalLoginSuccessWriter(file.executor).succeed(org, loginInput(snapshot)),
      createLocalLoginSuccessWriter(second).succeed(
        org,
        loginInput(snapshot, { session: newSession('01J0SESSIONNEW0000000000A2') }),
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await file.executor.all<{ n: number }>(
      insert('SELECT count(*) AS n FROM session'),
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe('re-authentication', () => {
  const OWN = '01J0SESSIONOWN0000000000A1';
  const SIBLING = '01J0SESSIONSIB0000000000A2';

  async function reauthAt(id: string): Promise<unknown> {
    return (await sessionRow(id))?.reauth_at;
  }

  beforeEach(async () => {
    await seedSession(OWN);
    await seedSession(SIBLING);
  });

  it('sets reauth_at on the given local session only and advances the step', async () => {
    const result = await writer.succeed(
      a,
      reauthInput(await snapshotOf(), OWN, { rehash: REHASH }),
    );
    expect(result).toBe(true);
    expect(await reauthAt(OWN)).toBe(NOW);
    expect(await reauthAt(SIBLING)).toBeNull();
    expect(await loginRow()).toMatchObject({
      totp_last_step: STEP,
      password_hash: REHASH,
    });
    expect((await loginRow()).last_op_id).toMatch(MINTED_OP);
    expect(await sessionCount()).toBe(2);
  });

  it('uses one batch and no read for a re-authentication', async () => {
    const counted = countCalls(executor);
    await createLocalLoginSuccessWriter(counted.executor).succeed(
      a,
      reauthInput(await snapshotOf(), OWN),
    );
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
  });

  it('refuses a replayed step without touching the session', async () => {
    const snapshot = await snapshotOf();
    await expect(writer.succeed(a, reauthInput(snapshot, OWN))).resolves.toBe(true);
    await exec(insert('UPDATE session SET reauth_at = NULL WHERE id = ?', OWN));
    await expect(writer.succeed(a, reauthInput(snapshot, OWN))).resolves.toBe(false);
    expect(await reauthAt(OWN)).toBeNull();
  });

  it('moves reauth_at forward only', async () => {
    await exec(insert('UPDATE session SET reauth_at = ? WHERE id = ?', PAST, OWN));
    await expect(writer.succeed(a, reauthInput(await snapshotOf(), OWN))).resolves.toBe(true);
    expect(await reauthAt(OWN)).toBe(NOW);
  });

  it('refuses a session that cannot be re-authenticated and leaves local_login unchanged', async () => {
    await seedSession('01J0SESSIONREV0000000000A3', { revokedAt: PAST });
    await seedSession('01J0SESSIONSSO0000000000A4', { identityId: IDENTITY });
    await seedSession('01J0SESSIONOTH0000000000A5', { userId: OTHER_ADMIN });
    await seedSession('01J0SESSIONEXP0000000000A6', { expiresAt: PAST });
    await seedSession('01J0SESSIONFRE0000000000A8');
    await exec(
      insert('UPDATE session SET reauth_at = ? WHERE id = ?', FUTURE, '01J0SESSIONFRE0000000000A8'),
    );
    const ids = [
      '01J0SESSIONREV0000000000A3',
      '01J0SESSIONSSO0000000000A4',
      '01J0SESSIONOTH0000000000A5',
      '01J0SESSIONEXP0000000000A6',
      '01J0SESSIONFRE0000000000A8',
      '01J0SESSIONNONE000000000A9',
    ];
    const before = await loginRow();
    for (const [index, id] of ids.entries()) {
      const input = reauthInput(await snapshotOf(), id, { step: STEP + index });
      await expect(writer.succeed(a, input)).resolves.toBe(false);
      expect(await loginRow()).toEqual(before);
      expect((await sessionRow(id))?.reauth_at ?? null).toBe(id.includes('FRE') ? FUTURE : null);
    }
  });

  it('refuses a session of another organization context', async () => {
    const before = await loginRow();
    await expect(writer.succeed(b, reauthInput(await snapshotOf(), OWN))).resolves.toBe(false);
    expect(await loginRow()).toEqual(before);
    expect(await reauthAt(OWN)).toBeNull();
  });

  it('refuses after a reset and leaves the step alone', async () => {
    const snapshot = await snapshotOf();
    await exec(
      insert('UPDATE local_login SET credential_rev = credential_rev + 1 WHERE user_id = ?', ADMIN),
    );
    await expect(writer.succeed(a, reauthInput(snapshot, OWN))).resolves.toBe(false);
    expect((await loginRow()).totp_last_step).toBe(LAST_STEP);
    expect(await reauthAt(OWN)).toBeNull();
  });
});

describe('input validation', () => {
  it('rejects input that names both a session and a re-authentication, or neither', async () => {
    const snapshot = await snapshotOf();
    await expect(
      writer.succeed(a, loginInput(snapshot, { reauthSessionId: '01J0SESSIONOWN0000000000A1' })),
    ).rejects.toThrow(TypeError);
    await expect(writer.succeed(a, loginInput(snapshot, { session: null }))).rejects.toThrow(
      TypeError,
    );
  });

  it('rejects a session of a different user than the snapshot', async () => {
    const snapshot = await snapshotOf();
    await expect(
      writer.succeed(
        a,
        loginInput(snapshot, { session: newSession('01J0SESSIONNEW0000000000A1', OTHER_ADMIN) }),
      ),
    ).rejects.toThrow(TypeError);
  });

  it('rejects an identity session and a previous hash equal to the new secret', async () => {
    const snapshot = await snapshotOf();
    const session = newSession('01J0SESSIONNEW0000000000A1');
    await expect(
      writer.succeed(a, loginInput(snapshot, { session: { ...session, identityId: IDENTITY } })),
    ).rejects.toThrow(TypeError);
    await expect(
      writer.succeed(a, loginInput(snapshot, { session, previousSecretHash: session.secretHash })),
    ).rejects.toThrow(TypeError);
  });

  it('rejects a bad step, timestamp and malformed previous hash', async () => {
    const snapshot = await snapshotOf();
    for (const overrides of [
      { step: -1 },
      { step: 1.5 },
      { now: '2026-10-15 12:00:00' },
      { previousSecretHash: 'XYZ' },
    ]) {
      await expect(writer.succeed(a, loginInput(snapshot, overrides))).rejects.toThrow(TypeError);
    }
    expect(await sessionCount()).toBe(0);
  });
});
