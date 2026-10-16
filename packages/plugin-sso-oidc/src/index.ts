import type { IdentityProvider } from '@package-broker/core/identity/port';
import { definePlugin, type PluginDefinition } from '@package-broker/core/plugin';
import {
  type CloudflareAccessConfig,
  cloudflareAccessProblems,
  createCloudflareAccessProvider,
} from './cloudflare-access.js';
import { type OidcConfig, createOidcProvider, oidcProblems } from './oidc.js';

export type { CloudflareAccessConfig } from './cloudflare-access.js';
export type { OidcConfig } from './oidc.js';

export interface SsoOidcOptions {
  readonly providers?: readonly (CloudflareAccessConfig | OidcConfig)[];
}

type ProviderConfig = CloudflareAccessConfig | OidcConfig;
type Fields = Record<PropertyKey, unknown>;

const MAX_PROVIDERS = 64;
const UNREADABLE = 'configuration must be a readable object';
const UNRESERVED_CHARACTER = /^[A-Za-z0-9\-._~]$/;
const LIST_KEYS: readonly string[] = ['scopes', 'trustedAudiences', 'trustedEndpointOrigins'];

function definition(
  extra: Pick<PluginDefinition, 'binds' | 'identityProviders'>,
): PluginDefinition {
  return Object.freeze(
    definePlugin({
      id: 'sso-oidc',
      package: '@package-broker/plugin-sso-oidc',
      apiVersion: 3,
      platforms: Object.freeze(['cloudflare', 'node'] as const),
      capabilities: Object.freeze(['sso'] as const),
      ...extra,
    }),
  );
}

function isContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyFields(raw: object): Fields {
  const source = raw as Fields;
  const copy: Fields = Object.create(null) as Fields;
  for (const key of Reflect.ownKeys(raw)) {
    Object.defineProperty(copy, key, {
      value: source[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

function frozenList(value: unknown): unknown {
  return Array.isArray(value) ? Object.freeze(Array.from(value as unknown[])) : value;
}

function snapshotConfig(raw: unknown): unknown {
  if (!isContainer(raw)) {
    return raw;
  }
  const copy = copyFields(raw);
  for (const key of LIST_KEYS) {
    if (Object.hasOwn(copy, key)) {
      copy[key] = frozenList(copy[key]);
    }
  }
  if (isContainer(copy['policy'])) {
    const policy = copyFields(copy['policy']);
    if (Object.hasOwn(policy, 'verifiedDomains')) {
      policy['verifiedDomains'] = frozenList(policy['verifiedDomains']);
    }
    copy['policy'] = Object.freeze(policy);
  }
  return Object.freeze(copy);
}

function problemsOf(config: unknown): string[] {
  if (!isContainer(config)) {
    return ['configuration must be an object'];
  }
  switch ((config as { kind?: unknown }).kind) {
    case 'cloudflare-access':
      return cloudflareAccessProblems(config);
    case 'oidc':
      return oidcProblems(config);
    default:
      return ['kind must be "cloudflare-access" or "oidc"'];
  }
}

function canonicalAnchor(anchor: string): string {
  if (!anchor.startsWith('oidc:')) {
    return anchor.toLowerCase();
  }
  try {
    const url = new URL(anchor.slice('oidc:'.length));
    const path = url.pathname
      .replace(/%([0-9a-fA-F]{2})/g, (escape, hex: string) => {
        const char = String.fromCharCode(Number.parseInt(hex, 16));
        return UNRESERVED_CHARACTER.test(char) ? char : escape.toUpperCase();
      })
      .replace(/\/+$/, '');
    const host = url.hostname.replace(/\.$/, '');
    return `oidc:${url.protocol}//${host}${url.port === '' ? '' : `:${url.port}`}${path}`;
  } catch {
    return anchor;
  }
}

function anchorOf(config: ProviderConfig): string {
  return config.kind === 'oidc'
    ? `oidc:${config.issuer}`
    : `access:${config.teamDomain}/${config.audience}`;
}

function fail(problems: readonly string[]): never {
  throw new TypeError(`invalid sso-oidc configuration: ${problems.join('; ')}`);
}

export default function ssoOidc(options: SsoOidcOptions = {}): PluginDefinition {
  if (!isContainer(options)) {
    return fail(['options must be an object']);
  }
  let configured: unknown;
  let length = 0;
  let readable = true;
  try {
    configured = options.providers;
    if (Array.isArray(configured)) {
      length = (configured as unknown[]).length;
    }
  } catch {
    readable = false;
  }
  if (!readable) {
    return fail(['providers must be readable']);
  }
  if (configured !== undefined && !Array.isArray(configured)) {
    return fail(['providers must be an array']);
  }
  if (configured === undefined || length === 0) {
    return definition({});
  }
  if (length > MAX_PROVIDERS) {
    return fail([`providers must hold at most ${MAX_PROVIDERS} entries`]);
  }

  const problems: string[] = [];
  const snapshots: ProviderConfig[] = [];
  const idIndex = new Map<string, number>();
  const anchorIndex = new Map<string, number>();
  for (let index = 0; index < length; index += 1) {
    const label = `providers[${index}]`;
    let config: unknown;
    let own: string[];
    try {
      config = snapshotConfig((configured as unknown[])[index]);
      own = problemsOf(config);
    } catch {
      problems.push(`${label}: ${UNREADABLE}`);
      continue;
    }
    problems.push(...own.map((problem) => `${label}: ${problem}`));
    const id = isContainer(config) ? (config as { id?: unknown }).id : undefined;
    if (typeof id === 'string') {
      const first = idIndex.get(id);
      if (first === undefined) {
        idIndex.set(id, index);
      } else {
        problems.push(`${label}: id duplicates providers[${first}]`);
      }
    }
    if (own.length === 0) {
      const key = canonicalAnchor(anchorOf(config as ProviderConfig));
      const first = anchorIndex.get(key);
      if (first === undefined) {
        anchorIndex.set(key, index);
      } else {
        problems.push(`${label}: trust anchor duplicates providers[${first}]`);
      }
      snapshots.push(config as ProviderConfig);
    }
  }
  if (problems.length > 0) {
    return fail(problems);
  }

  return definition({
    binds: Object.freeze(['identity'] as const),
    identityProviders: (ctx): readonly IdentityProvider[] =>
      snapshots.map((config) =>
        config.kind === 'oidc'
          ? createOidcProvider(config, ctx)
          : createCloudflareAccessProvider(config, ctx),
      ),
  });
}
