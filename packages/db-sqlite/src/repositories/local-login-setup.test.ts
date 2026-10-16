import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type { CredentialRecord } from '@package-broker/core/db/credentials';
import type { LocalLoginSetupWriter } from '@package-broker/core/db/local-login';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { NewSession } from '@package-broker/core/db/sessions';
import { credentialAad } from '@package-broker/core/secrets/cipher';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createLocalLoginSetupWriter } from './local-login-setup.js';

const NOW = '2026-10-15T12:00:00.000Z';
const LATER = '2026-10-15T12:05:00.000Z';
const SETUP_EXPIRES = '2026-10-16T12:00:00.000Z';
const SESSION_EXPIRES = '2026-10-15T20:00:00.000Z';
const LOCKED_UNTIL = '2026-10-15T12:30:00.000Z';

const ADMIN = '01J0USERADMIN00000000000A1';
const PLAIN = '01J0USERPLAIN000000000000A3';
const ADMIN_B = '01J0USERADMIN00000000000B1';
const SETUP_HASH = 'ab'.repeat(32);
const SETUP_HASH_PLAIN = 'ef'.repeat(32);
const SETUP_HASH_B = 'cd'.repeat(32);
const PASSWORD_HASH = 'pbkdf2-sha256$i=100000$v=1$c2FsdA$aGFzaA';
const OLD_CREDENTIAL = '01J0CREDENTIAL00000000000A1';
const NEW_CREDENTIAL = '01J0CREDENTIAL00000000000A2';
const THIRD_CREDENTIAL = '01J0CREDENTIAL00000000000A3';
const OLD_SESSION = '01J0SESSION0000000000000A1';
const NEW_SESSION = '01J0SESSION0000000000000A2';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let writer: LocalLoginSetupWriter;
let opCounter = 0;

