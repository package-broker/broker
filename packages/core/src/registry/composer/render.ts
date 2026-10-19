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
  validatorHeaders,
  type RepresentationClock,
} from '../conditional.js';
import { composerDistPath } from './dist-url.js';
import { minifyVersions } from './minify.js';

export interface ComposerRenderOptions {
  /** The request id supplied by the caller. */
  readonly requestId: string;
  readonly actor: ProjectActor;
  readonly access: PackageAccess;
  readonly projectSlug: string;
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

export async function renderComposerP2(options: ComposerP2Options): Promise<Response> {
  if (!authorized(options.actor)) return missing(options);
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

export async function renderPackagesJson(options: ComposerRenderOptions): Promise<Response> {
  if (!authorized(options.actor)) return missing(options);
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
