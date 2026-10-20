import { PACKAGE_BOUNDARY_PERMISSIONS } from '../authz/project-actor.js';
import type { PackageVisibilityPort } from '../db/catalogue.js';
import { catalogueTokenEligible } from '../authz/catalogue.js';
import { PERMISSIONS } from '../authz/permissions.js';
import type { PackageEcosystem, RouteDefinition as PluginRouteDefinition } from '../plugin.js';

export interface RouteDefinition extends PluginRouteDefinition {
  readonly bearerOnly?: true;
}

export const RESERVED_PATH_PREFIXES = ['/health/', '/_pb/'] as const;

const LITERAL = /^[A-Za-z0-9._~-]+$/;
const PARAMETER = /^:[a-zA-Z][a-zA-Z0-9]*$/;

export function routePathProblem(path: string): string | null {
  const label = JSON.stringify(path);
  if (!path.startsWith('/')) {
    return `route path ${label} must start with "/"`;
  }
  if (path === '/') {
    return null;
  }
  if (path === '/health' || path === '/_pb') {
    return `route path ${label} is reserved for core`;
  }
  if (RESERVED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return `route path ${label} is under a reserved core prefix (${RESERVED_PATH_PREFIXES.join(', ')})`;
  }
  const segments = path.slice(1).split('/');
  const seen = new Set<string>();
  for (const segment of segments) {
    if (segment === '') {
      return `route path ${label} must not contain an empty segment or a trailing slash`;
    }
    if (PARAMETER.test(segment)) {
      if (seen.has(segment)) {
        return `route path ${label} repeats parameter "${segment}"; each parameter name may appear once`;
      }
      seen.add(segment);
    } else if (!LITERAL.test(segment)) {
      return `route path ${label} has invalid segment "${segment}"; use [A-Za-z0-9._~-]+ or :name`;
    }
  }
  return null;
}

type RouteKey = { readonly method: string; readonly path: string };

export function routesConflict(a: RouteKey, b: RouteKey): boolean {
  if (a.method.toUpperCase() !== b.method.toUpperCase()) {
    return false;
  }
  const left = a.path.split('/');
  const right = b.path.split('/');
  if (left.length !== right.length) {
    return false;
  }
  return left.every((segment, i) => {
    const other = right[i] as string;
    return segment === other || segment.startsWith(':') || other.startsWith(':');
  });
}

type OwnedRouteKey = RouteKey & { readonly owner: 'core' | 'ecosystem' | 'plugin' };

export function ownedRoutesConflict(a: OwnedRouteKey, b: OwnedRouteKey): boolean {
  if (!routesConflict(a, b)) return false;
  if (a.owner !== 'ecosystem' || b.owner !== 'ecosystem') return true;
  const right = b.path.split('/');
  return !a.path
    .split('/')
    .some((segment, i) => segment.startsWith(':') !== right[i]!.startsWith(':'));
}

export function compareRoutePrecedence(a: RouteKey, b: RouteKey): number {
  const left = a.path.split('/');
  const right = b.path.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = Number(left[i]!.startsWith(':')) - Number(right[i]!.startsWith(':'));
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

const BOUNDARIES: ReadonlySet<string> = new Set([
  'none',
  'organization',
  'project',
  'self',
  'package',
  'authenticated',
]);
const PROJECT_PARAMETER = ':project';
const PACKAGE_PERMISSION_PREFIX = 'project:packages:';
export const PACKAGE_ECOSYSTEMS = [
  'composer',
  'npm',
] as const satisfies readonly PackageEcosystem[];
const ECOSYSTEM_NAMES: ReadonlySet<string> = new Set(PACKAGE_ECOSYSTEMS);
const BOUNDARY_API_VERSION = 3;
const MAX_REPORTED_LENGTH = 80;

export interface RouteBoundaryOptions {
  readonly packageResolver?: PackageVisibilityPort;
  /** Set for plugin routes: the declaring plugin's apiVersion. Absent for core routes. */
  readonly apiVersion?: number;
  /** Only core routes may be 'self'. */
  readonly allowSelf?: boolean;
  /** Only core routes may be 'authenticated'. */
  readonly allowAuthenticated?: boolean;
}

interface BoundaryInput {
  readonly method?: unknown;
  readonly path: unknown;
  readonly permission: unknown;
  readonly boundary?: unknown;
  readonly bearerOnly?: unknown;
  readonly allowArchived?: unknown;
  readonly needsOrg?: unknown;
  readonly package?: unknown;
}

function packageBindingProblems(binding: unknown, route: BoundaryInput): string[] {
  if (typeof binding !== 'object' || binding === null) {
    return ['the package boundary requires a package binding'];
  }
  const { ecosystem, name, fetchOnAdmission } = binding as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof ecosystem !== 'string' || !ECOSYSTEM_NAMES.has(ecosystem)) {
    problems.push(
      `the package binding has unknown ecosystem ${reported(ecosystem)}; use ${PACKAGE_ECOSYSTEMS.join(' or ')}`,
    );
  }
  if (typeof name !== 'function') {
    problems.push('the package binding requires a name extractor function');
  }
  if (fetchOnAdmission !== undefined && typeof fetchOnAdmission !== 'boolean') {
    problems.push('the package binding fetchOnAdmission must be a boolean');
  }
  if (
    fetchOnAdmission === true &&
    (route.method !== 'GET' || route.permission !== 'project:packages:read')
  ) {
    problems.push('fetchOnAdmission requires GET with project:packages:read');
  }
  return problems;
}

