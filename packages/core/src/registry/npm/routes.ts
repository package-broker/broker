import { API_ERROR_CODES, jsonResponse } from '../../api/response.js';
import { accessContextOf } from '../../authz/access-context.js';
import { contextPackageActorOf } from '../../internal/package-actor.js';
import { deferOf } from '../defer.js';
import type { ProjectActor } from '../../authz/project-actor.js';
import { displayName, packageKey } from '../../catalogue/names.js';
import type { PackageAccess } from '../../catalogue/package-access.js';
import {
  CATALOGUE_SEARCH_MAX,
  CATALOGUE_WINNER_KEYS_MAX,
  type PackageVisibility,
} from '../../db/catalogue.js';
import type { OnDemandFill } from '../../ingest/on-demand.js';
import { resolvedPackageOf } from '../../internal/package-context.js';
import { CodecLimitError, type Codecs } from '../../platform/codec.js';
import type { RequestContext, RouteDefinition } from '../../plugin.js';
import { isNotModified, notModifiedResponse, npmValidators } from '../conditional.js';
import type { DistService } from '../dist-service.js';
import { parseNpmPath, type NpmPath } from './paths.js';
import { renderPackument, renderVersionDocument, type NpmRenderOptions } from './render.js';

export const NPM_RENDER_VERSION = 1;
const ABBREVIATED_TYPE = 'application/vnd.npm.install-v1+json';
const VARY = 'Accept, Authorization';
const REVALIDATE = 'private, no-cache';
const AUDIT_BODY_MAX = 1024 * 1024;
const SEARCH_DEFAULT = 20;
const READ = 'project:packages:read';
const NOT_FOUND = { status: 404, code: 'not_found', message: 'Route not found' };

export interface NpmRouteDeps {
  readonly access: PackageAccess;
  readonly dist: Pick<DistService, 'serve'>;
  readonly onDemand: OnDemandFill;
  readonly actorOf?: (ctx: RequestContext) => ProjectActor | null;
  readonly reresolve: (ctx: RequestContext) => Promise<PackageVisibility>;
  readonly handleOf: (ctx: RequestContext) => string | null;
  readonly defer?: (thunk: () => Promise<void>) => void;
  readonly publicUrl: string;
  readonly codecs: Pick<Codecs, 'gunzip'>;
}

