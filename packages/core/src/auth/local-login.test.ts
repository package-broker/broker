import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalLoginService } from './local-login.js';
import type { LocalLoginService } from './local-login.js';
import { hashPassword, PASSWORD_HASH_PATTERN, verifyPassword } from './password.js';
import { sha256Hex } from './primitives.js';
import { createSessionService, SESSION_ABSOLUTE_MS } from './session.js';
import type { AuthenticatedSession, SessionMeta } from './session.js';
import { encodeTotpEnvelope, generateTotpSecret, totpCode } from './totp.js';
import type { CredentialRecord, CredentialRepository } from '../db/credentials.js';
import type {
  LocalLoginSnapshot,
  LocalLoginSuccessWriter,
  Reservation,
} from '../db/local-login.js';
import { orgContext } from '../db/port.js';
import type { ActiveSession } from '../db/sessions.js';
import { fixedClock, ulid } from '../ids.js';
import { createSecretCipher } from '../secrets/cipher.js';
import { createCredentialStore } from '../secrets/credential-store.js';
import { createKeyring } from '../secrets/keyring.js';
import type { MasterKey } from '../secrets/master-key.js';

const NOW = '2026-10-15T12:00:10.000Z';
const NOW_MS = Date.parse(NOW);
const STEP = Math.floor(NOW_MS / 30_000);
const LOCK_UNTIL = '2026-10-15T12:15:10.000Z';
const ORG = orgContext('01J0ORGA00000000000000000A');
const OTHER_ORG = orgContext('01J0ORGB00000000000000000B');
const USER_ID = '01J0USERA0000000000000000A';
const OTHER_USER_ID = '01J0USERB0000000000000000B';
const EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://broker.example.test';
const SESSION_ID = '01J0SESSION00000000000000S1';

function masterKey(version: number, start: number): MasterKey {
  return { version, bytes: Uint8Array.from({ length: 32 }, (_, index) => start + index) };
}

const V1 = (): MasterKey => masterKey(1, 0x00);
const V2 = (): MasterKey => masterKey(2, 0x20);

const META: SessionMeta = {
  ip: '203.0.113.7',
  userAgent: 'agent/1.0',
  previousSecretHash: 'b'.repeat(64),
};

interface Counts {
  pbkdf2: number;
  aes: number;
  sha1: number;
}

