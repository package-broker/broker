import { routesConflict } from '../kernel/routes.js';
import type { RouteDefinition } from '../plugin.js';
import { accessRoutes } from './routes/access.js';
import { auditRoutes } from './routes/audit.js';
import { importRoutes } from './routes/import.js';
import { organizationRoutes } from './routes/organization.js';
import { packageManageRoutes } from './routes/package-manage.js';
import { publishRoutes } from './routes/publishes.js';
import { packageRoutes } from './routes/packages.js';
import { myPermissionsRoute, myProjectPermissionsRoute } from './routes/permissions.js';
import { projectAccessRoutes } from './routes/project-access.js';
import { projectRoutes } from './routes/projects.js';
import { servicePrincipalRoutes } from './routes/service-principals.js';
import { sourceAttachmentRoutes } from './routes/source-attachment.js';
import { sourceNameRoutes } from './routes/source-names.js';
import { sourcePackageRoutes } from './routes/source-packages.js';
import { sourceRoutes } from './routes/sources.js';
import { tokenRoutes } from './routes/tokens.js';

/** Build-time extensions close over their required service and reader dependencies. */
export type ApiRouteFactory = () => readonly RouteDefinition[];

export interface ApiModuleDeps {
  readonly publishes: Parameters<typeof publishRoutes>[0];
  readonly organization: Parameters<typeof organizationRoutes>[0];
  readonly projects: Parameters<typeof projectRoutes>[0];
  readonly access: Parameters<typeof accessRoutes>[0];
  readonly projectAccess: Parameters<typeof projectAccessRoutes>[0];
  readonly tokens: Parameters<typeof tokenRoutes>[0];
  readonly servicePrincipals: Omit<
    Parameters<typeof servicePrincipalRoutes>[0],
    'sessions' | 'projects' | 'idempotency'
  >;
  readonly sourcePackages: Parameters<typeof sourcePackageRoutes>[0];
  readonly sources: Parameters<typeof sourceRoutes>[0];
  readonly sourceNames: Parameters<typeof sourceNameRoutes>[0];
  readonly sourceAttachments: Parameters<typeof sourceAttachmentRoutes>[0];
  readonly packages: Parameters<typeof packageRoutes>[0];
  readonly audit: Parameters<typeof auditRoutes>[0];
  readonly packageManage: Parameters<typeof packageManageRoutes>[0];
  /** Import routes are mounted only when provided; they need a blob store. */
  readonly imports?: Parameters<typeof importRoutes>[0];
  readonly extensions?: readonly ApiRouteFactory[];
}

export const API_EXEMPT_ROUTES = Object.freeze({
  '/_pb/ui': 'Serves the management UI HTML document.',
  '/_pb/ui/assets/:file': 'Serves static management UI assets.',
  '/_pb/mcp': 'Uses the MCP protocol transport.',
  '/_pb/openapi.json': 'Serves the generated OpenAPI document.',
});

type RouteDependencies = Omit<ApiModuleDeps, 'extensions' | 'imports'> &
  Required<Pick<ApiModuleDeps, 'imports'>>;
