import { PERMISSIONS } from '../authz/permissions.js';
import type { PackageEcosystem } from '../plugin.js';

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

const BOUNDARIES: ReadonlySet<string> = new Set([
  'none',
  'organization',
  'project',
  'self',
  'package',
]);
const PROJECT_PARAMETER = ':project';
const PACKAGE_PERMISSION_PREFIX = 'project:packages:';
const PACKAGE_BOUNDARY_PERMISSIONS: ReadonlySet<string> = new Set([
  'project:packages:read',
  'project:packages:write',
]);
export const PACKAGE_ECOSYSTEMS = [
  'composer',
  'npm',
] as const satisfies readonly PackageEcosystem[];
const ECOSYSTEM_NAMES: ReadonlySet<string> = new Set(PACKAGE_ECOSYSTEMS);
const BOUNDARY_API_VERSION = 3;
const MAX_REPORTED_LENGTH = 80;

export interface PackageVisibilityResolver {
  isVisible(projectId: string, packageName: string): Promise<boolean> | boolean;
}

export interface RouteBoundaryOptions {
  readonly packageResolver?: PackageVisibilityResolver;
  /** Set for plugin routes: the declaring plugin's apiVersion. Absent for core routes. */
  readonly apiVersion?: number;
  /** Only core routes may be 'self'. */
  readonly allowSelf?: boolean;
}

interface BoundaryInput {
  readonly path: unknown;
  readonly permission: unknown;
  readonly boundary?: unknown;
  readonly needsOrg?: unknown;
  readonly package?: unknown;
}

function packageBindingProblems(binding: unknown): string[] {
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
  return problems;
}

function hasResolver(resolver: unknown): boolean {
  return (
    typeof resolver === 'object' &&
    resolver !== null &&
    typeof (resolver as { isVisible?: unknown }).isVisible === 'function'
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
    if (!hasResolver(options.packageResolver)) {
      fail('the package boundary is reserved until a package resolver exists');
      return problems;
    }
    for (const problem of packageBindingProblems(route.package)) fail(problem);
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

  if (permission === null) {
    if (boundary === 'self') {
      if (hasProject) fail('a self route must not have :project in its path');
    } else if (boundary !== undefined && boundary !== 'none') {
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
  if (permission.startsWith(PACKAGE_PERMISSION_PREFIX) && !hasResolver(options.packageResolver)) {
    fail(`"${permission}" needs a package-visibility resolver, none is registered`);
  }
  return problems;
}
