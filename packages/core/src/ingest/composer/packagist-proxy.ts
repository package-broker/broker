import { UPSTREAM_DEFAULTS } from '../../sources/config.js';
import {
  UpstreamError,
  type PolicyFetch,
  type UpstreamCredential,
} from '../../sources/policy-fetch.js';
import type {
  DistStream,
  DocumentValidators,
  ProviderContext,
  ProviderSource,
  SourceProvider,
} from '../../sources/provider.js';
import type { Clock } from '../../ids.js';
import type { ComposerRoot } from './root.js';
import { describeComposerV2, type ComposerV2Result } from './v2-package.js';

const PACKAGIST = UPSTREAM_DEFAULTS.packagist.url;
const GITHUB_API = 'https://api.github.com';
const GITHUB_CODELOAD = 'https://codeload.github.com';
const GITHUB_ORIGINS: readonly string[] = [GITHUB_API, GITHUB_CODELOAD];
const REPO_SEGMENT = /^[\w.-]+$/;
const DOTS_ONLY = /^\.+$/;
const PROXY_ROOT_NO_DIGEST = '0'.repeat(64);
const ARCHIVE_TIMEOUT_MS = 120_000;
const NO_PROBE = { secrets: [], queryParams: [] } as const;

/** Fixed root: no packages.json is read, so the proxy only ever requests the p2 documents. */
const PACKAGIST_ROOT: ComposerRoot = {
  mode: 'v2',
  packagesJsonUrl: `${PACKAGIST}/packages.json`,
  metadataUrl: `${PACKAGIST}/p2/%package%.json`,
  metadataChangesUrl: 'https://packagist.org/metadata/changes.json',
  inlineProviders: false,
  partialPackages: false,
  inlinePackages: false,
  validator: { sha256: PROXY_ROOT_NO_DIGEST },
  messages: [],
  mirrors: [],
};

export interface PackagistDescribeOptions {
  readonly path: 'job' | 'request';
  readonly clock: Clock;
  readonly validators?: DocumentValidators;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

export function describePackagist(
  fetch: PolicyFetch,
  name: string,
  options: PackagistDescribeOptions,
): Promise<ComposerV2Result> {
  return describeComposerV2(fetch, { root: PACKAGIST_ROOT, allowedOrigins: [] }, name, {
    dev: true,
    path: options.path,
    probe: NO_PROBE,
    clock: options.clock,
    ...(options.validators === undefined ? {} : { validators: options.validators }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export class PackagistBusyError extends UpstreamError {
  override readonly name = 'PackagistBusyError';
  constructor(readonly retryAfterSeconds: number | null) {
    super('http_status', 429, 'busy');
  }
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function validRefSegment(segment: string): boolean {
  for (const char of segment) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '/' || char === '\\') return false;
  }
  return true;
}

export function codeloadUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.href !== url || parsed.origin !== GITHUB_API) return null;
  if (parsed.username !== '' || parsed.password !== '' || url.includes('?') || url.includes('#')) {
    return null;
  }
  const [empty, repos, ...rest] = parsed.pathname.split('/');
  if (empty !== '' || repos !== 'repos' || rest.length < 4 || rest[2] !== 'zipball') return null;
  const segments = [rest[0], rest[1], ...rest.slice(3)].map((raw) => decodeSegment(raw ?? ''));
  if (segments.some((segment) => segment === null || segment === '' || DOTS_ONLY.test(segment))) {
    return null;
  }
  const [owner, repo, ...ref] = segments as string[];
  if (!REPO_SEGMENT.test(owner ?? '') || !REPO_SEGMENT.test(repo ?? '')) return null;
  if (!ref.every(validRefSegment)) return null;
  const path = [owner ?? '', repo ?? '', 'legacy.zip', ...ref].map((segment, index) =>
    index === 2 ? segment : encodeURIComponent(segment),
  );
  return `${GITHUB_CODELOAD}/${path.join('/')}`;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new UpstreamError('refused', undefined, 'invalid_url');
  }
}

function githubCredential(
  credential: UpstreamCredential | null,
  enabled: boolean,
): UpstreamCredential | undefined {
  if (!enabled || credential === null) return undefined;
  const origins = credential.origins.map(originOf);
  if (origins.length === 0 || !origins.every((origin) => GITHUB_ORIGINS.includes(origin))) {
    throw new UpstreamError('refused', undefined, 'credential_origin');
  }
  return credential;
}

function assertPackagist(source: ProviderSource): asserts source is ProviderSource & {
  readonly type: 'packagist_proxy';
} {
  if (source.type !== 'packagist_proxy') throw new TypeError('not a packagist_proxy source');
}

export const packagistProxyProvider: SourceProvider = {
  id: 'packagist',
  sourceTypes: ['packagist_proxy'],
  ecosystems: ['composer'],
  async describe(ctx, source, name, options) {
    assertPackagist(source);
    const result = await describePackagist(ctx.fetch, name, {
      path: 'request',
      clock: ctx.clock,
      signal: ctx.signal,
      ...(options.validators === undefined ? {} : { validators: options.validators }),
    });
    if (result.kind === 'busy') throw new PackagistBusyError(result.retryAfterSeconds);
    return result;
  },
  async openDist(ctx: ProviderContext, source, target): Promise<DistStream> {
    assertPackagist(source);
    if (target.url === null) throw new UpstreamError('refused', undefined, 'dist_url');
    const url = codeloadUrl(target.url) ?? target.url;
    const github = GITHUB_ORIGINS.includes(originOf(url));
    const credential = github
      ? githubCredential(ctx.credential, source.config.githubToken)
      : undefined;
    const response = await ctx.fetch({
      url,
      method: 'GET',
      ...(credential === undefined ? {} : { credential }),
      ...(github ? { destinations: GITHUB_ORIGINS } : {}),
      purpose: 'archive',
      maxBytes: UPSTREAM_DEFAULTS.archiveMaxBytes,
      timeoutMs: ARCHIVE_TIMEOUT_MS,
      signal: ctx.signal,
    });
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      throw new UpstreamError('http_status', response.status);
    }
    const length = response.headers.get('content-length');
    return {
      body: response.body,
      size: length !== null && /^\d+$/.test(length) ? Number(length) : null,
    };
  },
};
