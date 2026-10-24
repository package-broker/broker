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
  CreatedImportRun,
  ImportRunService as RunService,
  ImportRunDto,
  ImportRunError,
} from '../../import/run-service.js';
import { isUlid } from '../../ids.js';
import { denialResponse } from '../../kernel/denial-page.js';
import { envelopeResponse } from '../../kernel/errors.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import {
  buildIdempotencyRecord,
  parseIdempotencyKey,
  principalKey,
  requestHash,
  settleIdempotent,
} from '../idempotency.js';
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
    credentialWindowUntil: run.credentialWindowUntil,
  };
}

function replayedRun(responseJson: string): { id: string; state: 'planned' } | null {
  let stored: unknown;
  try {
    stored = JSON.parse(responseJson);
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null) return null;
  const { id, state } = stored as Record<string, unknown>;
  return typeof id === 'string' && isUlid(id) && state === 'planned' ? { id, state } : null;
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
      const key = parseIdempotencyKey(ctx.request.headers.get('idempotency-key'));
      if (!key.ok)
        return apiError('invalid_request', ctx.requestId, [
          { path: '/headers/idempotency-key', code: 'invalid' },
        ]);
      const org = orgOf(ctx);
      const fence = await fenceOf(ctx, deps);
      const clockNow = deps.clock.now();
      const now = clockNow.toISOString();
      const input = {
        manifest: parsed.data,
        now,
        audit: audit(ctx, deps, 'import_run.create', null, now),
      };
      const created = (result: Awaited<ReturnType<ImportRunService['createRun']>>) => {
        if (!result.ok) return apiError(ERRORS[result.error], ctx.requestId);
        const { id, planHash, state } = result.value;
        return jsonResponse(201, { id, planHash, state });
      };
      if (key.key === null) return created(await deps.service.createRun(org, fence, input));
      const { principal } = ctx;
      if (principal === null) throw new TypeError('import route requires a principal');
      const hash = await requestHash({
        method: IMPORT_CREATE_SPEC.method,
        route: IMPORT_CREATE_SPEC.path,
        params: {},
        body: parsed.data,
      });
      // The plan hash is left out: its hex digest trips the shared credential-value check, and a
      // replay reads it back from the run, where it never changes.
      const record = ({ id, state }: Pick<CreatedImportRun, 'id' | 'state'>) =>
        buildIdempotencyRecord({
          principal,
          key: key.key!,
          route: IMPORT_CREATE_SPEC.path,
          hash,
          status: 201,
          response: { id, state },
          now: clockNow,
        });
      const settled = await settleIdempotent({
        record: record({ id: '', state: 'planned' }),
        hash,
        now: clockNow,
        find: () => deps.service.findIdempotency(org, principalKey(principal), key.key!, now),
        run: () => deps.service.createRun(org, fence, { ...input, idempotency: record }),
        failed: (result) => !result.ok,
      });
      if (settled.kind === 'mismatch') return apiError('idempotency_mismatch', ctx.requestId);
      if (settled.kind === 'result') return created(settled.result);
      const stored = replayedRun(settled.record.responseJson);
      if (stored === null) return apiError('conflict', ctx.requestId);
      const run = await deps.service.get(org, stored.id);
      if (!run.ok || run.value.planHash === null) return apiError('conflict', ctx.requestId);
      const response = jsonResponse(201, {
        id: stored.id,
        planHash: run.value.planHash,
        state: stored.state,
      });
      response.headers.set('Idempotent-Replayed', 'true');
      return response;
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
    if (!result.ok) return { error: ERRORS[result.error] };
    const credentials = await deps.credentials.credentialStatus(orgOf(ctx), params.id);
    if (!credentials.ok) return { error: ERRORS[credentials.error] };
    return {
      status: 200,
      body: {
        ...view(result.value),
        credentials: credentials.value.map(({ sourceRef, bound }) => ({ sourceRef, bound })),
      },
    };
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
