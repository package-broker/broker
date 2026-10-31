import type { NameEcosystem } from '../catalogue/names.js';
import {
  CATALOGUE_KEY_LIST_MAX,
  type CatalogueWriteGuard,
  type CatalogueWriteMethod,
  type CatalogueWriter,
  type SyncRefusal,
  type VersionInput,
} from '../db/catalogue.js';
import type { ExistingVersion, ExistingVersionsReader } from '../db/existing-versions.js';
import type { OrgContext } from '../db/port.js';
import { parseSha256 } from '../platform/blob.js';
import type { Observability } from '../platform/observability.js';
import type { SourceType } from '../sources/config.js';
import {
  snapshotRef,
  type DescribeOptions,
  type DocumentValidators,
  type PackageDescription,
  type SkippedMember,
  type VersionCandidate,
} from '../sources/provider.js';
import { JsonStreamError } from './json-tokenizer.js';
import { JsonExtractError } from './json-stream.js';
import { NpmPackumentError } from './npm/packument.js';
import { SnapshotCorruptError } from './snapshot.js';
import type { IngestFinalizeRefusal, IngestFinalizer } from './finalize.js';
import { INVOCATION_BUDGET, planChunk, type ChunkMember } from './plan-chunk.js';
import type { IngestSessionHandle, IngestSessions } from './session.js';
import { UPSTREAM_FORMS } from './validators.js';

export const APPLY_MEMBER_WINDOW = CATALOGUE_KEY_LIST_MAX;
const EXISTING_PAGE_ROWS = 1000;
const TAGS_PER_CALL = 100;
const ABANDON_STATEMENTS = 1;
/** Retained metadata per window, counted as UTF-16 bytes; one member is always admitted. */
export const APPLY_WINDOW_BYTES = 16 * 1024 * 1024;
const START_STATEMENTS = 1;
/** Finalizer reads, its session guard, one publish per form, the blob flag and the completion pair. */
const FINALIZE_SESSION_STATEMENTS = 3 + 1 + UPSTREAM_FORMS.length + 1 + 2;
const PROXY_TYPES: readonly SourceType[] = ['packagist_proxy', 'npmjs_proxy'];

const ABANDONING_REFUSALS: ReadonlySet<IngestFinalizeRefusal> = new Set([
  'count_mismatch',
  'mass_absence',
  'no_package',
]);

export interface ApplySource {
  readonly id: string;
  readonly key: string;
  readonly type: SourceType;
  readonly ecosystem: NameEcosystem;
  /** Outcome of coveredByRegisteredNames for this key; ignored for proxy sources. */
  readonly covered: boolean;
}

export interface ApplyDeps {
  readonly writer: CatalogueWriter;
  readonly sessions: IngestSessions;
  readonly existing: ExistingVersionsReader;
  readonly finalizer: IngestFinalizer;
  readonly observability?: Pick<Observability, 'log'>;
}

export interface ApplyInput {
  readonly session: IngestSessionHandle;
  /** The session guard, plus the job guard when a job applies. */
  readonly guard: CatalogueWriteGuard;
  readonly source: ApplySource;
  readonly description: PackageDescription;
  readonly packageDescription: string | null;
  /** Null when the member cannot become a catalogue version; it is counted as attempted. */
  readonly toVersion: (candidate: VersionCandidate) => VersionInput | null;
  readonly validatorTtlSeconds: number;
}

export type MemberRefusal = SyncRefusal | 'unreadable' | 'payload_too_large';

export interface RefusedMember {
  readonly version: string;
  readonly reason: MemberRefusal;
}

/** A later member whose normalized version an earlier ordinal already carried; it is ignored. */
export interface DuplicateMember {
  readonly version: string;
  readonly ordinal: number;
}

export type ApplyStatus =
  'progress' | 'complete' | 'incomplete' | 'abandoned' | 'superseded' | 'refused';

