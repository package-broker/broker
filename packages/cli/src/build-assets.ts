import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrokerConfig } from '@package-broker/core';
import {
  assetProviderProblems,
  assetProviderResultProblems,
  brokerAssetsProblems,
  type AssetProviderV1,
} from '@package-broker/core/config';
import { parseUiManifest } from '@package-broker/core/platform/ui-manifest';
import type { Platform } from '@package-broker/core/plugin';

const ASSET_DIR = 'assets';
const RECORD_FILE = 'assets.json';
const MANIFEST_FILE = 'manifest.json';

interface AssetRecord {
  readonly schemaVersion: 1;
  readonly provider: { readonly specifier: string; readonly version: string };
  readonly digest: string;
  readonly descriptor: {
    readonly directory: './assets';
    readonly binding: 'ASSETS';
    readonly run_worker_first: true;
    readonly html_handling: 'none';
    readonly not_found_handling: 'none';
  };
}

export interface PreparedAssets {
  readonly record: AssetRecord;
  readonly files: readonly { readonly name: string; readonly content: Buffer }[];
}

export class AssetProblemsError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'AssetProblemsError';
    this.problems = problems;
  }
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function readProviderVersion(resolvedModule: string): Promise<string | null> {
  for (let dir = path.dirname(resolvedModule); ; dir = path.dirname(dir)) {
    let text: string;
    try {
      text = await readFile(path.join(dir, 'package.json'), 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      if (path.dirname(dir) === dir) return null;
      continue;
    }
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  }
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function loadProvider(
  specifier: string,
  configDir: string,
): Promise<{ provider: AssetProviderV1; resolvedModule: string }> {
  let resolvedModule: string;
  try {
    resolvedModule = createRequire(path.join(configDir, 'package.json')).resolve(specifier);
  } catch {
    throw new AssetProblemsError([
      `assets: provider "${specifier}" could not be resolved from the config location`,
    ]);
  }
  let exported: unknown;
  try {
    exported = ((await import(pathToFileURL(resolvedModule).href)) as { default?: unknown })
      .default;
  } catch {
    throw new AssetProblemsError([`assets: provider "${specifier}" failed to load`]);
  }
  const problems = assetProviderProblems(exported);
  if (problems.length > 0) throw new AssetProblemsError(problems);
  return { provider: exported as AssetProviderV1, resolvedModule };
}

async function readListedFiles(
  manifestFile: string,
  names: readonly string[],
  bytes: (name: string) => number,
): Promise<{ name: string; content: Buffer }[]> {
  const root = await realpath(path.dirname(manifestFile));
  const problems: string[] = [];
  const files: { name: string; content: Buffer }[] = [];
  for (const name of names) {
    const label = `assets: listed file "${name}"`;
    let real: string;
    try {
      real = await realpath(path.join(root, name));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      problems.push(`${label} is missing`);
      continue;
    }
    if (!isContained(root, real)) {
      problems.push(`${label} escapes the asset directory`);
      continue;
    }
    if (!(await stat(real)).isFile()) {
      problems.push(`${label} is not a regular file`);
      continue;
    }
    const content = await readFile(real);
    if (content.length !== bytes(name)) {
      problems.push(`${label} has ${content.length} bytes, manifest lists ${bytes(name)}`);
      continue;
    }
    files.push({ name, content });
  }
  if (problems.length > 0) throw new AssetProblemsError(problems);
  return files;
}

export async function prepareAssets(options: {
  config: BrokerConfig;
  configPath: string;
  target: Platform;
}): Promise<PreparedAssets | null> {
  const problems = brokerAssetsProblems(options.config);
  if (problems.length > 0) throw new AssetProblemsError(problems);
  const selection = options.config.assets?.[0];
  if (selection === undefined) return null;

  const { provider, resolvedModule } = await loadProvider(
    selection.provider,
    path.dirname(options.configPath),
  );
  let result: unknown;
  try {
    result = await provider.resolve({ target: options.target });
  } catch (error) {
    throw new AssetProblemsError([
      `assets: provider resolve failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    ]);
  }
  const resultProblems = assetProviderResultProblems(result);
  if (resultProblems.length > 0) throw new AssetProblemsError(resultProblems);

  const manifestFile = fileURLToPath((result as { manifestUrl: string }).manifestUrl);
  let manifestBytes: Buffer;
  try {
    const realManifest = await realpath(manifestFile);
    if (!(await stat(realManifest)).isFile()) throw Object.assign(new Error(), { code: 'EISDIR' });
    manifestBytes = await readFile(realManifest);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'EISDIR') throw error;
    throw new AssetProblemsError(['assets: provider manifest could not be read']);
  }
  let manifest: ReturnType<typeof parseUiManifest>;
  try {
    manifest = parseUiManifest(manifestBytes.toString('utf8'));
  } catch (error) {
    throw new AssetProblemsError([
      `assets: ${error instanceof Error ? error.message : 'invalid UI manifest'}`,
    ]);
  }
  const names = Object.keys(manifest.files).sort();
  if (names.includes(MANIFEST_FILE)) {
    throw new AssetProblemsError([`assets: manifest must not list ${MANIFEST_FILE}`]);
  }
  const listed = await readListedFiles(manifestFile, names, (name) => manifest.files[name]!.bytes);

  const version = await readProviderVersion(resolvedModule);
  if (version === null) {
    throw new AssetProblemsError([
      `assets: provider "${selection.provider}" has no package version`,
    ]);
  }
  const files = [{ name: MANIFEST_FILE, content: manifestBytes }, ...listed];
  const digest = sha256(JSON.stringify(files.map((file) => [file.name, sha256(file.content)])));
  return {
    record: {
      schemaVersion: 1,
      provider: { specifier: selection.provider, version },
      digest: `sha256:${digest}`,
      descriptor: {
        directory: './assets',
        binding: 'ASSETS',
        run_worker_first: true,
        html_handling: 'none',
        not_found_handling: 'none',
      },
    },
    files,
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export async function stageAssets(outDir: string, prepared: PreparedAssets | null): Promise<void> {
  const assetsDir = path.join(outDir, ASSET_DIR);
  const recordFile = path.join(outDir, RECORD_FILE);
  const owned = await exists(recordFile);
  if (prepared === null) {
    if (owned) {
      await rm(assetsDir, { recursive: true, force: true });
      await rm(recordFile, { force: true });
    }
    return;
  }
  if (!owned && (await exists(assetsDir))) {
    throw new AssetProblemsError([
      `assets: output directory "${ASSET_DIR}" exists and is not builder-owned`,
    ]);
  }
  const staging = path.join(outDir, `.${ASSET_DIR}-staging`);
  const pendingRecord = `${recordFile}.tmp`;
  let swapped = false;
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    for (const file of prepared.files) await writeFile(path.join(staging, file.name), file.content);
    await writeFile(pendingRecord, `${JSON.stringify(prepared.record, null, 2)}\n`);
    await rm(assetsDir, { recursive: true, force: true });
    await rename(staging, assetsDir);
    swapped = true;
    await rename(pendingRecord, recordFile);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rm(pendingRecord, { force: true });
    if (swapped && !owned) await rm(assetsDir, { recursive: true, force: true });
    throw error;
  }
}
