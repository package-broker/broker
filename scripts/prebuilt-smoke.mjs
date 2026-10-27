import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertDiscovered,
  assertProviderListing,
  assertStartRedirect,
  digestFiles,
  runtimeProviderSettings,
  startMockIssuer,
} from '../packages/runtime-cloudflare/scripts/mock-oidc-issuer.mjs';
import { listFiles, payloadFiles } from './stage-prebuilt.mjs';

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

export async function copyMetafile(root, target, outDir) {
  const built = join(root, '.pb', target);
  const nonAsset = (name) => !name.startsWith('assets/');
  try {
    const sourceFiles = payloadFiles(built).filter(nonAsset);
    // Materialization replaces the staging-only Wrangler template with its provenance record.
    const installedFiles = listFiles(outDir).filter(
      (name) => nonAsset(name) && !(target === 'cloudflare' && name === 'prebuilt.json'),
    );
    if (JSON.stringify(sourceFiles) !== JSON.stringify(installedFiles)) throw new Error();
    for (const name of sourceFiles) {
      if (!(await readFile(join(built, name))).equals(await readFile(join(outDir, name))))
        throw new Error();
    }
    // Metafiles are build diagnostics and are deliberately omitted from dist packages.
    await copyFile(join(built, 'metafile.json'), join(outDir, 'metafile.json'));
  } catch {
    throw new Error(
      'Smoke metafile needs matching payloads; re-run pnpm bundle && pnpm stage:prebuilt',
    );
  }
}

export const NODE_SSO_STAGES = Object.freeze([
  Object.freeze({ id: 'mock', path: '/tenant-a', absent: Object.freeze([]) }),
  Object.freeze({ id: 'mock2', path: '/tenant-b', absent: Object.freeze(['mock']) }),
]);

export function bundleFileNames(directory) {
  return listFiles(directory).filter((name) => !name.startsWith('assets/'));
}

const SMOKE_MASTER_KEY = `pbmk_v1_${randomBytes(32).toString('base64url')}`;

