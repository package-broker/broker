import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalSetupService } from './local-setup.js';
import type { LocalSetupService } from './local-setup.js';
import { randomToken, sha256Hex } from './primitives.js';
import { createSessionService } from './session.js';
import type { SessionMeta } from './session.js';
import { PASSWORD_ITERATIONS, verifyPassword } from './password.js';
import {
  base32Decode,
  base32Encode,
  encodeTotpEnvelope,
  generateTotpSecret,
  totpCode,
} from './totp.js';
import type { CredentialRecord, CredentialRepository } from '../db/credentials.js';
import type {
  LocalLoginReader,
  LocalLoginSetupWriter,
  LocalLoginSnapshot,
} from '../db/local-login.js';
import { orgContext } from '../db/port.js';
import type { NewSession } from '../db/sessions.js';
import { fixedClock, ulid } from '../ids.js';
import { createSecretCipher } from '../secrets/cipher.js';
import { createCredentialStore } from '../secrets/credential-store.js';
import type { CredentialStore } from '../secrets/credential-store.js';
import { createKeyring } from '../secrets/keyring.js';

const NOW = '2026-10-15T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const STEP = Math.floor(NOW_MS / 30_000);
const ctx = orgContext('01J0ORGA00000000000000000A');
const USER = '01J0USERA0000000000000000A';
const OTHER_USER = '01J0USERB0000000000000000B';
const EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://broker.example.test';
const META: SessionMeta = {
  requestId: '01K00000000000000000000001',
  ip: '203.0.113.7',
  userAgent: 'vitest',
  previousSecretHash: null,
};

