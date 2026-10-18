import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateOpenApi } from './openapi.js';
import { IF_MATCH, defineApi, type ApiRouteSpec } from './route.js';
import { toJsonSchema, type JsonValue } from './json-schema.js';

import { VALIDATION_DETAIL_CODES } from './validate.js';

const info = { title: 'Package Broker', version: '2.0.0' };
const result = z.strictObject({ ok: z.boolean() });
const specs: readonly ApiRouteSpec[] = [
  defineApi({
    method: 'GET',
    path: '/_pb/status',
    permission: null,
    api: { operationId: 'status', summary: 'Status', tags: ['public'], responses: { 200: result } },
  }),
  defineApi({
    method: 'POST',
    path: '/_pb/settings',
    permission: 'org:settings:write',
    boundary: 'organization',
    api: {
      operationId: 'createSettings',
      summary: 'Create settings',
      tags: ['settings'],
      body: z.strictObject({ name: z.string() }),
      responses: { 201: result },
    },
  }),
  defineApi({
    method: 'PATCH',
    path: '/_pb/settings',
    permission: 'org:settings:write',
    boundary: 'organization',
    concurrency: 'if-match',
    api: {
      operationId: 'updateSettings',
      summary: 'Update settings',
      tags: ['settings'],
      responses: { 204: null },
    },
  }),
  defineApi({
    method: 'GET',
    path: '/_pb/projects/:project',
    permission: 'project:read',
    boundary: 'project',
    api: {
      operationId: 'getProject',
      summary: 'Get project',
      tags: ['projects'],
      params: z.strictObject({ project: z.string() }),
      query: z.strictObject({ search: z.string(), limit: z.string().optional() }),
      responses: { 200: result, 409: null },
    },
  }),
];

const document = () => generateOpenApi(specs, info);

