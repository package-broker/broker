import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { LocalLoginReader } from '@package-broker/core/db/local-login';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createLocalLoginReader } from './local-login.js';

const NOW = '2026-10-15T12:00:00.000Z';
const LOCK_UNTIL = '2026-10-15T12:15:00.000Z';
const AFTER_LOCK = '2026-10-15T12:15:00.001Z';
const LATER = '2026-10-15T13:00:00.000Z';
const LATER_LOCK = '2026-10-15T13:15:00.000Z';
const SETUP_EXPIRES = '2026-10-16T12:00:00.000Z';

const ADMIN = '01J0USERADMIN00000000000A1';
const PROJECT_ONLY = '01J0USERPROJECT0000000000A2';
const UNPROTECTED = '01J0USERPLAIN000000000000A3';
const SUSPENDED = '01J0USERSUSPENDED00000000A4';
const NO_LOGIN = '01J0USERNOLOGIN0000000000A5';
const ADMIN_B = '01J0USERADMIN00000000000B1';

const PASSWORD_HASH = 'pbkdf2-sha256$i=100000$v=1$c2FsdA$aGFzaA';
const CREDENTIAL = '01J0CREDENTIAL000000000000A';
const SETUP_HASH = 'ab'.repeat(32);
const SETUP_HASH_B = 'cd'.repeat(32);

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let reader: LocalLoginReader;

function insert(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function user(org: OrgContext, id: string, email: string, status = 'active'): Statement {
  return insert(
    'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
    id,
    org.orgId,
    email,
    status,
  );
}

function role(
  org: OrgContext,
  id: string,
  key: string,
  scope: string,
  protects: number,
): Statement {
  return insert(
    'INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    key,
    key,
    scope,
    protects,
  );
}

function grant(
  org: OrgContext,
  id: string,
  email: string,
  roleId: string,
  projectId: string | null,
): Statement {
  return insert(
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, 'email', ?, ?, ?, ?)",
    id,
    org.orgId,
    email,
    projectId === null ? 'organization' : 'project',
    projectId,
    roleId,
  );
}

function credential(org: OrgContext, id: string): Statement {
  return insert(
    "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'aad')",
    id,
    org.orgId,
  );
}

interface LoginSeed {
  readonly passwordHash?: string | null;
  readonly credentialId?: string | null;
  readonly enabledAt?: string | null;
  readonly lastStep?: number | null;
  readonly rev?: number;
  readonly failed?: number;
  readonly lockedUntil?: string | null;
  readonly setupHash?: string | null;
  readonly setupExpiresAt?: string | null;
}

function login(org: OrgContext, userId: string, seed: LoginSeed = {}): Statement {
  const setupHash = seed.setupHash ?? null;
  return insert(
    'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, totp_last_step, credential_rev, failed_count, locked_until, setup_hash, setup_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    userId,
    org.orgId,
    seed.passwordHash === undefined ? PASSWORD_HASH : seed.passwordHash,
    seed.credentialId ?? null,
    seed.enabledAt ?? null,
    seed.lastStep ?? null,
    seed.rev ?? 0,
    seed.failed ?? 0,
    seed.lockedUntil ?? null,
    setupHash,
    setupHash === null ? null : (seed.setupExpiresAt ?? SETUP_EXPIRES),
  );
}