function fail(
  ctx: RequestContext,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  const response = jsonResponse(status, { error: message, code, requestId: ctx.requestId });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

const notFound = (ctx: RequestContext) =>
  fail(ctx, NOT_FOUND.status, NOT_FOUND.code, NOT_FOUND.message);
const unavailable = (ctx: RequestContext, retryAfter: number) =>
  fail(ctx, 503, 'unavailable', API_ERROR_CODES.unavailable.message, {
    'Retry-After': String(retryAfter),
  });

function rawSegments(ctx: RequestContext): string[] {
  return new URL(ctx.request.url).pathname.split('/').slice(3);
}

function acceptsAbbreviated(accept: string | null): boolean {
  return (accept ?? '').split(',').some((item) => {
    const [type, ...parameters] = item.split(';').map((part) => part.trim().toLowerCase());
    const quality = parameters.find((parameter) => parameter.startsWith('q='));
    return type === ABBREVIATED_TYPE && (quality === undefined || Number(quality.slice(2)) > 0);
  });
}

function nameFrom(params: Readonly<Record<string, string>>, names: readonly string[]) {
  const parsed = parseNpmPath(names.map((name) => encodeURIComponent(params[name] ?? '')));
  return parsed.kind === 'packument' || parsed.kind === 'version' || parsed.kind === 'tarball'
    ? displayName(parsed.key)
    : null;
}

function distTagsName(params: Readonly<Record<string, string>>): string | null {
  const parsed = parseNpmPath(['-', 'package', encodeURIComponent(params['a'] ?? ''), 'dist-tags']);
  return parsed.kind === 'dist_tags' ? displayName(parsed.key) : null;
}

function outcomeKey(outcome: PackageVisibility): string | null {
  if (outcome.kind === 'visible') return outcome.pkg.key;
  return outcome.kind === 'proxy_admissible' ? outcome.key : null;
}

type Served = Extract<NpmPath, { kind: 'packument' | 'version' | 'tarball' }>;

export function npmRoutes(deps: NpmRouteDeps): RouteDefinition[] {
  function actorFor(ctx: RequestContext): ProjectActor | null {
    const actor = (deps.actorOf ?? contextPackageActorOf)(ctx);
    const snapshot = accessContextOf(ctx);
    if (
      actor === null ||
      snapshot === null ||
      ctx.org === null ||
      ctx.principal === null ||
      ctx.projectId === null ||
      actor.orgId !== ctx.org.orgId ||
      actor.projectId !== ctx.projectId ||
      actor.projectId !== snapshot.projectId ||
      actor.userId !== ctx.principal.id ||
      actor.userId !== snapshot.principal?.id ||
      !actor.permissions.has(READ)
    ) {
      return null;
    }
    return actor;
  }

  function ok(body: unknown): Response {
    const response = jsonResponse(200, body);
    response.headers.set('Cache-Control', REVALIDATE);
    response.headers.set('Vary', VARY);
    return response;
  }

  async function resolveForRead(
    ctx: RequestContext,
    parsed: Served | { kind: 'dist_tags'; key: string },
  ) {
    const actor = actorFor(ctx);
    if (actor === null) return unavailable(ctx, 10);
    const resolved = resolvedPackageOf(ctx);
    if (resolved === null || outcomeKey(resolved) !== parsed.key) return notFound(ctx);
    if (resolved.kind === 'visible' && resolved.pkg.projectId !== actor.projectId) {
      return notFound(ctx);
    }
    if (parsed.kind === 'dist_tags') {
      return resolved.kind === 'visible'
        ? { actor, pkg: resolved.pkg, stale: false }
        : notFound(ctx);
    }
    const filled = await deps.onDemand.ensure(actor, {
      ecosystem: 'npm',
      key: parsed.key,
      outcome: resolved,
      signal: ctx.request.signal,
    });
    if (ctx.request.signal.aborted) return new Response(null, { status: 499 });
    if (filled.kind === 'not_found') return notFound(ctx);
    if (filled.kind === 'busy') return unavailable(ctx, filled.retryAfterSeconds);
    if (filled.kind === 'upstream_error') {
      return fail(ctx, 502, 'bad_gateway', API_ERROR_CODES.bad_gateway.message);
    }
    if (filled.kind === 'serve' && filled.background !== undefined) {
      (deps.defer ?? deferOf(ctx))(filled.background);
    }
    if (resolved.kind === 'visible' && filled.kind === 'serve') {
      return { actor, pkg: resolved.pkg, stale: filled.stale };
    }
    const current = await deps.reresolve(ctx);
    if (
      current.kind !== 'visible' ||
      current.pkg.key !== parsed.key ||
      current.pkg.ecosystem !== 'npm' ||
      current.pkg.projectId !== actor.projectId
    ) {
      return notFound(ctx);
    }
    return { actor, pkg: current.pkg, stale: false };
  }

  function revalidating(response: Response, stale: boolean): Response {
    if (response.status === 200 || response.status === 304) {
      response.headers.set('Cache-Control', REVALIDATE);
      if (stale) response.headers.set('x-broker-stale', '1');
    }
    return response;
  }

  async function servePackage(ctx: RequestContext): Promise<Response> {
    const parsed = parseNpmPath(rawSegments(ctx));
    if (parsed.kind !== 'packument' && parsed.kind !== 'version' && parsed.kind !== 'tarball') {
      return notFound(ctx);
    }
    const read = await resolveForRead(ctx, parsed);
    if (read instanceof Response) return read;
    const { actor, pkg, stale } = read;
    const name = displayName(parsed.key);
    const projectSlug = ctx.params['project'] ?? '';
    const abbreviated = acceptsAbbreviated(ctx.request.headers.get('accept'));
    const options: NpmRenderOptions = {
      requestId: ctx.requestId,
      access: deps.access,
      actor,
      projectSlug,
      name,
      publicUrl: deps.publicUrl,
      abbreviated,
    };
    const uniform = async (response: Response) => {
      if (response.status !== 404) return response;
      await response.body?.cancel();
      return notFound(ctx);
    };
    if (parsed.kind === 'version') {
      return revalidating(
        await uniform(await renderVersionDocument(options, parsed.selector)),
        stale,
      );
    }
    if (parsed.kind === 'packument') {
      const validators = await npmValidators(
        pkg,
        abbreviated ? 'npm-abbreviated' : 'npm-full',
        NPM_RENDER_VERSION,
        { projectSlug, origin: deps.publicUrl },
      );
      if (isNotModified(ctx.request, validators))
        return revalidating(notModifiedResponse(validators, VARY), stale);
      const response = await uniform(await renderPackument(options));
      if (response.ok) response.headers.set('ETag', validators.etag);
      return revalidating(response, stale);
    }
    const found = await deps.access.version(actor, 'npm', name, parsed.version);
    if (found === null || (found.version.distType !== null && found.version.distType !== 'tgz')) {
      return notFound(ctx);
    }
    let served: Awaited<ReturnType<typeof deps.dist.serve>>;
    try {
      served = await deps.dist.serve(
        actor,
        {
          ecosystem: 'npm',
          key: parsed.key,
          versionId: found.version.versionId,
          revision: found.version.revision,
        },
        { signal: ctx.request.signal },
      );
    } catch (error) {
      if (ctx.request.signal.aborted) return new Response(null, { status: 499 });
      throw error;
    }
    if (served.kind === 'busy') return unavailable(ctx, served.retryAfterSeconds);
    if (served.kind === 'refused') {
      return fail(ctx, 502, 'bad_gateway', API_ERROR_CODES.bad_gateway.message);
    }
    if (served.kind === 'not_found') return notFound(ctx);
    if (ctx.request.method === 'HEAD') {
      await served.body.cancel();
      return new Response(null, { headers: served.headers });
    }
    return new Response(served.body, { headers: served.headers });
  }

  async function serveDistTags(ctx: RequestContext): Promise<Response> {
    const parsed = parseNpmPath(rawSegments(ctx));
    if (parsed.kind !== 'dist_tags') return notFound(ctx);
    const read = await resolveForRead(ctx, parsed);
    if (read instanceof Response) return read;
    const tags = await deps.access.distTags(read.actor, 'npm', displayName(parsed.key));
    if (tags === null) return notFound(ctx);
    if (!tags.pkg.listingComplete) return unavailable(ctx, 10);
    return ok(tags.tags);
  }

  function whoami(ctx: RequestContext): Response {
    const handle = deps.handleOf(ctx);
    return handle === null || handle.includes('@') ? notFound(ctx) : ok({ username: handle });
  }

  async function search(ctx: RequestContext): Promise<Response> {
    const actor = actorFor(ctx);
    if (actor === null) return unavailable(ctx, 10);
    const query = new URL(ctx.request.url).searchParams;
    const text = (query.get('text') ?? '').trim();
    const requested = Number(query.get('size'));
    const limit =
      Number.isSafeInteger(requested) && requested >= 1
        ? Math.min(requested, CATALOGUE_SEARCH_MAX)
        : SEARCH_DEFAULT;
    const found = text === '' ? [] : await deps.access.search(actor, 'npm', { text, limit });
    return ok({
      objects: found.map((item) => ({
        package: {
          name: displayName(item.key),
          ...(item.description === null ? {} : { description: item.description }),
        },
        score: { final: 0, detail: { quality: 0, popularity: 0, maintenance: 0 } },
        searchScore: 0,
      })),
      total: found.length,
      time: ctx.ports.clock.now().toISOString(),
    });
  }

  async function readAuditBody(ctx: RequestContext): Promise<Uint8Array> {
    const encoding = ctx.request.headers.get('content-encoding')?.trim().toLowerCase();
    const stream =
      encoding === 'gzip' && ctx.request.body !== null
        ? ctx.request.body.pipeThrough(deps.codecs.gunzip(AUDIT_BODY_MAX))
        : ctx.request.body;
    if (stream === null) return new Uint8Array();
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > AUDIT_BODY_MAX) throw new RangeError('Body exceeds limit');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  }

  async function audit(ctx: RequestContext): Promise<Response> {
    const encoding = ctx.request.headers.get('content-encoding')?.trim().toLowerCase();
    if (encoding && encoding !== 'identity' && encoding !== 'gzip') {
      return fail(
        ctx,
        415,
        'unsupported_media_type',
        API_ERROR_CODES.unsupported_media_type.message,
      );
    }
    const tooLarge = () =>
      fail(ctx, 413, 'payload_too_large', API_ERROR_CODES.payload_too_large.message);
    const invalid = () =>
      fail(ctx, 400, 'invalid_request', API_ERROR_CODES.invalid_request.message);
    try {
      const bytes = await readAuditBody(ctx);
      const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid();
      const entries = Object.entries(input);
      if (entries.length > CATALOGUE_WINNER_KEYS_MAX) return tooLarge();
      for (const [name, versions] of entries) {
        packageKey(name, { ecosystem: 'npm', legacyCase: true });
        if (!Array.isArray(versions) || !versions.every((v: unknown) => typeof v === 'string')) {
          return invalid();
        }
      }
      return jsonResponse(200, {});
    } catch (error) {
      return error instanceof RangeError || error instanceof CodecLimitError
        ? tooLarge()
        : invalid();
    }
  }

  function methodNotAllowed(ctx: RequestContext): Response {
    return fail(ctx, 405, 'method_not_allowed', 'Method not allowed', { Allow: 'GET, HEAD' });
  }

  const shapes = [['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']] as const;
  const pathOf = (names: readonly string[]) =>
    `/:project/npm/${names.map((n) => `:${n}`).join('/')}`;
  const routes: RouteDefinition[] = [
    {
      method: 'GET',
      path: '/:project/npm/-/whoami',
      permission: 'project:read',
      boundary: 'project',
      handler: whoami,
    },
    {
      method: 'GET',
      path: '/:project/npm/-/ping',
      permission: 'project:read',
      boundary: 'project',
      handler: () => jsonResponse(200, {}),
    },
    {
      method: 'GET',
      path: '/:project/npm/-/v1/search',
      permission: READ,
      boundary: 'project',
      handler: search,
    },
    {
      method: 'POST',
      path: '/:project/npm/-/npm/v1/security/advisories/bulk',
      permission: READ,
      boundary: 'project',
      handler: audit,
    },
    {
      method: 'GET',
      path: '/:project/npm/-/package/:a/dist-tags',
      permission: READ,
      boundary: 'package',
      package: { ecosystem: 'npm', name: distTagsName },
      handler: serveDistTags,
    },
  ];
  for (const names of shapes) {
    routes.push({
      method: 'GET',
      path: pathOf(names),
      permission: READ,
      boundary: 'package',
      package: {
        ecosystem: 'npm',
        name: (params) => nameFrom(params, names),
        fetchOnAdmission: true,
      },
      handler: servePackage,
    });
    for (const method of ['PUT', 'POST', 'DELETE'] as const) {
      routes.push({
        method,
        path: pathOf(names),
        permission: READ,
        boundary: 'project',
        handler: methodNotAllowed,
      });
    }
  }
  return routes;
}
