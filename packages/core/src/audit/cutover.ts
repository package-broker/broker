import type { OrgContext } from '../db/port.js';
import { isUlid, ulid } from '../ids.js';
import { auditEvent, type AuditEvent } from './actions.js';
import { AUDIT_VERIFIED_EXPORT, type AuditLedgerEntry } from './ledger.js';

export interface AuditExportHead {
  readonly chainId: string;
  readonly epoch: number;
  readonly boundarySeq: number;
  readonly boundaryPrevHash: string;
  readonly headSeq: number;
  readonly headHash: string;
}

export interface VerifiedAuditArtifact extends AuditExportHead {
  readonly orgId: string | null;
  readonly bodies: number;
  readonly withheld: number;
}

export interface AuditCutoverPort {
  record(
    org: OrgContext,
    artifact: VerifiedAuditArtifact,
    generation: number,
    event: AuditEvent,
    entry: Omit<AuditLedgerEntry, 'policy' | 'modeGeneration'>,
  ): Promise<boolean>;
}

export async function registerAuditExport(
  port: AuditCutoverPort,
  org: OrgContext,
  artifact: VerifiedAuditArtifact,
  generation: number,
  actor: AuditEvent['actor'] & { type: 'user' | 'service_principal' },
  now: string,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !['user', 'service_principal'].includes(actor.type) ||
    !actor.id ||
    (!isUlid(actor.id) && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(actor.id)) ||
    !/^[0-9a-f]{32}$/.test(artifact.chainId) ||
    ![artifact.epoch, artifact.headSeq, artifact.bodies, artifact.withheld].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    !Number.isSafeInteger(artifact.boundarySeq) ||
    artifact.boundarySeq < 1 ||
    artifact.headSeq < artifact.boundarySeq ||
    artifact.orgId !== org.orgId ||
    artifact.withheld !== 0 ||
    artifact.bodies !== artifact.headSeq - artifact.boundarySeq + 1 ||
    ![artifact.headHash, artifact.boundaryPrevHash].every((h) => /^[0-9a-f]{64}$/.test(h))
  )
    throw new TypeError('Invalid verified audit export');
  const event = auditEvent({
    id: ulid(),
    now,
    actor,
    action: 'audit.export',
    target: { type: 'organization', id: org.orgId },
    context: { opId: ulid(), requestId: ulid(), tokenSelector: null, sourceIp: null },
    changes: {
      from_seq: { new: artifact.boundarySeq },
      to_seq: { new: artifact.headSeq },
      count: { new: artifact.bodies },
      withheld: { new: 0 },
      format: { new: 'jsonl' },
    },
  });
  if (!event.ok) throw new TypeError('Invalid audit export registration');
  return port.record(org, artifact, generation, event.event, {
    ...AUDIT_VERIFIED_EXPORT,
    id: ulid(),
    chainId: artifact.chainId,
    epoch: artifact.epoch,
    fromSeq: artifact.boundarySeq,
    toSeq: artifact.headSeq,
    count: artifact.bodies,
    actorType: actor.type,
    actorId: actor.id,
    createdAt: now,
  });
}
