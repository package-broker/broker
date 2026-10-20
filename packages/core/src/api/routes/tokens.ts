import type { SessionService } from '../../auth/session.js';
import { authenticatedActorOf } from '../../authz/access-context.js';
import { mutationFence, type MutationFence } from '../../authz/fence.js';
import type { PersonalTokenService } from '../../authz/pat-service.js';
import type { ServiceTokenService } from '../../authz/service-token-service.js';
import type { TokenLifetimePolicy } from '../../authz/token-lifetime.js';
import type { TokenListItem, TokenPage, TokenReader } from '../../authz/token-read.js';
import type { TokenRevokeInput, TokenRevokeService } from '../../authz/token-revoke.js';
import type * as z from 'zod';
import type { OrganizationActor } from '../../authz/actor.js';
import type { OrgContext } from '../../db/port.js';
import type { OrganizationRepository } from '../../db/organization.js';
import { isoTimestamp } from '../../ids.js';
import { errorEnvelope, type ErrorEnvelope } from '../../envelope.js';
import { jsonResponse } from '../response.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import {
  buildIdempotencyRecord,
  decideReplay,
  parseIdempotencyKey,
  principalKey,
  replayResponse,
  requestHash,
  settleIdempotent,
  type ApiCall as IdempotentCall,
  type IdempotencyRecord,
} from '../idempotency.js';
import { apiRoute, type ApiOutcome } from '../route.js';
import { auditCall, callContext, projectSessionCallContext, type ApiRouteDeps } from './context.js';
import {
  createOrganizationTokenSpec,
  createPersonalTokenSpec,
  createProjectTokenSpec,
  getMyTokenSpec,
  getProjectTokenSpec,
  getTokenSpec,
  rotateProjectTokenSpec,
  rotateTokenSpec,
  listMyTokensSpec,
  listProjectTokensSpec,
  listTokensSpec,
  revokeMyTokenSpec,
  revokeProjectTokenSpec,
  revokeTokenSpec,
} from './tokens-schemas.js';

const DEFAULT_LIMIT = 50;

export interface TokenRouteDeps extends ApiRouteDeps {
  readonly tokens: {
    readonly personal: PersonalTokenService;
    readonly service: ServiceTokenService;
    readonly revoke: TokenRevokeService;
  };
  readonly reader: TokenReader;
  readonly idempotency: {
    find(
      ctx: OrgContext,
      principalKey: string,
      key: string,
      now: string,
    ): Promise<IdempotencyRecord | null>;
  };
  readonly sessions: Pick<SessionService, 'authenticate'>;
  readonly organizations: Pick<OrganizationRepository, 'get'>;
  readonly lifetime: TokenLifetimePolicy;
}

type IssueSpec =
  | typeof createPersonalTokenSpec
  | typeof createProjectTokenSpec
  | typeof createOrganizationTokenSpec
  | typeof rotateProjectTokenSpec
  | typeof rotateTokenSpec;

type ListQuery = {
  readonly limit?: string | undefined;
  readonly after?: string | undefined;
  readonly status?: 'active' | 'expired' | 'revoked' | undefined;
};

type Present<T> = { [K in keyof T]: Exclude<T[K], undefined> };

function present<T extends object>(value: T): Present<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Present<T>;
}

function listItem(item: TokenListItem) {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    scope: item.scope,
    readOnly: item.readOnly,
    status: item.status,
    projectMode: item.projectMode,
    projectCount: item.projectCount,
    projectId: item.projectId,
    userId: item.userId,
    createdByUserId: item.createdByUserId,
    servicePrincipalId: item.servicePrincipalId,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    lastUsedAt: item.lastUsedAt,
    revokedAt: item.revokedAt,
  };
}