function hasVisibilityPort(resolver: unknown): boolean {
  return (
    typeof resolver === 'object' &&
    resolver !== null &&
    typeof (resolver as { resolve?: unknown }).resolve === 'function'
  );
}

function reported(value: unknown): string {
  return typeof value === 'string'
    ? JSON.stringify(value.slice(0, MAX_REPORTED_LENGTH))
    : `of type ${typeof value}`;
}

export function routeBoundaryProblems(
  route: BoundaryInput,
  label: string,
  options: RouteBoundaryOptions = {},
): string[] {
  const problems: string[] = [];
  const fail = (message: string): void => {
    problems.push(`${label}: ${message}`);
  };
  const { permission, boundary } = route;
  const path = typeof route.path === 'string' ? route.path : '';
  const hasProject = path.split('/').includes(PROJECT_PARAMETER);

  if (boundary !== undefined && (typeof boundary !== 'string' || !BOUNDARIES.has(boundary))) {
    fail(`unknown boundary ${reported(boundary)}`);
    return problems;
  }
  if (permission !== null && typeof permission !== 'string') {
    fail('permission must be a string or null');
    return problems;
  }
  if (boundary !== undefined && options.apiVersion !== undefined) {
    if (options.apiVersion < BOUNDARY_API_VERSION) {
      fail(`declaring a boundary requires apiVersion ${BOUNDARY_API_VERSION}`);
    }
  }
  if (boundary === 'package') {
    if (!hasVisibilityPort(options.packageResolver)) {
      fail('the package boundary is reserved until a package resolver exists');
      return problems;
    }
    for (const problem of packageBindingProblems(route.package, route)) fail(problem);
    if (!hasProject) fail('the package boundary requires :project in the path');
    if (typeof permission !== 'string' || !PACKAGE_BOUNDARY_PERMISSIONS.has(permission)) {
      fail(
        `the package boundary is reserved for ${[...PACKAGE_BOUNDARY_PERMISSIONS].join(' or ')}, got ${permission === null ? 'null' : reported(permission)}`,
      );
    }
  } else if (route.package !== undefined) {
    fail('a package binding is only allowed on the package boundary');
  }
  if (boundary === 'self' && options.allowSelf !== true) {
    fail('the self boundary is not available to plugin routes');
  }

  const allowArchived = route.allowArchived;
  if (allowArchived !== undefined) {
    if (allowArchived !== true) fail('allowArchived must be true when set');
    if (boundary !== 'project') fail('allowArchived requires the project boundary');
    if (typeof permission !== 'string' || catalogueTokenEligible(permission)) {
      fail('allowArchived requires a session-only permission');
    }
  }

  if (route.bearerOnly !== undefined) {
    if (route.bearerOnly !== true) fail('bearerOnly must be true when set');
    if (options.apiVersion !== undefined || options.allowAuthenticated !== true) {
      fail('bearerOnly is not available to plugin routes');
    }
    if (boundary !== 'authenticated' || permission !== null) {
      fail('bearerOnly requires the authenticated boundary and permission null');
    }
    if (route.method !== 'POST' || path !== '/_pb/mcp') {
      fail('bearerOnly requires POST /_pb/mcp');
    }
  }

  if (boundary === 'authenticated') {
    if (options.allowAuthenticated !== true) {
      fail('the authenticated boundary is not available to plugin routes');
    }
    if (route.method !== 'GET' && route.bearerOnly !== true) {
      fail('an authenticated route must be a GET route');
    }
    if (hasProject) fail('an authenticated route must not have :project in its path');
    if (route.needsOrg === false) fail('an authenticated route needs organization context');
  }

  if (permission === null) {
    if (boundary === 'self') {
      if (hasProject) fail('a self route must not have :project in its path');
    } else if (boundary !== undefined && boundary !== 'none' && boundary !== 'authenticated') {
      fail(`a public route (permission null) cannot have the ${boundary} boundary`);
    }
    return problems;
  }

  if (route.needsOrg === false) {
    fail('a route without organization context must be public');
  }
  const info = PERMISSIONS.find((entry) => entry.name === permission);
  if (info === undefined) {
    fail(`unknown permission ${reported(permission)}`);
    return problems;
  }
  if (boundary === undefined || boundary === 'none') {
    fail('a protected route needs an explicit boundary (organization or project)');
  } else if (boundary === 'self') {
    fail('a self route must not require a permission');
  } else if (boundary === 'authenticated') {
    fail('an authenticated route must not require a permission');
  } else if (boundary === 'organization') {
    if (info.scope !== 'organization') {
      fail(`the organization boundary requires an org:* permission, got "${permission}"`);
    }
  } else if (boundary === 'project') {
    if (info.scope !== 'project') {
      fail(`the project boundary requires a project:* permission, got "${permission}"`);
    }
    if (!hasProject) fail('the project boundary requires :project in the path');
  } else if (boundary !== 'package') {
    fail(`unsupported boundary ${reported(boundary)}`);
  }
  if (
    permission.startsWith(PACKAGE_PERMISSION_PREFIX) &&
    !hasVisibilityPort(options.packageResolver)
  ) {
    fail(`"${permission}" needs a package-visibility resolver, none is registered`);
  }
  return problems;
}

