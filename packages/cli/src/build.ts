import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrokerConfig } from '@package-broker/core';
import { validatePlatformPorts } from '@package-broker/core/platform/port-config';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { Platform } from '@package-broker/core/plugin';
import { build as esbuild, type Metafile } from 'esbuild';
import {
  credentialProblems,
  describePlatformPorts,
  renderBuildInfo,
  renderBuildManifest,
  renderNodePackageJson,
  toManifestMigrations,
  writeOutputPackageJson,
} from './build-artifacts.js';
import { orderPlugins, renderManifestJson, validatePlugins } from './manifest.js';
import { collectMigrations, defaultResolvePackageDir } from './migrations-collect.js';

export interface BuildOptions {
  configPath: string;
  target?: Platform;
  outDir?: string;
  cwd?: string;
  runtimeEntry?: string;
}

export interface BuildResult {
  outDir: string;
  manifestJson: string;
  manifestTs: string;
  bundle: string;
  migrations: string;
  buildInfo: string;
  metafile: Metafile;
}

async function loadConfig(configPath: string, cwd: string): Promise<BrokerConfig> {
  const scratch = path.join(cwd, '.pb', 'config');
  const outfile = path.join(
    scratch,
    `${createHash('sha256').update(configPath).digest('hex').slice(0, 12)}.mjs`,
  );
  await esbuild({
    entryPoints: [configPath],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
  });
  try {
    const loaded = (await import(`${pathToFileURL(outfile).href}`)) as { default?: BrokerConfig };
    if (!loaded.default) throw new Error(`${configPath} has no default export`);
    return loaded.default;
  } finally {
    await rm(outfile, { force: true });
  }
}

async function readVersion(packageName: string, cwd: string): Promise<string> {
  const require = createRequire(path.join(cwd, 'package.json'));
  const pkg = JSON.parse(
    await readFile(require.resolve(`${packageName}/package.json`), 'utf8'),
  ) as {
    version: string;
  };
  return pkg.version;
}

export async function readNodeDriverVersion(
  cliRequire: NodeJS.Require = createRequire(import.meta.url),
): Promise<string> {
  const runtimeRequire = createRequire(
    cliRequire.resolve('@package-broker/runtime-node/package.json'),
  );
  const driver = JSON.parse(
    await readFile(runtimeRequire.resolve('better-sqlite3/package.json'), 'utf8'),
  ) as { version: string };
  return driver.version;
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.resolve(cwd, options.configPath);
  const config = await loadConfig(configPath, cwd);
  const target = options.target ?? config.platform;

  const errors = validatePlugins(config.plugins, target);
  errors.push(...validatePlatformPorts(config.platformPorts, target));
  const stanza =
    typeof config.platformPorts === 'object' &&
    config.platformPorts !== null &&
    Object.hasOwn(config.platformPorts, target)
      ? config.platformPorts[target]
      : undefined;
  const platformPorts = describePlatformPorts(stanza);
  errors.push(...credentialProblems(platformPorts, target));
  if (errors.length > 0) throw new Error(`invalid broker config:\n${errors.join('\n')}`);
  const plugins = orderPlugins(config.plugins);
  const registration = collectRegistrations(plugins);
  if (registration.jobs.length > 0 && platformPorts === null) {
    throw new Error(
      `invalid broker config:\njobs: registered but platformPorts.${target} is not configured`,
    );
  }
  const sources = await collectMigrations(plugins, defaultResolvePackageDir(cwd));

  const outDir = path.resolve(cwd, options.outDir ?? path.join('.pb', target));
  const generated = path.join(outDir, 'generated');
  await mkdir(generated, { recursive: true });

  const migrations = path.join(outDir, 'migrations');
  await rm(migrations, { recursive: true, force: true });
  await mkdir(migrations, { recursive: true });
  for (const source of sources) {
    const ownerDir = path.join(migrations, source.owner);
    await mkdir(ownerDir, { recursive: true });
    await writeFile(path.join(ownerDir, `${source.name}.sql`), source.sql);
  }

  const versions = new Map<string, string>();
  for (const plugin of plugins)
    versions.set(plugin.package, await readVersion(plugin.package, cwd));

  const manifestTs = path.join(generated, 'manifest.ts');
  const manifestJson = path.join(generated, 'manifest.json');
  await writeFile(
    manifestTs,
    renderBuildManifest(
      configPath,
      plugins.map((plugin) => plugin.id),
      target === 'node' ? sources : undefined,
      process.platform,
      platformPorts,
    ),
  );
  await writeFile(
    manifestJson,
    `${JSON.stringify(
      {
        ...renderManifestJson(plugins, versions, target, {
          migrations: toManifestMigrations(sources),
          registration,
        }),
        platformPorts,
      },
      null,
      2,
    )}\n`,
  );

  const packageJson = path.join(outDir, 'package.json');
  await writeOutputPackageJson(
    packageJson,
    target === 'node' ? renderNodePackageJson(await readNodeDriverVersion()) : null,
  );

  let lockfileSha256: string | null = null;
  try {
    lockfileSha256 = createHash('sha256')
      .update(await readFile(path.join(cwd, 'pnpm-lock.yaml')))
      .digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const buildInfo = path.join(outDir, 'build-info.json');
  await writeFile(
    buildInfo,
    renderBuildInfo({
      schemaVersion: 1,
      target,
      core: await readVersion('@package-broker/core', cwd),
      plugins: Object.fromEntries(versions),
      lockfileSha256,
      gitSha: process.env.GITHUB_SHA ?? null,
    }),
  );

  const runtime = target === 'cloudflare' ? 'runtime-cloudflare' : 'runtime-node';
  const entry =
    options.runtimeEntry ??
    createRequire(import.meta.url).resolve(`@package-broker/${runtime}/entry`);
  const bundle = path.join(outDir, target === 'cloudflare' ? 'worker.js' : 'server.js');
  const result = await esbuild({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: target === 'cloudflare' ? 'neutral' : 'node',
    conditions: target === 'cloudflare' ? ['workerd', 'worker', 'browser'] : [],
    external: target === 'cloudflare' ? ['cloudflare:*'] : ['better-sqlite3'],
    alias: { '#pb-manifest': manifestTs },
    nodePaths: [path.join(cwd, 'node_modules')],
    absWorkingDir: cwd,
    sourcemap: true,
    metafile: true,
    logLevel: 'silent',
  });
  await writeFile(path.join(outDir, 'metafile.json'), JSON.stringify(result.metafile));

  return {
    outDir,
    manifestJson,
    manifestTs,
    bundle,
    migrations,
    buildInfo,
    metafile: result.metafile,
  };
}
