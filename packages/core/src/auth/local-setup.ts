import { hashPassword, passwordProblems } from './password.js';
import type { PasswordProblem } from './password.js';
import { sha256Hex } from './primitives.js';
import { SESSION_ABSOLUTE_MS, newSessionSecrets } from './session.js';
import type { SessionMeta, SessionService } from './session.js';
import {
  base32Encode,
  decodeTotpEnvelope,
  encodeTotpEnvelope,
  generateTotpSecret,
  provisioningUri,
  verifyTotp,
} from './totp.js';
import type { LocalLoginReader, LocalLoginSetupWriter } from '../db/local-login.js';
import type { OrgContext } from '../db/port.js';
import { isoTimestamp, type Clock } from '../ids.js';
import { SecretDecryptError } from '../secrets/cipher.js';
import { CredentialNotFoundError } from '../secrets/credential-store.js';
import type { CredentialStore } from '../secrets/credential-store.js';
import type { Keyring } from '../secrets/keyring.js';

export interface LocalSetupService {
  start(
    ctx: OrgContext,
    token: string,
  ): Promise<
    | { readonly ok: true; readonly provisioningUri: string; readonly secret: string }
    | { readonly ok: false }
  >;
  finish(
    ctx: OrgContext,
    input: { readonly token: string; readonly password: string; readonly code: string },
    meta: SessionMeta,
  ): Promise<
    | { readonly ok: true; readonly cookies: readonly string[]; readonly userId: string }
    | { readonly ok: false; readonly problems?: readonly PasswordProblem[] }
  >;
}

export interface LocalSetupDeps {
  readonly reader: LocalLoginReader;
  readonly writer: LocalLoginSetupWriter;
  readonly credentials: CredentialStore;
  readonly sessions: SessionService;
  readonly keyring: Keyring;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
}

const SETUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOCK_MS = 900_000;
const TOTP_KIND = 'totp';
const DUMMY_SECRET = new Uint8Array(20);
const REFUSED = Object.freeze({ ok: false } as const);

export function createLocalSetupService(deps: LocalSetupDeps): LocalSetupService {
  const { reader, writer, credentials, sessions, keyring, clock, ids } = deps;

  async function pendingSecret(
    ctx: OrgContext,
    credentialId: string | null,
    userId: string,
  ): Promise<Uint8Array | null> {
    if (credentialId === null) return null;
    let plaintext: Uint8Array;
    try {
      plaintext = await credentials.read(ctx, credentialId);
    } catch (error) {
      if (error instanceof CredentialNotFoundError || error instanceof SecretDecryptError) {
        return null;
      }
      throw error;
    }
    try {
      return decodeTotpEnvelope(plaintext, userId);
    } catch (error) {
      if (error instanceof TypeError) return null;
      throw error;
    } finally {
      plaintext.fill(0);
    }
  }

  return {
    async start(ctx, token) {
      if (typeof token !== 'string' || !SETUP_TOKEN_PATTERN.test(token)) return REFUSED;
      const setupHash = await sha256Hex(token);
      const snapshot = await reader.findBySetupHash(ctx, setupHash, isoTimestamp(clock.now()));
      if (snapshot === null || !snapshot.userActive || !snapshot.adminEligible) return REFUSED;

      const secret = generateTotpSecret();
      const envelope = encodeTotpEnvelope(snapshot.userId, secret);
      try {
        let uri: string;
        try {
          uri = provisioningUri(secret, snapshot.email);
        } catch (error) {
          if (error instanceof TypeError) return REFUSED;
          throw error;
        }
        const credential = await credentials.seal(ctx, {
          kind: TOTP_KIND,
          projectId: null,
          plaintext: envelope,
        });
        const staged = await writer.stagePendingTotp(ctx, {
          userId: snapshot.userId,
          setupHash,
          credential,
          opId: ids.ulid(),
          now: credential.now,
        });
        if (!staged) return REFUSED;
        return { ok: true, provisioningUri: uri, secret: base32Encode(secret) };
      } finally {
        envelope.fill(0);
        secret.fill(0);
      }
    },

    async finish(ctx, input, meta) {
      if (
        typeof input !== 'object' ||
        input === null ||
        typeof input.token !== 'string' ||
        typeof input.password !== 'string' ||
        typeof input.code !== 'string' ||
        !SETUP_TOKEN_PATTERN.test(input.token)
      ) {
        return REFUSED;
      }
      const now = clock.now();
      const nowIso = isoTimestamp(now);
      const setupHash = await sha256Hex(input.token);
      const found = await reader.findBySetupHash(ctx, setupHash, nowIso);
      if (found === null || !found.userActive || !found.adminEligible) return REFUSED;

      const problems = passwordProblems(input.password, found.email);
      if (problems.length > 0) return { ok: false, problems };

      const reservation = await reader.reserveAttempt(
        ctx,
        found.userId,
        nowIso,
        isoTimestamp(new Date(now.getTime() + LOCK_MS)),
      );
      if (!reservation.reserved) return REFUSED;
      const { snapshot } = reservation;

      const secret = await pendingSecret(ctx, snapshot.totpCredentialId, snapshot.userId);
      let totp: Awaited<ReturnType<typeof verifyTotp>>;
      let passwordHash: string;
      try {
        totp = await verifyTotp(
          secret ?? DUMMY_SECRET,
          input.code,
          now.getTime(),
          snapshot.totpLastStep,
        );
        passwordHash = await hashPassword(input.password, keyring);
      } finally {
        secret?.fill(0);
      }
      const credentialId = snapshot.totpCredentialId;
      if (secret === null || !totp.ok || credentialId === null || snapshot.totpEnabled) {
        return REFUSED;
      }

      const secrets = await newSessionSecrets();
      const expiresAt = isoTimestamp(new Date(now.getTime() + SESSION_ABSOLUTE_MS));
      const completed = await writer.completeSetup(ctx, {
        userId: snapshot.userId,
        setupHash,
        expectedCredentialId: credentialId,
        credentialRev: snapshot.credentialRev,
        passwordHash,
        step: totp.step,
        opId: ids.ulid(),
        session: {
          id: ids.ulid(),
          userId: snapshot.userId,
          identityId: null,
          secretHash: secrets.secretHash,
          csrfHash: secrets.csrfHash,
          expiresAt,
          ip: meta.ip,
          userAgent: meta.userAgent,
          now: nowIso,
        },
        previousSecretHash: meta.previousSecretHash,
        now: nowIso,
      });
      if (!completed) return REFUSED;
      return {
        ok: true,
        cookies: sessions.setCookies(secrets, expiresAt),
        userId: snapshot.userId,
      };
    },
  };
}