function counted<T>(
  events: string[] | null,
  run: () => Promise<T>,
): Promise<{ counts: Counts; value: T }> {
  const counts: Counts = { pbkdf2: 0, aes: 0, sha1: 0 };
  const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  const sign = crypto.subtle.sign.bind(crypto.subtle);
  const deriveBitsSpy = vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(((
    ...args: Parameters<typeof deriveBits>
  ) => {
    if ((args[0] as { name: string }).name === 'PBKDF2') {
      counts.pbkdf2 += 1;
      events?.push('pbkdf2');
    }
    return deriveBits(...args);
  }) as typeof deriveBits);
  const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(((
    ...args: Parameters<typeof decrypt>
  ) => {
    if ((args[0] as { name: string }).name === 'AES-GCM') counts.aes += 1;
    return decrypt(...args);
  }) as typeof decrypt);
  const signSpy = vi.spyOn(crypto.subtle, 'sign').mockImplementation(((
    ...args: Parameters<typeof sign>
  ) => {
    const algorithm = (
      args[1] as unknown as { algorithm: { name: string; hash?: { name: string } } }
    ).algorithm;
    if (algorithm.name === 'HMAC' && algorithm.hash?.name === 'SHA-1') counts.sha1 += 1;
    return sign(...args);
  }) as typeof sign);
  return run()
    .then((value) => ({ counts, value }))
    .finally(() => {
      deriveBitsSpy.mockRestore();
      decryptSpy.mockRestore();
      signSpy.mockRestore();
    });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function snapshotOf(overrides: Partial<LocalLoginSnapshot> = {}): LocalLoginSnapshot {
  return {
    userId: USER_ID,
    email: EMAIL,
    userActive: true,
    adminEligible: true,
    passwordHash: 'pbkdf2-sha256$placeholder',
    totpCredentialId: 'placeholder',
    totpEnabled: true,
    totpState: 'enabled',
    totpLastStep: null,
    credentialRev: 3,
    failedCount: 0,
    lockedUntil: null,
    ...overrides,
  };
}

function fakeCredentialRepository(): CredentialRepository & {
  rows: Map<string, CredentialRecord>;
} {
  const rows = new Map<string, CredentialRecord>();
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  return {
    rows,
    insertStatement: () => {
      throw new Error('unexpected insertStatement');
    },
    insert: (_ctx, row) => {
      rows.set(row.id, row);
      return Promise.resolve();
    },
    get: (_ctx, id) => Promise.resolve(rows.get(id) ?? null),
    listBelowVersion: unexpected('listBelowVersion'),
    reseal: unexpected('reseal'),
    delete: unexpected('delete'),
  };
}

function activeSession(overrides: Partial<ActiveSession> = {}): AuthenticatedSession {
  const session: ActiveSession = {
    id: SESSION_ID,
    userId: USER_ID,
    identityId: null,
    csrfHash: 'a'.repeat(64),
    createdAt: '2026-10-15T11:00:00.000Z',
    expiresAt: '2026-10-15T13:00:00.000Z',
    lastSeenAt: null,
    reauthAt: null,
    user: { id: USER_ID, email: EMAIL, displayName: null },
    ...overrides,
  };
  return { session, principal: { kind: 'user', id: session.userId } };
}

interface Options {
  readonly snapshot?: Partial<LocalLoginSnapshot> | null;
  readonly reserved?: Partial<LocalLoginSnapshot> | null;
  readonly reservation?: Reservation;
  readonly passwordHashKeys?: readonly MasterKey[];
  readonly secretFor?: string;
  readonly totpUserId?: string;
  readonly skipCredential?: boolean;
  readonly succeed?: boolean;
  readonly mutateRow?: (row: CredentialRecord) => CredentialRecord;
}

async function build(options: Options = {}) {
  const keyring = createKeyring([V2(), V1()]);
  const cipher = createSecretCipher(keyring, 'credential-encryption');
  const repository = fakeCredentialRepository();
  const ids = { ulid: () => ulid(NOW_MS) };
  const clock = fixedClock(NOW);
  const credentials = createCredentialStore({ repository, cipher, ids, clock });
  const secret = generateTotpSecret();
  const credentialId =
    options.skipCredential === true
      ? 'missing-credential'
      : await credentials.put(ORG, {
          kind: 'totp',
          projectId: null,
          plaintext: encodeTotpEnvelope(options.totpUserId ?? USER_ID, secret),
        });
  const stored = repository.rows.get(credentialId);
  if (options.mutateRow !== undefined && stored !== undefined) {
    repository.rows.set(credentialId, options.mutateRow(stored));
  }
  const passwordHash = await hashPassword(
    options.secretFor ?? PASSWORD,
    createKeyring(options.passwordHashKeys ?? [V2(), V1()]),
  );
  const base = { passwordHash, totpCredentialId: credentialId };
  const found =
    options.snapshot === null ? null : snapshotOf({ ...base, ...(options.snapshot ?? {}) });
  const reservedSnapshot = snapshotOf({
    ...base,
    failedCount: 1,
    ...(options.snapshot ?? {}),
    ...(options.reserved ?? {}),
  });
  const events: string[] = [];
  const reader = {
    findByEmail: vi.fn((ctx: unknown, email: string) => {
      events.push('findByEmail');
      void ctx;
      void email;
      return Promise.resolve(found);
    }),
    findBySetupHash: vi.fn(() => Promise.reject(new Error('unexpected findBySetupHash'))),
    reserveAttempt: vi.fn(() => {
      events.push('reserveAttempt');
      return Promise.resolve<Reservation>(
        options.reservation ?? { reserved: true, snapshot: reservedSnapshot },
      );
    }),
  };
  const writer = {
    replacePasswordHash: vi.fn<LocalLoginSuccessWriter['replacePasswordHash']>(() => {
      events.push('replacePasswordHash');
      return Promise.resolve(true);
    }),
    succeed: vi.fn<LocalLoginSuccessWriter['succeed']>(() => {
      events.push('succeed');
      return Promise.resolve(options.succeed ?? true);
    }),
  };
  const sessions = createSessionService({
    sessions: {
      findActive: () => Promise.reject(new Error('unexpected findActive')),
      findActiveById: () => Promise.reject(new Error('unexpected findActiveById')),
      touch: () => Promise.reject(new Error('unexpected touch')),
      markReauthenticatedByIdentity: () => Promise.reject(new Error('unexpected mark')),
      revoke: () => Promise.reject(new Error('unexpected revoke')),
      revokeBySecretHash: () => Promise.reject(new Error('unexpected revokeBySecretHash')),
      deleteExpired: () => Promise.reject(new Error('unexpected deleteExpired')),
    },
    clock,
    publicOrigin: ORIGIN,
  });
  const service: LocalLoginService = createLocalLoginService({
    reader,
    writer,
    credentials,
    sessions,
    keyring,
    clock,
    ids,
  });
  const code = await totpCode(secret, STEP);
  const windowCodes = await Promise.all(
    [STEP - 1, STEP, STEP + 1].map((step) => totpCode(secret, step)),
  );
  const wrongCode =
    ['000000', '111111', '222222'].find((value) => !windowCodes.includes(value)) ?? '';
  return {
    service,
    reader,
    writer,
    events,
    secret,
    code,
    wrongCode,
    reservedSnapshot,
    found,
    repository,
  };
}

const login = (
  harness: Awaited<ReturnType<typeof build>>,
  input: { email?: string; password?: string; code?: string } = {},
) =>
  harness.service.login(
    ORG,
    {
      email: input.email ?? EMAIL,
      password: input.password ?? PASSWORD,
      code: input.code === WRONG ? harness.wrongCode : (input.code ?? harness.code),
    },
    META,
  );

const WRONG = 'wrong-code';
const UNIFORM: Counts = { pbkdf2: 1, aes: 1, sha1: 3 };

describe('login success', () => {
  it('opens a session and passes the reservation snapshot to succeed', async () => {
    const harness = await build();
    const result = await login(harness);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe(USER_ID);
    expect(harness.writer.succeed).toHaveBeenCalledTimes(1);
    const [ctx, input] = harness.writer.succeed.mock.calls[0] ?? [];
    expect(ctx).toBe(ORG);
    expect(input?.snapshot).toBe(harness.reservedSnapshot);
    expect(input?.snapshot).not.toBe(harness.found);
    expect(input?.step).toBe(STEP);
    expect(input?.rehash).toBeNull();
    expect(input?.reauthSessionId).toBeNull();
    expect(input?.previousSecretHash).toBe(META.previousSecretHash);
    expect(input?.now).toBe(NOW);
    expect(input?.session).toMatchObject({
      userId: USER_ID,
      identityId: null,
      ip: META.ip,
      userAgent: META.userAgent,
      now: NOW,
      expiresAt: new Date(NOW_MS + SESSION_ABSOLUTE_MS).toISOString(),
    });
    expect(input?.session?.id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('returns cookies bound to the stored session hashes', async () => {
    const harness = await build();
    const result = await login(harness);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = harness.writer.succeed.mock.calls[0]?.[1].session;
    const value = (cookie: string): string => cookie.split(';')[0]?.split('=')[1] ?? '';
    expect(result.cookies).toHaveLength(2);
    expect(await sha256Hex(value(result.cookies[0] ?? ''))).toBe(session?.secretHash);
    expect(await sha256Hex(value(result.cookies[1] ?? ''))).toBe(session?.csrfHash);
  });

  it('reserves with the context, now and a 15 minute lock', async () => {
    const harness = await build();
    const result = await login(harness);
    expect(result.ok).toBe(true);
    expect(harness.reader.reserveAttempt).toHaveBeenCalledTimes(1);
    expect(harness.reader.reserveAttempt).toHaveBeenCalledWith(ORG, USER_ID, NOW, LOCK_UNTIL);
  });

  it('finds, reserves, verifies the password and only then calls succeed', async () => {
    const harness = await build();
    const { counts, value } = await counted(harness.events, () => login(harness));
    expect(value.ok).toBe(true);
    expect(counts).toEqual(UNIFORM);
    expect(harness.events).toEqual(['findByEmail', 'reserveAttempt', 'pbkdf2', 'succeed']);
    expect(harness.writer.replacePasswordHash).not.toHaveBeenCalled();
  });

  it('normalizes the e-mail before the lookup', async () => {
    const harness = await build();
    const result = await login(harness, { email: '  Admin@Example.TEST ' });
    expect(result.ok).toBe(true);
    expect(harness.reader.findByEmail).toHaveBeenCalledWith(ORG, EMAIL);
  });

  it('rehashes an older hash only after succeed accepts the login', async () => {
    const harness = await build({ passwordHashKeys: [V1()] });
    const { counts, value } = await counted(harness.events, () => login(harness));
    expect(value.ok).toBe(true);
    expect(counts.pbkdf2).toBe(2);
    expect(harness.events).toEqual([
      'findByEmail',
      'reserveAttempt',
      'pbkdf2',
      'succeed',
      'pbkdf2',
      'replacePasswordHash',
    ]);
    expect(harness.writer.succeed.mock.calls[0]?.[1].rehash).toBeNull();
    expect(harness.writer.replacePasswordHash).toHaveBeenCalledTimes(1);
    const replacement = harness.writer.replacePasswordHash.mock.calls[0];
    expect(replacement?.[0]).toBe(ORG);
    expect(replacement?.[1]).toMatchObject({
      userId: USER_ID,
      expectedHash: harness.reservedSnapshot.passwordHash,
      now: NOW,
    });
    const rehash = replacement?.[1].newHash ?? '';
    expect(rehash).toMatch(PASSWORD_HASH_PATTERN);
    expect(rehash).toContain('$v=2$');
    expect(await verifyPassword(rehash, PASSWORD, createKeyring([V2(), V1()]))).toEqual({
      ok: true,
      needsRehash: false,
    });
  });
});

describe('login refusals', () => {
  const refusals: readonly [
    string,
    Options,
    { email?: string; password?: string; code?: string },
  ][] = [
    ['unknown e-mail', { snapshot: null }, {}],
    ['malformed e-mail', {}, { email: 'not an e-mail' }],
    ['non-admin', { snapshot: { adminEligible: false } }, {}],
    ['suspended user', { snapshot: { userActive: false } }, {}],
    ['no password', { snapshot: { passwordHash: null } }, {}],
    [
      'no TOTP',
      { snapshot: { totpState: 'none', totpCredentialId: null, totpEnabled: false } },
      {},
    ],
    [
      'TOTP setup required',
      { snapshot: { totpState: 'setup_required', totpCredentialId: null } },
      {},
    ],
    ['locked account', { reservation: { reserved: false, reason: 'locked' } }, {}],
    ['row gone at reservation', { reservation: { reserved: false, reason: 'missing' } }, {}],
    ['grant removed before the reservation', { reserved: { adminEligible: false } }, {}],
    ['suspended before the reservation', { reserved: { userActive: false } }, {}],
    ['reset before the reservation', { reserved: { totpState: 'setup_required' } }, {}],
    ['wrong password', {}, { password: 'another long password!' }],
    ['wrong code', {}, { code: WRONG }],
    ['malformed code', {}, { code: 'abc' }],
    ['replayed code', { snapshot: { totpLastStep: STEP } }, {}],
    ['succeed returning false', { succeed: false }, {}],
    ['TOTP credential of another user', { totpUserId: OTHER_USER_ID }, {}],
    ['missing TOTP credential', { skipCredential: true }, {}],
    [
      'password hash under an unloaded pepper version',
      { passwordHashKeys: [masterKey(3, 0x40)] },
      {},
    ],
    ['malformed password hash', { snapshot: { passwordHash: 'pbkdf2-sha256$garbage' } }, {}],
    [
      'credential sealed under an unloaded key version',
      { mutateRow: (row) => ({ ...row, sealed: { ...row.sealed, keyVersion: 9 } }) },
      {},
    ],
    [
      'credential with a mismatching AAD',
      { mutateRow: (row) => ({ ...row, aad: `${row.aad}x` }) },
      {},
    ],
    [
      'credential with a ciphertext shorter than the tag',
      {
        mutateRow: (row) => ({
          ...row,
          sealed: { ...row.sealed, ciphertext: row.sealed.ciphertext.slice(0, 8) },
        }),
      },
      {},
    ],
  ];

  it.each(refusals)(
    '%s returns exactly { ok: false } after the uniform work',
    async (_name, options, input) => {
      const harness = await build(options);
      const { counts, value } = await counted(null, () => login(harness, input));
      expect(value).toStrictEqual({ ok: false });
      expect(counts).toEqual(UNIFORM);
    },
  );

  it('does the same work for a refusal as for a success', async () => {
    const success = await build();
    const refusal = await build();
    const accepted = await counted(null, () => login(success));
    const refused = await counted(null, () => login(refusal, { code: WRONG }));
    expect(accepted.value.ok).toBe(true);
    expect(refused.value).toStrictEqual({ ok: false });
    expect(refused.counts).toEqual(accepted.counts);
  });

  it('opens one dummy envelope on top of the real decrypt for a tampered ciphertext', async () => {
    const harness = await build({
      mutateRow: (row) => {
        const ciphertext = row.sealed.ciphertext.slice();
        ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
        return { ...row, sealed: { ...row.sealed, ciphertext } };
      },
    });
    const { counts, value } = await counted(null, () => login(harness));
    expect(value).toStrictEqual({ ok: false });
    expect(counts).toEqual({ pbkdf2: 1, aes: 2, sha1: 3 });
  });

  it('does not rehash on a refusal and rehashes once on success', async () => {
    const refused = await build({ passwordHashKeys: [V1()] });
    const refusedRun = await counted(null, () => login(refused, { code: WRONG }));
    expect(refusedRun.counts).toEqual(UNIFORM);
    expect(refused.writer.succeed).not.toHaveBeenCalled();
    const accepted = await build({ passwordHashKeys: [V1()] });
    const acceptedRun = await counted(null, () => login(accepted));
    expect(acceptedRun.value.ok).toBe(true);
    expect(acceptedRun.counts).toEqual({ pbkdf2: 2, aes: 1, sha1: 3 });
  });

  it('makes no reservation for an unknown or malformed e-mail or an ineligible account', async () => {
    for (const [options, input] of [
      [{ snapshot: null }, {}],
      [{}, { email: 'nope' }],
      [{ snapshot: { adminEligible: false } }, {}],
      [{ snapshot: { userActive: false } }, {}],
      [{ snapshot: { passwordHash: null } }, {}],
      [{ snapshot: { totpState: 'setup_required', totpCredentialId: null } }, {}],
    ] as const) {
      const harness = await build(options);
      await login(harness, input);
      expect(harness.reader.reserveAttempt).not.toHaveBeenCalled();
      expect(harness.writer.succeed).not.toHaveBeenCalled();
    }
  });

  it('reserves an existing account before any PBKDF2 even when it ends locked', async () => {
    const harness = await build({ reservation: { reserved: false, reason: 'locked' } });
    await counted(harness.events, () => login(harness));
    expect(harness.events).toEqual(['findByEmail', 'reserveAttempt', 'pbkdf2']);
    expect(harness.writer.succeed).not.toHaveBeenCalled();
  });

  it('reserves before verifying a wrong password and never calls succeed', async () => {
    const harness = await build();
    await counted(harness.events, () => login(harness, { password: 'wrong password value' }));
    expect(harness.events).toEqual(['findByEmail', 'reserveAttempt', 'pbkdf2']);
  });

  it('refuses a TOTP credential whose envelope names another user', async () => {
    const harness = await build({ totpUserId: OTHER_USER_ID });
    expect(await login(harness)).toStrictEqual({ ok: false });
    expect(harness.writer.succeed).not.toHaveBeenCalled();
  });

  it('does not verify against the findByEmail snapshot when the reservation differs', async () => {
    const harness = await build({ reserved: { totpLastStep: STEP } });
    expect(await login(harness)).toStrictEqual({ ok: false });
    expect(harness.writer.succeed).not.toHaveBeenCalled();
  });

  it('never returns a reason, a user id or cookies on refusal', async () => {
    const harness = await build({ succeed: false });
    const result = await login(harness);
    expect(Object.keys(result)).toEqual(['ok']);
  });
});

describe('TOTP window', () => {
  it.each([-1, 1])(
    'accepts the code of step offset %i and passes the matched step',
    async (offset) => {
      const harness = await build();
      const code = await totpCode(harness.secret, STEP + offset);
      const result = await login(harness, { code });
      expect(result.ok).toBe(true);
      expect(harness.writer.succeed.mock.calls[0]?.[1].step).toBe(STEP + offset);
    },
  );

  it.each([-2, 2])('refuses the code of step offset %i', async (offset) => {
    const harness = await build();
    const code = await totpCode(harness.secret, STEP + offset);
    expect(await login(harness, { code })).toStrictEqual({ ok: false });
    expect(harness.writer.succeed).not.toHaveBeenCalled();
  });

  it.each([STEP, STEP + 1])('refuses a code at or below a stored step of %i', async (lastStep) => {
    const harness = await build({ snapshot: { totpLastStep: lastStep } });
    const { counts, value } = await counted(null, () => login(harness));
    expect(value).toStrictEqual({ ok: false });
    expect(counts).toEqual(UNIFORM);
    expect(harness.writer.succeed).not.toHaveBeenCalled();
    const next = await login(harness, { code: await totpCode(harness.secret, STEP + 1) });
    expect(next.ok).toBe(lastStep < STEP + 1);
  });
});

describe('reauth', () => {
  it('accepts a local session and sets reauthSessionId with the reservation snapshot', async () => {
    const harness = await build();
    const result = await harness.service.reauth(ORG, activeSession(), {
      password: PASSWORD,
      code: harness.code,
    });
    expect(result).toStrictEqual({ ok: true });
    const input = harness.writer.succeed.mock.calls[0]?.[1];
    expect(input?.snapshot).toBe(harness.reservedSnapshot);
    expect(input?.session).toBeNull();
    expect(input?.reauthSessionId).toBe(SESSION_ID);
    expect(input?.previousSecretHash).toBeNull();
    expect(input?.step).toBe(STEP);
    expect(input?.rehash).toBeNull();
    expect(harness.events).toEqual(['findByEmail', 'reserveAttempt', 'succeed']);
  });

  it('refuses an SSO session with the uniform work and no reservation', async () => {
    const harness = await build();
    const { counts, value } = await counted(null, () =>
      harness.service.reauth(ORG, activeSession({ identityId: '01J0IDENT0000000000000000I' }), {
        password: PASSWORD,
        code: harness.code,
      }),
    );
    expect(value).toStrictEqual({ ok: false });
    expect(counts).toEqual(UNIFORM);
    expect(harness.reader.reserveAttempt).not.toHaveBeenCalled();
    expect(harness.writer.succeed).not.toHaveBeenCalled();
  });

  it('refuses a wrong code with the uniform work', async () => {
    const harness = await build();
    const { counts, value } = await counted(null, () =>
      harness.service.reauth(ORG, activeSession(), { password: PASSWORD, code: harness.wrongCode }),
    );
    expect(value).toStrictEqual({ ok: false });
    expect(counts).toEqual(UNIFORM);
    expect(harness.writer.succeed).not.toHaveBeenCalled();
  });

  it('refuses a wrong password', async () => {
    const harness = await build();
    const result = await harness.service.reauth(ORG, activeSession(), {
      password: 'another long password!',
      code: harness.code,
    });
    expect(result).toStrictEqual({ ok: false });
    expect(harness.writer.succeed).not.toHaveBeenCalled();
  });

  it('refuses when the e-mail now belongs to another user', async () => {
    const harness = await build({ snapshot: { userId: OTHER_USER_ID } });
    const { counts, value } = await counted(null, () =>
      harness.service.reauth(ORG, activeSession(), { password: PASSWORD, code: harness.code }),
    );
    expect(value).toStrictEqual({ ok: false });
    expect(counts).toEqual(UNIFORM);
    expect(harness.reader.reserveAttempt).not.toHaveBeenCalled();
  });

  it('refuses a locked account and a refused succeed', async () => {
    const locked = await build({ reservation: { reserved: false, reason: 'locked' } });
    expect(
      await locked.service.reauth(ORG, activeSession(), { password: PASSWORD, code: locked.code }),
    ).toStrictEqual({ ok: false });
    const stale = await build({ succeed: false });
    expect(
      await stale.service.reauth(ORG, activeSession(), { password: PASSWORD, code: stale.code }),
    ).toStrictEqual({ ok: false });
  });

  it('uses the session organization context unchanged', async () => {
    const harness = await build();
    await harness.service.reauth(OTHER_ORG, activeSession(), {
      password: PASSWORD,
      code: harness.code,
    });
    expect(harness.reader.findByEmail.mock.calls[0]?.[0]).toBe(OTHER_ORG);
  });
});

describe('non-string body fields', () => {
  const NON_STRINGS: readonly unknown[] = [42, { value: 'x' }, ['x'], null];

  it.each(
    (['email', 'password', 'code'] as const).flatMap((field) =>
      NON_STRINGS.map((value) => [field, value] as const),
    ),
  )('login refuses %s as %j without throwing or reserving', async (field, value) => {
    const harness = await build();
    const input = { email: EMAIL, password: PASSWORD, code: harness.code, [field]: value };
    const result = await harness.service.login(
      ORG,
      input as unknown as { email: string; password: string; code: string },
      META,
    );
    expect(result).toStrictEqual({ ok: false });
    expect(harness.reader.reserveAttempt).not.toHaveBeenCalled();
    expect(harness.writer.succeed).not.toHaveBeenCalled();
  });

  it.each(
    (['password', 'code'] as const).flatMap((field) =>
      NON_STRINGS.map((value) => [field, value] as const),
    ),
  )('reauth refuses %s as %j without throwing or reserving', async (field, value) => {
    const harness = await build();
    const input = { password: PASSWORD, code: harness.code, [field]: value };
    const result = await harness.service.reauth(
      ORG,
      activeSession(),
      input as unknown as { password: string; code: string },
    );
    expect(result).toStrictEqual({ ok: false });
    expect(harness.reader.reserveAttempt).not.toHaveBeenCalled();
    expect(harness.writer.succeed).not.toHaveBeenCalled();
  });
});

describe('password rehash after success', () => {
  it('does one PBKDF2 when succeed refuses an older hash', async () => {
    const harness = await build({ passwordHashKeys: [V1()], succeed: false });
    const { counts, value } = await counted(null, () => login(harness));
    expect(value).toStrictEqual({ ok: false });
    expect(counts.pbkdf2).toBe(1);
    expect(harness.writer.replacePasswordHash).not.toHaveBeenCalled();
  });

  it('does one PBKDF2 when succeed throws for an older hash', async () => {
    const harness = await build({ passwordHashKeys: [V1()] });
    harness.writer.succeed.mockRejectedValueOnce(new Error('write failed'));
    const { counts } = await counted(null, async () => {
      await expect(login(harness)).rejects.toThrow('write failed');
    });
    expect(counts.pbkdf2).toBe(1);
    expect(harness.writer.replacePasswordHash).not.toHaveBeenCalled();
  });

  it('keeps the successful login when a concurrent hash change wins', async () => {
    const harness = await build({ passwordHashKeys: [V1()] });
    harness.writer.replacePasswordHash.mockResolvedValueOnce(false);
    const result = await login(harness);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cookies).toHaveLength(2);
    expect(harness.writer.replacePasswordHash).toHaveBeenCalledTimes(1);
  });

  it('keeps the successful login and logs only an approved name when the CAS throws', async () => {
    const harness = await build({ passwordHashKeys: [V1()] });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new TypeError('private database detail');
    harness.writer.replacePasswordHash.mockRejectedValueOnce(error);
    const result = await login(harness);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cookies).toHaveLength(2);
    expect(harness.writer.replacePasswordHash).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([['TypeError']]);
  });

  it('does one PBKDF2 when reauth succeed refuses an older hash', async () => {
    const harness = await build({ passwordHashKeys: [V1()], succeed: false });
    const { counts, value } = await counted(null, () =>
      harness.service.reauth(ORG, activeSession(), { password: PASSWORD, code: harness.code }),
    );
    expect(value).toStrictEqual({ ok: false });
    expect(counts.pbkdf2).toBe(1);
    expect(harness.writer.replacePasswordHash).not.toHaveBeenCalled();
  });

  it('rehashes after successful reauth', async () => {
    const harness = await build({ passwordHashKeys: [V1()] });
    const { counts, value } = await counted(harness.events, () =>
      harness.service.reauth(ORG, activeSession(), { password: PASSWORD, code: harness.code }),
    );
    expect(value).toStrictEqual({ ok: true });
    expect(counts.pbkdf2).toBe(2);
    expect(harness.events).toEqual([
      'findByEmail',
      'reserveAttempt',
      'pbkdf2',
      'succeed',
      'pbkdf2',
      'replacePasswordHash',
    ]);
    expect(harness.writer.succeed.mock.calls[0]?.[1].rehash).toBeNull();
  });
});
