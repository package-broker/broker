declare module '#pb-manifest' {
  import type { PluginDefinition } from '@package-broker/core/plugin';
  import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
  export const plugins: readonly PluginDefinition[];
  export const migrations: readonly MigrationSource[];
}
