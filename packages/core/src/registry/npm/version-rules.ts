import { compareNpmVersions, validateVersion } from '../../catalogue/versions.js';

export interface NpmRefVersion {
  readonly ref: string;
  readonly version: string;
  readonly versionNormalized: string;
  readonly kind: 'tag';
  readonly defaultBranch: false;
}

export function npmVersionsFromRefs(tags: readonly string[]): {
  readonly versions: readonly NpmRefVersion[];
  readonly latest: string | null;
} {
  if (tags.length > 50_000) throw new RangeError('too_many_refs');
  const selected = new Map<string, NpmRefVersion>();
  for (const ref of tags) {
    if (ref.length > 257) continue;
    const version = ref.startsWith('v') ? ref.slice(1) : ref;
    try {
      validateVersion({ ecosystem: 'npm', version, versionNormalized: version });
    } catch {
      continue;
    }
    if (!selected.has(version) || ref === version)
      selected.set(version, {
        ref,
        version,
        versionNormalized: version,
        kind: 'tag',
        defaultBranch: false,
      });
  }
  const versions = [...selected.values()].sort((a, b) => compareNpmVersions(b.version, a.version));
  return {
    versions,
    latest: (versions.find((item) => !item.version.includes('-')) ?? versions[0])?.version ?? null,
  };
}

export { compareNpmVersions } from '../../catalogue/versions.js';