async function failedCount(userId: string): Promise<number> {
  const rows = await executor.all<{ failed_count: number }>(
    insert('SELECT failed_count FROM local_login WHERE user_id = ?', userId),
  );
  return rows[0]?.failed_count ?? -1;
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  reader = createLocalLoginReader(executor);
  await executor.batch([
    user(a, ADMIN, 'admin@example.test'),
    user(a, PROJECT_ONLY, 'project@example.test'),
    user(a, UNPROTECTED, 'plain@example.test'),
    user(a, SUSPENDED, 'suspended@example.test', 'suspended'),
    user(a, NO_LOGIN, 'nologin@example.test'),
    user(b, ADMIN_B, 'admin@example.test'),
    role(a, '01J0ROLEADMINA000000000000', 'organization_admin', 'organization', 1),
    role(a, '01J0ROLEPLAINA000000000000', 'viewer', 'organization', 0),
    role(a, '01J0ROLEPROJECTA0000000000', 'project_admin', 'project', 1),
    role(b, '01J0ROLEADMINB000000000000', 'organization_admin', 'organization', 1),
    insert(
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      '01J0PROJECTA00000000000000',
      a.orgId,
      'proj',
      'Project',
    ),
    grant(
      a,
      '01J0GRANT1000000000000000A',
      'admin@example.test',
      '01J0ROLEADMINA000000000000',
      null,
    ),
    grant(
      a,
      '01J0GRANT2000000000000000A',
      'project@example.test',
      '01J0ROLEPROJECTA0000000000',
      '01J0PROJECTA00000000000000',
    ),
    grant(
      a,
      '01J0GRANT3000000000000000A',
      'plain@example.test',
      '01J0ROLEPLAINA000000000000',
      null,
    ),
    grant(
      a,
      '01J0GRANT4000000000000000A',
      'suspended@example.test',
      '01J0ROLEADMINA000000000000',
      null,
    ),
    grant(
      b,
      '01J0GRANT1000000000000000B',
      'admin@example.test',
      '01J0ROLEADMINB000000000000',
      null,
    ),
    credential(a, CREDENTIAL),
    login(a, ADMIN, {
      credentialId: CREDENTIAL,
      enabledAt: NOW,
      lastStep: 57_000_001,
      rev: 7,
    }),
    login(a, PROJECT_ONLY),
    login(a, UNPROTECTED),
    login(a, SUSPENDED),
    login(b, ADMIN_B, { passwordHash: null, setupHash: SETUP_HASH_B }),
  ]);
});

afterEach(async () => {
  await database.close();
});

describe('findByEmail', () => {
  it('returns the snapshot of the local login', async () => {
    await expect(reader.findByEmail(a, 'admin@example.test')).resolves.toEqual({
      userId: ADMIN,
      email: 'admin@example.test',
      userActive: true,
      adminEligible: true,
      passwordHash: PASSWORD_HASH,
      totpCredentialId: CREDENTIAL,
      totpEnabled: true,
      totpState: 'enabled',
      totpLastStep: 57_000_001,
      credentialRev: 7,
      failedCount: 0,
      lockedUntil: null,
    });
  });

  it('compares the e-mail lower-cased', async () => {
    const found = await reader.findByEmail(a, 'Admin@Example.TEST');
    expect(found?.userId).toBe(ADMIN);
  });

  it('trims the e-mail and returns null without a query for one that is not valid', async () => {
    const found = await reader.findByEmail(a, '  admin@example.test ');
    expect(found?.userId).toBe(ADMIN);
    const counted = countCalls(executor);
    const counting = createLocalLoginReader(counted.executor);
    await expect(counting.findByEmail(a, 'not-an-email')).resolves.toBeNull();
    await expect(counting.findByEmail(a, 'a@b@example.test')).resolves.toBeNull();
    await expect(counting.findByEmail(a, '')).resolves.toBeNull();
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });

  it('is null for an unknown e-mail and for a user without a local login', async () => {
    await expect(reader.findByEmail(a, 'nobody@example.test')).resolves.toBeNull();
    await expect(reader.findByEmail(a, 'nologin@example.test')).resolves.toBeNull();
  });

  it('is scoped to the organization', async () => {
    const inA = await reader.findByEmail(a, 'admin@example.test');
    const inB = await reader.findByEmail(b, 'admin@example.test');
    expect(inA?.userId).toBe(ADMIN);
    expect(inB?.userId).toBe(ADMIN_B);
    expect(inB?.passwordHash).toBeNull();
    await expect(reader.findByEmail(b, 'plain@example.test')).resolves.toBeNull();
  });

  it('reports TOTP as not enabled before setup', async () => {
    const found = await reader.findByEmail(a, 'plain@example.test');
    expect(found).toMatchObject({
      totpEnabled: false,
      totpState: 'none',
      totpCredentialId: null,
      totpLastStep: null,
    });
  });

  it('keeps totpEnabled true and the credential null once the credential is deleted', async () => {
    await executor.batch([insert('DELETE FROM credential WHERE id = ?', CREDENTIAL)]);
    const found = await reader.findByEmail(a, 'admin@example.test');
    expect(found).toMatchObject({
      totpEnabled: true,
      totpState: 'setup_required',
      totpCredentialId: null,
    });
  });

  it('uses one executor call', async () => {
    const counted = countCalls(executor);
    await createLocalLoginReader(counted.executor).findByEmail(a, 'admin@example.test');
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
  });
});

