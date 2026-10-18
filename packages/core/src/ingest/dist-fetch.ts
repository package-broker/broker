import type {
  CatalogueWriteGuard,
  CatalogueWriter,
  DistType,
  FetchDescriptor,
  WriteEffect,
} from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';
import { parseSha256, type BlobStore, type Sha256 } from '../platform/blob.js';
import type { ProviderContext, ProviderSource, SourceProvider } from '../sources/provider.js';
import { twoPassPut, type FirstPass } from './two-pass-put.js';

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
}

export interface DistFetchTarget {
  readonly versionId: string;
  readonly revision: number;
  readonly packageName: string;
  readonly version: string;
  readonly fetch: FetchDescriptor;
  readonly previousBlob: { readonly id: string; readonly sha256: Sha256 } | null;
}

export type DistFetchOutcome = 'attached' | 'replaced' | 'quarantined' | 'stale';

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

function refetchable(source: ProviderSource): boolean {
  return !(
    source.type === 'vcs' &&
    (source.config.provider === 'git' || source.config.provider === 'ssh')
  );
}

export async function fetchAndVerifyDist(
  deps: DistFetchDeps,
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  target: DistFetchTarget,
): Promise<DistFetchOutcome> {
  const { fetch } = target;
  if (fetch.upstreamDistUrl === null && fetch.sourceRef === null) {
    throw new Error('dist has no upstream location to fetch from');
  }
  let declaredSize: number | null = null;
  const result = await twoPassPut(
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
      return opened.body;
    },
    deps.store,
    {
      mediaType: fetch.distType === null ? 'application/octet-stream' : MEDIA_TYPES[fetch.distType],
      refetchable: refetchable(deps.source),
      maxBytes: deps.maxBytes,
      codecs: deps.providerContext.codecs,
      signal: deps.providerContext.signal,
      verifyFirstPass: (first) => {
        if (declaredSize !== null && declaredSize !== first.size) throw new DistSizeMismatchError();
        return publishedDigestsMatch(target, first);
      },
    },
  );

  if (result.status === 'rejected') {
    const effect = await deps.writer.quarantine(ctx, guard, {
      versionId: target.versionId,
      reason: 'digest_mismatch',
    });
    if (!effect.changed) return 'stale';
    deps.providerContext.observability.log({
      level: 'warn',
      event: 'dist.quarantined',
      reason_code: 'digest_mismatch',
    });
    return 'quarantined';
  }

  const sha256 = result.info.sha256;
  if (target.previousBlob !== null && target.previousBlob.sha256 !== sha256) {
    const effect = await deps.blobReplacer.replaceBlob(ctx, guard, {
      versionId: target.versionId,
      expectedRevision: target.revision,
      oldBlobId: target.previousBlob.id,
      newSha256: parseSha256(sha256),
      reason: 'refetch_changed',
    });
    return effect.changed ? 'replaced' : 'stale';
  }
  const effect = await deps.writer.attachDist(ctx, guard, {
    versionId: target.versionId,
    revision: target.revision,
    sha256,
  });
  return effect.changed ? 'attached' : 'stale';
}
