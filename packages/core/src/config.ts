import type { PlatformPortConfig } from './platform/port-config.js';
import type { RegistryConfigInput } from './registry/registry-config.js';
import type { Platform, PluginDefinition } from './plugin.js';

export interface BrokerConfig {
  readonly platform: Platform;
  readonly plugins: readonly PluginDefinition[];
  readonly platformPorts?: Partial<Record<Platform, PlatformPortConfig>>;
  readonly registry?: RegistryConfigInput;
  readonly observability?: BrokerObservabilityConfig;
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

export function defineConfig(config: BrokerConfig): BrokerConfig {
  return config;
}
