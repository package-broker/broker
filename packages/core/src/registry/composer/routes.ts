import { apiError } from '../../api/response.js';
import type { ProjectActor } from '../../authz/project-actor.js';
import { PACKAGES_READ, type PackageAccess } from '../../catalogue/package-access.js';
import type { ScopedCache } from '../../platform/cache.js';
import type { OnDemandFill } from '../../ingest/on-demand.js';
import { resolvedPackageOf } from '../../internal/package-context.js';
import { envelopeResponse } from '../../kernel/errors.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import type { RepresentationClock } from '../conditional.js';
import type { DistService } from '../dist-service.js';
import { parseComposerDistPath } from './dist-url.js';
import { renderComposerP2, renderPackagesJson } from './render.js';

export interface ComposerRouteDeps {
  readonly access: PackageAccess;
  readonly fill: OnDemandFill;
  readonly dist: DistService;
  readonly clock: RepresentationClock;
  readonly publicUrl: string;
  readonly cache?: ScopedCache;
}

const FILE = /^([^~]+?)(~dev)?\.json$/;
const COMPOSER_1 = /^Composer\/1\./;
const REVALIDATE = 'private, no-cache';
const BUSY_RETRY_AFTER_SECONDS = 10;

function notFound(requestId: string): Response {
  return envelopeResponse(404, 'not_found', 'Route not found', requestId);
}

function document(response: Response, requestId: string, stale = false): Response {
  if (response.status === 404) {
    void response.body?.cancel().catch(() => undefined);
    return notFound(requestId);
  }
  if (response.status === 200 || response.status === 304) {
    response.headers.set('Cache-Control', REVALIDATE);
    response.headers.delete('Expires');
  }
  if (stale) response.headers.set('x-broker-stale', '1');
  return response;
}

async function quietOnAbort(
  ctx: RequestContext,
  work: () => Promise<Response>,
  retryAfterSeconds: number,
): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (ctx.request.signal.aborted) return unavailable(ctx.requestId, retryAfterSeconds);
    throw error;
  }
}

function distExtension(headers: Headers): string | null {
  return /\.([a-z]+)"$/.exec(headers.get('Content-Disposition') ?? '')?.[1] ?? null;
}

function unavailable(requestId: string, retryAfterSeconds: number): Response {
  const response = apiError('unavailable', requestId);
  response.headers.set('Retry-After', String(retryAfterSeconds));
  return response;
}

function actorOf(ctx: RequestContext): ProjectActor | null {
  if (ctx.org === null || ctx.principal === null || ctx.projectId === null) return null;
  return Object.freeze({
    kind: 'project',
    userId: ctx.principal.id,
    orgId: ctx.org.orgId,
    projectId: ctx.projectId,
    permissions: new Set([PACKAGES_READ]),
  });
}

function p2File(file: string | undefined): { name: string; dev: boolean } | null {
  const match = file === undefined ? null : FILE.exec(file);
  return match?.[1] === undefined ? null : { name: match[1], dev: match[2] !== undefined };
}

export function composerRoutes(deps: ComposerRouteDeps): readonly RouteDefinition[] {
  const packagesJson: RouteDefinition = {
    method: 'GET',
    path: '/:project/packages.json',
    permission: PACKAGES_READ,
    boundary: 'project',
    async handler(ctx) {
      if (COMPOSER_1.test(ctx.request.headers.get('User-Agent') ?? '')) {
        return apiError('not_acceptable', ctx.requestId);
      }
      const actor = actorOf(ctx);
      if (actor === null) return notFound(ctx.requestId);
      return quietOnAbort(
        ctx,
        async () =>
          document(
            await renderPackagesJson({
              requestId: ctx.requestId,
              actor,
              access: deps.access,
              projectSlug: ctx.params['project'] ?? '',
            }),
            ctx.requestId,
          ),
        BUSY_RETRY_AFTER_SECONDS,
      );
    },
  };

  const p2: RouteDefinition = {
    method: 'GET',
    path: '/:project/p2/:vendor/:file',
    permission: PACKAGES_READ,
    boundary: 'package',
    package: {
      ecosystem: 'composer',
      fetchOnAdmission: true,
      name: (params) => {
        const parsed = p2File(params['file']);
        return parsed === null ? null : `${params['vendor'] ?? ''}/${parsed.name}`;
      },
    },
    async handler(ctx) {
      const actor = actorOf(ctx);
      const resolved = resolvedPackageOf(ctx);
      const parsed = p2File(ctx.params['file']);
      if (actor === null || resolved === null || parsed === null) return notFound(ctx.requestId);
      const key = resolved.kind === 'visible' ? resolved.pkg.key : resolved.key;
      return quietOnAbort(
        ctx,
        async () => {
          const filled = await deps.fill.ensure(actor, {
            ecosystem: 'composer',
            key,
            outcome: resolved,
            signal: ctx.request.signal,
          });
          if (filled.kind === 'not_found') return notFound(ctx.requestId);
          if (filled.kind === 'busy') return unavailable(ctx.requestId, filled.retryAfterSeconds);
          if (filled.kind === 'upstream_error') return apiError('bad_gateway', ctx.requestId);
          if (filled.kind === 'serve' && filled.background !== undefined) {
            const background = filled.background;
            void Promise.resolve()
              .then(background)
              .catch(() => undefined);
          }
          return document(
            await renderComposerP2({
              requestId: ctx.requestId,
              actor,
              access: deps.access,
              projectSlug: ctx.params['project'] ?? '',
              name: key,
              publicUrl: deps.publicUrl,
              request: ctx.request,
              clock: deps.clock,
              dev: parsed.dev,
              ...(deps.cache === undefined ? {} : { cache: deps.cache }),
            }),
            ctx.requestId,
            filled.kind === 'serve' && filled.stale,
          );
        },
        BUSY_RETRY_AFTER_SECONDS,
      );
    },
  };

  const dist: RouteDefinition = {
    method: 'GET',
    path: '/:project/dist/:vendor/:name/:file',
    permission: PACKAGES_READ,
    boundary: 'package',
    package: {
      ecosystem: 'composer',
      name: (params) =>
        params['vendor'] === undefined || params['name'] === undefined
          ? null
          : `${params['vendor']}/${params['name']}`,
    },
    async handler(ctx) {
      const actor = actorOf(ctx);
      const resolved = resolvedPackageOf(ctx);
      const ref = parseComposerDistPath(new URL(ctx.request.url).pathname);
      if (
        actor === null ||
        resolved?.kind !== 'visible' ||
        ref === null ||
        ref.project !== ctx.params['project'] ||
        ref.key !== resolved.pkg.key
      ) {
        return notFound(ctx.requestId);
      }
      return quietOnAbort(
        ctx,
        async () => {
          const result = await deps.dist.serve(actor, {
            ecosystem: 'composer',
            key: resolved.pkg.key,
            versionId: ref.versionId,
            revision: ref.revision,
          });
          if (result.kind === 'busy') return unavailable(ctx.requestId, result.retryAfterSeconds);
          if (result.kind === 'not_found') return notFound(ctx.requestId);
          if (distExtension(result.headers) !== ref.type) {
            void result.body.cancel().catch(() => undefined);
            return notFound(ctx.requestId);
          }
          return new Response(result.body, { status: 200, headers: result.headers });
        },
        BUSY_RETRY_AFTER_SECONDS,
      );
    },
  };

  return Object.freeze([packagesJson, p2, dist]);
}
