import type { CatalogueDocKind, FetchDescriptor } from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import type { Codecs } from '../platform/codec.js';
import type { Sha256 } from '../platform/blob.js';
import type { Observability } from '../platform/observability.js';
import type {
  ComposerRepositoryConfig,
  NpmRegistryConfig,
  NpmjsProxyConfig,
  PackagistProxyConfig,
  SourceEcosystem,
  SourceType,
  VcsConfig,
} from './config.js';
import type { BearerMaterial } from './credentials.js';
import { UpstreamError, type PolicyFetch, type UpstreamCredential } from './policy-fetch.js';

/**
 * A listing has one listing-level snapshot id that every page carries. A provider whose upstream
 * changes ETag per page must derive a listing-level id, for example from the first page or the root document.
 */
export interface SnapshotRef {
  /** A quoted strong ETag, or `sha256:` plus the hex digest of the bytes read. */
  readonly id: string;
  readonly stagedBlob?: Sha256;
}

const STRONG_ETAG = /^"[^"]+"$/;
const BYTES_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function snapshotRef(id: string, stagedBlob?: Sha256): SnapshotRef {
  if (!STRONG_ETAG.test(id) && !BYTES_DIGEST.test(id)) {
    throw new TypeError('snapshot id must be a strong ETag or sha256:<64 hex>');
  }
  return stagedBlob === undefined ? { id } : { id, stagedBlob };
}

export function assertSnapshotRef(ref: SnapshotRef): void {
  snapshotRef(ref.id, ref.stagedBlob);
}

export interface ProviderContext {
  readonly org: OrgContext;
  readonly fetch: PolicyFetch;
  readonly credential: UpstreamCredential | null;
  readonly codecs: Codecs;
  readonly signal: AbortSignal;
  readonly clock: Clock;
  readonly observability: Observability;
}

export type VcsProviderId = 'github' | 'git' | 'ssh';

interface ProviderSourceBase {
  readonly id: string;
  readonly ecosystem: SourceEcosystem;
  readonly url: string | null;
}

/** For `vcs` the provider id is `config.provider`; the other types name the provider registered for them. */
export type ProviderSource = ProviderSourceBase &
  (
    | { readonly type: 'vcs'; readonly config: VcsConfig }
    | {
        readonly type: 'composer_repository';
        readonly config: ComposerRepositoryConfig;
        readonly providerId: string;
      }
    | {
        readonly type: 'packagist_proxy';
        readonly config: PackagistProxyConfig;
        readonly providerId: string;
      }
    | {
        readonly type: 'npmjs_proxy';
        readonly config: NpmjsProxyConfig;
        readonly providerId: string;
      }
    | {
        readonly type: 'npm_registry';
        readonly config: NpmRegistryConfig;
        readonly providerId: string;
      }
  );

export function providerIdOf(source: ProviderSource): string {
  return source.type === 'vcs' ? source.config.provider : source.providerId;
}

export interface ListingPage {
  readonly names: readonly string[];
  readonly next: string | null;
  readonly last: boolean;
  readonly snapshot: SnapshotRef;
}

export interface Validators {
  readonly etag?: string;
  readonly lastModified?: string;
}

export type DocumentValidators = Partial<Record<CatalogueDocKind, Validators>>;

export type ComposerForm = Extract<CatalogueDocKind, 'composer-p2' | 'composer-p2-dev'>;

export interface VersionCandidate {
  /** Strictly increasing position in the upstream document order of one snapshot. */
  readonly ordinal: number;
  readonly version: string;
  readonly form: CatalogueDocKind | 'npm-vcs';
  readonly upstreamTime?: string;
  /** The raw JSON text of the version object. */
  readonly raw: string;
}

export interface FormEvidence {
  readonly form: ComposerForm;
  readonly status: 'present' | 'absent';
  readonly snapshot: SnapshotRef;
  readonly validators: Validators;
}

/** A selected member the description left out of `members`. */
export interface SkippedMember {
  readonly version: string;
  readonly reason: 'member_too_large' | 'name_mismatch' | 'version_mismatch' | 'invalid_manifest';
}

declare const descriptionBrand: unique symbol;
const created = new WeakSet<object>();

export interface PackageDescription {
  readonly [descriptionBrand]: true;
  readonly name: string;
  readonly snapshot: SnapshotRef;
  readonly forms?: readonly FormEvidence[];
  readonly members: AsyncIterable<VersionCandidate>;
  readonly distTags?: Readonly<Record<string, string>>;
  readonly validators: DocumentValidators;
  /**
   * Read after `members` is exhausted; true only if every requested document was returned and
   * parsed fully and no member was skipped.
   */
  readonly upstreamComplete: boolean;
  /** Read after `members` is exhausted. */
  readonly skippedMembers: readonly SkippedMember[];
}

