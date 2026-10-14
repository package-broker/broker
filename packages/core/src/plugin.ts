export const SUPPORTED_PLUGIN_API = [1, 1] as const;

export type Platform = 'cloudflare' | 'node';

export interface PluginApi {
  readonly apiVersion: number;
}

export interface PluginDefinition extends PluginApi {
  readonly id: string;
  readonly package: string;
  readonly platforms: readonly Platform[];
  readonly dependsOn?: readonly string[];
  readonly capabilities?: readonly string[];
}

export function definePlugin<T extends PluginDefinition>(definition: T): T {
  return definition;
}
