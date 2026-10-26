declare module '#pb-manifest' {
  import type { PluginDefinition } from '@package-broker/core/plugin';
  import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
  export const migrations: readonly Pick<
    import('@package-broker/db-sqlite/migrations/source').MigrationSource,
    'id' | 'checksum'
  >[];
  export const plugins: readonly PluginDefinition[];
  export const platformPorts: PlatformPortConfig | null;
  export const mcp: import('@package-broker/core/config').BrokerConfig['mcp'];
  export const vulnerability: import('@package-broker/core/config').BrokerConfig['vulnerability'];
  export const tokens: import('@package-broker/core/config').BrokerConfig['tokens'];
  export const registry: import('@package-broker/core/config').BrokerConfig['registry'];
}
