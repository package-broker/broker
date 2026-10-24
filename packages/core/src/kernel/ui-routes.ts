import { parsePublicOrigin } from './public-origin.js';
import type { StaticAssets, UiManifest } from '../platform/assets.js';
import type { RequestContext, RouteDefinition } from '../plugin.js';
import { defaultLog, envelopeResponse, type KernelLog } from './errors.js';

export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; require-trusted-types-for 'script'";

const UI_PATH = '/_pb/ui';
export const SETUP_UI_PATH = `${UI_PATH}/setup`;
export const SETUP_DOCUMENT_ROUTE = `${UI_PATH}/setup/document`;
const SETUP_REWRITE_HEADER = 'x-pb-setup-ui';
let setupRewriteKey: string | undefined;
const rewriteKey = (): string => (setupRewriteKey ??= crypto.randomUUID());
export const SETUP_ASSET_PREFIX = `${UI_PATH}/setup/assets/`;
const SETUP_DOCUMENT = 'setup.html';
const SETUP_ASSET_TYPES: ReadonlySet<string> = new Set(['text/javascript', 'text/css']);
const SETUP_REFERENCE = /<(?:script|link)\b[^>]*?\s(?:src|href)="([^"]*)"/gi;
const NO_STORE = 'no-store';
const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const HSTS = 'max-age=31536000; includeSubDomains';
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

/**
 * The kernel refuses a literal route that overlaps `/_pb/ui/:file`, so the public setup URL is
 * rewritten to an internal route. The rewrite is marked with a per-process secret, which keeps the
 * internal route unreachable to a client that requests it directly.
 */
export function rewriteSetupRequest(request: Request): Request | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (url.pathname !== SETUP_UI_PATH) return null;
  url.pathname = SETUP_DOCUMENT_ROUTE;
  const headers = new Headers(request.headers);
  headers.set(SETUP_REWRITE_HEADER, rewriteKey());
  return new Request(url, { method: request.method, headers });
}

/** For `GET /`: a 303 to the UI when Accept prefers HTML, otherwise null so the existing response stands. */
export function uiRootRedirect(request: Request): Response | null {
  if (!prefersHtml(request)) return null;
  return new Response(null, {
    status: 303,
    headers: { location: UI_PATH, 'cache-control': 'no-store', vary: 'Accept' },
  });
}

