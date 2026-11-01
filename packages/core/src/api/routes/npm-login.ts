import { createAnonymousAdmission } from '../anonymous-admission.js';
import { envelopeResponse } from '../../kernel/errors.js';
import * as z from 'zod';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import type { OrgContext } from '../../db/port.js';
import type { SessionService } from '../../auth/session.js';
import type { PersonalTokenService } from '../../authz/pat-service.js';
import { authenticatedActorOf } from '../../authz/access-context.js';
import { mutationFence } from '../../authz/fence.js';
import { base64urlEncode } from '../../auth/primitives.js';
import { apiRoute } from '../route.js';
import { API_ERROR_CODES, jsonResponse } from '../response.js';
import { auditCall, type ApiRouteDeps } from './context.js';
import { NPM_IDENTITY_SCHEMAS as schemas } from './npm-identity-schemas.js';
import { readNpmLoginBody, readNpmLoginApprovalBody } from './npm-login-body.js';

export interface NpmLoginStore {
  start(
    ctx: OrgContext,
    input: {
      id: string;
      projectId: string;
      selectorHash: string;
      doneHash: string;
      hostname: string | null;
      sourceIp: string | null;
    },
  ): Promise<boolean>;
  confirmation(
    ctx: OrgContext,
    hash: string,
  ): Promise<{
    projectId: string;
    name: string;
    slug: string;
    cliHostname: string | null;
    sourceIp: string | null;
    createdAt: string;
    expiresAt: string;
  } | null>;
  poll(
    ctx: OrgContext,
    projectId: string,
    hash: string,
    buildResponse: (token: string) => void,
  ): Promise<{ status: 'pending' | 'not_found' } | { status: 'token'; token: string }>;
}
export interface NpmLoginDeps extends ApiRouteDeps {
  readonly admissionIp?: (request: Request) => string | null;
  readonly store: NpmLoginStore;
  readonly publicUrl: string;
  readonly projects: {
    getBySlug(ctx: OrgContext, slug: string): Promise<{ id: string; status: string } | null>;
  };
  readonly sessions: Pick<SessionService, 'authenticate' | 'isReauthFresh'>;
  readonly personal: (selectorHash: string) => PersonalTokenService;
}
export async function npmLoginHash(secret: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const params = z.strictObject({ selector: z.string().regex(SECRET) });
export function npmLoginRoutes(deps: NpmLoginDeps): readonly RouteDefinition[] {
  const admit = createAnonymousAdmission(() => deps.clock.now().getTime());
  const fail = (ctx: RequestContext, code: keyof typeof API_ERROR_CODES) =>
    envelopeResponse(
      API_ERROR_CODES[code].status,
      code,
      code === 'not_found' ? 'Route not found' : API_ERROR_CODES[code].message,
      ctx.requestId,
      undefined,
      'npm',
    );
  const routes: RouteDefinition[] = [
    {
      method: 'POST',
      path: '/:project/npm/-/v1/login',
      boundary: 'none',
      permission: null,
      handler: async (ctx) => {
        if (ctx.org === null) return fail(ctx, 'not_found');
        const project = await deps.projects.getBySlug(ctx.org, ctx.params['project'] ?? '');
        if (project === null || project.status !== 'active') return fail(ctx, 'not_found');
        let body;
        try {
          body = await readNpmLoginBody(ctx.request);
        } catch {
          return fail(ctx, 'invalid_request');
        }
        const selector = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
        const done = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
        const ip = deps.clientIp(ctx.request);
        const created = await deps.store.start(ctx.org, {
          id: deps.ids.ulid(),
          projectId: project.id,
          selectorHash: await npmLoginHash(selector),
          doneHash: await npmLoginHash(done),
          hostname: body.hostname ?? null,
          sourceIp: ip !== null && /^[0-9a-fA-F:.]{1,45}$/.test(ip) ? ip : null,
        });
        if (!created) return fail(ctx, 'too_many_sessions');
        const base = deps.publicUrl.replace(/\/$/, '');
        return jsonResponse(200, {
          loginUrl: `${base}/#/npm-login/${selector}`,
          doneUrl: `${base}/${encodeURIComponent(ctx.params['project']!)}/npm/-/v1/done/${done}`,
        });
      },
    },
    {
      method: 'GET',
      path: '/:project/npm/-/v1/done/:session',
      boundary: 'none',
      permission: null,
      handler: async (ctx) => {
        if (ctx.org === null || !SECRET.test(ctx.params['session'] ?? ''))
          return fail(ctx, 'not_found');
        const project = await deps.projects.getBySlug(ctx.org, ctx.params['project'] ?? '');
        if (project === null || project.status !== 'active') return fail(ctx, 'not_found');
        let delivered: Response | undefined;
        const result = await deps.store.poll(
          ctx.org,
          project.id,
          await npmLoginHash(ctx.params['session']!),
          (token) => {
            delivered = jsonResponse(200, { token });
          },
        );
        if (result.status === 'token')
          return delivered ?? jsonResponse(200, { token: result.token });
        if (result.status === 'pending') {
          const response = jsonResponse(202, {});
          response.headers.set('Retry-After', '5');
          return response;
        }
        return fail(ctx, 'not_found');
      },
    },
    apiRoute(
      {
        method: 'GET',
        path: '/_pb/me/npm-login/:selector',
        boundary: 'self',
        permission: null,
        api: {
          operationId: 'getNpmLogin',
          summary: 'Review an npm login request',
          tags: ['tokens'],
          sessionOnly: true,
          params,
          responses: { 200: schemas.NpmLoginConfirmation },
        },
      },
      async ({ ctx, params }) => {
        if (ctx.org === null) return { error: 'not_found' };
        const session = await deps.sessions.authenticate(ctx.org, ctx.request);
        if (session === null) return { error: 'unauthorized' };
        if (!deps.sessions.isReauthFresh(session)) return { error: 'reauth_required' };
        const row = await deps.store.confirmation(ctx.org, await npmLoginHash(params.selector));
        if (row === null) return { error: 'not_found' };
        return {
          status: 200,
          body: {
            project: { id: row.projectId, name: row.name, slug: row.slug },
            cliHostname: row.cliHostname,
            sourceIp: row.sourceIp,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
          },
        };
      },
    ),
    apiRoute(
      {
        method: 'POST',
        path: '/_pb/me/npm-login/:selector',
        boundary: 'self',
        permission: null,
        api: {
          operationId: 'approveNpmLogin',
          summary: 'Approve an npm login request',
          tags: ['tokens'],
          sessionOnly: true,
          params,
          body: schemas.NpmLoginApprovalBody,
          responses: { 200: schemas.NpmLoginConfirmResponse },
        },
      },
      async ({ ctx, params, body }) => {
        const actor = authenticatedActorOf(ctx);
        if (ctx.org === null || actor === null) return { error: 'unauthorized' };
        const session = await deps.sessions.authenticate(ctx.org, ctx.request);
        if (session === null || session.session.id !== actor.sessionId)
          return { error: 'unauthorized' };
        const hash = await npmLoginHash(params.selector);
        const row = await deps.store.confirmation(ctx.org, hash);
        if (row === null) return { error: 'conflict' };
        const result = await deps.personal(hash).issue(
          ctx.org,
          session,
          mutationFence(actor, {}),
          {
            name: 'npm login',
            scope: body.scope,
            projectMode: 'selected',
            projectIds: [row.projectId],
          },
          auditCall(ctx, deps),
        );
        if (result.ok) return { status: 200, body: { ok: true } };
        return {
          error:
            result.error === 'reauth_required'
              ? 'reauth_required'
              : result.error === 'indeterminate'
                ? 'unavailable'
                : result.error === 'conflict'
                  ? 'conflict'
                  : 'forbidden',
        };
      },
    ),
  ];
  return routes.map((route) => ({
    ...route,
    handler: async (ctx) => {
      if (route.method === 'POST' && route.path.startsWith('/_pb/')) {
        try {
          await readNpmLoginApprovalBody(ctx.request.clone());
        } catch {
          const response = envelopeResponse(
            API_ERROR_CODES.invalid_request.status,
            'invalid_request',
            API_ERROR_CODES.invalid_request.message,
            ctx.requestId,
          );
          response.headers.set('Cache-Control', 'no-store');
          return response;
        }
      }
      if (!route.path.startsWith('/_pb/') && ctx.org !== null) {
        const retry = admit(
          ctx.org.orgId,
          route.method === 'POST' ? 'login-start' : 'login-poll',
          (deps.admissionIp ?? deps.clientIp)(ctx.request),
        );
        if (retry > 0) {
          const response = envelopeResponse(
            429,
            'rate_limited',
            'Rate limit exceeded',
            ctx.requestId,
            undefined,
            'npm',
          );
          response.headers.set('Retry-After', String(retry));
          response.headers.set('Cache-Control', 'no-store');
          return response;
        }
      }
      const response = await route.handler(ctx);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    },
  }));
}
