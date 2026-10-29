import type { OrgContext } from '../../db/port.js';
import { ulid } from '../../ids.js';
import { auditEvent, type AuditEvent } from '../actions.js';
import type { AuditBatchV1, AuditMarkerV1 } from '../plugin-api.js';

export interface AuditSinkRegistration {
  readonly id: string;
  readonly pluginId: string;
  readonly kind: string;
  readonly durableAck: boolean;
  readonly destination: {
    readonly receiverFingerprint: string;
    readonly activationSource: string;
  } | null;
}

export interface AuditSinkState {
  readonly id: string;
  readonly pluginId: string;
  readonly kind: string;
  readonly generation: number;
  readonly receiverFingerprint: string;
  readonly durableAck: boolean;
  readonly activationSource: string;
  readonly state: 'active' | 'inactive' | 'blocked' | 'disabled' | 'retired';
  readonly progressSeq: number;
  readonly progressHash: string;
  readonly custodySeq: number;
  readonly blockedReason: string | null;
  readonly inflightFrom: number | null;
  readonly inflightTo: number | null;
  readonly inflightBody: string | null;
  readonly inflightRepr: string | null;
}

export interface AuditSinkSnapshot {
  readonly chainId: string;
  readonly epoch: number;
  readonly generation: number;
  readonly boundarySeq: number;
  readonly boundaryPrevHash: string;
  readonly boundaryReason: string | null;
  readonly policy: 'availability' | 'required';
  readonly restorePending: boolean;
  readonly sinks: readonly AuditSinkState[];
}

export interface AuditSinkRebind {
  readonly id: string;
  readonly sinkId: string;
  readonly custodySeq: number;
  readonly event: AuditEvent;
}

export interface AuditSinkRegistryPort {
  read(ctx: OrgContext): Promise<AuditSinkSnapshot>;
  save(
    ctx: OrgContext,
    expected: AuditSinkSnapshot,
    change: {
      readonly generation: number;
      readonly sinks: readonly AuditSinkState[];
      readonly rebinds: readonly AuditSinkRebind[];
      readonly now: string;
    },
  ): Promise<boolean>;
}

function validate(generation: number, sinks: readonly AuditSinkRegistration[]): void {
  const ids = new Set<string>();
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new TypeError('Invalid audit generation');
  for (const sink of sinks) {
    if (
      !/^[a-z0-9-]{1,32}(?![\s\S])/.test(sink.id) ||
      !/^[a-z0-9-]{1,32}(?![\s\S])/.test(sink.kind) ||
      !/^[a-z0-9][a-z0-9-]{0,63}(?![\s\S])/.test(sink.pluginId) ||
      ids.has(sink.id) ||
      (sink.destination !== null &&
        (!/^[a-f0-9]{64}(?![\s\S])/.test(sink.destination.receiverFingerprint) ||
          !/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/.test(sink.destination.activationSource)))
    ) {
      throw new TypeError('Invalid audit sink registration');
    }
    ids.add(sink.id);
  }
}

function representationOf(raw: string | null): { registryMarkers?: readonly AuditMarkerV1[] } {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('Audit sink representation malformed');
  }
}

/** An unregistered configured sink is a zero watermark, including before boot reconciliation. */
export function auditSinkPruneProgress(
  configuredIds: readonly string[],
  sinks: readonly AuditSinkState[],
): number {
  if (configuredIds.some((id) => !sinks.some((sink) => sink.id === id))) return 0;
  const holding = sinks.filter((sink) => sink.state !== 'inactive' && sink.state !== 'retired');
  return holding.length === 0 ? 0 : Math.min(...holding.map((sink) => sink.progressSeq));
}

