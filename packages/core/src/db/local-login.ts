import type { AuditEvent } from '../audit/actions.js';
import type { CredentialRecord } from './credentials.js';
import type { OrgContext } from './port.js';
import type { NewSession } from './sessions.js';

export type TotpState = 'none' | 'enabled' | 'setup_required';

/**
 * `totpEnabled` is `totp_enabled_at IS NOT NULL`. `totpState` is derived from it and
 * `totpCredentialId`: `enabled` with both set, `none` when TOTP was never enabled, and
 * `setup_required` when it was enabled but the credential is gone (deleting the credential nulls
 * `totpCredentialId` and leaves `totp_enabled_at` set). `setup_required` is never a verified code
 * and never "no TOTP needed".
 */
export interface LocalLoginSnapshot {
  readonly userId: string;
  readonly email: string;
  readonly userActive: boolean;
  readonly adminEligible: boolean;
  readonly passwordHash: string | null;
  readonly totpCredentialId: string | null;
  readonly totpEnabled: boolean;
  readonly totpState: TotpState;
  readonly totpLastStep: number | null;
  readonly credentialRev: number;
  readonly failedCount: number;
  readonly lockedUntil: string | null;
}

/** The refusal `reason` is advisory: it comes from a follow-up read that can race with other writers. */
export type Reservation =
  | { readonly reserved: true; readonly snapshot: LocalLoginSnapshot }
  | { readonly reserved: false; readonly reason: 'missing' | 'locked' };

export interface LocalLoginReader {
  /** The e-mail is normalised with `normalizeEmail`. Null when it is invalid or the user has no local login. */
  findByEmail(ctx: OrgContext, email: string): Promise<LocalLoginSnapshot | null>;
  /**
   * Null for an unknown hash and for a setup that expired at or before `now`. TypeError unless
   * `setupHash` is 64 lowercase hexadecimal characters and `now` is `YYYY-MM-DDTHH:MM:SS.mmmZ`.
   */
  findBySetupHash(
    ctx: OrgContext,
    setupHash: string,
    now: string,
  ): Promise<LocalLoginSnapshot | null>;
  /**
   * Counts one attempt atomically: `failed_count + 1`, and `locked_until = lockUntil` when the new
   * count is a multiple of 5, unless the row is locked at `now`. The snapshot holds the values
   * after the update, so the attempt that reached the limit already carries its own `lockedUntil`.
   * One statement on success; a refusal adds one read to tell `missing` from `locked`. TypeError
   * unless `now` and `lockUntil` are `YYYY-MM-DDTHH:MM:SS.mmmZ`; RangeError unless `lockUntil` is
   * after `now`.
   */
  reserveAttempt(
    ctx: OrgContext,
    userId: string,
    now: string,
    lockUntil: string,
  ): Promise<Reservation>;
}

export interface LocalLoginSetupWriter {
  /**
   * One batch. `credential` is the pending TOTP credential row (the writer validates it like
   * `CredentialRepository.insertStatement`); its id becomes `totp_credential_id`. True when the
   * batch staged it: the setup hash matched an unexpired setup of a user whose TOTP is not enabled,
   * the previous pending credential is deleted and every later statement was guarded by the
   * operation marker. The writer mints that marker itself for every call: a
   * caller-chosen marker could match an earlier operation. TypeError unless `setupHash` is 64
   * lowercase hexadecimal characters, `now` and `credential.now` are the same
   * `YYYY-MM-DDTHH:MM:SS.mmmZ` instant, and `credential` is an organization-level (`projectId`
   * null) credential of kind `totp`.
   */
  stagePendingTotp(
    ctx: OrgContext,
    input: {
      readonly userId: string;
      readonly setupHash: string;
      readonly credential: CredentialRecord & { readonly now: string };
      readonly now: string;
    },
  ): Promise<boolean>;
  /**
   * One batch. True when the session row exists afterwards; false when a precondition no longer
   * holds. Like `stagePendingTotp` it mints its own operation marker. TypeError
   * unless `session.userId` is `userId`, `session.identityId` is null, `session.now` equals `now`,
   * the hashes are 64 lowercase hexadecimal characters, `passwordHash` starts with
   * `pbkdf2-sha256$` and the timestamps are `YYYY-MM-DDTHH:MM:SS.mmmZ`;
   * RangeError unless `step` and `credentialRev` are non-negative safe integers.
   */
  completeSetup(
    ctx: OrgContext,
    input: {
      readonly userId: string;
      readonly setupHash: string;
      readonly expectedCredentialId: string;
      readonly credentialRev: number;
      readonly passwordHash: string;
      readonly step: number;
      readonly session: NewSession;
      readonly previousSecretHash: string | null;
      readonly now: string;
    },
  ): Promise<boolean>;
}

export interface LocalLoginSuccessWriter {
  /**
   * One statement. Replaces only an active user's matching password hash in this organization,
   * increments credential_rev and sets updated_at to now. False when the comparison no longer
   * matches. TypeError unless now is YYYY-MM-DDTHH:MM:SS.mmmZ and newHash starts with pbkdf2-sha256$.
   */
  replacePasswordHash(
    ctx: OrgContext,
    input: {
      readonly userId: string;
      readonly expectedHash: string;
      readonly newHash: string;
      readonly now: string;
    },
  ): Promise<boolean>;
  succeed(
    ctx: OrgContext,
    input: {
      readonly audit: AuditEvent;
      readonly snapshot: LocalLoginSnapshot;
      readonly step: number;
      readonly rehash: string | null;
      readonly session: NewSession | null;
      readonly previousSecretHash: string | null;
      readonly reauthSessionId: string | null;
      readonly now: string;
    },
  ): Promise<boolean>;
}
