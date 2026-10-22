import type { AuthenticatedSession, SessionService } from '../../auth/session.js';
import { authenticatedActorOf } from '../../authz/access-context.js';
import { mutationFence, type MutationFence } from '../../authz/fence.js';
import type {
  PackageManageService,
  PackageManageError,
  PackageManageResult,
  PackageVersionAction,
} from '../../catalogue/package-manage-service.js';
import type { OrgContext } from '../../db/port.js';
import { denialResponse } from '../../kernel/denial-page.js';
import { envelopeResponse } from '../../kernel/errors.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import {
  buildIdempotencyRecord,
  decideReplay,
  parseIdempotencyKey,
  principalKey,
  replayResponse,
  requestHash,
  settleIdempotent,
  type ApiCall,
  type IdempotencyRecord,
} from '../idempotency.js';
import { apiError, jsonResponse, type ApiErrorCode } from '../response.js';
import { defineApi } from '../route.js';
import {
  readJsonBody,
  validateInput,
  type BodyResult,
  type ValidationDetail,
} from '../validate.js';
import { auditCall, type ApiRouteDeps } from './context.js';
import { packageManageSpec } from './package-manage.schemas.js';

export interface TagRebuildPort {
  requestTagRebuild(
    ctx: OrgContext,
    authenticated: AuthenticatedSession,
    fence: MutationFence,
    input: { packageId: string; versionId: string },
    call: ApiCall,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        error: 'reauth_required' | 'forbidden' | 'not_found' | 'conflict' | 'indeterminate';
      }
  >;
}

export interface PackageManageRouteDeps extends ApiRouteDeps {
  readonly service: PackageManageService;
  readonly rebuild: TagRebuildPort;
  readonly sessions: Pick<SessionService, 'authenticate' | 'isReauthFresh'>;
  readonly idempotency: {
    find(
      ctx: OrgContext,
      principalKey: string,
      key: string,
      now: string,
    ): Promise<IdempotencyRecord | null>;
  };
}

const ERRORS = {
  invalid_input: 'invalid_request',
  reauth_required: 'reauth_required',
  forbidden: 'forbidden',
  not_found: 'not_found',
  conflict: 'conflict',
  indeterminate: 'unavailable',
} as const satisfies Record<PackageManageError, ApiErrorCode>;
const STATUSES = { quarantine: 'quarantined', tombstone: 'tombstoned', release: 'active' } as const;

function failure(ctx: RequestContext, code: ApiErrorCode, details?: readonly ValidationDetail[]) {
  if (code === 'not_found') return envelopeResponse(404, code, 'Route not found', ctx.requestId);
  if (code === 'forbidden') return denialResponse(ctx.request, ctx.requestId);
  if (code === 'unauthorized') return envelopeResponse(401, code, 'Unauthorized', ctx.requestId);
  return apiError(code, ctx.requestId, details);
}

async function readOptionalJsonBody(request: Request): Promise<BodyResult> {
  if (request.body === null) return { ok: true, value: undefined };
  const reader = request.body.getReader();
  try {
    let first = await reader.read();
    while (!first.done && first.value.byteLength === 0) first = await reader.read();
    if (first.done) return { ok: true, value: undefined };
    // Node supplies an empty stream for bodyless POSTs; only non-empty bodies require JSON.
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(first.value),
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return await readJsonBody(new Request(request, { body, duplex: 'half' } as RequestInit));
  } catch {
    return { ok: false, status: 400, code: 'invalid_request', detail: 'invalid_request' };
  } finally {
    reader
      .cancel()
      .finally(() => reader.releaseLock())
      .catch(() => undefined);
  }
}