/** Callers must finish reconciliation before starting delivery; contended boots retry. */
export async function reconcileAuditSinks(
  port: AuditSinkRegistryPort,
  ctx: OrgContext,
  generation: number,
  configured: readonly AuditSinkRegistration[],
  now: Date,
): Promise<'applied' | 'stale' | 'contended'> {
  validate(generation, configured);
  const timestamp = now.toISOString();
  const snapshot = await port.read(ctx);
  if (
    generation < snapshot.generation ||
    snapshot.sinks.some((sink) => sink.generation > generation)
  )
    return 'stale';
  const next: AuditSinkState[] = [];
  const rebinds: AuditSinkRebind[] = [];
  for (const registration of configured) {
    const old = snapshot.sinks.find((sink) => sink.id === registration.id);
    // A retired id is reused only by a newer build, never by a still-running old build.
    if (old?.state === 'retired' && old.generation >= generation) {
      next.push(old);
      continue;
    }
    const destination = registration.destination;
    const changed =
      destination !== null &&
      old !== undefined &&
      old.receiverFingerprint !== '' &&
      destination.receiverFingerprint !== old.receiverFingerprint;
    const start = snapshot.boundarySeq - 1;
    const fresh = old === undefined || old.state === 'retired';
    let sink: AuditSinkState = {
      id: registration.id,
      pluginId: registration.pluginId,
      kind: registration.kind,
      generation,
      receiverFingerprint: destination?.receiverFingerprint ?? old?.receiverFingerprint ?? '',
      durableAck: registration.durableAck,
      activationSource: destination?.activationSource ?? old?.activationSource ?? 'none',
      state:
        snapshot.restorePending || (!fresh && old?.blockedReason != null)
          ? 'blocked'
          : destination === null
            ? 'inactive'
            : 'active',
      progressSeq: fresh ? start : old.progressSeq,
      progressHash: fresh ? snapshot.boundaryPrevHash : old.progressHash,
      custodySeq: fresh ? start : old.custodySeq,
      blockedReason: snapshot.restorePending ? 'fork' : fresh ? null : old.blockedReason,
      inflightFrom: fresh ? null : old.inflightFrom,
      inflightTo: fresh ? null : old.inflightTo,
      inflightBody: fresh ? null : old.inflightBody,
      inflightRepr: fresh ? null : old.inflightRepr,
    };
    const markers: AuditMarkerV1[] = [];
    const identity = () => ({
      chainId: snapshot.chainId,
      epoch: snapshot.epoch,
      markerId: ulid(now.getTime()),
    });
    if (fresh && snapshot.boundarySeq > 1)
      markers.push({
        ...identity(),
        kind: 'boundary',
        boundarySeq: snapshot.boundarySeq,
        boundaryPrevHash: snapshot.boundaryPrevHash,
        provenance: snapshot.boundaryReason ?? 'retained_suffix',
      });
    if (changed) {
      markers.push({
        ...identity(),
        kind: 'receiver_changed',
        oldFingerprint: old.receiverFingerprint,
        newFingerprint: sink.receiverFingerprint,
      });
      const event = auditEvent({
        id: ulid(now.getTime()),
        now: timestamp,
        context: {
          opId: ulid(now.getTime()),
          requestId: ulid(now.getTime()),
          sourceIp: null,
          tokenSelector: null,
        },
        actor: { type: 'system', id: null },
        action: 'audit.sink_admin',
        target: { type: 'audit_sink', id: null },
        changes: {
          operation: { new: 'rebind' },
          sink_id: { new: sink.id },
          from_seq: { new: 0 },
          to_seq: { new: old.custodySeq },
          generation: { new: generation },
          reason_code: { new: 'receiver_changed' },
        },
      });
      if (!event.ok) throw new Error('Audit sink control event refused');
      rebinds.push({
        id: ulid(now.getTime()),
        sinkId: sink.id,
        custodySeq: old.custodySeq,
        event: event.event,
      });
    }
    if (markers.length > 0) {
      const batch: AuditBatchV1 = {
        v: 1,
        chainId: snapshot.chainId,
        epoch: snapshot.epoch,
        orgId: ctx.orgId,
        records: markers,
        throughSeq: sink.progressSeq,
        throughHash: sink.progressHash,
      };
      if (sink.inflightBody === null) {
        sink = {
          ...sink,
          inflightFrom: sink.progressSeq + 1,
          inflightTo: sink.progressSeq + 1,
          inflightBody: JSON.stringify(batch),
          inflightRepr: JSON.stringify({ v: 1, purpose: 'registry_markers' }),
        };
      } else {
        // Delivery drains registryMarkers before retrying the frozen body; representation fields stay intact.
        const representation = representationOf(sink.inflightRepr);
        sink = {
          ...sink,
          inflightRepr: JSON.stringify({
            ...representation,
            registryMarkers: [...(representation.registryMarkers ?? []), ...markers],
          }),
        };
      }
    }
    next.push(sink);
  }
  for (const old of snapshot.sinks) {
    if (!configured.some((sink) => sink.id === old.id))
      next.push({ ...old, generation, state: old.state === 'retired' ? 'retired' : 'disabled' });
  }
  return (await port.save(ctx, snapshot, { generation, sinks: next, rebinds, now: timestamp }))
    ? 'applied'
    : 'contended';
}
