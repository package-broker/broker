import type { PlatformPortConfig } from './platform/port-config.js';
import type { RegistryConfigInput } from './registry/registry-config.js';
import type { Platform, PluginDefinition } from './plugin.js';

export interface BrokerConfig {
  readonly platform: Platform;
  readonly plugins: readonly PluginDefinition[];
  readonly platformPorts?: Partial<Record<Platform, PlatformPortConfig>>;
  readonly registry?: RegistryConfigInput;
}

export function defineConfig(config: BrokerConfig): BrokerConfig {
  return config;
}
