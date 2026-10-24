import type { AuditEvent } from '../audit/actions.js';
import type { OrgContext } from './port.js';

export interface SessionRow {
  readonly id: string;
  readonly userId: string;
  readonly identityId: string | null;
  readonly csrfHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string | null;
  readonly reauthAt: string | null;
}

export interface ActiveSession extends SessionRow {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string | null;
  };
}

export interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly identityId: string | null;
  readonly secretHash: string;
  readonly csrfHash: string;
  readonly expiresAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly now: string;
}

export interface SessionCutoffs {
  readonly now: string;
  readonly idleSince: string;
}

export interface SessionRepository {
  /**
   * One statement. TypeError unless `secretHash` is 64 lowercase hex characters and every timestamp
   * parameter (here and in the other methods) is `YYYY-MM-DDTHH:MM:SS.mmmZ`. Null for an unknown
   * hash, another organization, a revoked, expired, 12-hour-old or idle session (idle:
   * `coalesce(last_seen_at, created_at)` not after `idleSince`) and an inactive user. Malformed stored liveness timestamps fail closed.
   */
  findActive(
    ctx: OrgContext,
    secretHash: string,
    cutoffs: SessionCutoffs,
  ): Promise<ActiveSession | null>;
  /**
   * Same liveness and timestamp contract as `findActive`, keyed by session id. Null for an unknown
   * id or another organization. TypeError unless `id` is a non-empty string, before any query.
   */
  findActiveById(
    ctx: OrgContext,
    id: string,
    cutoffs: SessionCutoffs,
  ): Promise<ActiveSession | null>;
  /**
   * Sets `last_seen_at` only when the last sign of life is before `staleBefore`. Valid only right
   * after `findActive` succeeded: it re-checks revocation and absolute expiry but not idle expiry.
   */
  touch(ctx: OrgContext, id: string, now: string, staleBefore: string): Promise<void>;
  /**
   * Atomically stages the audit event and moves `reauth_at` forward to `authTime`. True when a row
   * changed; false for a revoked or expired session, another identity (`null` matches only a session
   * without identity), an `authTime` later than `now` and an `authTime` that is not later than the
   * stored `reauth_at`.
   */
  markReauthenticatedByIdentity(
    ctx: OrgContext,
    input: {
      readonly audit: AuditEvent;
      readonly sessionId: string;
      readonly identityId: string | null;
      readonly authTime: string;
      readonly now: string;
    },
  ): Promise<boolean>;
  revoke(ctx: OrgContext, id: string, now: string): Promise<boolean>;
  revokeBySecretHash(ctx: OrgContext, secretHash: string, now: string): Promise<boolean>;
  /** Deletes at most `limit` sessions with `expires_at < before`; RangeError unless `limit` is an integer from 1 to 500. */
  deleteExpired(ctx: OrgContext, before: string, limit: number): Promise<number>;
}
