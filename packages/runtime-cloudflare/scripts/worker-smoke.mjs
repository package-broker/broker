import { fork, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES } from '@package-broker/core/authz/permissions';
import { DbError } from '@package-broker/core/db/errors';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
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
const defaultOutDir = join(repoRoot, '.pb', 'cloudflare');
const workerScript =
  process.env.SMOKE_WORKER_SCRIPT === undefined
    ? join(defaultOutDir, 'worker.js')
    : resolve(repoRoot, process.env.SMOKE_WORKER_SCRIPT);

function positiveInteger(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const children = new Set();
const instances = new Map();
// Node publishes only children spawned by this process, including Miniflare's private runtime.
channel('child_process').subscribe(({ process: child }) => {
  children.add(child);
  child.once('close', () => children.delete(child));
});

function processLabel() {
  const pids = [...children].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
  return `smoke PID ${process.pid}; child PIDs: ${pids.join(', ') || 'none'}`;
}

async function within(promise, limitMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} exceeded ${limitMs}ms (${processLabel()})`));
        }, limitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function trackMiniflare(instance) {
  instances.set(instance, undefined);
  return instance;
}

const workerLogs = [];
async function waitForAuditLog(predicate, label, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (workerLogs.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`audit jobs: missing ${label}`);
}
let step = 'startup';
let mf;
let cleanupPromise;
let timedOut = false;
let deadlineTimer;

function disposeMiniflare(instance = mf) {
  if (instance === undefined) return Promise.resolve();
  let disposal = instances.get(instance);
  if (disposal === undefined) {
    disposal = within(
      Promise.resolve().then(() => instance.dispose()),
      DISPOSE_GRACE_MS,
      'Miniflare disposal',
    );
    instances.set(instance, disposal);
  }
  return disposal;
}

function cleanup() {
  cleanupPromise ??= (async () => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    try {
      const results = await Promise.allSettled([...instances.keys()].map(disposeMiniflare));
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          failures
            .map((result) =>
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            )
            .join('; '),
        );
      }
    } finally {
      const remaining = [...children];
      const exits = remaining.map((child) => once(child, 'close'));
      for (const child of remaining) {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
      await within(Promise.all(exits), DISPOSE_GRACE_MS, 'Child process cleanup');
    }
  })();
  return cleanupPromise;
}

function fail(error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

async function exitAfterCleanup(code) {
  try {
    await cleanup();
    process.exit(code);
  } catch (error) {
    fail(error);
  }
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    console.error(`smoke:cloudflare received ${signal} while ${step}; cleaning up`);
    void exitAfterCleanup(code);
  });
}

async function readMigrations(outDir = defaultOutDir) {
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

async function envelopeOf(response) {
  return {
    status: response.status,
    body: (await body(response)).replace(/"requestId":"[^"]*"/, ''),
  };
}

async function expectStatus(label, response, status) {
  if (response.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${response.status}: ${await body(response)}`,
    );
  }
}

