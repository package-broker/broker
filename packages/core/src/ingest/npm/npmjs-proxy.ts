import { PackageNameError, packageKey } from '../../catalogue/names.js';
import type { OrgContext } from '../../db/port.js';
import type { BlobStore } from '../../platform/blob.js';
import { UPSTREAM_DEFAULTS } from '../../sources/config.js';
import { UpstreamError, type UpstreamCredential } from '../../sources/policy-fetch.js';
import type {
  DescribeOptions,
  DescribeResult,
  DistStream,
  ProviderContext,
  ProviderDistTarget,
  ProviderSource,
  SourceProvider,
} from '../../sources/provider.js';
import { NpmPackumentError, describeNpmPackument } from './packument.js';

export const NPMJS_REGISTRY = UPSTREAM_DEFAULTS.npmjs.url;
export const NPMJS_TARBALL_ORIGINS: readonly string[] = [
  NPMJS_REGISTRY,
  'https://registry.yarnpkg.com',
];
const ARCHIVE_TIMEOUT_MS = 120_000;

/** Large packuments are staged; the provider context carries neither the store nor the org. */
export interface NpmStaging {
  readonly store: BlobStore;
  orgOf(source: ProviderSource): OrgContext;
}

const refused = (reason: string): UpstreamError => new UpstreamError('refused', undefined, reason);

/** Throws PackageNameError for a name npm would not accept, including '.' and '..' segments. */
export function assertNpmName(name: string): void {
  packageKey(name, { ecosystem: 'npm', legacyCase: true });
  const bare = name.startsWith('@') ? name.slice(1) : name;
  if (bare.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new PackageNameError('invalid npm package name');
  }
}

export function validNpmName(name: string): boolean {
  try {
    assertNpmName(name);
    return true;
  } catch (error) {
    if (error instanceof PackageNameError) return false;
    throw error;
  }
}

export function npmPackumentUrl(registry: string, name: string): string {
  assertNpmName(name);
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  const path = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1, name.indexOf('/')))}%2f${encodeURIComponent(name.slice(name.indexOf('/') + 1))}`
    : encodeURIComponent(name);
  return new URL(path, base).href;
}

export async function describeNpm(
  staging: NpmStaging,
  ctx: ProviderContext,
  source: ProviderSource,
  target: {
    readonly url: string;
    readonly name: string;
    readonly destinations: readonly string[];
    readonly credential?: UpstreamCredential;
  },
  options: DescribeOptions,
): Promise<DescribeResult> {
  const result = await describeNpmPackument(
    {
      ctx: staging.orgOf(source),
      fetch: ctx.fetch,
      store: staging.store,
      codecs: ctx.codecs,
      signal: ctx.signal,
    },
    {
      name: target.name,
      url: target.url,
      destinations: target.destinations,
      maxBytes: UPSTREAM_DEFAULTS.metadataMaxBytes,
      ...(target.credential === undefined ? {} : { credential: target.credential }),
    },
    options,
  );
  if (result.kind === 'restart') throw new NpmPackumentError('snapshot_gone');
  return result;
}

export async function openNpmTarball(
  ctx: ProviderContext,
  target: ProviderDistTarget,
  tarballOrigins: readonly string[],
  destinations: readonly string[],
  credential?: UpstreamCredential,
): Promise<DistStream> {
  if (target.url === null) throw refused('tarball_url');
  let origin: string;
  try {
    origin = new URL(target.url).origin;
  } catch {
    throw refused('tarball_url');
  }
  if (!tarballOrigins.includes(origin)) throw refused('foreign_tarball_host');
  const response = await ctx.fetch({
    url: target.url,
    method: 'GET',
    headers: { accept: 'application/octet-stream' },
    destinations,
    ...(credential === undefined ? {} : { credential }),
    purpose: 'archive',
    maxBytes: UPSTREAM_DEFAULTS.archiveMaxBytes,
    timeoutMs: ARCHIVE_TIMEOUT_MS,
    signal: ctx.signal,
  });
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError('http_status', response.status);
  }
  const length = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  const identity = encoding === undefined || encoding === '' || encoding === 'identity';
  return {
    body: response.body,
    size: identity && length !== null && /^\d+$/.test(length) ? Number(length) : null,
  };
}

function assertNpmjs(ctx: ProviderContext, source: ProviderSource): void {
  if (source.type !== 'npmjs_proxy') throw refused('source_type');
  if (ctx.credential !== null) throw refused('credential');
}

export function createNpmjsProxyProvider(staging: NpmStaging, id = 'npmjs'): SourceProvider {
  return {
    id,
    sourceTypes: ['npmjs_proxy'],
    ecosystems: ['npm'],
    async describe(ctx, source, name, options) {
      assertNpmjs(ctx, source);
      if (!validNpmName(name)) return { kind: 'not_found', definitive: true };
      return describeNpm(
        staging,
        ctx,
        source,
        { name, url: npmPackumentUrl(NPMJS_REGISTRY, name), destinations: [NPMJS_REGISTRY] },
        options,
      );
    },
    async openDist(ctx, source, target) {
      assertNpmjs(ctx, source);
      return openNpmTarball(ctx, target, NPMJS_TARBALL_ORIGINS, NPMJS_TARBALL_ORIGINS);
    },
  };
}
