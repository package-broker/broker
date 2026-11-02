import type { Clock } from '../ids.js';
import type { CredentialRepository } from '../db/credentials.js';
import type { CredentialStore } from '../secrets/credential-store.js';
import { createBulkDiscovery, type BulkDiscoveryDeps } from './bulk-discovery.js';
import { parseCredentialMaterial } from './credentials.js';
import { discoverRepositories, planRepository } from './github-discovery.js';
import { createInstallationTokens, type InstallationTokens } from './github-installation-token.js';
import type { PolicyFetch, UpstreamCredential } from './policy-fetch.js';

export function createConfiguredGithubDiscovery(deps: {
  readonly credentials: Pick<CredentialRepository, 'get'>;
  readonly store: Pick<CredentialStore, 'read'>;
  readonly sources: BulkDiscoveryDeps['sources'];
  readonly existingRepository: BulkDiscoveryDeps['existingRepository'];
  readonly fetch: PolicyFetch;
  readonly clock: Clock;
}) {
  const bindings = new WeakMap<UpstreamCredential, InstallationTokens>();
  return createBulkDiscovery({
    repositoriesPerInvocation: 2,
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
          bindings.set(
            upstream,
            createInstallationTokens({
              app,
              fetch: deps.fetch,
              now: () => deps.clock.now().getTime(),
            }),
          );
          return { credentialId, installationId, upstream };
        } finally {
          plaintext.fill(0);
        }
      },
    },
    discovery: {
      discover: (_ctx, credential, request) =>
        discoverRepositories({
          tokens: bindings.get(credential.upstream)!,
          fetch: deps.fetch,
          installationId: String(credential.installationId),
          pattern: request.pattern,
          includeForks: request.includeForks === true,
          ...(request.ecosystem === undefined ? {} : { ecosystem: request.ecosystem }),
          ...(request.cursor === null ? {} : { cursor: request.cursor }),
          exists: request.exists,
        }),
      plan: (_ctx, credential, repository, exists, options) =>
        planRepository({
          tokens: bindings.get(credential.upstream)!,
          fetch: deps.fetch,
          installationId: String(credential.installationId),
          repository,
          exists,
          includeForks: options?.includeForks === true,
          ...(options?.ecosystem === undefined ? {} : { ecosystem: options.ecosystem }),
        }),
    },
  });
}
