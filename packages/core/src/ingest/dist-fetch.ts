import { PublishValidationError } from '../registry/npm/tarball-walk.js';
import { NPM_PACK_SKIP_CODES, type NpmPackSkipCode } from '../sources/source-error-codes.js';
import { packTarball } from '../registry/npm/tarball-pack.js';
import { formatIntegrity } from '../platform/codec.js';
import type {
  CatalogueWriteGuard,
  CatalogueWriter,
  DistType,
  FetchDescriptor,
  WriteEffect,
} from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';
import {
  BlobTooLargeError,
  parseSha256,
  type CoreBlobStore as BlobStore,
  type Sha256,
  type StagedBlob,
} from '../platform/blob.js';
import { UpstreamError } from '../sources/policy-fetch.js';
import {
  ProviderBusyError,
  type ProviderContext,
  type ProviderSource,
  type SourceProvider,
} from '../sources/provider.js';
import {
  TwoPassLimitError,
  twoPassPut,
  type FirstPass,
  type TwoPassResult,
} from './two-pass-put.js';

export interface ReplaceBlobRequest {
  readonly versionId: string;
  readonly expectedRevision: number;
  readonly oldBlobId: string;
  readonly newSha256: Sha256;
  readonly reason: 'refetch_changed';
}

export interface BlobReplacer {
  replaceBlob(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    request: ReplaceBlobRequest,
  ): Promise<WriteEffect>;
}

export interface DistFetchDeps {
  readonly provider: Pick<SourceProvider, 'openDist'>;
  readonly providerContext: ProviderContext;
  readonly source: ProviderSource;
  readonly store: BlobStore;
  readonly writer: Pick<CatalogueWriter, 'attachDist' | 'quarantine'>;
  readonly blobReplacer: BlobReplacer;
  readonly maxBytes: number;
  readonly enqueueNpmVcsBuild?: () => Promise<void>;
  readonly reportSkipped?: (code: NpmPackSkipCode) => Promise<void>;
}

export interface DistFetchTarget {
  readonly versionId: string;
  readonly revision: number;
  readonly packageName: string;
  readonly version: string;
  readonly fetch: FetchDescriptor;
  readonly previousBlob: { readonly id: string; readonly sha256: Sha256 } | null;
  readonly packageKey?: string;
}

export type DistFetchOutcome = 'attached' | 'replaced' | 'quarantined' | 'stale' | 'skipped';

export class DistSizeMismatchError extends Error {
  override readonly name = 'DistSizeMismatchError';
  constructor() {
    super('upstream body size differs from declared size');
  }
}

const MEDIA_TYPES: Readonly<Record<DistType, string>> = {
  zip: 'application/zip',
  tgz: 'application/gzip',
  tar: 'application/octet-stream',
};

