import { proxyClaimConflict } from './routes/proxy-claims-schema.js';
import type { ErrorEnvelope } from '../envelope.js';
import { type $ZodType, type output } from 'zod/v4/core';
import { routeApiProblems } from '../kernel/routes.js';
import type { ApiSlot, RequestContext, RouteBoundary, RouteDefinition } from '../plugin.js';
import { assertRepresentable } from './json-schema.js';
import { apiError, jsonResponse, SERVICE_ERROR_TABLE, type ApiErrorCode } from './response.js';
import {
  readJsonBody,
  VALIDATION_CODES,
  validateInput,
  type ValidationDetail,
} from './validate.js';

const MAX_DETAILS = 20;
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);
const CONCURRENCY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const IF_MATCH = /^"r([1-9][0-9]*)"$/;

export interface ApiRouteSpec {
  readonly method: RouteDefinition['method'];
  readonly path: string;
  readonly permission: string | null;
  readonly boundary?: RouteBoundary;
  readonly allowArchived?: true;
  readonly concurrency?: 'if-match';
  readonly service?: keyof typeof SERVICE_ERROR_TABLE;
  readonly api: ApiSlot;
}

export type ApiOutcome =
  | { readonly status: number; readonly body?: unknown; readonly etag?: number }
  | { readonly error: ApiErrorCode; readonly details?: readonly ValidationDetail[] }
  | { readonly error: 'conflict'; readonly conflictingClaims: readonly string[] };

type ServiceFamily = keyof typeof SERVICE_ERROR_TABLE;

export type RouteOutcome<S extends ApiRouteSpec> =
  | ApiOutcome
  | (S['service'] extends ServiceFamily
      ? { readonly serviceError: keyof (typeof SERVICE_ERROR_TABLE)[S['service']] & string }
      : never);

const STALE_REVISION_ERROR: {
  readonly [F in ServiceFamily]?: keyof (typeof SERVICE_ERROR_TABLE)[F] & string;
} = {
  AdminError: 'conflict',
  ServicePrincipalError: 'conflict',
};

type Parsed<S extends $ZodType | undefined, Fallback> = S extends $ZodType ? output<S> : Fallback;

export interface ApiCall<S extends ApiRouteSpec> {
  readonly ctx: RequestContext;
  readonly params: Parsed<S['api']['params'], Readonly<Record<string, string>>>;
  readonly query: Parsed<S['api']['query'], undefined>;
  readonly body: Parsed<S['api']['body'], undefined>;
  readonly expectedRevision: number | null;
}

function schemasOf(api: ApiSlot): [string, $ZodType][] {
  const named: [string, $ZodType | undefined][] = [
    ['params', api.params],
    ['query', api.query],
    ['body', api.body],
  ];
  for (const [status, schema] of Object.entries(api.responses)) {
    named.push([`response ${status}`, schema ?? undefined]);
  }
  return named.filter((entry): entry is [string, $ZodType] => entry[1] !== undefined);
}

export function defineApi<S extends ApiRouteSpec>(spec: S): S {
  const label = `${spec.method} ${spec.path}`;
  const problems = routeApiProblems(spec, label);
  if (problems.length > 0) throw new TypeError(problems.join('; '));
  if (spec.api.body !== undefined && !BODY_METHODS.has(spec.method)) {
    throw new TypeError(`${label}: a body is only allowed on POST, PUT or PATCH`);
  }
  if (spec.concurrency !== undefined && !CONCURRENCY_METHODS.has(spec.method)) {
    throw new TypeError(`${label}: concurrency is only allowed on POST, PUT, PATCH or DELETE`);
  }
  for (const [name, schema] of schemasOf(spec.api)) {
    assertRepresentable(schema, `${label} ${name}`);
  }
  return spec;
}

function queryOf(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = Object.create(null) as never;
  for (const [key, value] of url.searchParams) {
    const seen = query[key];
    if (seen === undefined) query[key] = value;
    else if (Array.isArray(seen)) seen.push(value);
    else query[key] = [seen, value];
  }
  return query;
}

async function hasBody(request: Request): Promise<boolean> {
  if (request.body === null) return false;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value.byteLength > 0) {
        reader.cancel().catch(() => undefined);
        return true;
      }
    }
  } catch {
    return true;
  } finally {
    reader.releaseLock();
  }
}

function handlerDetails(details: readonly ValidationDetail[]): ValidationDetail[] {
  return details.slice(0, MAX_DETAILS).map((detail) => {
    const { location } = detail as ValidationDetail & { readonly location?: unknown };
    return {
      path: typeof detail.path === 'string' ? detail.path : '',
      code: VALIDATION_CODES.has(detail.code) ? detail.code : 'invalid',
      ...(location === 'params' || location === 'query' || location === 'body' ? { location } : {}),
    };
  });
}