export interface ApplyOutcome {
  readonly done: boolean;
  readonly cursor: string | null;
  readonly status: ApplyStatus;
  readonly refusal?:
    | IngestFinalizeRefusal
    | 'name_not_registered'
    | 'refused_members'
    | 'snapshot_corrupt'
    | 'budget_exhausted';
  /** With `refused_members`: members the session attempted but never marked present. */
  readonly refusedMembers?: number;
  /** The handle with this invocation's stamp, snapshot, cursor and seen count. */
  readonly session: IngestSessionHandle;
  readonly skipped: readonly SkippedMember[];
  /** Members of this invocation the writer or the converter refused. */
  readonly refused: readonly RefusedMember[];
  readonly duplicates: readonly DuplicateMember[];
  readonly tagsSkipped: boolean;
  /** Dist-tags the writer refused to store (invalid or pointing at no stored version). */
  readonly skippedTags: readonly string[];
  /** Worst-case statements planned for this invocation. */
  readonly planned: number;
}

type Tail = 'tags' | 'finalize';

interface ApplyCursor {
  readonly packageId: string;
  readonly ordinal: number | null;
  readonly attempted: number;
  readonly tail: Tail | null;
  readonly tagOffset?: number;
}

type WindowEntry =
  | { readonly ordinal: number; readonly version: VersionInput }
  | {
      readonly ordinal: number;
      readonly version: null;
      readonly name: string;
      readonly duplicate: boolean;
    };

export function continuationOptions(
  session: IngestSessionHandle,
  published: DocumentValidators,
): DescribeOptions {
  if (session.snapshotId === null) return { validators: published };
  const blob = session.snapshotBlobSha256;
  return {
    snapshot: snapshotRef(session.snapshotId, blob === null ? undefined : parseSha256(blob)),
  };
}

function isSnapshotFailure(error: unknown): boolean {
  return (
    error instanceof SnapshotCorruptError ||
    error instanceof JsonStreamError ||
    error instanceof JsonExtractError ||
    error instanceof NpmPackumentError ||
    (error instanceof RangeError && error.message === 'member ordinals must be strictly increasing')
  );
}

function parseCursor(text: string): ApplyCursor {
  const value = JSON.parse(text) as Partial<ApplyCursor> | null;
  const { packageId, ordinal, attempted, tail, tagOffset } = value ?? {};
  if (
    typeof packageId !== 'string' ||
    packageId === '' ||
    (ordinal !== null && !Number.isSafeInteger(ordinal)) ||
    !Number.isSafeInteger(attempted) ||
    (attempted as number) < 0 ||
    (tail !== null && tail !== 'tags' && tail !== 'finalize') ||
    (tagOffset !== undefined && (!Number.isSafeInteger(tagOffset) || tagOffset < 0))
  ) {
    throw new TypeError('invalid ingest apply cursor');
  }
  return {
    packageId,
    ordinal: ordinal as number | null,
    attempted: attempted as number,
    tail,
    ...(tagOffset === undefined ? {} : { tagOffset }),
  };
}

function guardedBudget(
  writer: CatalogueWriter,
  guardStatements: number,
): Record<CatalogueWriteMethod, number> {
  const extra = guardStatements - 1;
  const budget = { ...writer.statementBudget };
  for (const method of Object.keys(budget) as CatalogueWriteMethod[]) {
    if (method !== 'syncPackage') budget[method] += extra;
  }
  return budget;
}

async function* ordered(description: PackageDescription): AsyncGenerator<VersionCandidate> {
  let previous = -1;
  for await (const candidate of description.members) {
    if (!Number.isSafeInteger(candidate.ordinal) || candidate.ordinal <= previous) {
      throw new RangeError('member ordinals must be strictly increasing');
    }
    previous = candidate.ordinal;
    yield candidate;
  }
}

async function readWindow(
  description: PackageDescription,
  after: number | null,
  toVersion: ApplyInput['toVersion'],
  limit: number,
): Promise<{ entries: WindowEntry[]; exhausted: boolean }> {
  const entries: WindowEntry[] = [];
  const keys = new Set<string>();
  let retained = 0;
  let admitted = 0;
  let exhausted = true;
  for await (const candidate of ordered(description)) {
    if (!exhausted) continue;
    const prior = after !== null && candidate.ordinal <= after;
    if (!prior && entries.length >= limit) {
      exhausted = false;
      continue;
    }
    const version = toVersion(candidate);
    const key = version?.versionNormalized;
    const duplicate = key !== undefined && keys.has(key);
    if (key !== undefined) keys.add(key);
    if (prior) continue;
    const { ordinal } = candidate;
    if (version === null || duplicate) {
      entries.push({ ordinal, version: null, name: candidate.version, duplicate });
    } else {
      const bytes = 2 * version.metadata.json.length;
      if (admitted > 0 && retained + bytes > APPLY_WINDOW_BYTES) {
        exhausted = false;
        continue;
      }
      retained += bytes;
      admitted += 1;
      entries.push({ ordinal, version });
    }
  }
  return { entries, exhausted };
}

