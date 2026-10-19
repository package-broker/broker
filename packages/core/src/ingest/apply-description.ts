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
import type { IngestFinalizeRefusal, IngestFinalizer } from './finalize.js';
import { INVOCATION_BUDGET, planChunk, type ChunkMember } from './plan-chunk.js';
import type { IngestSessionHandle, IngestSessions } from './session.js';
import { SnapshotCorruptError } from './snapshot.js';
import { UPSTREAM_FORMS } from './validators.js';

export const APPLY_MEMBER_WINDOW = CATALOGUE_KEY_LIST_MAX;
const EXISTING_PAGE_ROWS = 1000;
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
  readonly refusal?: IngestFinalizeRefusal | 'name_not_registered' | 'refused_members';
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

function parseCursor(text: string): ApplyCursor {
  const value = JSON.parse(text) as Partial<ApplyCursor> | null;
  const { packageId, ordinal, attempted, tail } = value ?? {};
  if (
    typeof packageId !== 'string' ||
    packageId === '' ||
    (ordinal !== null && !Number.isSafeInteger(ordinal)) ||
    !Number.isSafeInteger(attempted) ||
    (attempted as number) < 0 ||
    (tail !== null && tail !== 'tags' && tail !== 'finalize')
  ) {
    throw new TypeError('invalid ingest apply cursor');
  }
  return { packageId, ordinal: ordinal as number | null, attempted: attempted as number, tail };
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
  wanted: ReadonlySet<string>,
): Promise<{ rows: ExistingVersion[]; reads: number }> {
  const rows: ExistingVersion[] = [];
  let reads = 0;
  let after: string | null = null;
  do {
    const page = await reader.existingVersions(ctx, {
      packageId,
      after,
      withMetadata: true,
      limit: EXISTING_PAGE_ROWS,
    });
    reads += 1;
    for (const row of page.rows) if (wanted.has(row.versionNormalized)) rows.push(row);
    after = page.next;
  } while (after !== null);
  return { rows, reads };
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
  let tagsSkipped = false;
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
  const outcome = (
    status: ApplyStatus,
    done: boolean,
    extra: Partial<Pick<ApplyOutcome, 'refusal' | 'refusedMembers' | 'skipped'>> = {},
  ): ApplyOutcome => ({
    done,
    cursor: session.cursor,
    status,
    session,
    skipped: extra.skipped ?? [],
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
    if (!(error instanceof SnapshotCorruptError)) throw error;
    return abandon('refused', { refusal: 'incomplete' });
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
  let { ordinal, attempted } = cursor;
  if (tail === null) {
    const members: ChunkMember[] = window.entries.flatMap((e) =>
      e.version === null ? [] : [{ ordinal: e.ordinal, version: e.version }],
    );
    let existingRows: ExistingVersion[] = [];
    if (members.length > 0) {
      const wanted = new Set(members.map((m) => m.version.versionNormalized));
      const read = await readExisting(ctx, deps.existing, cursor.packageId, wanted);
      existingRows = read.rows;
      used += read.reads;
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
      throw new Error('ingest apply made no progress');
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

  const skipped: readonly SkippedMember[] = tail === null ? [] : description.skippedMembers;
  if (tail === 'tags') {
    const tags = description.distTags;
    if (tags === undefined || !description.upstreamComplete) {
      tail = 'finalize';
    } else {
      const tagCost = writer.syncPackageCost({
        versions: 0,
        tags: Object.keys(tags).length,
        guardStatements,
      });
      const fresh = used === 0;
      if (used + tagCost + closeStatements <= INVOCATION_BUDGET) {
        const written = await writer.syncPackage(ctx, guard, { ...syncInput, versions: [], tags });
        skippedTags = written.skippedTags;
        used += tagCost;
        tail = 'finalize';
      } else if (fresh) {
        tagsSkipped = true;
        tail = 'finalize';
      }
    }
  }

  const next: ApplyCursor = { packageId: cursor.packageId, ordinal, attempted, tail };
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
  if (tail === null || tail === 'tags') return outcome('progress', false);

  if (!description.upstreamComplete) {
    skipped.forEach(() =>
      deps.observability?.log({
        level: 'info',
        event: 'ingest.version_skipped',
        reason_code: 'member_too_large',
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
    return outcome('progress', false);
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
  if (result.status === 'complete') return outcome('complete', true);
  if (result.reason === 'superseded') return outcome('superseded', true);
  if (ABANDONING_REFUSALS.has(result.reason)) {
    return abandon('refused', { refusal: result.reason });
  }
  return outcome('refused', false, { refusal: result.reason });
}
