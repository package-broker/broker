import { redactValue } from '../../audit/redact.js';
import { auditEvent } from '../../audit/actions.js';
import { authenticatedActorOf } from '../../authz/access-context.js';
import { mutationFence } from '../../authz/fence.js';
import type { PublishesRepository } from '../../db/publishes.js';
import type { RouteDefinition } from '../../plugin.js';
import { apiRoute } from '../route.js';
import { auditCall, type ApiRouteDeps } from './context.js';
import {
  publishRescanSpec,
  publishApproveBody,
  publishRejectBody,
  publishListSpec,
  publishGetSpec,
  publishApproveSpec,
  publishRejectSpec,
} from './publishes-schemas.js';

export interface PublishRouteDeps extends ApiRouteDeps {
  readonly publishes: Pick<PublishesRepository, 'get' | 'list' | 'decide' | 'rescan'>;
}

export function publishRoutes(deps: PublishRouteDeps): readonly RouteDefinition[] {
  return [
    apiRoute(publishListSpec, async ({ ctx, query }) => {
      if (!ctx.org) return { error: 'unauthorized' };
      return {
        status: 200,
        body: await deps.publishes.list(ctx.org, {
          ...(query.actionable === undefined ? {} : { actionable: true }),
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          limit: Number(query.limit ?? 50),
        }),
      };
    }),
    apiRoute(publishGetSpec, async ({ ctx, params }) => {
      if (!ctx.org) return { error: 'unauthorized' };
      const item = await deps.publishes.get(ctx.org, params.id);
      return item ? { status: 200, body: item, etag: item.revision } : { error: 'not_found' };
    }),
    ...([publishApproveSpec, publishRejectSpec] as const).map((spec) =>
      apiRoute(spec, async ({ ctx, params, body, expectedRevision }) => {
        const schema = spec === publishRejectSpec ? publishRejectBody : publishApproveBody;
        if (!schema.safeParse(body).success || (spec === publishRejectSpec && !body.reason?.trim()))
          return { error: 'invalid_request' };
        if (body.reason !== undefined) {
          const safe = redactValue(body.reason, 1000, 'reason');
          if (!safe.ok || safe.value !== body.reason) return { error: 'invalid_request' };
        }
        const actor = authenticatedActorOf(ctx);
        if (!ctx.org || !actor) return { error: 'unauthorized' };
        const item = await deps.publishes.get(ctx.org, params.id);
        if (!item) return { error: 'not_found' };
        if (
          item.scanState === 'denied' ||
          (item.approvalState !== 'pending' &&
            !(
              spec === publishRejectSpec &&
              item.holdScan &&
              (item.approvalState === 'not_required' ||
                (item.approvalState === 'approved' && item.scanState === 'failed'))
            ))
        )
          return { error: 'already_decided' };
        if (
          spec === publishApproveSpec &&
          item.requestedByType === 'user' &&
          item.requestedById === actor.userId
        )
          return { error: 'self_approval' };
        const reject = spec === publishRejectSpec;
        const call = auditCall(ctx, deps);
        const now = deps.clock.now().toISOString();
        const prepared = auditEvent({
          id: deps.ids.ulid(),
          now,
          action: reject ? 'publish.reject' : 'publish.approve',
          actor: { type: 'user', id: actor.userId },
          target: { type: 'publish', id: item.id },
          context: call.audit,
          changes: {
            package: { new: item.packageName },
            version: { new: item.version },
            token_id: { new: item.tokenId },
            ...(reject ? { reason: { new: body.reason! } } : {}),
          },
        });
        if (!prepared.ok) return { error: 'invalid_request' };
        const result = await deps.publishes.decide(ctx.org, mutationFence(actor, {}), {
          id: item.id,
          expectedRevision: expectedRevision!,
          expectedApprovalState: item.approvalState,
          expectedScanState: item.scanState,
          now,
          event: prepared.event,
          decision: reject ? 'rejected' : 'approved',
          decidedByUserId: actor.userId,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        });
        if (!result.changed) {
          const current = await deps.publishes.get(ctx.org, item.id);
          return {
            error:
              current && (current.approvalState !== 'pending' || current.scanState === 'denied')
                ? 'already_decided'
                : 'conflict',
          };
        }
        const updated = await deps.publishes.get(ctx.org, item.id);
        return updated
          ? { status: 200, body: updated, etag: updated.revision }
          : { error: 'not_found' };
      }),
    ),
    apiRoute(publishRescanSpec, async ({ ctx, params, expectedRevision }) => {
      const actor = authenticatedActorOf(ctx);
      if (!ctx.org || !actor) return { error: 'unauthorized' };
      const item = await deps.publishes.get(ctx.org, params.id);
      if (!item) return { error: 'not_found' };
      if (item.scanState !== 'failed') return { error: 'conflict' };
      const now = deps.clock.now().toISOString();
      const prepared = auditEvent({
        id: deps.ids.ulid(),
        now,
        action: 'publish.scan',
        actor: { type: 'user', id: actor.userId },
        target: { type: 'publish', id: item.id },
        context: auditCall(ctx, deps).audit,
        changes: { verdict: { new: 'queued' } },
      });
      if (!prepared.ok) return { error: 'invalid_request' };
      const result = await deps.publishes.rescan(ctx.org, mutationFence(actor, {}), {
        id: item.id,
        expectedRevision: expectedRevision!,
        expectedApprovalState: item.approvalState,
        expectedScanState: item.scanState,
        now,
        event: prepared.event,
      });
      if (!result.changed) return { error: 'conflict' };
      const updated = await deps.publishes.get(ctx.org, item.id);
      return updated
        ? { status: 200, body: updated, etag: updated.revision }
        : { error: 'not_found' };
    }),
  ];
}
