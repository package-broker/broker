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

const FILTER_LIMITS = {
  project: 64,
  status: 64,
  source: 26,
  projectId: 26,
  q: 200,
  after: 4096,
  package: 26,
  versionAfter: 4096,
  cursor: 4096,
  run: 26,
  actor: 200,
  action: 200,
  filterProject: 200,
  limit: 3,
} as const;

export type ListFilters = {
  readonly [K in keyof typeof FILTER_LIMITS]?: string | null | undefined;
};

export function buildListFilterHash(route: HashRoute, filters: ListFilters = {}): string {
  const entries: string[] = [];
  for (const name of Object.keys(FILTER_LIMITS) as (keyof ListFilters)[]) {
    const value = filters[name];
    if (value == null || value.length === 0 || value.length > FILTER_LIMITS[name]) continue;
    if (name === 'project' && /[^A-Za-z0-9._-]/.test(value)) continue;
    if (
      (name === 'source' || name === 'projectId') &&
      (route !== 'packages' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value))
    )
      continue;
    if ((name === 'package' || name === 'versionAfter') && route !== 'packages') continue;
    if ((name === 'run' || name === 'cursor') && route !== 'import') continue;
    if (['actor', 'action', 'filterProject', 'limit'].includes(name) && route !== 'audit') continue;
    if ((name === 'package' || name === 'run') && !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value))
      continue;
    try {
      entries.push(`${name}=${encodeURIComponent(value)}`);
    } catch {
      // A lone surrogate cannot be encoded as a URI component.
    }
  }
  return `#/${route}${entries.length === 0 ? '' : `?${entries.join('&')}`}`;
}