function createMiniflare(script) {
  return trackMiniflare(
    new Miniflare(
      convertV4MiniflareOptions({
        rootPath: dirname(script),
        handleStructuredLogs: (record) => workerLogs.push(record.message),
        modules: true,
        scriptPath: basename(script),
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        assets: {
          directory: join(repoRoot, 'packages/ui/dist/assets'),
          binding: 'ASSETS',
          run_worker_first: true,
          routerConfig: { has_user_worker: true },
          assetConfig: { html_handling: 'none' },
        },
        r2Buckets: ['STORAGE'],
        queueProducers: { JOBS: 'pb-smoke-jobs' },
        analyticsEngineDatasets: { ANALYTICS: { dataset: 'pb-smoke' } },
        bindings: {
          PB_MASTER_KEY: MASTER_KEY,
          PB_PUBLIC_URL: PUBLIC_ORIGIN,
          DEPLOYMENT_ID: 'smoke',
        },
      }),
    ),
  );
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
    if (cleanupPromise !== undefined) return;
    timedOut = true;
    console.error(`smoke:cloudflare: ${deadlineMs}ms deadline exceeded while ${step}`);
    void exitAfterCleanup(1);
  }, deadlineMs);

  try {
    step = 'reading migrations';
    const migrations = await readMigrations();

    step = 'constructing Miniflare';
    mf = createMiniflare(workerScript);

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

    step = 'GET /_pb/session without credentials';
    await expectStatus(
      '/_pb/session without credentials',
      await dispatch('/_pb/session', limitMs),
      401,
    );
    console.log('smoke:cloudflare workerd: session without credentials refused (401)');

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

    step = 'checking the authenticated UI mount';
    const uiManifest = JSON.parse(
      await readFile(join(repoRoot, 'packages/ui/dist/assets/manifest.json'), 'utf8'),
    );
    for (const path of ['/_pb/ui/', '/_pb/ui/manifest.json']) {
      await expectStatus(`${path} without credentials`, await dispatch(path, limitMs), 401);
      const response = await send(path, limitMs, { cookie: cookiesOf(finished) });
      await expectStatus(`${path} with a session`, response, 200);
      if (path.endsWith('.json')) assert.deepEqual(await response.json(), uiManifest);
      else
        assert.equal(
          await response.text(),
          await readFile(join(repoRoot, 'packages/ui/dist/assets', uiManifest.entry), 'utf8'),
        );
    }
    console.log('smoke:cloudflare UI document and manifest require a session');

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

    step = 'uniform 401 for unusable credentials on /_pb/session';
    const anonymous = await envelopeOf(await dispatch('/_pb/session', limitMs));
    if (anonymous.status !== 401) {
      throw new Error(`/_pb/session anonymous: expected 401, got ${anonymous.status}`);
    }
    for (const [label, headers] of [
      ['bogus bearer', { authorization: 'Bearer pb_pat_bogus' }],
      ['malformed bearer', { authorization: 'Bearer nonsense' }],
      ['unknown session cookie', { cookie: '__Host-pb_session=nope' }],
    ]) {
      const refused = await envelopeOf(
        await mf.dispatchFetch('http://broker.test/_pb/session', {
          headers,
          signal: AbortSignal.timeout(limitMs),
        }),
      );
      if (refused.status !== anonymous.status || refused.body !== anonymous.body) {
        throw new Error(
          `/_pb/session ${label}: expected the anonymous 401 envelope, got ${JSON.stringify(refused)}`,
        );
      }
    }
    console.log('smoke:cloudflare workerd: unusable credentials share one 401 envelope');

    step = 'foreign keys enforced on the D1 binding';
    const insertGrant = (roleId) =>
      executor.all({
        sql: 'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [ulid(), orgId, 'email', 'fk@example.test', null, 'organization', null, roleId],
      });
    const fkFailure = await insertGrant(ulid()).then(
      () => undefined,
      (error) => error,
    );
    if (!(fkFailure instanceof DbError) || fkFailure.kind !== 'foreign_key') {
      throw new Error('access_grant insert with an unknown role: expected DbError foreign_key');
    }
    const [role] = await executor.all({
      sql: "SELECT id FROM role WHERE org_id = ? AND scope = 'organization' LIMIT 1",
      params: [orgId],
    });
    if (role === undefined) throw new Error('no organization role');
    await insertGrant(role.id);
    console.log('smoke:cloudflare workerd: D1 enforces foreign keys');

    step = 'checking registered audit schedules';
    const entry = await mf.getWorker();
    await entry.scheduled();
    const schedules = await executor.all({
      sql: 'SELECT name, every_seconds FROM job_schedule WHERE org_id = ? AND enabled = 1 ORDER BY name',
      params: [orgId],
    });
    assert.deepEqual(
      schedules.map((row) => [row.name, row.every_seconds]),
      [
        ['core:audit-seal:v1', 60],
        ['core:audit-verify:v1', 86400],
        ['core:pat-offboarding-sweep:v1', 86400],
      ],
    );
    await executor.batch([
      {
        sql: `INSERT INTO audit_pending (id, org_id, created_at, actor_type, action, target_type)
            VALUES ('smoke-audit', ?, ?, 'system', 'org.update', 'organization')`,
        params: [orgId, new Date().toISOString()],
      },
    ]);
    const jobs = createJobRepository(executor);
    const runAudit = async (type) => {
      const id = ulid();
      await jobs.enqueue(orgContext(orgId), {
        id,
        type,
        payloadJson: '{}',
        idempotencyKey: id,
        resourceKey: null,
        runAt: null,
        maxAttempts: 2,
        projectId: null,
        initiatorTokenId: null,
      });
      const result = await entry.queue('pb-smoke-jobs', [
        {
          id,
          timestamp: new Date(),
          attempts: 1,
          body: { v: 1, org: orgId, job: id },
        },
      ]);
      assert.equal(result.outcome, 'ok', `queue execution of ${type}`);
      assert.equal((await jobs.status(orgContext(orgId), id))?.state, 'succeeded', type);
      return id;
    };
    step = 'sealing and verifying audit rows through the built Worker';
    await runAudit('core:audit-seal:v1');
    const [sealed] = await executor.all({
      sql: "SELECT seq FROM audit_event WHERE org_id = ? AND id = 'smoke-audit'",
      params: [orgId],
    });
    assert.ok(sealed, 'seal job must append the audit row');
    const verified = await runAudit('core:audit-verify:v1');
    await waitForAuditLog(
      (message) => message.includes('audit.verified') && message.includes(verified),
      'verification success',
      limitMs,
    );
    step = 'detecting audit tampering through the built Worker';
    await executor.batch([
      {
        sql: "UPDATE audit_event SET action = 'org.delete' WHERE org_id = ? AND id = 'smoke-audit'",
        params: [orgId],
      },
    ]);
    const broken = await runAudit('core:audit-verify:v1');
    await waitForAuditLog(
      (message) =>
        message.includes('audit.chain_broken') &&
        message.includes(broken) &&
        message.includes('hash') &&
        new RegExp(`seq["']?\\s*:\\s*${sealed.seq}\\b`).test(message),
      'tamper outcome identifying the broken sequence and hash',
      limitMs,
    );
    assert.ok(
      !workerLogs.some((message) => message.includes('audit.verified') && message.includes(broken)),
    );
    console.log(
      'smoke:cloudflare registered audit schedules, sealed, verified and detected tampering',
    );

    step = 'building the package-route Worker';
    const routeOut = join(repoRoot, '.pb', 'package-route-cloudflare');
    const build = spawn(
      process.execPath,
      [
        join(repoRoot, 'packages', 'cli', 'dist', 'bin.js'),
        'build',
        '--config',
        join(repoRoot, 'fixtures', 'package-route.config.ts'),
        '--target',
        'cloudflare',
        '--out',
        routeOut,
      ],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    const [buildCode, buildSignal] = await once(build, 'exit');
    if (buildCode !== 0) {
      throw new Error(`package-route build PID ${build.pid} failed (${buildSignal ?? buildCode})`);
    }
    await disposeMiniflare();
    mf = createMiniflare(join(routeOut, 'worker.js'));
    const routeExecutor = createD1Executor(await mf.getD1Database('DB'));
    await migrate(routeExecutor, await readMigrations(routeOut), { holder: 'smoke' });
    const routeOrgId = ulid();
    const routeNow = new Date();
    await createOrganizationBootstrap(routeExecutor).bootstrap({
      id: routeOrgId,
      slug: 'smoke',
      name: 'Smoke',
      now: routeNow.toISOString(),
    });
    const routeAdminId = ulid();
    const routeToken = randomBytes(32).toString('base64url');
    const routeBootstrapped = await bootstrapAdmin(routeExecutor, orgContext(routeOrgId), {
      email: ADMIN_EMAIL,
      userId: routeAdminId,
      setupHash: createHash('sha256').update(routeToken).digest('hex'),
      setupExpiresAt: new Date(routeNow.getTime() + 3_600_000).toISOString(),
      grantId: ulid(),
      roleIds: Object.fromEntries(DEFAULT_ROLES.map(({ key }) => [key, ulid()])),
      opId: ulid(),
      now: routeNow.toISOString(),
    });
    if (routeBootstrapped !== 'created') {
      throw new Error(
        `package-route admin bootstrap: expected "created", got ${routeBootstrapped}`,
      );
    }
    const routeStarted = await send('/_pb/auth/local/setup/start', limitMs, {
      method: 'POST',
      json: { token: routeToken },
    });
    await expectStatus('package-route setup start', routeStarted, 200);
    const routeSecret = base32Decode((await routeStarted.json()).secret);
    const routeFinished = await send('/_pb/auth/local/setup/finish', limitMs, {
      method: 'POST',
      json: {
        token: routeToken,
        password: VECTOR_PASSWORD,
        code: await totpCode(routeSecret, totpStep()),
      },
    });
    await expectStatus('package-route setup finish', routeFinished, 204);
    const routeCookie = cookiesOf(routeFinished);

    step = 'seeding the package catalogue';
    const projectId = ulid();
    const sourceId = ulid();
    const visibleId = ulid();
    const hiddenId = ulid();
    const seed = [
      [
        "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'alpha', 'Alpha')",
        [projectId, routeOrgId],
      ],
      [
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'fixture', 'npm', 'npm_registry')",
        [sourceId, routeOrgId],
      ],
      [
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        [routeOrgId, projectId, sourceId],
      ],
    ];
    for (const [id, name] of [
      [visibleId, 'visible'],
      [hiddenId, 'hidden'],
    ]) {
      seed.push([
        "INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects) VALUES (?, ?, ?, 'npm', ?, 1)",
        [id, routeOrgId, sourceId, name],
      ]);
      seed.push([
        "INSERT INTO version (id, org_id, package_id, version, version_normalized, stability, published_at, published_at_basis, metadata_json) VALUES (?, ?, ?, '1.0.0', '1.0.0', 'stable', ?, 'import_time', '{}')",
        [ulid(), routeOrgId, id, new Date().toISOString()],
      ]);
    }
    seed.push([
      "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'subscription')",
      [routeOrgId, projectId, visibleId],
    ]);
    await routeExecutor.batch(seed.map(([sql, params]) => ({ sql, params })));

    step = 'checking the package-boundary route';
    const routePath = (name) => `/fixture/pkg/alpha/${name}`;
    await expectStatus(
      'package route without credentials',
      await dispatch(routePath('visible'), limitMs),
      401,
    );
    const visible = await send(routePath('visible'), limitMs, { cookie: routeCookie });
    await expectStatus('package route for a visible package', visible, 200);
    const resolved = await visible.json();
    assert.equal(resolved.kind, 'visible');
    assert.equal(resolved.pkg.packageId, visibleId);
    const hiddenResponse = await send(routePath('hidden'), limitMs, { cookie: routeCookie });
    const missingResponse = await send(routePath('missing'), limitMs, { cookie: routeCookie });
    await expectStatus('package route for an invisible package', hiddenResponse, 404);
    assert.deepEqual(await envelopeOf(hiddenResponse), await envelopeOf(missingResponse));
    console.log(
      'smoke:cloudflare package route: 401 without credentials, 200 visible, uniform 404 invisible',
    );

    step = 'done';
  } finally {
    await cleanup();
  }
  console.log('smoke:cloudflare ok');
}

