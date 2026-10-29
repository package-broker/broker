import { UPSTREAM_FETCH_EVENT, type Observability } from '../platform/observability.js';
import { childSpan, tracedFetch, type FetchLike, type SpanContext } from '../platform/tracing.js';
import { classifyUrl, type OutboundPolicy } from './url-policy.js';

export const GITHUB_API_VERSION = '2022-11-28';

const MAX_REDIRECTS = 5;
const MAX_REQUEST_BODY = 1024 * 1024;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PATCH']);
const GIT_CONTENT_TYPE = 'application/x-git-upload-pack-request';
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding'] as const;
const BARE_ORIGIN = /^https?:\/\/[^/?#@\\]+$/i;

export type UpstreamPurpose = 'metadata' | 'archive' | 'git' | 'api';
export type UpstreamErrorCode = 'refused' | 'timeout' | 'too_large' | 'http_status' | 'network';

export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode;
  readonly status: number | undefined;
  readonly reason: string | undefined;

  constructor(code: UpstreamErrorCode, status?: number, reason?: string) {
    super(reason === undefined ? `upstream ${code}` : `upstream ${code}: ${reason}`);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

export interface UpstreamCredential {
  readonly origins: readonly string[];
  /** Query parameter names the credential carries; empty when it uses headers only. */
  readonly queryParams: readonly string[];
  /** May change headers and query parameters only. */
  apply(headers: Headers, url: URL): { readonly headers: Headers; readonly url: URL };
}

export interface UpstreamRequest {
  readonly url: string;
  readonly method: 'GET' | 'HEAD' | 'POST' | 'PATCH';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly credential?: UpstreamCredential;
  readonly destinations?: readonly string[];
  readonly redirects?: 'follow' | 'error';
  readonly purpose: UpstreamPurpose;
  readonly maxBytes: number;
  /** Total budget including body streaming; fetch has no connect hook. */
  readonly timeoutMs: number;
  /** Per-hop budget until response headers arrive; defaults to min(timeoutMs, 30000). */
  readonly headersTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly redirected?: boolean;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface PolicyFetchOptions {
  readonly fetchImpl: FetchLike;
  readonly policy: OutboundPolicy;
  readonly userAgent: string;
  readonly observability?: Observability;
  readonly span?: SpanContext;
  readonly sourceId?: string;
}

export type PolicyFetch = (request: UpstreamRequest) => Promise<UpstreamResponse>;

type HeaderCheck = (value: string) => boolean;

const anyValue: HeaderCheck = () => true;
const commonHeaders: readonly (readonly [string, HeaderCheck])[] = [
  ['accept', anyValue],
  ['if-none-match', anyValue],
  ['if-modified-since', anyValue],
];

const PURPOSE_HEADERS: ReadonlyMap<string, ReadonlyMap<string, HeaderCheck>> = new Map([
  ['metadata', new Map(commonHeaders)],
  ['archive', new Map(commonHeaders)],
  [
    'git',
    new Map<string, HeaderCheck>([
      ...commonHeaders,
      ['git-protocol', (value) => value === 'version=2'],
      ['content-type', (value) => value === GIT_CONTENT_TYPE],
    ]),
  ],
  [
    'api',
    new Map<string, HeaderCheck>([
      ...commonHeaders,
      ['x-github-api-version', (value) => value === GITHUB_API_VERSION],
      ['content-type', (value) => value === 'application/json'],
    ]),
  ],
]);

const refuse = (reason: string): UpstreamError => new UpstreamError('refused', undefined, reason);

export const UPSTREAM_REFUSAL_REASON_CODES = [
  'invalid_url',
  'scheme',
  'userinfo',
  'port',
  'zone_id',
  'blocked_address',
  'blocked_host',
  'self_origin',
  'invalid_address',
  'origin',
  'header',
  'request',
  'limit',
  'body',
  'downgrade',
  'destination',
  'credential',
  'redirect_refused',
  'opaque_redirect',
  'redirect_limit',
  'redirect_status',
  'unknown',
].map((reason) => `upstream.${reason}`);

const REFUSAL_REASONS = new Set(UPSTREAM_REFUSAL_REASON_CODES);

const GUARD_REFUSED = new Set([
  'invalid_url',
  'scheme',
  'userinfo',
  'port',
  'zone_id',
  'blocked_address',
  'blocked_host',
  'self_origin',
  'invalid_address',
]);
const GUARD_NETWORK = new Set(['resolution_failed', 'no_address', 'aborted']);

function guardFailure(error: unknown): UpstreamError | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (!(cause instanceof Error) || cause.name !== 'DnsGuardError') return undefined;
  const reason = (cause as Error & { reason?: unknown }).reason;
  if (typeof reason === 'string' && GUARD_REFUSED.has(reason)) return refuse(reason);
  if (reason === 'resolution_timeout') return new UpstreamError('timeout');
  if (typeof reason === 'string' && GUARD_NETWORK.has(reason)) return undefined;
  return new UpstreamError('network');
}

function canonicalOrigin(text: string): string {
  if (typeof text !== 'string' || !BARE_ORIGIN.test(text.trim())) throw refuse('origin');
  try {
    const url = new URL(text.trim());
    return `${url.protocol}//${url.host}`;
  } catch {
    throw refuse('origin');
  }
}

function validateHeaders(
  request: UpstreamRequest,
  allowed: ReadonlyMap<string, HeaderCheck>,
): Headers {
  const out = new Headers();
  for (const [rawName, value] of Object.entries(request.headers ?? {})) {
    const name = rawName.toLowerCase();
    const check = allowed.get(name);
    if (check === undefined) continue;
    if (typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value) || !check(value)) {
      throw refuse('header');
    }
    out.set(name, value);
  }
  return out;
}

function queryName(pair: string): string {
  const raw = pair.split('=', 1)[0] ?? '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

function stripQuery(url: URL, names: ReadonlySet<string>): void {
  if (names.size === 0 || url.search === '') return;
  const pairs = url.search.slice(1).split('&');
  const kept = pairs.filter((pair) => !names.has(queryName(pair)));
  if (kept.length === pairs.length) return;
  url.search = kept.join('&');
}

function changedQueryNames(before: URL, after: URL): string[] {
  const changed: string[] = [];
  for (const name of new Set(after.searchParams.keys())) {
    const was = before.searchParams.getAll(name);
    const now = after.searchParams.getAll(name);
    if (was.length !== now.length || was.some((value, i) => value !== now[i])) changed.push(name);
  }
  return changed;
}

interface Tracking {
  readonly hop: (url: URL, redirects: number) => void;
  readonly refusedHop: () => void;
  readonly response: (status?: number) => void;
  readonly arrived: (status: number) => void;
  readonly bodyFailed: (code: string) => void;
}

function countedBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  failure: () => UpstreamError,
  tracking: Tracking,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => undefined);
          tracking.bodyFailed('too_large');
          controller.error(new UpstreamError('too_large'));
          return;
        }
        controller.enqueue(value);
      } catch {
        const error = failure();
        tracking.bodyFailed(error.code);
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

export function createPolicyFetch(options: PolicyFetchOptions): PolicyFetch {
  const { fetchImpl, policy, userAgent, observability, span } = options;

  async function run(
    request: UpstreamRequest,
    tracking: Tracking,
    child: SpanContext,
  ): Promise<UpstreamResponse> {
    const allowed = PURPOSE_HEADERS.get(request.purpose);
    if (
      allowed === undefined ||
      !METHODS.has(request.method) ||
      (request.method === 'PATCH' && (request.purpose !== 'api' || request.redirects !== 'error'))
    )
      throw refuse('request');
    if (
      request.redirects !== undefined &&
      request.redirects !== 'follow' &&
      request.redirects !== 'error'
    ) {
      throw refuse('request');
    }
    if (!Number.isFinite(request.maxBytes) || request.maxBytes <= 0) throw refuse('limit');
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw refuse('limit');
    const headersTimeoutMs = request.headersTimeoutMs ?? Math.min(request.timeoutMs, 30000);
    if (!Number.isFinite(headersTimeoutMs) || headersTimeoutMs <= 0) throw refuse('limit');
    if (request.body !== undefined) {
      if (
        (request.method !== 'POST' && request.method !== 'PATCH') ||
        request.body.byteLength > MAX_REQUEST_BODY
      ) {
        throw refuse('body');
      }
    }
    const baseHeaders = validateHeaders(request, allowed);
    const destinations = request.destinations?.map(canonicalOrigin);
    const bound = request.credential?.origins.map(canonicalOrigin) ?? [];
    const total = AbortSignal.timeout(request.timeoutMs);
    const send = tracedFetch(fetchImpl, child);

    let current: URL;
    try {
      current = new URL(request.url);
    } catch {
      throw refuse('invalid_url');
    }
    let method = request.method;
    let body = request.body;
    const stripped = new Set<string>();
    let previousOrigin: string | undefined;
    let previousProtocol: string | undefined;
    let crossOrigin = false;
    let tainted = false;

    for (let redirects = 0; ; redirects++) {
      const verdict = classifyUrl(current.href, policy);
      if (!verdict.ok) throw refuse(verdict.reason);
      if (previousProtocol === 'https:' && current.protocol === 'http:') throw refuse('downgrade');
      const origin = current.origin;
      if (destinations !== undefined && !destinations.includes(origin)) throw refuse('destination');
      if (previousOrigin !== undefined && origin !== previousOrigin) crossOrigin = true;
      if (!bound.includes(origin)) tainted = true;

      let headers = crossOrigin ? new Headers() : new Headers(baseHeaders);
      let target = current;
      if (request.credential !== undefined && !tainted) {
        const applied = request.credential.apply(new Headers(headers), new URL(current));
        headers = applied.headers;
        target = new URL(applied.url);
        if (
          target.origin !== current.origin ||
          target.pathname !== current.pathname ||
          target.hash !== current.hash ||
          target.username !== '' ||
          target.password !== ''
        ) {
          throw refuse('credential');
        }
        for (const name of changedQueryNames(current, target)) stripped.add(name);
        for (const name of request.credential.queryParams) stripped.add(name);
        if (redirects > 0) stripQuery(target, stripped);
      }
      tracking.hop(current, redirects);
      headers.set('user-agent', userAgent);

      const hop = new AbortController();
      const timer = setTimeout(() => hop.abort(), headersTimeoutMs);
      const signal = AbortSignal.any([
        total,
        hop.signal,
        ...(request.signal ? [request.signal] : []),
      ]);
      const failure = (): UpstreamError =>
        request.signal?.aborted
          ? new UpstreamError('network', undefined, 'aborted')
          : new UpstreamError(signal.aborted ? 'timeout' : 'network');

      let response: Response;
      try {
        response = await send(target.href, {
          method,
          headers,
          redirect: 'manual',
          signal,
          ...(body !== undefined ? { body } : {}),
        });
      } catch (error) {
        const guarded = guardFailure(error);
        if (guarded?.code === 'refused') tracking.refusedHop();
        throw guarded ?? failure();
      } finally {
        clearTimeout(timer);
      }

      tracking.response(response.status);
      if (response.status === 0 || response.type === 'opaqueredirect') {
        discard(response);
        throw refuse(request.redirects === 'error' ? 'redirect_refused' : 'opaque_redirect');
      }
      if (
        request.redirects === 'error' &&
        response.status >= 300 &&
        response.status < 400 &&
        response.status !== 304 &&
        response.headers.has('location')
      ) {
        discard(response);
        throw refuse('redirect_refused');
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        discard(response);
        const location = response.headers.get('location');
        if (location === null || location === '') {
          throw new UpstreamError('http_status', response.status);
        }
        if (redirects >= MAX_REDIRECTS) throw refuse('redirect_limit');
        tracking.response();
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw refuse('invalid_url');
        }
        stripQuery(next, stripped);
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === 'POST')
        ) {
          if (method !== 'HEAD') method = 'GET';
          body = undefined;
          for (const name of BODY_HEADERS) baseHeaders.delete(name);
        }
        previousOrigin = origin;
        previousProtocol = current.protocol;
        current = next;
        continue;
      }
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        discard(response);
        throw refuse('redirect_status');
      }

      const bodyless = method === 'HEAD' || response.status === 204 || response.status === 304;
      const declared = response.headers.get('content-length');
      if (
        !bodyless &&
        response.status >= 200 &&
        response.status < 300 &&
        declared !== null &&
        /^\d+$/.test(declared) &&
        Number(declared) > request.maxBytes
      ) {
        discard(response);
        throw new UpstreamError('too_large');
      }
      tracking.arrived(response.status);
      return {
        status: response.status,
        redirected: redirects > 0,
        headers: response.headers,
        body:
          response.body === null
            ? null
            : countedBody(response.body, request.maxBytes, failure, tracking),
      };
    }
  }

  return async (request) => {
    const kind =
      typeof request?.purpose === 'string' && PURPOSE_HEADERS.has(request.purpose)
        ? request.purpose
        : 'unknown';
    const started = Date.now();
    let arrived = false;
    const child = childSpan(span ?? null);
    let origin: string | undefined;
    let redirects = 0;
    let crossOrigin = false;
    let status: number | undefined;
    let outcome: string | undefined;
    const emit = (outcome: string, statusClass?: string): void => {
      const labels = { kind, outcome, ...(statusClass ? { status_class: statusClass } : {}) };
      observability?.counter('pb.upstream.requests', labels);
      observability?.histogram('pb.upstream.duration_ms', Date.now() - started, labels);
    };
    let beforeHop = { redirects, crossOrigin };
    const tracking: Tracking = {
      hop(url, count) {
        beforeHop = { redirects, crossOrigin };
        redirects = count;
        origin ??= url.origin;
        if (origin !== undefined && url.origin !== origin) crossOrigin = true;
      },
      refusedHop() {
        if (redirects === 0) origin = undefined;
        ({ redirects, crossOrigin } = beforeHop);
      },
      response(value) {
        status = value !== undefined && value >= 100 && value <= 599 ? value : undefined;
      },
      arrived(status) {
        arrived = true;
        emit('ok', `${Math.trunc(status / 100)}xx`);
      },
      bodyFailed(code) {
        emit(`body_${code}`);
      },
    };
    try {
      return await run(request, tracking, child);
    } catch (error) {
      const known = error instanceof UpstreamError ? error : new UpstreamError('network');
      outcome =
        known.code === 'refused'
          ? REFUSAL_REASONS.has(`upstream.${known.reason}`)
            ? `upstream.${known.reason}`
            : 'upstream.unknown'
          : known.code;
      if (!arrived) {
        emit(known.code);
        if (known.code === 'refused') {
          const reason = `upstream.${known.reason}`;
          observability?.log({
            level: 'debug',
            event: 'upstream.refused',
            reason_code: REFUSAL_REASONS.has(reason) ? reason : 'upstream.unknown',
            ...(options.sourceId === undefined ? {} : { source_id: options.sourceId }),
          });
        }
      }
      throw known;
    } finally {
      observability?.log({
        level: 'debug',
        event: UPSTREAM_FETCH_EVENT,
        upstream_span_id: child.spanId,
        ...(span === undefined
          ? {}
          : {
              upstream_trace_id: child.traceId,
              upstream_parent_span_id: span.spanId,
            }),
        ...(origin === undefined ? {} : { upstream_origin: origin }),
        ...(METHODS.has(request.method) ? { upstream_method: request.method } : {}),
        ...(status === undefined ? {} : { status }),
        redirects,
        cross_origin: crossOrigin,
        duration_ms: Date.now() - started,
        ...(outcome === undefined ? {} : { outcome }),
      });
    }
  };
}
