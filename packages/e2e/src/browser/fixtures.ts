import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RuntimeName = 'node' | 'workers';

export interface Fixture {
  readonly runtime: RuntimeName;
  readonly origin: string;
  readonly email: string;
  readonly database?: string;
  /** The one-time setup token. Never log it. */
  readonly token: string;
  stop(): Promise<void>;
}

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const ADMIN_EMAIL = 'first.admin@e2e.example.test';

const READY_TIMEOUT_MS = 60_000;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function probeStatus(origin: string): Promise<number> {
  const client = origin.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(
      `${origin}/health/ready`,
      { rejectUnauthorized: false, timeout: 2_000 },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.once('error', reject);
  });
}

async function waitReady(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('the fixture process exited before it was ready');
    try {
      if ((await probeStatus(origin)) === 200) return;
    } catch {
      await delay(200);
    }
    await delay(200);
  }
  throw new Error(`${origin}/health/ready was not 200 within ${READY_TIMEOUT_MS}ms`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function copyInstalledDependencies(
  target: string,
  manifestPath: string,
  seen = new Set<string>(),
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const resolver = createRequire(manifestPath);
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const sourceManifest = resolver.resolve(`${name}/package.json`);
    if (seen.has(sourceManifest)) continue;
    seen.add(sourceManifest);
    const destination = join(target, 'node_modules', name);
    await cp(dirname(sourceManifest), destination, { recursive: true });
    await copyInstalledDependencies(destination, sourceManifest, seen);
  }
}

export async function startNodeFixture(): Promise<Fixture> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'pb-e2e-node-')));
  let child: ChildProcess | undefined;
  try {
    await cp(join(REPO_ROOT, '.pb', 'node'), scratch, { recursive: true });
    const runtimeManifest = join(REPO_ROOT, 'packages', 'runtime-node', 'package.json');
    const driverManifest = createRequire(runtimeManifest).resolve('better-sqlite3/package.json');
    const driverTarget = join(scratch, 'node_modules', 'better-sqlite3');
    await cp(dirname(driverManifest), driverTarget, { recursive: true });
    await copyInstalledDependencies(driverTarget, driverManifest);

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const database = join(scratch, 'data', 'db.sqlite');
    const env: Record<string, string | undefined> = {
      ...process.env,
      PORT: String(port),
      PB_SQLITE_PATH: database,
      PB_ORG_SLUG: 'e2e',
      PB_ORG_NAME: 'E2E',
      PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      PB_PUBLIC_URL: origin,
      PB_BLOB_ROOT: join(scratch, 'data', 'blobs'),
      DEPLOYMENT_ID: 'e2e',
    };
    delete env['NODE_PATH'];
    delete env['PB_MASTER_KEY_FILE'];
    child = spawn(process.execPath, ['server.js'], {
      cwd: scratch,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await waitReady(origin, child);

    const tokenFile = join(scratch, 'setup-token');
    const issued = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js'),
        'admin',
        'bootstrap',
        '--email',
        ADMIN_EMAIL,
        '--sqlite',
        database,
        '--token-file',
        tokenFile,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] },
    );
    if (issued.status !== 0) throw new Error(`pb admin bootstrap exited with ${issued.status}`);
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const started = child;
    return {
      runtime: 'node',
      database,
      origin,
      email: ADMIN_EMAIL,
      token,
      async stop() {
        await stopChild(started);
        await rm(scratch, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child !== undefined) await stopChild(child);
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

export async function startWorkersFixture(): Promise<Fixture> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixture-workers.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        PB_E2E_REPO_ROOT: REPO_ROOT,
        PB_E2E_PORT: String(port),
        PB_E2E_EMAIL: ADMIN_EMAIL,
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  try {
    const ready = await new Promise<{ origin: string; token: string }>((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => {
        reject(new Error(`the Workers fixture was not ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);
      child.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const line = buffered.split('\n').find((entry) => entry.startsWith('PB_E2E_READY '));
        if (line === undefined) return;
        clearTimeout(timer);
        resolve(
          JSON.parse(line.slice('PB_E2E_READY '.length)) as { origin: string; token: string },
        );
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the Workers fixture exited with ${code} before it was ready`));
      });
    });
    await waitReady(ready.origin, child);
    return {
      runtime: 'workers',
      origin: ready.origin,
      email: ADMIN_EMAIL,
      token: ready.token,
      async stop() {
        await stopChild(child);
      },
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

export function startFixture(runtime: RuntimeName): Promise<Fixture> {
  return runtime === 'node' ? startNodeFixture() : startWorkersFixture();
}
