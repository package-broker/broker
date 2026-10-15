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