describe('adminEligible', () => {
  it('is true with an organization e-mail grant of a protected role', async () => {
    const found = await reader.findByEmail(a, 'admin@example.test');
    expect(found?.adminEligible).toBe(true);
  });

  it('is false with a project grant', async () => {
    const found = await reader.findByEmail(a, 'project@example.test');
    expect(found).toMatchObject({ adminEligible: false, userActive: true });
  });

  it('is false with a role that is not protected', async () => {
    const found = await reader.findByEmail(a, 'plain@example.test');
    expect(found).toMatchObject({ adminEligible: false, userActive: true });
  });

  it('is false for a suspended user', async () => {
    const found = await reader.findByEmail(a, 'suspended@example.test');
    expect(found).toMatchObject({ adminEligible: false, userActive: false });
  });

  it('is false without any grant', async () => {
    await executor.batch([
      insert(
        'DELETE FROM access_grant WHERE org_id = ? AND subject_value = ?',
        a.orgId,
        'admin@example.test',
      ),
    ]);
    const found = await reader.findByEmail(a, 'admin@example.test');
    expect(found?.adminEligible).toBe(false);
  });

  it('is reported by reserveAttempt as well', async () => {
    const admin = await reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL);
    const plain = await reader.reserveAttempt(a, UNPROTECTED, NOW, LOCK_UNTIL);
    expect(admin).toMatchObject({ reserved: true, snapshot: { adminEligible: true } });
    expect(plain).toMatchObject({ reserved: true, snapshot: { adminEligible: false } });
  });
});

