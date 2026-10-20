#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(REPO_ROOT, '.pb', 'node');
const READY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;
const REQUEST_TIMEOUT_MS = 2_000;
const EXIT_TIMEOUT_MS = 5_000;
const DEFAULT_DEADLINE_MS = 60_000;
const BREAK = process.argv.includes('--break');
const CLI = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');
const ADMIN_EMAIL = 'admin@smoke.test';
const ADMIN_PASSWORD = 'smoke horse battery staple 42';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

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

function base32Decode(text) {
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error('the setup secret is not base32');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
}

function post(base, route, body, headers = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    const body = await response.text().catch(() => '<unreadable body>');
    throw new Error(`${label}: expected ${expected}, got ${response.status}: ${body}`);
  }
}

async function mintSession(base, database) {
  const tokenFile = join(copy, 'setup-token');
  const issued = spawnSync(
    process.execPath,
    [
      CLI,
      'admin',
      'bootstrap',
      '--email',
      ADMIN_EMAIL,
      '--sqlite',
      database,
      '--token-file',
      tokenFile,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (issued.status !== 0) {
    throw new Error(`pb admin bootstrap exited with ${issued.status}: ${issued.stderr}`);
  }
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const started = await post(base, '/_pb/auth/local/setup/start', { token });
  await expectStatus(started, 200, 'POST /_pb/auth/local/setup/start');
  const secret = base32Decode((await started.json()).secret);
  const now = Math.floor(Date.now() / 30_000);
  const finished = await post(base, '/_pb/auth/local/setup/finish', {
    token,
    password: ADMIN_PASSWORD,
    code: totpCode(secret, now - 1),
  });
  await expectStatus(finished, 204, 'POST /_pb/auth/local/setup/finish');
  const login = await post(base, '/_pb/auth/local/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    code: totpCode(secret, now),
  });
  await expectStatus(login, 204, 'POST /_pb/auth/local/login');
  return cookieHeader(login);
}

let step = 'startup';
let copy;
let child;
let childStderr = '';
let childStdout = '';
let deadlineTimer;

async function copyInstalledDependencies(target, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const require = createRequire(manifestPath);
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const sourceManifest = require.resolve(`${name}/package.json`);
    const destination = join(target, 'node_modules', name);
    await cp(dirname(sourceManifest), destination, { recursive: true });
    await copyInstalledDependencies(destination, sourceManifest);
  }
}

async function waitForAudit(check, label) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`audit jobs: timed out waiting for ${label}`);
}

function auditLogs() {
  return `${childStdout}\n${childStderr}`.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

async function checkAuditJobs(database) {
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const orgId = db.prepare('SELECT id FROM organization LIMIT 1').get().id;
    const schedules = () =>
      db
        .prepare(
          'SELECT name, every_seconds FROM job_schedule WHERE org_id = ? AND enabled = 1 ORDER BY name',
        )
        .all(orgId);
    await waitForAudit(() => schedules().length >= 2, 'registered schedules');
    assert.deepEqual(
      schedules().map((row) => [row.name, row.every_seconds]),
      [
        ['core:audit-seal:v1', 60],
        ['core:audit-verify:v1', 86400],
        ['core:blob-purge:v1', 3600],
        ['core:pat-offboarding-sweep:v1', 86400],
        ['core:retention-scan:v1', 86400],
      ],
    );
    db.prepare(
      `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
      VALUES (?, ?, ?, 'system', 'org.update', 'organization')`,
    ).run('smoke-audit', orgId, new Date().toISOString());
    const run = async (type) => {
      const id = randomUUID();
      db.prepare(
        'INSERT INTO job (id, org_id, type, payload_json, idempotency_key) VALUES (?, ?, ?, ?, ?)',
      ).run(id, orgId, type, '{}', id);
      await waitForAudit(
        () =>
          db.prepare('SELECT state FROM job WHERE org_id = ? AND id = ?').get(orgId, id)?.state ===
          'succeeded',
        type,
      );
      return id;
    };
    await run('core:audit-seal:v1');
    const sealed = db
      .prepare('SELECT seq FROM audit_event WHERE org_id = ? AND id = ?')
      .get(orgId, 'smoke-audit');
    assert.ok(sealed, 'seal job must append the audit row');
    const verified = await run('core:audit-verify:v1');
    await waitForAudit(
      () =>
        auditLogs().some(
          (row) => row.event === 'audit.verified' && row.job_id === verified && row.rows >= 1,
        ),
      'verification success',
    );
    db.prepare("UPDATE audit_event SET action = 'org.delete' WHERE org_id = ? AND id = ?").run(
      orgId,
      'smoke-audit',
    );
    const broken = await run('core:audit-verify:v1');
    await waitForAudit(
      () =>
        auditLogs().some(
          (row) =>
            row.event === 'audit.chain_broken' &&
            row.job_id === broken &&
            row.seq === sealed.seq &&
            row.reason === 'hash',
        ),
      'tamper outcome',
    );
    assert.ok(!auditLogs().some((row) => row.event === 'audit.verified' && row.job_id === broken));
    console.log('smoke:node registered audit schedules, sealed, verified and detected tampering');
  } finally {
    db.close();
  }
}

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

