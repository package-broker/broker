import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../ids.js';
import type { RouteDefinition } from '../plugin.js';
import { API_EXEMPT_ROUTES, createApiModule, type ApiModuleDeps } from './module.js';
import * as organization from './routes/organization.js';
import * as projects from './routes/projects.js';
import * as access from './routes/access.js';
import * as projectAccess from './routes/project-access.js';
import * as tokens from './routes/tokens.js';
import * as servicePrincipals from './routes/service-principals.js';
import * as sources from './routes/sources.js';
import * as sourceNames from './routes/source-names.js';
import * as packages from './routes/packages.js';
import * as audit from './routes/audit.js';
import * as permissions from './routes/permissions.js';

const EXPECTED_ROUTES = [
  'GET /_pb/organization',
  'GET /_pb/users',
  'PATCH /_pb/users/:user',
  'GET /_pb/me',
  'GET /_pb/projects',
  'POST /_pb/projects',
  'GET /_pb/projects/:project',
  'PATCH /_pb/projects/:project',
  'POST /_pb/projects/:project/archive',
  'POST /_pb/projects/:project/restore',
  'GET /_pb/roles',
  'POST /_pb/roles',
  'PATCH /_pb/roles/:role',
  'DELETE /_pb/roles/:role',
  'GET /_pb/grants',
  'POST /_pb/grants',
  'PATCH /_pb/grants/:grant',
  'DELETE /_pb/grants/:grant',
  'POST /_pb/projects/:project/grants',
  'PATCH /_pb/projects/:project/grants/:grant',
  'DELETE /_pb/projects/:project/grants/:grant',
  'POST /_pb/me/tokens',
  'GET /_pb/me/tokens',
  'GET /_pb/me/tokens/:token',
  'DELETE /_pb/me/tokens/:token',
  'POST /_pb/projects/:project/tokens',
  'GET /_pb/projects/:project/tokens',
  'GET /_pb/projects/:project/tokens/:token',
  'DELETE /_pb/projects/:project/tokens/:token',
  'POST /_pb/projects/:project/tokens/:token/rotate',
  'POST /_pb/tokens',
  'GET /_pb/tokens',
  'GET /_pb/tokens/:token',
  'DELETE /_pb/tokens/:token',
  'POST /_pb/tokens/:token/rotate',
  'PUT /_pb/service-principals/:principal/permissions',
  'POST /_pb/service-principals/:principal/suspend',
  'POST /_pb/service-principals/:principal/restore',
  'PUT /_pb/projects/:project/service-principals/:principal/permissions',
  'POST /_pb/projects/:project/service-principals/:principal/suspend',
  'POST /_pb/projects/:project/service-principals/:principal/restore',
  'GET /_pb/sources',
  'POST /_pb/sources',
  'PATCH /_pb/sources/:source',
  'POST /_pb/sources/:source/pause',
  'POST /_pb/sources/:source/resume',
  'PUT /_pb/sources/:source/credential',
  'GET /_pb/projects/:project/sources',
  'POST /_pb/projects/:project/sources',
  'PATCH /_pb/projects/:project/sources/:source',
  'POST /_pb/projects/:project/sources/:source/pause',
  'POST /_pb/projects/:project/sources/:source/resume',
  'PUT /_pb/projects/:project/sources/:source/credential',
  'GET /_pb/sources/:source/names',
  'POST /_pb/sources/:source/names',
  'DELETE /_pb/sources/:source/names/:name',
  'POST /_pb/sources/:source/enable',
  'POST /_pb/sources/:source/accept-removal',
  'PUT /_pb/projects/:project/sources/order',
  'GET /_pb/projects/:project/resolve',
  'GET /_pb/packages',
  'GET /_pb/packages/:package/versions',
  'GET /_pb/projects/:project/packages',
  'GET /_pb/projects/:project/packages/:package/versions',
  'GET /_pb/audit',
  'GET /_pb/audit/head',
  'GET /_pb/projects/:project/audit',
  'GET /_pb/me/permissions',
  'GET /_pb/projects/:project/permissions',
];

function unused<T extends object>(...methods: readonly (keyof T)[]): T {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      vi.fn(() => {
        throw new Error('service called during route construction');
      }),
    ]),
  ) as T;
}