describe('findBySetupHash', () => {
  beforeEach(async () => {
    await executor.batch([
      insert(
        'UPDATE local_login SET password_hash = NULL, setup_hash = ?, setup_expires_at = ? WHERE user_id = ?',
        SETUP_HASH,
        SETUP_EXPIRES,
        UNPROTECTED,
      ),
    ]);
  });

  it('returns the snapshot of an unexpired setup', async () => {
    const found = await reader.findBySetupHash(a, SETUP_HASH, NOW);
    expect(found).toMatchObject({
      userId: UNPROTECTED,
      passwordHash: null,
      adminEligible: false,
    });
  });

  it('ignores an expired setup, including one expiring exactly now', async () => {
    await expect(reader.findBySetupHash(a, SETUP_HASH, SETUP_EXPIRES)).resolves.toBeNull();
    await expect(
      reader.findBySetupHash(a, SETUP_HASH, '2026-10-16T12:00:00.001Z'),
    ).resolves.toBeNull();
    const found = await reader.findBySetupHash(a, SETUP_HASH, '2026-10-16T11:59:59.999Z');
    expect(found?.userId).toBe(UNPROTECTED);
  });

  it('is null for an unknown hash', async () => {
    await expect(reader.findBySetupHash(a, 'ef'.repeat(32), NOW)).resolves.toBeNull();
  });

  it('does not cross organizations', async () => {
    await expect(reader.findBySetupHash(a, SETUP_HASH_B, NOW)).resolves.toBeNull();
    await expect(reader.findBySetupHash(b, SETUP_HASH, NOW)).resolves.toBeNull();
    const found = await reader.findBySetupHash(b, SETUP_HASH_B, NOW);
    expect(found?.userId).toBe(ADMIN_B);
  });

  it('rejects a malformed hash or timestamp before any SQL', async () => {
    const counted = countCalls(executor);
    const guarded = createLocalLoginReader(counted.executor);
    await expect(guarded.findBySetupHash(a, 'AB'.repeat(32), NOW)).rejects.toThrow(TypeError);
    await expect(guarded.findBySetupHash(a, 'ab', NOW)).rejects.toThrow(TypeError);
    await expect(guarded.findBySetupHash(a, SETUP_HASH, '2026-10-15')).rejects.toThrow(TypeError);
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});

describe('reserveAttempt', () => {
  it('returns the current credential state with the counted attempt', async () => {
    const result = await reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL);
    expect(result).toEqual({
      reserved: true,
      snapshot: {
        userId: ADMIN,
        email: 'admin@example.test',
        userActive: true,
        adminEligible: true,
        passwordHash: PASSWORD_HASH,
        totpCredentialId: CREDENTIAL,
        totpEnabled: true,
        totpState: 'enabled',
        totpLastStep: 57_000_001,
        credentialRev: 7,
        failedCount: 1,
        lockedUntil: null,
      },
    });
    await expect(failedCount(ADMIN)).resolves.toBe(1);
  });

  it('uses one executor call when it reserves and two when it refuses', async () => {
    const counted = countCalls(executor);
    const counting = createLocalLoginReader(counted.executor);
    await counting.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL);
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    await counting.reserveAttempt(a, 'unknown-user', NOW, LOCK_UNTIL);
    expect(counted.counts()).toEqual({ all: 3, batch: 0 });
  });

  it('reports a missing user and does not count against another organization', async () => {
    await expect(reader.reserveAttempt(a, 'unknown-user', NOW, LOCK_UNTIL)).resolves.toEqual({
      reserved: false,
      reason: 'missing',
    });
    await expect(reader.reserveAttempt(a, NO_LOGIN, NOW, LOCK_UNTIL)).resolves.toEqual({
      reserved: false,
      reason: 'missing',
    });
    await expect(reader.reserveAttempt(b, ADMIN, NOW, LOCK_UNTIL)).resolves.toEqual({
      reserved: false,
      reason: 'missing',
    });
    await expect(failedCount(ADMIN)).resolves.toBe(0);
  });

  it('locks on the fifth attempt and refuses the sixth without counting it', async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL);
      expect(result).toMatchObject({
        reserved: true,
        snapshot: { failedCount: attempt, lockedUntil: null },
      });
    }
    const fifth = await reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL);
    expect(fifth).toMatchObject({
      reserved: true,
      snapshot: { failedCount: 5, lockedUntil: LOCK_UNTIL },
    });
    await expect(reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL)).resolves.toEqual({
      reserved: false,
      reason: 'locked',
    });
    await expect(failedCount(ADMIN)).resolves.toBe(5);
  });

  it('keeps refusing until the lock expires and accepts it from lockedUntil on', async () => {
    await executor.batch([
      insert(
        'UPDATE local_login SET failed_count = 5, locked_until = ? WHERE user_id = ?',
        LOCK_UNTIL,
        ADMIN,
      ),
    ]);
    await expect(
      reader.reserveAttempt(a, ADMIN, '2026-10-15T12:14:59.999Z', LATER_LOCK),
    ).resolves.toMatchObject({ reserved: false, reason: 'locked' });
    await expect(reader.reserveAttempt(a, ADMIN, LOCK_UNTIL, LATER_LOCK)).resolves.toMatchObject({
      reserved: true,
      snapshot: { failedCount: 6 },
    });
  });

  it('resumes after the lock expires and locks again on the tenth consecutive failure', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL);
    }
    for (let attempt = 6; attempt <= 9; attempt += 1) {
      const result = await reader.reserveAttempt(a, ADMIN, AFTER_LOCK, LATER_LOCK);
      expect(result).toMatchObject({ reserved: true, snapshot: { failedCount: attempt } });
      if (result.reserved) expect(result.snapshot.lockedUntil).toBe(LOCK_UNTIL);
    }
    const tenth = await reader.reserveAttempt(a, ADMIN, AFTER_LOCK, LATER_LOCK);
    expect(tenth).toMatchObject({
      reserved: true,
      snapshot: { failedCount: 10, lockedUntil: LATER_LOCK },
    });
    await expect(reader.reserveAttempt(a, ADMIN, LATER, LATER_LOCK)).resolves.toMatchObject({
      reserved: false,
      reason: 'locked',
    });
    await expect(failedCount(ADMIN)).resolves.toBe(10);
  });

  it('reserves for a user whose credential was deleted and reports setup state', async () => {
    await executor.batch([insert('DELETE FROM credential WHERE id = ?', CREDENTIAL)]);
    const result = await reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL);
    expect(result).toMatchObject({
      reserved: true,
      snapshot: { totpEnabled: true, totpState: 'setup_required', totpCredentialId: null },
    });
  });

  it('rejects a lockUntil that is not after now before any SQL', async () => {
    const counted = countCalls(executor);
    const guarded = createLocalLoginReader(counted.executor);
    await expect(guarded.reserveAttempt(a, ADMIN, NOW, NOW)).rejects.toThrow(RangeError);
    await expect(guarded.reserveAttempt(a, ADMIN, NOW, '2026-10-15T11:59:59.999Z')).rejects.toThrow(
      RangeError,
    );
    await expect(
      guarded.reserveAttempt(a, ADMIN, NOW, '2026-10-15T12:00:00.001Z'),
    ).resolves.toMatchObject({ reserved: true });
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
  });

  it('reports a row whose user belongs to another organization as missing and leaves it alone', async () => {
    const stray = '01J0USERSTRAY0000000000B2';
    await executor.batch([user(b, stray, 'stray@example.test'), login(a, stray)]);
    await expect(reader.reserveAttempt(a, stray, NOW, LOCK_UNTIL)).resolves.toEqual({
      reserved: false,
      reason: 'missing',
    });
    await expect(failedCount(stray)).resolves.toBe(0);
  });

  it('still reserves for a suspended user and reports the user as inactive', async () => {
    const result = await reader.reserveAttempt(a, SUSPENDED, NOW, LOCK_UNTIL);
    expect(result).toMatchObject({
      reserved: true,
      snapshot: { userId: SUSPENDED, userActive: false, adminEligible: false, failedCount: 1 },
    });
  });

  it('leaves other users in the organization untouched', async () => {
    await reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL);
    await reader.reserveAttempt(a, ADMIN, NOW, LOCK_UNTIL);
    const rows = await executor.all<{
      user_id: string;
      failed_count: number;
      locked_until: string | null;
      updated_at: string;
    }>(
      insert(
        'SELECT user_id, failed_count, locked_until, updated_at FROM local_login WHERE user_id <> ? AND org_id = ? ORDER BY user_id',
        ADMIN,
        a.orgId,
      ),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.failed_count).toBe(0);
      expect(row.locked_until).toBeNull();
      expect(row.updated_at).not.toBe(NOW);
    }
  });

  it('rejects malformed timestamps before any SQL', async () => {
    const counted = countCalls(executor);
    const guarded = createLocalLoginReader(counted.executor);
    await expect(guarded.reserveAttempt(a, ADMIN, '2026-10-15', LOCK_UNTIL)).rejects.toThrow(
      TypeError,
    );
    await expect(guarded.reserveAttempt(a, ADMIN, NOW, 'tomorrow')).rejects.toThrow(TypeError);
    await expect(guarded.reserveAttempt(a, ADMIN, NOW, '2026-02-30T12:00:00.000Z')).rejects.toThrow(
      TypeError,
    );
    expect(counted.counts()).toEqual({ all: 0, batch: 0 });
  });
});

