import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';

/** The stored chain columns are verbatim; sourceIp is optional and is not hashed. */
export interface AuditRecordV1 {
  readonly chainId: string;
  readonly epoch: number;
  readonly id: string;
  readonly org_id: string;
  readonly seq: number;
  readonly prev_hash: string;
  readonly hash: string;
  readonly created_at: string;
  readonly actor_type: 'user' | 'service_principal' | 'customer' | 'system';
  readonly actor_id: string | null;
  readonly token_selector: string | null;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string | null;
  readonly project_id: string | null;
  readonly payload_json: string;
  readonly sourceIp?: string;
}

interface AuditMarkerIdentityV1 {
  readonly v: 1;
  readonly chain_id: string;
  readonly epoch: number;
  readonly org_id: string;
  /** A marker's own ULID, never the original event id. */
  readonly marker_id: string;
}

export type AuditMarkerV1 = AuditMarkerIdentityV1 &
  (
    | {
        readonly kind: 'boundary';
        readonly boundary_seq: number;
        readonly boundary_prev_hash: string;
        readonly provenance: string;
        readonly prior_archive_hint?: string;
      }
    | {
        readonly kind: 'gap';
        readonly from_seq: number;
        readonly to_seq: number;
        readonly count: number;
        readonly prev_hash: string;
        readonly hash: string;
        readonly reason: 'capacity';
        readonly policy_generation: number;
      }
    | {
        readonly kind: 'tombstone';
        readonly seq: number;
        readonly prev_hash: string;
        readonly hash: string;
        readonly reason_code: AuditSinkErrorCode;
      }
    | {
        readonly kind: 'delivery_uncertain';
        readonly from_seq: number;
        readonly to_seq: number;
        readonly reason_code: 'partial_rejected';
      }
    | ({
        readonly kind: 'withheld';
        readonly reason: 'content unavailable; hash link asserted, not recomputable';
      } & Pick<
        AuditRecordV1,
        | 'id'
        | 'seq'
        | 'prev_hash'
        | 'hash'
        | 'created_at'
        | 'actor_type'
        | 'actor_id'
        | 'action'
        | 'target_type'
        | 'target_id'
        | 'project_id'
      >)
    | { readonly kind: 'fork'; readonly last_common_seq: number; readonly last_common_hash: string }
    | {
        readonly kind: 'receiver_changed';
        readonly old_fingerprint: string;
        readonly new_fingerprint: string;
      }
    | {
        readonly kind: 'head';
        readonly seq: number;
        readonly hash: string;
        readonly boundary_seq: number;
      }
  );

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
  ): Promise<{ readonly items: readonly AuditRecordV1[]; readonly next: number | null }>;
  head(org: OrgContext): Promise<AuditHeadV1>;
  page(org: OrgContext, afterSeq: number, limit: number): Promise<readonly AuditRecordV1[]>;
  markVerified(org: OrgContext, scope: AuditVerificationScopeV1): Promise<void>;
}

export interface AuditTrailContext {
  readonly journal: AuditJournalReader;
  /** Only declared environment names are readable. */
  readonly env: (name: string) => string | undefined;
}

export interface AuditTrail {
  readonly envNames: readonly string[];
  /** Boot-time; accepts exactly on/off, and the required policy ignores the toggle. */
  active(): boolean;
}

export type AuditTrailFactory = (ctx: AuditTrailContext) => AuditTrail;

export type AuditSinkErrorCode =
  'network' | 'timeout' | 'refused' | 'too_large' | 'http_status' | 'bad_response';
export type AuditSinkWarningCode = 'partial_success';
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

/** Core enforces destination policy, credentials, no redirects and response/deadline caps. */
export type AuditFetch = (request: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
  /** Default 1500 ms; core caps this at 10000 ms. */
  readonly timeoutMs?: number;
  /** Node only, for loopback and link-local destinations. */
  readonly allowPrivate?: boolean;
}) => Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Core reads at most 64 KiB. */
  readonly body: string;
}>;

export interface AuditSinkContext {
  readonly runtime: 'docker' | 'cloudflare';
  /** Only declared environment names are readable. */
  readonly env: (name: string) => string | undefined;
  readonly fetch: AuditFetch;
  readonly clock: Clock;
}

export interface AuditSink {
  /** [a-z0-9-]{1,32}; unique cursor key across the composition. */
  readonly id: string;
  /** [a-z0-9-]{1,32}. */
  readonly kind: string;
  readonly envNames: readonly string[];
  /** Durable custody requires the operator's durableAck assertion; default delivery. */
  readonly custody: 'delivery' | 'durable';
  /** Defaults to include; source IP is not hashed. */
  readonly sourceIp: 'include' | 'omit';
  /** 1–100; default 100. */
  readonly maxBatchEvents?: number;
  /** 1–10; default 3. Only rejections allowed to retry by the protocol count. */
  readonly skipAfter?: number;
  activate(): { readonly receiverFingerprint: string; readonly activationSource: string } | null;
  deliver(batch: AuditBatchV1, signal: AbortSignal): Promise<AuditDelivery>;
  frontier?(signal: AbortSignal): Promise<{
    readonly chainId: string;
    readonly epoch: number;
    readonly seq: number;
    readonly hash: string;
  } | null>;
}

export type AuditSinkFactory = (ctx: AuditSinkContext) => readonly AuditSink[];

export interface AuditBatchV1 {
  readonly v: 1;
  readonly chainId: string;
  readonly epoch: number;
  readonly orgId: string;
  readonly records: readonly (AuditRecordV1 | AuditMarkerV1)[];
  readonly throughSeq: number;
  readonly throughHash: string;
}

/** ACKs echo the batch frontier. Throws become retry/network; codes never carry response text. */
export type AuditDelivery =
  | { readonly outcome: 'accepted'; readonly throughSeq: number; readonly throughHash: string }
  | {
      readonly outcome: 'accepted_with_warning';
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