async function selfCheck() {
  let disposeCalls = 0;
  const hung = trackMiniflare({
    dispose() {
      disposeCalls += 1;
      return new Promise(() => {});
    },
  });
  try {
    const disposal = disposeMiniflare(hung);
    assert.equal(disposeMiniflare(hung), disposal, 'disposal must be shared across cleanup calls');
    await assert.rejects(
      disposal,
      new RegExp(
        `Miniflare disposal exceeded ${DISPOSE_GRACE_MS}ms \\(smoke PID ${process.pid}; child PIDs:`,
      ),
    );
    assert.equal(disposeCalls, 1, 'dispose must be called once per instance');
  } finally {
    instances.delete(hung);
  }
  const failure = new Error('self-check disposal failure');
  const broken = trackMiniflare({ dispose: () => Promise.reject(failure) });
  try {
    await assert.rejects(disposeMiniflare(broken), (error) => error === failure);
  } finally {
    instances.delete(broken);
  }
  console.log('smoke:cloudflare self-check: disposal timeout, PID diagnostic and rejection passed');
  const smoke = fork(fileURLToPath(import.meta.url), ['--self-check-child'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const exit = once(smoke, 'exit');
  try {
    await within(once(smoke, 'message'), DEFAULT_TIMEOUT_MS, 'Self-check child startup');
    // Start after the smoke's initialization so a machine-wide PID-difference sweep would kill it.
    const unrelated = trackMiniflare(
      new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script: 'export default { fetch() { return new Response("unrelated workerd alive") } }',
          compatibilityDate: '2026-10-01',
        }),
      ),
    );
    await within(unrelated.ready, DEFAULT_TIMEOUT_MS, 'Unrelated workerd startup');
    const unrelatedChildren = [...children].filter((child) => child !== smoke);
    assert.ok(unrelatedChildren.length > 0, 'self-check must start an unrelated workerd');
    smoke.send('run');
    const [code, signal] = await within(
      exit,
      DEFAULT_DEADLINE_MS + 3 * DISPOSE_GRACE_MS,
      'Self-check smoke run',
    );
    assert.equal(signal, null, 'smoke must exit without a signal');
    assert.equal(code, 0, 'smoke must succeed');
    for (const child of unrelatedChildren) {
      assert.equal(child.exitCode, null, `unrelated PID ${child.pid} must survive`);
      assert.equal(child.signalCode, null, `unrelated PID ${child.pid} must not be killed`);
      assert.ok(child.kill(0), `unrelated PID ${child.pid} must still exist`);
    }
    assert.equal(
      await within(
        unrelated.dispatchFetch('http://unrelated.test').then((response) => response.text()),
        DEFAULT_TIMEOUT_MS,
        'Unrelated workerd response',
      ),
      'unrelated workerd alive',
    );
    console.log('smoke:cloudflare self-check: unrelated workerd survived the smoke run');
  } finally {
    try {
      if (smoke.exitCode === null && smoke.signalCode === null) {
        smoke.kill('SIGTERM');
        await within(exit, 3 * DISPOSE_GRACE_MS, 'Self-check child shutdown');
      }
    } finally {
      await cleanup();
    }
  }
}

async function main() {
  if (process.argv.includes('--self-check')) return selfCheck();
  if (process.argv.includes('--self-check-child')) {
    const start = once(process, 'message');
    process.send('ready');
    await start;
    process.disconnect();
  }
  return run();
}

main().catch((error) => {
  if (!timedOut) fail(error);
});