describe('reserveAttempt under concurrency', () => {
  it('lets exactly five of six concurrent attempts through on two connections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pb-local-login-'));
    const file = await openMigratedDatabase({
      twoOrganizations: true,
      file: join(directory, 'store.sqlite'),
    });
    try {
      if (file.orgs === null) throw new Error('two organizations were not seeded');
      const org = file.orgs.a;
      await file.executor.batch([
        user(org, ADMIN, 'admin@example.test'),
        login(org, ADMIN, { rev: 3 }),
      ]);
      const readers = [
        createLocalLoginReader(file.executor),
        createLocalLoginReader(await file.second()),
      ];
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          (readers[index % 2] as LocalLoginReader).reserveAttempt(org, ADMIN, NOW, LOCK_UNTIL),
        ),
      );
      expect(results.filter((result) => result.reserved)).toHaveLength(5);
      const refused = results.filter((result) => !result.reserved);
      expect(refused).toEqual([{ reserved: false, reason: 'locked' }]);
      const counts = results
        .flatMap((result) => (result.reserved ? [result.snapshot.failedCount] : []))
        .sort();
      expect(counts).toEqual([1, 2, 3, 4, 5]);
      const rows = await file.executor.all<{ failed_count: number }>(
        insert('SELECT failed_count FROM local_login WHERE user_id = ?', ADMIN),
      );
      expect(rows).toEqual([{ failed_count: 5 }]);
    } finally {
      await file.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
