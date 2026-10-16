import { compareNormalized } from '../registry/composer/version-rules.js';
import { displayName, packageKey, type NameEcosystem } from './names.js';

export const MAX_MISSING_NAMES = 1000;
export const MAX_REQUIRERS = 10;
export const MAX_VERSIONS = 5;

export type ClosureStatus = 'proxy_admissible' | 'attachable' | 'not_available';

export interface DependencyFields {
  require?: Readonly<Record<string, string>>;
  'require-dev'?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  dependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
  peerDependenciesMeta?: Readonly<Record<string, { optional?: boolean } | undefined>>;
}

export interface DependencyNames {
  keys: string[];
  unresolvable: number;
}

export interface ClosureEdge {
  dependency: string;
  requirer: string;
  version: string;
}

export interface MissingDependency {
  name: string;
  status: ClosureStatus;
  requiredBy: { name: string; versions: string[] }[];
}

export interface ClosureReport {
  missing: MissingDependency[];
  truncated: boolean;
  /** Edges skipped for an invalid key; separate from the spec count of dependencyNames, never summed with it. */
  invalidEdges: number;
}

const COMPOSER_PLATFORM = /^(?:php|hhvm|ext-|lib-|composer)/i;
const UNRESOLVABLE_SPEC =
  /^(?:[./~]|[a-z]:[\\/]|git(?:\+[a-z]+)?:|git@|[a-z]+:\/\/|https?:|file:|link:|workspace:|portal:|patch:|github:|gitlab:|bitbucket:|gist:|[\w.-]+\/[\w.-]+(?:#.*)?$)/i;

const TARBALL_SPEC = /\.(?:tgz|tar\.gz|tar)$/i;

function npmAliasTarget(spec: string): string {
  const target = spec.slice('npm:'.length);
  const at = target.lastIndexOf('@');
  return at > 0 ? target.slice(0, at) : target;
}

export function dependencyNames(
  ecosystem: NameEcosystem,
  fields: DependencyFields,
): DependencyNames {
  const keys = new Set<string>();
  let unresolvable = 0;
  const add = (name: string): void => {
    try {
      keys.add(packageKey(name, { ecosystem, legacyCase: ecosystem === 'npm' }));
    } catch {
      unresolvable += 1;
    }
  };

  if (ecosystem === 'composer') {
    for (const name of Object.keys(fields.require ?? {})) {
      if (!name.includes('/') && COMPOSER_PLATFORM.test(name)) continue;
      add(name);
    }
    return { keys: [...keys], unresolvable };
  }

  const peers = Object.fromEntries(
    Object.entries(fields.peerDependencies ?? {}).filter(
      ([name]) => fields.peerDependenciesMeta?.[name]?.optional !== true,
    ),
  );
  for (const group of [fields.dependencies, fields.optionalDependencies, peers]) {
    for (const [name, spec] of Object.entries(group ?? {}) as [string, unknown][]) {
      const trimmed = typeof spec === 'string' ? spec.trim() : null;
      if (trimmed === null) {
        unresolvable += 1;
      } else if (trimmed.startsWith('npm:')) {
        add(npmAliasTarget(trimmed));
      } else if (UNRESOLVABLE_SPEC.test(trimmed) || TARBALL_SPEC.test(trimmed)) {
        unresolvable += 1;
      } else {
        add(name);
      }
    }
  }
  return { keys: [...keys], unresolvable };
}

function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) {
    return a.length !== b.length
      ? a.length - b.length
      : byCode(a.replace(/^0+(?=\d)/, ''), b.replace(/^0+(?=\d)/, ''));
  }
  if (numericA !== numericB) return numericA ? -1 : 1;
  return byCode(a, b);
}

function compareSemver(a: string, b: string): number {
  const split = (v: string): [string[], string[] | null] => {
    const [core = '', pre] = v.split('+')[0]?.split(/-(.*)/s) ?? [];
    return [core.split('.'), pre === undefined ? null : pre.split('.')];
  };
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  for (let i = 0; i < Math.max(coreA.length, coreB.length); i += 1) {
    const difference = compareIdentifiers(coreA[i] ?? '0', coreB[i] ?? '0');
    if (difference !== 0) return difference;
  }
  if (preA === null || preB === null) return preA === preB ? 0 : preA === null ? 1 : -1;
  for (let i = 0; i < Math.min(preA.length, preB.length); i += 1) {
    const difference = compareIdentifiers(preA[i] ?? '', preB[i] ?? '');
    if (difference !== 0) return difference;
  }
  return preA.length - preB.length;
}

function newestFirst(ecosystem: NameEcosystem): (a: string, b: string) => number {
  const compare = ecosystem === 'npm' ? compareSemver : compareNormalized;
  return (a, b) => compare(b, a) || byCode(b, a);
}

function isKey(key: string, ecosystem: NameEcosystem): boolean {
  try {
    const name = displayName(key);
    return packageKey(name, { ecosystem, legacyCase: ecosystem === 'npm' }) === key;
  } catch {
    return false;
  }
}

/**
 * `canSeeOrganizationSources` must come from the organization-scope ActorContext
 * (`org:sources:read`), never from a project permission union. Without it every
 * status collapses to `not_available`, so the report cannot reveal whether a
 * hidden source holds a name. Edge versions are normalized versions.
 */
export function computeClosure(
  visibleKeys: ReadonlySet<string>,
  edges: readonly ClosureEdge[],
  classify: (key: string) => ClosureStatus,
  options: { ecosystem: NameEcosystem; canSeeOrganizationSources: boolean },
): ClosureReport {
  const grouped = new Map<string, Map<string, Set<string>>>();
  let invalidEdges = 0;
  for (const { dependency, requirer, version } of edges) {
    if (visibleKeys.has(dependency)) continue;
    if (!isKey(dependency, options.ecosystem) || !isKey(requirer, options.ecosystem)) {
      invalidEdges += 1;
      continue;
    }
    const requirers = grouped.get(dependency) ?? new Map<string, Set<string>>();
    const versions = requirers.get(requirer) ?? new Set<string>();
    versions.add(version);
    requirers.set(requirer, versions);
    grouped.set(dependency, requirers);
  }

  const keys = [...grouped.keys()].sort(byCode);
  let truncated = keys.length > MAX_MISSING_NAMES;
  const missing = keys.slice(0, MAX_MISSING_NAMES).map((key): MissingDependency => {
    const status = options.canSeeOrganizationSources ? classify(key) : 'not_available';
    const requirers = [...(grouped.get(key) ?? [])].sort(([a], [b]) => byCode(a, b));
    truncated ||= requirers.length > MAX_REQUIRERS;
    return {
      name: displayName(key),
      status,
      requiredBy: requirers.slice(0, MAX_REQUIRERS).map(([requirer, versions]) => {
        const sorted = [...versions].sort(newestFirst(options.ecosystem));
        truncated ||= sorted.length > MAX_VERSIONS;
        return { name: displayName(requirer), versions: sorted.slice(0, MAX_VERSIONS) };
      }),
    };
  });
  return { missing, truncated, invalidEdges };
}
