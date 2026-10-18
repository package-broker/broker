import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES } from '@package-broker/core/authz/permissions';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { planMigrations } from '@package-broker/db-sqlite/migrations/plan';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor } from '@package-broker/runtime-cloudflare/db/d1-executor';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_MS = 60_000;
const DISPOSE_GRACE_MS = 5_000;
const PUBLIC_ORIGIN = 'https://broker.test';
const MASTER_KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ADMIN_EMAIL = 'admin@example.test';
// Design note section 2.6: v1 password-pepper, salt 0xa0..0xaf, 100000 iterations.
const VECTOR_PASSWORD = 'correct horse battery staple';
const VECTOR_PASSWORD_HASH =
  'pbkdf2-sha256$i=100000$v=1$oKGio6SlpqeoqaqrrK2urw$K7MuJuKUZ7oO7dy0yZlMHaJS4zt5QunqAXSi_Zf584U';

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
    const name = entry.name;
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

async function send(path, limitMs, { method = 'GET', json, cookie } = {}) {
  const url = `http://broker.test${path}`;
  const headers = {};
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    headers.origin = PUBLIC_ORIGIN;
  }
  if (cookie !== undefined) headers.cookie = cookie;
  try {
    return await mf.dispatchFetch(url, {
      method,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(limitMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`${method} ${path}: no response within ${limitMs}ms`, { cause: error });
    }
    throw error;
  }
}

function cookiesOf(response) {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
}

function totpStep(offset = 0) {
  return Math.floor(Date.now() / 30_000) + offset;
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
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['STORAGE'],
        queueProducers: { JOBS: 'pb-smoke-jobs' },
        analyticsEngineDatasets: { ANALYTICS: { dataset: 'pb-smoke' } },
        bindings: {
          PB_MASTER_KEY: MASTER_KEY,
          PB_PUBLIC_URL: PUBLIC_ORIGIN,
          DEPLOYMENT_ID: 'smoke',
        },
      }),
    );

    step = 'opening the D1 database';
    const executor = createD1Executor(await mf.getD1Database('DB'));

    step = 'applying migrations';
    await migrate(executor, migrations, { holder: 'smoke' });

    step = 'bootstrapping the organization';
    const orgId = ulid();
    const now = new Date();
    await createOrganizationBootstrap(executor).bootstrap({
      id: orgId,
      slug: 'smoke',
      name: 'Smoke',
      now: now.toISOString(),
    });

    step = 'bootstrapping the admin';
    const adminId = ulid();
    const setupToken = randomBytes(32).toString('base64url');
    const roleIds = Object.fromEntries(DEFAULT_ROLES.map(({ key }) => [key, ulid()]));
    const bootstrapped = await bootstrapAdmin(executor, orgContext(orgId), {
      email: ADMIN_EMAIL,
      userId: adminId,
      setupHash: createHash('sha256').update(setupToken).digest('hex'),
      setupExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      grantId: ulid(),
      roleIds,
      opId: ulid(),
      now: now.toISOString(),
    });
    if (bootstrapped !== 'created') {
      throw new Error(`admin bootstrap: expected "created", got ${bootstrapped}`);
    }

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

    step = 'POST /_pb/auth/local/setup/start';
    const started = await send('/_pb/auth/local/setup/start', limitMs, {
      method: 'POST',
      json: { token: setupToken },
    });
    await expectStatus('local setup start', started, 200);
    const totpSecret = base32Decode((await started.json()).secret);
    console.log('smoke:cloudflare workerd: local setup start ok');

    step = 'POST /_pb/auth/local/setup/finish';
    const finished = await send('/_pb/auth/local/setup/finish', limitMs, {
      method: 'POST',
      json: {
        token: setupToken,
        password: VECTOR_PASSWORD,
        code: await totpCode(totpSecret, totpStep()),
      },
    });
    await expectStatus('local setup finish', finished, 204);
    console.log('smoke:cloudflare workerd: local setup finish ok');

    step = 'GET /_pb/session after setup';
    const afterSetup = await send('/_pb/session', limitMs, { cookie: cookiesOf(finished) });
    await expectStatus('/_pb/session after setup', afterSetup, 200);
    console.log('smoke:cloudflare workerd: session after setup ok');

    step = 'storing the section 2.6 password vector';
    await executor.all({
      sql: 'UPDATE local_login SET password_hash = ? WHERE user_id = ?',
      params: [VECTOR_PASSWORD_HASH, adminId],
    });

    step = 'POST /_pb/auth/local/login';
    const loggedIn = await send('/_pb/auth/local/login', limitMs, {
      method: 'POST',
      json: {
        email: ADMIN_EMAIL,
        password: VECTOR_PASSWORD,
        code: await totpCode(totpSecret, totpStep(1)),
      },
    });
    await expectStatus('local login against the section 2.6 password hash', loggedIn, 204);
    console.log(
      'smoke:cloudflare workerd: local login ok (HKDF keys match the section 2.6 vector)',
    );

    step = 'GET /_pb/session after login';
    const afterLogin = await send('/_pb/session', limitMs, { cookie: cookiesOf(loggedIn) });
    await expectStatus('/_pb/session after login', afterLogin, 200);
    console.log('smoke:cloudflare workerd: session after login ok');

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
