import type { OrgContext } from '../db/port.js';
import { isUlid, ulid } from '../ids.js';
import { auditEvent, type AuditEvent } from './actions.js';
import { auditCustodySeq, auditDurableCoverage } from './export-state.js';
import {
  confirmAuditRestore,
  AuditForkLimitError,
  type AuditForkPort,
  type AuditForkSnapshot,
  type AuditForkReason,
} from './fork.js';
import type { AuditLedgerEntry } from './ledger.js';
import type { AuditBatchV1 } from './plugin-api.js';
import { auditWireMarker } from './wire.js';

export type AuditSinkAdminCommand =
  | { readonly operation: 'list' }
  | { readonly operation: 'policy_set'; readonly policy: 'availability' | 'required' }
  | { readonly operation: 'confirm_restore'; readonly fromSeq: number }
  | { readonly operation: 'retire'; readonly sinkId: string; readonly confirm: string }
  | { readonly operation: 'unblock'; readonly sinkId: string }
  | { readonly operation: 'replay' | 'rebind'; readonly sinkId: string; readonly fromSeq: number }
  | { readonly operation: 'skip'; readonly sinkId: string; readonly seq: number }
  | { readonly operation: 'resolve'; readonly sinkId: string; readonly ledgerId: string };

export interface AuditSinkAdminSnapshot extends AuditForkSnapshot {
  readonly mode: 'none' | 'trail' | 'export';
  readonly pendingMode: 'none' | 'trail' | 'export' | null;
}

export interface AuditSinkAdminPort extends AuditForkPort {
  read(org: OrgContext): Promise<AuditSinkAdminSnapshot>;
  actorExists(org: OrgContext, actor: AuditSinkAdminOptions['actor']): Promise<boolean>;
  resolution(
    org: OrgContext,
    id: string,
  ): Promise<{
    readonly target: AuditLedgerEntry | null;
    readonly resolved: boolean;
  }>;
}