function createRoutes(
  assets: StaticAssets,
  options: UiRouteOptions,
): { readonly ui: readonly RouteDefinition[]; readonly setup: readonly RouteDefinition[] } {
  const log = options.log ?? defaultLog;
  const hsts = parsePublicOrigin(options.publicOrigin, { http: 'allow' }).startsWith('https:');

  function secured(response: Response): Response {
    response.headers.set('content-security-policy', UI_CSP);
    response.headers.set('cross-origin-opener-policy', 'same-origin');
    response.headers.set('x-content-type-options', 'nosniff');
    response.headers.set('referrer-policy', 'no-referrer');
    if (hsts) response.headers.set('strict-transport-security', HSTS);
    return response;
  }

  function notFound(requestId: string): Response {
    return secured(envelopeResponse(404, 'not_found', 'Route not found', requestId));
  }

  async function deliver(
    request: Request,
    requestId: string,
    manifest: UiManifest,
    file: string,
    cacheControl: string,
    harden?: (response: Response) => Response,
  ): Promise<Response> {
    const finish = (response: Response): Response => (harden ?? secured)(secured(response));
    const absent = (): Response =>
      finish(envelopeResponse(404, 'not_found', 'Route not found', requestId));
    const asset = await assets.read(file);
    if (asset === null) return absent();
    const expectedType = manifest.files[file]!.contentType;
    if (asset.contentType !== expectedType) {
      log({ level: 'warn', event: 'ui.asset_type_mismatch', file });
      return absent();
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
      // Preserve the bytes used for the ETag and length through Workers compression negotiation.
      'content-encoding': 'identity',
      'cache-control': cacheControl,
      'x-request-id': requestId,
    });
    if (matchesEtag(request.headers.get('if-none-match'), etag)) {
      return finish(new Response(null, { status: 304, headers }));
    }
    headers.set('content-length', String(body.byteLength));
    return finish(new Response(body, { status: 200, headers }));
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
    return deliver(
      request,
      requestId,
      manifest,
      file,
      name !== null && CONTENT_HASH.test(file) ? IMMUTABLE : NO_CACHE,
    );
  }

  const setupHeaders = (response: Response): Response => {
    response.headers.set('referrer-policy', 'no-referrer');
    return response;
  };

  /** The files the setup document itself references, or null when the document is not usable. */
  async function setupAllowlist(manifest: UiManifest): Promise<ReadonlySet<string> | null> {
    const descriptor = Object.hasOwn(manifest.files, SETUP_DOCUMENT)
      ? manifest.files[SETUP_DOCUMENT]
      : undefined;
    if (descriptor?.contentType !== 'text/html' || manifest.entry === SETUP_DOCUMENT) return null;
    const document = await assets.read(SETUP_DOCUMENT);
    if (document === null || document.contentType !== 'text/html') return null;
    const text = await new Response(
      document.body as ConstructorParameters<typeof Response>[0],
    ).text();
    const allowed = new Set<string>();
    for (const [, reference] of text.matchAll(SETUP_REFERENCE)) {
      if (reference === undefined || !reference.startsWith(SETUP_ASSET_PREFIX)) return null;
      const name = reference.slice(SETUP_ASSET_PREFIX.length);
      const listed = Object.hasOwn(manifest.files, name) ? manifest.files[name] : undefined;
      if (
        !isSafeFileName(name) ||
        name === manifest.entry ||
        name === SETUP_DOCUMENT ||
        name === 'manifest.json' ||
        listed === undefined ||
        !SETUP_ASSET_TYPES.has(listed.contentType)
      ) {
        return null;
      }
      allowed.add(name);
    }
    return allowed;
  }

  async function serveSetupDocument(request: Request, requestId: string): Promise<Response> {
    if (request.headers.get(SETUP_REWRITE_HEADER) !== rewriteKey()) return notFound(requestId);
    const manifest = await assets.manifest();
    if (manifest === null || (await setupAllowlist(manifest)) === null) return notFound(requestId);
    return deliver(request, requestId, manifest, SETUP_DOCUMENT, NO_STORE, setupHeaders);
  }

  async function serveSetupAsset(
    request: Request,
    requestId: string,
    name: string,
  ): Promise<Response> {
    const manifest = await assets.manifest();
    const allowed = manifest === null ? null : await setupAllowlist(manifest);
    if (manifest === null || allowed === null || !allowed.has(name)) return notFound(requestId);
    return deliver(
      request,
      requestId,
      manifest,
      name,
      CONTENT_HASH.test(name) ? IMMUTABLE : NO_CACHE,
      setupHeaders,
    );
  }

  const setup = Object.freeze([
    Object.freeze({
      method: 'GET',
      path: SETUP_DOCUMENT_ROUTE,
      permission: null,
      needsOrg: false,
      handler: (ctx: RequestContext) => serveSetupDocument(ctx.request, ctx.requestId),
    }),
    Object.freeze({
      method: 'GET',
      path: `${SETUP_ASSET_PREFIX}:file`,
      permission: null,
      needsOrg: false,
      handler: (ctx: RequestContext) =>
        serveSetupAsset(ctx.request, ctx.requestId, ctx.params['file'] ?? ''),
    }),
  ] satisfies RouteDefinition[]);

  const ui = Object.freeze([
    Object.freeze({
      method: 'GET',
      path: UI_PATH,
      permission: null,
      needsOrg: false,
      async handler(ctx: RequestContext) {
        const response = await serve(ctx.request, ctx.requestId, null);
        if (response.status !== 200) return response;
        const url = new URL(ctx.request.url);
        return secured(
          new Response(null, {
            status: 303,
            headers: {
              location: `${UI_PATH}/${url.search}`,
              'cache-control': NO_STORE,
              'x-request-id': ctx.requestId,
            },
          }),
        );
      },
    }),
    Object.freeze({
      method: 'GET',
      path: `${UI_PATH}/`,
      permission: null,
      needsOrg: false,
      handler: (ctx: RequestContext) => serve(ctx.request, ctx.requestId, null),
    }),
    Object.freeze({
      method: 'GET',
      path: `${UI_PATH}/:file`,
      permission: null,
      needsOrg: false,
      handler: (ctx: RequestContext) => serve(ctx.request, ctx.requestId, ctx.params['file'] ?? ''),
    }),
  ] satisfies RouteDefinition[]);
  return { ui, setup };
}

/** Public, visitor-independent document and manifest-listed assets; bypasses session authorization. */
export function createUiRoutes(
  assets: StaticAssets,
  options: UiRouteOptions,
): readonly RouteDefinition[] {
  return createRoutes(assets, options).ui;
}

/**
 * The public first-admin setup document and the scripts and styles it references. Mount these
 * before the routes from createUiRoutes; they carry no boundary because the one-time setup token
 * on the existing POST routes is the only authority.
 */
export function createSetupUiRoutes(
  assets: StaticAssets,
  options: UiRouteOptions,
): readonly RouteDefinition[] {
  return createRoutes(assets, options).setup;
}
