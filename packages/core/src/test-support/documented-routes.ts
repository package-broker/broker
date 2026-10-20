import { AUTH_API } from '../api/auth-schemas.js';
import type { ApiSlot, RouteDefinition } from '../plugin.js';

const FIXTURE_API: ApiSlot = Object.freeze({
  operationId: 'fixture',
  summary: 'Fixture route',
  tags: ['fixture'],
  responses: { 200: null },
});

export function documented(routes: readonly RouteDefinition[]): RouteDefinition[] {
  return routes.map((route) =>
    route.api !== undefined || !route.path.startsWith('/_pb/')
      ? route
      : { ...route, api: AUTH_API[`${route.method} ${route.path}`] ?? FIXTURE_API },
  );
}
