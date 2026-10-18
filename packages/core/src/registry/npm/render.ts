import type { ProjectActor } from '../../authz/project-actor.js';
import { displayName } from '../../catalogue/names.js';
import type { PackageAccess } from '../../catalogue/package-access.js';
import { validateVersion } from '../../catalogue/versions.js';
import { CATALOGUE_PAGE_MAX, type CatalogueVersion, type PageBinding } from '../../db/catalogue.js';

export const ABBREVIATED_VERSION_FIELDS = [
  'name',
  'version',
  'deprecated',
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bin',
  'directories',
  'engines',
  'os',
  'cpu',
  'libc',
  '_hasShrinkwrap',
  'hasInstallScript',
  'dist',
] as const;

export interface NpmRenderOptions {
  readonly access: PackageAccess;
  readonly actor: ProjectActor;
  readonly projectSlug: string;
  readonly name: string;
  readonly publicUrl: string;
  readonly abbreviated?: boolean;
}

const BUFFER_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();
type Json = Record<string, unknown>;

class Changed extends Error {
  constructor() {
    super('catalogue changed');
    this.name = 'CatalogueChangedError';
  }
}
class Unavailable extends Error {
  constructor(readonly status: 404 | 503) {
    super('package unavailable');
    this.name = 'PackageUnavailableError';
  }
}

function headers(abbreviated: boolean): Headers {
  return new Headers({
    'Content-Type': abbreviated ? 'application/vnd.npm.install-v1+json' : 'application/json',
    Vary: 'Accept, Authorization',
  });
}

function unavailable(status: 404 | 503): Response {
  return new Response(null, {
    status,
    headers: status === 503 ? { 'Retry-After': '10' } : { 'Cache-Control': 'private, max-age=300' },
  });
}

function manifest(options: NpmRenderOptions, version: CatalogueVersion, name: string): Json {
  const stored = JSON.parse(version.metadataJson) as Json;
  const dist = stored.dist as Json | undefined;
  const unscoped = name.slice(name.lastIndexOf('/') + 1);
  const base = options.publicUrl.replace(/\/+$/, '');
  const path = name.split('/').map(encodeURIComponent).join('/').replace(/^%40/, '@');
  const result: Json = {
    ...stored,
    name,
    version: version.version,
    dist: {
      tarball: `${base}/${encodeURIComponent(options.projectSlug)}/npm/${path}/-/${encodeURIComponent(unscoped)}-${encodeURIComponent(version.version)}.tgz`,
      ...(version.npmIntegrity === null ? {} : { integrity: version.npmIntegrity }),
      ...(typeof dist?.shasum === 'string' ? { shasum: dist.shasum } : {}),
    },
  };
  delete result.readme;
  delete result.readmeFilename;
  delete result.deprecated;
  if (version.deprecatedMessage !== null) result.deprecated = version.deprecatedMessage;
  if (!options.abbreviated) return result;
  if (result.bundleDependencies === undefined && result.bundledDependencies !== undefined) {
    result.bundleDependencies = result.bundledDependencies;
  }
  return Object.fromEntries(
    ABBREVIATED_VERSION_FIELDS.filter((key) => Object.hasOwn(result, key)).map((key) => [
      key,
      result[key],
    ]),
  );
}

function sameBinding(left: PageBinding, right: PageBinding): boolean {
  return (
    left.packageId === right.packageId && left.sourceId === right.sourceId && left.rev === right.rev
  );
}

async function* chunks(options: NpmRenderOptions): AsyncGenerator<Uint8Array> {
  const { access, actor, name } = options;
  let page = await access.versions(actor, 'npm', name, { limit: CATALOGUE_PAGE_MAX });
  if (page === null) throw new Unavailable(404);
  if ('changed' in page) throw new Changed();
  if (page.versions.length === 0) throw new Unavailable(404);
  if (!page.pkg.listingComplete) throw new Unavailable(503);
  const { pkg, binding } = page;
  const tags = await access.distTags(actor, 'npm', name);
  if (tags === null || !sameBinding(binding, tags.pkg)) throw new Changed();
  const display = displayName(pkg.key);
  const head = options.abbreviated
    ? { name: display, modified: pkg.modifiedAt, 'dist-tags': tags.tags }
    : { _id: display, name: display, 'dist-tags': tags.tags };
  yield encoder.encode(`${JSON.stringify(head).slice(0, -1)},"versions":{`);
  const times: string[] = [];
  let first = true;
  for (;;) {
    for (const version of page.versions) {
      yield encoder.encode(
        `${first ? '' : ','}${JSON.stringify(version.version)}:${JSON.stringify(manifest(options, version, display))}`,
      );
      first = false;
      if (!options.abbreviated)
        times.push(`${JSON.stringify(version.version)}:${JSON.stringify(version.publishedAt)}`);
    }
    if (page.next === null) break;
    const next = await access.versions(actor, 'npm', name, {
      limit: CATALOGUE_PAGE_MAX,
      binding,
      after: page.next,
    });
    if (next === null || 'changed' in next || !sameBinding(binding, next.binding))
      throw new Changed();
    page = next;
  }
  yield encoder.encode('}');
  if (!options.abbreviated) {
    yield encoder.encode(
      `,"time":{"created":${JSON.stringify(pkg.createdAt)},"modified":${JSON.stringify(pkg.modifiedAt)}`,
    );
    for (const time of times) yield encoder.encode(`,${time}`);
    yield encoder.encode('}');
  }
  yield encoder.encode('}');
}

export async function renderPackument(options: NpmRenderOptions): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const iterator = chunks(options);
    const buffered: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await iterator.next();
        if (chunk.done)
          return new Response(new Blob(buffered), { headers: headers(!!options.abbreviated) });
        buffered.push(chunk.value);
        size += chunk.value.byteLength;
        if (size > BUFFER_LIMIT) break;
      }
    } catch (error) {
      if (error instanceof Changed) continue;
      if (error instanceof Unavailable) return unavailable(error.status);
      throw error;
    }
    let index = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (index < buffered.length) {
            controller.enqueue(buffered[index++]!);
            if (index === buffered.length) buffered.length = 0;
            return;
          }
          try {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          await iterator.return(undefined);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { headers: headers(!!options.abbreviated) });
  }
  return unavailable(503);
}

export async function renderVersionDocument(
  options: NpmRenderOptions,
  versionOrTag: string,
): Promise<Response> {
  let exact = true;
  try {
    validateVersion({ ecosystem: 'npm', version: versionOrTag, versionNormalized: versionOrTag });
  } catch {
    exact = false;
  }
  const { access, actor, name } = options;
  const result = exact
    ? await access.version(actor, 'npm', name, versionOrTag)
    : await access.tag(actor, 'npm', name, versionOrTag);
  if (result === null) return unavailable(404);
  if (!result.pkg.listingComplete) return unavailable(503);
  return new Response(
    JSON.stringify(manifest(options, result.version, displayName(result.pkg.key))),
    { headers: headers(!!options.abbreviated) },
  );
}
