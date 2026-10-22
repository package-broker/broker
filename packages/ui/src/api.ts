const CSRF_COOKIE = '__Host-pb_csrf';
const API_PREFIX = '/_pb/';
const MAX_DETAILS = 20;

const API_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'reauth_required',
  'not_found',
  'conflict',
  'duplicate',
  'last_holder',
  'idempotency_mismatch',
  'already_issued',
  'not_approved',
  'precondition_failed',
  'precondition_required',
  'payload_too_large',
  'unsupported_media_type',
  'unavailable',
] as const;

const DETAIL_CODES = [
  'invalid_type',
  'too_small',
  'too_big',
  'invalid_format',
  'invalid_value',
  'unrecognized_keys',
  'invalid_union',
  'invalid',
  'invalid_json',
  'invalid_encoding',
  'too_deep',
] as const;

const DETAIL_LOCATIONS = ['params', 'query', 'body'] as const;

export type ApiErrorCode =
  (typeof API_ERROR_CODES)[number] | 'unknown_error' | 'network_error' | 'refused_url';

export interface ApiErrorDetail {
  path: string;
  code: (typeof DETAIL_CODES)[number];
  location?: (typeof DETAIL_LOCATIONS)[number];
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

type QueryValue = string | number | boolean | readonly (string | number | boolean)[];

export interface ApiRequestDescription {
  method: string;
  path: string;
  query?: Record<string, QueryValue | undefined>;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  body?: unknown;
}

export interface ApiResponseHeaders {
  etag?: string;
  location?: string;
}

export type ApiResult<Data> =
  | { ok: true; status: number; data: Data; headers?: ApiResponseHeaders }
  | {
      ok: false;
      status: number;
      code: ApiErrorCode;
      details: ApiErrorDetail[];
      request: ApiRequestDescription;
    };

export function responseHeader<Data>(
  result: ApiResult<Data>,
  name: keyof ApiResponseHeaders,
): string | undefined {
  return result.ok ? result.headers?.[name] : undefined;
}

export interface ApiClientDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  readCookie: (name: string) => string | undefined;
}

type PathsFor<P, M extends HttpMethod> = {
  [K in keyof P]: [NonNullable<P[K][M & keyof P[K]]>] extends [never] ? never : K;
}[keyof P] &
  string;

type OperationOf<P, K extends keyof P, M extends HttpMethod> = NonNullable<P[K][M & keyof P[K]]>;

type Section<O, K extends string> = O extends { parameters: infer Q }
  ? K extends keyof Q
    ? NonNullable<Q[K]>
    : never
  : never;

type Field<Name extends string, T> = [T] extends [never]
  ? unknown
  : object extends T
    ? { [N in Name]?: T }
    : { [N in Name]: T };

type BodyOf<O> = O extends { requestBody: { content: { 'application/json': infer B } } }
  ? { body: B }
  : unknown;

type OptionalKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

type Loosen<T> = [T] extends [never]
  ? never
  : { [K in OptionalKeys<T>]?: T[K] | undefined } & {
      [K in Exclude<keyof T, OptionalKeys<T>>]: T[K];
    };

type HeaderSection<O> = [Section<O, 'header'>] extends [never]
  ? never
  : Omit<Section<O, 'header'>, 'Idempotency-Key'>;

type RequestInitOf<O> = Field<'params', Section<O, 'path'>> &
  Field<'query', Loosen<Section<O, 'query'>>> &
  Field<'headers', HeaderSection<O>> &
  BodyOf<O> & { idempotencyKey?: string };

type DataOf<Response> = Response extends { content: { 'application/json': infer J } }
  ? J
  : undefined;

type SuccessData<O> = O extends { responses: infer R }
  ? DataOf<R[keyof R & (200 | 201 | 202 | 203 | 204 | 206)]>
  : undefined;

type RequestArgs<I> = object extends I ? [init?: I] : [init: I];

export interface ApiClient<P> {
  request<M extends HttpMethod, K extends PathsFor<P, M>>(
    method: M,
    path: K,
    ...args: RequestArgs<RequestInitOf<OperationOf<P, K, M>>>
  ): Promise<ApiResult<SuccessData<OperationOf<P, K, M>>>>;
}

