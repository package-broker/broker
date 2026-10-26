import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const INSTALL_NOT_RUN = 'NOT RUN: npm install needs the registry for better-sqlite3';

export function discoverTarball(names) {
  const tarballs = names.filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error('Expected exactly one packed tarball');
  return tarballs[0];
}

export function parseExpectedRecord(text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error('Invalid prebuilt expected record');
  }
  const keys = ['schemaVersion', 'package', 'version', 'artifactSha256', 'prebuiltJsonSha256'];
  if (
    !record ||
    Array.isArray(record) ||
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    record.schemaVersion !== 1 ||
    record.package !== '@package-broker/dist-cloudflare' ||
    typeof record.version !== 'string' ||
    !record.version ||
    typeof record.artifactSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.artifactSha256) ||
    typeof record.prebuiltJsonSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.prebuiltJsonSha256)
  )
    throw new Error('Invalid prebuilt expected record');
  return record;
}

export async function loadExpectedRecord(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      'Missing prebuilt expected record; run pnpm stage:prebuilt --write-cli-expected',
    );
  }
  return parseExpectedRecord(text);
}

export function installNeedsNetwork(result) {
  if (result.status === 0) return false;
  const output = `${result.error?.code ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ENOTCACHED)\b/i.test(
    output,
  );
}

function checked(program, args, options, label) {
  const result = spawnSync(program, args, options);
  if (result.status !== 0) {
    const message =
      label === 'npm install' && installNeedsNetwork(result) ? INSTALL_NOT_RUN : `${label} failed`;
    throw Object.assign(new Error(message), { exitCode: result.status || 1 });
  }
}

async function copyMetafile(root, target, outDir, entry) {
  const built = join(root, '.pb', target);
  if (!(await readFile(join(built, entry))).equals(await readFile(join(outDir, entry))))
    throw new Error('Smoke metafile needs the matching local bundle');
  // Metafiles are build diagnostics and are deliberately omitted from dist packages.
  await copyFile(join(built, 'metafile.json'), join(outDir, 'metafile.json'));
}

export async function runPrebuiltSmoke({ root = ROOT } = {}) {
  const expected = await loadExpectedRecord(join(root, 'packages/cli/dist/prebuilt-expected.json'));
  await mkdir(join(root, '.pb'), { recursive: true });
  const temporary = await mkdtemp(join(root, '.pb', 'prebuilt-smoke-'));
  try {
    const tarballs = [];
    for (const pkg of ['prebuilt', 'prebuilt-cloudflare']) {
      const destination = join(temporary, pkg);
      await mkdir(destination);
      checked(
        'pnpm',
        ['pack', '--pack-destination', destination],
        {
          cwd: join(root, 'packages', pkg),
          encoding: 'utf8',
        },
        `pnpm pack ${pkg}`,
      );
      const entries = await readdir(destination, { withFileTypes: true });
      tarballs.push(
        join(
          destination,
          discoverTarball(entries.filter((entry) => entry.isFile()).map((entry) => entry.name)),
        ),
      );
    }
    const project = join(temporary, 'project');
    await mkdir(project);
    const manifest = join(project, 'package.json');
    await writeFile(manifest, JSON.stringify({ private: true, type: 'module' }));
    const installEnv = { ...process.env, npm_config_cache: join(temporary, 'npm-cache') };
    console.log('smoke:prebuilt installing local dist tarballs');
    checked(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org',
        '--fetch-retries=0',
        '--fetch-timeout=20000',
        ...tarballs,
      ],
      { cwd: project, env: installEnv, encoding: 'utf8' },
      'npm install',
    );

    const resolve = createRequire(manifest).resolve;
    const { materializePrebuilt } = await import('../packages/cli/dist/prebuilt.js');
    console.log('smoke:prebuilt materializing installed Worker');
    const materialized = await materializePrebuilt({ project, resolve, expected });
    const record = JSON.parse(
      await readFile(resolve('@package-broker/dist-cloudflare/prebuilt.json'), 'utf8'),
    );
    console.log(`smoke:prebuilt artifactSha256=${materialized.artifactSha256}`);
    if (materialized.artifactSha256 !== record.artifactSha256)
      throw Object.assign(new Error('Materialized artifact digest differs from prebuilt.json'), {
        exitCode: 3,
      });

    const nodePackage = dirname(resolve('@package-broker/dist/package.json'));
    const nodeDir = join(nodePackage, 'node');
    const { dependencies } = JSON.parse(await readFile(join(nodePackage, 'package.json'), 'utf8'));
    await writeFile(
      join(nodeDir, 'package.json'),
      JSON.stringify({ private: true, type: 'module', dependencies }),
    );
    // The Node smoke copies its runtime before starting it, so carry the installed driver with it.
    const modules = join(project, 'node_modules');
    for (const name of await readdir(modules)) {
      if (name !== '@package-broker')
        await cp(join(modules, name), join(nodeDir, 'node_modules', name), { recursive: true });
    }
    await copyMetafile(root, 'node', nodeDir, 'server.js');
    await copyMetafile(root, 'cloudflare', materialized.outDir, 'worker.js');

    const smokeEnv = { ...installEnv, npm_config_offline: 'true', SMOKE_OFFLINE: '0' };
    console.log('smoke:prebuilt Node leg');
    checked(
      process.execPath,
      [join(root, 'scripts/node-bundle-smoke.mjs')],
      {
        cwd: root,
        stdio: 'inherit',
        env: { ...smokeEnv, SMOKE_NODE_DIR: nodeDir },
      },
      'smoke:prebuilt Node leg',
    );
    console.log('smoke:prebuilt Worker leg');
    checked(
      process.execPath,
      [join(root, 'packages/runtime-cloudflare/scripts/worker-smoke.mjs')],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...smokeEnv,
          SMOKE_WORKER_SCRIPT: join(materialized.outDir, 'worker.js'),
          SMOKE_WORKER_DIR: materialized.outDir,
        },
      },
      'smoke:prebuilt Worker leg',
    );
    console.log('smoke:prebuilt ok (Node and Worker)');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPrebuiltSmoke().catch((error) => {
    console.error(
      error.message === INSTALL_NOT_RUN ? INSTALL_NOT_RUN : `smoke:prebuilt ${error.message}`,
    );
    process.exitCode = error.exitCode || 1;
  });
}
