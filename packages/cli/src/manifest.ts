import type { Platform, PluginDefinition } from '@package-broker/core/plugin';
import { SUPPORTED_PLUGIN_API } from '@package-broker/core/plugin';
import {
  KernelConfigError,
  collectRegistrations,
  type Registration,
} from '@package-broker/core/kernel/registry';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';

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
  if (errors.length === 0) {
    try {
      collectRegistrations(plugins);
    } catch (error) {
      if (!(error instanceof KernelConfigError)) throw error;
      errors.push(...error.problems);
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

export function renderManifestFromConfig(
  configImportPath: string,
  migrations?: readonly MigrationSource[],
): string {
  if (configImportPath.includes("'") || /[\r\n]/.test(configImportPath)) {
    throw new Error('config import path must not contain a quote or a newline');
  }
  const lines = [
    `import config from '${configImportPath}';`,
    'export const plugins = config.plugins;',
  ];
  if (migrations !== undefined) {
    lines.push(`export const migrations = ${JSON.stringify(migrations, null, 2)};`);
  }
  return `${lines.join('\n')}\n`;
}

export interface ManifestPlugin {
  id: string;
  package: string;
  version: string;
  apiVersion: number;
  platforms: readonly Platform[];
  dependsOn: readonly string[];
  capabilities: readonly string[];
  binds: readonly string[];
}

export interface ManifestBinding {
  port: string;
  plugin: string;
}

export interface ManifestRoute {
  method: string;
  path: string;
  plugin: string;
  permission: string | null;
}

export interface ManifestMigration {
  id: string;
  name: string;
  checksum: string;
  phase: 'expand' | 'contract';
}

export interface Manifest {
  schemaVersion: 1;
  platform: Platform;
  plugins: ManifestPlugin[];
  bindings: ManifestBinding[];
  migrations: ManifestMigration[];
  routes: ManifestRoute[];
}

export function renderManifestJson(
  plugins: readonly PluginDefinition[],
  versions: ReadonlyMap<string, string>,
  platform: Platform,
  extra: {
    migrations?: readonly MigrationSource[];
    registration?: Registration;
  } = {},
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
      binds: plugin.binds ?? [],
    })),
    bindings: [...(extra.registration?.bindings ?? [])].map(([port, plugin]) => ({ port, plugin })),
    migrations: (extra.migrations ?? []).map(({ id, name, checksum, phase }) => ({
      id,
      name,
      checksum,
      phase,
    })),
    routes: (extra.registration?.routes ?? []).map(({ method, path, plugin, permission }) => ({
      method,
      path,
      plugin,
      permission,
    })),
  };
}
