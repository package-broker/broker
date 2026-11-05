import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrokerConfig } from '@package-broker/core';
import {
  brokerAuditProblems,
  brokerAuditWarnings,
  brokerNotificationsProblems,
  brokerObservabilityProblems,
  brokerVulnerabilityProblems,
} from '@package-broker/core/config';
import { validatePlatformPorts } from '@package-broker/core/platform/port-config';
import {
  collectRegistrations,
  KernelConfigError,
  type Registration,
} from '@package-broker/core/kernel/registry';
import type { PackageVisibilityPort } from '@package-broker/core/db/catalogue';
import type { Platform, PluginDefinition } from '@package-broker/core/plugin';
import { build as esbuild, type Metafile } from 'esbuild';
import { auditTrail } from '@package-broker/plugin-audit-trail';
import { AssetProblemsError, prepareAssets, stageAssets } from './build-assets.js';
import {
  credentialProblems,
  describePlatformPorts,
  renderBuildInfo,
  renderBuildManifest,
  renderNodePackageJson,
  toManifestMigrations,
  writeOutputPackageJson,
} from './build-artifacts.js';
import {
  diagnoseRoutes,
  isRouteProblem,
  orderPlugins,
  renderManifestJson,
  describeAudit,
  validatePluginShape,
} from './manifest.js';
import {
  collectMigrations,
  defaultResolvePackageDir,
  type ResolvePackageDir,
} from './migrations-collect.js';

const DB_SQLITE_PACKAGE = '@package-broker/db-sqlite';

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

export const declarationOnlyPackageResolver: PackageVisibilityPort = Object.freeze({
  resolve: () =>
    Promise.reject(new Error('the build-time package resolver validates declarations only')),
});

