import { assetDeclarationProblems, type AssetDeclaration } from './asset-provider.js';
import type { TokenLifetimeInput } from './authz/token-lifetime.js';
import type { PlatformPortConfig } from './platform/port-config.js';
import type { RegistryConfigInput } from './registry/registry-config.js';
import type { Platform, PluginDefinition } from './plugin.js';

export {
  defineAssets,
  assetDeclarationProblems,
  assetProviderProblems,
  assetProviderResultProblems,
} from './asset-provider.js';
export type {
  AssetDeclaration,
  AssetProviderContextV1,
  AssetProviderResultV1,
  AssetProviderV1,
} from './asset-provider.js';

export interface BrokerConfig {
  readonly platform: Platform;
  readonly plugins: readonly PluginDefinition[];
  readonly assets?: readonly AssetDeclaration[];
  readonly platformPorts?: Partial<Record<Platform, PlatformPortConfig>>;
  readonly registry?: RegistryConfigInput;
  readonly tokens?: TokenLifetimeInput;
  readonly observability?: BrokerObservabilityConfig;
  readonly vulnerability?: { readonly enabled?: boolean };
  /** Read-only MCP endpoint for `read` tokens; requires the Rate Limiting binding on Workers. */
  readonly mcp?: { readonly enabled?: boolean };
}

export function brokerAssetsProblems(config: BrokerConfig): string[] {
  const value: unknown = config.assets;
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ['assets: must be a list'];
  const problems = value.flatMap(assetDeclarationProblems);
  if (
    value.filter(
      (entry: unknown) =>
        typeof entry === 'object' && entry !== null && 'kind' in entry && entry.kind === 'ui',
    ).length > 1
  ) {
    problems.push('assets: duplicate ui selection');
  }
  return problems;
}

export interface BrokerObservabilityConfig {
  /** Honour an inbound W3C traceparent only behind a proxy that sets or strips it. */
  readonly trustInboundTraceparent?: boolean;
}

const OBSERVABILITY_KEYS: ReadonlySet<string> = new Set(['trustInboundTraceparent']);

export function brokerObservabilityProblems(config: BrokerConfig): string[] {
  const value: unknown = config.observability;
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['observability: must be an object'];
  }
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!OBSERVABILITY_KEYS.has(key)) {
      problems.push('observability: contains an unknown key');
    } else if (typeof entry !== 'boolean') {
      problems.push(`observability.${key}: must be a boolean`);
    }
  }
  return problems;
}

const MCP_KEYS: ReadonlySet<string> = new Set(['enabled']);

export function brokerMcpProblems(config: BrokerConfig): string[] {
  const value: unknown = config.mcp;
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['mcp: must be an object'];
  }
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!MCP_KEYS.has(key)) {
      problems.push('mcp: contains an unknown key');
    } else if (typeof entry !== 'boolean') {
      problems.push(`mcp.${key}: must be a boolean`);
    }
  }
  return problems;
}

export function mcpEnabled(config: BrokerConfig): boolean {
  return config.mcp?.enabled === true;
}

export function defineConfig(config: BrokerConfig): BrokerConfig {
  return config;
}

export function brokerVulnerabilityProblems(config: BrokerConfig): string[] {
  const value: unknown = config.vulnerability;
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['vulnerability: must be an object'];
  }
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'enabled') problems.push('vulnerability: contains an unknown key');
    else if (typeof entry !== 'boolean') problems.push('vulnerability.enabled: must be a boolean');
  }
  return problems;
}

export function vulnerabilityEnabled(config: BrokerConfig): boolean {
  if (brokerVulnerabilityProblems(config).length) return false;
  return config.vulnerability?.enabled !== false;
}
