import type { ManagedRoute } from './inventory.js';

const host = (pattern: string): string =>
  pattern
    .replace(/^https?:\/\//i, '')
    .split('/')[0]!
    .toLowerCase();

export function routeConflict(
  zone: string,
  existing: Record<string, unknown>,
  requested: readonly ManagedRoute[],
  script: string,
): 'foreign_owner' | 'overlap' | null {
  if (existing.script === script) return null;
  const routes = requested.filter((route) => route.zone_id === zone);
  if (routes.some((route) => route.pattern === existing.pattern)) return 'foreign_owner';
  if (typeof existing.pattern !== 'string') return null;
  const attachedHost = host(existing.pattern);
  if (
    routes.some((route) => {
      const wanted = host(route.pattern);
      return (
        attachedHost === '*' ||
        attachedHost === wanted ||
        (attachedHost.startsWith('*.') && wanted.endsWith(attachedHost.slice(1))) ||
        (attachedHost.startsWith('*') &&
          !attachedHost.startsWith('*.') &&
          wanted.endsWith(attachedHost.slice(1)))
      );
    })
  )
    return 'overlap';
  return null;
}
