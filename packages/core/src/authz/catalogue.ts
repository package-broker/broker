import type { Registration } from '../kernel/registry.js';
import type { RouteBoundary, RouteDefinition } from '../plugin.js';
import { PERMISSIONS, isPermission } from './permissions.js';

export interface RouteDescriptor {
  readonly plugin: string;
  readonly method: RouteDefinition['method'];
  readonly path: string;
  readonly permission: string | null;
  readonly boundary: RouteBoundary;
  readonly sessionOnly: boolean;
}

const sessionOnlyByName: ReadonlyMap<string, boolean> = new Map(
  PERMISSIONS.map(({ name, sessionOnly }) => [name, sessionOnly]),
);

export function catalogueTokenEligible(permission: string): boolean {
  return sessionOnlyByName.get(permission) === false;
}

export function tokenAllowedPermissions(): string[] {
  return PERMISSIONS.filter(({ sessionOnly }) => !sessionOnly).map(({ name }) => name);
}

function routeSessionOnly(permission: string | null, boundary: RouteBoundary): boolean {
  if (permission === null) return boundary === 'self';
  return !catalogueTokenEligible(permission);
}

export function routeDescriptors(routes: Registration['routes']): RouteDescriptor[] {
  return routes.map((route) => {
    const boundary = route.boundary ?? 'none';
    return Object.freeze({
      plugin: route.plugin,
      method: route.method,
      path: route.path,
      permission: route.permission,
      boundary,
      sessionOnly: routeSessionOnly(route.permission, boundary),
    });
  });
}

const MAX_REPORTED_LENGTH = 80;

function quoted(value: string): string {
  return JSON.stringify(value.slice(0, MAX_REPORTED_LENGTH));
}

export function catalogueProblems(
  descriptors: readonly RouteDescriptor[],
  seededAdminPermissions: readonly string[],
): string[] {
  const seeded = new Set(seededAdminPermissions);
  const problems: string[] = [];
  for (const { plugin, method, path, permission, boundary } of descriptors) {
    const subject = `Route ${method} ${quoted(path).slice(1, -1)} (plugin ${quoted(plugin)})`;
    if (permission === null) {
      if (boundary === 'organization' || boundary === 'project') {
        problems.push(`${subject}: public route declares the ${boundary} boundary`);
      }
      continue;
    }
    if (boundary === 'none') {
      problems.push(`${subject}: protected route declares no boundary`);
    }
    if (!isPermission(permission)) {
      problems.push(`${subject}: permission ${quoted(permission)} is not in the catalogue`);
    } else if (!seeded.has(permission)) {
      problems.push(
        `${subject}: permission ${quoted(permission)} is not in the seeded Organization Admin rows`,
      );
    }
  }
  const routed = new Set(descriptors.map(({ permission }) => permission));
  for (const { name } of PERMISSIONS) {
    if (!seeded.has(name) && !routed.has(name)) {
      problems.push(
        `Catalogue permission ${quoted(name)} is not in the seeded Organization Admin rows`,
      );
    }
  }
  return problems;
}
