declare module '#pb-manifest' {
  import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
  import type { PluginDefinition } from '@package-broker/core/plugin';
  import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
  export const plugins: readonly PluginDefinition[];
  export const migrations: readonly MigrationSource[];
  export const platformPorts: PlatformPortConfig | null;
  export const mcp: import('@package-broker/core/config').BrokerConfig['mcp'];
  export const vulnerability: import('@package-broker/core/config').BrokerConfig['vulnerability'];
  export const tokens: import('@package-broker/core/config').BrokerConfig['tokens'];
  export const registry: import('@package-broker/core/config').BrokerConfig['registry'];
}
