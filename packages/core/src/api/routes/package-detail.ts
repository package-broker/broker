import { authenticatedActorOf } from '../../authz/access-context.js';
import { mutationFence } from '../../authz/fence.js';
import { auditEvent } from '../../audit/actions.js';
import type { PackageDetailRepository } from '../../db/package-admin.js';
import { envelopeResponse } from '../../kernel/errors.js';
import type { RouteDefinition } from '../../kernel/routes.js';
import {
  buildIdempotencyRecord,
  decideReplay,
  parseIdempotencyKey,
  principalKey,
  requestHash,
  settleIdempotent,
  type IdempotencyRecord,
} from '../idempotency.js';
import { apiRoute } from '../route.js';
import { auditCall, type ApiRouteDeps } from './context.js';
import { PACKAGE_DETAIL_API_SPECS } from './package-detail-schemas.js';

export interface PackageDetailRouteDeps extends ApiRouteDeps {
  readonly repository: PackageDetailRepository;
  readonly idempotency: {
    find(
      ctx: import('../../db/port.js').OrgContext,
      principal: string,
      key: string,
      now: string,
    ): Promise<IdempotencyRecord | null>;
  };
}

export function packageDetailRoutes(deps: PackageDetailRouteDeps): readonly RouteDefinition[] {
  const [readme, access] = PACKAGE_DETAIL_API_SPECS;
  const routes = [
    {
      ...apiRoute(readme, async ({ ctx, params, query }) => {
        if (ctx.org === null || ctx.projectId === null) return { error: 'not_found' };
        const item = await deps.repository.readme(ctx.org, {
          packageId: params.package,
          projectId: ctx.projectId,
          ...(query.version === undefined ? {} : { version: query.version }),
        });
        if (item === null) return { error: 'not_found' };
        const sizeBytes = new TextEncoder().encode(item.body).byteLength;
        if (sizeBytes > 524288) return { error: 'not_found' };
        return {
          status: 200,
          body: {
            ...item,
            contentType: /\.md$/i.test(item.filename) ? 'text/markdown' : 'text/plain',
            sizeBytes,
          },
        };
      }),
      package: {
        ecosystem: 'npm' as const,
        name: (params: Readonly<Record<string, string>>) => params['package']!,
      },
    },
    apiRoute(access, async ({ ctx, params, body }) => {
      if (body.newProjectAccessMode === 'request' && body.visibleToNewProjects)
        return { error: 'invalid_request' };
      const key = parseIdempotencyKey(ctx.request.headers.get('idempotency-key'));
      if (!key.ok) return { error: 'invalid_request' };
      const actor = authenticatedActorOf(ctx);
      if (ctx.org === null || actor === null) return { error: 'not_found' };
      const c = {
        org: ctx.org,
        actor,
        fence: mutationFence(actor, {}),
        call: auditCall(ctx, deps),
      };
      const now = deps.clock.now();
      const response = { ...body, revision: body.revision + 1 };
      const principal = { kind: 'user' as const, id: c.actor.userId };
      const find = () =>
        deps.idempotency.find(c.org, principalKey(principal), key.key!, now.toISOString());
      const hash = await requestHash({
        method: access.method,
        route: access.path,
        params: ctx.params,
        body,
      });
      let record: IdempotencyRecord | undefined;
      if (key.key !== null) {
        const existing = await find();
        const decision = decideReplay(existing, hash, now);
        if (decision === 'mismatch') return { error: 'idempotency_mismatch' };
        if (decision === 'replay' && existing)
          return { status: existing.status, body: JSON.parse(existing.responseJson) as unknown };
        record = buildIdempotencyRecord({
          principal,
          key: key.key,
          route: access.path,
          hash,
          status: 200,
          response,
          now,
        });
      }
      const event = auditEvent({
        id: deps.ids.ulid(),
        now: now.toISOString(),
        action: 'package.access_update',
        actor: { type: 'user', id: c.actor.userId },
        target: { type: 'package', id: params.package },
        context: c.call.audit,
        changes: {
          visible_to_new_projects: { new: body.visibleToNewProjects },
          new_project_access_mode: { new: body.newProjectAccessMode },
        },
      });
      if (!event.ok) throw new TypeError('invalid package access audit');
      const settled = await settleIdempotent({
        record,
        hash,
        now,
        find,
        run: () =>
          deps.repository.setAccess(c.org, c.fence, {
            ...body,
            packageId: params.package,
            audit: event.event,
            ...(record ? { idempotency: record } : {}),
          }),
        failed: (result) => !result.ok,
      });
      if (settled.kind === 'mismatch') return { error: 'idempotency_mismatch' };
      if (settled.kind === 'replay')
        return {
          status: settled.record.status,
          body: JSON.parse(settled.record.responseJson) as unknown,
        };
      if (!settled.result.ok) return { error: settled.result.error };
      return { status: 200, body: response };
    }),
  ];
  return routes.map((route, index) => {
    const wrapped: RouteDefinition = {
      ...route,
      handler: async (ctx) => {
        const response = await route.handler(ctx);
        if (response.status === 404)
          return envelopeResponse(404, 'not_found', 'Route not found', ctx.requestId);
        response.headers.set('cache-control', 'no-store');
        return response;
      },
    };
    return index === 0
      ? {
          ...wrapped,
          corePackageName: (org, params) => deps.repository.packageName(org, params['package']!),
        }
      : wrapped;
  });
}
