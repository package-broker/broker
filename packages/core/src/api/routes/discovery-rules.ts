import type { SessionService } from '../../auth/session.js';
import { auditEvent, type AuditAction } from '../../audit/actions.js';
import type {
  DiscoveryRule,
  DiscoveryRuleOptions,
  DiscoveryRuleRepository,
  DiscoveryRuleWriteResult,
} from '../../db/discovery-rules.js';
import type { OrgContext } from '../../db/port.js';
import type { IdempotencyRecord } from '../idempotency.js';
import type { RequestContext } from '../../plugin.js';
import {
  buildIdempotencyRecord,
  decideReplay,
  parseIdempotencyKey,
  principalKey,
  requestHash,
  settleIdempotent,
} from '../idempotency.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import { callContext, type ApiRouteDeps } from './context.js';
import { DISCOVERY_RULE_API_SPECS } from './source-discovery-schemas.js';

export interface DiscoveryRuleRouteDeps extends ApiRouteDeps {
  readonly rules: DiscoveryRuleRepository;
  readonly sessions: Pick<SessionService, 'authenticate' | 'isReauthFresh'>;
  readonly idempotency: {
    find(
      ctx: OrgContext,
      principal: string,
      key: string,
      now: string,
    ): Promise<IdempotencyRecord | null>;
  };
}
export function discoveryRuleRoutes(deps: DiscoveryRuleRouteDeps) {
  const [create, list, get, update, remove, run, results] = DISCOVERY_RULE_API_SPECS;
  function project(ctx: RequestContext, rule: DiscoveryRule) {
    const c = callContext(ctx, deps);
    if (c.actor.permissions.has('org:sources:write')) return rule;
    return {
      id: rule.id,
      name: rule.name,
      ecosystem: rule.ecosystem,
      pattern: rule.pattern,
      includeForks: rule.includeForks,
      enabled: rule.enabled,
      intervalSeconds: rule.intervalSeconds,
      revision: rule.revision,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
      completed: rule.completed ?? null,
    };
  }
  const replayed = new WeakSet<RequestContext>();
  async function write(
    ctx: RequestContext,
    action: AuditAction,
    id: string,
    status: number,
    params: Readonly<Record<string, string>>,
    body: unknown,
    mutation: (
      c: ReturnType<typeof callContext>,
      audit: ReturnType<typeof validAudit>,
    ) => Promise<DiscoveryRuleWriteResult | 'not_found' | 'reauth_required'>,
    fresh = false,
  ): Promise<ApiOutcome> {
    const c = callContext(ctx, deps);
    const key = parseIdempotencyKey(ctx.request.headers.get('idempotency-key'));
    if (!key.ok) return { error: 'invalid_request' };
    const response = status === 204 ? null : { id };
    const hash = await requestHash({
      method: ctx.request.method,
      route: action,
      params,
      body: body ?? null,
    });
    const principal = ctx.principal;
    if (principal === null) return { error: 'forbidden' };
    const now = deps.clock.now();
    const record =
      key.key === null
        ? undefined
        : buildIdempotencyRecord({
            principal,
            key: key.key,
            route: action,
            hash,
            status,
            response,
            now,
          });
    if (key.key !== null) {
      const existing = await deps.idempotency.find(
        c.org,
        principalKey(principal),
        key.key,
        now.toISOString(),
      );
      const decision = decideReplay(existing, hash, now);
      if (decision === 'mismatch') return { error: 'idempotency_mismatch' };
      if (decision === 'replay' && existing !== null) {
        replayed.add(ctx);
        return {
          status: existing.status,
          ...(existing.status === 204
            ? {}
            : { body: JSON.parse(existing.responseJson) as unknown }),
        };
      }
    }
    if (fresh) {
      const auth = await deps.sessions.authenticate(c.org, ctx.request);
      if (
        auth === null ||
        auth.session.id !== c.fence.sessionId ||
        auth.session.userId !== c.fence.userId ||
        !deps.sessions.isReauthFresh(auth)
      )
        return { error: 'reauth_required' };
    }
    const settled = await settleIdempotent({
      record,
      hash,
      now,
      find: () =>
        deps.idempotency.find(c.org, principalKey(principal), key.key!, now.toISOString()),
      run: () =>
        mutation(
          { ...c, call: { ...c.call, ...(record === undefined ? {} : { idempotency: record }) } },
          validAudit(c, action, id),
        ),
      failed: (r) => r !== 'ok',
    });
    if (settled.kind === 'mismatch') return { error: 'idempotency_mismatch' };
    if (settled.kind === 'replay') {
      replayed.add(ctx);
      return {
        status: settled.record.status,
        ...(settled.record.status === 204
          ? {}
          : { body: JSON.parse(settled.record.responseJson) as unknown }),
      };
    }
    return settled.result === 'ok'
      ? { status, ...(status === 204 ? {} : { body: response }) }
      : {
          error: settled.result === 'indeterminate' ? 'unavailable' : settled.result,
        };
  }
  function validAudit(c: ReturnType<typeof callContext>, action: AuditAction, id: string) {
    const result = auditEvent({
      id: deps.ids.ulid(),
      now: deps.clock.now().toISOString(),
      action,
      actor: { type: 'user', id: c.actor.userId },
      target: { type: 'discovery_rule', id },
      context: c.call.audit,
    });
    if (!result.ok) throw new TypeError('invalid discovery audit');
    return result.event;
  }
  const read = (spec: typeof get | typeof results) =>
    apiRoute(spec, async ({ ctx, params }) => {
      const c = callContext(ctx, deps);
      const found = await deps.rules.get(c.org, params.id);
      return found === null
        ? { error: 'not_found' }
        : {
            status: 200,
            body:
              spec === results
                ? (found.completed ?? {
                    lastRunAt: null,
                    outcome: null,
                    created: 0,
                    existing: 0,
                    skipped: 0,
                    failed: 0,
                    skips: [],
                  })
                : project(ctx, found),
            etag: found.revision,
          };
    });
  return [
    apiRoute(create, async ({ ctx, body }) => {
      const id = deps.ids.ulid();
      return write(
        ctx,
        'discovery_rule.create',
        id,
        201,
        {},
        body,
        (c, audit) =>
          deps.rules.create(c.org, c.fence, {
            id,
            options: body,
            now: deps.clock.now().toISOString(),
            audit,
            call: c.call,
          }),
        true,
      );
    }),
    apiRoute(list, async ({ ctx, query }) => {
      const c = callContext(ctx, deps);
      const limit = Number(query.limit ?? 50);
      const items = await deps.rules.list(c.org, query.after ?? null, limit);
      return {
        status: 200,
        body: {
          items: items.map((item) => project(ctx, item)),
          next: items.length === limit ? items.at(-1)!.id : null,
        },
      };
    }),
    read(get),
    apiRoute(update, async ({ ctx, params, body, expectedRevision }) => {
      if (Object.keys(body).length === 0) return { error: 'invalid_request' };
      return write(
        ctx,
        'discovery_rule.update',
        params.id,
        200,
        params,
        { ...body, expectedRevision },
        async (c, audit) => {
          const prior = await deps.rules.get(c.org, params.id);
          if (prior === null) return 'not_found';
          if (prior.revision !== expectedRevision) return 'conflict';
          const credentialChanged =
            (body.credentialId !== undefined && body.credentialId !== prior.credentialId) ||
            (body.installationId !== undefined && body.installationId !== prior.installationId);
          if (credentialChanged) {
            const auth = await deps.sessions.authenticate(c.org, ctx.request);
            if (
              auth === null ||
              auth.session.id !== c.fence.sessionId ||
              auth.session.userId !== c.fence.userId ||
              !deps.sessions.isReauthFresh(auth)
            )
              return 'reauth_required';
          }
          return deps.rules.update(c.org, c.fence, {
            id: params.id,
            revision: expectedRevision!,
            options: { ...prior, ...body } as DiscoveryRuleOptions,
            credentialChanged,
            now: deps.clock.now().toISOString(),
            audit,
            call: c.call,
          });
        },
      );
    }),
    apiRoute(remove, async ({ ctx, params, expectedRevision }) =>
      write(
        ctx,
        'discovery_rule.delete',
        params.id,
        204,
        params,
        { expectedRevision },
        (c, audit) =>
          deps.rules.delete(c.org, c.fence, {
            id: params.id,
            revision: expectedRevision!,
            audit,
            call: c.call,
          }),
      ),
    ),
    apiRoute(run, async ({ ctx, params, body }) =>
      write(ctx, 'discovery_rule.run_requested', params.id, 202, params, body, (c, audit) =>
        deps.rules.runNow(c.org, c.fence, {
          id: params.id,
          now: deps.clock.now().toISOString(),
          audit,
          call: c.call,
        }),
      ),
    ),
    read(results),
  ].map((route) => ({
    ...route,
    handler: async (ctx: RequestContext) => {
      const response = await route.handler(ctx);
      if (replayed.has(ctx)) response.headers.set('Idempotent-Replayed', 'true');
      return response;
    },
  }));
}