function insert(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function opId(): string {
  opCounter += 1;
  return `01J0OP${String(opCounter).padStart(20, '0')}`;
}

function hex(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

function credentialRow(
  ctx: OrgContext,
  id: string,
  overrides: Partial<CredentialRecord & { readonly now: string }> = {},
): CredentialRecord & { readonly now: string } {
  const kind = overrides.kind ?? 'totp';
  return {
    id,
    projectId: null,
    kind,
    sealed: {
      ciphertext: Uint8Array.from({ length: 33 }, (_, index) => (id.length + index) % 256),
      nonce: Uint8Array.from({ length: 12 }, (_, index) => (index * 5 + 1) % 256),
      keyVersion: 1,
    },
    aad: credentialAad({ id, orgId: ctx.orgId, kind }),
    rotatedAt: null,
    now: NOW,
    ...overrides,
  };
}

function stageInput(
  credentialId: string,
  overrides: Partial<Parameters<LocalLoginSetupWriter['stagePendingTotp']>[1]> = {},
): Parameters<LocalLoginSetupWriter['stagePendingTotp']>[1] {
  const now = overrides.now ?? NOW;
  return {
    userId: ADMIN,
    setupHash: SETUP_HASH,
    credential: credentialRow(a, credentialId, { now }),
    now,
    ...overrides,
  };
}

function newSession(overrides: Partial<NewSession> = {}): NewSession {
  return {
    id: NEW_SESSION,
    userId: ADMIN,
    identityId: null,
    secretHash: hex('new-session'),
    csrfHash: hex('csrf'),
    expiresAt: SESSION_EXPIRES,
    ip: null,
    userAgent: null,
    now: LATER,
    ...overrides,
  };
}

function completeInput(
  overrides: Partial<Parameters<LocalLoginSetupWriter['completeSetup']>[1]> = {},
): Parameters<LocalLoginSetupWriter['completeSetup']>[1] {
  return {
    userId: ADMIN,
    setupHash: SETUP_HASH,
    expectedCredentialId: OLD_CREDENTIAL,
    credentialRev: 3,
    passwordHash: PASSWORD_HASH,
    step: 57_000_123,
    session: newSession(),
    previousSecretHash: hex('old-session'),
    now: LATER,
    ...overrides,
  };
}

interface LoginRow {
  readonly password_hash: string | null;
  readonly totp_credential_id: string | null;
  readonly totp_enabled_at: string | null;
  readonly totp_last_step: number | null;
  readonly credential_rev: number;
  readonly setup_hash: string | null;
  readonly setup_expires_at: string | null;
  readonly failed_count: number;
  readonly locked_until: string | null;
  readonly last_op_id: string | null;
  readonly last_login_at: string | null;
}

async function loginRow(userId = ADMIN): Promise<LoginRow> {
  const rows = await executor.all<LoginRow>(
    insert('SELECT * FROM local_login WHERE user_id = ?', userId),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('local_login row is missing');
  return row;
}

async function credentialIds(): Promise<string[]> {
  const rows = await executor.all<{ id: string }>(insert('SELECT id FROM credential ORDER BY id'));
  return rows.map((row) => row.id);
}

async function sessionRows(): Promise<
  { id: string; user_id: string; revoked_at: string | null }[]
> {
  return executor.all(insert('SELECT id, user_id, revoked_at FROM session ORDER BY id'));
}

async function seedPending(): Promise<void> {
  await executor.batch([
    insert(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, ?)",
      OLD_CREDENTIAL,
      a.orgId,
      credentialAad({ id: OLD_CREDENTIAL, orgId: a.orgId, kind: 'totp' }),
    ),
    insert(
      'UPDATE local_login SET totp_credential_id = ? WHERE user_id = ?',
      OLD_CREDENTIAL,
      ADMIN,
    ),
  ]);
}

async function open(file?: string): Promise<void> {
  database = await openMigratedDatabase(
    file === undefined ? { twoOrganizations: true } : { twoOrganizations: true, file },
  );
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  writer = createLocalLoginSetupWriter(executor);
  await seed();
}

async function seed(): Promise<void> {
  await executor.batch([
    insert(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      ADMIN,
      a.orgId,
      'admin@example.test',
      'active',
    ),
    insert(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      PLAIN,
      a.orgId,
      'plain@example.test',
      'active',
    ),
    insert(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      ADMIN_B,
      b.orgId,
      'admin@example.test',
      'active',
    ),
    insert(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'organization_admin', 'organization_admin', 'organization', 1)",
      '01J0ROLEADMINA000000000000',
      a.orgId,
    ),
    insert(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'viewer', 'viewer', 'organization', 0)",
      '01J0ROLEPLAINA000000000000',
      a.orgId,
    ),
    insert(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, 'email', ?, 'organization', NULL, ?)",
      '01J0GRANT1000000000000000A',
      a.orgId,
      'admin@example.test',
      '01J0ROLEADMINA000000000000',
    ),
    insert(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, 'email', ?, 'organization', NULL, ?)",
      '01J0GRANT2000000000000000A',
      a.orgId,
      'plain@example.test',
      '01J0ROLEPLAINA000000000000',
    ),
    insert(
      'INSERT INTO local_login (user_id, org_id, password_hash, credential_rev, failed_count, locked_until, setup_hash, setup_expires_at) VALUES (?, ?, NULL, 3, 4, ?, ?, ?)',
      ADMIN,
      a.orgId,
      LOCKED_UNTIL,
      SETUP_HASH,
      SETUP_EXPIRES,
    ),
    insert(
      'INSERT INTO local_login (user_id, org_id, password_hash, credential_rev, setup_hash, setup_expires_at) VALUES (?, ?, NULL, 0, ?, ?)',
      PLAIN,
      a.orgId,
      SETUP_HASH_PLAIN,
      SETUP_EXPIRES,
    ),
    insert(
      'INSERT INTO local_login (user_id, org_id, password_hash, credential_rev, setup_hash, setup_expires_at) VALUES (?, ?, NULL, 0, ?, ?)',
      ADMIN_B,
      b.orgId,
      SETUP_HASH_B,
      SETUP_EXPIRES,
    ),
    insert(
      'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
      OLD_SESSION,
      a.orgId,
      ADMIN,
      hex('old-session'),
      hex('old-csrf'),
      NOW,
      SESSION_EXPIRES,
    ),
  ]);
}

beforeEach(async () => {
  await open();
});

afterEach(async () => {
  await database.close();
});

