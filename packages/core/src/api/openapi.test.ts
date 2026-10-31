import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { generateOpenApi } from './openapi.js';
import { IF_MATCH, defineApi, type ApiRouteSpec } from './route.js';
import { toJsonSchema, type JsonValue } from './json-schema.js';

import { SERVICE_ERROR_TABLE } from './response.js';
import { VALIDATION_DETAIL_CODES } from './validate.js';
import { AUTH_API } from './auth-schemas.js';
import { PROJECT_API_SPECS } from './routes/projects-schemas.js';
import { SERVICE_PRINCIPAL_API_SPECS } from './routes/service-principals-schemas.js';

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
  it('constrains service links to the service error table', () => {
    expectTypeOf<ApiRouteSpec['service']>().toEqualTypeOf<
      keyof typeof SERVICE_ERROR_TABLE | undefined
    >();
  });

  it.each(['PersonalTokenError', 'ServiceTokenError'] as const)(
    'derives reauthentication and unavailability from %s without declarations',
    (service) => {
      const linked = defineApi({ ...specs[0]!, service });
      expect(linked.api.responses).toEqual({ 200: result });
      const responses = generateOpenApi([linked], info).paths['/_pb/status']!.get!.responses;
      expect(responses).toMatchObject({
        403: {
          description: 'Reauthentication required',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
          },
        },
        503: {
          description: 'Service unavailable',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
          },
        },
      });
      expect(Object.keys(responses!)).toEqual(['200', '400', '403', '503']);
    },
  );

  it('keeps unlinked routes free of service-derived errors', () => {
    expect(document().paths['/_pb/status']!.get!.responses).toEqual({
      200: {
        description: 'Response',
        content: { 'application/json': { schema: toJsonSchema(result, 'output') } },
      },
      400: {
        description: 'Invalid request',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
    });
  });

  it('does not advertise scan_incomplete for project listing', () => {
    const operation = generateOpenApi(PROJECT_API_SPECS, info).paths['/_pb/projects']!.get;
    expect(JSON.stringify(operation)).not.toContain('scan_incomplete');
    expect(SERVICE_ERROR_TABLE.ProjectListError).not.toHaveProperty('scan_incomplete');
  });

  it('derives only errors present in the linked service', () => {
    const responses = generateOpenApi([{ ...specs[0]!, service: 'ProjectListError' }], info).paths[
      '/_pb/status'
    ]!.get!.responses;
    expect(responses).toHaveProperty('503.description', 'Service unavailable');
    expect(responses).not.toHaveProperty('403');
  });

  it('preserves access denial alongside service reauthentication', () => {
    const responses = generateOpenApi([{ ...specs[1]!, service: 'PersonalTokenError' }], info)
      .paths['/_pb/settings']!.post!.responses;
    expect(responses).toHaveProperty('403.description', 'Access denied; Reauthentication required');
  });

  it('does not repeat service errors already declared by the route', () => {
    const responses = generateOpenApi(
      [
        {
          ...specs[0]!,
          service: 'PersonalTokenError',
          api: { ...specs[0]!.api, responses: { 200: result, 403: null, 503: null } },
        },
      ],
      info,
    ).paths['/_pb/status']!.get!.responses;
    expect(responses).toHaveProperty(
      '403.description',
      'Access denied; Reauthentication required; The token scope does not permit this operation; The package is not admitted to this project; You cannot approve your own publish; The token is bound to a different package; No trusted publisher matches this workload',
    );
    expect(responses).toHaveProperty(
      '503.description',
      'Service unavailable; Publishing is busy, try again later',
    );
  });

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

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'adds declared concurrency parameters and errors to %s',
    (method) => {
      const spec = defineApi({ ...specs[2]!, method });
      const operation = generateOpenApi([spec], info).paths['/_pb/settings']![
        method.toLowerCase()
      ]!;
      expect(operation).toMatchObject({
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
      const responses = operation.responses as Record<string, unknown>;
      expect(responses['204']).not.toHaveProperty('content');
    },
  );

  it('documents the weak-password problems on the auth setup error envelope', () => {
    const doc = generateOpenApi(
      [
        defineApi({
          method: 'POST',
          path: '/_pb/auth/local/setup/finish',
          permission: null,
          api: AUTH_API['POST /_pb/auth/local/setup/finish']!,
        }),
      ],
      info,
    );
    expect(doc.paths['/_pb/auth/local/setup/finish']!.post!.responses).toMatchObject({
      400: {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
    });
    expect(doc.components).toMatchObject({
      schemas: {
        ErrorEnvelope: {
          additionalProperties: false,
          properties: {
            error: {
              additionalProperties: false,
              dependentSchemas: {
                problems: { properties: { code: { const: 'weak_password' } } },
              },
              properties: {
                problems: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'string',
                    enum: ['too_short', 'too_long', 'equals_email', 'not_well_formed'],
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it('omits concurrency parameters and errors from POST without a declaration', () => {
    const post = document().paths['/_pb/settings']!.post!;
    expect(post.parameters ?? []).toEqual([]);
    expect(post.responses).not.toHaveProperty('412');
    expect(post.responses).not.toHaveProperty('428');
  });

  it.each([
    ['/_pb/projects/{project}/archive', PROJECT_API_SPECS],
    ['/_pb/projects/{project}/restore', PROJECT_API_SPECS],
    ['/_pb/service-principals/{principal}/restore', SERVICE_PRINCIPAL_API_SPECS],
    ['/_pb/projects/{project}/service-principals/{principal}/restore', SERVICE_PRINCIPAL_API_SPECS],
  ] as const)('documents If-Match for POST %s', (path, specs) => {
    const operation = generateOpenApi(specs, info).paths[path]!.post!;
    expect(operation.parameters).toContainEqual({
      name: 'If-Match',
      in: 'header',
      required: true,
      schema: { type: 'string', pattern: IF_MATCH.source },
    });
    for (const status of ['412', '428']) {
      expect(operation.responses).toHaveProperty(
        `${status}.content.application/json.schema.$ref`,
        '#/components/schemas/ErrorEnvelope',
      );
    }
  });

  it('keeps suspend POSTs free of concurrency parameters and errors', () => {
    const doc = generateOpenApi(SERVICE_PRINCIPAL_API_SPECS, info);
    for (const methods of Object.values(doc.paths)) {
      if (!String(methods.post?.operationId).startsWith('suspend')) continue;
      expect(methods.post!.parameters).not.toContainEqual(
        expect.objectContaining({ in: 'header', name: 'If-Match' }),
      );
      expect(methods.post!.responses).not.toHaveProperty('412');
      expect(methods.post!.responses).not.toHaveProperty('428');
    }
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

describe('OpenAPI follow-ups', () => {
  it('labels duplicate path and method errors', () => {
    expect(() =>
      generateOpenApi(
        [specs[0]!, { ...specs[0]!, api: { ...specs[0]!.api, operationId: 'otherStatus' } }],
        info,
      ),
    ).toThrow('GET /_pb/status: Duplicate path and method');
  });
  it.each([
    [
      409,
      'The hosted source must be attached to the project first; Conflict; Source is paused; Already exists; Last holder cannot be removed; Idempotency key does not match; Already issued; Approval required; Publish approval already decided; This claim still covers hosted packages; This package name is already published or proxied; This package name is already published publicly; The public package name could not be verified; This package name has not been claimed; This package version already exists; Approval is required before this version can be released; There are too many pending login sessions; More than one trusted publisher matches this workload',
    ],
    [503, 'Service unavailable; Publishing is busy, try again later'],
    [418, 'Error'],
  ] as const)(
    'describes declared error %s from the code table when available',
    (status, description) => {
      const doc = generateOpenApi(
        [{ ...specs[0]!, api: { ...specs[0]!.api, responses: { 200: result, [status]: null } } }],
        info,
      );
      expect(doc.paths['/_pb/status']!.get!.responses).toHaveProperty(
        `${status}.description`,
        description,
      );
    },
  );
});

it('publishes the same required nested vulnerability contract on both version reads', async () => {
  const { PACKAGE_API_SPECS } = await import('./routes/packages-schemas.js');
  const doc = generateOpenApi(PACKAGE_API_SPECS, info);
  for (const path of [
    '/_pb/packages/{package}/versions',
    '/_pb/projects/{project}/packages/{package}/versions',
  ]) {
    const operation = doc.paths[path]!.get!;
    expect(operation).toMatchObject({
      responses: {
        200: {
          content: {
            'application/json': {
              schema: {
                properties: {
                  items: {
                    items: {
                      required: expect.arrayContaining(['status', 'vulnerability']),
                      properties: {
                        vulnerability: {
                          additionalProperties: false,
                          required: expect.arrayContaining([
                            'status',
                            'reason',
                            'source',
                            'fetchedAt',
                            'lastKnownStatus',
                            'advisoryCount',
                            'advisories',
                            'detailsComplete',
                            'advisoriesTruncated',
                          ]),
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  }
});

it('declares the paused-source conflict for both source sync operations', async () => {
  const { SOURCE_API_SPECS } = await import('./routes/sources-schemas.js');
  const doc = generateOpenApi(SOURCE_API_SPECS, info);
  for (const path of [
    '/_pb/sources/{source}/sync',
    '/_pb/projects/{project}/sources/{source}/sync',
  ]) {
    const responses = doc.paths[path]!.post!.responses;
    expect(responses).toHaveProperty('202');
    expect(responses).toHaveProperty('409.content.application/json');
    expect(responses).toHaveProperty(
      '409.description',
      expect.stringContaining('Source is paused'),
    );
  }
});