async function startBundle(source) {
  if (copy !== undefined) await rm(copy, { recursive: true, force: true });
  childStdout = '';
  childStderr = '';
  step = 'copying the bundle';
  copy = await realpath(await mkdtemp(join(tmpdir(), 'pb-node-smoke-')));
  await cp(join(source, '.'), copy, { recursive: true });
  console.log(`smoke:node copied ${source} to ${copy}`);

  if (process.env['SMOKE_OFFLINE'] === '1') {
    step = 'copying installed production dependencies';
    const require = createRequire(join(REPO_ROOT, 'packages/runtime-node/package.json'));
    const driverManifest = require.resolve('better-sqlite3/package.json');
    const driverTarget = join(copy, 'node_modules/better-sqlite3');
    await cp(dirname(driverManifest), driverTarget, { recursive: true });
    await copyInstalledDependencies(driverTarget, driverManifest);
    console.log('smoke:node copied installed production dependencies (offline)');
  } else {
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
  }

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
    PB_PUBLIC_URL: `http://127.0.0.1:${port}`,
    PB_BLOB_ROOT: join(copy, 'data', 'blobs'),
    DEPLOYMENT_ID: 'smoke',
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
  child.stdout.on('data', (chunk) => {
    childStdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    childStderr += chunk;
  });
  console.log(`smoke:node started ${nodeBin} server.js on port ${port}`);

  step = 'waiting for /health/ready';
  const base = `http://127.0.0.1:${port}`;
  await Promise.race([waitReady(base), failure]);
  console.log('smoke:node GET /health/ready 200');
  return { base, env };
}

function seedPackageCatalogue(database) {
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const orgId = db.prepare('SELECT id FROM organization LIMIT 1').get().id;
    const ids = Object.fromEntries(
      ['project', 'source', 'visible', 'hidden'].map((name) => [name, randomUUID()]),
    );
    db.prepare("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'alpha', 'Alpha')").run(
      ids.project,
      orgId,
    );
    db.prepare(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'fixture', 'npm', 'npm_registry')",
    ).run(ids.source, orgId);
    db.prepare('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)').run(
      orgId,
      ids.project,
      ids.source,
    );
    for (const [id, name] of [
      [ids.visible, 'visible'],
      [ids.hidden, 'hidden'],
    ]) {
      db.prepare(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects) VALUES (?, ?, ?, 'npm', ?, 1)",
      ).run(id, orgId, ids.source, name);
      db.prepare(
        "INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, metadata_json) VALUES (?, ?, ?, '1.0.0', '1.0.0', 'stable', ?, 'import_time', '{}')",
      ).run(randomUUID(), orgId, id, new Date().toISOString());
    }
    db.prepare(
      "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'subscription')",
    ).run(orgId, ids.project, ids.visible);
    return ids;
  } finally {
    db.close();
  }
}