describe('stagePendingTotp', () => {
  it('1a: deletes the old pending credential, inserts the new one and references it', async () => {
    await seedPending();
    await expect(writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL))).resolves.toBe(true);
    expect(await credentialIds()).toEqual([NEW_CREDENTIAL]);
    const row = await loginRow();
    expect(row.totp_credential_id).toBe(NEW_CREDENTIAL);
    expect(row.last_op_id).not.toBeNull();
    expect(row.setup_hash).toBe(SETUP_HASH);
    const stored = await executor.all<{ org_id: string; kind: string; aad: string }>(
      insert('SELECT org_id, kind, aad FROM credential WHERE id = ?', NEW_CREDENTIAL),
    );
    expect(stored).toEqual([
      {
        org_id: a.orgId,
        kind: 'totp',
        aad: credentialAad({ id: NEW_CREDENTIAL, orgId: a.orgId, kind: 'totp' }),
      },
    ]);
  });

  it('1b: stages the first credential when none is pending', async () => {
    await expect(writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL))).resolves.toBe(true);
    expect(await credentialIds()).toEqual([NEW_CREDENTIAL]);
    expect((await loginRow()).totp_credential_id).toBe(NEW_CREDENTIAL);
  });

  it('1c: an expired setup deletes nothing and inserts nothing', async () => {
    await seedPending();
    const before = await loginRow();
    await expect(
      writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL, { now: SETUP_EXPIRES })),
    ).resolves.toBe(false);
    await expect(
      writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL, { now: '2026-10-17T00:00:00.000Z' })),
    ).resolves.toBe(false);
    expect(await credentialIds()).toEqual([OLD_CREDENTIAL]);
    expect(await loginRow()).toEqual(before);
  });

  it('1d: a wrong setup hash deletes nothing and inserts nothing', async () => {
    await seedPending();
    const before = await loginRow();
    await expect(
      writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL, { setupHash: 'ee'.repeat(32) })),
    ).resolves.toBe(false);
    await expect(
      writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL, { setupHash: SETUP_HASH_PLAIN })),
    ).resolves.toBe(false);
    expect(await credentialIds()).toEqual([OLD_CREDENTIAL]);
    expect(await loginRow()).toEqual(before);
  });

  it('1e: a cleared setup (already completed) is refused', async () => {
    await seedPending();
    await executor.batch([
      insert(
        'UPDATE local_login SET setup_hash = NULL, setup_expires_at = NULL WHERE user_id = ?',
        ADMIN,
      ),
    ]);
    await expect(writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL))).resolves.toBe(false);
    expect(await credentialIds()).toEqual([OLD_CREDENTIAL]);
  });

  it('1f: another organization cannot stage for the user', async () => {
    await seedPending();
    await expect(
      writer.stagePendingTotp(b, {
        ...stageInput(NEW_CREDENTIAL),
        credential: credentialRow(b, NEW_CREDENTIAL),
      }),
    ).resolves.toBe(false);
    expect(await credentialIds()).toEqual([OLD_CREDENTIAL]);
    expect((await loginRow()).totp_credential_id).toBe(OLD_CREDENTIAL);
  });

  it('1g: an enabled TOTP credential is neither deleted nor replaced', async () => {
    await seedPending();
    await executor.batch([
      insert('UPDATE local_login SET totp_enabled_at = ? WHERE user_id = ?', NOW, ADMIN),
    ]);
    await expect(writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL))).resolves.toBe(false);
    expect(await credentialIds()).toEqual([OLD_CREDENTIAL]);
    expect((await loginRow()).totp_credential_id).toBe(OLD_CREDENTIAL);
  });

  it('1h: a second stage replaces the first', async () => {
    await expect(writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL))).resolves.toBe(true);
    await expect(writer.stagePendingTotp(a, stageInput(THIRD_CREDENTIAL))).resolves.toBe(true);
    expect(await credentialIds()).toEqual([THIRD_CREDENTIAL]);
    expect((await loginRow()).totp_credential_id).toBe(THIRD_CREDENTIAL);
  });

  it('1i: only the pending credential of the staged user is deleted', async () => {
    await executor.batch([
      insert(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, ?)",
        THIRD_CREDENTIAL,
        a.orgId,
        credentialAad({ id: THIRD_CREDENTIAL, orgId: a.orgId, kind: 'totp' }),
      ),
      insert(
        'UPDATE local_login SET totp_credential_id = ? WHERE user_id = ?',
        THIRD_CREDENTIAL,
        PLAIN,
      ),
    ]);
    await expect(writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL))).resolves.toBe(true);
    expect(await credentialIds()).toEqual([THIRD_CREDENTIAL, NEW_CREDENTIAL].sort());
    expect((await loginRow(PLAIN)).totp_credential_id).toBe(THIRD_CREDENTIAL);
  });

  it('1j: statements 2 to 4 change nothing without the marker or after a concurrent restage', async () => {
    await seedPending();
    const before = await loginRow();
    const captured: Statement[] = [];
    const spy: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        captured.push(...statements);
        return [];
      },
    };
    await createLocalLoginSetupWriter(spy).stagePendingTotp(a, stageInput(NEW_CREDENTIAL));
    expect(captured).toHaveLength(4);
    const [mark, ...guarded] = captured;
    if (mark === undefined) throw new Error('the batch is empty');

    const withoutMarker = await executor.batch(guarded);
    expect(withoutMarker.map((result) => result.changes)).toEqual([0, 0, 0]);
    expect(await credentialIds()).toEqual([OLD_CREDENTIAL]);
    expect(await loginRow()).toEqual(before);

    const [marked] = await executor.batch([mark]);
    expect(marked?.changes).toBe(1);
    await executor.batch([
      insert('UPDATE local_login SET last_op_id = ? WHERE user_id = ?', opId(), ADMIN),
    ]);
    const afterRestage = await executor.batch(guarded);
    expect(afterRestage.map((result) => result.changes)).toEqual([0, 0, 0]);
    expect(await credentialIds()).toEqual([OLD_CREDENTIAL]);
    expect((await loginRow()).totp_credential_id).toBe(OLD_CREDENTIAL);
  });

  it('1k: a marker written for another user or organization does not let the statements through', async () => {
    await seedPending();
    const captured: Statement[] = [];
    const spy: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => executor.all(statement),
      batch: async (statements) => {
        captured.push(...statements);
        return [];
      },
    };
    await createLocalLoginSetupWriter(spy).stagePendingTotp(a, stageInput(NEW_CREDENTIAL));
    const [mark, ...guarded] = captured;
    if (mark === undefined) throw new Error('the batch is empty');
    const marker = mark.params[0];
    if (typeof marker !== 'string') throw new Error('the marker is not a string');
    await executor.batch([
      insert(
        'UPDATE local_login SET last_op_id = ? WHERE user_id IN (?, ?)',
        marker,
        PLAIN,
        ADMIN_B,
      ),
    ]);
    const results = await executor.batch(guarded);
    expect(results.map((result) => result.changes)).toEqual([0, 0, 0]);
    expect(await credentialIds()).toEqual([OLD_CREDENTIAL]);
  });

  it('1l: a caller operation id that is already stored does not let a refused stage through', async () => {
    await expect(writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL))).resolves.toBe(true);
    const before = await loginRow();
    await expect(
      writer.stagePendingTotp(a, stageInput(THIRD_CREDENTIAL, { now: SETUP_EXPIRES })),
    ).resolves.toBe(false);
    expect(await credentialIds()).toEqual([NEW_CREDENTIAL]);
    expect(await loginRow()).toEqual(before);
  });

  it('1m: staging a credential id that already exists changes nothing', async () => {
    await executor.batch([
      insert(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, ?)",
        THIRD_CREDENTIAL,
        a.orgId,
        credentialAad({ id: THIRD_CREDENTIAL, orgId: a.orgId, kind: 'totp' }),
      ),
      insert(
        'UPDATE local_login SET totp_credential_id = ? WHERE user_id = ?',
        THIRD_CREDENTIAL,
        PLAIN,
      ),
    ]);
    await seedPending();
    const admin = await loginRow();
    const plain = await loginRow(PLAIN);
    const failure = await writer.stagePendingTotp(a, stageInput(THIRD_CREDENTIAL)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DbError);
    expect((failure as DbError).kind).toBe('unique');
    expect((failure as DbError).constraint).toBe('credential.id');
    expect(await credentialIds()).toEqual([OLD_CREDENTIAL, THIRD_CREDENTIAL].sort());
    expect(await loginRow()).toEqual(admin);
    expect(await loginRow(PLAIN)).toEqual(plain);
  });

  it('5a: is one executor batch and no read', async () => {
    const counted = countCalls(executor);
    await createLocalLoginSetupWriter(counted.executor).stagePendingTotp(
      a,
      stageInput(NEW_CREDENTIAL),
    );
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
    const refused = countCalls(executor);
    await createLocalLoginSetupWriter(refused.executor).stagePendingTotp(
      a,
      stageInput(THIRD_CREDENTIAL, { setupHash: 'ee'.repeat(32) }),
    );
    expect(refused.counts()).toEqual({ all: 0, batch: 1 });
  });

  it('6a: rejects invalid input before any SQL', async () => {
    const counted = countCalls(executor);
    const counting = createLocalLoginSetupWriter(counted.executor);
    await expect(
      counting.stagePendingTotp(a, stageInput(NEW_CREDENTIAL, { setupHash: 'ABC' })),
    ).rejects.toThrow(TypeError);
    await expect(
      counting.stagePendingTotp(a, stageInput(NEW_CREDENTIAL, { now: '2026-10-15' })),
    ).rejects.toThrow(TypeError);
    await expect(
      counting.stagePendingTotp(
        a,
        stageInput(NEW_CREDENTIAL, {
          credential: credentialRow(a, NEW_CREDENTIAL, { kind: 'source.token' }),
        }),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      counting.stagePendingTotp(
        a,
        stageInput(NEW_CREDENTIAL, {
          credential: credentialRow(a, NEW_CREDENTIAL, { projectId: '01J0PROJECT00000000000000A' }),
        }),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      counting.stagePendingTotp(
        a,
        stageInput(NEW_CREDENTIAL, {
          credential: credentialRow(a, NEW_CREDENTIAL, { now: LATER }),
        }),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      counting.stagePendingTotp(
        a,
        stageInput(NEW_CREDENTIAL, {
          credential: { ...credentialRow(a, NEW_CREDENTIAL), aad: 'credential/other' },
        }),
      ),
    ).rejects.toThrow(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});

describe('completeSetup', () => {
  async function staged(): Promise<void> {
    await seedPending();
  }

  it('4a: sets the password, enables TOTP, clears the setup, inserts the session, revokes the previous one', async () => {
    await staged();
    const input = completeInput();
    await expect(writer.completeSetup(a, input)).resolves.toBe(true);
    const row = await loginRow();
    expect(row).toMatchObject({
      password_hash: PASSWORD_HASH,
      totp_credential_id: OLD_CREDENTIAL,
      totp_enabled_at: LATER,
      totp_last_step: 57_000_123,
      credential_rev: 4,
      setup_hash: null,
      setup_expires_at: null,
      failed_count: 0,
      locked_until: null,
      last_login_at: LATER,
    });
    expect(row.last_op_id).not.toBeNull();
    expect(await sessionRows()).toEqual([
      { id: OLD_SESSION, user_id: ADMIN, revoked_at: LATER },
      { id: NEW_SESSION, user_id: ADMIN, revoked_at: null },
    ]);
  });

  it('4b: without a previous session hash nothing is revoked', async () => {
    await staged();
    await expect(
      writer.completeSetup(a, completeInput({ previousSecretHash: null })),
    ).resolves.toBe(true);
    expect(await sessionRows()).toEqual([
      { id: OLD_SESSION, user_id: ADMIN, revoked_at: null },
      { id: NEW_SESSION, user_id: ADMIN, revoked_at: null },
    ]);
  });

  it('2a: a completion naming the first staged credential after a restage is refused', async () => {
    await expect(writer.stagePendingTotp(a, stageInput(OLD_CREDENTIAL))).resolves.toBe(true);
    await expect(writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL))).resolves.toBe(true);
    const before = await loginRow();
    await expect(writer.completeSetup(a, completeInput())).resolves.toBe(false);
    expect(await loginRow()).toEqual(before);
    expect((await loginRow()).password_hash).toBeNull();
    expect(await sessionRows()).toEqual([{ id: OLD_SESSION, user_id: ADMIN, revoked_at: null }]);
  });

  it('2b: a completion naming the credential staged last succeeds', async () => {
    await expect(writer.stagePendingTotp(a, stageInput(OLD_CREDENTIAL))).resolves.toBe(true);
    await expect(writer.stagePendingTotp(a, stageInput(NEW_CREDENTIAL))).resolves.toBe(true);
    await expect(
      writer.completeSetup(a, completeInput({ expectedCredentialId: NEW_CREDENTIAL })),
    ).resolves.toBe(true);
    expect((await loginRow()).totp_credential_id).toBe(NEW_CREDENTIAL);
  });

  it('3a: is refused after the admin grant was removed', async () => {
    await staged();
    await executor.batch([
      insert('DELETE FROM access_grant WHERE id = ?', '01J0GRANT1000000000000000A'),
    ]);
    const before = await loginRow();
    await expect(writer.completeSetup(a, completeInput())).resolves.toBe(false);
    expect(await loginRow()).toEqual(before);
    expect(await sessionRows()).toEqual([{ id: OLD_SESSION, user_id: ADMIN, revoked_at: null }]);
  });

  it('3b: is refused for a role that does not protect the last holder', async () => {
    await executor.batch([
      insert(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, ?)",
        OLD_CREDENTIAL,
        a.orgId,
        credentialAad({ id: OLD_CREDENTIAL, orgId: a.orgId, kind: 'totp' }),
      ),
      insert(
        'UPDATE local_login SET totp_credential_id = ? WHERE user_id = ?',
        OLD_CREDENTIAL,
        PLAIN,
      ),
    ]);
    await expect(
      writer.completeSetup(
        a,
        completeInput({
          userId: PLAIN,
          setupHash: SETUP_HASH_PLAIN,
          credentialRev: 0,
          session: newSession({ userId: PLAIN }),
          previousSecretHash: null,
        }),
      ),
    ).resolves.toBe(false);
    expect((await loginRow(PLAIN)).password_hash).toBeNull();
  });

  it('3c: is refused for a suspended user', async () => {
    await staged();
    await executor.batch([
      insert("UPDATE user_account SET status = 'suspended' WHERE id = ?", ADMIN),
    ]);
    await expect(writer.completeSetup(a, completeInput())).resolves.toBe(false);
    expect((await loginRow()).password_hash).toBeNull();
    expect(await sessionRows()).toEqual([{ id: OLD_SESSION, user_id: ADMIN, revoked_at: null }]);
  });

  it('3d: is refused with a stale credential revision', async () => {
    await staged();
    const before = await loginRow();
    await expect(writer.completeSetup(a, completeInput({ credentialRev: 2 }))).resolves.toBe(false);
    await expect(writer.completeSetup(a, completeInput({ credentialRev: 4 }))).resolves.toBe(false);
    expect(await loginRow()).toEqual(before);
    expect(await sessionRows()).toEqual([{ id: OLD_SESSION, user_id: ADMIN, revoked_at: null }]);
  });

  it('3e: is refused for an expired setup, a wrong hash and another organization', async () => {
    await staged();
    const before = await loginRow();
    await expect(
      writer.completeSetup(
        a,
        completeInput({ now: SETUP_EXPIRES, session: newSession({ now: SETUP_EXPIRES }) }),
      ),
    ).resolves.toBe(false);
    await expect(
      writer.completeSetup(a, completeInput({ setupHash: 'ee'.repeat(32) })),
    ).resolves.toBe(false);
    await expect(writer.completeSetup(b, completeInput())).resolves.toBe(false);
    expect(await loginRow()).toEqual(before);
    expect(await sessionRows()).toEqual([{ id: OLD_SESSION, user_id: ADMIN, revoked_at: null }]);
  });

  it('3f: is refused a second time once the setup was cleared', async () => {
    await staged();
    await expect(writer.completeSetup(a, completeInput())).resolves.toBe(true);
    await expect(
      writer.completeSetup(
        a,
        completeInput({
          credentialRev: 4,
          previousSecretHash: null,
          session: newSession({ id: '01J0SESSION0000000000000A3', secretHash: hex('third') }),
        }),
      ),
    ).resolves.toBe(false);
    expect(await sessionRows()).toHaveLength(2);
  });

  it('4c: a failed completion leaves the previous session alive', async () => {
    await staged();
    await expect(writer.completeSetup(a, completeInput({ credentialRev: 99 }))).resolves.toBe(
      false,
    );
    expect(await sessionRows()).toEqual([{ id: OLD_SESSION, user_id: ADMIN, revoked_at: null }]);
  });

  it('5b: is one executor batch and no read, also when refused', async () => {
    await staged();
    const counted = countCalls(executor);
    const counting = createLocalLoginSetupWriter(counted.executor);
    await counting.completeSetup(a, completeInput({ credentialRev: 99 }));
    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
    await counting.completeSetup(a, completeInput());
    expect(counted.counts()).toEqual({ all: 0, batch: 2 });
  });

  it('1l: a caller operation id used by the stage does not let a refused completion insert a session', async () => {
    await expect(writer.stagePendingTotp(a, stageInput(OLD_CREDENTIAL))).resolves.toBe(true);
    const before = await loginRow();
    await expect(writer.completeSetup(a, completeInput({ credentialRev: 2 }))).resolves.toBe(false);
    expect(await loginRow()).toEqual(before);
    expect(await sessionRows()).toEqual([{ id: OLD_SESSION, user_id: ADMIN, revoked_at: null }]);
  });

  it('6b: rejects invalid input before any SQL', async () => {
    const counted = countCalls(executor);
    const counting = createLocalLoginSetupWriter(counted.executor);
    await expect(
      counting.completeSetup(a, completeInput({ session: newSession({ userId: PLAIN }) })),
    ).rejects.toThrow(TypeError);
    await expect(counting.completeSetup(a, completeInput({ setupHash: 'xyz' }))).rejects.toThrow(
      TypeError,
    );
    await expect(counting.completeSetup(a, completeInput({ now: 'yesterday' }))).rejects.toThrow(
      TypeError,
    );
    await expect(
      counting.completeSetup(
        a,
        completeInput({ session: newSession({ identityId: OLD_SESSION }) }),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      counting.completeSetup(a, completeInput({ session: newSession({ now: NOW }) })),
    ).rejects.toThrow(TypeError);
    await expect(
      counting.completeSetup(a, completeInput({ passwordHash: 'plain-text' })),
    ).rejects.toThrow(TypeError);
    await expect(counting.completeSetup(a, completeInput({ passwordHash: '' }))).rejects.toThrow(
      TypeError,
    );
    await expect(counting.completeSetup(a, completeInput({ step: -1 }))).rejects.toThrow(
      RangeError,
    );
    await expect(counting.completeSetup(a, completeInput({ step: 1.5 }))).rejects.toThrow(
      RangeError,
    );
    await expect(counting.completeSetup(a, completeInput({ credentialRev: -1 }))).rejects.toThrow(
      RangeError,
    );
    await expect(
      counting.completeSetup(a, completeInput({ previousSecretHash: 'short' })),
    ).rejects.toThrow(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});

describe('two connections', () => {
  let directory: string;

  beforeEach(async () => {
    await database.close();
    directory = await mkdtemp(join(tmpdir(), 'local-login-setup-'));
    await open(join(directory, 'race.db'));
    await seedPending();
  });

  afterEach(async () => {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('4d: a second completion after the first is refused and leaves one new session', async () => {
    const other = createLocalLoginSetupWriter(await database.second());
    const results = await Promise.all([
      writer.completeSetup(a, completeInput()),
      other.completeSetup(
        a,
        completeInput({
          session: newSession({ id: '01J0SESSION0000000000000A3', secretHash: hex('second') }),
          previousSecretHash: null,
        }),
      ),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await loginRow()).credential_rev).toBe(4);
    expect(await sessionRows()).toHaveLength(2);
  });

  it('4e: a restage and a completion issued together on two connections: exactly one applies', async () => {
    const other = createLocalLoginSetupWriter(await database.second());
    const [completed, staged] = await Promise.all([
      writer.completeSetup(a, completeInput()),
      other.stagePendingTotp(a, stageInput(NEW_CREDENTIAL)),
    ]);
    expect([completed, staged].filter(Boolean)).toHaveLength(1);
    const row = await loginRow();
    if (completed) {
      expect(row.password_hash).toBe(PASSWORD_HASH);
      expect(row.totp_credential_id).toBe(OLD_CREDENTIAL);
      expect(await credentialIds()).toEqual([OLD_CREDENTIAL]);
    } else {
      expect(row.password_hash).toBeNull();
      expect(row.totp_credential_id).toBe(NEW_CREDENTIAL);
      expect(await credentialIds()).toEqual([NEW_CREDENTIAL]);
      expect(await sessionRows()).toEqual([{ id: OLD_SESSION, user_id: ADMIN, revoked_at: null }]);
    }
  });
});
