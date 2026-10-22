import * as z from 'zod';
import { PROJECT_SLUG_PATTERN } from '../../authz/project-path.js';
import type { ApiRouteSpec } from '../route.js';

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const project = z.string().regex(PROJECT_SLUG_PATTERN);
const ecosystem = z.enum(['composer', 'npm']);
const type = z.enum([
  'vcs',
  'composer_repository',
  'npm_registry',
  'packagist_proxy',
  'npmjs_proxy',
  'hosted',
]);
const removalPolicy = z.enum(['flag', 'exclude']);
const strings = z.array(z.string());
const config = z.union([
  z.strictObject({
    provider: z.enum(['github', 'git', 'ssh']),
    repository: z.string(),
    installationId: z.number().int().positive().optional(),
    packageName: z.string().optional(),
    refs: z.strictObject({ tags: z.boolean().optional(), branches: strings.optional() }).optional(),
  }),
  z.strictObject({
    selection: z
      .strictObject({
        packages: strings.optional(),
        patterns: strings.optional(),
        expandPatterns: z.boolean().optional(),
      })
      .optional(),
    distHosts: strings.optional(),
    mirrorsFallback: z.boolean().optional(),
  }),
  z.strictObject({ scopes: strings.optional(), distHosts: strings.optional() }),
  z.strictObject({ githubToken: z.boolean().optional() }),
  z.strictObject({}),
]);
const changes = {
  url: z.string().max(2048).nullable().optional(),
  config: config.optional(),
  userAgent: z.string().nullable().optional(),
  pollIntervalSeconds: z.number().int().positive().optional(),
  removalPolicy: removalPolicy.optional(),
  retentionDaysOverride: z.number().int().nonnegative().nullable().optional(),
  defaultVisibleToNewProjects: z.boolean().optional(),
};
const createBody = z.strictObject({ name: z.string().min(1), ecosystem, type, ...changes });
const updateBody = z.strictObject(changes);
const credentialBody = z.strictObject({
  kind: z.enum(['http_basic', 'bearer', 'header', 'query', 'github_app', 'npm_token', 'ssh_key']),
  material: z.string().max(16384),
});
const listQuery = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9][0-9]?|100)$/)
    .optional(),
  after: ulid.optional(),
});
const source = z.strictObject({
  id: ulid,
  projectId: ulid.nullable(),
  name: z.string(),
  ecosystem,
  type,
  url: z.string().nullable(),
  status: z.enum(['active', 'degraded', 'failing', 'paused']),
  removalPolicy,
  pollIntervalSeconds: z.number().int(),
  lastSuccessAt: z.string().nullable(),
  hasCredential: z.boolean(),
  lastRemovalRefusal: z
    .strictObject({
      at: z.string(),
      absent: z.number().int(),
      listed: z.number().int(),
      successful: z.number().int(),
    })
    .nullable(),
  removalAcceptanceArmed: z.boolean(),
});
const page = z.strictObject({
  items: z.array(source.extend({ attachedProjectCount: z.number().int().nonnegative() })),
  next: ulid.nullable(),
});
const created = z.strictObject({ id: ulid });

function scopeSpecs(boundary: 'organization' | 'project') {
  const scoped = boundary === 'project';
  const path = scoped ? '/_pb/projects/:project/sources' : '/_pb/sources';
  const scope = scoped ? 'project' : 'org';
  const name = scoped ? 'Project' : 'Organization';
  const collectionParams = scoped ? z.strictObject({ project }) : z.strictObject({});
  const sourceParams = scoped
    ? z.strictObject({ project, source: ulid })
    : z.strictObject({ source: ulid });
  return [
    {
      method: 'GET',
      path,
      boundary,
      permission: `${scope}:sources:read`,
      service: 'SourceError',
      api: {
        operationId: `list${name}Sources`,
        summary: 'List sources',
        tags: ['sources'],
        params: collectionParams,
        query: listQuery,
        responses: {
          200: scoped
            ? z.strictObject({
                items: z.array(
                  z.union([
                    source.extend({ attached: z.literal(true), precedence: z.number().int() }),
                    source.extend({ attached: z.literal(false) }),
                  ]),
                ),
                next: ulid.nullable(),
              })
            : page,
        },
      },
    },
    {
      method: 'POST',
      path,
      boundary,
      permission: `${scope}:sources:write`,
      service: 'SourceError',
      api: {
        operationId: `create${name}Source`,
        summary: 'Add a source',
        tags: ['sources'],
        params: collectionParams,
        body: createBody,
        responses: { 201: created },
      },
    },
    {
      method: 'PATCH',
      path: `${path}/:source`,
      boundary,
      permission: `${scope}:sources:write`,
      service: 'SourceError',
      api: {
        operationId: `update${name}Source`,
        summary: 'Change source settings',
        tags: ['sources'],
        params: sourceParams,
        body: updateBody,
        responses: { 204: null },
      },
    },
    {
      method: 'POST',
      path: `${path}/:source/pause`,
      boundary,
      permission: `${scope}:sources:write`,
      service: 'SourceError',
      api: {
        operationId: `pause${name}Source`,
        summary: 'Pause a source',
        tags: ['sources'],
        params: sourceParams,
        responses: { 204: null },
      },
    },
    {
      method: 'POST',
      path: `${path}/:source/resume`,
      boundary,
      permission: `${scope}:sources:write`,
      service: 'SourceError',
      api: {
        operationId: `resume${name}Source`,
        summary: 'Resume a proxy source',
        tags: ['sources'],
        params: sourceParams,
        responses: { 204: null },
      },
    },
    {
      method: 'PUT',
      path: `${path}/:source/credential`,
      boundary,
      permission: `${scope}:sources:write`,
      service: 'SourceError',
      api: {
        operationId: `write${name}SourceCredential`,
        summary: 'Replace a source credential after reauthentication',
        tags: ['sources'],
        params: sourceParams,
        body: credentialBody,
        responses: { 204: null },
      },
    },
  ] as const satisfies readonly ApiRouteSpec[];
}

export const SOURCE_API_SPECS = [...scopeSpecs('organization'), ...scopeSpecs('project')] as const;

export const ACCEPT_REMOVAL_API_SPEC = {
  method: 'POST',
  path: '/_pb/sources/:source/accept-removal',
  boundary: 'organization',
  permission: 'org:sources:write',
  service: 'SourceError',
  api: {
    operationId: 'acceptSourceRemoval',
    summary: 'Arm a one-shot acceptance of the last refused source removal',
    tags: ['sources'],
    params: z.strictObject({ source: ulid }),
    responses: { 204: null, 409: null },
  },
} as const satisfies ApiRouteSpec;
