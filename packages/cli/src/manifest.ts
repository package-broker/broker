import type { Platform, PluginDefinition } from '@package-broker/core/plugin';
import { SUPPORTED_PLUGIN_API } from '@package-broker/core/plugin';

export function validatePlugins(plugins: readonly PluginDefinition[], target: Platform): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const [minApi, maxApi] = SUPPORTED_PLUGIN_API;

  for (const plugin of plugins) {
    if (ids.has(plugin.id)) errors.push(`duplicate plugin id "${plugin.id}"`);
    ids.add(plugin.id);
    if (
      !Number.isInteger(plugin.apiVersion) ||
      plugin.apiVersion < minApi ||
      plugin.apiVersion > maxApi
    ) {
      errors.push(
        `plugin "${plugin.id}" has apiVersion ${plugin.apiVersion}, core supports ${minApi} to ${maxApi}`,
      );
    }
    if (!plugin.platforms.includes(target)) {
      errors.push(`plugin "${plugin.id}" does not support target "${target}"`);
    }
  }
  for (const plugin of plugins) {
    for (const dependency of plugin.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        errors.push(`plugin "${plugin.id}" depends on missing plugin "${dependency}"`);
      }
    }
  }
  return errors;
}

export function orderPlugins(plugins: readonly PluginDefinition[]): PluginDefinition[] {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const ordered: PluginDefinition[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (plugin: PluginDefinition): void => {
    const current = state.get(plugin.id);
    if (current === 'done') return;
    if (current === 'visiting') throw new Error(`dependency cycle at plugin "${plugin.id}"`);
    state.set(plugin.id, 'visiting');
    for (const dependency of plugin.dependsOn ?? []) {
      const resolved = byId.get(dependency);
      if (resolved) visit(resolved);
    }
    state.set(plugin.id, 'done');
    ordered.push(plugin);
  };

  plugins.forEach(visit);
  return ordered;
}

export function renderManifestTs(plugins: readonly PluginDefinition[]): string {
  const imports = plugins.map((plugin, index) => `import plugin${index} from '${plugin.package}';`);
  const list = plugins.map((_plugin, index) => `plugin${index}()`);
  return [...imports, '', `export const plugins = [${list.join(', ')}];`, ''].join('\n');
}

export interface ManifestPlugin {
  id: string;
  package: string;
  version: string;
  apiVersion: number;
  platforms: readonly Platform[];
  dependsOn: readonly string[];
  capabilities: readonly string[];
}

export interface Manifest {
  schemaVersion: 1;
  platform: Platform;
  plugins: ManifestPlugin[];
  bindings: never[];
  migrations: never[];
  routes: never[];
}

export function renderManifestJson(
  plugins: readonly PluginDefinition[],
  versions: ReadonlyMap<string, string>,
  platform: Platform,
): Manifest {
  return {
    schemaVersion: 1,
    platform,
    plugins: plugins.map((plugin) => ({
      id: plugin.id,
      package: plugin.package,
      version: versions.get(plugin.package) ?? '0.0.0',
      apiVersion: plugin.apiVersion,
      platforms: plugin.platforms,
      dependsOn: plugin.dependsOn ?? [],
      capabilities: plugin.capabilities ?? [],
    })),
    bindings: [],
    migrations: [],
    routes: [],
  };
}