interface LooseInit {
  params?: Record<string, string | number>;
  query?: Record<string, QueryValue | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function hasDotSegment(path: string): boolean {
  return path.split('/').some((segment) => {
    const decoded = segment.replace(/%2e/gi, '.');
    return decoded === '.' || decoded === '..';
  });
}

function buildPath(template: string, init: LooseInit): string | undefined {
  if (!template.startsWith(API_PREFIX)) return undefined;
  let filled: string;
  try {
    let refused = false;
    filled = template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const value = init.params?.[name];
      if (value === undefined) {
        refused = true;
        return '';
      }
      return encodeURIComponent(String(value));
    });
    if (refused) return undefined;
  } catch {
    return undefined;
  }
  if (!filled.startsWith(API_PREFIX) || /[{}?#\\]/.test(filled) || hasDotSegment(filled)) {
    return undefined;
  }
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(init.query ?? {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(name, String(item));
  }
  const search = query.toString();
  return search === '' ? filled : `${filled}?${search}`;
}

function parseDetails(value: unknown): ApiErrorDetail[] {
  if (!Array.isArray(value)) return [];
  const details: ApiErrorDetail[] = [];
  for (const entry of value) {
    if (details.length === MAX_DETAILS) break;
    if (!isRecord(entry) || typeof entry.path !== 'string' || !includes(DETAIL_CODES, entry.code)) {
      continue;
    }
    details.push({
      path: entry.path,
      code: entry.code,
      ...(includes(DETAIL_LOCATIONS, entry.location) ? { location: entry.location } : {}),
    });
  }
  return details;
}

async function readFailure(
  response: Response,
): Promise<{ code: ApiErrorCode; details: ApiErrorDetail[] }> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { code: 'unknown_error', details: [] };
  }
  const error = isRecord(parsed) ? parsed.error : undefined;
  if (!isRecord(error) || !includes(API_ERROR_CODES, error.code)) {
    return { code: 'unknown_error', details: [] };
  }
  return { code: error.code, details: parseDetails(error.details) };
}

export function createApiClient<P>(deps: ApiClientDeps): ApiClient<P> {
  async function perform(
    method: string,
    template: string,
    init: LooseInit,
  ): Promise<ApiResult<unknown>> {
    const upper = method.toUpperCase();
    const description: ApiRequestDescription = {
      method: upper,
      path: template,
      ...(init.query === undefined ? {} : { query: init.query }),
      ...(init.headers === undefined ? {} : { headers: { ...init.headers } }),
      ...(init.idempotencyKey === undefined ? {} : { idempotencyKey: init.idempotencyKey }),
      ...(init.body === undefined ? {} : { body: init.body }),
    };
    const fail = (
      status: number,
      code: ApiErrorCode,
      details: ApiErrorDetail[] = [],
    ): ApiResult<never> => ({ ok: false, status, code, details, request: description });

    const url = buildPath(template, init);
    if (url === undefined) return fail(0, 'refused_url');
    description.path = url.split('?')[0]!;

    const headers: Record<string, string> = { ...init.headers };
    if (!SAFE_METHODS.has(upper)) {
      headers['Content-Type'] = 'application/json';
      const token = deps.readCookie(CSRF_COOKIE);
      if (token !== undefined) headers['X-CSRF-Token'] = token;
      if (init.idempotencyKey !== undefined) headers['Idempotency-Key'] = init.idempotencyKey;
    }

    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: upper,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        credentials: 'same-origin',
        redirect: 'error',
      });
    } catch {
      return fail(0, 'network_error');
    }

    if (response.ok) {
      const headers: ApiResponseHeaders = {};
      for (const name of ['etag', 'location'] as const) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      const metadata = Object.keys(headers).length === 0 ? {} : { headers };
      if (response.status === 204) return { ok: true, status: 204, data: undefined, ...metadata };
      try {
        return { ok: true, status: response.status, data: await response.json(), ...metadata };
      } catch {
        return fail(response.status, 'unknown_error');
      }
    }
    const failure = await readFailure(response);
    return fail(response.status, failure.code, failure.details);
  }

  return {
    request: ((method: string, path: string, init: LooseInit = {}) =>
      perform(method, path, init)) as ApiClient<P>['request'],
  };
}
