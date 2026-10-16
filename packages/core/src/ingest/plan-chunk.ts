import {
  CATALOGUE_SYNC_VERSIONS_PER_CALL,
  type CatalogueWriteMethod,
  type VersionInput,
} from '../db/catalogue.js';
import type { SourceType } from '../sources/config.js';

export const INVOCATION_BUDGET = 450;
export const MARK_KEYS_PER_STATEMENT = 1000;

const PROXY_TYPES: readonly SourceType[] = ['packagist_proxy', 'npmjs_proxy'];
const NPM_TYPES: readonly SourceType[] = ['npm_registry', 'npmjs_proxy'];

export interface ChunkMember {
  readonly ordinal: number;
  readonly version: VersionInput;
}

export interface ExistingChunkVersion {
  readonly versionNormalized: string;
  readonly id: string;
  readonly revision: number;
  readonly status: string;
  readonly npmIntegrity: string | null;
  readonly composerShasum: string | null;
  readonly metadataJson?: string;
}

export interface ChunkSource {
  readonly key: string;
  readonly type: SourceType;
  /** Outcome of coveredByRegisteredNames for this key; ignored for proxy sources. */
  readonly covered: boolean;
}

export interface ChunkBudget {
  readonly sessionStatements: number;
  readonly statementBudget?: Readonly<Record<CatalogueWriteMethod, number>>;
}

export interface NpmConflict {
  readonly versionNormalized: string;
  readonly versionId: string;
  readonly revision: number;
}

export type PlannedWriterCall =
  | { readonly method: 'syncPackage'; readonly versions: readonly VersionInput[] }
  | { readonly method: 'quarantine'; readonly versionNormalized: string };

export interface ChunkPlan {
  readonly inserts: readonly VersionInput[];
  readonly composerUpdates: readonly VersionInput[];
  readonly npmConflicts: readonly NpmConflict[];
  readonly unchanged: readonly string[];
  readonly refused: readonly { readonly version: string; readonly reason: 'name_not_registered' }[];
  /**
   * npm versions held as key-only rows whose integrity matches: re-read them with metadata and
   * plan again. The plan stops before the first of them.
   */
  readonly metadataRequired: readonly string[];
  readonly cursorAfter: number | null;
  readonly writerCalls: readonly PlannedWriterCall[];
  /** Worst-case statements of the plan; null without reported writer costs. */
  readonly statements: number | null;
}

type Decision =
  | { readonly kind: 'insert' | 'update' | 'unchanged' | 'refused' | 'needs_metadata' }
  | { readonly kind: 'conflict'; readonly existing: ExistingChunkVersion };

interface NpmDigests {
  readonly shasum: string | null;
  readonly tarballName: string | null;
}

function npmDigests(json: string): NpmDigests {
  const parsed = JSON.parse(json) as { dist?: { shasum?: unknown; tarball?: unknown } };
  const dist = parsed !== null && typeof parsed === 'object' ? parsed.dist : undefined;
  const shasum = typeof dist?.shasum === 'string' ? dist.shasum.toLowerCase() : null;
  const tarball = typeof dist?.tarball === 'string' ? dist.tarball : null;
  return { shasum, tarballName: tarball === null ? null : tarballName(tarball) };
}

function tarballName(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  return path.slice(path.lastIndexOf('/') + 1);
}

function decideNpm(incoming: VersionInput, existing: ExistingChunkVersion): Decision {
  if (incoming.metadata.npmIntegrity !== existing.npmIntegrity) {
    return { kind: 'conflict', existing };
  }
  if (existing.metadataJson === undefined) return { kind: 'needs_metadata' };
  const next = npmDigests(incoming.metadata.json);
  const prior = npmDigests(existing.metadataJson);
  return next.shasum !== prior.shasum || next.tarballName !== prior.tarballName
    ? { kind: 'conflict', existing }
    : { kind: 'unchanged' };
}

function decide(
  npm: boolean,
  incoming: VersionInput,
  existing: ExistingChunkVersion | undefined,
): Decision {
  if (existing === undefined) return { kind: 'insert' };
  if (npm) return decideNpm(incoming, existing);
  return existing.metadataJson === incoming.metadata.json
    ? { kind: 'unchanged' }
    : { kind: 'update' };
}

