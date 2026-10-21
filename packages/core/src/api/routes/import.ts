import { auditEvent, type AuditAction, type AuditEvent } from '../../audit/actions.js';
import { accessContextOf, authenticatedActorOf } from '../../authz/access-context.js';
import {
  mutationFence,
  fenceKind,
  type MutationFence,
  type TokenMutationFence,
} from '../../authz/fence.js';
import type { OrgContext, Statement } from '../../db/port.js';
import type {
  ImportCredentialService as CredentialService,
  ImportCredentialError,
} from '../../import/credentials.js';
import { MAX_MANIFEST_BYTES, parseManifest } from '../../import/manifest.js';
import type {
  ImportRunService as RunService,
  ImportRunDto,
  ImportRunError,
} from '../../import/run-service.js';
import { denialResponse } from '../../kernel/denial-page.js';
import { envelopeResponse } from '../../kernel/errors.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { apiError, jsonResponse, type ApiErrorCode } from '../response.js';
import { apiRoute, defineApi } from '../route.js';
import { readJsonBody, VALIDATION_CODES, type ValidationCode } from '../validate.js';
import { auditCall, type ApiRouteDeps } from './context.js';
import {
  IMPORT_ACTIONS,
  IMPORT_CREATE_SPEC,
  IMPORT_CREDENTIAL_SPEC,
  IMPORT_GET_SPEC,
  IMPORT_LIST_SPEC,
  importActionSpec,
} from './import.schemas.js';

export type ImportRunService = RunService;
export type ImportCredentialService = CredentialService;

export interface ImportRouteDeps extends ApiRouteDeps {
  readonly service: ImportRunService;
  readonly credentials: ImportCredentialService;
  readonly auditStatement: (org: OrgContext, event: AuditEvent) => Statement;
  readonly tokenFence: (ctx: RequestContext) => Promise<TokenMutationFence>;
}

const ERRORS = {
  not_found: 'not_found',
  forbidden: 'forbidden',
  reauth_required: 'reauth_required',
  not_approved: 'not_approved',
  conflict: 'conflict',
  unavailable: 'unavailable',
  invalid_manifest: 'invalid_request',
  invalid_time: 'invalid_request',
  invalid_cursor: 'invalid_request',
  invalid_limit: 'invalid_request',
  invalid_credential: 'invalid_request',
  too_large: 'payload_too_large',
} as const satisfies Record<ImportRunError | ImportCredentialError, ApiErrorCode>;

function orgOf(ctx: RequestContext): OrgContext {
  if (ctx.org === null) throw new TypeError('import route requires an organization');
  return ctx.org;
}

async function fenceOf(
  ctx: RequestContext,
  deps: ImportRouteDeps,
): Promise<MutationFence | TokenMutationFence> {
  const actor = authenticatedActorOf(ctx);
  if (actor !== null) return mutationFence(actor, {});
  const access = accessContextOf(ctx);
  if (
    access?.token == null ||
    access.principal === null ||
    access.rateKey.stage !== 'authenticated' ||
    access.rateKey.tokenSelector === null
  ) {
    throw new TypeError('import route requires an authenticated actor');
  }
  const fence = await deps.tokenFence(ctx);
  if (
    fenceKind(fence) !== 'token' ||
    fence.permission !== 'org:import:write' ||
    fence.principalId !== access.principal.id ||
    fence.tokenKind !== access.token.kind
  ) {
    throw new TypeError('import route requires an import write token fence');
  }
  return fence;
}

function view(run: ImportRunDto): ImportRunDto {
  return {
    id: run.id,
    state: run.state,
    planHash: run.planHash,
    approvedAt: run.approvedAt,
    approvedByUserId: run.approvedByUserId,
    acceptedAt: run.acceptedAt,
    beforeImageExpiresAt: run.beforeImageExpiresAt,
  };
}

function audit(
  ctx: RequestContext,
  deps: ImportRouteDeps,
  action: AuditAction,
  runId: string | null,
  now: string,
): Statement {
  if (ctx.principal === null) throw new TypeError('import route requires a principal');
  const event = auditEvent({
    id: deps.ids.ulid(),
    now,
    action,
    actor: {
      type: ctx.principal.kind === 'service' ? 'service_principal' : 'user',
      id: ctx.principal.id,
    },
    context: auditCall(ctx, deps).audit,
    target: { type: 'import_run', id: runId },
  });
  if (!event.ok) throw new TypeError('invalid import audit context');
  return deps.auditStatement(orgOf(ctx), event.event);
}