const INTEGRITY_ALGORITHMS = ['sha512', 'sha256', 'sha1'] as const;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function published(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

function integrityMatches(integrity: string, first: FirstPass): boolean {
  const entries = integrity
    .split(/\s+/)
    .filter((entry) => entry !== '')
    .map((entry) => {
      const dash = entry.indexOf('-');
      const rest = entry.slice(dash + 1);
      const option = rest.indexOf('?');
      return {
        algorithm: entry.slice(0, Math.max(dash, 0)).toLowerCase(),
        value: option === -1 ? rest : rest.slice(0, option),
      };
    });
  const algorithm = INTEGRITY_ALGORITHMS.find((a) => entries.some((e) => e.algorithm === a));
  if (algorithm === undefined) return false;
  const actual = base64(first[algorithm]);
  return entries.some((e) => e.algorithm === algorithm && e.value === actual);
}

/** True when every published digest, and the previous sha256 if one was published, matches. */
function publishedDigestsMatch(target: DistFetchTarget, first: FirstPass): boolean {
  const { composerShasum, npmIntegrity, npmShasum } = target.fetch;
  const composer = published(composerShasum);
  const integrity = published(npmIntegrity);
  const legacy = published(npmShasum);
  const anyPublished = composer !== null || integrity !== null || legacy !== null;
  if (
    anyPublished &&
    target.previousBlob !== null &&
    target.previousBlob.sha256 !== hex(first.sha256)
  ) {
    return false;
  }
  if (composer !== null && composer.toLowerCase() !== hex(first.sha1)) return false;
  if (integrity !== null && !integrityMatches(integrity, first)) return false;
  if (legacy !== null && legacy.toLowerCase() !== hex(first.sha1)) return false;
  return true;
}

function overSizeCap(error: unknown): boolean {
  return (
    error instanceof TwoPassLimitError ||
    error instanceof BlobTooLargeError ||
    (error instanceof UpstreamError && error.code === 'too_large')
  );
}

async function quarantine(
  deps: DistFetchDeps,
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  target: DistFetchTarget,
  reasonCode: 'digest_mismatch' | 'archive_too_large',
): Promise<DistFetchOutcome> {
  const effect = await deps.writer.quarantine(ctx, guard, {
    versionId: target.versionId,
    reason: 'digest_mismatch',
  });
  if (!effect.changed) return 'stale';
  deps.providerContext.observability.log({
    level: 'warn',
    event: 'dist.quarantined',
    reason_code: reasonCode,
    ...(target.packageKey === undefined
      ? { source_id: deps.source.id }
      : { source_id: deps.source.id, package_key: target.packageKey }),
  });
  return 'quarantined';
}

function refetchable(source: ProviderSource): boolean {
  return !(source.type === 'vcs' && source.config.provider === 'ssh');
}

export async function fetchAndVerifyDist(
  deps: DistFetchDeps,
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  target: DistFetchTarget,
): Promise<DistFetchOutcome> {
  if (deps.source.type === 'vcs' && deps.source.ecosystem === 'npm') {
    if (deps.enqueueNpmVcsBuild !== undefined) await deps.enqueueNpmVcsBuild();
    throw new ProviderBusyError();
  }
  const { fetch } = target;
  if (fetch.upstreamDistUrl === null && fetch.sourceRef === null) {
    throw new Error('dist has no upstream location to fetch from');
  }
  let declaredSize: number | null = null;
  let result: TwoPassResult;
  try {
    result = await twoPassPut(
      ctx,
      async () => {
        const opened = await deps.provider.openDist(deps.providerContext, deps.source, {
          packageName: target.packageName,
          version: target.version,
          distType: fetch.distType,
          sourceRef: fetch.sourceRef,
          url: fetch.upstreamDistUrl,
        });
        declaredSize = opened.size;
        if (opened.size !== null && opened.size > deps.maxBytes) {
          await opened.body.cancel().catch(() => undefined);
          throw new TwoPassLimitError(deps.maxBytes);
        }
        return opened.body;
      },
      deps.store,
      {
        mediaType:
          fetch.distType === null ? 'application/octet-stream' : MEDIA_TYPES[fetch.distType],
        refetchable: refetchable(deps.source),
        maxBytes: deps.maxBytes,
        codecs: deps.providerContext.codecs,
        signal: deps.providerContext.signal,
        verifyFirstPass: (first) => {
          if (declaredSize !== null && declaredSize !== first.size)
            throw new DistSizeMismatchError();
          return publishedDigestsMatch(target, first);
        },
      },
    );
  } catch (error) {
    if (deps.providerContext.signal.aborted || !overSizeCap(error)) throw error;
    return quarantine(deps, ctx, guard, target, 'archive_too_large');
  }

  if (result.status === 'rejected') return quarantine(deps, ctx, guard, target, 'digest_mismatch');

  const sha256 = result.info.sha256;
  if (target.previousBlob !== null && target.previousBlob.sha256 !== sha256) {
    const effect = await deps.blobReplacer.replaceBlob(ctx, guard, {
      versionId: target.versionId,
      expectedRevision: target.revision,
      oldBlobId: target.previousBlob.id,
      newSha256: parseSha256(sha256),
      reason: 'refetch_changed',
    });
    if (!effect.changed) return 'stale';
    deps.providerContext.observability.log({
      level: 'warn',
      event: 'dist.refetch_changed',
      version_id: target.versionId,
      revision: target.revision,
      previous_sha256_prefix: target.previousBlob.sha256.slice(0, 12),
      sha256_prefix: sha256.slice(0, 12),
    });
    return 'replaced';
  }
  const effect = await deps.writer.attachDist(ctx, guard, {
    versionId: target.versionId,
    revision: target.revision,
    sha256,
  });
  return effect.changed ? 'attached' : 'stale';
}

export async function buildNpmVcsDist(
  deps: DistFetchDeps,
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  target: DistFetchTarget,
): Promise<DistFetchOutcome> {
  if (
    deps.source.type !== 'vcs' ||
    deps.source.ecosystem !== 'npm' ||
    target.fetch.sourceRef === null ||
    !/^[a-f0-9]{40}$/.test(target.fetch.sourceRef) ||
    target.previousBlob !== null
  ) {
    throw new TypeError('invalid_npm_vcs_build');
  }
  const signal = deps.providerContext.signal;
  signal.throwIfAborted();
  let repository: StagedBlob | undefined;
  let packed: StagedBlob | undefined;
  let promoted = false;
  try {
    const opened = await deps.provider.openDist(deps.providerContext, deps.source, {
      packageName: target.packageName,
      version: target.version,
      distType: 'tgz',
      sourceRef: target.fetch.sourceRef,
      url: null,
    });
    const inputCap = 64 * 1024 * 1024;
    if (opened.size !== null && opened.size > inputCap) {
      await opened.body.cancel();
      throw new BlobTooLargeError();
    }
    repository = await deps.store.stage(ctx, opened.body, {
      maxBytes: inputCap,
      mediaType: 'application/gzip',
    });
    const input = repository;
    const result = await packTarball({
      open: async () =>
        (await deps.store.openStaged(ctx, input)).pipeThrough(
          deps.providerContext.codecs.gunzip(256 * 1024 * 1024),
          { signal },
        ),
      codecs: deps.providerContext.codecs,
      maxOutputBytes: Math.min(deps.maxBytes, 50_000_000),
    });
    const digest = deps.providerContext.codecs.digestTap(['sha512']);
    packed = await deps.store.stage(ctx, result.body.pipeThrough(digest.transform, { signal }), {
      maxBytes: Math.min(deps.maxBytes, 50_000_000),
      mediaType: 'application/gzip',
    });
    const npmIntegrity = formatIntegrity('sha512', (await digest.digests).sha512);
    signal.throwIfAborted();
    promoted = true;
    const blob = await deps.store.promote(ctx, packed, { refetchable: false });
    signal.throwIfAborted();
    const filename = result.readmeFilename ?? 'README';
    const effect = await deps.writer.attachDist(ctx, guard, {
      versionId: target.versionId,
      revision: target.revision,
      sha256: blob.sha256,
      expectedGeneration: blob.generation,
      npmIntegrity,
      readmeTruncated: result.readmeTruncated,
      readme: result.readme === null ? null : { filename, body: result.readme },
    });
    return effect.changed ? 'attached' : 'stale';
  } catch (error) {
    if (error instanceof PublishValidationError) {
      const code = error.code === 'candidate_skipped' ? error.detail : error.code;
      if (
        (NPM_PACK_SKIP_CODES as readonly (string | undefined)[]).includes(code) &&
        deps.reportSkipped !== undefined
      ) {
        await deps.reportSkipped(code as NpmPackSkipCode);
        return 'skipped';
      }
    }
    throw error;
  } finally {
    if (repository !== undefined) await deps.store.discard(ctx, repository).catch(() => undefined);
    if (packed !== undefined && !promoted)
      await deps.store.discard(ctx, packed).catch(() => undefined);
  }
}
