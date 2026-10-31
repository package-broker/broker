import * as packageDetail from '@package-broker/core/api/routes/package-detail-schemas';
import * as packageAccessRequests from '@package-broker/core/api/routes/package-access-requests-schemas';
import { createApiModule, type ApiModuleDeps } from '@package-broker/core/api/module';
import { AUTH_API } from '@package-broker/core/api/auth-schemas';
import type { ApiRouteSpec } from '@package-broker/core/api/route';
import * as access from '@package-broker/core/api/routes/access-schemas';
import * as imports from '@package-broker/core/api/routes/import.schemas';
import * as organization from '@package-broker/core/api/routes/organization-schemas';
import * as packages from '@package-broker/core/api/routes/packages-schemas';
import * as projectAccess from '@package-broker/core/api/routes/project-access-schemas';
import * as projects from '@package-broker/core/api/routes/projects-schemas';
import * as servicePrincipals from '@package-broker/core/api/routes/service-principals-schemas';
import * as sourceAttachments from '@package-broker/core/api/routes/source-attachment-schemas';
import * as sourceNames from '@package-broker/core/api/routes/source-names-schemas';
import * as sources from '@package-broker/core/api/routes/sources-schemas';
import * as publishes from '@package-broker/core/api/routes/publishes-schemas';
import * as tokens from '@package-broker/core/api/routes/tokens-schemas';
import type { ApiSlot } from '@package-broker/core/plugin';

const MAX_STUB_ROUNDS = 1000;
const MISSING = /^API module requires dependency: dependencies\.(.+)$/;

/** Route construction never calls a dependency, so each required one is satisfied by a stub. */
function stubDependencies(): ApiModuleDeps {
  const deps: Record<string, unknown> = {
    imports: {},
    packageAccessRequests: {},
    packageDetail: {},
    sources: { service: { acceptRemoval: () => undefined } },
  };
  for (let round = 0; round < MAX_STUB_ROUNDS; round += 1) {
    try {
      createApiModule(deps as unknown as ApiModuleDeps);
      return deps as unknown as ApiModuleDeps;
    } catch (error) {
      const path = MISSING.exec(error instanceof Error ? error.message : '')?.[1]?.split('.');
      if (path === undefined) throw error;
      let holder = deps;
      for (const key of path.slice(0, -1)) holder = holder[key] as Record<string, unknown>;
      const leaf = path[path.length - 1]!;
      holder[leaf] = holder[leaf] === undefined ? {} : () => undefined;
    }
  }
  throw new Error('api_module_stub_failed');
}

function declaredSpecs(): Map<string, ApiRouteSpec> {
  const byOperation = new Map<string, ApiRouteSpec>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === 'object') {
      const spec = value as Partial<ApiRouteSpec>;
      if (typeof spec.method === 'string' && typeof spec.api?.operationId === 'string') {
        byOperation.set(spec.api.operationId, spec as ApiRouteSpec);
      }
    }
  };
  for (const module of [
    access,
    imports,
    organization,
    packages,
    packageDetail,
    packageAccessRequests,
    projectAccess,
    projects,
    servicePrincipals,
    sourceAttachments,
    sourceNames,
    sources,
    tokens,
    publishes,
  ]) {
    Object.values(module).forEach(collect);
  }
  return byOperation;
}

/** The specs behind the served document: the API module routes plus the auth routes. */
export function servedApiSpecs(): readonly ApiRouteSpec[] {
  const declared = declaredSpecs();
  const specs: ApiRouteSpec[] = [];
  for (const route of createApiModule(stubDependencies()).routes) {
    if (route.api === undefined || 'exempt' in route.api) continue;
    const source = declared.get(route.api.operationId);
    specs.push({
      method: route.method,
      path: route.path,
      permission: route.permission,
      ...(route.boundary === undefined ? {} : { boundary: route.boundary }),
      ...(route.allowArchived === true ? { allowArchived: true as const } : {}),
      ...(source?.concurrency === undefined ? {} : { concurrency: source.concurrency }),
      ...(source?.service === undefined ? {} : { service: source.service }),
      api: route.api,
    });
  }
  for (const [key, api] of Object.entries(AUTH_API) as [string, ApiSlot][]) {
    const [method, path] = key.split(' ') as [ApiRouteSpec['method'], string];
    specs.push({ method, path, permission: null, api });
  }
  return specs;
}