async function readExisting(
  ctx: OrgContext,
  reader: ExistingVersionsReader,
  packageId: string,
  members: readonly ChunkMember[],
  npm: boolean,
  maxReads: number,
  trim: (through: number) => void,
): Promise<{ rows: ExistingVersion[]; reads: number; through: number | null }> {
  if (maxReads < 1) return { rows: [], reads: 0, through: null };
  const keys = members.map((m) => m.version.versionNormalized);
  const page = await reader.existingVersions(ctx, {
    packageId,
    keys,
    after: null,
    withMetadata: false,
    limit: EXISTING_PAGE_ROWS,
  });
  const byKey = new Map(page.rows.map((row) => [row.versionNormalized, row]));
  let reads = 1;
  let candidates = [...members];
  const needsMetadata = (m: ChunkMember): boolean => {
    const row = byKey.get(m.version.versionNormalized);
    return (
      row !== undefined &&
      row.metadataJson === undefined &&
      row.status !== 'tombstoned' &&
      row.status !== 'quarantined' &&
      (!npm || row.npmIntegrity === m.version.metadata.npmIntegrity)
    );
  };
  const bound = (): void => {
    let bytes = 0;
    let count = 0;
    for (const m of candidates) {
      const old = byKey.get(m.version.versionNormalized)?.metadataJson;
      const size = 2 * (m.version.metadata.json.length + (old?.length ?? 0));
      if (count > 0 && bytes + size > APPLY_WINDOW_BYTES) break;
      bytes += size;
      count++;
    }
    if (count < candidates.length) {
      candidates = candidates.slice(0, count);
      trim(candidates.at(-1)!.ordinal);
    }
    const retained = new Set(candidates.map((m) => m.version.versionNormalized));
    for (const key of byKey.keys()) if (!retained.has(key)) byKey.delete(key);
  };
  bound();
  for (;;) {
    const wanted = candidates.filter(needsMetadata);
    if (wanted.length === 0) break;
    if (reads >= maxReads) {
      candidates = candidates.slice(0, candidates.indexOf(wanted[0]!));
      break;
    }
    const selected = wanted.map((m) => m.version.versionNormalized);
    const metadata = await reader.existingVersions(ctx, {
      packageId,
      keys: selected,
      after: null,
      withMetadata: true,
      limit: EXISTING_PAGE_ROWS,
    });
    reads++;
    for (const row of metadata.rows) byKey.set(row.versionNormalized, row);
    // A row deleted between the key and metadata reads is now an insert candidate.
    if (metadata.next === null) {
      const found = new Set(metadata.rows.map((row) => row.versionNormalized));
      for (const key of selected) if (!found.has(key)) byKey.delete(key);
    }
    if (metadata.rows.length === 0 && metadata.next !== null) break;
    bound();
  }
  const through = candidates.at(-1)?.ordinal ?? null;
  const retained = new Set(candidates.map((m) => m.version.versionNormalized));
  return {
    rows: [...byKey.values()].filter((r) => retained.has(r.versionNormalized)),
    reads,
    through,
  };
}

