declare module '#pb-manifest' {
  import type { PluginDefinition } from '@package-broker/core/plugin';
  import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
  export const plugins: readonly PluginDefinition[];
  export const platformPorts: PlatformPortConfig | null;
  export const vulnerability: import('@package-broker/core/config').BrokerConfig['vulnerability'];
  export const tokens: import('@package-broker/core/config').BrokerConfig['tokens'];
  export const registry: import('@package-broker/core/config').BrokerConfig['registry'];
}
