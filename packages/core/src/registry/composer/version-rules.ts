import { validateVersion } from '../../catalogue/versions.js';
import { normalizeBranch, normalizeVersion } from './version-parser.js';

const DEFAULT_BRANCH_ALIAS = '9999999-dev';
const CONSTRAINT_SYNTAX = /[\s,|]/;
const STABILITY_RANK: Readonly<Record<string, number>> = {
  dev: 0,
  alpha: 1,
  beta: 2,
  rc: 3,
  '': 4,
  patch: 5,
};

export type VersionResult =
  | { ok: true; version: string; versionNormalized: string; skipped?: boolean }
  | { ok: false; reason: string };

export interface RefVersion {
  version: string;
  versionNormalized: string;
  ref: string;
  kind: 'tag' | 'branch';
  defaultBranch: boolean;
}

export function branchToVersion(branch: string): VersionResult {
  if (CONSTRAINT_SYNTAX.test(branch)) {
    return { ok: false, reason: 'branch name conflicts with constraint syntax' };
  }
  const parsed = normalizeBranch(branch);
  if (parsed.startsWith('dev-') || parsed === DEFAULT_BRANCH_ALIAS) {
    const version = `dev-${branch.replaceAll('#', '+')}`;
    return { ok: true, version, versionNormalized: version };
  }
  const version = (branch.startsWith('v') ? 'v' : '') + parsed.replace(/(\.9{7})+/g, '.x');
  return { ok: true, version, versionNormalized: parsed };
}

function parseTag(tag: string): {
  version: string;
  versionNormalized: string;
  skipped: boolean;
} | null {
  const stripped = tag.replaceAll('release-', '');
  let parsed: string;
  try {
    parsed = normalizeVersion(stripped);
  } catch {
    return null;
  }
  return {
    version: stripped.replace(/[.-]?dev$/gi, ''),
    versionNormalized: parsed.replace(/(^dev-|[.-]?dev$)/gi, ''),
    skipped: parsed.startsWith('dev-') || parsed.endsWith('-dev'),
  };
}

export function tagToVersion(tag: string): VersionResult {
  const result = parseTag(tag);
  if (result === null) {
    return { ok: false, reason: 'invalid tag name' };
  }
  return {
    ok: true,
    version: result.version,
    versionNormalized: result.versionNormalized,
    skipped: result.skipped,
  };
}

interface ParsedNormalized {
  named: string | null;
  numbers: string[];
  rank: number;
  rest: string[];
}

function digitParts(value: string): string[] {
  return value.split(/[.-]/).filter((part) => /^\d+$/.test(part));
}

function parseNormalized(value: string): ParsedNormalized {
  if (value.startsWith('dev-')) {
    return { named: value, numbers: [], rank: 0, rest: [] };
  }
  const dash = value.indexOf('-');
  const base = dash === -1 ? value : value.slice(0, dash);
  const suffix = dash === -1 ? '' : value.slice(dash + 1);
  const match = /^(dev|alpha|beta|rc|patch)?(.*)$/i.exec(suffix);
  return {
    named: null,
    numbers: digitParts(base),
    rank: STABILITY_RANK[(match?.[1] ?? '').toLowerCase()] ?? 0,
    rest: digitParts(match?.[2] ?? ''),
  };
}

function compareDigits(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, '');
  const right = b.replace(/^0+(?=\d)/, '');
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumbers(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = compareDigits(a[index] ?? '0', b[index] ?? '0');
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function compareNormalized(a: string, b: string): number {
  const left = parseNormalized(a);
  const right = parseNormalized(b);
  if (left.named !== null || right.named !== null) {
    if (left.named !== null && right.named !== null) {
      return left.named < right.named ? -1 : left.named > right.named ? 1 : 0;
    }
    return left.named !== null ? -1 : 1;
  }
  return (
    compareNumbers(left.numbers, right.numbers) ||
    left.rank - right.rank ||
    compareNumbers(left.rest, right.rest)
  );
}

function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface RefVersions {
  versions: RefVersion[];
  skipped: number;
}

function acceptable(version: string, versionNormalized: string): boolean {
  try {
    validateVersion({ ecosystem: 'composer', version, versionNormalized });
    return true;
  } catch {
    return false;
  }
}

export function versionsFromRefs(
  tags: readonly string[],
  branches: readonly string[],
  defaultBranch: string | null,
): RefVersions {
  const candidates: RefVersion[] = [];
  let skipped = 0;
  for (const tag of tags) {
    const result = parseTag(tag);
    if (result?.skipped) {
      continue;
    }
    if (result === null || !acceptable(result.version, result.versionNormalized)) {
      skipped += 1;
      continue;
    }
    candidates.push({
      version: result.version,
      versionNormalized: result.versionNormalized,
      ref: tag,
      kind: 'tag',
      defaultBranch: false,
    });
  }
  for (const branch of branches) {
    const result = branchToVersion(branch);
    if (!result.ok || !acceptable(result.version, result.versionNormalized)) {
      skipped += 1;
      continue;
    }
    candidates.push({
      version: result.version,
      versionNormalized: result.versionNormalized,
      ref: branch,
      kind: 'branch',
      defaultBranch: branch === defaultBranch,
    });
  }
  const winners = new Map<string, RefVersion>();
  for (const candidate of candidates) {
    const current = winners.get(candidate.versionNormalized);
    if (current === undefined) {
      winners.set(candidate.versionNormalized, candidate);
      continue;
    }
    const winner = preferred(candidate, current) ? candidate : current;
    winners.set(candidate.versionNormalized, {
      ...winner,
      defaultBranch: candidate.defaultBranch || current.defaultBranch,
    });
  }
  const versions = [...winners.values()].sort(
    (a, b) => compareNormalized(b.versionNormalized, a.versionNormalized) || lexical(a.ref, b.ref),
  );
  return { versions, skipped };
}

function preferred(candidate: RefVersion, current: RefVersion): boolean {
  if (candidate.defaultBranch !== current.defaultBranch) {
    return candidate.defaultBranch;
  }
  const candidateExact = candidate.ref === candidate.version;
  const currentExact = current.ref === current.version;
  if (candidateExact !== currentExact) {
    return candidateExact;
  }
  return lexical(candidate.ref, current.ref) < 0;
}