export async function applyChunk(
  ctx: OrgContext,
  deps: ApplyDeps,
  input: ApplyInput,
): Promise<ApplyOutcome> {
  const { writer, sessions } = deps;
  const { description, source, guard } = input;
  let session = input.session;
  const guardStatements = guard.length;
  const budget = guardedBudget(writer, guardStatements);
  let used = 0;
  const tagsSkipped = false;
  let skippedTags: readonly string[] = [];
  const advanceStatements = 1 + guardStatements;
  const closeStatements = advanceStatements + ABANDON_STATEMENTS;
  const refused: RefusedMember[] = [];
  const duplicates: DuplicateMember[] = [];
  const abandon = async (
    status: ApplyStatus,
    extra: Partial<Pick<ApplyOutcome, 'refusal' | 'refusedMembers' | 'skipped'>> = {},
  ): Promise<ApplyOutcome> => {
    used += ABANDON_STATEMENTS;
    return outcome((await sessions.abandon(ctx, session)) ? status : 'superseded', true, extra);
  };
  const exhausted = (): Promise<ApplyOutcome> => {
    deps.observability?.log({
      level: 'warn',
      event: 'ingest.budget_exhausted',
      reason_code: 'budget_exhausted',
      package_key: source.key,
      source_id: source.id,
      seq: ordinal ?? 0,
    });
    return abandon('refused', { refusal: 'budget_exhausted' });
  };
  const outcome = (
    status: ApplyStatus,
    done: boolean,
    extra: Partial<Pick<ApplyOutcome, 'refusal' | 'refusedMembers' | 'skipped'>> = {},
  ): ApplyOutcome => ({
    done,
    cursor: session.cursor,
    status,
    session,
    skipped: extra.skipped ?? description.skippedMembers,
    refused,
    duplicates,
    tagsSkipped,
    skippedTags,
    planned: used,
    ...(extra.refusal === undefined ? {} : { refusal: extra.refusal }),
    ...(extra.refusedMembers === undefined ? {} : { refusedMembers: extra.refusedMembers }),
  });

  if (session.snapshotId !== null && session.snapshotId !== description.snapshot.id) {
    return abandon('abandoned');
  }
  if (!PROXY_TYPES.includes(source.type) && !source.covered) {
    return abandon('refused', { refusal: 'name_not_registered' });
  }

  const resumed =
    session.stamp === null || session.cursor === null ? null : parseCursor(session.cursor);
  let window: Awaited<ReturnType<typeof readWindow>> = { entries: [], exhausted: true };
  try {
    // Drain to EOF before writing: staged snapshots verify their digest only at EOF.
    if (resumed?.tail == null) {
      window = await readWindow(
        description,
        resumed?.ordinal ?? null,
        input.toVersion,
        APPLY_MEMBER_WINDOW,
      );
    } else {
      for await (const candidate of ordered(description)) void candidate.ordinal;
    }
  } catch (error) {
    if (!isSnapshotFailure(error)) throw error;
    deps.observability?.log({
      level: 'warn',
      event: 'ingest.snapshot_corrupt',
      reason_code: 'snapshot_corrupt',
    });
    return abandon('refused', { refusal: 'snapshot_corrupt' });
  }

  const syncInput = {
    sourceId: source.id,
    ecosystem: source.ecosystem,
    key: source.key,
    description: input.packageDescription,
  };
  let cursor: ApplyCursor;
  if (resumed === null) {
    const upsert = await writer.syncPackage(ctx, guard, { ...syncInput, versions: [] });
    used += upsert.statements;
    let stamp = session.stamp;
    if (stamp === null) {
      ({ stamp } = await writer.openListing(ctx, guard, {
        kind: 'package',
        packageId: upsert.packageId,
      }));
      const blob = description.snapshot.stagedBlob;
      const started = await sessions.start(ctx, session, {
        snapshot: {
          id: description.snapshot.id,
          ...(blob === undefined ? {} : { blobSha256: blob }),
        },
        stamp,
      });
      used += budget.openListing + START_STATEMENTS;
      if (!started) return outcome('superseded', true);
      session = {
        ...session,
        stamp,
        snapshotId: description.snapshot.id,
        snapshotBlobSha256: blob ?? null,
      };
    }
    cursor = { packageId: upsert.packageId, ordinal: null, attempted: 0, tail: null };
  } else {
    cursor = resumed;
  }
  const stamp = session.stamp as string;
  const finalizeCost = budget.finalizeListing + FINALIZE_SESSION_STATEMENTS;

  let marked = 0;
  let tail = cursor.tail;
  let tagOffset = cursor.tagOffset ?? 0;
  let { ordinal, attempted } = cursor;
  if (tail === null) {
    let members: ChunkMember[] = window.entries.flatMap((e) =>
      e.version === null ? [] : [{ ordinal: e.ordinal, version: e.version }],
    );
    let existingRows: ExistingVersion[] = [];
    if (members.length > 0) {
      const reserve = Math.max(
        writer.syncPackageCost({ versions: 1, tags: 0, guardStatements }),
        budget.quarantine,
      );
      const read = await readExisting(
        ctx,
        deps.existing,
        cursor.packageId,
        members,
        source.ecosystem === 'npm',
        INVOCATION_BUDGET - used - closeStatements - budget.markListing - reserve,
        (through) => {
          while ((members.at(-1)?.ordinal ?? -1) > through) members.pop();
          while ((window.entries.at(-1)?.ordinal ?? -1) > through) window.entries.pop();
          window.exhausted = false;
        },
      );
      existingRows = read.rows;
      used += read.reads;
      if (read.through !== members.at(-1)?.ordinal) {
        if (read.through === null) return exhausted();
        members = members.filter((m) => m.ordinal <= read.through!);
        window = {
          entries: window.entries.filter((e) => e.ordinal <= read.through!),
          exhausted: false,
        };
      }
    }
    if (used + closeStatements + budget.markListing > INVOCATION_BUDGET) {
      return exhausted();
    }
    const plan = planChunk(
      members,
      existingRows,
      { key: source.key, type: source.type, covered: source.covered },
      {
        sessionStatements: used + closeStatements,
        statementBudget: budget,
        syncCost: (versions) => writer.syncPackageCost({ versions, tags: 0, guardStatements }),
        syncPayload: {
          limit: writer.syncPayloadLimit,
          bytes: (version) => writer.syncPayloadBytes(ctx, guard, { ...syncInput, version }),
        },
      },
    );
    used = (plan.statements ?? used + closeStatements) - closeStatements;

    const display = new Map(members.map((m) => [m.version.versionNormalized, m.version.version]));
    for (const r of plan.refused) {
      if (r.reason === 'payload_too_large') {
        refused.push({ version: display.get(r.version) ?? r.version, reason: r.reason });
      }
    }
    const writerRefused = new Set<string>();
    for (const call of plan.writerCalls) {
      if (call.method === 'syncPackage') {
        const result = await writer.syncPackage(ctx, guard, {
          ...syncInput,
          versions: call.versions,
        });
        const reasons = new Map(result.refused.map((r) => [r.version, r.reason]));
        for (const v of call.versions) {
          const reason = reasons.get(v.version);
          if (reason === undefined) continue;
          if (reason !== 'tombstoned') writerRefused.add(v.versionNormalized);
          refused.push({ version: v.version, reason });
        }
      } else {
        const conflict = plan.npmConflicts.find(
          (c) => c.versionNormalized === call.versionNormalized,
        );
        if (conflict === undefined) throw new TypeError('planned quarantine has no conflict');
        await writer.quarantine(ctx, guard, {
          versionId: conflict.versionId,
          reason: 'digest_mismatch',
        });
      }
    }
    const present = [
      ...plan.inserts.map((v) => v.versionNormalized),
      ...plan.composerUpdates.map((v) => v.versionNormalized),
      ...plan.npmUpdates.map((v) => v.versionNormalized),
      ...plan.npmConflicts.map((c) => c.versionNormalized),
      ...plan.unchanged,
    ].filter((key) => !writerRefused.has(key));
    for (let offset = 0; offset < present.length; offset += CATALOGUE_KEY_LIST_MAX) {
      await writer.markListing(ctx, guard, {
        scope: { kind: 'package', packageId: cursor.packageId },
        stamp,
        present: present.slice(offset, offset + CATALOGUE_KEY_LIST_MAX),
      });
    }
    marked = present.length;

    const tookAll = plan.cursorAfter === (members.at(-1)?.ordinal ?? null);
    const consumedThrough = tookAll
      ? (window.entries.at(-1)?.ordinal ?? ordinal)
      : plan.cursorAfter;
    const consumed = window.entries.filter(
      (e) => consumedThrough !== null && e.ordinal <= consumedThrough,
    ).length;
    if (consumed === 0 && window.entries.length > 0) {
      return exhausted();
    }
    for (const e of window.entries) {
      if (e.version !== null || consumedThrough === null || e.ordinal > consumedThrough) continue;
      if (e.duplicate) duplicates.push({ version: e.name, ordinal: e.ordinal });
      else refused.push({ version: e.name, reason: 'unreadable' });
    }
    attempted += consumed - duplicates.length;
    ordinal = consumedThrough;
    if (window.exhausted && tookAll) tail = 'tags';
  }

  const skipped: readonly SkippedMember[] = description.skippedMembers;
  if (tail === 'tags') {
    const tags = description.distTags;
    if (
      tags === undefined ||
      !description.upstreamComplete ||
      attempted > session.seenCount + marked
    ) {
      tail = 'finalize';
    } else {
      const entries = Object.entries(tags);
      if (tagOffset > entries.length) tagOffset = 0;
      const remaining = entries.length - tagOffset;
      let size = Math.min(TAGS_PER_CALL, remaining);
      const cost = (count: number) =>
        writer.syncPackageCost({
          versions: 0,
          tags: count,
          guardStatements,
        });
      const fitsFresh =
        remaining <= TAGS_PER_CALL && cost(size) + closeStatements <= INVOCATION_BUDGET;
      if (fitsFresh && used + cost(size) + closeStatements > INVOCATION_BUDGET) size = 0;
      else while (size > 0 && used + cost(size) + closeStatements > INVOCATION_BUDGET) size--;
      if (
        (size > 0 || entries.length === 0) &&
        used + cost(size) + closeStatements <= INVOCATION_BUDGET
      ) {
        const written = await writer.syncPackage(ctx, guard, {
          ...syncInput,
          versions: [],
          tags: Object.fromEntries(entries.slice(tagOffset, tagOffset + size)),
          tagNames: entries.map(([name]) => name),
        });
        skippedTags = written.skippedTags;
        used += cost(size);
        tagOffset += size;
        if (tagOffset >= entries.length) tail = 'finalize';
      } else if (used === 0) {
        return exhausted();
      }
    }
  }

  const next: ApplyCursor = {
    packageId: cursor.packageId,
    ordinal,
    attempted,
    tail,
    ...(tail === 'tags' && tagOffset > 0 ? { tagOffset } : {}),
  };
  const nextText = JSON.stringify(next);
  const progress = await sessions.advance(
    ctx,
    session,
    { cursor: nextText, addSeen: marked },
    guard,
  );
  used += advanceStatements;
  if (progress === null) return outcome('superseded', true);
  session = {
    ...session,
    cursor: nextText,
    seenCount: progress.seenCount,
    pagesSoFar: progress.pagesSoFar,
  };
  if (tail === null || tail === 'tags') return outcome('progress', false, { skipped });

  if (!description.upstreamComplete) {
    skipped.forEach((skip) =>
      deps.observability?.log({
        level: 'info',
        event: 'ingest.version_skipped',
        reason_code: skip.reason,
      }),
    );
    return abandon('incomplete', { skipped });
  }
  if (attempted > progress.seenCount) {
    return abandon('incomplete', {
      refusal: 'refused_members',
      refusedMembers: attempted - progress.seenCount,
    });
  }
  if (used + finalizeCost + ABANDON_STATEMENTS > INVOCATION_BUDGET) {
    return outcome('progress', false, { skipped });
  }

  const result = await deps.finalizer.finalize(
    ctx,
    session,
    {
      expectedCount: progress.seenCount,
      attemptedCandidates: attempted,
      successfulCandidates: progress.seenCount,
      definitiveAbsent: 0,
      upstreamComplete: true,
      validatorTtlSeconds: input.validatorTtlSeconds,
    },
    guard,
  );
  used += finalizeCost;
  if (result.status === 'complete') return outcome('complete', true, { skipped });
  if (result.reason === 'superseded') return outcome('superseded', true);
  if (ABANDONING_REFUSALS.has(result.reason)) {
    return abandon('refused', { refusal: result.reason });
  }
  return outcome('refused', false, { refusal: result.reason });
}