export function isPackageDescription(value: unknown): value is PackageDescription {
  return typeof value === 'object' && value !== null && created.has(value);
}

export type DescribeFound = { readonly kind: 'found'; readonly description: PackageDescription };
export type DescribeNotFound = { readonly kind: 'not_found'; readonly definitive: boolean };
export type DescribeResult = { readonly kind: 'not_modified' } | DescribeNotFound | DescribeFound;

export type DescribeOptions =
  | { readonly validators: DocumentValidators; readonly snapshot?: never }
  | { readonly snapshot: SnapshotRef; readonly validators?: never }
  | { readonly validators?: never; readonly snapshot?: never };

export function assertDescribeResult(options: DescribeOptions, result: DescribeResult): void {
  if (options.snapshot !== undefined && result.kind === 'not_modified') {
    throw new TypeError('describe with a snapshot must not answer not_modified');
  }
}

export interface ProviderDistTarget extends Pick<FetchDescriptor, 'distType' | 'sourceRef'> {
  readonly packageName: string;
  readonly version: string;
  readonly url: string | null;
}

/** A provider cannot open a dist right now; the caller answers busy and the client retries. */
export class ProviderBusyError extends Error {
  override readonly name = 'ProviderBusyError';
  constructor() {
    super('provider busy');
  }
}

export interface DistStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number | null;
}

export interface DiscoveredRepository {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly archived?: boolean;
}

export interface RepositoryPage {
  readonly repositories: readonly DiscoveredRepository[];
  readonly next: string | null;
}

export interface WebhookVerifier {
  verify(secret: BearerMaterial, headers: Headers, rawBody: Uint8Array): Promise<boolean>;
}

export interface RepositoryIdentity {
  readonly repository: string;
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
}

export interface SourceProvider {
  lookupRepository?(
    ctx: ProviderContext,
    source: ProviderSource,
    repository: string,
  ): Promise<RepositoryIdentity | null>;
  readonly id: string;
  readonly sourceTypes: readonly SourceType[];
  readonly ecosystems: readonly SourceEcosystem[];
  listPackages?(
    ctx: ProviderContext,
    source: ProviderSource,
    cursor: string | null,
  ): Promise<ListingPage>;
  /** With `options.snapshot` set, `not_modified` is not a valid answer; see assertDescribeResult. */
  describe(
    ctx: ProviderContext,
    source: ProviderSource,
    name: string,
    options: DescribeOptions,
  ): Promise<DescribeResult>;
  openDist(
    ctx: ProviderContext,
    source: ProviderSource,
    target: ProviderDistTarget,
  ): Promise<DistStream>;
  discoverRepositories?(
    ctx: ProviderContext,
    credential: UpstreamCredential,
    cursor: string | null,
  ): Promise<RepositoryPage>;
  readonly webhookVerifier?: WebhookVerifier;
}

export interface PackageDescriptionInput {
  readonly name: string;
  readonly snapshot: SnapshotRef;
  readonly forms?: readonly FormEvidence[];
  readonly members: AsyncIterable<VersionCandidate>;
  readonly distTags?: Readonly<Record<string, string>>;
  readonly validators: DocumentValidators;
  /** Every requested document came back 200 or 304 and parsed fully; a function is read after the members are drained. */
  readonly documentsComplete: boolean | (() => boolean);
  /** Default empty; a function is read after the members are drained. */
  readonly skippedMembers?: readonly SkippedMember[] | (() => readonly SkippedMember[]);
}

