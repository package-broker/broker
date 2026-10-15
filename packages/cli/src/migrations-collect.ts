import { readdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { planMigrations } from '@package-broker/db-sqlite/migrations/plan';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';

export type ResolvePackageDir = (packageName: string) => string;

const CORE_PACKAGE = '@package-broker/db-sqlite';

export function defaultResolvePackageDir(cwd: string): ResolvePackageDir {
  const require = createRequire(path.join(cwd, 'package.json'));
  return (packageName) => path.dirname(require.resolve(`${packageName}/package.json`));
}

async function loadDir(owner: string, dir: string): Promise<MigrationSource[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource(owner, name, await readFile(path.join(dir, name), 'utf8')),
    ),
  );
}

function isOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function pluginMigrationsDir(
  plugin: PluginDefinition,
  packageDir: string,
  dir: string,
): Promise<string> {
  const outside = () =>
    new Error(`plugin "${plugin.id}": migrations dir "${dir}" resolves outside the plugin package`);
  const lexical = path.resolve(packageDir, dir);
  if (isOutside(packageDir, lexical)) throw outside();
  const resolved = await realpath(lexical);
  if (isOutside(await realpath(packageDir), resolved)) throw outside();
  return resolved;
}

export async function collectMigrations(
  plugins: readonly PluginDefinition[],
  resolve: ResolvePackageDir,
): Promise<MigrationSource[]> {
  const sources = await loadDir('core', path.join(resolve(CORE_PACKAGE), 'migrations'));
  for (const plugin of plugins) {
    if (plugin.migrations === undefined) continue;
    const dir = await pluginMigrationsDir(plugin, resolve(plugin.package), plugin.migrations.dir);
    sources.push(...(await loadDir(plugin.id, dir)));
  }
  return planMigrations(sources, ['core', ...plugins.map((plugin) => plugin.id)]);
}