function dependencies(): ApiModuleDeps {
  const common = () => ({
    ids: { ulid: vi.fn<() => string>() },
    clock: fixedClock('2026-10-21T00:00:00.000Z'),
    clientIp: vi.fn<() => string | null>(),
  });
  const lifetime = { personal: { maxDays: 365 }, service: { maxDays: 365 } };
  return {
    organization: {
      ...common(),
      organizations: unused('get'),
      users: unused('list', 'get'),
      administration: unused('suspendUser', 'reactivateUser'),
      lifetime,
    },
    projects: {
      ...common(),
      lister: unused('list'),
      service: unused('createProject', 'updateSettings', 'archiveProject', 'restoreProject'),
      projects: unused('get', 'getBySlug'),
      idempotency: unused('find'),
    },
    access: {
      ...common(),
      administration: unused(
        'listRoles',
        'createRole',
        'renameRole',
        'setRolePermissions',
        'deleteRole',
        'grantOrganization',
        'changeGrantRole',
        'revokeOrganizationGrant',
      ),
      grants: unused('listOrganization'),
    },
    projectAccess: {
      ...common(),
      projectAdministration: unused('grant', 'changeRole', 'revoke'),
      roles: unused('get'),
    },
    tokens: {
      ...common(),
      tokens: {
        personal: unused('issue'),
        service: unused('issue', 'rotate'),
        revoke: unused('revoke'),
      },
      reader: unused(
        'listOwn',
        'listProject',
        'listOrganization',
        'getOwn',
        'getProject',
        'getOrganization',
      ),
      idempotency: unused('find'),
      sessions: unused('authenticate'),
      organizations: unused('get'),
      lifetime,
    },
    servicePrincipals: {
      ...common(),
      servicePrincipals: unused('setPermissions', 'suspend', 'restore'),
      principals: unused('get'),
    },
    sources: {
      ...common(),
      service: unused('getVisible', 'list', 'create', 'update', 'pause', 'resume'),
      sources: unused('get'),
      projects: unused('get'),
      sessions: unused('authenticate', 'isReauthFresh'),
    },
    sourceNames: {
      ...common(),
      service: unused(
        'getVisible',
        'listRegisteredNames',
        'addRegisteredName',
        'removeRegisteredName',
        'enable',
        'preview',
      ),
      sources: unused('get'),
      registeredNames: unused('owner'),
      visibility: unused('setOrder'),
      projectSources: unused('list'),
      projects: unused('get'),
    },
    packages: unused('listProject', 'listOrganization', 'listVersions'),
    audit: unused('list', 'head'),
  };
}

function methodPaths(value: object, prefix: readonly string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, field]) => {
    const path = [...prefix, key];
    if (typeof field === 'function') return [path];
    return field !== null && typeof field === 'object' ? methodPaths(field, path) : [];
  });
}

function route(path = '/_pb/wave-b/:id', operationId = 'firstOperation'): RouteDefinition {
  return {
    method: 'GET',
    path,
    permission: null,
    api: { operationId, summary: 'Extension route', tags: [], responses: { 204: null } },
    handler: () => new Response(null, { status: 204 }),
  };
}

function extended(...routes: RouteDefinition[]) {
  return createApiModule({ ...dependencies(), extensions: [() => routes] });
}

afterEach(() => vi.restoreAllMocks());

