import type { AuditEvent } from '../../audit/actions.js';
import type { MutationFence } from '../../authz/fence.js';
import type { OrgContext } from '../../db/port.js';
import type { trustedPublisherInput } from './trusted-publishers-input.js';
import type { NPM_IDENTITY_SCHEMAS } from './npm-identity-schemas.js';
import type { output } from 'zod';

export type TrustedPublisher = output<typeof NPM_IDENTITY_SCHEMAS.TrustedPublisher>;
export type PublisherInput = ReturnType<typeof trustedPublisherInput>;
export interface RepositoryIdentity {
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
  readonly repository: string;
}
export type PublisherErrorCode =
  | 'invalid_request'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'name_not_claimed'
  | 'ambiguous_trusted_publisher'
  | 'unavailable';
export class TrustedPublisherError extends Error {
  constructor(readonly code: PublisherErrorCode) {
    super(code);
  }
}
export interface PublisherWrite {
  readonly input: PublisherInput;
  readonly identity: RepositoryIdentity;
  readonly now: string;
  readonly event: AuditEvent;
}
export interface TrustedPublisherStore {
  list(
    ctx: OrgContext,
    query?: { cursor?: string; limit?: number },
  ): Promise<{ items: TrustedPublisher[]; next: string | null }>;
  get(ctx: OrgContext, id: string): Promise<TrustedPublisher | null>;
  create(
    ctx: OrgContext,
    fence: MutationFence,
    write: PublisherWrite & { id: string; principalId: string },
  ): Promise<TrustedPublisher>;
  update(
    ctx: OrgContext,
    fence: MutationFence,
    write: PublisherWrite & { id: string; expectedRevision: number },
  ): Promise<TrustedPublisher>;
  disable(
    ctx: OrgContext,
    fence: MutationFence,
    write: { id: string; expectedRevision: number; now: string; event: AuditEvent },
  ): Promise<void>;
}
