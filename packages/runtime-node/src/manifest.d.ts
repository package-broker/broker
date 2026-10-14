declare module '#pb-manifest' {
  import type { PluginDefinition } from '@package-broker/core/plugin';
  export const plugins: readonly PluginDefinition[];
}