export function importRoutes(deps: ImportRouteDeps): readonly RouteDefinition[] {
  // The shared builder has a fixed 64 KiB cap; import manifests need their own raw-byte reader.
  const create: RouteDefinition = {
    ...defineApi(IMPORT_CREATE_SPEC),
    handler: async (ctx) => {
      if (new URL(ctx.request.url).searchParams.size > 0)
        return apiError('invalid_request', ctx.requestId, [
          { path: '/query', code: 'unrecognized_keys' },
        ]);
      const read = await readJsonBody(ctx.request, { maxBytes: MAX_MANIFEST_BYTES });
      if (!read.ok)
        return apiError(
          read.code,
          ctx.requestId,
          read.status === 400 && read.detail !== 'invalid_request'
            ? [{ path: '/body', code: read.detail }]
            : undefined,
        );
      const parsed = parseManifest(read.value);
      if (!parsed.ok)
        return apiError(
          'invalid_request',
          ctx.requestId,
          parsed.details.map(({ path, code }) => ({
            path: `/body${path}`,
            code: VALIDATION_CODES.has(code) ? (code as ValidationCode) : 'invalid',
          })),
        );
      const now = deps.clock.now().toISOString();
      const result = await deps.service.createRun(orgOf(ctx), await fenceOf(ctx, deps), {
        manifest: parsed.data,
        now,
        audit: audit(ctx, deps, 'import_run.create', null, now),
      });
      if (!result.ok) return apiError(ERRORS[result.error], ctx.requestId);
      const { id, planHash, state } = result.value;
      return jsonResponse(201, { id, planHash, state });
    },
  };
  const list = apiRoute(IMPORT_LIST_SPEC, async ({ ctx, query }) => {
    const result = await deps.service.list(orgOf(ctx), {
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    });
    return result.ok
      ? { status: 200, body: { items: result.value.items.map(view), next: result.value.next } }
      : { error: ERRORS[result.error] };
  });
  const get = apiRoute(IMPORT_GET_SPEC, async ({ ctx, params }) => {
    const result = await deps.service.get(orgOf(ctx), params.id);
    return result.ok ? { status: 200, body: view(result.value) } : { error: ERRORS[result.error] };
  });
  const actions = (Object.keys(IMPORT_ACTIONS) as (keyof typeof IMPORT_ACTIONS)[]).map((action) =>
    apiRoute(importActionSpec(action), async ({ ctx, params, body }) => {
      const now = deps.clock.now().toISOString();
      const input = {
        runId: params.id,
        now,
        audit: audit(ctx, deps, `import_run.${action}` as AuditAction, params.id, now),
      };
      const fence = await fenceOf(ctx, deps);
      if (action !== 'verify' && authenticatedActorOf(ctx) === null) return { error: 'forbidden' };
      const result =
        action === 'approve'
          ? await deps.service.approveRun(orgOf(ctx), fence as MutationFence, {
              ...input,
              planHash: body?.planHash ?? '',
            })
          : action === 'verify'
            ? await deps.service.requestVerify(orgOf(ctx), fence, input)
            : await deps.service[IMPORT_ACTIONS[action]](orgOf(ctx), fence as MutationFence, input);
      return result.ok ? { status: 204 } : { error: ERRORS[result.error] };
    }),
  );
  const credential = apiRoute(IMPORT_CREDENTIAL_SPEC, async ({ ctx, params, body }) => {
    const result = await deps.credentials.acceptImportCredential(
      orgOf(ctx),
      await fenceOf(ctx, deps),
      {
        runId: params.id,
        externalRef: params.externalRef,
        kind: body.kind,
        material: body.material,
        now: deps.clock.now().toISOString(),
        context: auditCall(ctx, deps).audit,
      },
    );
    return result.ok ? { status: 204 } : { error: ERRORS[result.error] };
  });
  return [create, list, get, ...actions, credential].map((route) => ({
    ...route,
    handler: async (ctx) => {
      const response = await route.handler(ctx);
      if (response.status === 404)
        return envelopeResponse(404, 'not_found', 'Route not found', ctx.requestId);
      if (response.status === 403) {
        const body = (await response.clone().json()) as { error: { code: string } };
        if (body.error.code === 'forbidden') return denialResponse(ctx.request, ctx.requestId);
      }
      response.headers.set('x-request-id', ctx.requestId);
      return response;
    },
  }));
}
