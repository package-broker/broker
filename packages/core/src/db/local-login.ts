import type { OrgContext, Statement } from './port.js';
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
  stagePendingTotp(
    ctx: OrgContext,
    input: {
      readonly userId: string;
      readonly setupHash: string;
      readonly credential: Statement;
      readonly credentialId: string;
      readonly opId: string;
      readonly now: string;
    },
  ): Promise<boolean>;
  completeSetup(
    ctx: OrgContext,
    input: {
      readonly userId: string;
      readonly setupHash: string;
      readonly expectedCredentialId: string;
      readonly credentialRev: number;
      readonly passwordHash: string;
      readonly step: number;
      readonly opId: string;
      readonly session: NewSession;
      readonly previousSecretHash: string | null;
      readonly now: string;
    },
  ): Promise<boolean>;
}

export interface LocalLoginSuccessWriter {
  succeed(
    ctx: OrgContext,
    input: {
      readonly snapshot: LocalLoginSnapshot;
      readonly step: number;
      readonly opId: string;
      readonly rehash: string | null;
      readonly session: NewSession | null;
      readonly previousSecretHash: string | null;
      readonly reauthSessionId: string | null;
      readonly now: string;
    },
  ): Promise<boolean>;
}