function checkBudget(budget: ChunkBudget): void {
  const costs = [budget.sessionStatements, ...Object.values(budget.statementBudget ?? {})];
  if (costs.some((cost) => !Number.isSafeInteger(cost) || cost < 0)) {
    throw new TypeError('invalid chunk budget');
  }
}

export function planChunk(
  members: readonly ChunkMember[],
  existing: readonly ExistingChunkVersion[],
  source: ChunkSource,
  budget: ChunkBudget,
): ChunkPlan {
  checkBudget(budget);
  const refusing = !PROXY_TYPES.includes(source.type) && !source.covered;
  const npm = NPM_TYPES.includes(source.type);
  const byVersion = new Map(existing.map((row) => [row.versionNormalized, row]));
  const costs = budget.statementBudget;
  const markCost = costs?.markListing ?? 1;
  const maxCalls = costs === undefined ? 1 : Number.POSITIVE_INFINITY;
  const classify = (m: ChunkMember): Decision =>
    refusing
      ? { kind: 'refused' }
      : decide(npm, m.version, byVersion.get(m.version.versionNormalized));

  const decisions = members.map(classify);
  const metadataRequired = members
    .filter((_, i) => decisions[i]?.kind === 'needs_metadata')
    .map((m) => m.version.versionNormalized);

  const inserts: VersionInput[] = [];
  const updates: VersionInput[] = [];
  const conflicts: NpmConflict[] = [];
  const unchanged: string[] = [];
  const refused: { version: string; reason: 'name_not_registered' }[] = [];
  const calls: PlannedWriterCall[] = [];
  let open: VersionInput[] | null = null;
  let writeStatements = 0;
  let cursorAfter: number | null = null;
  let taken = 0;

  for (const [index, m] of members.entries()) {
    const decision = decisions[index];
    if (decision === undefined || decision.kind === 'needs_metadata') break;
    const marks = Math.ceil((taken + 1) / MARK_KEYS_PER_STATEMENT) * markCost;
    let extraCalls = 0;
    let extraStatements = 0;
    if (decision.kind === 'conflict') {
      extraCalls = 1;
      extraStatements = costs?.quarantine ?? 0;
    } else if (
      (decision.kind === 'insert' || decision.kind === 'update') &&
      (open === null || open.length >= CATALOGUE_SYNC_VERSIONS_PER_CALL)
    ) {
      extraCalls = 1;
      extraStatements = costs?.syncPackage ?? 0;
    }
    const total = budget.sessionStatements + marks + writeStatements + extraStatements;
    if (calls.length + extraCalls > maxCalls || total > INVOCATION_BUDGET) {
      if (taken === 0) throw new RangeError('chunk budget cannot fit one member');
      break;
    }

    writeStatements += extraStatements;
    const version = m.version.versionNormalized;
    if (decision.kind === 'conflict') {
      conflicts.push({
        versionNormalized: version,
        versionId: decision.existing.id,
        revision: decision.existing.revision,
      });
      calls.push({ method: 'quarantine', versionNormalized: version });
    } else if (decision.kind === 'unchanged') {
      unchanged.push(version);
    } else if (decision.kind === 'refused') {
      refused.push({ version, reason: 'name_not_registered' });
    } else {
      if (extraCalls === 1) {
        open = [];
        calls.push({ method: 'syncPackage', versions: open });
      }
      open?.push(m.version);
      (decision.kind === 'insert' ? inserts : updates).push(m.version);
    }
    taken += 1;
    cursorAfter = m.ordinal;
  }

  return {
    inserts,
    composerUpdates: updates,
    npmConflicts: conflicts,
    unchanged,
    refused,
    metadataRequired,
    cursorAfter,
    writerCalls: calls,
    statements:
      costs === undefined
        ? null
        : budget.sessionStatements +
          Math.ceil(taken / MARK_KEYS_PER_STATEMENT) * markCost +
          writeStatements,
  };
}
