export type HashRoute =
  | 'projects'
  | 'access'
  | 'sources'
  | 'packages'
  | 'tokens'
  | 'audit'
  | 'import'
  | 'login'
  | 'setup'
  | 'reauth';

const FILTER_LIMITS = { project: 64, status: 64, q: 200, after: 4096 } as const;

export type ListFilters = {
  readonly [K in keyof typeof FILTER_LIMITS]?: string | null | undefined;
};

export function buildListFilterHash(route: HashRoute, filters: ListFilters = {}): string {
  const entries: string[] = [];
  for (const name of Object.keys(FILTER_LIMITS) as (keyof ListFilters)[]) {
    const value = filters[name];
    if (value == null || value.length === 0 || value.length > FILTER_LIMITS[name]) continue;
    if (name === 'project' && /[^A-Za-z0-9._-]/.test(value)) continue;
    try {
      entries.push(`${name}=${encodeURIComponent(value)}`);
    } catch {
      // A lone surrogate cannot be encoded as a URI component.
    }
  }
  return `#/${route}${entries.length === 0 ? '' : `?${entries.join('&')}`}`;
}