export class AuditSinkAdminError extends Error {
  override readonly name = 'AuditSinkAdminError';
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AuditSinkAdminOptions {
  readonly alert: (reason: AuditForkReason) => void;
  readonly generation: number;
  readonly now: Date;
  readonly actor: AuditEvent['actor'] & { type: 'user' | 'service_principal' };
}

/** Retirement confirmation names the entire replay range being relinquished. */
export function auditRetirementConfirmation(sinkId: string, from: number, through: number): string {
  return `${sinkId}:${from}-${through}`;
}

export async function administerAuditSink(
  port: AuditSinkAdminPort,
  org: OrgContext,
  command: AuditSinkAdminCommand,
  options: AuditSinkAdminOptions,
): Promise<{
  readonly result: 'applied' | 'stale' | 'contended';
  readonly sinks?: readonly unknown[];
}> {
  if (
    !Number.isSafeInteger(options.generation) ||
    options.generation < 0 ||
    !['user', 'service_principal'].includes(options.actor.type) ||
    options.actor.id === null ||
    (!isUlid(options.actor.id) &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.actor.id)) ||
    ('sinkId' in command && !/^[a-z0-9-]{1,32}$/.test(command.sinkId)) ||
    (command.operation === 'resolve' && !isUlid(command.ledgerId)) ||
    (command.operation === 'policy_set' && !['required', 'availability'].includes(command.policy))
  )
    throw new TypeError('Invalid audit administration input');
  if (!(await port.actorExists(org, options.actor)))
    throw new AuditSinkAdminError('actor_unavailable', 'Audit operator unavailable');
  const snapshot = await port.read(org).catch((error: unknown) => {
    if (error instanceof AuditForkLimitError) options.alert(error.reason);
    throw error;
  });
  const highestGeneration = Math.max(0, ...snapshot.sinks.map((sink) => sink.generation));
  if (snapshot.sinks.some((sink) => sink.generation > options.generation))
    return { result: 'stale' };
  if (options.generation > highestGeneration)
    throw new AuditSinkAdminError('generation_ahead', 'Audit generation exceeds stored generation');
  if (command.operation === 'list') {
    return {
      result: 'applied',
      sinks: snapshot.sinks.map((sink) => ({
        id: sink.id,
        state: sink.state,
        generation: sink.generation,
        progressSeq: sink.progressSeq,
        custodySeq: sink.custodySeq,
        durableAck: sink.durableAck,
        ...(['disabled', 'inactive'].includes(sink.state) && sink.progressSeq < snapshot.headSeq
          ? {
              retireConfirmation: auditRetirementConfirmation(
                sink.id,
                sink.progressSeq + 1,
                snapshot.headSeq,
              ),
            }
          : {}),
      })),
    };
  }
  const hasDurableWitness = (sinks: readonly AuditForkSnapshot['sinks'][number][]) =>
    sinks.some((sink) => sink.durableAck && ['active', 'blocked'].includes(sink.state));
  if (
    command.operation === 'policy_set' &&
    command.policy === 'required' &&
    (snapshot.mode === 'none' ||
      snapshot.pendingMode === 'none' ||
      ((snapshot.pendingMode ?? snapshot.mode) === 'export' && !hasDurableWitness(snapshot.sinks)))
  )
    throw new AuditSinkAdminError('policy_unavailable', 'Audit required policy unavailable');
  if (command.operation === 'policy_set' && command.policy === snapshot.policy)
    return { result: 'applied' };
  if (command.operation === 'confirm_restore') {
    const result = await confirmAuditRestore(port, org, {
      ...options,
      fromSeq: command.fromSeq,
    });
    return { result: result === 'confirmed' ? 'applied' : result };
  }
  if (snapshot.restorePending && !['list', 'policy_set'].includes(command.operation))
    throw new AuditSinkAdminError('restore_required', 'Audit restore confirmation required');
  const now = options.now.toISOString();
  const sinks = [...snapshot.sinks];
  const observed: { seq: number; hash: string | null }[] = [];
  const hashAt = async (seq: number) => {
    if (seq === snapshot.boundarySeq - 1) return snapshot.boundaryPrevHash;
    const hash = await port.hashAt(org, seq);
    observed.push({ seq, hash });
    if (hash === null)
      throw new AuditSinkAdminError('position_unavailable', 'Audit position unavailable');
    return hash;
  };
  let from = Math.max(1, snapshot.headSeq);
  let through = from;
  let kind: AuditLedgerEntry['kind'] =
    command.operation === 'policy_set'
      ? 'policy_change'
      : command.operation === 'skip'
        ? 'skipped'
        : command.operation === 'resolve'
          ? 'replay'
          : command.operation;
  let resolvesId: string | undefined;
  if ('sinkId' in command) {
    const index = sinks.findIndex((sink) => sink.id === command.sinkId);
    const sink = sinks[index];
    if (!sink || sink.state === 'retired')
      throw new AuditSinkAdminError('sink_unavailable', 'Audit sink unavailable');
    let next = { ...sink };
    let repr: Record<string, unknown>;
    try {
      repr = JSON.parse(sink.inflightRepr ?? '{}') as Record<string, unknown>;
      if (
        !repr ||
        typeof repr !== 'object' ||
        Array.isArray(repr) ||
        !Number.isSafeInteger(repr.custodyFromSeq) ||
        Number(repr.custodyFromSeq) < 1
      )
        throw new Error();
    } catch {
      throw new AuditSinkAdminError(
        'representation_malformed',
        'Audit sink representation malformed',
      );
    }
    if (command.operation === 'retire') {
      from = sink.progressSeq + 1;
      through = snapshot.headSeq;
      if (!['disabled', 'inactive'].includes(sink.state))
        throw new AuditSinkAdminError('retire_state', 'Audit sink retirement unavailable');
      if (from > through)
        throw new AuditSinkAdminError('retire_empty', 'Audit retirement range empty');
      if (command.confirm !== auditRetirementConfirmation(sink.id, from, snapshot.headSeq))
        throw new TypeError('Audit retirement confirmation mismatch');
      next.state = 'retired';
    } else if (command.operation === 'unblock') {
      if (sink.state !== 'blocked' || sink.blockedReason === 'fork')
        throw new AuditSinkAdminError('unblock_unavailable', 'Audit sink unblock unavailable');
      next = {
        ...next,
        state: 'active',
        blockedReason: null,
        attempt: 0,
        retryCountForSeq: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
      };
    } else if (command.operation === 'replay' || command.operation === 'rebind') {
      from = command.fromSeq;
      if (
        !Number.isSafeInteger(from) ||
        from < snapshot.boundarySeq ||
        from > sink.progressSeq + 1 ||
        from > snapshot.headSeq + 1 ||
        sink.inflightBody !== null ||
        repr.uncertainOutcome !== undefined ||
        repr.rejectionTail !== undefined
      )
        throw new TypeError('Invalid audit replay range');
      through = Math.max(from, snapshot.headSeq);
      const hash = await hashAt(from - 1);
      next = {
        ...next,
        progressSeq: from - 1,
        progressHash: hash,
        custodySeq: Math.min(sink.custodySeq, from - 1),
        attempt: 0,
        retryCountForSeq: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
        inflightRepr: JSON.stringify({
          ...repr,
          purpose: 'idle',
          custodyFromSeq: from,
          durableCustodySeq: Math.min(auditDurableCoverage(sink).durableCustodySeq, from - 1),
          durableAckRanges: auditDurableCoverage(sink)
            .durableAckRanges.filter((range) => range.from < from)
            .map((range) => ({ from: range.from, to: Math.min(range.to, from - 1) })),
        }),
      };
    } else if (command.operation === 'skip') {
      let batch: AuditBatchV1;
      try {
        batch = JSON.parse(sink.inflightBody ?? 'null') as AuditBatchV1;
      } catch {
        throw new AuditSinkAdminError('skip_unavailable', 'Audit skip unavailable');
      }
      const record = batch?.records?.[0];
      if (
        !Number.isSafeInteger(command.seq) ||
        command.seq < snapshot.boundarySeq ||
        command.seq > snapshot.headSeq ||
        sink.state !== 'blocked' ||
        sink.blockedReason !== 'rejected' ||
        repr.purpose !== 'events' ||
        repr.uncertainOutcome !== undefined ||
        repr.registryMarkerBody !== undefined ||
        batch?.records?.length !== 1 ||
        record?.kind !== 'event' ||
        record.seq !== command.seq ||
        batch.chainId !== snapshot.chainId ||
        batch.epoch !== snapshot.epoch ||
        batch.throughSeq !== record.seq ||
        batch.throughHash !== record.hash
      )
        throw new AuditSinkAdminError('skip_unavailable', 'Audit skip unavailable');
      from = through = command.seq;
      if ((await hashAt(from)) !== record.hash)
        throw new AuditSinkAdminError('position_unavailable', 'Audit position unavailable');
      const marker = await auditWireMarker(snapshot, {
        kind: 'tombstone',
        seq: from,
        prevHash: record.prevHash,
        hash: record.hash,
        reasonCode: 'operator_skip',
      });
      next = {
        ...next,
        state: 'active',
        blockedReason: null,
        attempt: 0,
        retryCountForSeq: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
        custodySeq: auditCustodySeq(sink, { from, to: through, kind: 'disposed' }),
        inflightBody: JSON.stringify({
          ...batch,
          frozenAt: options.now.getTime(),
          records: [marker],
        }),
        inflightRepr: JSON.stringify({
          ...repr,
          purpose: 'disposition',
          ...auditDurableCoverage(sink, undefined, [{ fromSeq: from, toSeq: through }]),
        }),
      };
    } else if (command.operation === 'resolve') {
      const { target, resolved } = await port.resolution(org, command.ledgerId);
      if (
        !target ||
        resolved ||
        !['withheld', 'uncertain'].includes(target.kind) ||
        target.chainId !== snapshot.chainId ||
        target.epoch !== snapshot.epoch ||
        (target.sinkId !== null && target.sinkId !== sink.id) ||
        !sink.durableAck ||
        !auditDurableCoverage(sink).durableAckRanges.some(
          (range) => range.from <= target.fromSeq && range.to >= target.toSeq,
        )
      )
        throw new AuditSinkAdminError(
          'durable_resolution_unavailable',
          'Audit durable resolution unavailable',
        );
      from = target.fromSeq;
      through = target.toSeq;
      resolvesId = target.id;
    }
    sinks[index] = next;
  }
  if ('sinkId' in command && snapshot.policy === 'required' && !hasDurableWitness(sinks))
    throw new AuditSinkAdminError('required_witness', 'Audit durable witness required');
  // A replay request records intent. Only resolution of a durable ACK uses the replay kind.
  if (command.operation === 'replay') kind = 'rebind';
  const event = auditEvent({
    id: ulid(),
    now,
    action: 'audit.sink_admin',
    actor: options.actor,
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    target: { type: 'organization', id: org.orgId },
    changes: {
      operation: { new: command.operation },
      from_seq: { new: from },
      to_seq: { new: through },
      ...('sinkId' in command ? { sink_id: { new: command.sinkId } } : {}),
      ...(command.operation === 'policy_set' ? { policy: { new: command.policy } } : {}),
    },
  });
  if (!event.ok)
    throw new AuditSinkAdminError('control_event_refused', 'Audit control event refused');
  const saved = await port
    .save(
      org,
      snapshot,
      observed,
      {
        epoch: snapshot.epoch,
        restorePending: snapshot.restorePending,
        boundaryReason: snapshot.boundaryReason,
        sinks,
        now,
        event: event.event,
        ...(command.operation === 'policy_set' ? { policy: command.policy } : {}),
        ledger: [
          {
            id: ulid(),
            kind,
            chainId: snapshot.chainId,
            epoch: snapshot.epoch,
            fromSeq: from,
            toSeq: through,
            count: command.operation === 'skip' ? 1 : 0,
            sinkId: 'sinkId' in command ? command.sinkId : null,
            ...(resolvesId === undefined ? {} : { resolvesId }),
            reasonCode:
              command.operation === 'resolve'
                ? 'durable_ack'
                : command.operation === 'replay'
                  ? 'replay'
                  : `operator_${command.operation}`,
            policy: command.operation === 'policy_set' ? command.policy : snapshot.policy,
            modeGeneration:
              snapshot.modeGeneration +
              (command.operation === 'policy_set' && command.policy !== snapshot.policy ? 1 : 0),
            actorType: options.actor.type,
            actorId: options.actor.id,
            createdAt: now,
          },
        ],
      },
      options.generation,
    )
    .catch((error: unknown) => {
      if (error instanceof AuditForkLimitError) options.alert(error.reason);
      throw error;
    });
  return { result: saved ? 'applied' : 'contended' };
}
