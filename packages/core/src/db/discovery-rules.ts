import type { ApplyOutcome } from '../sources/bulk-discovery.js';
import type { AuditEvent } from '../audit/actions.js';
import type { ApiCall } from '../api/idempotency.js';
import type { DiscoveryRuleFence, MutationFence } from '../authz/fence.js';
import type { OrgContext } from './port.js';

export interface DiscoveryRuleOptions {
  readonly name: string;
  readonly credentialId: string;
  readonly installationId: number;
  readonly ecosystem: 'composer' | 'npm' | 'both';
  readonly pattern: string;
  readonly includeForks: boolean;
  readonly enabled: boolean;
  readonly intervalSeconds: number;
}
export interface DiscoveryRuleState {
  readonly pendingResults?: readonly ApplyOutcome[];
  readonly consecutiveFailures?: number;
  readonly failureReason?: string | null;
  readonly completed?: DiscoveryRuleResults | null;
  readonly lastRunAt: string | null;
  readonly outcome: 'running' | 'succeeded' | 'failed' | 'rate_limited' | null;
  readonly created: number;
  readonly existing: number;
  readonly skipped: number;
  readonly failed: number;
  readonly skips: readonly { readonly repository: string; readonly reason: string | null }[];
  readonly cursor: string | null;
  readonly remaining: readonly string[];
  readonly nextRunAt: string | null;
}
export interface DiscoveryRuleResults {
  readonly lastRunAt: string | null;
  readonly outcome: 'succeeded' | 'failed' | null;
  readonly created: number;
  readonly existing: number;
  readonly skipped: number;
  readonly failed: number;
  readonly skips: DiscoveryRuleState['skips'];
  readonly failureReason?: string | null;
}
export interface DiscoveryRule extends DiscoveryRuleOptions, DiscoveryRuleState {
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type DiscoveryRuleWriteResult =
  | 'ok'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'duplicate'
  | 'indeterminate'
  | 'discovery_rule_disabled';
export interface DiscoveryRuleRepository {
  list(ctx: OrgContext, after: string | null, limit: number): Promise<readonly DiscoveryRule[]>;
  get(ctx: OrgContext, id: string): Promise<DiscoveryRule | null>;
  due(ctx: OrgContext, now: string): Promise<readonly DiscoveryRule[]>;
  create(
    ctx: OrgContext,
    fence: MutationFence,
    input: {
      id: string;
      options: DiscoveryRuleOptions;
      now: string;
      audit: AuditEvent;
      call: ApiCall;
    },
  ): Promise<DiscoveryRuleWriteResult>;
  update(
    ctx: OrgContext,
    fence: MutationFence,
    input: {
      id: string;
      revision: number;
      options: DiscoveryRuleOptions;
      now: string;
      audit: AuditEvent;
      call: ApiCall;
      credentialChanged: boolean;
    },
  ): Promise<DiscoveryRuleWriteResult>;
  delete(
    ctx: OrgContext,
    fence: MutationFence,
    input: { id: string; revision: number; audit: AuditEvent; call: ApiCall },
  ): Promise<DiscoveryRuleWriteResult>;
  runNow(
    ctx: OrgContext,
    fence: MutationFence,
    input: { id: string; now: string; audit: AuditEvent; call: ApiCall },
  ): Promise<DiscoveryRuleWriteResult>;
  checkpoint(
    ctx: OrgContext,
    fence: DiscoveryRuleFence,
    state: DiscoveryRuleState,
    audit?: AuditEvent | readonly AuditEvent[],
  ): Promise<boolean>;
}