export function createPackageDescription(input: PackageDescriptionInput): PackageDescription {
  assertSnapshotRef(input.snapshot);
  for (const form of input.forms ?? []) assertSnapshotRef(form.snapshot);
  let exhausted = false;
  let started = false;
  let failed = false;
  const source = input.members;
  const members: AsyncIterable<VersionCandidate> = {
    [Symbol.asyncIterator]() {
      if (started) throw new Error('package members were already read');
      started = true;
      const inner = source[Symbol.asyncIterator]();
      let previous = -1;
      const validateOrdinal = (ordinal: number): void => {
        if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
          throw new RangeError('member ordinals must be safe integers of at least 0');
        }
        if (ordinal <= previous) {
          throw new RangeError('member ordinals must be strictly increasing');
        }
      };
      return {
        async next() {
          let step: IteratorResult<VersionCandidate>;
          try {
            step = await inner.next();
            if (step.done !== true) validateOrdinal(step.value.ordinal);
          } catch (error) {
            failed = true;
            throw error;
          }
          if (step.done === true) {
            exhausted = true;
          } else {
            previous = step.value.ordinal;
          }
          return step;
        },
        async return(value) {
          return inner.return === undefined ? { done: true as const, value } : inner.return(value);
        },
      };
    },
  };
  const skippedMembers = (): readonly SkippedMember[] => {
    const listed =
      typeof input.skippedMembers === 'function'
        ? input.skippedMembers()
        : (input.skippedMembers ?? []);
    return Object.freeze(listed.map(({ version, reason }) => Object.freeze({ version, reason })));
  };
  const description = {
    name: input.name,
    snapshot: input.snapshot,
    ...(input.forms === undefined ? {} : { forms: input.forms }),
    ...(input.distTags === undefined ? {} : { distTags: input.distTags }),
    validators: input.validators,
    members,
    get upstreamComplete() {
      const documents =
        typeof input.documentsComplete === 'function'
          ? input.documentsComplete()
          : input.documentsComplete;
      return (
        documents &&
        exhausted &&
        !failed &&
        skippedMembers().every(
          (skip) =>
            skip.reason === 'name_mismatch' ||
            skip.reason === 'version_mismatch' ||
            skip.reason === 'invalid_manifest',
        )
      );
    },
    get skippedMembers() {
      return skippedMembers();
    },
  } as PackageDescription;
  created.add(description);
  return description;
}

/** Pages one listing session may fetch across all its chunks. */
export const SESSION_PAGE_CAP = 10_000;

export interface ListingInput {
  readonly cursor: string | null;
  /** The session's snapshot; null on the first chunk. */
  readonly snapshot: SnapshotRef | null;
  /** Pages this call may fetch before returning a continuation; a safe integer of at least 1. */
  readonly pageBudget: number;
  /** Pages fetched by earlier chunks of this session. Cycle detection covers one call only. */
  readonly pagesSoFar: number;
  readonly signal?: AbortSignal;
}

export type ListingStop =
  'last' | 'budget' | 'cycle' | 'snapshot_changed' | 'error' | 'no_next' | 'inconsistent_last';

export interface ListingOutcome {
  readonly complete: boolean;
  /** Distinct names reported by this call; a resumed session sums its chunks. */
  readonly count: number;
  readonly snapshot: SnapshotRef | null;
  /** Cursor to resume from; null when the listing ended or cannot continue. */
  readonly next: string | null;
  /** Session total including this call, to pass as `pagesSoFar` to the next chunk. */
  readonly pagesSoFar: number;
  readonly stop: ListingStop;
  /** The session must be abandoned: the upstream snapshot changed. */
  readonly abandoned: boolean;
  readonly error?: UpstreamError;
}

/** Walks up to `pageBudget` pages. Core reports this outcome to the session finalize and never mints a proof itself. */
export async function collectListing(
  fetchPage: (cursor: string | null) => Promise<ListingPage>,
  onNames: (names: readonly string[]) => Promise<void>,
  input: ListingInput,
): Promise<ListingOutcome> {
  if (!Number.isSafeInteger(input.pageBudget) || input.pageBudget < 1) {
    throw new RangeError('pageBudget must be a safe integer of at least 1');
  }
  if (!Number.isSafeInteger(input.pagesSoFar) || input.pagesSoFar < 0) {
    throw new RangeError('pagesSoFar must be a safe integer of at least 0');
  }
  if (input.snapshot !== null) assertSnapshotRef(input.snapshot);
  const budget = Math.min(input.pageBudget, Math.max(0, SESSION_PAGE_CAP - input.pagesSoFar));
  let pages = input.pagesSoFar;
  const seenCursors = new Set<string>();
  const names = new Set<string>();
  let cursor = input.cursor;
  let snapshot = input.snapshot;
  const stopped = (
    stop: ListingStop,
    next: string | null,
    extra: { error?: UpstreamError; abandoned?: boolean } = {},
  ): ListingOutcome => ({
    complete: false,
    count: names.size,
    snapshot,
    next,
    pagesSoFar: pages,
    stop,
    abandoned: extra.abandoned ?? false,
    ...(extra.error === undefined ? {} : { error: extra.error }),
  });
  for (let fetched = 0; fetched < budget; fetched += 1) {
    if (input.signal?.aborted === true) {
      throw new DOMException('listing aborted', 'AbortError');
    }
    if (cursor !== null) {
      if (seenCursors.has(cursor)) return stopped('cycle', null);
      seenCursors.add(cursor);
    }
    let page: ListingPage;
    pages += 1;
    try {
      page = await fetchPage(cursor);
    } catch (error) {
      if (error instanceof UpstreamError) return stopped('error', cursor, { error });
      throw error;
    }
    assertSnapshotRef(page.snapshot);
    if (snapshot !== null && page.snapshot.id !== snapshot.id) {
      return stopped('snapshot_changed', null, { abandoned: true });
    }
    snapshot = page.snapshot;
    await onNames(page.names);
    for (const name of page.names) names.add(name);
    if (page.last) {
      if (page.next !== null) return stopped('inconsistent_last', null);
      return {
        complete: true,
        count: names.size,
        snapshot,
        next: null,
        pagesSoFar: pages,
        stop: 'last',
        abandoned: false,
      };
    }
    if (page.next === null) return stopped('no_next', null);
    cursor = page.next;
  }
  return stopped('budget', cursor);
}

