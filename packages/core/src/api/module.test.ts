import { ulid } from '../ids.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../ids.js';
import { createAuthorizationEngine, patValidationGate } from '../authz/engine.js';
import type { EngineAccessPort, EngineTokenAccess } from '../authz/engine.js';
import { orgContext } from '../db/port.js';
import { createKeyring } from '../secrets/keyring.js';
import { formatToken } from '../secrets/token-format.js';
import { hashToken } from '../secrets/token-hash.js';
import type { RouteDefinition } from '../plugin.js';
import {
  API_EXEMPT_ROUTES,
  ApiModuleDependencyError,
  createApiModule,
  type ApiModuleDeps,
} from './module.js';
import * as organization from './routes/organization.js';
import * as projects from './routes/projects.js';
import * as access from './routes/access.js';
import * as projectAccess from './routes/project-access.js';
import * as tokens from './routes/tokens.js';
import * as servicePrincipals from './routes/service-principals.js';
import * as sources from './routes/sources.js';
import * as sourceNames from './routes/source-names.js';
import * as sourceAttachment from './routes/source-attachment.js';
import * as packages from './routes/packages.js';
import * as audit from './routes/audit.js';
import * as permissions from './routes/permissions.js';
import * as packageManage from './routes/package-manage.js';
import * as importRuns from './routes/import.js';

const EXPECTED_ROUTES = [
  'PATCH /_pb/sources/:source/names/:name',
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
  'GET /_pb/projects/:project/grants',
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
  'POST /_pb/service-principals',
  'GET /_pb/service-principals',
  'GET /_pb/service-principals/:principal',
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
  'POST /_pb/sources/:source/sync',
  'POST /_pb/sources/:source/resume',
  'PUT /_pb/sources/:source/credential',
  'GET /_pb/projects/:project/sources',
  'POST /_pb/projects/:project/sources',
  'PATCH /_pb/projects/:project/sources/:source',
  'POST /_pb/projects/:project/sources/:source/pause',
  'POST /_pb/projects/:project/sources/:source/sync',
  'POST /_pb/projects/:project/sources/:source/packages',
  'POST /_pb/projects/:project/sources/:source/resume',
  'PUT /_pb/projects/:project/sources/:source/credential',
  'GET /_pb/sources/:source/names',
  'POST /_pb/sources/:source/names',
  'DELETE /_pb/sources/:source/names/:name',
  'POST /_pb/sources/:source/enable',
  'PUT /_pb/projects/:project/sources/order',
  'PUT /_pb/projects/:project/sources/:source/attachment',
  'DELETE /_pb/projects/:project/sources/:source/attachment',
  'GET /_pb/projects/:project/resolve',
  'GET /_pb/publishes',
  'GET /_pb/publishes/:id',
  'POST /_pb/publishes/:id/approve',
  'POST /_pb/publishes/:id/reject',
  'GET /_pb/packages',
  'GET /_pb/packages/:package/versions',
  'GET /_pb/projects/:project/packages',
  'GET /_pb/projects/:project/packages/:package/versions',
  'GET /_pb/audit',
  'GET /_pb/audit/head',
  'GET /_pb/projects/:project/audit',
  'GET /_pb/me/permissions',
  'GET /_pb/projects/:project/permissions',
  'POST /_pb/packages/:package/versions/:version/quarantine',
  'POST /_pb/packages/:package/versions/:version/tombstone',
  'POST /_pb/packages/:package/versions/:version/release',
  'POST /_pb/projects/:project/packages/:package/versions/:version/quarantine',
  'POST /_pb/projects/:project/packages/:package/versions/:version/tombstone',
  'POST /_pb/projects/:project/packages/:package/versions/:version/release',
];
const IMPORT_ROUTES = [
  'POST /_pb/import-runs',
  'GET /_pb/import-runs',
  'GET /_pb/import-runs/:id',
  'POST /_pb/import-runs/:id/verify',
  'POST /_pb/import-runs/:id/approve',
  'POST /_pb/import-runs/:id/apply',
  'POST /_pb/import-runs/:id/rollback',
  'POST /_pb/import-runs/:id/accept',
  'POST /_pb/import-runs/:id/cancel',
  'PUT /_pb/import-runs/:id/credentials/:externalRef',
];
const REBUILD_ROUTE = 'POST /_pb/packages/:package/versions/:version/rebuild';
const ACCEPT_REMOVAL_ROUTE = 'POST /_pb/sources/:source/accept-removal';

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
      reader: unused('list'),
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
      servicePrincipals: unused('create', 'setPermissions', 'suspend', 'restore'),
      principals: unused('get', 'list'),
    },
    sourcePackages: {
      ...common(),
      sources: unused('get'),
      projects: unused('get'),
      projectSources: unused('list'),
      store: unused('request', 'present'),
      probe: vi.fn(),
    },
    sources: {
      ...common(),
      service: unused('getVisible', 'list', 'create', 'update', 'pause', 'resume'),
      sources: unused('get'),
      projectSources: unused('list'),
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
    sourceAttachments: {
      ...common(),
      sources: unused('get'),
      visibility: unused('attachSource', 'detachSource'),
      projectSources: unused('list'),
      projects: unused('get'),
    },
    packages: unused('listProject', 'listOrganization', 'listVersions'),
    audit: unused('list', 'head'),
    publishes: {
      ids: { ulid },
      clock: { now: () => new Date() },
      clientIp: () => null,
      publishes: {
        get: async () => null,
        list: async () => ({ items: [], next: null }),
        decide: async () => ({ changed: false, active: false, revision: 1 }),
      },
    },
    packageManage: {
      ...common(),
      service: unused('manage'),
      sessions: unused('authenticate', 'isReauthFresh'),
      idempotency: unused('find'),
    },
    imports: {
      ...common(),
      service: unused(
        'get',
        'list',
        'createRun',
        'approveRun',
        'requestApply',
        'requestVerify',
        'cancelRun',
        'acceptRun',
        'requestRollback',
      ),
      credentials: unused('acceptImportCredential'),
      auditStatement: vi.fn(),
      tokenFence: vi.fn(),
    },
  };
}

