import { toJSONSchema, type $ZodType } from 'zod/v4/core';
import { PUBLISH_SCHEMAS } from './routes/publishes-schemas.js';
import { PACKAGE_ACCESS_REQUEST_SCHEMAS } from './routes/package-access-requests-schemas.js';
import { NPM_IDENTITY_SCHEMAS } from './routes/npm-identity-schemas.js';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { PERMISSIONS } from '../authz/permissions.js';
import { toJsonSchema, type JsonObject, type JsonValue } from './json-schema.js';
import { routeApiProblems } from '../kernel/routes.js';
import { IF_MATCH, type ApiRouteSpec } from './route.js';
import { API_ERROR_CODES, SERVICE_ERROR_TABLE, type ApiErrorCode } from './response.js';
import { VALIDATION_DETAIL_CODES } from './validate.js';
import { LOCAL_AUTH_API, weakPasswordErrorResponse } from './auth-schemas.js';

export interface OpenApiDocument extends JsonObject {
  openapi: '3.1.0';
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema';
  info: { title: string; version: string };
  paths: Record<string, Record<string, JsonObject>>;
  components: JsonObject;
}

const ERROR_ENVELOPE: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'requestId'],
      dependentSchemas: {
        problems: { properties: { code: { const: 'weak_password' } } },
      },
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        problems: toJsonSchema(weakPasswordErrorResponse.shape.error.shape.problems, 'output'),
        details: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'code'],
            properties: {
              path: { type: 'string' },
              code: { type: 'string', enum: [...VALIDATION_DETAIL_CODES] },
              location: { type: 'string', enum: ['params', 'query', 'body'] },
            },
          },
        },
      },
    },
  },
};

function sorted(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key] as JsonValue)]),
    );
  }
  return value;
}

function objectSchema(schema: $ZodType | undefined, location: 'params' | 'query'): JsonObject {
  if (schema === undefined) return { type: 'object', properties: {} };
  const json = toJsonSchema(schema, 'input');
  if (json.type !== 'object') throw new TypeError(`${location} schema must be an object`);
  return json;
}

function parameters(spec: ApiRouteSpec, names: readonly string[]): JsonObject[] {
  const params = objectSchema(spec.api.params, 'params');
  const properties = (params.properties ?? {}) as JsonObject;
  for (const name of Object.keys(properties)) {
    if (!names.includes(name))
      throw new TypeError(`params property ${name} is absent from the path`);
  }
  const query = objectSchema(spec.api.query, 'query');
  const required = (query.required ?? []) as string[];
  return [
    ...names.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: Object.hasOwn(properties, name) ? properties[name]! : { type: 'string' },
    })),
    ...Object.entries((query.properties ?? {}) as JsonObject)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, property]) => ({
        name,
        in: 'query',
        required: required.includes(name),
        schema: property,
      })),
  ];
}

function jsonContent(schema: JsonObject): JsonObject {
  return { 'application/json': { schema } };
}

