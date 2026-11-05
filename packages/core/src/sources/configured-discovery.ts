import type { Clock } from '../ids.js';
import type { CredentialRepository } from '../db/credentials.js';
import type { CredentialStore } from '../secrets/credential-store.js';
import {
  createBulkDiscovery,
  type BulkDiscovery,
  type BulkDiscoveryDeps,
} from './bulk-discovery.js';
import { parseCredentialMaterial } from './credentials.js';
import { discoverRepositories, planRepository } from './github-discovery.js';
import { createInstallationTokens, type InstallationTokens } from './github-installation-token.js';
import { UpstreamError, type PolicyFetch, type UpstreamCredential } from './policy-fetch.js';

interface ConfiguredDiscoveryDeps {
  readonly credentials: Pick<CredentialRepository, 'get'>;
  readonly store: Pick<CredentialStore, 'read'>;
  readonly sources: BulkDiscoveryDeps['sources'];
  readonly existingRepository: BulkDiscoveryDeps['existingRepository'];
  readonly fetch: PolicyFetch;
  readonly clock: Clock;
  readonly scheduled?: boolean;
  readonly authority?: BulkDiscoveryDeps['authority'];
  readonly statementCount?: () => number;
}
export function createConfiguredGithubDiscovery(deps: ConfiguredDiscoveryDeps): BulkDiscovery {
  return configuredGithubDiscovery(deps, false);
}
function configuredGithubDiscovery(deps: ConfiguredDiscoveryDeps, scoped: boolean): BulkDiscovery {
  const invocationStarted = deps.clock.now().getTime();
  let cached:
    | {
        orgId: string;
        credentialId: string;
        installationId: number;
        value: Awaited<ReturnType<BulkDiscoveryDeps['credentials']['resolve']>>;
      }
    | undefined;
  const fetch: PolicyFetch = !scoped
    ? deps.fetch
    : async (request) => {
        const remaining = 20000 - (deps.clock.now().getTime() - invocationStarted);
        if (remaining <= 0) throw new UpstreamError('timeout');
        return deps.fetch({
          ...request,
          timeoutMs: Math.min(request.timeoutMs, remaining),
          signal: AbortSignal.any([
            ...(request.signal === undefined ? [] : [request.signal]),
            AbortSignal.timeout(remaining),
          ]),
        });
      };
  const bindings = new WeakMap<UpstreamCredential, InstallationTokens>();
  const bulk = createBulkDiscovery({
    repositoriesPerInvocation: deps.scheduled ? 20 : 2,
    clock: deps.clock,
    ...(scoped
      ? { invocationStarted, invocationStatementStart: deps.statementCount?.() ?? 0 }
      : {}),
    ...(deps.authority === undefined ? {} : { authority: deps.authority }),
    ...(deps.statementCount === undefined ? {} : { statementCount: deps.statementCount }),
    sources: deps.sources,
    existingRepository: deps.existingRepository,
    credentials: {
      async resolve(ctx, credentialId, installationId) {
        if (
          typeof installationId !== 'number' ||
          !Number.isSafeInteger(installationId) ||
          installationId < 1
        )
          return null;
        if (
          scoped &&
          cached?.orgId === ctx.orgId &&
          cached.credentialId === credentialId &&
          cached.installationId === installationId
        )
          return cached.value;
        const row = await deps.credentials.get(ctx, credentialId);
        if (row === null || row.projectId !== null || row.kind !== 'github_app') return null;
        const plaintext = await deps.store.read(ctx, credentialId);
        try {
          const app = parseCredentialMaterial('github_app', plaintext);
          if (app.kind !== 'github_app') return null;
          const upstream: UpstreamCredential = {
            origins: [],
            queryParams: [],
            apply: (headers, url) => ({ headers, url }),
          };
          const tokens = createInstallationTokens({
            app,
            fetch,
            now: () => deps.clock.now().getTime(),
          });
          let contents:
            | {
                repositories: readonly string[];
                token: Awaited<ReturnType<InstallationTokens['forRepositories']>>;
              }
            | undefined;
          bindings.set(
            upstream,
            !scoped
              ? tokens
              : {
                  ...tokens,
                  async forRepositories(installation, repositories) {
                    if (
                      contents !== undefined &&
                      repositories.every((name) => contents!.repositories.includes(name))
                    )
                      return contents.token;
                    const token = await tokens.forRepositories(installation, repositories);
                    contents = { repositories, token };
                    return token;
                  },
                },
          );
          const value = { credentialId, installationId, upstream };
          if (scoped) cached = { orgId: ctx.orgId, credentialId, installationId, value };
          return value;
        } finally {
          plaintext.fill(0);
        }
      },
    },
    discovery: {
      async prepare(_ctx, credential, repositories) {
        if (scoped && repositories.length > 0)
          await bindings.get(credential.upstream)!.forRepositories(
            String(credential.installationId),
            repositories.map((repository) => repository.split('/')[1]!),
          );
      },
      discover: (_ctx, credential, request) =>
        discoverRepositories({
          tokens: bindings.get(credential.upstream)!,
          fetch,
          installationId: String(credential.installationId),
          pattern: request.pattern,
          now: () => deps.clock.now().getTime(),
          ...(deps.scheduled === true ? { pageSize: 3 } : {}),
          includeForks: request.includeForks === true,
          ...(request.ecosystem === undefined ? {} : { ecosystem: request.ecosystem }),
          ...(request.cursor === null ? {} : { cursor: request.cursor }),
          exists: request.exists,
        }),
      plan: (_ctx, credential, repository, exists, options) =>
        planRepository({
          tokens: bindings.get(credential.upstream)!,
          fetch,
          installationId: String(credential.installationId),
          repository,
          now: () => deps.clock.now().getTime(),
          exists,
          includeForks: options?.includeForks === true,
          ...(options?.ecosystem === undefined ? {} : { ecosystem: options.ecosystem }),
        }),
    },
  });
  return {
    ...bulk,
    forInvocation() {
      return configuredGithubDiscovery(deps, true);
    },
  };
}