async function checkPackageRoute() {
  step = 'building the package-route bundle';
  const out = join(REPO_ROOT, '.pb', 'package-route-node');
  const built = spawnSync(
    process.execPath,
    [
      CLI,
      'build',
      '--config',
      join(REPO_ROOT, 'fixtures', 'package-route.config.ts'),
      '--target',
      'node',
      '--out',
      out,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (built.status !== 0) throw new Error(`pb build exited with ${built.status}: ${built.stderr}`);
  const { base, env } = await startBundle(out);

  step = 'checking the package-boundary route';
  const route = (name) => `${base}/fixture/pkg/alpha/${name}`;
  const fetchRoute = (name, headers = {}) =>
    fetch(route(name), { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  await expectStatus(await fetchRoute('visible'), 401, 'GET package route without credentials');
  const cookie = await mintSession(base, env['PB_SQLITE_PATH']);
  const ids = seedPackageCatalogue(env['PB_SQLITE_PATH']);
  const visible = await fetchRoute('visible', { cookie });
  await expectStatus(visible, 200, 'GET package route for a visible package');
  const resolved = await visible.json();
  if (resolved?.kind !== 'visible' || resolved?.pkg?.packageId !== ids.visible) {
    throw new Error('the package route did not resolve the visible package');
  }
  const hiddenResponse = await fetchRoute('hidden', { cookie });
  const missingResponse = await fetchRoute('missing', { cookie });
  await expectStatus(hiddenResponse, 404, 'GET package route for an invisible package');
  await expectStatus(missingResponse, 404, 'GET package route for a missing package');
  const strip = (text) => text.replace(/"requestId":"[^"]*"/, '');
  if (strip(await hiddenResponse.text()) !== strip(await missingResponse.text())) {
    throw new Error('an invisible package must answer with the same 404 as a missing package');
  }
  console.log(
    'smoke:node package route: 401 without credentials, 200 visible, uniform 404 invisible',
  );

  step = 'shutting down the package-route server';
  child.kill('SIGTERM');
  const code = await waitExit(child, EXIT_TIMEOUT_MS);
  if (code !== 0) throw new Error(`the server exited with code ${code} after SIGTERM, expected 0`);
}

async function run() {
  const { base, env } = await startBundle(SOURCE);

  step = 'checking the not-found envelope';
  const envelope = JSON.parse(await request(`${base}/nope`, 404));
  if (envelope?.error?.code !== 'not_found') {
    throw new Error(`/nope: expected error.code "not_found", got ${JSON.stringify(envelope)}`);
  }
  console.log('smoke:node GET /nope 404 error.code=not_found');

  step = 'checking the authenticated route';
  const anonymous = await fetch(`${base}/_pb/session`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await expectStatus(anonymous, 401, 'GET /_pb/session without credentials');
  console.log('smoke:node GET /_pb/session without credentials 401');
  const cookie = await mintSession(base, env['PB_SQLITE_PATH']);
  const signedIn = await fetch(`${base}/_pb/session`, {
    headers: { cookie },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await expectStatus(signedIn, 200, 'GET /_pb/session with the minted session');
  console.log('smoke:node GET /_pb/session with a session minted through pb admin bootstrap 200');

  step = 'checking the authenticated UI mount';
  const assetsDir = join(copy, 'assets');
  const uiManifest = JSON.parse(await readFile(join(assetsDir, 'manifest.json'), 'utf8'));
  const uiDocument = await readFile(join(assetsDir, uiManifest.entry), 'utf8');
  const referenced = [...uiDocument.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(referenced.length > 0, 'the UI document references no assets');
  for (const name of referenced) {
    assert.ok(
      name in uiManifest.files,
      `the document references ${name}, absent from the manifest`,
    );
  }
  const uiPaths = [
    '/_pb/ui/',
    '/_pb/ui/manifest.json',
    ...Object.keys(uiManifest.files)
      .filter((name) => name !== uiManifest.entry)
      .map((name) => `/_pb/ui/${name}`),
  ];
  for (const path of uiPaths) {
    const anonymousUi = await fetch(`${base}${path}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await expectStatus(anonymousUi, 401, `GET ${path} without credentials`);
    const authenticatedUi = await fetch(`${base}${path}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await expectStatus(authenticatedUi, 200, `GET ${path} with a session`);
    const name = path === '/_pb/ui/' ? uiManifest.entry : path.slice('/_pb/ui/'.length);
    if (name === 'manifest.json') {
      assert.deepEqual(await authenticatedUi.json(), uiManifest);
    } else {
      assert.deepEqual(
        Buffer.from(await authenticatedUi.arrayBuffer()),
        await readFile(join(assetsDir, name)),
        `${path} differs from the staged file`,
      );
    }
  }
  for (const name of ['index.html', 'manifest.json', ...referenced]) {
    for (const headers of [{}, { cookie }]) {
      const raw = await fetch(`${base}/${name}`, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      assert.equal(raw.status, 404, `GET /${name} must not serve a UI asset`);
    }
  }
  console.log(
    `smoke:node UI document, manifest and ${uiPaths.length - 2} assets require a session and match the staged output`,
  );

  step = 'checking audit jobs';
  await checkAuditJobs(env['PB_SQLITE_PATH']);

  step = 'shutting down';
  child.kill('SIGTERM');
  const code = await waitExit(child, EXIT_TIMEOUT_MS);
  if (code !== 0) throw new Error(`the server exited with code ${code} after SIGTERM, expected 0`);
  console.log('smoke:node SIGTERM exit code 0');

  await checkPackageRoute();

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