function withoutImports(): ApiModuleDeps {
  const { imports: _imports, ...rest } = dependencies();
  void _imports;
  return rest;
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

describe.each(
  createApiModule(dependencies()).routes.filter((route) =>
    route.path.split('/').includes(':project'),
  ),
)('$method $path token cap', (route) => {
  it.each(['pat', 'svc'] as const)(
    'conceals excluded and absent projects from a %s',
    async (kind) => {
      const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
      const token = formatToken(kind, 'abcdefghijkl', new Uint8Array(32).fill(9));
      const verifier = { secretHash: await hashToken(keyring, 1, token), pepperVersion: 1 };
      const touch = vi.fn(async () => true);
      const lookupToken = vi.fn<EngineAccessPort['lookupToken']>(async (_ctx, input) => {
        const project =
          input.boundary === 'project' && input.projectSlug === 'alpha' ? { id: 'proj-a' } : null;
        return Object.defineProperty(
          {
            token: {
              id: 'token-1',
              kind,
              bindingOk: true,
              projectMode: 'selected',
              boundProjectIds: ['proj-a'],
              scope: { level: 'read', readOnly: true },
              expired: false,
              revoked: false,
              lastUsedAt: null,
              userId: kind === 'pat' ? 'user-1' : null,
              servicePrincipalId: kind === 'svc' ? 'service-1' : null,
            },
            principalStatus: 'active',
            validation: { kind: 'local', identityId: null, fresh: true, evidenceAt: null },
            organizationPermissions: [],
            projectPermissions: project === null ? [] : ['project:read'],
            project,
            projectVisible: input.projectSlug === 'beta',
          } satisfies Omit<EngineTokenAccess, 'verifier'>,
          'verifier',
          { value: verifier },
        ) as unknown as EngineTokenAccess;
      });
      const engine = createAuthorizationEngine({
        access: {
          lookupToken,
          lookupSession: async () => null,
          touchSession: touch,
          touchToken: touch,
        },
        tokenUse: { keyring, nowMs: () => 0, dispatch: vi.fn(), log: vi.fn() },
        patValidation: patValidationGate,
        publicOrigin: 'https://broker.test',
        providerAnchors: async () => [],
      });
      const authorize = (project: string) =>
        engine.authorize({
          org: orgContext('org-1'),
          route: { ...route, plugin: 'core', permission: route.permission! },
          params: { project },
          request: new Request('https://broker.test', {
            method: route.method,
            headers: { authorization: `Bearer ${token}` },
          }),
        });
      expect(await authorize('nowhere')).toEqual({ allow: false, status: 404 });
      expect(await authorize('beta')).toEqual({ allow: false, status: 404 });
      if (route.boundary === 'organization') {
        expect(await authorize('alpha')).toEqual({ allow: false, status: 403 });
        expect(lookupToken).toHaveBeenCalledWith(
          orgContext('org-1'),
          expect.objectContaining({
            boundary: 'project',
            projectSlug: 'beta',
            allowArchived: true,
          }),
        );
      }
      expect(touch).not.toHaveBeenCalled();
    },
  );
});

describe('createApiModule', () => {
  it('registers exactly the method/path table once', () => {
    const { routes } = createApiModule(dependencies());
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [...EXPECTED_ROUTES, ...IMPORT_ROUTES].sort(),
    );
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
      vi.spyOn(sourceAttachment, 'sourceAttachmentRoutes'),
      vi.spyOn(packages, 'packageRoutes'),
      vi.spyOn(audit, 'auditRoutes'),
      vi.spyOn(permissions, 'myPermissionsRoute'),
      vi.spyOn(permissions, 'myProjectPermissionsRoute'),
    ];
    createApiModule(dependencies());
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('omits the import routes when no import dependencies are provided', () => {
    const { routes } = createApiModule(withoutImports());
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...EXPECTED_ROUTES].sort());
  });

  it('registers the rebuild route only when a rebuild port is provided', () => {
    const deps = withoutImports();
    const rebuild = { requestTagRebuild: vi.fn() };
    const { routes } = createApiModule({
      ...deps,
      packageManage: { ...deps.packageManage, rebuild },
    });
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [...EXPECTED_ROUTES, REBUILD_ROUTE].sort(),
    );
  });

  it('rejects a rebuild port missing requestTagRebuild at construction', () => {
    const deps = dependencies();
    Object.assign(deps.packageManage, { rebuild: {} });
    expect(() => createApiModule(deps)).toThrow(
      new ApiModuleDependencyError('dependencies.packageManage.rebuild.requestTagRebuild'),
    );
  });

  it('rejects a non-callable rebuild method without exposing its value', () => {
    const deps = dependencies();
    Object.assign(deps.packageManage, {
      rebuild: { requestTagRebuild: 'private-dependency-value' },
    });
    expect(() => createApiModule(deps)).toThrow(
      new ApiModuleDependencyError('dependencies.packageManage.rebuild.requestTagRebuild'),
    );
  });

  it('omits the accept-removal route when the service method is absent', () => {
    const deps = dependencies();
    expect(sources.sourceRoutes(deps.sources).map((r) => `${r.method} ${r.path}`)).not.toContain(
      ACCEPT_REMOVAL_ROUTE,
    );
    expect(createApiModule(deps).routes.map((r) => `${r.method} ${r.path}`)).not.toContain(
      ACCEPT_REMOVAL_ROUTE,
    );
  });

  it('registers the accept-removal route when its service method is provided', () => {
    const deps = dependencies();
    Object.assign(deps.sources.service, { acceptRemoval: vi.fn() });
    expect(
      createApiModule(deps)
        .routes.map((r) => `${r.method} ${r.path}`)
        .sort(),
    ).toEqual([...EXPECTED_ROUTES, ...IMPORT_ROUTES, ACCEPT_REMOVAL_ROUTE].sort());
  });

  it.each([null, 'private-dependency-value'])(
    'rejects a non-callable acceptRemoval method at construction (case %#)',
    (acceptRemoval) => {
      const deps = dependencies();
      Object.assign(deps.sources.service, { acceptRemoval });
      expect(() => createApiModule(deps)).toThrow(
        new ApiModuleDependencyError('dependencies.sources.service.acceptRemoval'),
      );
    },
  );

  it('calls the package manage and import factories exactly once', () => {
    const manage = vi.spyOn(packageManage, 'packageManageRoutes');
    const imports = vi.spyOn(importRuns, 'importRoutes');
    createApiModule(dependencies());
    expect(manage).toHaveBeenCalledTimes(1);
    expect(imports).toHaveBeenCalledTimes(1);
  });

  it('adds typed extension factories once through the same registration checks', () => {
    const extra = route();
    const extension = vi.fn(() => [extra]);
    const { routes } = createApiModule({ ...dependencies(), extensions: [extension] });
    expect(extension).toHaveBeenCalledTimes(1);
    expect(routes).toHaveLength(EXPECTED_ROUTES.length + IMPORT_ROUTES.length + 1);
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
      EXPECTED_ROUTES.length + IMPORT_ROUTES.length + 2,
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
  it.each(Object.keys(deps).filter((key) => key !== 'imports'))(
    'rejects missing dependency group %s at construction',
    (key) => {
      expect(() =>
        createApiModule({ ...dependencies(), [key]: undefined } as unknown as ApiModuleDeps),
      ).toThrow(TypeError);
    },
  );

  const fields = Object.entries(deps).flatMap(([group, value]) =>
    Object.keys(value).map((field) => [group, field] as const),
  );
  it.each(fields)('rejects missing %s.%s at construction', (group, field) => {
    const broken = dependencies();
    const values = broken[group as keyof Omit<ApiModuleDeps, 'extensions'>]!;
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
      new ApiModuleDependencyError(`dependencies.${label}`),
    );
  });

  it.each(methods)('rejects non-callable method %s without exposing its value', (label, path) => {
    const broken = dependencies();
    let owner: object = broken;
    for (const field of path.slice(0, -1)) owner = Reflect.get(owner, field) as object;
    Object.assign(owner, { [path.at(-1)!]: 'private-dependency-value' });
    expect(() => createApiModule(broken)).toThrow(
      new ApiModuleDependencyError(`dependencies.${label}`),
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
    expect(error).toBeInstanceOf(ApiModuleDependencyError);
    expect((error as ApiModuleDependencyError).dependency).toBe('dependencies.organization.ids');
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

it('refuses an incomplete package access request assembly before serving', () => {
  expect(() => createApiModule({ ...dependencies(), packageAccessRequests: {} as never })).toThrow(
    'API module requires dependency: dependencies.packageAccessRequests.ids',
  );
});