export function generateOpenApi(
  specs: readonly ApiRouteSpec[],
  info: { title: string; version: string },
): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = Object.create(null) as OpenApiDocument['paths'];
  const operationIds = new Set<string>();
  const templates = new Map<string, string>();
  for (const spec of specs) {
    const label = `${spec.method} ${spec.path}`;
    const problems = routeApiProblems(spec, label);
    if (problems.length > 0) throw new TypeError(problems.join('; '));
    const { api } = spec;
    if (operationIds.has(api.operationId)) {
      throw new TypeError(`${label}: Duplicate operationId ${api.operationId}`);
    }
    operationIds.add(api.operationId);
    const names = [
      ...new Set(
        Array.from(spec.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g), (match) => match[1]!),
      ),
    ];
    const path = spec.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
    const template = spec.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, ':');
    const existingPath = templates.get(template);
    if (existingPath !== undefined && existingPath !== spec.path) {
      throw new TypeError(`${label}: Duplicate equivalent path template ${existingPath}`);
    }
    templates.set(template, spec.path);
    const method = spec.method.toLowerCase();
    const methods = (paths[path] ??= Object.create(null) as Record<string, JsonObject>);
    if (Object.hasOwn(methods, method)) throw new TypeError(`${label}: Duplicate path and method`);
    const sessionOnly =
      spec.boundary === 'self' ||
      PERMISSIONS.some(
        (permission) => permission.name === spec.permission && permission.sessionOnly,
      );
    const protectedRoute = spec.permission !== null || spec.boundary === 'self';
    const params = parameters(spec, names);
    const responses: JsonObject = {};
    const error = (status: number, description: string): void => {
      responses[String(status)] = {
        description,
        content: jsonContent({ $ref: '#/components/schemas/ErrorEnvelope' }),
      };
    };
    for (const [status, schema] of Object.entries(api.responses)) {
      if (Number(status) >= 400) {
        if (schema !== null) throw new TypeError(`${label}: error response ${status} must be null`);
        const messages = [
          ...new Set(
            Object.entries(API_ERROR_CODES)
              .filter(
                ([code, entry]) =>
                  entry.status === Number(status) &&
                  (code !== 'local_auth_disabled' || Object.hasOwn(LOCAL_AUTH_API, label)),
              )
              .map(([, entry]) => entry.message),
          ),
        ];
        error(Number(status), messages.length > 0 ? messages.join('; ') : 'Error');
      } else {
        responses[status] = {
          description: schema === null ? 'No content' : 'Response',
          ...(schema === null ? {} : { content: jsonContent(toJsonSchema(schema, 'output')) }),
        };
      }
    }
    error(400, 'Invalid request');
    if (api.body !== undefined) {
      error(413, 'Payload too large');
      error(415, 'Unsupported media type');
    }
    if (protectedRoute) error(401, 'Authentication required');
    if (spec.permission !== null) error(403, 'Access denied');
    if (names.length > 0) error(404, 'Not found');
    if (spec.service !== undefined) {
      for (const { code, status } of Object.values<{ code: ApiErrorCode; status: number }>(
        SERVICE_ERROR_TABLE[spec.service],
      )) {
        if (code !== 'reauth_required' && code !== 'unavailable') continue;
        const existing = responses[String(status)] as JsonObject | undefined;
        const message = API_ERROR_CODES[code].message;
        const descriptions = new Set([
          ...(typeof existing?.description === 'string' ? existing.description.split('; ') : []),
          message,
        ]);
        error(status, [...descriptions].join('; '));
      }
    }
    if (spec.concurrency !== undefined) {
      params.push({
        name: 'If-Match',
        in: 'header',
        required: true,
        schema: { type: 'string', pattern: IF_MATCH.source },
      });
      error(412, 'Precondition failed');
      error(428, 'Precondition required');
    }
    methods[method] = {
      operationId: api.operationId,
      summary: api.summary,
      tags: [...api.tags],
      ...(params.length === 0 ? {} : { parameters: params }),
      ...(api.body === undefined
        ? {}
        : {
            requestBody: { required: true, content: jsonContent(toJsonSchema(api.body, 'input')) },
          }),
      responses,
      security: !protectedRoute
        ? []
        : sessionOnly
          ? [{ session: [] }]
          : [{ session: [] }, { bearer: [] }],
      'x-pb-permission': spec.permission,
      'x-pb-boundary': spec.boundary ?? 'none',
      'x-pb-session-only': sessionOnly,
    };
  }
  return sorted({
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: info.title, version: info.version },
    paths,
    components: {
      schemas: {
        ErrorEnvelope: ERROR_ENVELOPE,
        ...Object.fromEntries(
          Object.entries({
            ...PUBLISH_SCHEMAS,
            ...PACKAGE_ACCESS_REQUEST_SCHEMAS,
            ...NPM_IDENTITY_SCHEMAS,
          }).map(([name, schema]) => {
            const io = name.endsWith('Body') ? 'input' : 'output';
            const json = Object.hasOwn(PACKAGE_ACCESS_REQUEST_SCHEMAS, name)
              ? toJsonSchema(schema, io)
              : toJSONSchema(schema, { target: 'draft-2020-12', io });
            delete json.$schema;
            return [name, json];
          }),
        ),
      },
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description:
            'Session authentication. Send the X-CSRF-Token header on state-changing requests.',
        },
        bearer: { type: 'http', scheme: 'bearer' },
      },
    },
  }) as OpenApiDocument;
}
