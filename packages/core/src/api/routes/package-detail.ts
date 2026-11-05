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
import {
  createOrganizationPolicyViews,
  createPolicyViews,
  type PackageViewPolicy,
} from '../../catalogue/policy-views.js';
import { policyBoundReadme } from '../../catalogue/readme.js';
import { contextPackageActorOf } from '../../internal/package-actor.js';
import { policyErrorResponse } from '../../registry/policy/http.js';
import { withPolicyRetry } from '../../registry/policy/session.js';
import { auditCall, type ApiRouteDeps } from './context.js';
import { PACKAGE_DETAIL_API_SPECS } from './package-detail-schemas.js';
import { inspects } from './packages.js';

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
  /**
   * Present only when `registry.policy.enabled`; the readme then follows its version's decision and
   * the package detail counts permitted versions as the package list does.
   */
  readonly policy?: PackageViewPolicy;
}

export function packageDetailRoutes(deps: PackageDetailRouteDeps): readonly RouteDefinition[] {
  const [readme, access] = PACKAGE_DETAIL_API_SPECS;
  const details = PACKAGE_DETAIL_API_SPECS.slice(2).map((spec) =>
    apiRoute(spec, async ({ ctx, params }) => {
      if (ctx.org === null || (spec.boundary === 'project' && ctx.projectId === null))
        return { error: 'not_found' };
      const org = ctx.org;
      const read = () =>
        deps.repository.detail(org, {
          packageId: params.package,
          projectId: spec.boundary === 'project' ? ctx.projectId : null,
        });
      const policy = deps.policy;
      let item: Awaited<ReturnType<typeof read>>;
      if (policy === undefined || (spec.boundary === 'organization' && inspects(ctx))) {
        item = await read();
      } else if (spec.boundary === 'project') {
        const actor = contextPackageActorOf(ctx);
        if (actor === null) return { error: 'not_found' };
        item = await withPolicyRetry(async () => {
          const views = createPolicyViews(policy, ctx, actor, 'listing');
          const raw = await read();
          const summary = raw === null ? null : await views.summarize(raw);
          await views.seal();
          return summary;
        });
      } else {
        item = await withPolicyRetry(async () => {
          const views = createOrganizationPolicyViews(policy, ctx);
          const raw = await read();
          const summary = raw === null ? null : await views.summarize(raw);
          await views.seal();
          return summary;
        });
      }
      if (item === null) return { error: 'not_found' };
      return { status: 200, body: item };
    }),
  );
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
        let readme: { filename: string; body: string } | null = item;
        if (deps.policy !== undefined) {
          const actor = contextPackageActorOf(ctx);
          readme =
            actor === null
              ? null
              : await policyBoundReadme(deps.policy, ctx, actor, params.package, item);
          if (readme === null) return { error: 'not_found' };
        }
        const sizeBytes = new TextEncoder().encode(readme.body).byteLength;
        if (sizeBytes > 524288) return { error: 'not_found' };
        return {
          status: 200,
          body: {
            filename: readme.filename,
            body: readme.body,
            contentType: /\.md$/i.test(readme.filename) ? 'text/markdown' : 'text/plain',
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
  return [...routes, ...details].map((route, index) => {
    const wrapped: RouteDefinition = {
      ...route,
      handler: async (ctx) => {
        let response: Response;
        try {
          response = await route.handler(ctx);
        } catch (error) {
          const refused = policyErrorResponse(error, ctx.requestId);
          if (refused !== null) return refused;
          throw error;
        }
        const result =
          response.status === 404
            ? envelopeResponse(404, 'not_found', 'Route not found', ctx.requestId)
            : response;
        result.headers.set('cache-control', 'no-store');
        return result;
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