function prefixed(prefix: string, details: readonly ValidationDetail[]): ValidationDetail[] {
  return details.map((detail) => ({ path: `${prefix}${detail.path}`, code: detail.code }));
}

function withRequestId(response: Response, requestId: string): Response {
  response.headers.set('x-request-id', requestId);
  return response;
}

export function apiRoute<const S extends ApiRouteSpec>(
  spec: S,
  handler: (call: ApiCall<S>) => Promise<RouteOutcome<S>>,
): RouteDefinition {
  const { api, concurrency } = defineApi(spec);
  const declared = (status: number): boolean => Object.hasOwn(api.responses, String(status));

  return {
    method: spec.method,
    path: spec.path,
    permission: spec.permission,
    ...(spec.boundary === undefined ? {} : { boundary: spec.boundary }),
    ...(spec.allowArchived === true ? { allowArchived: true as const } : {}),
    api,
    handler: async (ctx) => {
      const fail = (code: ApiErrorCode, details?: readonly ValidationDetail[]): Response =>
        withRequestId(apiError(code, ctx.requestId, details), ctx.requestId);

      let body: unknown;
      if (api.body !== undefined) {
        const read = await readJsonBody(ctx.request);
        if (!read.ok) {
          if (read.status !== 400) return fail(read.code);
          if (read.detail === 'invalid_request') return fail('invalid_request');
          const detail: ValidationDetail = { path: '/body', code: read.detail };
          return fail('invalid_request', [detail]);
        }
        body = read.value;
      }

      const details: ValidationDetail[] = [];
      const check = (schema: $ZodType | undefined, prefix: string, value: unknown): unknown => {
        if (schema === undefined) return undefined;
        const result = validateInput(schema, value);
        if (result.ok) return result.data;
        details.push(...prefixed(prefix, result.details));
        return undefined;
      };
      const params = check(api.params, '/params', ctx.params);
      const url = new URL(ctx.request.url);
      const query = check(api.query, '/query', queryOf(url));
      if (api.query === undefined && url.searchParams.size > 0) {
        details.push({ path: '/query', code: 'unrecognized_keys' });
      }
      const parsedBody = check(api.body, '/body', body);
      if (api.body === undefined && (await hasBody(ctx.request))) {
        details.push({ path: '/body', code: 'invalid' });
      }
      if (details.length > 0) return fail('invalid_request', details.slice(0, MAX_DETAILS));

      let expectedRevision: number | null = null;
      if (concurrency !== undefined) {
        const header = ctx.request.headers.get('if-match');
        if (header === null) return fail('precondition_required');
        const match = IF_MATCH.exec(header);
        const revision = match?.[1] === undefined ? Number.NaN : Number(match[1]);
        if (!Number.isSafeInteger(revision)) return fail('invalid_request');
        expectedRevision = revision;
      }

      const outcome = await handler({
        ctx,
        params: params ?? ctx.params,
        query,
        body: parsedBody,
        expectedRevision,
      } as ApiCall<S>);

      if ('serviceError' in outcome) {
        const { service } = spec;
        const key: unknown = outcome.serviceError;
        if (
          service === undefined ||
          !Object.hasOwn(SERVICE_ERROR_TABLE, service) ||
          typeof key !== 'string' ||
          !Object.hasOwn(SERVICE_ERROR_TABLE[service], key)
        ) {
          throw new TypeError('API handler returned an invalid service error');
        }
        if (concurrency !== undefined && STALE_REVISION_ERROR[service] === key) {
          return fail('precondition_failed');
        }
        const mapping = (SERVICE_ERROR_TABLE[service] as Record<string, { code: ApiErrorCode }>)[
          key
        ];
        return fail(mapping!.code);
      }

      if ('error' in outcome) {
        if ('conflictingClaims' in outcome) {
          if (spec.api.responses[409] !== proxyClaimConflict)
            throw new TypeError('API handler returned undeclared claim conflicts');
          const response = fail('conflict');
          return new Response(
            JSON.stringify({
              ...((await response.json()) as ErrorEnvelope),
              conflictingClaims: outcome.conflictingClaims,
            }),
            { status: response.status, headers: response.headers },
          );
        }
        if (outcome.error === 'conflict' && concurrency !== undefined) {
          return fail('precondition_failed');
        }
        return fail(
          outcome.error,
          outcome.error === 'invalid_request' && outcome.details !== undefined
            ? handlerDetails(outcome.details)
            : undefined,
        );
      }
      if (!Number.isInteger(outcome.status) || outcome.status < 200 || outcome.status > 299) {
        throw new TypeError('API handler returned a non-success status');
      }
      if (!declared(outcome.status)) {
        throw new TypeError(`API handler returned undeclared status ${String(outcome.status)}`);
      }
      return withRequestId(
        jsonResponse(outcome.status, outcome.body ?? null, {
          ...(outcome.etag === undefined ? {} : { etag: outcome.etag }),
        }),
        ctx.requestId,
      );
    },
  };
}
