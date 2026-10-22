import type { $ZodType, output } from 'zod/v4/core';
import { CsrfError, assertSameOrigin } from './csrf.js';
import { sessionMetaOf } from './session.js';
import type { LocalLoginService } from './local-login.js';
import type { LocalSetupService } from './local-setup.js';
import type { SessionService } from './session.js';
import type { OrgContext } from '../db/port.js';
import {
  localLoginBody,
  localReauthBody,
  localSetupFinishBody,
  localSetupStartBody,
} from '../api/auth-schemas.js';
import { apiError } from '../api/response.js';
import { validateInput, type ValidationDetail } from '../api/validate.js';
import { envelopeResponse } from '../kernel/errors.js';
import type { KernelLog } from '../kernel/errors.js';
import type { RequestContext, RouteDefinition } from '../plugin.js';

const MAX_BODY_BYTES = 8192;
const JSON_MEDIA_TYPE = 'application/json';

class InvalidBodyError extends Error {
  constructor(readonly details: readonly ValidationDetail[]) {
    super('invalid_request');
    this.name = 'InvalidBodyError';
  }
}

class BadBodyError extends Error {
  constructor() {
    super('bad_body');
    this.name = 'BadBodyError';
  }
}

async function readBytes(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BadBodyError();
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      throw new BadBodyError();
    }
    const { done, value } = chunk;
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BadBodyError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readFields<S extends $ZodType>(request: Request, schema: S): Promise<output<S>> {
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) throw new BadBodyError();
  const bytes = await readBytes(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BadBodyError();
  }
  const result = validateInput(schema, parsed);
  if (!result.ok) {
    throw new InvalidBodyError(
      result.details.map((detail) => ({ ...detail, path: `/body${detail.path}` })),
    );
  }
  return result.data;
}

function orgOf(ctx: RequestContext): OrgContext {
  if (ctx.org === null) throw new TypeError('local routes require an organization context');
  return ctx.org;
}

export function createLocalRoutes(deps: {
  readonly local: LocalLoginService;
  readonly setup: LocalSetupService;
  readonly sessions: SessionService;
  readonly publicOrigin: string;
  readonly clientIp?: (request: Request) => string | null;
  readonly log: KernelLog;
}): readonly RouteDefinition[] {
  const { local, setup, sessions, publicOrigin } = deps;
  if (publicOrigin === 'null' || new URL(publicOrigin).origin !== publicOrigin) {
    throw new TypeError('publicOrigin must be a canonical origin');
  }
  const log: KernelLog = (entry) => {
    try {
      deps.log(entry);
    } catch {
      return;
    }
  };

  const forbidden = (ctx: RequestContext): Response =>
    envelopeResponse(403, 'forbidden', 'Forbidden', ctx.requestId);
  const badRequest = (ctx: RequestContext): Response =>
    envelopeResponse(400, 'bad_request', 'Bad request', ctx.requestId);
  const unauthorized = (ctx: RequestContext): Response =>
    envelopeResponse(401, 'unauthorized', 'Unauthorized', ctx.requestId);
  const invalidCredentials = (ctx: RequestContext): Response =>
    envelopeResponse(401, 'invalid_credentials', 'Invalid credentials', ctx.requestId);
  const noContent = (cookies: readonly string[]): Response => {
    const headers = new Headers({ 'cache-control': 'no-store' });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return new Response(null, { status: 204, headers });
  };

  const guarded =
    (handle: (ctx: RequestContext, org: OrgContext) => Promise<Response>) =>
    async (ctx: RequestContext): Promise<Response> => {
      try {
        assertSameOrigin(ctx.request, publicOrigin);
        return await handle(ctx, orgOf(ctx));
      } catch (error) {
        if (error instanceof CsrfError) return forbidden(ctx);
        if (error instanceof BadBodyError) return badRequest(ctx);
        if (error instanceof InvalidBodyError) {
          const response = apiError('invalid_request', ctx.requestId, error.details);
          response.headers.set('x-request-id', ctx.requestId);
          return response;
        }
        throw error;
      }
    };

  return [
    {
      method: 'POST',
      path: '/_pb/auth/local/setup/start',
      permission: null,
      handler: guarded(async (ctx, org) => {
        const { token } = await readFields(ctx.request, localSetupStartBody);
        const result = await setup.start(org, token);
        if (!result.ok) {
          log({ level: 'info', event: 'auth.local.setup.refused', requestId: ctx.requestId });
          return invalidCredentials(ctx);
        }
        return Response.json(
          { provisioningUri: result.provisioningUri, secret: result.secret },
          { headers: { 'cache-control': 'no-store', 'x-request-id': ctx.requestId } },
        );
      }),
    },
    {
      method: 'POST',
      path: '/_pb/auth/local/setup/finish',
      permission: null,
      handler: guarded(async (ctx, org) => {
        const body = await readFields(ctx.request, localSetupFinishBody);
        const result = await setup.finish(
          org,
          body,
          await sessionMetaOf(ctx.request, deps.clientIp),
        );
        if (result.ok) {
          log({
            level: 'info',
            event: 'auth.local.setup.completed',
            requestId: ctx.requestId,
            user_id: result.userId,
          });
          return noContent(result.cookies);
        }
        log({ level: 'info', event: 'auth.local.setup.refused', requestId: ctx.requestId });
        if (result.problems !== undefined && result.problems.length > 0) {
          const body = {
            error: {
              code: 'weak_password',
              message: 'Password does not meet the requirements',
              requestId: ctx.requestId,
              problems: [...result.problems],
            },
          };
          return Response.json(body, {
            status: 400,
            headers: { 'cache-control': 'no-store', 'x-request-id': ctx.requestId },
          });
        }
        return invalidCredentials(ctx);
      }),
    },
    {
      method: 'POST',
      path: '/_pb/auth/local/login',
      permission: null,
      handler: guarded(async (ctx, org) => {
        const body = await readFields(ctx.request, localLoginBody);
        const result = await local.login(
          org,
          body,
          await sessionMetaOf(ctx.request, deps.clientIp),
        );
        if (result.ok) {
          log({
            level: 'info',
            event: 'auth.login.succeeded',
            provider: 'local',
            requestId: ctx.requestId,
            user_id: result.userId,
          });
          return noContent(result.cookies);
        }
        log({
          level: 'info',
          event: 'auth.login.refused',
          provider: 'local',
          requestId: ctx.requestId,
        });
        return invalidCredentials(ctx);
      }),
    },
    {
      method: 'POST',
      path: '/_pb/auth/local/reauth',
      permission: null,
      handler: guarded(async (ctx, org) => {
        const body = await readFields(ctx.request, localReauthBody);
        const authenticated = await sessions.authenticate(org, ctx.request);
        if (authenticated === null) return unauthorized(ctx);
        await sessions.assertCsrf(ctx.request, authenticated);
        const result = await local.reauth(org, authenticated, body);
        if (result.ok) {
          log({
            level: 'info',
            event: 'auth.reauth.succeeded',
            requestId: ctx.requestId,
            session_id: authenticated.session.id,
          });
          return noContent([]);
        }
        log({
          level: 'info',
          event: 'auth.reauth.refused',
          ...(result.reason === 'session_inactive' ? { reason: result.reason } : {}),
          requestId: ctx.requestId,
          session_id: authenticated.session.id,
        });
        if (result.reason === 'session_inactive') return unauthorized(ctx);
        return invalidCredentials(ctx);
      }),
    },
  ];
}