describe('generateOpenApi', () => {
  it('emits identical bytes on repeated calls and reversed specs', () => {
    const bytes = JSON.stringify(document());
    expect(JSON.stringify(document())).toBe(bytes);
    expect(JSON.stringify(generateOpenApi([...specs].reverse(), info))).toBe(bytes);
  });

  it('changes bytes when one summary changes', () => {
    const changed = specs.map((spec, i) =>
      i === 0 ? { ...spec, api: { ...spec.api, summary: 'Changed' } } : spec,
    );
    expect(JSON.stringify(generateOpenApi(changed, info))).not.toBe(JSON.stringify(document()));
  });

  it('matches the authorization golden JSON for all four operations', () => {
    const facts = Object.fromEntries(
      Object.entries(document().paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => [
          `${method} ${path}`,
          {
            permission: operation['x-pb-permission'],
            boundary: operation['x-pb-boundary'],
            sessionOnly: operation['x-pb-session-only'],
            security: operation.security,
          },
        ]),
      ),
    );
    expect(JSON.stringify(facts)).toBe(
      '{"get /_pb/projects/{project}":{"permission":"project:read","boundary":"project","sessionOnly":false,"security":[{"session":[]},{"bearer":[]}]},"patch /_pb/settings":{"permission":"org:settings:write","boundary":"organization","sessionOnly":true,"security":[{"session":[]}]},"post /_pb/settings":{"permission":"org:settings:write","boundary":"organization","sessionOnly":true,"security":[{"session":[]}]},"get /_pb/status":{"permission":null,"boundary":"none","sessionOnly":false,"security":[]}}',
    );
  });

  it('documents self as protected and session-only without a permission', () => {
    const self = generateOpenApi([{ ...specs[0]!, boundary: 'self' }], info);
    expect(self.paths['/_pb/status']?.get).toMatchObject({
      'x-pb-permission': null,
      'x-pb-boundary': 'self',
      'x-pb-session-only': true,
      security: [{ session: [] }],
      responses: {
        401: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
          },
        },
      },
    });
  });

  it('documents schemas, parameters, declared statuses and implicit errors', () => {
    const doc = document();
    expect(doc).toMatchObject({
      openapi: '3.1.0',
      jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
      info,
    });
    expect(doc.paths['/_pb/projects/{project}']?.get).toMatchObject({
      operationId: 'getProject',
      summary: 'Get project',
      tags: ['projects'],
      parameters: [
        { in: 'path', name: 'project', required: true, schema: { type: 'string' } },
        { in: 'query', name: 'limit', required: false, schema: { type: 'string' } },
        { in: 'query', name: 'search', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { content: { 'application/json': { schema: toJsonSchema(result, 'output') } } },
        401: {},
        403: {},
        404: {},
        409: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
          },
        },
      },
    });
    expect(doc.paths['/_pb/settings']?.post).toMatchObject({
      requestBody: {
        required: true,
        content: { 'application/json': { schema: toJsonSchema(specs[1]!.api.body!, 'input') } },
      },
    });
    expect(doc.paths['/_pb/status']?.get).toMatchObject({ responses: { 200: {} } });
    expect(Object.keys(doc.paths['/_pb/status']!.get!.responses!)).toEqual(['200', '400']);
    expect(doc.components).toMatchObject({
      schemas: {
        ErrorEnvelope: {
          properties: {
            error: {
              required: ['code', 'message', 'requestId'],
              properties: {
                details: {
                  type: 'array',
                  maxItems: 20,
                  items: {
                    required: ['path', 'code'],
                    properties: {
                      path: { type: 'string' },
                      code: { type: 'string', enum: [...VALIDATION_DETAIL_CODES] },
                      location: { enum: ['params', 'query', 'body'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-pb_session',
          description: expect.stringContaining('X-CSRF-Token'),
        },
        bearer: { type: 'http', scheme: 'bearer' },
      },
    });
  });

  it('adds concurrency parameters and errors to PATCH', () => {
    expect(document().paths['/_pb/settings']?.patch).toMatchObject({
      parameters: [
        {
          in: 'header',
          name: 'If-Match',
          required: true,
          schema: { type: 'string', pattern: IF_MATCH.source },
        },
      ],
      responses: {
        204: { description: expect.any(String) },
        412: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
          },
        },
        428: {},
      },
    });
    const responses = document().paths['/_pb/settings']!.patch!.responses as Record<
      string,
      unknown
    >;
    expect(responses['204']).not.toHaveProperty('content');
  });

  it('omits concurrency parameters and errors from POST', () => {
    const post = document().paths['/_pb/settings']!.post!;
    expect(post.parameters ?? []).toEqual([]);
    expect(post.responses).not.toHaveProperty('412');
    expect(post.responses).not.toHaveProperty('428');
  });

  it('adds 404 for a path parameter other than project', () => {
    const doc = generateOpenApi(
      [
        {
          ...specs[0]!,
          path: '/_pb/things/:id',
          api: { ...specs[0]!.api, params: z.strictObject({ id: z.string() }) },
        },
      ],
      info,
    );
    expect(doc.paths['/_pb/things/{id}']?.get?.responses).toHaveProperty('404');
  });

  it('rejects duplicate operation IDs', () => {
    expect(() =>
      generateOpenApi(
        [specs[0]!, { ...specs[1]!, api: { ...specs[1]!.api, operationId: 'status' } }],
        info,
      ),
    ).toThrow(/POST \/_pb\/settings.*operationId.*status/);
  });

  it.each([400, 403, 409, 503])('uses the shared envelope for declared error %s', (status) => {
    const doc = generateOpenApi(
      [
        {
          ...specs[0]!,
          api: {
            ...specs[0]!.api,
            responses: { 200: result, [status]: null },
          },
        },
      ],
      info,
    );
    expect(doc.paths['/_pb/status']!.get!.responses).toMatchObject({
      [status]: {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
    });
  });

  it('rejects a schema for a declared error status', () => {
    expect(() =>
      generateOpenApi(
        [
          {
            ...specs[0]!,
            api: {
              ...specs[0]!.api,
              responses: { 200: result, 409: result },
            },
          },
        ],
        info,
      ),
    ).toThrow(/409.*null/);
  });

  it('documents invalid requests on every operation and body read errors for bodies', () => {
    for (const methods of Object.values(document().paths)) {
      for (const operation of Object.values(methods)) {
        expect(operation.responses).toHaveProperty(
          '400.content.application/json.schema.$ref',
          '#/components/schemas/ErrorEnvelope',
        );
      }
    }
    const settings = document().paths['/_pb/settings']!;
    expect(settings.post!.responses).toHaveProperty('413');
    expect(settings.post!.responses).toHaveProperty('415');
    expect(settings.patch!.responses).not.toHaveProperty('413');
    expect(settings.patch!.responses).not.toHaveProperty('415');
  });

  it('derives path parameters without a params schema, including underscores', () => {
    const doc = generateOpenApi([{ ...specs[0]!, path: '/_pb/things/:_item_id' }], info);
    expect(doc.paths['/_pb/things/{_item_id}']!.get!.parameters).toEqual([
      { in: 'path', name: '_item_id', required: true, schema: { type: 'string' } },
    ]);
  });

  it('uses declared property schemas and falls back for missing properties', () => {
    const doc = generateOpenApi(
      [
        {
          ...specs[0]!,
          path: '/_pb/things/:id/:other',
          api: {
            ...specs[0]!.api,
            params: z.strictObject({ id: z.enum(['a', 'b']) }),
          },
        },
      ],
      info,
    );
    expect(doc.paths['/_pb/things/{id}/{other}']!.get!.parameters).toEqual([
      { in: 'path', name: 'id', required: true, schema: { type: 'string', enum: ['a', 'b'] } },
      { in: 'path', name: 'other', required: true, schema: { type: 'string' } },
    ]);
  });

  it('rejects params properties absent from the template', () => {
    expect(() =>
      generateOpenApi(
        [
          {
            ...specs[0]!,
            api: {
              ...specs[0]!.api,
              params: z.strictObject({ extra: z.string() }),
            },
          },
        ],
        info,
      ),
    ).toThrow(/extra.*path/);
  });

  it.each(['params', 'query'] as const)('rejects a non-object %s schema', (location) => {
    expect(() =>
      generateOpenApi(
        [
          {
            ...specs[0]!,
            api: {
              ...specs[0]!.api,
              [location]: z.string(),
            },
          },
        ],
        info,
      ),
    ).toThrow(new RegExp(`${location}.*object`));
  });

  it('validates every API slot before generating', () => {
    expect(() =>
      generateOpenApi(
        [
          {
            ...specs[0]!,
            api: {
              ...specs[0]!.api,
              operationId: 'bad-id',
            },
          },
        ],
        info,
      ),
    ).toThrow(/GET \/_pb\/status.*operationId/);
  });

  it('rejects equivalent templates for the same method', () => {
    expect(() =>
      generateOpenApi(
        [
          { ...specs[0]!, path: '/_pb/things/:a' },
          { ...specs[0]!, path: '/_pb/things/:b', api: { ...specs[0]!.api, operationId: 'other' } },
        ],
        info,
      ),
    ).toThrow(/Duplicate.*path/);
  });

  it('rejects equivalent templates across methods', () => {
    expect(() =>
      generateOpenApi(
        [
          { ...specs[0]!, path: '/_pb/things/:a' },
          { ...specs[1]!, path: '/_pb/things/:b' },
        ],
        info,
      ),
    ).toThrow(/Duplicate.*path/);
  });

  it('sorts every object key recursively', () => {
    function check(value: JsonValue): void {
      if (Array.isArray(value)) value.forEach(check);
      else if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value);
        expect(keys).toEqual([...keys].sort());
        Object.values(value).forEach(check);
      }
    }
    check(document());
  });

  it('contains no deployment host or date', () => {
    const bytes = JSON.stringify(document());
    expect(bytes).not.toMatch(
      /localhost|broker\.test|https?:\/\/(?!json-schema\.org)[^/"\s]+|\b\d{4}-\d{2}-\d{2}\b/,
    );
    expect(document()).not.toHaveProperty('servers');
  });
});
