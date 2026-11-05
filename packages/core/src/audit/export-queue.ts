import type { AuditBatchV1, AuditMarkerV1 } from './plugin-api.js';

export type QueuedAuditMarker = AuditMarkerV1 & { readonly queueId?: string };

export function auditQueuedMarkerRecords(queued: readonly QueuedAuditMarker[]): AuditMarkerV1[] {
  return queued.map((queuedMarker) => {
    const marker = { ...queuedMarker };
    delete marker.queueId;
    return marker;
  });
}

export function auditQueuedMarkerOccurrences(queued: readonly QueuedAuditMarker[]): string[] {
  return queued.map((marker) => marker.queueId ?? marker.markerId);
}

/** Legacy frozen batches acknowledge one occurrence per record, even for repeated wire IDs. */
export function remainingAuditQueuedMarkers(
  queued: readonly QueuedAuditMarker[],
  batch: AuditBatchV1,
  occurrences: unknown,
): readonly QueuedAuditMarker[] {
  if (
    occurrences !== undefined &&
    (!Array.isArray(occurrences) ||
      occurrences.length !== batch.records.length ||
      !occurrences.every((value) => typeof value === 'string'))
  )
    throw new Error('Audit sink representation malformed');
  const accepted: readonly string[] =
    occurrences ??
    batch.records.flatMap((record) => ('markerId' in record ? [record.markerId] : []));
  const counts = new Map<string, number>();
  for (const key of accepted) counts.set(key, (counts.get(key) ?? 0) + 1);
  return queued.filter((marker) => {
    const key = occurrences === undefined ? marker.markerId : (marker.queueId ?? marker.markerId);
    const count = counts.get(key) ?? 0;
    if (count === 0) return true;
    counts.set(key, count - 1);
    return false;
  });
}