export class BuildDiagnosticsError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid broker config:\n${problems.join('\n')}`);
    this.name = 'BuildDiagnosticsError';
    this.problems = problems;
  }
}

export class BuildConfigError extends Error {
  readonly configKeys: readonly string[];

  constructor(keys: readonly string[], message = `invalid broker config: ${keys.join(', ')}`) {
    super(message);
    this.configKeys = [...new Set(keys)];
  }
}

async function loadConfig(configPath: string, cwd: string): Promise<BrokerConfig> {
  const outfile = path.join(
    cwd,
    '.pb',
    'config',
    `${createHash('sha256').update(configPath).digest('hex').slice(0, 12)}.mjs`,
  );
  await esbuild({
    entryPoints: [configPath],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'config-dir-externals',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (args.pluginData === 'config-dir') return undefined;
            const resolved = await pluginBuild.resolve(args.path, {
              kind: args.kind,
              resolveDir: args.resolveDir,
              pluginData: 'config-dir',
            });
            if (resolved.errors.length > 0) return { errors: resolved.errors };
            return { path: resolved.external ? args.path : resolved.path, external: true };
          });
        },
      },
    ],
  });
  try {
    const hash = createHash('sha256')
      .update(await readFile(outfile))
      .digest('hex');
    const loaded = (await import(`${pathToFileURL(outfile).href}?hash=${hash}`)) as {
      default?: BrokerConfig;
    };
    if (!loaded.default) throw new BuildConfigError(['default']);
    return loaded.default;
  } finally {
    await rm(outfile, { force: true });
  }
}

async function readPackageVersion(packageDir: string): Promise<string> {
  const pkg = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8')) as {
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
  let gitSha: string | null;
  let dirty: boolean | null = null;
  try {
    gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    dirty =
      execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().length > 0;
  } catch {
    gitSha = null;
  }
  gitSha = process.env.GITHUB_SHA ?? gitSha;
  const configPath = path.resolve(cwd, options.configPath);
  const loadedConfig = await loadConfig(configPath, cwd);
  if (loadedConfig.plugins.some((plugin) => plugin.id === 'audit-trail' && !plugin.auditTrail)) {
    throw new BuildConfigError(
      ['plugins.id'],
      'invalid broker config: audit-trail id requires a trail definition',
    );
  }
  const defaultTrail =
    loadedConfig.audit?.acceptNoDurableAudit !== true &&
    !loadedConfig.plugins.some((plugin) => plugin.auditTrail || plugin.auditSinks?.length);
  const config: BrokerConfig = defaultTrail
    ? { ...loadedConfig, plugins: [...loadedConfig.plugins, auditTrail()] }
    : loadedConfig;
  const target = options.target ?? config.platform;

  const configProblems = [
    ...brokerObservabilityProblems(config),
    ...brokerVulnerabilityProblems(config),
    ...brokerAuditProblems(config, target),
    ...brokerNotificationsProblems(config),
  ];
  if (
    config.audit?.policy === 'required' &&
    !config.plugins.some(
      (plugin) =>
        plugin.auditTrail || plugin.auditSinks?.some((sink) => sink.custody === 'durable'),
    )
  ) {
    configProblems.push('audit: required policy needs a durable path');
  }
  if (configProblems.length > 0) throw new BuildDiagnosticsError(configProblems);
  for (const warning of brokerAuditWarnings(config, target))
    console.warn(`warning: ${warning.message}`);
  const pluginKeys: string[] = [];
  validatePluginShape(config.plugins, target, (key) => pluginKeys.push(key));
  if (pluginKeys.length > 0) throw new BuildConfigError(pluginKeys);
  const errors: string[] = [];
  errors.push(...validatePlatformPorts(config.platformPorts, target));
  const stanza =
    typeof config.platformPorts === 'object' &&
    config.platformPorts !== null &&
    Object.hasOwn(config.platformPorts, target)
      ? config.platformPorts[target]
      : undefined;
  const platformPorts = describePlatformPorts(stanza);
  errors.push(...credentialProblems(platformPorts, target));
  if (errors.length > 0) throw new BuildConfigError(errors);
  let plugins: PluginDefinition[];
  try {
    plugins = orderPlugins(config.plugins);
  } catch (error) {
    throw new BuildConfigError(
      ['plugins.dependsOn'],
      error instanceof Error ? error.message : 'invalid plugin dependency order',
    );
  }
  let registration: Registration;
  try {
    registration = collectRegistrations(plugins, {
      packageResolver: declarationOnlyPackageResolver,
    });
  } catch (error) {
    if (!(error instanceof KernelConfigError)) throw error;
    if (error.problems.every(isRouteProblem)) throw new BuildDiagnosticsError(error.problems);
    throw new BuildConfigError(['plugins'], `invalid broker config:\n${error.problems.join('\n')}`);
  }
  const routeProblems = diagnoseRoutes(registration.routes);
  if (routeProblems.length > 0) throw new BuildDiagnosticsError(routeProblems);
  if (registration.jobs.length > 0 && platformPorts === null) {
    throw new BuildConfigError([`jobs: registered but platformPorts.${target} is not configured`]);
  }
  if (platformPorts === null) {
    console.warn(
      `warning: no platformPorts stanza for ${target}; blob, cache, jobs and observability ports are disabled`,
    );
  }
  const configDir = path.dirname(configPath);
  const resolveFromConfig = defaultResolvePackageDir(configDir);
  const resolveFromCli = defaultResolvePackageDir(path.dirname(fileURLToPath(import.meta.url)));
  const resolvePackageDir: ResolvePackageDir = (packageName) => {
    if (
      packageName === DB_SQLITE_PACKAGE ||
      (defaultTrail && packageName === '@package-broker/plugin-audit-trail')
    )
      return resolveFromCli(packageName);
    try {
      return resolveFromConfig(packageName);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      const owners = plugins
        .filter((plugin) => plugin.package === packageName)
        .map((plugin) => `plugin "${plugin.id}": `)
        .join('');
      throw new BuildDiagnosticsError([
        `${owners}package "${packageName}" could not be resolved from the config location`,
      ]);
    }
  };
  const versions = new Map<string, string>();
  for (const plugin of plugins) {
    versions.set(plugin.package, await readPackageVersion(resolvePackageDir(plugin.package)));
  }
  const coreVersion = await readPackageVersion(resolveFromCli('@package-broker/core'));
  const runtime = target === 'cloudflare' ? 'runtime-cloudflare' : 'runtime-node';
  const runtimeMetadata =
    options.runtimeEntry === undefined
      ? JSON.parse(
          await readFile(
            path.join(resolveFromCli(`@package-broker/${runtime}`), 'package.json'),
            'utf8',
          ),
        )
      : undefined;
  const sources = await collectMigrations(plugins, resolvePackageDir);
  let assets;
  try {
    assets = await prepareAssets({ config, configPath, target });
  } catch (error) {
    if (error instanceof AssetProblemsError) throw new BuildDiagnosticsError(error.problems);
    throw error;
  }

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

  const manifestTs = path.join(generated, 'manifest.ts');
  const manifestJson = path.join(generated, 'manifest.json');
  const audit = describeAudit(config, target);
  await writeFile(
    manifestTs,
    renderBuildManifest(
      `./${path.relative(generated, configPath)}`,
      plugins.map((plugin) => plugin.id),
      target === 'node' ? sources : sources.map(({ id, checksum }) => ({ id, checksum })),
      process.platform,
      platformPorts,
      {
        buildGeneration: audit.build_generation,
        ...(defaultTrail ? { defaultTrailImport: '@package-broker/plugin-audit-trail' } : {}),
      },
    ),
  );
  await writeFile(
    manifestJson,
    `${JSON.stringify(
      {
        ...renderManifestJson(plugins, versions, target, {
          migrations: toManifestMigrations(sources),
          registration,
          runtimeMetadata,
        }),
        platformPorts,
        audit,
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
      core: coreVersion,
      plugins: Object.fromEntries(versions),
      lockfileSha256,
      gitSha,
      dirty,
    }),
  );

  const entry =
    options.runtimeEntry ??
    createRequire(import.meta.url).resolve(`@package-broker/${runtime}/entry`);
  const bundle = path.join(outDir, target === 'cloudflare' ? 'worker.js' : 'server.js');
  const manifestRealPath = await realpath(manifestTs);
  const result = await esbuild({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: target === 'cloudflare' ? 'neutral' : 'node',
    conditions: target === 'cloudflare' ? ['workerd', 'worker', 'browser'] : [],
    dropLabels: process.env['PB_E2E_AUDIT_FIXTURE'] === '1' ? [] : ['PB_AUDIT_FIXTURE'],
    define: {
      'import.meta.pbAuditFixture': process.env['PB_E2E_AUDIT_FIXTURE'] === '1' ? 'true' : 'false',
    },
    external:
      target === 'cloudflare'
        ? ['cloudflare:*', 'node:async_hooks', 'node:buffer', 'node:zlib']
        : ['better-sqlite3'],
    alias: { '#pb-manifest': manifestTs },
    plugins: [
      {
        name: 'cli-audit-dependencies',
        async setup(pluginBuild) {
          const resolving = {};
          const roots = await Promise.all(
            ['@package-broker/core', '@package-broker/plugin-audit-trail'].map(async (name) => {
              const dir = resolveFromCli(name);
              const metadata = JSON.parse(
                await readFile(path.join(dir, 'package.json'), 'utf8'),
              ) as { sideEffects?: unknown };
              return { name, dir, sideEffects: metadata.sideEffects === false ? false : undefined };
            }),
          );
          const packageModule = (file: string) => {
            for (const root of roots) {
              const relative = path.relative(root.dir, file);
              if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
              return {
                path: file,
                ...(root.sideEffects === false ? { sideEffects: false } : {}),
              };
            }
            return undefined;
          };
          pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
            if (args.pluginData === resolving) return undefined;
            if (args.path.startsWith('.') || path.isAbsolute(args.path)) {
              const file = path.resolve(args.resolveDir, args.path);
              if (/\.[cm]?[jt]s$/.test(file)) return packageModule(file);
            }
            if (!/^@package-broker\/(?:core|plugin-audit-trail)(?:\/|$)/.test(args.path))
              return undefined;
            const resolved =
              args.path === '@package-broker/plugin-audit-trail' &&
              (args.importer === manifestTs || args.importer === manifestRealPath) &&
              defaultTrail
                ? {
                    path: createRequire(import.meta.url).resolve(args.path),
                    external: false,
                    errors: [],
                  }
                : await pluginBuild.resolve(args.path, {
                    kind: args.kind,
                    resolveDir: args.resolveDir,
                    pluginData: resolving,
                  });
            if (resolved.errors.length > 0 || resolved.external) return resolved;
            return packageModule(resolved.path) ?? resolved;
          });
        },
      },
    ],
    nodePaths: [path.join(cwd, 'node_modules')],
    absWorkingDir: cwd,
    sourcemap: true,
    metafile: true,
    logLevel: 'silent',
  });
  await writeFile(path.join(outDir, 'metafile.json'), JSON.stringify(result.metafile));
  try {
    await stageAssets(outDir, assets);
  } catch (error) {
    if (error instanceof AssetProblemsError) throw new BuildDiagnosticsError(error.problems);
    throw error;
  }

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
