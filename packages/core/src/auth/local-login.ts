import { isReauthSessionActive } from './identity-reauth.js';
import { hashPassword, verifyDummy, verifyPassword } from './password.js';
import { SESSION_ABSOLUTE_MS, newSessionSecrets } from './session.js';
import type { AuthenticatedSession, SessionMeta, SessionService } from './session.js';
import { decodeTotpEnvelope, encodeTotpEnvelope, verifyTotp } from './totp.js';
import type {
  LocalLoginReader,
  LocalLoginSnapshot,
  LocalLoginSuccessWriter,
} from '../db/local-login.js';
import type { OrgContext } from '../db/port.js';
import type { SessionRepository } from '../db/sessions.js';
import { isoTimestamp } from '../ids.js';
import type { Clock } from '../ids.js';
import { normalizeEmail } from '../identity/policy.js';
import { reportableErrorName } from '../kernel/error-name.js';
import { SecretDecryptError, createSecretCipher } from '../secrets/cipher.js';
import type { Sealed } from '../secrets/cipher.js';
import { CredentialNotFoundError } from '../secrets/credential-store.js';
import type { CredentialStore } from '../secrets/credential-store.js';
import type { Keyring } from '../secrets/keyring.js';

export type LocalResult =
  | { readonly ok: true; readonly cookies: readonly string[]; readonly userId: string }
  | { readonly ok: false };

export type LocalReauthResult =
  { readonly ok: true } | { readonly ok: false; readonly reason?: 'session_inactive' };

export interface LocalLoginService {
  login(
    ctx: OrgContext,
    input: { readonly email: string; readonly password: string; readonly code: string },
    meta: SessionMeta,
  ): Promise<LocalResult>;
  reauth(
    ctx: OrgContext,
    session: AuthenticatedSession,
    input: { readonly password: string; readonly code: string },
  ): Promise<LocalReauthResult>;
}

export interface LocalLoginDeps {
  readonly reader: LocalLoginReader;
  readonly writer: LocalLoginSuccessWriter;
  readonly credentials: CredentialStore;
  readonly sessionCookies: Pick<SessionService, 'setCookies'>;
  readonly sessions: Pick<SessionRepository, 'findActiveById'>;
  readonly keyring: Keyring;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
}

export const LOCK_DURATION_MS = 900_000;

const DUMMY_AAD = 'local-login/dummy';
const DUMMY_SECRET = new Uint8Array(20);
const REFUSED = Object.freeze({ ok: false as const });

interface Verified {
  readonly snapshot: LocalLoginSnapshot;
  readonly step: number;
  readonly needsRehash: boolean;
  readonly nowMs: number;
}

function strings(...values: readonly unknown[]): boolean {
  return values.every((value) => typeof value === 'string');
}

function usable(snapshot: LocalLoginSnapshot): boolean {
  return (
    snapshot.userActive &&
    snapshot.adminEligible &&
    snapshot.passwordHash !== null &&
    snapshot.totpState === 'enabled' &&
    snapshot.totpCredentialId !== null
  );
}

