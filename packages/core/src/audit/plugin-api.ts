import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import type { AuditActorType } from './actions.js';

/** Core exposes the stored payload only after an equal sanitizer comparison. */
export interface AuditRecordV1 {
  readonly kind: 'event';
  readonly chainId: string;
  readonly epoch: number;
  readonly id: string;
  readonly orgId: string;
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
  readonly createdAt: string;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly tokenSelector: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly projectId: string | null;
  readonly payloadJson: string;
  readonly sourceIp?: string | null;
}

interface AuditMarkerIdentityV1 {
  readonly chainId: string;
  readonly epoch: number;
  /** A marker's own ULID, never the original event id. */
  readonly markerId: string;
}

export type AuditMarkerV1 = AuditMarkerIdentityV1 &
  (
    | {
        readonly kind: 'boundary';
        readonly boundarySeq: number;
        readonly boundaryPrevHash: string;
        readonly provenance: string;
        readonly priorArchiveHint?: string;
      }
    | {
        readonly kind: 'gap';
        readonly fromSeq: number;
        readonly toSeq: number;
        readonly count: number;
        readonly prevHash: string;
        readonly hash: string;
        readonly reason: 'capacity';
        readonly policyGeneration: number;
      }
    | {
        readonly kind: 'tombstone';
        readonly seq: number;
        readonly prevHash: string;
        readonly hash: string;
        readonly reasonCode: string;
      }
    | {
        readonly kind: 'delivery_uncertain';
        readonly fromSeq: number;
        readonly toSeq: number;
        readonly hash: string;
        readonly reasonCode: string;
      }
    | AuditWithheldMarkerV1
    | { readonly kind: 'fork'; readonly lastCommonSeq: number; readonly lastCommonHash: string }
    | {
        readonly kind: 'receiver_changed';
        readonly oldFingerprint: string;
        readonly newFingerprint: string;
      }
    | {
        readonly kind: 'head';
        readonly seq: number;
        readonly hash: string;
        readonly boundarySeq: number;
      }
  );

/** Withheld bodies cannot be recomputed; these fields assert only the chain link. */
export type AuditWithheldMarkerV1 = AuditMarkerIdentityV1 & {
  readonly kind: 'withheld';
  readonly reasonCode: string;
} & Pick<
    AuditRecordV1,
    | 'id'
    | 'orgId'
    | 'seq'
    | 'prevHash'
    | 'hash'
    | 'createdAt'
    | 'actorType'
    | 'actorId'
    | 'action'
    | 'targetType'
    | 'targetId'
    | 'projectId'
  >;

export type AuditJournalItemV1 = AuditRecordV1 | AuditWithheldMarkerV1;

export interface AuditVerificationScopeV1 {
  readonly fromSeq: number;
  readonly throughSeq: number;
  readonly bodies: number;
  readonly withheld: number;
  readonly verifiedAt: string;
}

export interface AuditHeadV1 {
  readonly chainId: string;
  readonly epoch: number;
  readonly headSeq: number;
  readonly headHash: string;
  readonly boundarySeq: number;
  readonly boundaryPrevHash: string;
  readonly pendingCount: number;
  readonly verification: AuditVerificationScopeV1 | null;
}

/** Core checks stored payloads against the sanitizer before returning records or withheld markers. */
export interface AuditJournalReader {
  list(
    org: OrgContext,
    q: {
      readonly projectId: string | null;
      readonly actor?: string;
      readonly action?: string;
      readonly afterSeq?: number;
      readonly limit: number;
    },
  ): Promise<{ readonly items: readonly AuditJournalItemV1[]; readonly next: number | null }>;
  head(org: OrgContext): Promise<AuditHeadV1>;
}

export interface AuditTrailDefinition {
  readonly toggleEnv?: string;
  readonly create: (ctx: AuditTrailContext) => AuditTrail;
}

export interface AuditTrailContext {
  readonly active: boolean;
  readonly journal: AuditJournalReader;
  readonly requestVerification: (org: OrgContext) => Promise<void>;
}

// Reserved by the public contract for later additive members.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AuditTrail {}

