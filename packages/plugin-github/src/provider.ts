import {
  createPackageDescription,
  GITHUB_API_VERSION,
  lsRefs,
  packageKey,
  readFileAtRefs,
  snapshotRef,
  UpstreamError,
  versionsFromRefs,
  npmVersionsFromRefs,
  npmVcsDescription,
  type PolicyFetch,
  type ProviderContext,
  type ProviderSource,
  type SourceProvider,
  type UpstreamCredential,
  type UpstreamResponse,
  type VersionCandidate,
} from '@package-broker/core/plugin';
import {
  InstallationTokenError,
  parseRateLimit,
  type InstallationTokens,
} from './installation-token.js';

import { meteredFetch, tokenRest, type ManifestFile, type TokenRestBudget } from './token-rest.js';

const MAX_RATE_LIMIT_WAIT_SECONDS = 3600;
const MIB = 1024 * 1024;

/** Ceilings for one token-mode describe; exceeding one fails it with the stable too_large code. */
export const TOKEN_DESCRIBE_BUDGET: Readonly<Record<'docker' | 'cloudflare', TokenRestBudget>> =
  Object.freeze({
    cloudflare: Object.freeze({ textBytes: 64 * MIB, requests: 1000 }),
    docker: Object.freeze({ textBytes: 256 * MIB, requests: 5000 }),
  });

import { RateLimited } from './rate-limited.js';
export { RateLimited } from './rate-limited.js';

export class GithubProviderError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'invalid_response' | 'skipped' | 'snapshot_changed',
    readonly status?: number,
  ) {
    super(`GitHub provider ${code}`);
    this.name = 'GithubProviderError';
  }
}

export interface GithubProviderOptions {
  /** Resolves an installation token service for App sources; token sources do not call this. */
  readonly tokensFor: (
    source: ProviderSource,
  ) => InstallationTokens | null | Promise<InstallationTokens | null>;
  readonly runtime: 'docker' | 'cloudflare';
  /** Test-only override of TOKEN_DESCRIBE_BUDGET; production wiring never sets it. */
  readonly budget?: TokenRestBudget;
}

const API = 'https://api.github.com';
const GIT = 'https://github.com';
const CODELOAD = 'https://codeload.github.com';
const SHA = /^[a-f0-9]{40}$/;

function repository(source: ProviderSource) {
  if (
    source.type !== 'vcs' ||
    source.config.provider !== 'github' ||
    !['composer', 'npm'].includes(source.ecosystem)
  ) {
    throw new GithubProviderError('invalid_request');
  }
  const { config } = source;
  if (
    !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(config.repository) ||
    ['.', '..'].includes(config.repository.split('/')[1]!) ||
    (config.installationId !== undefined &&
      (!Number.isSafeInteger(config.installationId) || config.installationId <= 0))
  ) {
    throw new GithubProviderError('invalid_request');
  }
  return {
    config,
    installationId: String(config.installationId),
    repo: config.repository,
    name: config.repository.split('/')[1]!,
    gitUrl: `${GIT}/${config.repository}.git`,
  };
}

function credential(origin: string, authorization: string): UpstreamCredential {
  return {
    origins: [origin],
    queryParams: [],
    apply(headers, url) {
      if (url.origin === origin) headers.set('authorization', authorization);
      return { headers, url };
    },
  };
}