type DependencyRequirements<T> = {
  readonly [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? true
    : DependencyRequirements<T[K]> | null;
};
const CONTEXT_METHODS = { ids: { ulid: true }, clock: { now: true }, clientIp: true } as const;
const REQUIRED_DEPENDENCIES = {
  publishes: { ...CONTEXT_METHODS, publishes: { get: true, list: true, decide: true } },
  organization: {
    ...CONTEXT_METHODS,
    organizations: { get: true },
    users: { list: true, get: true },
    administration: { suspendUser: true, reactivateUser: true },
    lifetime: null,
  },
  projects: {
    ...CONTEXT_METHODS,
    lister: { list: true },
    service: {
      createProject: true,
      updateSettings: true,
      archiveProject: true,
      restoreProject: true,
    },
    projects: { get: true, getBySlug: true },
    idempotency: { find: true },
  },
  access: {
    ...CONTEXT_METHODS,
    administration: {
      listRoles: true,
      createRole: true,
      renameRole: true,
      setRolePermissions: true,
      deleteRole: true,
      grantOrganization: true,
      changeGrantRole: true,
      revokeOrganizationGrant: true,
    },
    grants: { listOrganization: true },
  },
  projectAccess: {
    ...CONTEXT_METHODS,
    projectAdministration: { grant: true, changeRole: true, revoke: true },
    reader: { list: true },
    roles: { get: true },
  },
  tokens: {
    ...CONTEXT_METHODS,
    tokens: {
      personal: { issue: true },
      service: { issue: true, rotate: true },
      revoke: { revoke: true },
    },
    reader: {
      listOwn: true,
      listProject: true,
      listOrganization: true,
      getOwn: true,
      getProject: true,
      getOrganization: true,
    },
    idempotency: { find: true },
    sessions: { authenticate: true },
    organizations: { get: true },
    lifetime: null,
  },
  servicePrincipals: {
    ...CONTEXT_METHODS,
    servicePrincipals: { create: true, setPermissions: true, suspend: true, restore: true },
    principals: { get: true, list: true },
  },
  sources: {
    ...CONTEXT_METHODS,
    service: {
      getVisible: true,
      list: true,
      create: true,
      update: true,
      pause: true,
      resume: true,
    },
    sources: { get: true },
    projectSources: { list: true },
    projects: { get: true },
    sessions: { authenticate: true, isReauthFresh: true },
  },
  sourceNames: {
    ...CONTEXT_METHODS,
    service: {
      getVisible: true,
      listRegisteredNames: true,
      addRegisteredName: true,
      removeRegisteredName: true,
      enable: true,
      preview: true,
    },
    sources: { get: true },
    registeredNames: { owner: true },
    visibility: { setOrder: true },
    projectSources: { list: true },
    projects: { get: true },
  },
  sourceAttachments: {
    ...CONTEXT_METHODS,
    sources: { get: true },
    visibility: { attachSource: true, detachSource: true },
    projectSources: { list: true },
    projects: { get: true },
  },
  sourcePackages: {
    ...CONTEXT_METHODS,
    sources: { get: true },
    projects: { get: true },
    projectSources: { list: true },
    store: { request: true, present: true },
    probe: true,
  },
  packages: { listProject: true, listOrganization: true, listVersions: true },
  audit: { list: true, head: true },
  packageManage: {
    ...CONTEXT_METHODS,
    service: { manage: true },
    sessions: { authenticate: true, isReauthFresh: true },
    idempotency: { find: true },
  },
  imports: {
    ...CONTEXT_METHODS,
    service: {
      get: true,
      list: true,
      createRun: true,
      approveRun: true,
      requestApply: true,
      requestVerify: true,
      cancelRun: true,
      acceptRun: true,
      requestRollback: true,
    },
    credentials: { acceptImportCredential: true },
    auditStatement: true,
    tokenFence: true,
  },
} as const satisfies {
  [K in keyof RouteDependencies]: DependencyRequirements<RouteDependencies[K]>;
};

interface Requirements {
  readonly [field: string]: true | null | Requirements;
}

export class ApiModuleDependencyError extends TypeError {
  constructor(readonly dependency: string) {
    super(`API module requires dependency: ${dependency}`);
  }
}

function requireDependencies(value: unknown, requirements: Requirements, label: string): void {
  if (value === null || typeof value !== 'object') {
    throw new ApiModuleDependencyError(label);
  }
  for (const [field, requirement] of Object.entries(requirements)) {
    const dependency = (value as Record<string, unknown>)[field];
    const path = `${label}.${field}`;
    if (dependency == null || (requirement === true && typeof dependency !== 'function')) {
      throw new ApiModuleDependencyError(path);
    }
    if (requirement !== true && requirement !== null) {
      requireDependencies(dependency, requirement, path);
    }
  }
}

function operationId(route: RouteDefinition): string {
  return route.api?.exempt === undefined ? (route.api?.operationId ?? '<missing>') : '<exempt>';
}

export function createApiModule(deps: ApiModuleDeps): { routes: readonly RouteDefinition[] } {
  const { imports, ...required } = REQUIRED_DEPENDENCIES;
  requireDependencies(deps, required, 'dependencies');
  if (deps.imports != null) requireDependencies(deps, { imports }, 'dependencies');
  if (deps.packageManage.rebuild !== undefined) {
    requireDependencies(
      deps.packageManage.rebuild,
      { requestTagRebuild: true },
      'dependencies.packageManage.rebuild',
    );
  }
  if (deps.sources.service.acceptRemoval !== undefined) {
    requireDependencies(
      deps.sources.service,
      { acceptRemoval: true },
      'dependencies.sources.service',
    );
  }

  const routes = [
    ...organizationRoutes(deps.organization),
    ...projectRoutes(deps.projects),
    ...accessRoutes(deps.access),
    ...projectAccessRoutes(deps.projectAccess),
    ...tokenRoutes(deps.tokens),
    ...servicePrincipalRoutes({
      ...deps.servicePrincipals,
      sessions: deps.tokens.sessions,
      projects: deps.projects.projects,
      idempotency: deps.tokens.idempotency,
    }),
    ...sourceRoutes(deps.sources),
    ...sourcePackageRoutes(deps.sourcePackages),
    ...sourceNameRoutes(deps.sourceNames),
    ...sourceAttachmentRoutes(deps.sourceAttachments),
    ...packageRoutes(deps.packages),
    ...publishRoutes(deps.publishes),
    ...auditRoutes(deps.audit),
    ...packageManageRoutes(deps.packageManage),
    ...(deps.imports == null ? [] : importRoutes(deps.imports)),
    myPermissionsRoute(),
    myProjectPermissionsRoute(),
    ...(deps.extensions ?? []).flatMap((factory) => factory()),
  ];

  const registered: RouteDefinition[] = [];
  for (const route of routes) {
    if (!route.path.startsWith('/_pb/')) {
      throw new TypeError('API route must be under /_pb/');
    }
    if (route.api == null) {
      throw new TypeError('API route requires an api slot');
    }
    if (route.api.exempt !== undefined && !Object.hasOwn(API_EXEMPT_ROUTES, route.path)) {
      throw new TypeError('API route exemption is not documented');
    }
    const conflict = registered.find((other) => routesConflict(other, route));
    if (conflict !== undefined) {
      throw new TypeError(
        `API routes conflict: ${operationId(conflict)} and ${operationId(route)}`,
      );
    }
    registered.push(route);
  }
  return Object.freeze({ routes: Object.freeze(registered) });
}
