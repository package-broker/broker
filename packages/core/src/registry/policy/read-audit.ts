import { auditEvent, type AuditActorType, type AuditEvent } from '../../audit/actions.js';
import type { OrgContext } from '../../db/port.js';
import type { Clock } from '../../ids.js';
import type { PolicyEcosystem } from '../../db/registry-policy.js';
import { RegistryPolicyUnavailableError } from './errors.js';
import type { PolicyDenialReason, PolicyPrincipal } from './types.js';

export const MAX_REASONS_PER_EVENT = 32;

/** Durable writer for policy read evidence; resolves only once every event is persisted. */
export interface PolicyReadAuditSink {
  record(ctx: OrgContext, events: readonly AuditEvent[]): Promise<void>;
}

export type PolicyEvidence =
  | {
      readonly kind: 'rule';
      readonly ruleId: string;
      readonly ruleRevision: number;
      readonly reason: PolicyDenialReason;
    }
  | { readonly kind: 'plugin'; readonly plugin: string; readonly reason: PolicyDenialReason };

export interface DirectDenial {
  readonly readKind: 'version' | 'tag' | 'dist';
  readonly ecosystem: PolicyEcosystem;
  readonly packageKey: string;
  readonly versionId: string;
  readonly revision: number;
  readonly evidence: readonly PolicyEvidence[];
}

export interface DirectDenialAuditDeps {
  readonly sink: PolicyReadAuditSink;
  readonly ids: { ulid(): string };
  readonly clock: Clock;
  readonly ctx: OrgContext;
  readonly requestId: string;
  readonly projectId: string;
  readonly principal: PolicyPrincipal;
}

export interface DirectDenialAudit {
  /** Persists the evidence before the caller may answer 404; a failure is the fixed 503. */
  record(denial: DirectDenial): Promise<void>;
}

const ACTOR_TYPES: Readonly<Record<PolicyPrincipal['kind'], AuditActorType>> = {
  user: 'user',
  service: 'service_principal',
  customer: 'customer',
};

function reasonText(evidence: PolicyEvidence): string {
  return evidence.kind === 'rule'
    ? `rule:${evidence.ruleId}:${String(evidence.ruleRevision)}:${evidence.reason}`
    : `plugin:${evidence.plugin}:${evidence.reason}`;
}

export function createDirectDenialAudit(deps: DirectDenialAuditDeps): DirectDenialAudit {
  const recorded = new Set<string>();

  function build(denial: DirectDenial, reasons: readonly string[], opId: string): AuditEvent {
    const result = auditEvent({
      id: deps.ids.ulid(),
      now: deps.clock.now().toISOString(),
      action: 'policy.read_denied',
      actor: { type: ACTOR_TYPES[deps.principal.kind], id: deps.principal.id },
      context: { opId, requestId: deps.requestId, sourceIp: null, tokenSelector: null },
      target: { type: 'version', id: denial.versionId },
      projectId: deps.projectId,
      changes: {
        read_kind: { new: denial.readKind },
        ecosystem: { new: denial.ecosystem },
        package_key: { new: denial.packageKey },
        version_id: { new: denial.versionId },
        version_revision: { new: denial.revision },
        reasons: { new: reasons },
      },
    });
    if (!result.ok) throw new RegistryPolicyUnavailableError();
    return result.event;
  }

  return {
    async record(denial) {
      const key = `${denial.versionId}\u0000${String(denial.revision)}`;
      if (recorded.has(key)) return;
      const reasons = [...new Set(denial.evidence.map(reasonText))];
      if (reasons.length === 0) throw new RegistryPolicyUnavailableError();
      const opId = deps.ids.ulid();
      const events: AuditEvent[] = [];
      for (let offset = 0; offset < reasons.length; offset += MAX_REASONS_PER_EVENT) {
        events.push(build(denial, reasons.slice(offset, offset + MAX_REASONS_PER_EVENT), opId));
      }
      try {
        await deps.sink.record(deps.ctx, events);
      } catch {
        throw new RegistryPolicyUnavailableError();
      }
      recorded.add(key);
    },
  };
}