export function packageManageRoutes(deps: PackageManageRouteDeps): readonly RouteDefinition[] {
  function route(
    action: PackageVersionAction | 'rebuild',
    boundary: 'organization' | 'project',
  ): RouteDefinition {
    const spec = defineApi(packageManageSpec(action, boundary));
    return {
      ...spec,
      handler: async (ctx) => {
        const org = ctx.org;
        const actor = authenticatedActorOf(ctx);
        if (org === null || actor === null) return failure(ctx, 'unauthorized');
        if (boundary === 'project' && ctx.projectId === null) return failure(ctx, 'not_found');
        const params = validateInput(spec.api.params, ctx.params);
        if (!params.ok)
          return failure(
            ctx,
            'invalid_request',
            params.details.map(({ path, code }) => ({ path: `/params${path}`, code })),
          );
        if (new URL(ctx.request.url).searchParams.size > 0)
          return failure(ctx, 'invalid_request', [{ path: '/query', code: 'unrecognized_keys' }]);

        const read = await readOptionalJsonBody(ctx.request);
        if (!read.ok)
          return failure(
            ctx,
            read.code,
            read.status === 400 && read.detail !== 'invalid_request'
              ? [{ path: '/body', code: read.detail }]
              : undefined,
          );
        const parsed = validateInput(spec.api.body, read.value);
        if (!parsed.ok)
          return failure(
            ctx,
            'invalid_request',
            parsed.details.map(({ path, code }) => ({ path: `/body${path}`, code })),
          );
        const key = parseIdempotencyKey(ctx.request.headers.get('idempotency-key'));
        if (!key.ok)
          return failure(ctx, 'invalid_request', [
            { path: '/headers/idempotency-key', code: 'invalid' },
          ]);
        const authenticated = await deps.sessions.authenticate(org, ctx.request);
        if (
          authenticated === null ||
          authenticated.session.id !== actor.sessionId ||
          authenticated.session.userId !== actor.userId
        )
          return failure(ctx, 'unauthorized');
        if (
          (action === 'tombstone' || action === 'rebuild') &&
          !deps.sessions.isReauthFresh(authenticated)
        )
          return failure(ctx, 'reauth_required');
        const fence = mutationFence(actor, {});
        const call = auditCall(ctx, deps);
        const input = { packageId: params.data.package, versionId: params.data.version };
        const response = {
          id: input.versionId,
          status: action === 'rebuild' ? 'rebuild_requested' : STATUSES[action],
        };
        const run = (
          call: ApiCall,
        ): Promise<
          PackageManageResult | Awaited<ReturnType<TagRebuildPort['requestTagRebuild']>>
        > =>
          action === 'rebuild'
            ? deps.rebuild.requestTagRebuild(org, authenticated, fence, input, call)
            : deps.service.manage(
                org,
                authenticated,
                fence,
                {
                  ...input,
                  action,
                  scope:
                    boundary === 'project'
                      ? { kind: 'project', projectId: ctx.projectId! }
                      : { kind: 'organization' },
                },
                call,
              );
        const now = deps.clock.now();
        let record: IdempotencyRecord | undefined;
        let hash = '';
        const find = () =>
          deps.idempotency.find(
            org,
            principalKey(authenticated.principal),
            key.key!,
            now.toISOString(),
          );
        if (key.key !== null) {
          const name = `${spec.method} ${spec.path}`;
          hash = await requestHash({
            method: spec.method,
            route: name,
            params: ctx.params,
            body: {},
          });
          const existing = await find();
          const decision = decideReplay(existing, hash, now);
          if (decision === 'replay' && existing !== null)
            return replayResponse(existing, ctx.requestId);
          if (decision === 'mismatch') return failure(ctx, 'idempotency_mismatch');
          record = buildIdempotencyRecord({
            principal: authenticated.principal,
            key: key.key,
            route: name,
            hash,
            status: 200,
            response,
            now,
          });
        }
        const settled = await settleIdempotent({
          record,
          hash,
          now,
          find,
          run: () => run(record === undefined ? call : { ...call, idempotency: record }),
          failed: (result) => !result.ok,
        });
        if (settled.kind === 'replay') return replayResponse(settled.record, ctx.requestId);
        if (settled.kind === 'mismatch') return failure(ctx, 'idempotency_mismatch');
        const result = settled.result;
        if (!result.ok) return failure(ctx, ERRORS[result.error]);
        return jsonResponse(
          200,
          action === 'rebuild'
            ? response
            : {
                id: 'value' in result ? result.value.versionId : input.versionId,
                status: 'value' in result ? result.value.status : STATUSES[action],
              },
        );
      },
    };
  }
  return [
    ...(['organization', 'project'] as const).flatMap((boundary) =>
      (['quarantine', 'tombstone', 'release'] as const).map((action) => route(action, boundary)),
    ),
    route('rebuild', 'organization'),
  ];
}
