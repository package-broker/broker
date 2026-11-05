const MANAGE = 'project:packages:manage';
const MANIFEST_ROUTES = ['/:project/npm/:a', '/:project/npm/:a/:b'];

interface CoreRoute {
  readonly plugin: string;
  readonly method: string;
  readonly path: string;
}

/** DEC-NPM-35: core npm adapters only. The handler still decides the operation and its guards. */
export function npmManagementRoute(route: CoreRoute): boolean {
  if (route.plugin !== 'core') return false;
  if (route.method !== 'PUT' && route.method !== 'DELETE') return false;
  if (route.path === '/:project/npm/-/package/:a/dist-tags/:tag') return true;
  if (
    [
      '/:project/npm/:a/-rev/:rev',
      '/:project/npm/:a/:b/-rev/:rev',
      '/:project/npm/:a/-/:file/-rev/:rev',
      '/:project/npm/:a/:b/-/:file/-rev/:rev',
    ].includes(route.path)
  )
    return route.method === 'DELETE' || !route.path.includes('/:file');
  return route.method === 'PUT' && MANIFEST_ROUTES.includes(route.path);
}

/**
 * Whether the exception may stand in for the route permission. Only manage is lent. The shared
 * manifest route declares the publish permission because publish and `npm deprecate` share it;
 * there the exception admits the deprecation form alone, and the publish handler refuses
 * `_attachments` from a caller without publish authority before staging any byte.
 */
export function npmManagementPermits(route: CoreRoute, permission: string | null): boolean {
  if (!npmManagementRoute(route)) return false;
  if (permission === MANAGE) return true;
  return (
    permission === 'project:packages:write' &&
    route.method === 'PUT' &&
    MANIFEST_ROUTES.includes(route.path)
  );
}

/**
 * Issuance check for the exception: a full service token whose principal stores manage can act on
 * the npm management routes, so the issuer must hold manage too. The scope mask stays unchanged.
 */
export function npmManagementIssuance(
  scope: string,
  permissions: readonly string[],
): readonly string[] {
  return scope === 'full' && permissions.includes(MANAGE) ? [MANAGE] : [];
}
