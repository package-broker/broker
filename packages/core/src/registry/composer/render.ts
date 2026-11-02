import { apiError } from '../../api/response.js';
import type { ProjectActor } from '../../authz/project-actor.js';
import { catalogueCacheKey } from '../../catalogue/cache-keys.js';
import { PACKAGES_READ, type PackageAccess } from '../../catalogue/package-access.js';
import type { CatalogueVersion, PackageResolution } from '../../db/catalogue.js';
import { CATALOGUE_PAGE_MAX } from '../../db/catalogue.js';
import { defaultEntry, MAX_ENTRY_BYTES, type ScopedCache } from '../../platform/cache.js';
import {
  composerValidators,
  isNotModified,
  notModifiedResponse,
  representationValidator,
  validatorHeaders,
  type RepresentationClock,
} from '../conditional.js';
import {
  RegistryPolicyBoundError,
  RegistryPolicyChangedError,
  RegistryPolicyUnavailableError,
} from '../policy/errors.js';
import { POLICY_METADATA_CACHE_CONTROL, policyErrorResponse } from '../policy/http.js';
import { withPolicyRetry, type RegistryReadSession } from '../policy/session.js';
import { policyEntityTag, type DecidedVersion } from '../policy/validator.js';
import { composerDistPath } from './dist-url.js';
import { minifyVersions } from './minify.js';

export interface ComposerRenderOptions {
  /** The request id supplied by the caller. */
  readonly requestId: string;
  readonly actor: ProjectActor;
  readonly access: PackageAccess;
  readonly projectSlug: string;
  /** Present only when registry policy governs this read; `access` is then its facade. */
  readonly policy?: { readonly session: RegistryReadSession };
}

export interface ComposerP2Options extends ComposerRenderOptions {
  readonly name: string;
  readonly publicUrl: string;
  readonly request: Request;
  readonly clock: RepresentationClock;
  readonly dev?: boolean;
  readonly cache?: ScopedCache;
}

const encoder = new TextEncoder();
const CACHE_CONTROL = 'private, max-age=300';

function authorized(actor: ProjectActor): boolean {
  return actor.kind === 'project' && actor.permissions.has(PACKAGES_READ);
}

function missing(options: ComposerRenderOptions): Response {
  const requestId = options.requestId;
  const response = apiError('not_found', requestId);
  response.headers.set('x-request-id', requestId);
  response.headers.set('Cache-Control', CACHE_CONTROL);
  response.headers.set('Vary', 'Authorization');
  return response;
}

function unavailable(options: ComposerRenderOptions): Response {
  const requestId = options.requestId;
  const response = apiError('unavailable', requestId);
  response.headers.set('x-request-id', requestId);
  return response;
}

