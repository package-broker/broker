import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TARGETS = { node: 'prebuilt', cloudflare: 'prebuilt-cloudflare' };

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function listFiles(root) {
  const result = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Payload symlinks are forbidden');
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) result.push(relative(root, path).split('\\').join('/'));
      else throw new Error('Payload must contain regular files');
    }
  }
  walk(root);
  return result.sort();
}

export function payloadFiles(root) {
  return listFiles(root).filter(
    (name) =>
      !name.endsWith('.map') &&
      !['metafile.json', 'package.json', 'generated/manifest.ts'].includes(name),
  );
}

export function payloadDigests(root) {
  return Object.fromEntries(
    payloadFiles(root).map((name) => [name, `sha256:${sha256(readFileSync(join(root, name)))}`]),
  );
}

export function differingPaths(left, right) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((name) => left[name] !== right[name])
    .sort();
}

export function currentCommit() {
  return (
    process.env.GITHUB_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  );
}

export function deriveWrangler(template) {
  let result = template.replace(/\r\n/g, '\n');
  for (const [pattern, replacement] of [
    [/^main\s*=.*$/m, 'main = "worker.js"'],
    [/^# \[assets\]$/m, '[assets]'],
    [/^# directory = .*$/m, 'directory = "./assets"'],
  ]) {
    if (!pattern.test(result)) throw new Error('Wrangler template replacement did not match');
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function checkConsistency(node, cloudflare) {
  const migrations = (root) =>
    Object.fromEntries(
      Object.entries(payloadDigests(root)).filter(([name]) => name.startsWith('migrations/')),
    );
  const stale = () => {
    throw new Error('stale build: run pnpm bundle');
  };
  if (!Object.keys(migrations(node)).length || !Object.keys(migrations(cloudflare)).length) stale();
  const differences = differingPaths(migrations(node), migrations(cloudflare));
  if (differences.length) throw new Error(`Migration bytes differ: ${differences.join(', ')}`);
  const assets = [node, cloudflare].map((root) => json(join(root, 'assets.json')).digest);
  if (assets.some((digest) => typeof digest !== 'string' || !digest.trim())) stale();
  if (assets[0] !== assets[1]) throw new Error('Asset digests differ');
  const infos = [node, cloudflare].map((root) => json(join(root, 'build-info.json')));
  for (const info of infos) {
    if (info.dirty !== false)
      throw new Error('Build dirty must be false (true, null and missing are refused)');
    if (typeof info.gitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(info.gitSha))
      throw new Error('Build gitSha must be 40 hex characters');
    if (typeof info.lockfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(info.lockfileSha256))
      throw new Error('Build lockfileSha256 must be 64 hex characters');
  }
  if (infos[0].lockfileSha256 !== infos[1].lockfileSha256)
    throw new Error('Build lockfileSha256 values differ');
  const gitSha = currentCommit();
  if (infos.some((info) => info.gitSha !== gitSha)) stale();
  const plugins = (info) =>
    JSON.stringify(Object.entries(info.plugins ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  if (plugins(infos[0]) !== plugins(infos[1])) stale();
  return infos;
}

export function checkReproducible(
  root,
  builder = () => execFileSync('pnpm', ['bundle'], { cwd: root, stdio: 'inherit' }),
) {
  const snapshot = () =>
    Object.fromEntries(
      Object.keys(TARGETS).flatMap((target) =>
        Object.entries(payloadDigests(join(root, '.pb', target))).map(([name, digest]) => [
          `${target}/${name}`,
          digest,
        ]),
      ),
    );
  const before = snapshot();
  for (const target of Object.keys(TARGETS))
    rmSync(join(root, '.pb', target), { recursive: true, force: true });
  builder();
  const after = snapshot();
  const differences = differingPaths(before, after);
  if (differences.length)
    throw new Error(`Reproducibility digests differ:\n${differences.join('\n')}`);
  return { before, after };
}

async function preparePrebuilt({
  root = ROOT,
  reproducible = false,
  writeCliExpected = false,
  builder,
  validateArtifact,
  esbuildVersion,
} = {}) {
  const source = (target) => join(root, '.pb', target);
  checkConsistency(source('node'), source('cloudflare'));
  let reproduction;
  if (reproducible) {
    reproduction = checkReproducible(root, builder);
    checkConsistency(source('node'), source('cloudflare'));
  }
  const cli = join(root, 'packages/cli');
  validateArtifact ??= (await import(pathToFileURL(join(cli, 'dist/index.js')).href))
    .validateDeploymentArtifact;
  esbuildVersion ??= createRequire(join(cli, 'package.json'))('esbuild/package.json').version;
  const toolchain = {
    node: process.version,
    esbuild: esbuildVersion,
    os: process.platform,
    arch: process.arch,
  };
  const records = {};
  const pending = [];
  try {
    for (const [target, pkg] of Object.entries(TARGETS)) {
      const packageRoot = join(root, 'packages', pkg);
      const temporary = mkdtempSync(join(packageRoot, '.stage-'));
      pending.push({ temporary, packageRoot, target });
      const payload = join(temporary, target);
      mkdirSync(payload);
      for (const name of payloadFiles(source(target))) {
        const destination = join(payload, name);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(source(target), name), destination);
      }
      if (target === 'cloudflare') {
        const template = readFileSync(
          join(root, 'packages/runtime-cloudflare/wrangler.toml'),
          'utf8',
        );
        writeFileSync(join(payload, 'wrangler.toml'), deriveWrangler(template));
      }
      const info = json(join(payload, 'build-info.json'));
      const pkgJson = json(join(packageRoot, 'package.json'));
      records[target] = {
        schemaVersion: 1,
        package: pkgJson.name,
        version: pkgJson.version,
        target,
        payload: target,
        gitSha: info.gitSha,
        lockfileSha256: info.lockfileSha256,
        toolchain,
        plugins: info.plugins,
        files: Object.fromEntries(
          listFiles(payload).map((name) => [
            name,
            `sha256:${sha256(readFileSync(join(payload, name)))}`,
          ]),
        ),
        artifactSha256:
          target === 'cloudflare' ? (await validateArtifact(payload)).artifactHash : null,
      };
      if (
        target === 'cloudflare' &&
        (typeof records[target].artifactSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(records[target].artifactSha256))
      )
        throw new Error('artifactSha256 must be a valid digest');
      writeJson(join(temporary, 'prebuilt.json'), records[target]);
    }
    for (const { temporary, packageRoot, target } of pending) {
      renameSync(join(temporary, target), join(packageRoot, target));
      renameSync(join(temporary, 'prebuilt.json'), join(packageRoot, 'prebuilt.json'));
    }
    if (writeCliExpected) {
      const record = records.cloudflare;
      writeJson(join(cli, 'dist/prebuilt-expected.json'), {
        schemaVersion: 1,
        package: record.package,
        version: record.version,
        artifactSha256: record.artifactSha256,
        prebuiltJsonSha256: sha256(
          readFileSync(join(root, 'packages/prebuilt-cloudflare/prebuilt.json')),
        ),
      });
    }
    return { records, reproduction };
  } finally {
    for (const { temporary } of pending) rmSync(temporary, { recursive: true, force: true });
  }
}

export async function stagePrebuilt(options = {}) {
  const root = options.root ?? ROOT;
  const clear = () => {
    for (const [target, pkg] of Object.entries(TARGETS)) {
      for (const name of [target, 'prebuilt.json'])
        rmSync(join(root, 'packages', pkg, name), { recursive: true, force: true });
    }
    rmSync(join(root, 'packages/cli/dist/prebuilt-expected.json'), { force: true });
  };
  clear();
  try {
    return await preparePrebuilt(options);
  } catch (error) {
    clear();
    throw error;
  }
}

function printSizes(root) {
  for (const pkg of Object.values(TARGETS)) {
    const temporary = mkdtempSync(join(root, '.pb/pack-'));
    try {
      execFileSync('pnpm', ['pack', '--pack-destination', temporary], {
        cwd: join(root, 'packages', pkg),
        stdio: 'pipe',
      });
      const tarball = join(
        temporary,
        readdirSync(temporary).find((name) => name.endsWith('.tgz')),
      );
      const extract = join(temporary, 'extract');
      mkdirSync(extract);
      execFileSync('tar', ['-xzf', tarball, '-C', extract]);
      const unpacked = listFiles(extract).reduce(
        (sum, name) => sum + statSync(join(extract, name)).size,
        0,
      );
      console.log(`${pkg}: packed ${statSync(tarball).size} bytes, unpacked ${unpacked} bytes`);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flags = process.argv.slice(2);
    if (flags.some((flag) => !['--check-reproducible', '--write-cli-expected'].includes(flag)))
      throw new Error('Unknown staging option');
    const result = await stagePrebuilt({
      reproducible: flags.includes('--check-reproducible'),
      writeCliExpected: flags.includes('--write-cli-expected'),
    });
    if (result.reproduction) console.log(JSON.stringify(result.reproduction, null, 2));
    console.log(`toolchain: ${JSON.stringify(result.records.cloudflare.toolchain)}`);
    printSizes(ROOT);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
