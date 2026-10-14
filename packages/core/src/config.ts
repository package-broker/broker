import type { Platform, PluginDefinition } from './plugin.js';

export interface BrokerConfig {
  readonly platform: Platform;
  readonly plugins: readonly PluginDefinition[];
}

export function defineConfig(config: BrokerConfig): BrokerConfig {
  return config;
}
