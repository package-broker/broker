import {
  definePlugin,
  GITHUB_API_VERSION,
  packageKey,
  sha256Hex,
  SnapshotCorruptError,
  snapshotRef,
  UpstreamError,
  type PolicyFetch,
  type ProviderContext,
  type SourceProvider,
  type SourceProviderContext,
} from '@package-broker/core/plugin';
import {
  createInstallationTokens,
  parseRateLimit,
  type InstallationToken,
  type InstallationTokens,
  type RateLimit,
} from './installation-token.js';
import { createGithubProvider, GithubProviderError, RateLimited } from './provider.js';
import { GithubRestError } from './token-rest.js';
import { githubWebhookVerifier } from './webhook.js';
import { discoverRepositories, DiscoveryError } from './discovery.js';

export default function github() {
  return definePlugin({
    id: 'github',
    package: '@package-broker/plugin-github',
    apiVersion: 3,
    platforms: ['cloudflare', 'node'],
    capabilities: ['source'],
    binds: ['source'],
    sourceProviders: (context?: SourceProviderContext): readonly SourceProvider[] => {
      const cache = new Map<
        string,
        {
          appId: string;
          privateKeyPem: string;
          tokens: Map<string, InstallationToken>;
          inflight: Map<string, Promise<InstallationToken>>;
          limit: RateLimit | undefined;
        }
      >();
      const tokensFor = (
        ctx: ProviderContext,
        input: Parameters<SourceProviderContext['tokensFor']>[1],
      ) =>
        context?.tokensFor(ctx.org, input, (app, installationId, credentialId) => {
          const key = JSON.stringify([ctx.org.orgId, credentialId ?? app.appId, installationId]);
          let state = cache.get(key);
          if (
            state === undefined ||
            state.appId !== app.appId ||
            state.privateKeyPem !== app.privateKeyPem
          ) {
            state = { ...app, tokens: new Map(), inflight: new Map(), limit: undefined };
            cache.delete(key);
            if (cache.size >= 256) cache.delete(cache.keys().next().value!);
            cache.set(key, state);
          }
          const shared = state;
          // A caller's cancellation must not abort a token mint shared with other requests.
          const service = createInstallationTokens({
            app,
            fetch: ctx.fetch,
            now: () => ctx.clock.now().getTime(),
          });
          const lookup = (grant: string, mint: () => Promise<InstallationToken>) => {
            const now = ctx.clock.now().getTime();
            for (const [key, token] of shared.tokens) {
              if (now >= token.expiresAt - 10 * 60_000) shared.tokens.delete(key);
            }
            const hit = shared.tokens.get(grant);
            if (hit !== undefined) return Promise.resolve(hit);
            const running = shared.inflight.get(grant);
            if (running !== undefined) return running;
            const pending = mint()
              .then((token) => {
                if (shared.tokens.size >= 512)
                  shared.tokens.delete(shared.tokens.keys().next().value!);
                shared.tokens.set(grant, token);
                return token;
              })
              .finally(() => shared.inflight.delete(grant));
            shared.inflight.set(grant, pending);
            return pending;
          };
          const tokens: InstallationTokens = {
            forRepositories: (id, repositories) =>
              lookup(
                JSON.stringify([
                  id,
                  [...new Set(repositories.map((name) => name.toLowerCase()))].sort(),
                ]),
                () => service.forRepositories(id, repositories),
              ),
            forListing: (id) => lookup(JSON.stringify([id, '*']), () => service.forListing(id)),
            observe: (_id, headers) => {
              shared.limit = parseRateLimit(headers) ?? shared.limit;
            },
            rateLimit: () => shared.limit,
          };
          return { installationId, tokens };
        }) ?? Promise.resolve(null);

      const provider = (ctx: ProviderContext) =>
        createGithubProvider({
          runtime: context?.runtime ?? 'docker',
          tokensFor: async (source) => (await tokensFor(ctx, source))?.tokens ?? null,
        });
      return [
        {
          id: 'github',
          sourceTypes: ['vcs'],
          ecosystems: ['composer'],
          async listPackages(ctx, source, cursor) {
            if (cursor !== null || source.type !== 'vcs' || source.config.provider !== 'github')
              throw new DiscoveryError('invalid_request');
            if (source.config.installationId === undefined) {
              try {
                return await provider(ctx).listPackages!(ctx, source, cursor);
              } catch (error) {
                if (error instanceof GithubRestError) throw new DiscoveryError('invalid_response');
                if (error instanceof GithubProviderError)
                  throw new DiscoveryError(
                    error.code === 'invalid_request' ? 'invalid_request' : 'invalid_response',
                  );
                if (error instanceof RateLimited) throw new UpstreamError('http_status', 429);
                throw error;
              }
            }
            const { repository, installationId } = source.config;
            if (
              !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
              ['.', '..'].includes(repository.split('/')[1]!) ||
              !Number.isSafeInteger(installationId) ||
              (installationId ?? 0) <= 0
            )
              throw new DiscoveryError('invalid_request');
            const binding = await tokensFor(ctx, source);
            if (binding === null) throw new DiscoveryError('invalid_request');
            let name = source.config.packageName;
            if (name === undefined) {
              const token = await binding.tokens.forRepositories(binding.installationId, [
                repository.split('/')[1]!,
              ]);
              const origin = 'https://api.github.com';
              const response = await fetchFor(ctx)({
                url: `${origin}/repos/${repository}/contents/composer.json`,
                method: 'GET',
                purpose: 'api',
                headers: {
                  accept: 'application/vnd.github.raw+json',
                  'x-github-api-version': GITHUB_API_VERSION,
                },
                credential: {
                  origins: [origin],
                  queryParams: [],
                  apply(headers, url) {
                    if (url.origin === origin)
                      headers.set('authorization', `Bearer ${token.value}`);
                    return { headers, url };
                  },
                },
                destinations: [origin],
                maxBytes: 1024 * 1024,
                timeoutMs: 30_000,
              });
              binding.tokens.observe(binding.installationId, response.headers);
              if (response.status !== 200) {
                void response.body?.cancel().catch(() => undefined);
                throw new UpstreamError('http_status', response.status);
              }
              let manifest: unknown;
              try {
                manifest = await new Response(response.body).json();
              } catch {
                throw new DiscoveryError('invalid_response');
              }
              if (
                typeof manifest !== 'object' ||
                manifest === null ||
                !('name' in manifest) ||
                typeof manifest.name !== 'string'
              )
                throw new DiscoveryError('invalid_response');
              name = manifest.name;
            }
            try {
              name = packageKey(name, { ecosystem: 'composer' });
            } catch {
              throw new DiscoveryError('invalid_response');
            }
            return {
              names: [name],
              next: null,
              last: true,
              snapshot: snapshotRef(
                `sha256:${await sha256Hex(JSON.stringify([repository, name]))}`,
              ),
            };
          },
          async describe(ctx, source, name, options) {
            try {
              return await provider(ctx).describe(ctx, source, name, options);
            } catch (error) {
              if (error instanceof GithubProviderError && error.code === 'snapshot_changed')
                throw new SnapshotCorruptError();
              throw error;
            }
          },
          openDist: (ctx, source, target) => provider(ctx).openDist(ctx, source, target),
          async discoverRepositories(ctx, credential, cursor) {
            const binding = await tokensFor(ctx, credential);
            if (binding === undefined || binding === null)
              throw new DiscoveryError('invalid_request');
            const page = await discoverRepositories({
              ...binding,
              fetch: fetchFor(ctx),
              exists: () => false,
              ...(cursor === null ? {} : { cursor }),
            });
            const repositories = new Map(
              page.entries.map((entry) => [
                entry.repository,
                {
                  id: entry.repository,
                  name: entry.repository,
                  url: `https://github.com/${entry.repository}.git`,
                  archived: entry.reason === 'archived',
                },
              ]),
            );
            return { repositories: [...repositories.values()], next: page.nextCursor };
          },
          webhookVerifier: githubWebhookVerifier,
        },
      ];
    },
  });
}

function fetchFor(ctx: ProviderContext): PolicyFetch {
  return (request) =>
    ctx.fetch({
      ...request,
      signal:
        request.signal === undefined ? ctx.signal : AbortSignal.any([ctx.signal, request.signal]),
    });
}
