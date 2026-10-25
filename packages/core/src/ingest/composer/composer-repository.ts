import { repositoryListing } from '../../internal/composer-repository-listing.js';
import { UPSTREAM_DEFAULTS } from '../../sources/config.js';
import { UpstreamError, type PolicyFetch } from '../../sources/policy-fetch.js';
import {
  snapshotRef,
  type ProviderContext,
  type ProviderSource,
  type SourceProvider,
} from '../../sources/provider.js';
import type { OutboundPolicy } from '../../sources/url-policy.js';
import { PackagistBusyError } from './packagist-proxy.js';
import {
  ComposerRootError,
  readComposerRoot,
  type ComposerRoot,
  type ComposerRootSource,
} from './root.js';
import { isSelected, readV1Index, type V1IndexResult } from './v1-index.js';
import { describeComposerV1 } from './v1-package.js';
import { ComposerV2Error, describeComposerV2 } from './v2-package.js';

const NO_PROBE = { secrets: [], queryParams: [] } as const;
const ARCHIVE_TIMEOUT_MS = 120_000;

type RepositorySource = Extract<ProviderSource, { type: 'composer_repository' }>;

function repository(source: ProviderSource): RepositorySource & { url: string } {
  if (source.type !== 'composer_repository' || source.url === null) {
    throw new UpstreamError('refused', undefined, 'source_type');
  }
  return source as RepositorySource & { url: string };
}

function origins(source: RepositorySource & { url: string }): string[] {
  return [new URL(source.url).origin, ...source.config.distHosts.map((host) => `https://${host}`)];
}

/** Keep parser failures in the same fixed-code error vocabulary as policy fetch and sync jobs. */
async function upstream<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ComposerRootError || error instanceof ComposerV2Error) {
      const code = error.code === 'origin' ? 'refused' : error.code;
      if (code === 'invalid' || code === 'unsupported') throw new UpstreamError('network');
      throw new UpstreamError(code, error.status);
    }
    throw error;
  }
}