const API_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  '/_pb/ui',
  '/_pb/ui/assets/:file',
  '/_pb/mcp',
  '/_pb/openapi.json',
]);

export function routeApiProblems(
  route: { readonly path: unknown; readonly method: unknown; readonly api?: unknown },
  label: string,
  options: { requireApi?: boolean } = {},
): string[] {
  const underApi = typeof route.path === 'string' && route.path.startsWith('/_pb/');
  if (route.api === undefined) {
    return underApi && options.requireApi === true ? [`${label}: api is required under /_pb/`] : [];
  }
  if (!underApi) return [`${label}: api is only allowed under /_pb/`];
  if (typeof route.api !== 'object' || route.api === null || Array.isArray(route.api)) {
    return [`${label}: api must be an API slot or exemption`];
  }
  const slot = route.api as Record<string, unknown>;
  if ('exempt' in slot) {
    if (Reflect.ownKeys(slot).some((key) => key !== 'exempt')) {
      return [`${label}: api exemption must only contain exempt`];
    }
    if (!API_EXEMPT_PATHS.has(route.path as string)) {
      return [`${label}: api exemption is only allowed on non-API core routes`];
    }
    if (typeof slot.exempt !== 'string' || slot.exempt.length < 1 || slot.exempt.length > 120) {
      return [`${label}: api exemption reason must be 1 to 120 characters`];
    }
    return [];
  }
  const problems: string[] = [];
  const fail = (message: string): void => {
    problems.push(`${label}: ${message}`);
  };
  if (typeof slot.operationId !== 'string' || !/^[a-z][A-Za-z0-9]{2,63}$/.test(slot.operationId)) {
    fail('api operationId must match ^[a-z][A-Za-z0-9]{2,63}$');
  }
  if (typeof slot.summary !== 'string' || slot.summary.length < 1 || slot.summary.length > 120) {
    fail('api summary must be 1 to 120 characters');
  }
  if (
    !Array.isArray(slot.tags) ||
    slot.tags.length < 1 ||
    slot.tags.length > 8 ||
    !slot.tags.every((tag: unknown) => typeof tag === 'string' && tag.length > 0)
  ) {
    fail('api tags must contain 1 to 8 non-empty strings');
  }
  if (
    typeof slot.responses !== 'object' ||
    slot.responses === null ||
    Array.isArray(slot.responses)
  ) {
    fail('api responses must be a status-code record');
  } else {
    const keys = Object.keys(slot.responses);
    if (!keys.every((key) => /^[1-5][0-9]{2}$/.test(key))) {
      fail('api response keys must be integers from 100 to 599');
    }
    if (!keys.some((key) => /^2[0-9]{2}$/.test(key))) {
      fail('api responses must include a 2xx response');
    }
  }
  if (slot.mcp === true && route.method !== 'GET') fail('api mcp true requires GET');
  return problems;
}