const SIGN = 4;
const keyring = createKeyring([
  { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
]);

interface User {
  userId: string;
  email: string;
  setupHash: string | null;
  setupExpiresAt: string | null;
  totpCredentialId: string | null;
  totpEnabled: boolean;
  totpLastStep: number | null;
  credentialRev: number;
  failedCount: number;
  lockedUntil: string | null;
  passwordHash: string | null;
  active: boolean;
  adminEligible: boolean;
}

interface Harness {
  readonly service: LocalSetupService;
  readonly user: User;
  readonly rows: Map<string, CredentialRecord>;
  readonly sessions: NewSession[];
  readonly completions: Parameters<LocalLoginSetupWriter['completeSetup']>[1][];
  readonly calls: string[];
  readonly store: CredentialStore;
  readonly token: string;
  readonly hooks: {
    beforeComplete: (() => Promise<void>) | null;
    reserved: ((snapshot: LocalLoginSnapshot) => LocalLoginSnapshot) | null;
    readError: Error | null;
  };
  stageFor(other: { userId: string; secret: Uint8Array }): Promise<void>;
}

function snapshotOf(user: User): LocalLoginSnapshot {
  return {
    userId: user.userId,
    email: user.email,
    userActive: user.active,
    adminEligible: user.adminEligible,
    passwordHash: user.passwordHash,
    totpCredentialId: user.totpCredentialId,
    totpEnabled: user.totpEnabled,
    totpState: user.totpEnabled && user.totpCredentialId !== null ? 'enabled' : 'none',
    totpLastStep: user.totpLastStep,
    credentialRev: user.credentialRev,
    failedCount: user.failedCount,
    lockedUntil: user.lockedUntil,
  };
}

async function harness(
  options: {
    expired?: boolean;
    email?: string;
    stageRefused?: boolean;
    inactive?: boolean;
    ineligible?: boolean;
  } = {},
): Promise<Harness> {
  const token = randomToken(32);
  const user: User = {
    userId: USER,
    email: options.email ?? EMAIL,
    setupHash: await sha256Hex(token),
    setupExpiresAt:
      options.expired === true ? NOW : new Date(NOW_MS + 24 * 3_600_000).toISOString(),
    totpCredentialId: null,
    totpEnabled: false,
    totpLastStep: null,
    credentialRev: 3,
    failedCount: 0,
    lockedUntil: null,
    passwordHash: null,
    active: options.inactive !== true,
    adminEligible: options.ineligible !== true,
  };
  const rows = new Map<string, CredentialRecord>();
  const sessions: NewSession[] = [];
  const completions: Harness['completions'] = [];
  const calls: string[] = [];
  const hooks: Harness['hooks'] = { beforeComplete: null, reserved: null, readError: null };
  const unexpected = (name: string) => () => {
    throw new Error(`unexpected ${name}`);
  };

  const repository: CredentialRepository = {
    insertStatement: unexpected('insertStatement'),
    insert: unexpected('insert'),
    get: (_ctx, id) =>
      hooks.readError === null
        ? Promise.resolve(rows.get(id) ?? null)
        : Promise.reject(hooks.readError),
    listBelowVersion: unexpected('listBelowVersion'),
    reseal: unexpected('reseal'),
    delete: unexpected('delete'),
  };
  const innerStore = createCredentialStore({
    repository,
    cipher: createSecretCipher(keyring, 'credential-encryption'),
    ids: { ulid },
    clock: fixedClock(NOW),
  });
  const store: CredentialStore = {
    ...innerStore,
    read: (readCtx, id) => {
      calls.push('read');
      return innerStore.read(readCtx, id);
    },
  };

  const live = (hash: string, now: string): boolean =>
    user.setupHash === hash && user.setupExpiresAt !== null && user.setupExpiresAt > now;

  const reader: LocalLoginReader = {
    findByEmail: unexpected('findByEmail'),
    findBySetupHash(_ctx, hash, now) {
      calls.push('findBySetupHash');
      return Promise.resolve(live(hash, now) ? snapshotOf(user) : null);
    },
    reserveAttempt(_ctx, userId, now, lockUntil) {
      calls.push('reserveAttempt');
      if (userId !== user.userId) return Promise.resolve({ reserved: false, reason: 'missing' });
      if (user.lockedUntil !== null && user.lockedUntil > now) {
        return Promise.resolve({ reserved: false, reason: 'locked' });
      }
      user.failedCount += 1;
      if (user.failedCount % 5 === 0) user.lockedUntil = lockUntil;
      const snapshot = snapshotOf(user);
      return Promise.resolve({
        reserved: true,
        snapshot: hooks.reserved === null ? snapshot : hooks.reserved(snapshot),
      });
    },
  };

  const writer: LocalLoginSetupWriter = {
    stagePendingTotp(_ctx, input) {
      calls.push('stagePendingTotp');
      if (options.stageRefused === true || !live(input.setupHash, input.now)) {
        return Promise.resolve(false);
      }
      expect(input.credential.projectId).toBeNull();
      expect(input.credential.kind).toBe('totp');
      expect(input.credential.now).toBe(input.now);
      if (user.totpCredentialId !== null) rows.delete(user.totpCredentialId);
      rows.set(input.credential.id, input.credential);
      user.totpCredentialId = input.credential.id;
      return Promise.resolve(true);
    },
    async completeSetup(_ctx, input) {
      calls.push('completeSetup');
      completions.push(input);
      await hooks.beforeComplete?.();
      if (
        !live(input.setupHash, input.now) ||
        user.totpCredentialId !== input.expectedCredentialId ||
        user.credentialRev !== input.credentialRev ||
        !user.active ||
        !user.adminEligible
      ) {
        return false;
      }
      user.passwordHash = input.passwordHash;
      user.totpEnabled = true;
      user.totpLastStep = input.step;
      user.credentialRev += 1;
      user.setupHash = null;
      user.setupExpiresAt = null;
      user.failedCount = 0;
      user.lockedUntil = null;
      sessions.push(input.session);
      return true;
    },
  };

  const sessionService = createSessionService({
    sessions: {
      findActive: unexpected('findActive'),
      findActiveById: unexpected('findActiveById'),
      touch: unexpected('touch'),
      markReauthenticatedByIdentity: unexpected('markReauthenticatedByIdentity'),
      revoke: unexpected('revoke'),
      revokeBySecretHash: unexpected('revokeBySecretHash'),
      deleteExpired: unexpected('deleteExpired'),
    },
    clock: fixedClock(NOW),
    publicOrigin: ORIGIN,
  });

  const service = createLocalSetupService({
    reader,
    writer,
    credentials: store,
    sessions: sessionService,
    keyring,
    clock: fixedClock(NOW),
    ids: { ulid },
  });

  return {
    service,
    user,
    rows,
    sessions,
    completions,
    calls,
    store,
    token,
    hooks,
    async stageFor(other) {
      const row = await innerStore.seal(ctx, {
        kind: 'totp',
        projectId: null,
        plaintext: encodeTotpEnvelope(other.userId, other.secret),
      });
      if (user.totpCredentialId !== null) rows.delete(user.totpCredentialId);
      rows.set(row.id, row);
      user.totpCredentialId = row.id;
    },
  };
}

async function started(h: Harness): Promise<{ secret: Uint8Array; uri: string }> {
  const result = await h.service.start(ctx, h.token);
  if (!result.ok) throw new Error('start refused');
  return { secret: base32Decode(result.secret), uri: result.provisioningUri };
}

async function wrongCode(secret: Uint8Array): Promise<string> {
  const valid = new Set(await Promise.all([-1, 0, 1].map((offset) => codeFor(secret, offset))));
  for (;;) {
    const other = generateTotpSecret();
    const candidate = await codeFor(other);
    if (!valid.has(candidate)) return candidate;
  }
}

async function codeFor(secret: Uint8Array, offset = 0): Promise<string> {
  return totpCode(secret, STEP + offset);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('start', () => {
  it('stages a pending credential and returns the base32 secret and the provisioning URI', async () => {
    const h = await harness();
    const result = await h.service.start(ctx, h.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(result.secret)).toHaveLength(20);
    expect(result.provisioningUri).toBe(
      `otpauth://totp/Package%20Broker:admin%40example.test?secret=${result.secret}&issuer=Package%20Broker&algorithm=SHA1&digits=6&period=30`,
    );
    expect(h.rows.size).toBe(1);
    expect(h.user.totpCredentialId).toBe([...h.rows.keys()][0]);
    expect(h.user.totpEnabled).toBe(false);
  });

  it('stores the secret in an envelope that names the user, sealed under the totp kind', async () => {
    const h = await harness();
    const { secret } = await started(h);
    const id = h.user.totpCredentialId as string;
    const plaintext = JSON.parse(new TextDecoder().decode(await h.store.read(ctx, id))) as unknown;
    expect(plaintext).toEqual({ u: USER, s: expect.stringMatching(/^[A-Z2-7]{32}$/) });
    expect(base32Decode((plaintext as { s: string }).s)).toEqual(secret);
    expect(h.rows.get(id)?.kind).toBe('totp');
    expect(h.rows.get(id)?.projectId).toBeNull();
  });

  it('never inserts the credential outside the guarded batch', async () => {
    const h = await harness();
    await started(h);
    expect(h.calls).toEqual(['findBySetupHash', 'stagePendingTotp']);
  });

  it('refuses malformed tokens without a lookup', async () => {
    const h = await harness();
    const code = await wrongCode(generateTotpSecret());
    for (const token of [
      '',
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}=`,
      `${'a'.repeat(42)}+`,
    ]) {
      expect(await h.service.start(ctx, token)).toEqual({ ok: false });
      expect(await h.service.finish(ctx, { token, password: PASSWORD, code }, META)).toEqual({
        ok: false,
      });
    }
    expect(h.calls).toEqual([]);
  });

  it('refuses an unknown and an expired token the same way and stages nothing', async () => {
    const expired = await harness({ expired: true });
    const unknown = await harness();
    const a = await expired.service.start(ctx, expired.token);
    const b = await unknown.service.start(ctx, randomToken(32));
    expect(a).toEqual({ ok: false });
    expect(b).toEqual({ ok: false });
    expect(expired.calls).toEqual(unknown.calls);
    expect(expired.rows.size).toBe(0);
  });

  it('returns not-ok when the writer refuses the stage', async () => {
    const h = await harness({ stageRefused: true });
    expect(await h.service.start(ctx, h.token)).toEqual({ ok: false });
  });

  it('refuses an e-mail that cannot be provisioned before staging anything', async () => {
    const h = await harness({ email: 'a:b@example.test' });
    expect(await h.service.start(ctx, h.token)).toEqual({ ok: false });
    expect(h.calls).toEqual(['findBySetupHash']);
    expect(h.rows.size).toBe(0);
  });
});

describe('finish', () => {
  it('builds setup.complete with only operation and request correlation in the payload', async () => {
    const h = await harness();
    const { secret } = await started(h);
    expect(
      (
        await h.service.finish(
          ctx,
          { token: h.token, password: PASSWORD, code: await codeFor(secret) },
          META,
        )
      ).ok,
    ).toBe(true);
    expect(h.completions).toHaveLength(1);
    const input = h.completions[0]!;
    expect(input.audit).toEqual({
      id: expect.any(String),
      occurredAt: NOW,
      action: 'setup.complete',
      actor: { type: 'user', id: USER },
      target: { type: 'user', id: USER },
      projectId: null,
      sourceIp: META.ip,
      tokenSelector: null,
      payloadJson: JSON.stringify({ op_id: input.audit?.id, request_id: META.requestId }),
    });
    expect(input.audit.id).not.toBe(input.session.id);
    for (const sentinel of [EMAIL, PASSWORD, input.passwordHash, base32Encode(secret)]) {
      expect(input.audit.payloadJson.includes(sentinel)).toBe(false);
    }
  });

  it('throws a fixed error before the writer if auditEvent refuses the envelope', async () => {
    const h = await harness();
    const { secret } = await started(h);
    await expect(
      h.service.finish(
        ctx,
        { token: h.token, password: PASSWORD, code: await codeFor(secret) },
        { ...META, requestId: 'invalid' },
      ),
    ).rejects.toThrow('Invalid local setup audit event');
    expect(h.completions).toHaveLength(0);
    expect(h.sessions).toHaveLength(0);
  });

  it('opens a session after start with a correct code, and the token cannot be reused', async () => {
    const h = await harness();
    const { secret } = await started(h);
    const result = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(secret) },
      META,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe(USER);
    expect(result.cookies.some((c) => c.startsWith('__Host-pb_session='))).toBe(true);
    expect(result.cookies.some((c) => c.startsWith('__Host-pb_csrf='))).toBe(true);
    expect(h.sessions).toHaveLength(1);

    const reuse = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(secret, 1) },
      META,
    );
    expect(reuse).toEqual({ ok: false });
    expect(await h.service.start(ctx, h.token)).toEqual({ ok: false });
    expect(h.sessions).toHaveLength(1);
  });

  it('passes credential-bound completion input and a session whose secrets match the cookies', async () => {
    const h = await harness();
    const { secret } = await started(h);
    const credentialId = h.user.totpCredentialId;
    const previousSecretHash = 'b'.repeat(64);
    const result = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(secret) },
      { ...META, previousSecretHash },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const input = h.completions[0];
    expect(input).toBeDefined();
    if (input === undefined) return;
    expect(input.userId).toBe(USER);
    expect(input.setupHash).toBe(await sha256Hex(h.token));
    expect(input.expectedCredentialId).toBe(credentialId);
    expect(input.credentialRev).toBe(3);
    expect(input.step).toBe(STEP);
    expect(input.now).toBe(NOW);
    expect(input.previousSecretHash).toBe(previousSecretHash);
    expect(input.passwordHash).toMatch(
      new RegExp(`^pbkdf2-sha256\\$i=${String(PASSWORD_ITERATIONS)}\\$v=1\\$`),
    );
    expect((await verifyPassword(input.passwordHash, PASSWORD, keyring)).ok).toBe(true);
    expect(input.session.userId).toBe(USER);
    expect(input.session.identityId).toBeNull();
    expect(input.session.now).toBe(NOW);
    expect(input.session.ip).toBe(META.ip);
    expect(input.session.userAgent).toBe(META.userAgent);
    expect(input.session.expiresAt).toBe(new Date(NOW_MS + 43_200_000).toISOString());
    const cookieSecret = /^__Host-pb_session=([^;]+)/.exec(result.cookies[0] ?? '')?.[1] ?? '';
    expect(await sha256Hex(cookieSecret)).toBe(input.session.secretHash);
    expect(h.user.passwordHash).toBe(input.passwordHash);
  });

  it('accepts a code from the neighbouring window', async () => {
    const h = await harness();
    const { secret } = await started(h);
    const result = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(secret, -1) },
      META,
    );
    expect(result.ok).toBe(true);
    expect(h.completions[0]?.step).toBe(STEP - 1);
  });

  it('fails with the first secret after a restage between start and finish', async () => {
    const h = await harness();
    const first = await started(h);
    const second = await started(h);
    const stale = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(first.secret) },
      META,
    );
    expect(stale).toEqual({ ok: false });
    expect(h.sessions).toHaveLength(0);
    const fresh = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(second.secret) },
      META,
    );
    expect(fresh.ok).toBe(true);
  });

  it('fails when a restage lands between the credential read and the completion', async () => {
    const h = await harness();
    const first = await started(h);
    h.hooks.beforeComplete = async () => {
      h.hooks.beforeComplete = null;
      await started(h);
    };
    const result = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(first.secret) },
      META,
    );
    expect(result).toEqual({ ok: false });
    expect(h.sessions).toHaveLength(0);
    expect(h.user.passwordHash).toBeNull();
  });

  it('refuses the sixth wrong code at the reservation without reading the credential', async () => {
    const h = await harness();
    const { secret } = await started(h);
    const wrong = await wrongCode(secret);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await h.service.finish(
        ctx,
        { token: h.token, password: PASSWORD, code: wrong },
        META,
      );
      expect(result).toEqual({ ok: false });
    }
    expect(h.calls.filter((c) => c === 'read')).toHaveLength(5);
    expect(h.user.lockedUntil).toBe(new Date(NOW_MS + 15 * 60_000).toISOString());

    const sixth = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(secret) },
      META,
    );
    expect(sixth).toEqual({ ok: false });
    expect(h.calls.filter((c) => c === 'read')).toHaveLength(5);
    expect(h.calls.filter((c) => c === 'reserveAttempt')).toHaveLength(6);
    expect(h.sessions).toHaveLength(0);
  });

  it('refuses an envelope that names another user even with a correct code', async () => {
    const h = await harness();
    await started(h);
    const foreign = generateTotpSecret();
    await h.stageFor({ userId: OTHER_USER, secret: foreign });
    const result = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(foreign) },
      META,
    );
    expect(result).toEqual({ ok: false });
    expect(h.sessions).toHaveLength(0);
    expect(h.user.passwordHash).toBeNull();
  });

  it('refuses when no pending credential exists', async () => {
    const h = await harness();
    const result = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(generateTotpSecret()) },
      META,
    );
    expect(result).toEqual({ ok: false });
    expect(h.sessions).toHaveLength(0);
  });

  it('refuses a code for the all-zero dummy secret when the credential is unusable', async () => {
    const h = await harness();
    const result = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(new Uint8Array(20)) },
      META,
    );
    expect(result).toEqual({ ok: false });
  });

  it('returns the password problems and opens no session for a weak password', async () => {
    const h = await harness();
    const { secret } = await started(h);
    const result = await h.service.finish(
      ctx,
      { token: h.token, password: 'short', code: await codeFor(secret) },
      META,
    );
    expect(result).toEqual({ ok: false, problems: ['too_short'] });
    expect(h.sessions).toHaveLength(0);
    expect(h.completions).toHaveLength(0);
    const same = await h.service.finish(
      ctx,
      { token: h.token, password: EMAIL, code: await codeFor(secret) },
      META,
    );
    expect(same).toEqual({ ok: false, problems: ['equals_email'] });
  });

  it('refuses an expired and an unknown token with the same bare result', async () => {
    const expired = await harness({ expired: true });
    const unknown = await harness();
    const input = (token: string) => ({ token, password: PASSWORD, code: '123456' });
    const a = await expired.service.finish(ctx, input(expired.token), META);
    const b = await unknown.service.finish(ctx, input(randomToken(32)), META);
    expect(a).toEqual({ ok: false });
    expect(b).toEqual({ ok: false });
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(expired.calls).toEqual(unknown.calls);
    expect(expired.sessions).toHaveLength(0);
  });

  it.each([
    [
      'a foreign envelope',
      async (h: Harness) => {
        await h.stageFor({ userId: OTHER_USER, secret: new Uint8Array(20) });
      },
    ],
    [
      'a deleted row',
      (h: Harness) => {
        h.rows.clear();
        return Promise.resolve();
      },
    ],
    [
      'tampered ciphertext',
      (h: Harness) => {
        const id = h.user.totpCredentialId as string;
        const row = h.rows.get(id) as CredentialRecord;
        const ciphertext = row.sealed.ciphertext.slice();
        ciphertext[0] = (ciphertext[0] as number) ^ 0xff;
        h.rows.set(id, { ...row, sealed: { ...row.sealed, ciphertext } });
        return Promise.resolve();
      },
    ],
  ])(
    'refuses a code for the all-zero secret when the credential is unreadable: %s',
    async (_name, spoil) => {
      const h = await harness();
      await started(h);
      await spoil(h);
      const result = await h.service.finish(
        ctx,
        { token: h.token, password: PASSWORD, code: await codeFor(new Uint8Array(20)) },
        META,
      );
      expect(result).toEqual({ ok: false });
      expect(h.sessions).toHaveLength(0);
      expect(h.completions).toHaveLength(0);
    },
  );

  it('does no TOTP or password work when the reservation is refused', async () => {
    const h = await harness();
    const { secret } = await started(h);
    h.user.lockedUntil = new Date(NOW_MS + 60_000).toISOString();
    const code = await codeFor(secret);
    const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits');
    const sign = vi.spyOn(crypto.subtle, 'sign');
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    const result = await h.service.finish(ctx, { token: h.token, password: PASSWORD, code }, META);
    expect(result).toEqual({ ok: false });
    expect(deriveBits).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c === 'read')).toHaveLength(0);
  });

  it('consumes no attempt for a weak password', async () => {
    const h = await harness();
    const { secret } = await started(h);
    const result = await h.service.finish(
      ctx,
      { token: h.token, password: 'short', code: await codeFor(secret) },
      META,
    );
    expect(result).toEqual({ ok: false, problems: ['too_short'] });
    expect(h.calls).not.toContain('reserveAttempt');
    expect(h.user.failedCount).toBe(0);
  });

  it('lets a correct code on the attempt that wrote its own lock succeed and clears the lock', async () => {
    const h = await harness();
    const { secret } = await started(h);
    const wrong = await wrongCode(secret);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(
        await h.service.finish(ctx, { token: h.token, password: PASSWORD, code: wrong }, META),
      ).toEqual({ ok: false });
    }
    const fifth = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(secret) },
      META,
    );
    expect(fifth.ok).toBe(true);
    expect(h.user.failedCount).toBe(0);
    expect(h.user.lockedUntil).toBeNull();
  });

  it('refuses an inactive or not admin-eligible user in start and finish', async () => {
    for (const options of [{ inactive: true }, { ineligible: true }]) {
      const h = await harness(options);
      expect(await h.service.start(ctx, h.token)).toEqual({ ok: false });
      expect(h.calls).toEqual(['findBySetupHash']);
      expect(
        await h.service.finish(ctx, { token: h.token, password: PASSWORD, code: '123456' }, META),
      ).toEqual({ ok: false });
      expect(h.calls).toEqual(['findBySetupHash', 'findBySetupHash']);
      expect(h.rows.size).toBe(0);
    }
  });

  it('returns the uniform refusal for non-string input', async () => {
    const h = await harness();
    const bad = [
      null,
      undefined,
      42,
      {},
      { toString: () => 'a'.repeat(43) },
    ] as unknown as string[];
    for (const value of bad) {
      expect(await h.service.start(ctx, value)).toEqual({ ok: false });
      expect(
        await h.service.finish(ctx, { token: h.token, password: value, code: '123456' }, META),
      ).toEqual({ ok: false });
      expect(
        await h.service.finish(ctx, { token: h.token, password: PASSWORD, code: value }, META),
      ).toEqual({ ok: false });
      expect(
        await h.service.finish(ctx, { token: value, password: PASSWORD, code: '123456' }, META),
      ).toEqual({ ok: false });
    }
    expect(h.calls).toEqual([]);
    expect(h.user.failedCount).toBe(0);
  });

  it('returns the uniform refusal when the input is not an object', async () => {
    const h = await harness();
    for (const input of [null, undefined, 'token', 42, []] as unknown as {
      token: string;
      password: string;
      code: string;
    }[]) {
      expect(await h.service.finish(ctx, input, META)).toEqual({ ok: false });
    }
    expect(h.calls).toEqual([]);
  });

  it('shares one frozen refusal object', async () => {
    const h = await harness();
    const refusals = [
      await h.service.start(ctx, randomToken(32)),
      await h.service.finish(
        ctx,
        { token: randomToken(32), password: PASSWORD, code: '123456' },
        META,
      ),
    ];
    for (const refusal of refusals) {
      expect(Object.isFrozen(refusal)).toBe(true);
    }
    expect(refusals[0]).toBe(refusals[1]);
  });

  it('propagates an unexpected credential read error instead of refusing', async () => {
    const h = await harness();
    const { secret } = await started(h);
    h.hooks.readError = new Error('database unavailable');
    await expect(
      h.service.finish(
        ctx,
        { token: h.token, password: PASSWORD, code: await codeFor(secret) },
        META,
      ),
    ).rejects.toThrow('database unavailable');
    expect(h.sessions).toHaveLength(0);
  });

  it('takes the credential id, revision and last step from the reservation snapshot', async () => {
    const h = await harness();
    const { secret } = await started(h);
    const lookupId = h.user.totpCredentialId as string;
    const reservedRow = await h.store.seal(ctx, {
      kind: 'totp',
      projectId: null,
      plaintext: encodeTotpEnvelope(USER, secret),
    });
    h.rows.set(reservedRow.id, reservedRow);
    h.hooks.reserved = (snapshot) => ({
      ...snapshot,
      totpCredentialId: reservedRow.id,
      credentialRev: 9,
      totpLastStep: STEP,
    });

    const replayed = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(secret) },
      META,
    );
    expect(replayed).toEqual({ ok: false });
    expect(h.completions).toHaveLength(0);

    const next = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(secret, 1) },
      META,
    );
    expect(next.ok).toBe(false);
    const input = h.completions[0];
    expect(input?.expectedCredentialId).toBe(reservedRow.id);
    expect(input?.expectedCredentialId).not.toBe(lookupId);
    expect(input?.credentialRev).toBe(9);
    expect(input?.step).toBe(STEP + 1);
  });

  it('refuses a reservation snapshot whose TOTP is already enabled', async () => {
    const h = await harness();
    const { secret } = await started(h);
    h.hooks.reserved = (snapshot) => ({ ...snapshot, totpEnabled: true, totpState: 'enabled' });
    const result = await h.service.finish(
      ctx,
      { token: h.token, password: PASSWORD, code: await codeFor(secret) },
      META,
    );
    expect(result).toEqual({ ok: false });
    expect(h.completions).toHaveLength(0);
    expect(h.sessions).toHaveLength(0);
  });

  it('does the same password and TOTP work for a wrong code, a foreign envelope and a missing credential', async () => {
    const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits');
    const sign = vi.spyOn(crypto.subtle, 'sign');
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');

    async function measure(prepare: (h: Harness) => Promise<Uint8Array>, wrong: boolean) {
      const h = await harness();
      const secret = await prepare(h);
      const code = wrong ? await wrongCode(secret) : await codeFor(secret);
      deriveBits.mockClear();
      sign.mockClear();
      decrypt.mockClear();
      const result = await h.service.finish(
        ctx,
        { token: h.token, password: PASSWORD, code },
        META,
      );
      return {
        ok: result.ok,
        derive: deriveBits.mock.calls.length,
        sign: sign.mock.calls.length,
        decrypt: decrypt.mock.calls.length,
      };
    }

    const success = await measure(async (h) => (await started(h)).secret, false);
    const wrongResult = await measure(async (h) => (await started(h)).secret, true);
    const foreign = await measure(async (h) => {
      await started(h);
      const secret = generateTotpSecret();
      await h.stageFor({ userId: OTHER_USER, secret });
      return secret;
    }, false);
    const missing = await measure(() => Promise.resolve(generateTotpSecret()), false);

    expect(success).toEqual({ ok: true, derive: 1, sign: SIGN, decrypt: 1 });
    expect(wrongResult).toEqual({ ok: false, derive: 1, sign: SIGN, decrypt: 1 });
    expect(foreign).toEqual({ ok: false, derive: 1, sign: SIGN, decrypt: 1 });
    expect(missing).toEqual({ ok: false, derive: 1, sign: SIGN, decrypt: 0 });
  });
});
