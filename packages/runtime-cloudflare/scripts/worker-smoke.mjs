import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ulid } from '@package-broker/core/ids';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { planMigrations } from '@package-broker/db-sqlite/migrations/plan';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor } from '@package-broker/runtime-cloudflare/db/d1-executor';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_MS = 60_000;
const DISPOSE_GRACE_MS = 5_000;

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const outDir = join(repoRoot, '.pb', 'cloudflare');
const workerScript =
  process.env.SMOKE_WORKER_SCRIPT === undefined
    ? join(outDir, 'worker.js')
    : resolve(repoRoot, process.env.SMOKE_WORKER_SCRIPT);

function positiveInteger(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function workerdPids() {
  try {
    return execFileSync('pgrep', ['-x', 'workerd'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

let step = 'startup';
let mf;
let disposed = false;
let cleaned = false;
let timedOut = false;
let deadlineTimer;
const baselineWorkerd = new Set(workerdPids());

async function disposeMiniflare() {
  if (mf === undefined || disposed) return;
  disposed = true;
  let timer;
  try {
    await Promise.race([
      mf.dispose().catch(() => undefined),
      new Promise((done) => {
        timer = setTimeout(done, DISPOSE_GRACE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopLeftoverWorkerd() {
  for (const pid of workerdPids()) {
    if (baselineWorkerd.has(pid)) continue;
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // the process already exited
    }
  }
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  await disposeMiniflare();
  await stopLeftoverWorkerd();
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    console.error(`smoke:cloudflare received ${signal} while ${step}; cleaning up`);
    void cleanup().then(() => process.exit(code));
  });
}

async function readMigrations() {
  const manifest = JSON.parse(await readFile(join(outDir, 'generated', 'manifest.json'), 'utf8'));
  const owners = [];
  const sources = [];
  for (const entry of manifest.migrations) {
    const owner = entry.id.slice(0, entry.id.indexOf(':'));
    if (!owners.includes(owner)) owners.push(owner);
    const name = `${entry.name}.sql`;
    const sql = await readFile(join(outDir, 'migrations', owner, name), 'utf8');
    sources.push(await loadMigrationSource(owner, name, sql));
  }
  return planMigrations(sources, owners);
}

async function dispatch(path, limitMs) {
  const url = `http://broker.test${path}`;
  try {
    return await mf.dispatchFetch(url, { signal: AbortSignal.timeout(limitMs) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`${path}: no response within ${limitMs}ms`, { cause: error });
    }
    throw error;
  }
}

async function body(response) {
  return response.text().catch(() => '<unreadable body>');
}

async function expectStatus(label, response, status) {
  if (response.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${response.status}: ${await body(response)}`,
    );
  }
}

async function run() {
  const limitMs = positiveInteger(
    'SMOKE_TIMEOUT_MS',
    process.env.SMOKE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const deadlineMs = positiveInteger(
    'SMOKE_DEADLINE_MS',
    process.env.SMOKE_DEADLINE_MS,
    DEFAULT_DEADLINE_MS,
  );

  deadlineTimer = setTimeout(() => {
    if (cleaned) return;
    timedOut = true;
    console.error(`smoke:cloudflare: ${deadlineMs}ms deadline exceeded while ${step}`);
    void cleanup().then(() => process.exit(1));
  }, deadlineMs);

  try {
    step = 'reading migrations';
    const migrations = await readMigrations();

    step = 'constructing Miniflare';
    mf = new Miniflare(
      convertV4MiniflareOptions({
        rootPath: dirname(workerScript),
        modules: true,
        scriptPath: basename(workerScript),
        compatibilityDate: '2026-10-01',
        d1Databases: ['DB'],
      }),
    );

    step = 'opening the D1 database';
    const executor = createD1Executor(await mf.getD1Database('DB'));

    step = 'applying migrations';
    await migrate(executor, migrations, { holder: 'smoke' });

    step = 'bootstrapping the organization';
    await createOrganizationBootstrap(executor).bootstrap({
      id: ulid(),
      slug: 'smoke',
      name: 'Smoke',
      now: new Date().toISOString(),
    });

    step = 'GET /health/ready';
    await expectStatus('/health/ready', await dispatch('/health/ready', limitMs), 200);

    step = 'GET /health/live';
    await expectStatus('/health/live', await dispatch('/health/live', limitMs), 200);

    step = 'GET /nope';
    const missing = await dispatch('/nope', limitMs);
    await expectStatus('/nope', missing, 404);
    const envelope = await missing.json();
    if (envelope?.error?.code !== 'not_found') {
      throw new Error(`/nope: expected error.code "not_found", got ${JSON.stringify(envelope)}`);
    }

    step = 'done';
    console.log('smoke:cloudflare ok');
  } finally {
    await cleanup();
  }
}

run().catch((error) => {
  if (timedOut) return;
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