export function createComposerRepositoryProvider(policy: OutboundPolicy): SourceProvider {
  type VerifiedIndex = Extract<V1IndexResult, { status: 'updated' }>;
  const indexes = new Map<string, { result: VerifiedIndex; bytes: number }>();
  const cacheBudget = 16 * 1024 * 1024;
  let cachedBytes = 0;
  function binding(ctx: ProviderContext, source: RepositorySource & { url: string }) {
    const destinations = origins(source);
    if (
      ctx.credential !== null &&
      !ctx.credential.origins.every((origin) => destinations.includes(origin))
    ) {
      throw new UpstreamError('refused', undefined, 'credential');
    }
    const rootSource: ComposerRootSource = {
      url: source.url,
      policy,
      allowedOrigins: destinations.slice(1),
      ...(ctx.credential === null ? {} : { credential: ctx.credential }),
    };
    const fetch: PolicyFetch = (request) =>
      ctx.fetch({
        ...request,
        signal:
          request.signal === undefined ? ctx.signal : AbortSignal.any([ctx.signal, request.signal]),
      });
    const root = () =>
      readComposerRoot(fetch, rootSource, {
        codecs: ctx.codecs,
        maxDocumentBytes: UPSTREAM_DEFAULTS.metadataMaxBytes,
      });
    const index = async (currentRoot: ComposerRoot): Promise<V1IndexResult> => {
      const keyOf = (hash: string) =>
        JSON.stringify([ctx.org.orgId, source.id, source.url, source.config, hash]);
      // Every lookup follows an authenticated root read; hashes pin all cached includes.
      const key = keyOf(currentRoot.validator.sha256);
      const cached = indexes.get(key);
      if (cached !== undefined) {
        indexes.delete(key);
        indexes.set(key, cached);
        return cached.result;
      }
      const result = await readV1Index(fetch, {
        source: rootSource,
        codecs: ctx.codecs,
        signal: ctx.signal,
        selection: source.config.selection,
      });
      if (result.status === 'updated' && result.index.complete) {
        let bytes = 0;
        for (const name of result.index.entries.keys()) bytes += 256 + name.length * 2;
        for (const document of result.index.documents.values()) {
          for (const [name, raw] of document.members) bytes += 128 + (name.length + raw.length) * 2;
        }
        if (bytes <= cacheBudget) {
          const verifiedKey = keyOf(result.root.validator.sha256);
          const previous = indexes.get(verifiedKey);
          if (previous !== undefined) {
            cachedBytes -= previous.bytes;
            indexes.delete(verifiedKey);
          }
          while (indexes.size >= 4 || cachedBytes + bytes > cacheBudget) {
            const oldest = indexes.entries().next().value;
            if (oldest === undefined) break;
            cachedBytes -= oldest[1].bytes;
            indexes.delete(oldest[0]);
          }
          indexes.set(verifiedKey, { result, bytes });
          cachedBytes += bytes;
        }
      }
      return result;
    };
    return { destinations, rootSource, fetch, root, index };
  }

  return {
    id: 'composer-repository',
    sourceTypes: ['composer_repository'],
    ecosystems: ['composer'],
    async listPackages(ctx, input, cursor) {
      if (cursor !== null) throw new UpstreamError('refused', undefined, 'cursor');
      const source = repository(input);
      const bound = binding(ctx, source);
      return upstream(async () => {
        let root = await bound.root();
        let names: string[];
        if (root.mode === 'v2') {
          names = [...(root.availablePackages ?? [])];
        } else {
          const indexed = await bound.index(root);
          if (indexed.status !== 'updated' || !indexed.index.complete)
            throw new UpstreamError('network');
          root = indexed.root;
          names = [...indexed.index.entries.keys()];
        }
        return repositoryListing(
          {
            names: names.filter((name) => isSelected(name, source.config.selection)).sort(),
            next: null,
            last: true,
            snapshot: snapshotRef(`sha256:${root.validator.sha256}`),
          },
          {
            candidates: source.config.selection.packages,
            enumerable:
              root.mode === 'v2'
                ? root.availablePackages !== undefined &&
                  (root.availablePatterns?.length ?? 0) === 0
                : root.providersLazyUrl === undefined,
          },
        );
      });
    },
    async describe(ctx, input, name, options) {
      const source = repository(input);
      if (!isSelected(name, source.config.selection))
        return { kind: 'not_found', definitive: false };
      const bound = binding(ctx, source);
      return upstream(async () => {
        const root = await bound.root();
        if (root.mode === 'v2') {
          const result = await describeComposerV2(
            bound.fetch,
            {
              root,
              allowedOrigins: bound.destinations,
              sourceType: 'composer_repository',
              ...(ctx.credential === null ? {} : { credential: ctx.credential }),
            },
            name,
            {
              dev: true,
              path: 'request',
              probe: NO_PROBE,
              clock: ctx.clock,
              signal: ctx.signal,
              ...(options.validators === undefined ? {} : { validators: options.validators }),
            },
          );
          if (result.kind === 'busy') throw new PackagistBusyError(result.retryAfterSeconds);
          return result;
        }
        const indexed = await bound.index(root);
        if (indexed.status !== 'updated' || !indexed.index.complete)
          throw new UpstreamError('network');
        return describeComposerV1(bound.fetch, name, {
          source: bound.rootSource,
          root: indexed.root,
          index: indexed.index,
          selection: source.config.selection,
          codecs: ctx.codecs,
          signal: ctx.signal,
          origin: { probe: NO_PROBE, importedAt: ctx.clock.now().toISOString() },
        });
      });
    },
    async openDist(ctx, input, target) {
      const source = repository(input);
      const bound = binding(ctx, source);
      const open = async (url: string) => {
        const response = await bound.fetch({
          url,
          method: 'GET',
          destinations: bound.destinations,
          ...(ctx.credential === null ? {} : { credential: ctx.credential }),
          purpose: 'archive',
          maxBytes: UPSTREAM_DEFAULTS.archiveMaxBytes,
          timeoutMs: ARCHIVE_TIMEOUT_MS,
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
      };
      if (target.url === null) throw new UpstreamError('refused', undefined, 'dist_url');
      try {
        return await open(target.url);
      } catch (error) {
        if (
          !source.config.mirrorsFallback ||
          !(error instanceof UpstreamError) ||
          error.code === 'refused' ||
          ctx.signal.aborted
        )
          throw error;
        let root: Awaited<ReturnType<typeof bound.root>>;
        try {
          root = await upstream(bound.root);
        } catch (rootFailure) {
          if (rootFailure instanceof UpstreamError && rootFailure.code === 'too_large') throw error;
          throw rootFailure;
        }
        for (const mirror of root.mirrors) {
          const url = mirror.distUrl
            .replaceAll(
              '%package%',
              target.packageName.split('/').map(encodeURIComponent).join('/'),
            )
            .replaceAll('%version%', encodeURIComponent(target.version))
            .replaceAll('%reference%', encodeURIComponent(target.sourceRef ?? ''))
            .replaceAll('%type%', encodeURIComponent(target.distType ?? 'zip'));
          try {
            return await open(url);
          } catch (failure) {
            if (
              !(failure instanceof UpstreamError) ||
              failure.code === 'refused' ||
              ctx.signal.aborted
            )
              throw failure;
          }
        }
        throw error;
      }
    },
  };
}