export type AuditSinkErrorCode =
  'network' | 'timeout' | 'refused' | 'too_large' | 'http_status' | 'bad_response';
export type AuditSinkWarningCode = 'partial_success';
/** Core destination resolution raises transport configuration codes; plugins may raise invalid_option. */
export type AuditSinkConfigErrorCode =
  | 'invalid_endpoint'
  | 'missing_credential'
  | 'invalid_headers'
  | 'unsupported_protocol'
  | 'unsupported_tls'
  | 'unsupported_compression'
  | 'invalid_timeout'
  | 'invalid_option';

export class AuditSinkConfigError extends Error {
  readonly code: AuditSinkConfigErrorCode;

  constructor(code: AuditSinkConfigErrorCode) {
    super('Invalid audit sink configuration');
    this.name = 'AuditSinkConfigError';
    this.code = code;
  }
}

export interface AuditSinkDefinition {
  readonly id: string;
  readonly kind: string;
  readonly destination: AuditDestinationSpec;
  readonly envNames?: readonly string[];
  readonly activation: 'build' | 'env';
  readonly custody: 'delivery' | 'durable';
  readonly sourceIp: 'include' | 'omit';
  readonly maxBatchEvents?: number;
  readonly skipAfter?: number;
  readonly create: (ctx: AuditSinkContext) => AuditSink;
}

export type AuditDestinationSpec =
  | {
      readonly protocol: 'otlp-http-json';
      readonly endpointEnv?: string;
      readonly headersEnv?: string;
    }
  | {
      readonly protocol: 'https-json';
      readonly urlEnv: string;
      readonly headersEnv?: string;
    };

/** Core resolves the destination and adds credentials before calling this transport. */
export type AuditBoundFetch = (request: {
  /** At most 512 KiB. */
  readonly body: string;
  readonly contentType: 'application/json';
  readonly signal: AbortSignal;
}) => Promise<{
  readonly status: number;
  readonly contentType: string | null;
  readonly retryAfterMs: number | null;
  /** At most 64 KiB. */
  readonly body: string;
}>;

export interface AuditSinkContext {
  readonly runtime: 'docker' | 'cloudflare';
  readonly fetch: AuditBoundFetch;
  /** Only declared non-destination envNames are readable. */
  readonly env: (name: string) => string | undefined;
  readonly clock: Clock;
}

export interface AuditSink {
  deliver(batch: AuditBatchV1, signal: AbortSignal): Promise<AuditDelivery>;
  frontier?(signal: AbortSignal): Promise<AuditPositionV1 | null>;
}

export interface AuditPositionV1 {
  readonly chainId: string;
  readonly epoch: number;
  readonly seq: number;
  readonly hash: string;
}

export interface AuditBatchV1 {
  readonly v: 1;
  readonly chainId: string;
  readonly epoch: number;
  readonly orgId: string;
  readonly records: readonly (AuditRecordV1 | AuditMarkerV1)[];
  /** Last covered seq, or unchanged progress for a batch of non-advancing markers only. */
  readonly throughSeq: number;
  /** Hash at throughSeq, including the unchanged progress hash for non-advancing markers. */
  readonly throughHash: string;
}

/** ACKs echo the batch frontier. Throws become retry/network; codes never carry response text. */
export type AuditDelivery =
  | {
      readonly outcome: 'accepted';
      readonly chainId: string;
      readonly epoch: number;
      readonly throughSeq: number;
      readonly throughHash: string;
    }
  | {
      readonly outcome: 'accepted_with_warning';
      readonly chainId: string;
      readonly epoch: number;
      readonly throughSeq: number;
      readonly throughHash: string;
      readonly code: AuditSinkWarningCode;
    }
  | {
      readonly outcome: 'uncertain';
      readonly code: 'partial_rejected';
      readonly rejectedCount: number;
    }
  | { readonly outcome: 'retry'; readonly code: AuditSinkErrorCode; readonly retryAfterMs?: number }
  | { readonly outcome: 'rejected'; readonly code: AuditSinkErrorCode };