export function createLocalLoginService(deps: LocalLoginDeps): LocalLoginService {
  const { reader, writer, credentials, sessionCookies, keyring, clock, ids } = deps;
  const cipher = createSecretCipher(keyring, 'credential-encryption');
  const dummyEnvelope: Promise<Sealed> = cipher.seal(
    encodeTotpEnvelope('dummy', DUMMY_SECRET),
    DUMMY_AAD,
  );
  dummyEnvelope.catch(() => undefined);

  async function readSecret(
    ctx: OrgContext,
    userId: string,
    credentialId: string,
  ): Promise<{ readonly secret: Uint8Array | null; readonly returned: boolean }> {
    let plaintext: Uint8Array;
    try {
      plaintext = await credentials.read(ctx, credentialId);
    } catch (error) {
      if (error instanceof SecretDecryptError || error instanceof CredentialNotFoundError) {
        return { secret: null, returned: false };
      }
      throw error;
    }
    try {
      return { secret: decodeTotpEnvelope(plaintext, userId), returned: true };
    } catch (error) {
      if (error instanceof TypeError) return { secret: null, returned: true };
      throw error;
    } finally {
      plaintext.fill(0);
    }
  }

  async function check(
    ctx: OrgContext,
    snapshot: LocalLoginSnapshot | null,
    password: string,
    code: string,
    nowMs: number,
  ): Promise<{
    readonly ok: boolean;
    readonly step: number;
    readonly needsRehash: boolean;
  }> {
    let passwordOk = false;
    let needsRehash = false;
    if (snapshot !== null && snapshot.passwordHash !== null) {
      const verdict = await verifyPassword(snapshot.passwordHash, password, keyring);
      passwordOk = verdict.ok;
      needsRehash = verdict.needsRehash;
    } else {
      await verifyDummy(password, keyring);
    }
    const credentialId = snapshot?.totpCredentialId ?? null;
    const read =
      snapshot !== null && credentialId !== null
        ? await readSecret(ctx, snapshot.userId, credentialId)
        : { secret: null, returned: false };
    if (!read.returned) await cipher.open(await dummyEnvelope, DUMMY_AAD);
    const totp = await verifyTotp(
      read.secret ?? DUMMY_SECRET,
      code,
      nowMs,
      snapshot?.totpLastStep ?? null,
    );
    read.secret?.fill(0);
    if (passwordOk && read.secret !== null && totp.ok) {
      return { ok: true, step: totp.step, needsRehash };
    }
    return { ok: false, step: 0, needsRehash: false };
  }

  async function attempt(
    ctx: OrgContext,
    email: string,
    password: string,
    code: string,
    expectedUserId: string | null,
  ): Promise<Verified | null> {
    const nowMs = clock.now().getTime();
    const refuse = async (): Promise<null> => {
      await check(ctx, null, password, code, nowMs);
      return null;
    };
    const normalized = normalizeEmail(email);
    if (normalized === null) return refuse();
    const found = await reader.findByEmail(ctx, normalized);
    if (
      found === null ||
      !usable(found) ||
      (expectedUserId !== null && found.userId !== expectedUserId)
    ) {
      return refuse();
    }
    const reservation = await reader.reserveAttempt(
      ctx,
      found.userId,
      isoTimestamp(new Date(nowMs)),
      isoTimestamp(new Date(nowMs + LOCK_DURATION_MS)),
    );
    if (
      !reservation.reserved ||
      reservation.snapshot.userId !== found.userId ||
      !usable(reservation.snapshot)
    ) {
      return refuse();
    }
    const { snapshot } = reservation;
    const verdict = await check(ctx, snapshot, password, code, nowMs);
    if (!verdict.ok) return null;
    return { snapshot, step: verdict.step, needsRehash: verdict.needsRehash, nowMs };
  }

  async function rehashAfterSuccess(
    ctx: OrgContext,
    verified: Verified,
    password: string,
  ): Promise<void> {
    if (!verified.needsRehash || verified.snapshot.passwordHash === null) return;
    try {
      const newHash = await hashPassword(password, keyring);
      await writer.replacePasswordHash(ctx, {
        userId: verified.snapshot.userId,
        expectedHash: verified.snapshot.passwordHash,
        newHash,
        now: isoTimestamp(new Date(verified.nowMs)),
      });
    } catch (error) {
      console.error(reportableErrorName(error));
    }
  }

  return {
    async login(ctx, input, meta) {
      if (input === null || typeof input !== 'object') return REFUSED;
      if (!strings(input.email, input.password, input.code)) return REFUSED;
      const verified = await attempt(ctx, input.email, input.password, input.code, null);
      if (verified === null) return REFUSED;
      const { snapshot, step, nowMs } = verified;
      const secrets = await newSessionSecrets();
      const expiresAt = isoTimestamp(new Date(nowMs + SESSION_ABSOLUTE_MS));
      const succeeded = await writer.succeed(ctx, {
        snapshot,
        step,
        rehash: null,
        session: {
          id: ids.ulid(),
          userId: snapshot.userId,
          identityId: null,
          secretHash: secrets.secretHash,
          csrfHash: secrets.csrfHash,
          expiresAt,
          ip: meta.ip,
          userAgent: meta.userAgent,
          now: isoTimestamp(new Date(nowMs)),
        },
        previousSecretHash: meta.previousSecretHash,
        reauthSessionId: null,
        now: isoTimestamp(new Date(nowMs)),
      });
      if (!succeeded) return REFUSED;
      await rehashAfterSuccess(ctx, verified, input.password);
      return {
        ok: true,
        cookies: sessionCookies.setCookies(secrets, expiresAt),
        userId: snapshot.userId,
      };
    },

    async reauth(ctx, authenticated, input) {
      if (!(await isReauthSessionActive(deps, ctx, authenticated.session.id))) {
        return { ok: false, reason: 'session_inactive' };
      }
      if (input === null || typeof input !== 'object') return REFUSED;
      if (!strings(input.password, input.code)) return REFUSED;
      const { session } = authenticated;
      if (session.identityId !== null) {
        await check(ctx, null, input.password, input.code, clock.now().getTime());
        return REFUSED;
      }
      const verified = await attempt(
        ctx,
        session.user.email,
        input.password,
        input.code,
        session.userId,
      );
      if (verified === null) return REFUSED;
      if (!(await isReauthSessionActive(deps, ctx, session.id))) {
        return { ok: false, reason: 'session_inactive' };
      }
      const succeeded = await writer.succeed(ctx, {
        snapshot: verified.snapshot,
        step: verified.step,
        rehash: null,
        session: null,
        previousSecretHash: null,
        reauthSessionId: session.id,
        now: isoTimestamp(new Date(verified.nowMs)),
      });
      if (!succeeded) return REFUSED;
      await rehashAfterSuccess(ctx, verified, input.password);
      return { ok: true };
    },
  };
}
