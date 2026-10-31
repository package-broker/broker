import type {
  AuditTrail,
  AuditTrailContext,
  AuditJournalItemV1,
  AuditTrailResponse,
} from '@package-broker/core/plugin';

type EventItem = Extract<
  Extract<AuditTrailResponse, { items: unknown }>['items'][number],
  { payload: unknown }
>;
type Payload = EventItem['payload'];

function payloadOf(json: string): Payload {
  if (new TextEncoder().encode(json).length > 4096) return {};
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    if (Object.keys(value).some((key) => !['op_id', 'request_id', 'changes'].includes(key)))
      return {};
    return value as Payload;
  } catch {
    return {};
  }
}

function publicItem(item: AuditJournalItemV1) {
  if (item.kind === 'withheld')
    return {
      kind: 'withheld' as const,
      id: 'id' in item ? item.id : item.markerId,
      seq: item.seq,
      reason: item.reasonCode === 'unreadable' ? ('unreadable' as const) : ('content' as const),
    };
  return {
    id: item.id,
    seq: item.seq,
    action: item.action,
    actor: { type: item.actorType, id: item.actorId },
    targetType: item.targetType,
    targetId: item.targetId,
    projectId: item.projectId,
    createdAt: item.createdAt,
    payload: payloadOf(item.payloadJson),
  };
}

export function createTrail(ctx: AuditTrailContext): AuditTrail {
  return {
    async handle(operation, request) {
      if (!ctx.active) return { error: 'audit_trail_unavailable' };
      if (operation === 'auditHead') {
        const head = await ctx.journal.head();
        return {
          seq: head.headSeq,
          hash: head.headHash,
          pendingCount: head.pendingCount,
          lastVerifiedAt:
            head.verification !== null && head.verification.fromSeq <= head.verification.throughSeq
              ? head.verification.verifiedAt
              : null,
        };
      }
      const { query, projectId } = request;
      const limit = Number(query.limit ?? 50);
      const afterSeq = query.after === undefined ? undefined : Number(query.after);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        return {
          error: 'invalid_request',
          details: [
            {
              path: '/query/limit',
              code: limit > 200 ? 'too_big' : limit < 1 ? 'too_small' : 'invalid_type',
            },
          ],
        };
      }
      if (
        afterSeq !== undefined &&
        (!/^[0-9]+$/.test(query.after!) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)
      ) {
        return { error: 'invalid_request', details: [{ path: '/query/after', code: 'invalid' }] };
      }
      const page = await ctx.journal.list({
        projectId,
        limit,
        ...(query.actor === undefined ? {} : { actor: query.actor }),
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(afterSeq === undefined ? {} : { afterSeq }),
      });
      return {
        items: page.items.map(publicItem),
        next: page.next === null ? null : String(page.next),
      };
    },
  };
}
