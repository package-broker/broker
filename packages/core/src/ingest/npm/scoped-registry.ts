import { UpstreamError, type UpstreamCredential } from '../../sources/policy-fetch.js';
import type { ProviderContext, ProviderSource, SourceProvider } from '../../sources/provider.js';
import {
  describeNpm,
  npmPackumentUrl,
  openNpmTarball,
  validNpmName,
  type NpmStaging,
} from './npmjs-proxy.js';

const GITHUB_PACKAGES_ORIGIN = 'https://npm.pkg.github.com';
const GITHUB_PACKAGES_STORAGE = 'https://pkg-npm.githubusercontent.com';

const refused = (reason: string): UpstreamError => new UpstreamError('refused', undefined, reason);

interface Registry {
  readonly url: string;
  readonly origin: string;
  readonly scopes: readonly string[];
  readonly tarballOrigins: readonly string[];
  readonly tarballDestinations: readonly string[];
  readonly credential: UpstreamCredential | undefined;
}

function registryOf(ctx: ProviderContext, source: ProviderSource): Registry {
  if (source.type !== 'npm_registry' || source.url === null) throw refused('source_type');
  let origin: string;
  try {
    origin = new URL(source.url).origin;
  } catch {
    throw refused('source_url');
  }
  const { credential } = ctx;
  if (
    credential !== null &&
    (credential.origins.length === 0 || !credential.origins.every((bound) => bound === origin))
  ) {
    throw refused('credential');
  }
  const tarballOrigins = [
    origin,
    ...(source.config.distHosts ?? []).map((host) => `https://${host}`),
  ];
  return {
    url: source.url,
    origin,
    scopes: source.config.scopes,
    tarballOrigins,
    tarballDestinations: [
      ...tarballOrigins,
      ...(origin === GITHUB_PACKAGES_ORIGIN ? [GITHUB_PACKAGES_STORAGE] : []),
    ],
    credential: credential ?? undefined,
  };
}

function scopeOf(name: string): string | undefined {
  if (!validNpmName(name)) return undefined;
  const slash = name.indexOf('/');
  return name.startsWith('@') && slash > 1 ? name.slice(0, slash) : undefined;
}

/** True for a URL off the registry origin, which openNpmTarball refuses as a foreign host. */
function pathHasScope(url: string, origin: string, scope: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.origin !== origin) return true;
  try {
    return decodeURIComponent(parsed.pathname).split('/').includes(scope);
  } catch {
    return false;
  }
}

export function createNpmRegistryProvider(
  staging: NpmStaging,
  id = 'npm-registry',
): SourceProvider {
  return {
    id,
    sourceTypes: ['npm_registry'],
    ecosystems: ['npm'],
    async describe(ctx, source, name, options) {
      const registry = registryOf(ctx, source);
      const scope = scopeOf(name);
      if (scope === undefined || !registry.scopes.includes(scope)) {
        return { kind: 'not_found', definitive: false };
      }
      return describeNpm(
        staging,
        ctx,
        source,
        {
          name,
          url: npmPackumentUrl(registry.url, name),
          destinations: [registry.origin],
          ...(registry.credential === undefined ? {} : { credential: registry.credential }),
        },
        options,
      );
    },
    async openDist(ctx, source, target) {
      const registry = registryOf(ctx, source);
      const scope = scopeOf(target.packageName);
      if (scope === undefined || !registry.scopes.includes(scope)) throw refused('scope');
      if (target.url !== null && !pathHasScope(target.url, registry.origin, scope)) {
        throw refused('tarball_url');
      }
      return openNpmTarball(
        ctx,
        target,
        registry.tarballOrigins,
        registry.tarballDestinations,
        registry.credential,
      );
    },
  };
}