describe('createApiModule', () => {
  it('registers exactly the wave-a method/path table once', () => {
    const { routes } = createApiModule(dependencies());
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...EXPECTED_ROUTES].sort());
    for (const r of routes) {
      expect(r.path.startsWith('/_pb/')).toBe(true);
      expect(r.api?.exempt === undefined && r.api?.operationId).toBeTruthy();
    }
  });

  it('calls every merged route factory exactly once', () => {
    const spies = [
      vi.spyOn(organization, 'organizationRoutes'),
      vi.spyOn(projects, 'projectRoutes'),
      vi.spyOn(access, 'accessRoutes'),
      vi.spyOn(projectAccess, 'projectAccessRoutes'),
      vi.spyOn(tokens, 'tokenRoutes'),
      vi.spyOn(servicePrincipals, 'servicePrincipalRoutes'),
      vi.spyOn(sources, 'sourceRoutes'),
      vi.spyOn(sourceNames, 'sourceNameRoutes'),
      vi.spyOn(packages, 'packageRoutes'),
      vi.spyOn(audit, 'auditRoutes'),
      vi.spyOn(permissions, 'myPermissionsRoute'),
      vi.spyOn(permissions, 'myProjectPermissionsRoute'),
    ];
    createApiModule(dependencies());
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('adds typed extension factories once through the same registration checks', () => {
    const extra = route();
    const extension = vi.fn(() => [extra]);
    const { routes } = createApiModule({ ...dependencies(), extensions: [extension] });
    expect(extension).toHaveBeenCalledTimes(1);
    expect(routes).toHaveLength(EXPECTED_ROUTES.length + 1);
    expect(routes.at(-1)).toEqual(extra);
    expect(Object.isFrozen(routes)).toBe(true);
  });

  it('rejects a duplicate method/path and names both operation ids', () => {
    expect(() => extended(route(), route('/_pb/wave-b/:id', 'secondOperation'))).toThrow(
      new TypeError('API routes conflict: firstOperation and secondOperation'),
    );
  });

  it('rejects the same path with different parameter names', () => {
    expect(() => extended(route(), route('/_pb/wave-b/:project', 'secondOperation'))).toThrow(
      new TypeError('API routes conflict: firstOperation and secondOperation'),
    );
  });

  it('checks extension routes against the built-in routes', () => {
    expect(() => extended(route('/_pb/projects/:id', 'extensionProject'))).toThrow(
      /getProject.*extensionProject/,
    );
  });

  it('allows different methods on the same path', () => {
    expect(extended(route(), { ...route(), method: 'POST' }).routes).toHaveLength(
      EXPECTED_ROUTES.length + 2,
    );
  });

  it('rejects a route outside the management prefix', () => {
    expect(() => extended(route('/public'))).toThrow(TypeError);
  });

  it('rejects a route without an api slot', () => {
    const { api: _api, ...bare } = route();
    void _api;
    expect(() => extended(bare)).toThrow(TypeError);
  });

  it('rejects an undocumented exempt route', () => {
    expect(() => extended({ ...route(), api: { exempt: 'extra exemption' } })).toThrow(TypeError);
  });

  const deps = dependencies();
  it.each(Object.keys(deps))('rejects missing dependency group %s at construction', (key) => {
    expect(() =>
      createApiModule({ ...dependencies(), [key]: undefined } as unknown as ApiModuleDeps),
    ).toThrow(TypeError);
  });

  const fields = Object.entries(deps).flatMap(([group, value]) =>
    Object.keys(value).map((field) => [group, field] as const),
  );
  it.each(fields)('rejects missing %s.%s at construction', (group, field) => {
    const broken = dependencies();
    const values = broken[group as keyof Omit<ApiModuleDeps, 'extensions'>];
    Object.assign(values, { [field]: undefined });
    expect(() => createApiModule(broken)).toThrow(TypeError);
  });

  it.each(['personal', 'service', 'revoke'] as const)('rejects missing token service %s', (key) => {
    const broken = dependencies();
    Reflect.deleteProperty(broken.tokens.tokens, key);
    expect(() => createApiModule(broken)).toThrow(TypeError);
  });

  const methods = methodPaths(dependencies()).map((path) => [path.join('.'), path] as const);
  it.each(methods)('rejects missing method %s at construction', (label, path) => {
    const broken = dependencies();
    let owner: object = broken;
    for (const field of path.slice(0, -1)) owner = Reflect.get(owner, field) as object;
    Reflect.deleteProperty(owner, path.at(-1)!);
    expect(() => createApiModule(broken)).toThrow(
      new TypeError(`API module requires dependency: dependencies.${label}`),
    );
  });

  it.each(methods)('rejects non-callable method %s without exposing its value', (label, path) => {
    const broken = dependencies();
    let owner: object = broken;
    for (const field of path.slice(0, -1)) owner = Reflect.get(owner, field) as object;
    Object.assign(owner, { [path.at(-1)!]: 'private-dependency-value' });
    expect(() => createApiModule(broken)).toThrow(
      new TypeError(`API module requires dependency: dependencies.${label}`),
    );
  });

  it('reports a missing dependency without including dependency values', () => {
    const sentinel = 'private-dependency-value';
    const broken = {
      ...dependencies(),
      organization: { administration: undefined, marker: sentinel },
    };
    let error: unknown;
    try {
      createApiModule(broken as unknown as ApiModuleDeps);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain(sentinel);
  });
});

describe('API_EXEMPT_ROUTES', () => {
  it('contains exactly the four documented exemptions, each with a reason', () => {
    expect(Object.keys(API_EXEMPT_ROUTES).sort()).toEqual(
      ['/_pb/ui', '/_pb/ui/assets/:file', '/_pb/mcp', '/_pb/openapi.json'].sort(),
    );
    for (const reason of Object.values(API_EXEMPT_ROUTES))
      expect(reason.trim().length).toBeGreaterThan(0);
    expect(Object.isFrozen(API_EXEMPT_ROUTES)).toBe(true);
  });
});