export type ProviderRegistryErrorCode = 'duplicate' | 'unregistered' | 'ambiguous' | 'invalid';

export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode;

  constructor(code: ProviderRegistryErrorCode, sourceType: string, providerId?: string) {
    super(
      providerId === undefined
        ? `provider ${code} for source type ${sourceType}`
        : `provider ${code}: ${providerId} for source type ${sourceType}`,
    );
    this.name = 'ProviderRegistryError';
    this.code = code;
  }
}

export interface ProviderRegistry {
  register(provider: SourceProvider): void;
  get(sourceType: SourceType, providerId?: string): SourceProvider;
  forSource(source: ProviderSource): SourceProvider;
}

/** Returned providers check their own answers so a consumer cannot skip the contract. */
function guardProvider(provider: SourceProvider): SourceProvider {
  const { listPackages, discoverRepositories, lookupRepository } = provider;
  return {
    id: provider.id,
    sourceTypes: provider.sourceTypes,
    ecosystems: provider.ecosystems,
    ...(provider.webhookVerifier === undefined
      ? {}
      : { webhookVerifier: provider.webhookVerifier }),
    ...(listPackages === undefined
      ? {}
      : {
          async listPackages(ctx, source, cursor) {
            const page = await listPackages.call(provider, ctx, source, cursor);
            assertSnapshotRef(page.snapshot);
            return page;
          },
        }),
    ...(discoverRepositories === undefined
      ? {}
      : {
          discoverRepositories: (ctx, credential, cursor) =>
            discoverRepositories.call(provider, ctx, credential, cursor),
        }),
    ...(lookupRepository === undefined
      ? {}
      : {
          lookupRepository: (ctx, source, repository) =>
            lookupRepository.call(provider, ctx, source, repository),
        }),
    openDist: (ctx, source, target) => provider.openDist(ctx, source, target),
    async describe(ctx, source, name, options) {
      const result = await provider.describe(ctx, source, name, options);
      assertDescribeResult(options, result);
      if (result.kind === 'found') {
        if (!isPackageDescription(result.description)) {
          throw new TypeError('describe must return a description from createPackageDescription');
        }
        assertSnapshotRef(result.description.snapshot);
      }
      return result;
    },
  };
}

export function createProviderRegistry(): ProviderRegistry {
  const byType = new Map<SourceType, Map<string, SourceProvider>>();
  const registry: ProviderRegistry = {
    register(provider) {
      if (provider.sourceTypes.length === 0) {
        throw new ProviderRegistryError('invalid', '(none)', provider.id);
      }
      for (const type of provider.sourceTypes) {
        if (type === 'hosted') throw new ProviderRegistryError('invalid', type, provider.id);
        if (byType.get(type)?.has(provider.id) === true) {
          throw new ProviderRegistryError('duplicate', type, provider.id);
        }
      }
      const guarded = guardProvider(provider);
      for (const type of provider.sourceTypes) {
        const providers = byType.get(type) ?? new Map<string, SourceProvider>();
        providers.set(provider.id, guarded);
        byType.set(type, providers);
      }
    },
    get(sourceType, providerId) {
      const providers = byType.get(sourceType);
      if (providers === undefined) throw new ProviderRegistryError('unregistered', sourceType);
      if (providerId !== undefined) {
        const found = providers.get(providerId);
        if (found === undefined) {
          throw new ProviderRegistryError('unregistered', sourceType, providerId);
        }
        return found;
      }
      const [only, ...rest] = providers.values();
      if (only === undefined) throw new ProviderRegistryError('unregistered', sourceType);
      if (rest.length > 0) throw new ProviderRegistryError('ambiguous', sourceType);
      return only;
    },
    forSource(source) {
      return registry.get(source.type, providerIdOf(source));
    },
  };
  return registry;
}
