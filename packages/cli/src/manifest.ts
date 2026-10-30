import type { IdentityDescriptor, Platform, PluginDefinition } from '@package-broker/core/plugin';
import { SUPPORTED_PLUGIN_API } from '@package-broker/core/plugin';
import {
  KernelConfigError,
  collectRegistrations,
  type Registration,
} from '@package-broker/core/kernel/registry';
import {
  catalogueDiagnostics,
  type DiagnosticRoute,
} from '@package-broker/core/authz/catalogue-diagnostics';
import { DEFAULT_ROLES } from '@package-broker/core/authz/permissions';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';

export function validatePluginShape(
  plugins: readonly PluginDefinition[],
  target: Platform,
  onProblem?: (
    key: 'plugins.id' | 'plugins.apiVersion' | 'plugins.platforms' | 'plugins.dependsOn',
  ) => void,
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const [minApi, maxApi] = SUPPORTED_PLUGIN_API;

  for (const plugin of plugins) {
    if (ids.has(plugin.id)) {
      errors.push(`duplicate plugin id "${plugin.id}"`);
      onProblem?.('plugins.id');
    }
    ids.add(plugin.id);
    if (
      !Number.isInteger(plugin.apiVersion) ||
      plugin.apiVersion < minApi ||
      plugin.apiVersion > maxApi
    ) {
      errors.push(
        `plugin "${plugin.id}" has apiVersion ${plugin.apiVersion}, core supports ${minApi} to ${maxApi}`,
      );
      onProblem?.('plugins.apiVersion');
    }
    if (!plugin.platforms.includes(target)) {
      errors.push(`plugin "${plugin.id}" does not support target "${target}"`);
      onProblem?.('plugins.platforms');
    }
  }
  for (const plugin of plugins) {
    for (const dependency of plugin.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        errors.push(`plugin "${plugin.id}" depends on missing plugin "${dependency}"`);
        onProblem?.('plugins.dependsOn');
      }
    }
  }
  return errors;
}

export function validatePlugins(plugins: readonly PluginDefinition[], target: Platform): string[] {
  const errors = validatePluginShape(plugins, target);
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

const ROUTE_PROBLEM = /^(?:plugin "[^"]*"(?: route |: route path )|route [A-Z]+ )/;

export function isRouteProblem(problem: string): boolean {
  return ROUTE_PROBLEM.test(problem);
}

export function orderPlugins(plugins: readonly PluginDefinition[]): PluginDefinition[] {
  const ids = new Set(plugins.map((plugin) => plugin.id));
  const ordered: PluginDefinition[] = [];
  const emitted = new Set<string>();
  const remaining = new Set(plugins);
  while (remaining.size > 0) {
    const next = [...remaining].find((plugin) =>
      (plugin.dependsOn ?? []).every((id) => !ids.has(id) || emitted.has(id)),
    );
    if (next === undefined) {
      const [first] = remaining;
      throw new Error(`dependency cycle at plugin "${first?.id}"`);
    }
    ordered.push(next);
    emitted.add(next.id);
    remaining.delete(next);
  }
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
  boundary: string | null;
  needsOrg?: boolean;
  package?: true;
}

export interface ManifestMigration {
  id: string;
  name: string;
  checksum: string;
  phase: 'expand' | 'contract';
}

export interface Manifest {
  localAuth?: LocalAuthCapability;
  identity?: IdentityDescriptor;
  platformPorts?: PlatformPortConfig | null;
  schemaVersion: 1;
  platform: Platform;
  plugins: ManifestPlugin[];
  bindings: ManifestBinding[];
  migrations: ManifestMigration[];
  routes: ManifestRoute[];
}

export interface LocalAuthCapability {
  version: 1;
}

export function snapshotLocalAuthCapability(value: unknown): Readonly<LocalAuthCapability> | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'version') ||
    !('version' in value) ||
    value.version !== 1
  )
    return null;
  return Object.freeze({ version: 1 });
}

export function runtimeSupportsLocalAuth(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return false;
  if (!('packageBroker' in metadata)) return false;
  const marker = metadata.packageBroker;
  return (
    typeof marker === 'object' &&
    marker !== null &&
    !Array.isArray(marker) &&
    'localAuth' in marker &&
    marker.localAuth === 1
  );
}

export function renderManifestJson(
  plugins: readonly PluginDefinition[],
  versions: ReadonlyMap<string, string>,
  platform: Platform,
  extra: {
    migrations?: readonly MigrationSource[];
    registration?: Registration;
    runtimeMetadata?: unknown;
  } = {},
): Manifest {
  return {
    schemaVersion: 1,
    ...(runtimeSupportsLocalAuth(extra.runtimeMetadata)
      ? { localAuth: { version: 1 as const } }
      : {}),
    ...(extra.registration?.identityDescriptor
      ? {
          identity: {
            runtimeProviders: extra.registration.identityDescriptor.runtimeProviders,
            compiled: extra.registration.identityDescriptor.compiled.map(
              ({ id, kind, anchor, policy }) => ({
                id,
                kind,
                anchor,
                ...(policy === undefined
                  ? {}
                  : {
                      policy: {
                        verifiedDomains: [...policy.verifiedDomains],
                        ...(policy.emailAuthoritativeDomains === undefined
                          ? {}
                          : { emailAuthoritativeDomains: [...policy.emailAuthoritativeDomains] }),
                      },
                    }),
              }),
            ),
          },
        }
      : {}),
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
    routes: (extra.registration?.routes ?? []).map((route) => ({
      method: route.method,
      path: route.path,
      plugin: route.plugin,
      permission: route.permission,
      boundary: route.boundary ?? null,
      ...(route.needsOrg === undefined ? {} : { needsOrg: route.needsOrg }),
      ...(route.package === undefined ? {} : { package: true as const }),
    })),
  };
}

const ADMIN_PERMISSIONS: readonly string[] =
  DEFAULT_ROLES.find((role) => role.key === 'organization_admin')?.permissions ?? [];

export function diagnoseRoutes(routes: readonly DiagnosticRoute[]): string[] {
  return catalogueDiagnostics(routes, ADMIN_PERMISSIONS, { packageResolver: true });
}