export function serverEnv(base, { port, dataDir, settings }) {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (name.startsWith('PB_') || name === 'NODE_PATH') delete env[name];
  }
  return {
    ...env,
    PORT: String(port),
    PB_SQLITE_PATH: join(dataDir, 'db.sqlite'),
    PB_ORG_SLUG: 'smoke',
    PB_ORG_NAME: 'Smoke',
    PB_MASTER_KEY: SMOKE_MASTER_KEY,
    PB_PUBLIC_URL: `http://127.0.0.1:${port}`,
    PB_BLOB_ROOT: join(dataDir, 'blobs'),
    DEPLOYMENT_ID: 'smoke',
    ...settings,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(nodeDir, env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: nodeDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const base = env.PB_PUBLIC_URL;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr.slice(-2000)}`);
    const response = await fetch(`${base}/health/ready`, {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    if (response?.status === 200) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server was not ready within 15000ms');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    base,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

export async function checkSsoStage(base, issuer, { id, path, absent }, request = fetch) {
  const listed = await request(`${base}/_pb/auth/providers`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (listed.status !== 200) throw new Error(`GET /_pb/auth/providers answered ${listed.status}`);
  const ids = assertProviderListing(await listed.json(), { present: [id], absent });
  const started = await request(`${base}/_pb/auth/sso/${id}/start`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ purpose: 'login' }),
    signal: AbortSignal.timeout(5_000),
  });
  assertStartRedirect(
    { status: started.status, location: started.headers.get('location') },
    {
      authorizationEndpoint: issuer.authorizationEndpoint(path),
      callbackUrl: `${base}/_pb/auth/sso/${id}/callback`,
    },
  );
  assertDiscovered(issuer.requests, path);
  for (const gone of absent) {
    const refused = await request(`${base}/_pb/auth/sso/${gone}/start`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ purpose: 'login' }),
      signal: AbortSignal.timeout(5_000),
    });
    if (refused.status !== 404)
      throw new Error(`SSO start for removed provider ${gone} answered ${refused.status}`);
  }
  return ids;
}

export async function runNodeRuntimeSso({ nodeDir, dataDir, log = console.log }) {
  await mkdir(dataDir, { recursive: true });
  const names = bundleFileNames(nodeDir);
  const before = await digestFiles(nodeDir, names);
  log(`smoke:prebuilt runtime SSO Node bundle sha256 before=${before.combined}`);
  for (const [name, digest] of Object.entries(before.files))
    if (name.endsWith('.js')) log(`smoke:prebuilt runtime SSO Node   ${name} ${digest}`);
  const issuer = await startMockIssuer();
  try {
    for (const stage of NODE_SSO_STAGES) {
      const port = await freePort();
      const settings = runtimeProviderSettings(stage.id, issuer.issuer(stage.path));
      const server = await startServer(
        nodeDir,
        serverEnv(process.env, { port, dataDir, settings }),
      );
      const ids = await checkSsoStage(server.base, issuer, stage).catch(async (error) => {
        await server.stop();
        throw error;
      });
      const code = await server.stop();
      if (code !== 0) throw new Error(`server exited with ${code} after the ${stage.id} stage`);
      log(
        `smoke:prebuilt runtime SSO Node PB_IDP_PROVIDERS=${stage.id}: providers [${ids.join(', ')}], start 303 to ${issuer.authorizationEndpoint(stage.path).replace(issuer.origin, '<mock>')}${stage.absent.map((gone) => `, ${gone} start 404`).join('')}`,
      );
    }
  } finally {
    await issuer.close();
  }
  const after = await digestFiles(nodeDir, bundleFileNames(nodeDir));
  log(`smoke:prebuilt runtime SSO Node bundle sha256 after=${after.combined}`);
  if (JSON.stringify(after) !== JSON.stringify(before))
    throw new Error('Installed Node bundle changed between provider sets');
  return { before, after };
}

export async function runPrebuiltSmoke({ root = ROOT, run = checked, materialize } = {}) {
  const expected = await loadExpectedRecord(join(root, 'packages/cli/dist/prebuilt-expected.json'));
  await mkdir(join(root, '.pb'), { recursive: true });
  const temporary = await mkdtemp(join(root, '.pb', 'prebuilt-smoke-'));
  try {
    const tarballs = [];
    for (const pkg of ['prebuilt', 'prebuilt-cloudflare']) {
      const destination = join(temporary, pkg);
      await mkdir(destination);
      run(
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
    run(
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
    materialize ??= (await import('../packages/cli/dist/prebuilt.js')).materializePrebuilt;
    console.log('smoke:prebuilt materializing installed Worker');
    const materialized = await materialize({ project, resolve, expected });
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
    await copyMetafile(root, 'node', nodeDir);
    await copyMetafile(root, 'cloudflare', materialized.outDir);

    const smokeEnv = {
      ...installEnv,
      npm_config_offline: 'true',
      SMOKE_PREBUILT: '1',
    };
    console.log('smoke:prebuilt Node leg');
    run(
      process.execPath,
      [join(root, 'scripts/node-bundle-smoke.mjs')],
      {
        cwd: root,
        stdio: 'inherit',
        env: { ...smokeEnv, SMOKE_NODE_DIR: nodeDir },
      },
      'smoke:prebuilt Node leg',
    );
    console.log('smoke:prebuilt Node runtime SSO stage');
    run(
      process.execPath,
      [join(root, 'scripts/prebuilt-smoke.mjs'), '--node-runtime-sso'],
      {
        cwd: root,
        stdio: 'inherit',
        env: { ...smokeEnv, SMOKE_NODE_DIR: nodeDir, SMOKE_SSO_DATA: join(temporary, 'sso-data') },
      },
      'smoke:prebuilt Node runtime SSO stage',
    );
    console.log('smoke:prebuilt Worker leg');
    run(
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
    console.log(
      'smoke:prebuilt ok (installed Node: server.js in place with hoisted dependencies, readiness, OpenAPI, auth, UI, blobs, audit jobs, shutdown, runtime SSO providers across a restart with unchanged bundle bytes; materialized installed Worker: readiness/liveness, OpenAPI, auth, UI, D1 foreign keys, blobs, audit jobs/queue, runtime SSO providers across two versions of the same bundle; installed bundles: vitest scan with payload-matched local metafiles; repository helpers: cache adapter checks)',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv.includes('--node-runtime-sso')
) {
  runNodeRuntimeSso({
    nodeDir: process.env.SMOKE_NODE_DIR,
    dataDir: process.env.SMOKE_SSO_DATA,
  }).catch((error) => {
    console.error(`smoke:prebuilt runtime SSO ${error.message}`);
    process.exitCode = 1;
  });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPrebuiltSmoke().catch((error) => {
    console.error(
      error.message === INSTALL_NOT_RUN ? INSTALL_NOT_RUN : `smoke:prebuilt ${error.message}`,
    );
    process.exitCode = error.exitCode || 1;
  });
}