export function tokenRoutes(deps: TokenRouteDeps): readonly RouteDefinition[] {
  const responses = new WeakMap<RequestContext, Response>();

  function selfContext(ctx: RequestContext): {
    readonly org: OrgContext;
    readonly userId: string;
    readonly fence: MutationFence;
  } | null {
    const authenticated = authenticatedActorOf(ctx);
    if (ctx.org === null || authenticated === null) return null;
    return {
      org: ctx.org,
      userId: authenticated.userId,
      fence: mutationFence(authenticated, {}),
    };
  }

  async function sessionOf(org: OrgContext, ctx: RequestContext, fence: MutationFence) {
    const authenticated = await deps.sessions.authenticate(org, ctx.request);
    return authenticated !== null &&
      authenticated.session.id === fence.sessionId &&
      authenticated.session.userId === fence.userId
      ? authenticated
      : null;
  }

  async function settledIssue<R extends { readonly ok: boolean }>(
    spec: IssueSpec,
    ctx: RequestContext,
    org: OrgContext,
    body: unknown,
    base: IdempotentCall,
    run: (call: IdempotentCall) => Promise<R>,
  ): Promise<{ readonly result: R } | { readonly outcome: ApiOutcome }> {
    const parsed = parseIdempotencyKey(ctx.request.headers.get('idempotency-key'));
    if (!parsed.ok) return { outcome: { error: 'invalid_request' } };
    if (parsed.key === null || ctx.principal === null) return { result: await run(base) };
    const { key } = parsed;
    const { principal } = ctx;
    const route = `${spec.method} ${spec.path}`;
    const hash = await requestHash({ method: spec.method, route, params: ctx.params, body });
    const now = deps.clock.now();
    const find = () => deps.idempotency.find(org, principalKey(principal), key, isoTimestamp(now));
    const existing = await find();
    const decision = decideReplay(existing, hash, now);
    const replay = (record: IdempotencyRecord): { readonly outcome: ApiOutcome } => {
      responses.set(ctx, replayResponse(record, ctx.requestId));
      return { outcome: { error: 'already_issued' } };
    };
    if (decision === 'replay' && existing !== null) return replay(existing);
    if (decision === 'mismatch') return { outcome: { error: 'idempotency_mismatch' } };
    const record = buildIdempotencyRecord({
      principal,
      key,
      route,
      hash,
      status: 201,
      response: { code: 'already_issued' },
      now,
    });
    const settlement = await settleIdempotent({
      record,
      hash,
      now,
      find,
      run: () => run({ ...base, idempotency: record }),
      failed: (result) => !result.ok,
    });
    if (settlement.kind === 'result') return { result: settlement.result };
    return settlement.kind === 'replay'
      ? replay(settlement.record)
      : { outcome: { error: 'idempotency_mismatch' } };
  }

  async function lifetimeOf(org: OrgContext) {
    const organization = await deps.organizations.get(org);
    if (organization === null) return null;
    const configured = organization.settings.tokenDefaultExpiryDays;
    if (!Number.isSafeInteger(configured) || configured <= 0) return 'unavailable' as const;
    return {
      personal: {
        maxDays: deps.lifetime.personal.maxDays,
        defaultDays: Math.min(configured, deps.lifetime.personal.maxDays),
      },
      service: {
        maxDays: deps.lifetime.service.maxDays,
        defaultDays: Math.min(configured, deps.lifetime.service.maxDays),
      },
    };
  }

  async function listing(
    org: OrgContext,
    query: ListQuery,
    read: (page: {
      readonly after: string | null;
      readonly limit: number;
      readonly status?: 'active' | 'expired' | 'revoked';
      readonly now: string;
    }) => Promise<TokenPage>,
  ): Promise<ApiOutcome> {
    const lifetime = await lifetimeOf(org);
    if (lifetime === null) return { error: 'not_found' };
    if (lifetime === 'unavailable') return { error: 'unavailable' };
    const page = await read({
      after: query.after ?? null,
      limit: query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit),
      ...(query.status === undefined ? {} : { status: query.status }),
      now: isoTimestamp(deps.clock.now()),
    });
    return {
      status: 200,
      body: { items: page.items.map(listItem), next: page.next, lifetime },
    };
  }

  const created = (value: { readonly id: string; readonly plaintext: string }): ApiOutcome => ({
    status: 201,
    body: { id: value.id, token: value.plaintext },
  });

  async function issueService(
    spec: typeof createProjectTokenSpec | typeof createOrganizationTokenSpec,
    ctx: RequestContext,
    routeProjectId: string | null,
    context: {
      readonly org: OrgContext;
      readonly actor: OrganizationActor;
      readonly fence: MutationFence;
      readonly call: IdempotentCall;
    },
    body: z.output<typeof createOrganizationTokenSpec.api.body>,
  ) {
    const authenticated = await sessionOf(context.org, ctx, context.fence);
    if (authenticated === null) return { error: 'unauthorized' } as const;
    const settled = await settledIssue(spec, ctx, context.org, body, context.call, (call) =>
      deps.tokens.service.issue(
        context.org,
        authenticated,
        context.actor,
        context.fence,
        { ...present(body), routeProjectId },
        call,
      ),
    );
    if ('outcome' in settled) return settled.outcome;
    const { result } = settled;
    return result.ok ? created(result.value) : { serviceError: result.error };
  }

  function invalidRotation(
    ctx: RequestContext,
    code: 'invalid_overlap' | 'invalid_expiry' | 'invalid_name',
  ): ApiOutcome {
    const messages = {
      invalid_overlap: 'Invalid overlap',
      invalid_expiry: 'Invalid expiry',
      invalid_name: 'Invalid name',
    };
    responses.set(ctx, jsonResponse(422, errorEnvelope(code, messages[code], ctx.requestId)));
    return { error: 'invalid_request' };
  }

  async function rotateService(
    spec: typeof rotateProjectTokenSpec | typeof rotateTokenSpec,
    ctx: RequestContext,
    tokenId: string,
    routeProjectId: string | null,
    context: ReturnType<typeof callContext>,
    body: z.output<typeof rotateTokenSpec.api.body>,
  ) {
    const authenticated = await sessionOf(context.org, ctx, context.fence);
    if (authenticated === null) return { error: 'unauthorized' } as const;
    const settled = await settledIssue(spec, ctx, context.org, body, context.call, (call) =>
      deps.tokens.service.rotate(
        context.org,
        authenticated,
        context.actor,
        context.fence,
        { ...present(body), tokenId, routeProjectId },
        call,
      ),
    );
    if ('outcome' in settled) return settled.outcome;
    const { result } = settled;
    if (!result.ok) {
      if (
        result.error === 'invalid_overlap' ||
        result.error === 'invalid_expiry' ||
        result.error === 'invalid_name'
      ) {
        return invalidRotation(ctx, result.error);
      }
      return { serviceError: result.error };
    }
    return {
      status: 201,
      body: {
        id: result.value.id,
        token: result.value.plaintext,
        replacedTokenId: result.value.replacedTokenId,
        replacedExpiresAt: result.value.replacedExpiresAt,
      },
    };
  }

  function metadata(item: TokenListItem | null): ApiOutcome {
    return item === null ? { error: 'not_found' } : { status: 200, body: listItem(item) };
  }

  async function revoke(
    ctx: RequestContext,
    context: {
      readonly org: OrgContext;
      readonly fence: MutationFence;
      readonly call: IdempotentCall;
    },
    input: TokenRevokeInput,
  ) {
    const authenticated = await sessionOf(context.org, ctx, context.fence);
    if (authenticated === null) return { error: 'unauthorized' } as const;
    const result = await deps.tokens.revoke.revoke(
      context.org,
      authenticated,
      context.fence,
      input,
      context.call,
    );
    return result.ok ? ({ status: 204 } as const) : { serviceError: result.error };
  }

  const routes: RouteDefinition[] = [
    apiRoute(createPersonalTokenSpec, async ({ ctx, body }) => {
      const context = selfContext(ctx);
      if (context === null) return { error: 'unauthorized' };
      const authenticated = await sessionOf(context.org, ctx, context.fence);
      if (authenticated === null) return { error: 'unauthorized' };
      const settled = await settledIssue(
        createPersonalTokenSpec,
        ctx,
        context.org,
        body,
        auditCall(ctx, deps),
        (call) =>
          deps.tokens.personal.issue(
            context.org,
            authenticated,
            context.fence,
            present(body),
            call,
          ),
      );
      if ('outcome' in settled) return settled.outcome;
      const { result } = settled;
      return result.ok ? created(result.value) : { serviceError: result.error };
    }),
    apiRoute(createProjectTokenSpec, ({ ctx, body }) => {
      const context = projectSessionCallContext(ctx, deps);
      return issueService(createProjectTokenSpec, ctx, context.projectId, context, body);
    }),
    apiRoute(createOrganizationTokenSpec, ({ ctx, body }) =>
      issueService(createOrganizationTokenSpec, ctx, null, callContext(ctx, deps), body),
    ),
    apiRoute(listMyTokensSpec, async ({ ctx, query }): Promise<ApiOutcome> => {
      const context = selfContext(ctx);
      if (context === null) return { error: 'unauthorized' };
      return listing(context.org, query, (page) =>
        deps.reader.listOwn(context.org, context.userId, page),
      );
    }),
    apiRoute(listProjectTokensSpec, async ({ ctx, query }): Promise<ApiOutcome> => {
      if (ctx.org === null || ctx.projectId === null) {
        throw new TypeError('route requires a project context');
      }
      const { org, projectId } = { org: ctx.org, projectId: ctx.projectId };
      return listing(org, query, (page) => deps.reader.listProject(org, projectId, page));
    }),
    apiRoute(listTokensSpec, async ({ ctx, query }): Promise<ApiOutcome> => {
      if (ctx.org === null) throw new TypeError('route requires an organization context');
      const org = ctx.org;
      return listing(org, query, (page) =>
        deps.reader.listOrganization(org, {
          ...page,
          ...(query.kind === undefined ? {} : { kind: query.kind }),
        }),
      );
    }),
    apiRoute(getMyTokenSpec, async ({ ctx, params }) => {
      const context = selfContext(ctx);
      if (context === null) return { error: 'unauthorized' };
      return metadata(
        await deps.reader.getOwn(
          context.org,
          context.userId,
          params.token,
          isoTimestamp(deps.clock.now()),
        ),
      );
    }),
    apiRoute(getProjectTokenSpec, async ({ ctx, params }) => {
      if (ctx.org === null || ctx.projectId === null)
        throw new TypeError('route requires a project context');
      return metadata(
        await deps.reader.getProject(
          ctx.org,
          ctx.projectId,
          params.token,
          isoTimestamp(deps.clock.now()),
        ),
      );
    }),
    apiRoute(getTokenSpec, async ({ ctx, params }) => {
      if (ctx.org === null) throw new TypeError('route requires an organization context');
      return metadata(
        await deps.reader.getOrganization(ctx.org, params.token, isoTimestamp(deps.clock.now())),
      );
    }),
    apiRoute(rotateProjectTokenSpec, ({ ctx, params, body }) => {
      const context = projectSessionCallContext(ctx, deps);
      return rotateService(
        rotateProjectTokenSpec,
        ctx,
        params.token,
        context.projectId,
        context,
        body,
      );
    }),
    apiRoute(rotateTokenSpec, ({ ctx, params, body }) =>
      rotateService(rotateTokenSpec, ctx, params.token, null, callContext(ctx, deps), body),
    ),
    apiRoute(revokeMyTokenSpec, async ({ ctx, params }) => {
      const context = selfContext(ctx);
      if (context === null) return { error: 'unauthorized' };
      return revoke(
        ctx,
        { ...context, call: auditCall(ctx, deps) },
        { via: 'own', tokenId: params.token, routeProjectId: null },
      );
    }),
    apiRoute(revokeProjectTokenSpec, ({ ctx, params }) => {
      const context = projectSessionCallContext(ctx, deps);
      return revoke(ctx, context, {
        via: 'project',
        tokenId: params.token,
        routeProjectId: context.projectId,
      });
    }),
    apiRoute(revokeTokenSpec, ({ ctx, params }) =>
      revoke(ctx, callContext(ctx, deps), {
        via: 'organization',
        tokenId: params.token,
        routeProjectId: null,
      }),
    ),
  ];

  return routes.map((route) => ({
    ...route,
    handler: async (ctx) => {
      const response = await route.handler(ctx);
      if (
        response.status === 400 &&
        route.method === 'POST' &&
        (route.path === rotateProjectTokenSpec.path || route.path === rotateTokenSpec.path)
      ) {
        const body = (await response.clone().json()) as ErrorEnvelope;
        if (body.error.details?.some((detail) => detail.path === '/body/overlapDays')) {
          invalidRotation(ctx, 'invalid_overlap');
        } else if (
          body.error.details?.some(
            (detail) => detail.path === '/body/expiresAt' || detail.path === '/body/lifetimeDays',
          )
        ) {
          invalidRotation(ctx, 'invalid_expiry');
        }
      }
      const custom = responses.get(ctx);
      if (custom === undefined) return response;
      responses.delete(ctx);
      custom.headers.set('x-request-id', ctx.requestId);
      return custom;
    },
  }));
}
