#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, rename, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(REPO_ROOT, '.pb', 'node');
const READY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;
const REQUEST_TIMEOUT_MS = 2_000;
const EXIT_TIMEOUT_MS = 5_000;
const DEFAULT_DEADLINE_MS = 60_000;
const BREAK = process.argv.includes('--break');

function positiveInteger(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function delay(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`the server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? (signal === null ? 0 : 1));
    });
  });
}

async function request(url, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = await response.text().catch(() => '<unreadable body>');
  if (response.status !== expected) {
    throw new Error(`${url}: expected ${expected}, got ${response.status}: ${body}`);
  }
  return body;
}

let step = 'startup';
let copy;
let child;
let childStderr = '';
let deadlineTimer;

function spawnFailure(server) {
  let fail;
  const failure = new Promise((_, reject) => {
    fail = reject;
  });
  server.once('error', (error) => {
    fail(new Error(`failed to spawn the server: ${error.message}`));
  });
  server.once('exit', (code, signal) => {
    fail(
      new Error(
        `the server exited with ${code === null ? `signal ${signal}` : `code ${code}`} before becoming ready`,
      ),
    );
  });
  failure.catch(() => {});
  return failure;
}

async function waitReady(base) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await request(`${base}/health/ready`, 200);
      return;
    } catch {
      await delay(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`/health/ready was not 200 within ${READY_TIMEOUT_MS}ms`);
}

async function stopChild() {
  if (child === undefined || child.exitCode !== null || child.pid === undefined) return;
  child.kill('SIGKILL');
  await waitExit(child, 2_000).catch(() => {});
}

async function run() {
  step = 'copying the bundle';
  copy = await mkdtemp(join(tmpdir(), 'pb-node-smoke-'));
  await cp(join(SOURCE, '.'), copy, { recursive: true });
  console.log(`smoke:node copied ${SOURCE} to ${copy}`);

  step = 'installing production dependencies';
  const install = spawnSync(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
    { cwd: copy, encoding: 'utf8' },
  );
  if (install.status !== 0) {
    throw new Error(
      `npm install exited with ${install.status}: ${install.error?.message ?? (install.stderr || install.stdout)}`,
    );
  }
  console.log('smoke:node installed production dependencies');

  if (BREAK) {
    step = 'breaking the driver resolution';
    await rename(
      join(copy, 'node_modules', 'better-sqlite3'),
      join(copy, 'node_modules', 'better-sqlite3.disabled'),
    );
    console.log('smoke:node --break: hid node_modules/better-sqlite3 from the copy');
  }

  step = 'starting the server';
  const port = await freePort();
  const nodeBin = process.env['SMOKE_NODE_BIN'] ?? process.execPath;
  const env = {
    ...process.env,
    PORT: String(port),
    PB_SQLITE_PATH: join(copy, 'data', 'db.sqlite'),
    PB_ORG_SLUG: 'smoke',
    PB_ORG_NAME: 'Smoke',
    PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    PB_PUBLIC_URL: 'http://127.0.0.1',
  };
  delete env['NODE_PATH'];
  delete env['PB_MASTER_KEY_FILE'];
  for (const name of Object.keys(env)) {
    if (name.startsWith('PB_MASTER_KEY_PREVIOUS')) delete env[name];
  }
  child = spawn(nodeBin, ['server.js'], {
    cwd: copy,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const failure = spawnFailure(child);
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    childStderr += chunk;
  });
  console.log(`smoke:node started ${nodeBin} server.js on port ${port}`);

  step = 'waiting for /health/ready';
  const base = `http://127.0.0.1:${port}`;
  await Promise.race([waitReady(base), failure]);
  console.log('smoke:node GET /health/ready 200');

  step = 'checking the not-found envelope';
  const envelope = JSON.parse(await request(`${base}/nope`, 404));
  if (envelope?.error?.code !== 'not_found') {
    throw new Error(`/nope: expected error.code "not_found", got ${JSON.stringify(envelope)}`);
  }
  console.log('smoke:node GET /nope 404 error.code=not_found');

  step = 'shutting down';
  child.kill('SIGTERM');
  const code = await waitExit(child, EXIT_TIMEOUT_MS);
  if (code !== 0) throw new Error(`the server exited with code ${code} after SIGTERM, expected 0`);
  console.log('smoke:node SIGTERM exit code 0');

  console.log('smoke:node ok');
}

try {
  const deadlineMs = positiveInteger(
    'SMOKE_DEADLINE_MS',
    process.env['SMOKE_DEADLINE_MS'],
    DEFAULT_DEADLINE_MS,
  );
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(new Error(`the smoke exceeded the ${deadlineMs}ms deadline while ${step}`));
    }, deadlineMs);
  });
  deadline.catch(() => {});
  await Promise.race([run(), deadline]);
} catch (error) {
  console.error(
    `smoke:node FAILED while ${step}: ${error instanceof Error ? error.message : error}`,
  );
  if (childStderr.trim() !== '') console.error(`smoke:node server stderr:\n${childStderr.trim()}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadlineTimer);
  await stopChild();
  if (copy !== undefined) {
    await rm(copy, { recursive: true, force: true }).catch(() => {});
  }
}