type Json = Record<string, unknown>;
function record(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderVersion(
  version: CatalogueVersion,
  page: PackageResolution,
  options: ComposerP2Options,
): Json | null {
  if ((version.stability === 'dev') !== (options.dev ?? false)) return null;
  const metadata = JSON.parse(version.metadataJson) as unknown;
  if (!record(metadata)) return null;
  const rendered: Json = {
    ...metadata,
    version: version.version,
    version_normalized: version.versionNormalized,
    time: version.upstreamReleasedAt ?? version.publishedAt,
  };
  delete rendered.dist;
  if (version.distType === 'zip' || version.distType === 'tar') {
    let path: string;
    try {
      path = composerDistPath({
        project: options.projectSlug,
        key: page.pkg.key,
        versionId: version.versionId,
        revision: version.revision,
        type: version.distType,
      });
    } catch {
      return record(rendered.source) ? rendered : null;
    }
    const dist = record(metadata.dist) ? metadata.dist : {};
    rendered.dist = {
      type: version.distType,
      url: options.publicUrl + path,
      reference: typeof dist.reference === 'string' ? dist.reference : '',
      shasum: version.composerShasum ?? '',
    };
    delete rendered.source;
  }
  return rendered.type === 'metapackage' || rendered.dist !== undefined || record(rendered.source)
    ? rendered
    : null;
}

class CatalogueChangedError extends Error {
  constructor() {
    super('catalogue changed');
    this.name = 'CatalogueChangedError';
  }
}
class ListingIncompleteError extends Error {}

async function* document(
  first: PackageResolution,
  options: ComposerP2Options,
  beforePage?: () => Promise<void>,
): AsyncGenerator<Uint8Array> {
  let page = first;
  let previous: Json | undefined;
  for (;;) {
    for (const version of page.versions) {
      const rendered = renderVersion(version, page, options);
      if (rendered === null) continue;
      if (!first.pkg.listingComplete) throw new ListingIncompleteError();
      if (previous === undefined) {
        const name = typeof rendered.name === 'string' ? rendered.name : first.pkg.key;
        yield encoder.encode(`{"packages":{${JSON.stringify(name)}:[`);
      }
      const minified = previous === undefined ? rendered : minifyVersions([previous, rendered])[1];
      yield encoder.encode((previous === undefined ? '' : ',') + JSON.stringify(minified));
      previous = rendered;
    }
    if (page.next === null) break;
    await beforePage?.();
    const next = await options.access.versions(options.actor, 'composer', first.pkg.key, {
      limit: CATALOGUE_PAGE_MAX,
      binding: first.binding,
      after: page.next,
    });
    if (next === null || 'changed' in next) throw new CatalogueChangedError();
    page = next;
  }
  if (previous !== undefined) yield encoder.encode(']},"minified":"composer/2.0"}');
}

/** Every surviving version of the whole document, read before any validator is issued. */
async function preflight(
  first: PackageResolution,
  options: ComposerP2Options,
): Promise<DecidedVersion[]> {
  const decided: DecidedVersion[] = [];
  let page = first;
  for (;;) {
    for (const version of page.versions) {
      decided.push({ versionId: version.versionId, revision: version.revision });
    }
    if (page.next === null) return decided;
    const next = await options.access.versions(options.actor, 'composer', first.pkg.key, {
      limit: CATALOGUE_PAGE_MAX,
      binding: first.binding,
      after: page.next,
    });
    if (next === null || 'changed' in next) throw new CatalogueChangedError();
    page = next;
  }
}

/**
 * The policy-governed P2 document: filtered before minification, sealed before any validator,
 * 304 or byte, never written to the shared rendered cache, and validated by entity tag only.
 */
async function renderGovernedP2(
  options: ComposerP2Options,
  session: RegistryReadSession,
): Promise<Response> {
  const form = options.dev ? 'composer-p2-dev' : 'composer-p2';
  const firstAttempt = session.attempt();
  for (let attempt = 0; attempt < 2; attempt++) {
    let iterator: AsyncGenerator<Uint8Array> | undefined;
    try {
      const first = await options.access.versions(options.actor, 'composer', options.name, {
        limit: CATALOGUE_PAGE_MAX,
      });
      if (first === null) return missing(options);
      if ('changed' in first) continue;
      const decided = await preflight(first, options);
      const etag = await policyEntityTag(
        await representationValidator(first.pkg, form, 1, {
          projectSlug: options.projectSlug,
          origin: options.publicUrl,
        }),
        {
          versions: decided,
          nextBoundary: session.nextBoundary(),
          clientFamily: session.clientFamily,
        },
      );
      const body = document(first, options, () => session.seal());
      iterator = body;
      const chunks: Uint8Array[] = [];
      let size = 0;
      let complete = false;
      while (size <= MAX_ENTRY_BYTES) {
        const chunk = await body.next();
        if (chunk.done) {
          complete = true;
          break;
        }
        chunks.push(chunk.value);
        size += chunk.value.byteLength;
      }
      if (size === 0) return missing(options);
      await session.seal();
      const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': POLICY_METADATA_CACHE_CONTROL,
        Vary: 'Authorization',
        ETag: etag,
      };
      if (isNotModified(options.request, { etag })) {
        await body.return(undefined);
        return notModifiedResponse({ etag }, 'Authorization', headers);
      }
      if (complete) return new Response(new Blob(chunks), { headers });
      let buffered = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (buffered < chunks.length) {
              controller.enqueue(chunks[buffered++]!);
              return;
            }
            try {
              const chunk = await body.next();
              if (chunk.done) controller.close();
              else controller.enqueue(chunk.value);
            } catch {
              controller.error(new RegistryPolicyUnavailableError());
            }
          },
          async cancel() {
            await body.return(undefined);
          },
        }),
        { headers },
      );
    } catch (error) {
      await iterator?.return(undefined);
      if (error instanceof CatalogueChangedError || error instanceof RegistryPolicyChangedError) {
        continue;
      }
      if (error instanceof ListingIncompleteError) return unavailable(options);
      const refused = policyErrorResponse(error, options.requestId);
      if (refused !== null) return refused;
      throw error;
    }
  }
  if (session.attempt() === firstAttempt) return unavailable(options);
  return policyErrorResponse(new RegistryPolicyUnavailableError(), options.requestId)!;
}

