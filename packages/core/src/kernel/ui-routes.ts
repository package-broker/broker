import type { StaticAssets } from '../platform/assets.js';
import type { RequestContext, RouteDefinition } from '../plugin.js';
import { defaultLog, envelopeResponse, type KernelLog } from './errors.js';

export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; require-trusted-types-for 'script'";

const UI_PATH = '/_pb/ui';
const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const HSTS = 'max-age=31536000';
const CONTENT_HASH = /\.[0-9a-f]{12}\./;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STRONG_ETAG_LIST =
  /^"[\x21\x23-\x7e\x80-\xff]*"(?:[ \t]*,[ \t]*"[\x21\x23-\x7e\x80-\xff]*")*$/;

function matchesEtag(validator: string | null, etag: string): boolean {
  if (validator === null || !STRONG_ETAG_LIST.test(validator)) return false;
  return Array.from(validator.matchAll(/"[^"]*"/g)).some(([value]) => value === etag);
}

export interface UiRouteOptions {
  readonly publicOrigin: string;
  readonly log?: KernelLog;
}

function accepts(accept: string, types: readonly string[]): number {
  let best = 0;
  for (const part of accept.split(',')) {
    const [range = '', ...params] = part.split(';').map((piece) => piece.trim().toLowerCase());
    if (!types.includes(range)) continue;
    const q = params.find((param) => param.startsWith('q='));
    const value = q === undefined ? 1 : Number(q.slice(2));
    if (Number.isFinite(value) && value >= 0 && value <= 1 && value > best) best = value;
  }
  return best;
}

function prefersHtml(request: Request): boolean {
  const accept = request.headers.get('accept');
  if (accept === null) return false;
  const html = accepts(accept, ['text/html']);
  return html > 0 && html > accepts(accept, ['application/json', 'application/*', '*/*']);
}

function isSafeFileName(name: string): boolean {
  return SAFE_FILE_NAME.test(name) && !name.includes('..');
}

/** For `GET /`: a 303 to the UI when Accept prefers HTML, otherwise null so the existing response stands. */
export function uiRootRedirect(request: Request): Response | null {
  if (!prefersHtml(request)) return null;
  return new Response(null, {
    status: 303,
    headers: { location: UI_PATH, 'cache-control': 'no-store', vary: 'Accept' },
  });
}

export function createUiRoutes(
  assets: StaticAssets,
  options: UiRouteOptions,
): readonly RouteDefinition[] {
  const log = options.log ?? defaultLog;
  const hsts = new URL(options.publicOrigin).protocol === 'https:';

  function secured(response: Response): Response {
    response.headers.set('content-security-policy', UI_CSP);
    response.headers.set('cross-origin-opener-policy', 'same-origin');
    response.headers.set('x-content-type-options', 'nosniff');
    response.headers.set('referrer-policy', 'same-origin');
    if (hsts) response.headers.set('strict-transport-security', HSTS);
    return response;
  }

  function notFound(requestId: string): Response {
    return secured(envelopeResponse(404, 'not_found', 'Route not found', requestId));
  }

  async function serve(
    request: Request,
    requestId: string,
    name: string | null,
  ): Promise<Response> {
    const manifest = await assets.manifest();
    if (manifest === null) return notFound(requestId);
    const file = name ?? manifest.entry;
    if (!Object.hasOwn(manifest.files, file) || !isSafeFileName(file)) return notFound(requestId);
    if (name !== null && name === manifest.entry) return notFound(requestId);
    const asset = await assets.read(file);
    if (asset === null) return notFound(requestId);
    const expectedType = manifest.files[file]!.contentType;
    if (asset.contentType !== expectedType) {
      log({ level: 'warn', event: 'ui.asset_type_mismatch', file });
      return notFound(requestId);
    }
    const body = await new Response(
      asset.body as ConstructorParameters<typeof Response>[0],
    ).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
    const etag = `"${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}"`;
    const contentType = expectedType === 'text/html' ? 'text/html; charset=utf-8' : expectedType;
    const headers = new Headers({
      etag,
      'content-type': contentType,
      'cache-control': name !== null && CONTENT_HASH.test(file) ? IMMUTABLE : NO_CACHE,
      'x-request-id': requestId,
    });
    if (matchesEtag(request.headers.get('if-none-match'), etag)) {
      return secured(new Response(null, { status: 304, headers }));
    }
    headers.set('content-length', String(body.byteLength));
    return secured(
      new Response(body, {
        status: 200,
        headers,
      }),
    );
  }

  return Object.freeze([
    Object.freeze({
      method: 'GET',
      path: UI_PATH,
      permission: null,
      needsOrg: false,
      handler: (ctx: RequestContext) => serve(ctx.request, ctx.requestId, null),
    }),
    Object.freeze({
      method: 'GET',
      path: `${UI_PATH}/assets/:file`,
      permission: null,
      needsOrg: false,
      handler: (ctx: RequestContext) => serve(ctx.request, ctx.requestId, ctx.params['file'] ?? ''),
    }),
  ] satisfies RouteDefinition[]);
}