function cancel(response: UpstreamResponse): void {
  void response.body?.cancel().catch(() => undefined);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createGithubProvider(options: GithubProviderOptions): SourceProvider {
  async function session(ctx: ProviderContext, source: ProviderSource) {
    const repo = repository(source);
    const tokenMode = repo.config.installationId === undefined;
    const tokens = tokenMode ? null : await options.tokensFor(source);
    if (tokenMode && ctx.credential === null) throw new UpstreamError('http_status', 401);
    if (!tokenMode && tokens === null) throw new GithubProviderError('invalid_request');
    const now = () => Math.floor(ctx.clock.now().getTime() / 1000);
    const resetAt = (epochSeconds: number) =>
      Math.min(Math.max(epochSeconds, now() + 1), now() + MAX_RATE_LIMIT_WAIT_SECONDS);
    let value = '';
    try {
      if (tokens !== null)
        value = (await tokens.forRepositories(repo.installationId, [repo.name])).value;
    } catch (error) {
      if (error instanceof InstallationTokenError) {
        if (error.code === 'not_found' || error.code === 'unprocessable') {
          throw new GithubProviderError('skipped', error.status);
        }
        if (error.code === 'rate_limited') {
          throw new RateLimited(
            resetAt(
              error.retryAfter === undefined
                ? (error.rateLimit?.reset ?? now() + 60)
                : now() + error.retryAfter,
            ),
          );
        }
      }
      throw error;
    }
    const fetch: PolicyFetch = async (request) => {
      const response = await ctx.fetch({
        ...request,
        ...(request.purpose === 'git' && request.destinations === undefined
          ? { destinations: [GIT] }
          : {}),
        signal:
          request.signal === undefined ? ctx.signal : AbortSignal.any([ctx.signal, request.signal]),
      });
      tokens?.observe(repo.installationId, response.headers);
      const limit = parseRateLimit(response.headers);
      const retryAfter = response.headers.get('retry-after')?.trim();
      if (
        (limit !== undefined && limit.remaining < limit.limit * 0.05) ||
        response.status === 429 ||
        (response.status === 403 && retryAfter !== undefined)
      ) {
        cancel(response);
        const retryReset =
          retryAfter === undefined
            ? Number.NaN
            : /^\d+$/.test(retryAfter)
              ? now() + Number(retryAfter)
              : Math.ceil(Date.parse(retryAfter) / 1000);
        throw new RateLimited(
          resetAt(Number.isSafeInteger(retryReset) ? retryReset : (limit?.reset ?? now() + 60)),
        );
      }
      if (
        request.purpose === 'api' &&
        request.url === `${API}/repos/${repo.repo}` &&
        (response.status === 404 || response.status === 451)
      ) {
        cancel(response);
        throw new GithubProviderError('skipped', response.status);
      }
      if (response.status < 200 || response.status >= 300) {
        cancel(response);
        throw new UpstreamError('http_status', response.status);
      }
      return response;
    };
    return {
      ...repo,
      fetch,
      gitCredential: credential(GIT, `Basic ${btoa(`x-access-token:${value}`)}`),
      apiCredential: tokenMode ? ctx.credential! : credential(API, `Bearer ${value}`),
      tokenMode,
      resetAt: (epochSeconds: number | undefined) => resetAt(epochSeconds ?? now() + 60),
    };
  }
  return {
    id: 'github',
    sourceTypes: ['vcs'],
    ecosystems: ['composer', 'npm'],
    async listPackages(ctx: ProviderContext, source: ProviderSource, cursor: string | null) {
      if (cursor !== null) throw new GithubProviderError('invalid_request');
      const s = await session(ctx, source);
      if (!s.tokenMode) throw new GithubProviderError('invalid_request');
      let configuredName = s.config.packageName;
      if (configuredName !== undefined) {
        const response = await s.fetch({
          url: `${API}/repos/${s.repo}`,
          method: 'GET',
          purpose: 'api',
          credential: s.apiCredential,
          destinations: [API],
          maxBytes: 1024 * 1024,
          timeoutMs: 30_000,
        });
        cancel(response);
      }
      if (configuredName === undefined) {
        const manifest = await tokenRest(s.fetch, s.apiCredential, s.repo, s.resetAt).manifest(
          source.ecosystem === 'npm' ? 'package.json' : 'composer.json',
        );
        if (!record(manifest) || typeof manifest.name !== 'string')
          throw new GithubProviderError('invalid_response');
        configuredName = manifest.name;
      }
      let name: string;
      try {
        name = packageKey(configuredName, { ecosystem: source.ecosystem });
      } catch {
        throw new GithubProviderError('invalid_response');
      }
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify([s.repo, name])),
      );
      return {
        names: [name],
        next: null,
        last: true,
        snapshot: snapshotRef(
          `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
        ),
      };
    },
    async describe(ctx, source, name, describeOptions) {
      const s = await session(ctx, source);
      const budget = options.budget ?? TOKEN_DESCRIBE_BUDGET[options.runtime];
      const metered = s.tokenMode ? meteredFetch(s.fetch, budget.requests) : null;
      const response = await (metered?.fetch ?? s.fetch)({
        url: `${API}/repos/${s.repo}`,
        method: 'GET',
        purpose: 'api',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': GITHUB_API_VERSION,
        },
        credential: s.apiCredential,
        destinations: [API],
        maxBytes: 1024 * 1024,
        timeoutMs: 30_000,
      });
      let metadata: unknown;
      try {
        metadata = await new Response(response.body).json();
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        throw new GithubProviderError('invalid_response');
      }
      if (
        !record(metadata) ||
        typeof metadata.archived !== 'boolean' ||
        typeof metadata.default_branch !== 'string'
      ) {
        throw new GithubProviderError('invalid_response');
      }
      if (
        typeof metadata.full_name !== 'string' ||
        metadata.full_name.toLowerCase() !== s.repo.toLowerCase()
      ) {
        throw new GithubProviderError('skipped');
      }
      const rest = s.tokenMode
        ? tokenRest(
            metered!.fetch,
            s.apiCredential,
            s.repo,
            s.resetAt,
            {
              textBytes: budget.textBytes,
              remaining: metered!.remaining,
            },
            source.ecosystem === 'npm' ? 'package.json' : 'composer.json',
          )
        : null;
      const listing = s.tokenMode
        ? {
            refs: [
              ...(s.config.refs.tags ? await rest!.refs('tags') : []),
              ...(
                await branches(
                  rest!,
                  s.config.refs.branches.filter((name) => name !== '*'),
                )
              ).filter((ref) => ref !== null),
            ],
          }
        : await lsRefs(s.fetch, s.gitUrl, s.gitCredential);
      const refs = listing.refs.filter(
        (ref) =>
          (s.config.refs.tags && ref.name.startsWith('refs/tags/')) ||
          (ref.name.startsWith('refs/heads/') &&
            s.config.refs.branches.includes(ref.name.slice(11))),
      );
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({
            archived: metadata.archived,
            default_branch: metadata.default_branch,
            refs,
          }),
        ),
      );
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const snapshot = snapshotRef(`sha256:${hex}`);
      if (describeOptions.snapshot !== undefined && describeOptions.snapshot.id !== snapshot.id) {
        throw new GithubProviderError('snapshot_changed');
      }
      const versions =
        source.ecosystem === 'npm'
          ? npmVersionsFromRefs(
              refs
                .filter((ref) => ref.name.startsWith('refs/tags/'))
                .map((ref) => ref.name.slice(10)),
            )
          : versionsFromRefs(
              refs
                .filter((ref) => ref.name.startsWith('refs/tags/'))
                .map((ref) => ref.name.slice(10)),
              refs
                .filter((ref) => ref.name.startsWith('refs/heads/'))
                .map((ref) => ref.name.slice(11)),
              metadata.default_branch,
            );
      const winningNames = new Set(
        versions.versions.map(
          (version) => `refs/${version.kind === 'tag' ? 'tags' : 'heads'}/${version.ref}`,
        ),
      );
      const winningRefs = refs.filter((ref) => winningNames.has(ref.name));
      const refName = (version: (typeof versions.versions)[number]) =>
        `refs/${version.kind === 'tag' ? 'tags' : 'heads'}/${version.ref}`;
      let complete: boolean;
      type FileAtRef = Awaited<ReturnType<typeof readFileAtRefs>>[number];
      let files: AsyncIterable<ManifestFile | FileAtRef>;
      if (s.tokenMode) {
        const byName = new Map<string, (typeof winningRefs)[number]>();
        for (const ref of winningRefs) if (!byName.has(ref.name)) byName.set(ref.name, ref);
        const ordered = versions.versions.flatMap((version) => {
          const ref = byName.get(refName(version));
          return ref === undefined ? [] : [ref];
        });
        complete = ordered.length === versions.versions.length;
        files = (await rest!.stage(ordered)).files();
      } else {
        const read = await readFileAtRefs(
          {
            policyFetch: s.fetch,
            codecs: ctx.codecs,
            runtime: options.runtime,
            credential: s.gitCredential,
          },
          s.gitUrl,
          winningRefs,
          source.ecosystem === 'npm' ? 'package.json' : 'composer.json',
        );
        complete =
          read.length === winningRefs.length &&
          read.every((file) => file.reason === undefined && file.text !== null);
        const byName = new Map<string, FileAtRef>();
        for (const file of read) if (!byName.has(file.ref)) byName.set(file.ref, file);
        files = (async function* () {
          for (const version of versions.versions) {
            const file = byName.get(refName(version));
            if (file !== undefined) yield file;
          }
        })();
      }
      if (source.ecosystem === 'npm') {
        return {
          kind: 'found',
          description: await npmVcsDescription(
            name,
            s.config.packageName,
            refs
              .filter((ref) => ref.name.startsWith('refs/tags/'))
              .map((ref) => ref.name.slice(10)),
            files,
            snapshot,
          ),
        };
      }
      const metadataArchived = metadata.archived;
      async function* members(): AsyncGenerator<VersionCandidate> {
        let ordinal = 0;
        const pending = files[Symbol.asyncIterator]();
        let next: IteratorResult<ManifestFile | FileAtRef> | undefined;
        for (const version of versions.versions) {
          next ??= await pending.next();
          if (next.done === true || next.value.ref !== refName(version)) {
            complete = false;
            continue;
          }
          const file = next.value;
          next = undefined;
          if (file.reason !== undefined || file.text === null) {
            complete = false;
            continue;
          }
          let manifest: unknown;
          try {
            manifest = JSON.parse(file.text);
          } catch {
            complete = false;
            continue;
          }
          if (!record(manifest) || typeof manifest.name !== 'string' || !SHA.test(file.commit)) {
            complete = false;
            continue;
          }
          try {
            const key = packageKey(manifest.name, { ecosystem: 'composer' });
            if (
              key !== packageKey(name, { ecosystem: 'composer' }) ||
              (s.config.packageName !== undefined &&
                key !== packageKey(s.config.packageName, { ecosystem: 'composer' }))
            ) {
              complete = false;
              continue;
            }
          } catch {
            complete = false;
            continue;
          }
          const raw: Record<string, unknown> = {
            ...manifest,
            version: version.version,
            version_normalized: version.versionNormalized,
            ...(metadataArchived ? { abandoned: true } : {}),
            ...(file.committedAt === null ? {} : { time: file.committedAt }),
            source: { type: 'git', url: s.gitUrl, reference: file.commit },
            dist: {
              type: 'zip',
              url: `${API}/repos/${s.repo}/zipball/${file.commit}`,
              reference: file.commit,
              shasum: '',
            },
          };
          delete raw['notification-url'];
          delete raw.support;
          if (!metadataArchived) delete raw.abandoned;
          if (file.committedAt === null) delete raw.time;
          yield {
            ordinal: ordinal++,
            ...(file.committedAt === null ? {} : { upstreamTime: file.committedAt }),
            version: version.version,
            form: version.kind === 'tag' ? 'composer-p2' : 'composer-p2-dev',
            raw: JSON.stringify(raw),
          };
        }
      }
      return {
        kind: 'found',
        description: createPackageDescription({
          name,
          snapshot,
          validators: {},
          documentsComplete: () => complete,
          members: members(),
        }),
      };
    },
    async openDist(ctx, source, target) {
      const repo = repository(source);
      if (
        target.distType !== (source.ecosystem === 'npm' ? 'tgz' : 'zip') ||
        target.sourceRef === null ||
        !SHA.test(target.sourceRef)
      ) {
        throw new GithubProviderError('invalid_request');
      }
      const url = `${API}/repos/${repo.repo}/${source.ecosystem === 'npm' ? 'tarball' : 'zipball'}/${target.sourceRef}`;
      if (target.url !== null && target.url !== url)
        throw new GithubProviderError('invalid_request');
      const s = await session(ctx, source);
      const response = await s.fetch({
        url,
        method: 'GET',
        purpose: 'archive',
        credential: s.apiCredential,
        destinations: [API, CODELOAD],
        maxBytes: 64 * 1024 * 1024,
        timeoutMs: 120_000,
      });
      if (response.body === null) throw new GithubProviderError('invalid_response');
      const length = response.headers.get('content-length');
      const size = length !== null && /^\d+$/.test(length) ? Number(length) : Number.NaN;
      return { body: response.body, size: Number.isSafeInteger(size) ? size : null };
    },
  };
}

async function branches(rest: ReturnType<typeof tokenRest>, names: readonly string[]) {
  const results: Awaited<ReturnType<typeof rest.branch>>[] = new Array(names.length);
  let next = 0;
  let stopped = false;
  await Promise.all(
    Array.from({ length: Math.min(4, names.length) }, async () => {
      while (!stopped && next < names.length) {
        const index = next++;
        try {
          results[index] = await rest.branch(names[index]!);
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    }),
  );
  return results;
}