export async function renderComposerP2(options: ComposerP2Options): Promise<Response> {
  if (!authorized(options.actor)) return missing(options);
  if (options.policy !== undefined) return renderGovernedP2(options, options.policy.session);
  const ctx = { orgId: options.actor.orgId };
  const form = options.dev ? 'composer-p2-dev' : 'composer-p2';
  for (let attempt = 0; attempt < 2; attempt++) {
    const epoch = await options.cache?.currentVersion(ctx);
    const first = await options.access.versions(options.actor, 'composer', options.name, {
      limit: CATALOGUE_PAGE_MAX,
    });
    if (first === null) return missing(options);
    if ('changed' in first) continue;
    const iterator = document(first, options);
    const chunks: Uint8Array[] = [];
    let size = 0;
    let complete = false;
    try {
      while (size <= MAX_ENTRY_BYTES) {
        const chunk = await iterator.next();
        if (chunk.done) {
          complete = true;
          break;
        }
        chunks.push(chunk.value);
        size += chunk.value.byteLength;
      }
    } catch (error) {
      if (error instanceof CatalogueChangedError) continue;
      if (error instanceof ListingIncompleteError) return unavailable(options);
      throw error;
    }
    if (size === 0) return missing(options);
    const validators = await composerValidators(options.clock, ctx, first.pkg, form, 1, {
      projectSlug: options.projectSlug,
      origin: options.publicUrl,
    });
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': CACHE_CONTROL,
      Expires: new Date(Date.now() + 300_000).toUTCString(),
      Vary: 'Authorization',
      ...validatorHeaders(validators),
    };
    if (isNotModified(options.request, validators)) {
      await iterator.return(undefined);
      return notModifiedResponse(validators, 'Authorization', headers);
    }
    if (complete) {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (options.cache && epoch) {
        await options.cache.set(
          ctx,
          catalogueCacheKey(first.pkg, form),
          defaultEntry('metadata', bytes, new Date()),
          {
            expectedVersion: epoch,
            origin: { status: 200, authenticated: true, authorized: true },
          },
        );
      }
      return new Response(bytes, { headers });
    }
    let buffered = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (buffered < chunks.length) {
            controller.enqueue(chunks[buffered++]!);
            return;
          }
          try {
            const chunk = await iterator.next();
            if (chunk.done) controller.close();
            else controller.enqueue(chunk.value);
          } catch {
            controller.error(new CatalogueChangedError());
          }
        },
        async cancel() {
          await iterator.return(undefined);
        },
      }),
      { headers },
    );
  }
  return unavailable(options);
}

/**
 * Lists only packages with a permitted witness. When the candidate bound is reached the
 * enumeration is omitted, as for an open namespace, rather than claimed complete.
 */
async function governedPackagesJson(
  options: ComposerRenderOptions,
  session: RegistryReadSession,
): Promise<Response> {
  try {
    const body = await withPolicyRetry(async () => {
      const names: string[] = [];
      let after: string | undefined;
      let bounded = true;
      for (;;) {
        let listing;
        try {
          listing = await options.access.list(options.actor, 'composer', {
            limit: CATALOGUE_PAGE_MAX,
            ...(after === undefined ? {} : { after }),
          });
        } catch (error) {
          if (!(error instanceof RegistryPolicyBoundError)) throw error;
          bounded = false;
          break;
        }
        names.push(...listing.items.map((item) => item.key));
        if (listing.openNamespace || names.length > 1000) {
          bounded = false;
          break;
        }
        if (listing.next === null) break;
        after = listing.next;
      }
      await session.seal();
      return {
        packages: [],
        'metadata-url': `/${options.projectSlug}/p2/%package%.json`,
        ...(bounded ? { 'available-packages': names } : {}),
      };
    });
    return Response.json(body, {
      headers: { 'Cache-Control': POLICY_METADATA_CACHE_CONTROL, Vary: 'Authorization' },
    });
  } catch (error) {
    const refused = policyErrorResponse(error, options.requestId);
    if (refused !== null) return refused;
    throw error;
  }
}

export async function renderPackagesJson(options: ComposerRenderOptions): Promise<Response> {
  if (!authorized(options.actor)) return missing(options);
  if (options.policy !== undefined) return governedPackagesJson(options, options.policy.session);
  const names: string[] = [];
  let after: string | undefined;
  let bounded = true;
  for (;;) {
    const listing = await options.access.list(options.actor, 'composer', {
      limit: CATALOGUE_PAGE_MAX,
      ...(after === undefined ? {} : { after }),
    });
    names.push(...listing.items.map((item) => item.key));
    if (listing.openNamespace || names.length > 1000) {
      bounded = false;
      break;
    }
    if (listing.next === null) break;
    after = listing.next;
  }
  const body = {
    packages: [],
    'metadata-url': `/${options.projectSlug}/p2/%package%.json`,
    ...(bounded ? { 'available-packages': names } : {}),
  };
  return Response.json(body, {
    headers: { 'Cache-Control': CACHE_CONTROL, Vary: 'Authorization' },
  });
}
