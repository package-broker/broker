import type { OrgContext, Statement } from './port.js';

export interface TrustedPublisherMatch {
  readonly packageName: string;
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly workflow: string;
  readonly environment: string;
}
export interface TrustedPublisherBinding extends TrustedPublisherMatch {
  readonly id: string;
  readonly servicePrincipalId: string;
  readonly refPattern: string | null;
  readonly revision: number;
}
export interface OidcReplayReservation {
  readonly issuer: string;
  readonly jti: string;
  readonly trustedPublisherId: string;
  readonly expectedRevision: number;
  /** Verified JWT exp, in seconds since epoch. */
  readonly expiresAt: number;
  readonly now: string;
}
export interface OidcReplayBatch {
  /** Append verbatim to the token and audit issuance batch. Never execute independently.
   * The replay INSERT and its changes() assertion must remain contiguous, with no
   * intervening statement: changes() refers to the immediately preceding write.
   */
  appendTo(batch: readonly Statement[]): readonly Statement[];
}
export interface OidcRepository {
  find(ctx: OrgContext, input: TrustedPublisherMatch): Promise<readonly TrustedPublisherBinding[]>;
  reserveStatements(ctx: OrgContext, input: OidcReplayReservation): OidcReplayBatch;
  /** Delete at most 100 expired rows of this organization and return the deleted count. */
  purge(ctx: OrgContext, now: string): Promise<number>;
}
