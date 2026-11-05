import type { AuditEvent } from '../audit/actions.js';
import type { AnyMutationFence } from '../authz/fence.js';
import type { OrgContext } from './port.js';

export const PUBLISH_PURGE_WINDOW_DAYS = 7;
export const PUBLISH_APPROVAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const PUBLISH_APPROVAL_EXPIRY_BATCH_SIZE = 10;
/** 25 * 15 recovery statements + page read + continuation enqueue, with 50 for the runner. */
export const PUBLISH_SCAN_RECOVERY_BATCH_SIZE = 25;

export const PUBLISH_APPROVAL_STATES = [
  'not_required',
  'pending',
  'approved',
  'rejected',
  'expired',
] as const;
export const PUBLISH_SCAN_STATES = [
  'not_required',
  'queued',
  'running',
  'allowed',
  'denied',
  'failed',
] as const;
export type PublishApprovalState = (typeof PUBLISH_APPROVAL_STATES)[number];
export type PublishScanState = (typeof PUBLISH_SCAN_STATES)[number];
export type PackageAccessRequestState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PublishReadme {
  readonly filename: string;
  readonly body: string;
}

export interface PublishScannerVerdict {
  readonly plugin: string;
  readonly verdict: 'allow' | 'deny';
  readonly reason?: string;
}

export interface PublishApproval {
  readonly id: string;
  readonly packageId: string;
  readonly versionId: string;
  readonly sourceId: string;
  readonly holdApproval: boolean;
  readonly holdScan: boolean;
  readonly approvalState: PublishApprovalState;
  readonly scanState: PublishScanState;
  readonly requiredScanners: readonly string[];
  readonly scanAttempts: number;
  readonly requestedByType: 'user' | 'service';
  readonly requestedById: string;
  readonly tokenId: string;
  readonly routeProjectId: string | null;
  readonly distTags: Readonly<Record<string, string>>;
  readonly readmePending: boolean;
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly scanVerdicts: readonly PublishScannerVerdict[];
  readonly expiresAt: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PublishApprovalInsert = Omit<
  PublishApproval,
  | 'revision'
  | 'createdAt'
  | 'updatedAt'
  | 'scanAttempts'
  | 'decidedByUserId'
  | 'decidedAt'
  | 'decisionReason'
>;

export interface PublishTransition {
  readonly id: string;
  readonly expectedRevision: number;
  readonly expectedApprovalState: PublishApprovalState;
  readonly expectedScanState: PublishScanState;
  readonly now: string;
  readonly event: AuditEvent;
}

export interface PublishDecision extends PublishTransition {
  readonly decision: 'approved' | 'rejected';
  readonly decidedByUserId: string;
  readonly reason?: string;
}

export interface PublishScanTransition extends PublishTransition {
  readonly scanState: PublishScanState;
  readonly verdicts: readonly PublishScannerVerdict[];
}

export interface PublishTransitionResult {
  readonly changed: boolean;
  readonly active: boolean;
  readonly revision: number;
}

export interface PublishInspection extends PublishApproval {
  readonly packageName: string;
  readonly version: string;
  readonly sourceName: string;
  readonly requestedBy: { readonly type: 'user' | 'service'; readonly name: string };
  readonly decidedBy: { readonly name: string } | null;
  readonly project: { readonly id: string; readonly slug: string; readonly name: string } | null;
}

export interface PublishesRepository {
  listScanQueued(
    ctx: OrgContext,
    before: string,
    runningBefore?: string,
    after?: string,
  ): Promise<readonly PublishInspection[]>;
  scanInput(
    ctx: OrgContext,
    id: string,
  ): Promise<{
    readonly sha256: import('../platform/blob.js').Sha256;
    readonly manifest: Readonly<Record<string, unknown>>;
    readonly integrity: string;
    readonly sizeBytes: number;
  } | null>;
  listExpired(ctx: OrgContext, now: string): Promise<readonly PublishInspection[]>;
  get(ctx: OrgContext, id: string): Promise<PublishInspection | null>;
  list(
    ctx: OrgContext,
    query: {
      readonly state?: PublishApprovalState;
      readonly actionable?: boolean;
      readonly cursor?: string;
      readonly limit: number;
    },
  ): Promise<{ readonly items: readonly PublishInspection[]; readonly next: string | null }>;
  decide(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: PublishDecision,
  ): Promise<PublishTransitionResult>;
  expire(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: PublishTransition,
  ): Promise<PublishTransitionResult>;
  scan(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: PublishScanTransition,
  ): Promise<PublishTransitionResult>;
  rescan(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: PublishTransition,
  ): Promise<PublishTransitionResult>;
}

export interface PackageAccessRequest {
  readonly packageName: string;
  readonly requestedBy: { readonly type: 'user'; readonly name: string };
  readonly decidedBy: { readonly name: string } | null;
  readonly project: { readonly id: string; readonly slug: string; readonly name: string };
  readonly id: string;
  readonly packageId: string;
  readonly projectId: string;
  readonly state: PackageAccessRequestState;
  readonly requestedByUserId: string;
  readonly reason: string | null;
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly expiresAt: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PackageAccessRequestInput {
  readonly id: string;
  readonly packageId: string;
  readonly projectId: string;
  readonly requestedByUserId: string;
  readonly reason?: string;
  readonly expiresAt: string;
  readonly now: string;
  readonly event: AuditEvent;
}

export interface PackageAccessDecision {
  readonly id: string;
  readonly expectedRevision: number;
  readonly state: 'approved' | 'rejected' | 'expired';
  readonly decidedByUserId: string | null;
  readonly reason?: string;
  readonly now: string;
  readonly event: AuditEvent;
}

export interface RequestablePackage {
  readonly id: string;
  readonly name: string;
  readonly newProjectAccessMode: 'request';
}

export interface AccessRequestPage {
  readonly cursor?: string;
  readonly limit: number;
}

export class PackageAccessRequestError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'conflict'
      | 'not_found'
      | 'unavailable'
      | 'invalid_request'
      | 'source_not_attached',
  ) {
    super(code);
    this.name = 'PackageAccessRequestError';
  }
}

export interface PackageAccessRequestRepository {
  requestable(
    ctx: OrgContext,
    projectId: string,
    page: AccessRequestPage,
  ): Promise<{ readonly items: readonly RequestablePackage[]; readonly next: string | null }>;
  due(ctx: OrgContext): Promise<readonly PackageAccessRequest[]>;
  get(ctx: OrgContext, id: string): Promise<PackageAccessRequest | null>;
  list(
    ctx: OrgContext,
    query: {
      readonly state?: PackageAccessRequestState;
      readonly cursor?: string;
      readonly limit: number;
    },
  ): Promise<{ readonly items: readonly PackageAccessRequest[]; readonly next: string | null }>;
  request(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: PackageAccessRequestInput,
  ): Promise<PackageAccessRequest>;
  decide(
    ctx: OrgContext,
    fence: AnyMutationFence,
    input: PackageAccessDecision,
  ): Promise<{ readonly changed: boolean; readonly revision: number }>;
}
