import { routeBoundaryProblems } from '../kernel/routes.js';
import type { Registration } from '../kernel/registry.js';
import { catalogueProblems, routeDescriptors } from './catalogue.js';
import { rolePermissionProblems } from './permissions.js';

export type DiagnosticRoute = Registration['routes'][number];

export interface DiagnosticOptions {
  readonly packageResolver: boolean;
}

const CORE_PLUGIN = 'core';
const MAX_LABEL_LENGTH = 80;

function labelOf({ method, path, plugin }: DiagnosticRoute): string {
  const bounded = (value: unknown): string =>
    typeof value === 'string' ? value.slice(0, MAX_LABEL_LENGTH) : `<${typeof value}>`;
  return `Route ${bounded(method)} ${bounded(path)} (plugin ${bounded(plugin)})`;
}

function isWellTyped({ path, permission }: DiagnosticRoute): boolean {
  return typeof path === 'string' && (permission === null || typeof permission === 'string');
}

export function catalogueDiagnostics(
  routes: readonly DiagnosticRoute[],
  seededAdminPermissions: readonly string[],
  options: DiagnosticOptions,
): string[] {
  const packageResolver = options.packageResolver
    ? { resolve: () => Promise.resolve({ kind: 'absent' as const }) }
    : undefined;
  const problems = routes.flatMap((route) =>
    routeBoundaryProblems(route, labelOf(route), {
      allowSelf: route.plugin === CORE_PLUGIN,
      allowAuthenticated: route.plugin === CORE_PLUGIN,
      ...(packageResolver === undefined ? {} : { packageResolver }),
    }),
  );
  return [
    ...problems,
    ...catalogueProblems(routeDescriptors(routes.filter(isWellTyped)), seededAdminPermissions),
    ...rolePermissionProblems('organization', seededAdminPermissions),
  ];
}
