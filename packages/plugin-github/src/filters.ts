export interface RepositoryFilter {
  readonly names?: readonly string[];
  readonly topicsAll?: readonly string[];
  readonly topicsAny?: readonly string[];
  readonly pathsExist?: readonly string[];
  readonly pathsDoNotExist?: readonly string[];
}

export interface FilterRule {
  readonly filters?: readonly RepositoryFilter[];
  readonly skipArchived?: boolean;
  readonly skipForks?: boolean;
  readonly visibility?: 'any' | 'private_internal' | 'public';
  readonly excludedRepositoryIds?: readonly number[];
}

export interface FilterRepository {
  readonly id: number;
  readonly name: string;
  readonly archived: boolean;
  readonly fork: boolean;
  readonly visibility: 'public' | 'private' | 'internal';
  readonly topics?: readonly string[];
}

export type FilterResult = 'matched' | 'unmatched' | 'unknown';
export type FileEvidence = Readonly<Record<string, 'present' | 'absent' | 'unknown'>>;

export class FilterError extends Error {
  override readonly name = 'FilterError';
  constructor() {
    super('GitHub import filters are invalid');
  }
}

export function globMatch(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  let pi = 0;
  let ni = 0;
  let star = -1;
  let mark = 0;
  while (ni < n.length) {
    if (p[pi] === '*') {
      star = pi++;
      mark = ni;
    } else if (pi < p.length && (p[pi] === '?' || p[pi] === n[ni])) {
      pi++;
      ni++;
    } else if (star >= 0) {
      pi = star + 1;
      ni = ++mark;
    } else {
      return false;
    }
  }
  while (p[pi] === '*') pi++;
  return pi === p.length;
}

function validPath(path: string): boolean {
  return (
    path.length > 0 && path.length <= 100 && !/[^A-Za-z0-9._-]/.test(path) && !/^\.+$/.test(path)
  );
}

function validate(rule: FilterRule): void {
  if (
    typeof rule !== 'object' ||
    rule === null ||
    Array.isArray(rule) ||
    Object.keys(rule).some(
      (key) =>
        !['filters', 'skipArchived', 'skipForks', 'visibility', 'excludedRepositoryIds'].includes(
          key,
        ),
    )
  )
    throw new FilterError();
  if (rule.filters !== undefined && (!Array.isArray(rule.filters) || rule.filters.length > 10))
    throw new FilterError();
  if (
    (rule.skipArchived !== undefined && typeof rule.skipArchived !== 'boolean') ||
    (rule.skipForks !== undefined && typeof rule.skipForks !== 'boolean') ||
    (rule.visibility !== undefined &&
      !['any', 'private_internal', 'public'].includes(rule.visibility)) ||
    (rule.excludedRepositoryIds !== undefined &&
      (!Array.isArray(rule.excludedRepositoryIds) ||
        rule.excludedRepositoryIds.length > 1000 ||
        Array.from(rule.excludedRepositoryIds).some((id) => !Number.isSafeInteger(id) || id <= 0)))
  )
    throw new FilterError();
  for (const filter of rule.filters ?? []) {
    if (typeof filter !== 'object' || filter === null || Array.isArray(filter))
      throw new FilterError();
    for (const [key, values] of Object.entries(filter)) {
      if (
        !['names', 'topicsAll', 'topicsAny', 'pathsExist', 'pathsDoNotExist'].includes(key) ||
        !Array.isArray(values) ||
        values.length > 20
      )
        throw new FilterError();
      for (const value of values) {
        if (typeof value !== 'string') throw new FilterError();
        const valid =
          key === 'names'
            ? /^!?[A-Za-z0-9._*?-]{1,100}$/.test(value) && value.length <= 100
            : key.startsWith('topics')
              ? /^[a-z0-9-]{1,50}$/.test(value)
              : validPath(value);
        if (!valid) throw new FilterError();
      }
    }
  }
}

function all(results: readonly FilterResult[]): FilterResult {
  if (results.includes('unmatched')) return 'unmatched';
  return results.includes('unknown') ? 'unknown' : 'matched';
}

function evaluateEntry(
  repository: FilterRepository,
  filter: RepositoryFilter,
  files: FileEvidence,
): FilterResult {
  const results: FilterResult[] = [];
  const names = filter.names ?? [];
  const positive = names.filter((name) => !name.startsWith('!'));
  const name = repository.name.split('/').at(-1)!;
  results.push(
    names.some((pattern) => pattern.startsWith('!') && globMatch(pattern.slice(1), name)) ||
      (positive.length > 0 && !positive.some((pattern) => globMatch(pattern, name)))
      ? 'unmatched'
      : 'matched',
  );
  for (const [topics, every] of [
    [filter.topicsAll, true],
    [filter.topicsAny, false],
  ] as const) {
    if (topics === undefined || topics.length === 0) continue;
    if (repository.topics === undefined) results.push('unknown');
    else
      results.push(
        (
          every
            ? topics.every((topic) => repository.topics!.includes(topic))
            : topics.some((topic) => repository.topics!.includes(topic))
        )
          ? 'matched'
          : 'unmatched',
      );
  }
  for (const [paths, expected] of [
    [filter.pathsExist, 'present'],
    [filter.pathsDoNotExist, 'absent'],
  ] as const) {
    for (const path of paths ?? []) {
      const evidence = Object.hasOwn(files, path) ? files[path] : undefined;
      results.push(
        evidence === undefined || evidence === 'unknown'
          ? 'unknown'
          : evidence === expected
            ? 'matched'
            : 'unmatched',
      );
    }
  }
  return all(results);
}

export function evaluateFilters(
  repository: FilterRepository,
  rule: FilterRule,
  files: FileEvidence = {},
  options: { readonly existingChild?: boolean } = {},
): FilterResult {
  validate(rule);
  if (
    rule.excludedRepositoryIds?.includes(repository.id) ||
    (repository.archived && (rule.skipArchived ?? true) && !options.existingChild) ||
    (repository.fork && (rule.skipForks ?? true)) ||
    (rule.visibility === 'public' && repository.visibility !== 'public') ||
    (rule.visibility === 'private_internal' && repository.visibility === 'public')
  )
    return 'unmatched';
  if (!rule.filters?.length) return 'matched';
  const results = rule.filters.map((filter) => evaluateEntry(repository, filter, files));
  if (results.includes('matched')) return 'matched';
  return results.includes('unknown') ? 'unknown' : 'unmatched';
}
