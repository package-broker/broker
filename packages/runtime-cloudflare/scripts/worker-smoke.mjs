import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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

async function readAssetsDescriptor(script) {
  const outDir = dirname(script);
  let text;
  try {
    text = await readFile(join(outDir, 'assets.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const { descriptor } = JSON.parse(text);
  return { ...descriptor, directory: resolve(outDir, descriptor.directory) };
}

async function createMiniflare(script) {
  const assets = await readAssetsDescriptor(script);
  return new Miniflare(
    convertV4MiniflareOptions({
      rootPath: dirname(script),
      handleStructuredLogs: (record) => workerLogs.push(record.message),
      modules: true,
      scriptPath: basename(script),
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      ...(assets === null
        ? {}
        : {
            assets: {
              directory: assets.directory,
              binding: assets.binding,
              run_worker_first: assets.run_worker_first,
              routerConfig: { has_user_worker: true },
              assetConfig: {
                html_handling: assets.html_handling,
                not_found_handling: assets.not_found_handling,
              },
            },
          }),
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
    mf = await createMiniflare(workerScript);

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
    const stagedAssets = await readAssetsDescriptor(workerScript);
    assert.ok(stagedAssets !== null, 'the build output has no assets.json');
    assert.equal(stagedAssets.binding, 'ASSETS');
    assert.equal(stagedAssets.run_worker_first, true);
    assert.equal(stagedAssets.html_handling, 'none');
    assert.equal(stagedAssets.not_found_handling, 'none');
    const uiManifest = JSON.parse(
      await readFile(join(stagedAssets.directory, 'manifest.json'), 'utf8'),
    );
    const uiDocument = await readFile(join(stagedAssets.directory, uiManifest.entry), 'utf8');
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
      await expectStatus(`${path} without credentials`, await dispatch(path, limitMs), 401);
      const response = await send(path, limitMs, { cookie: cookiesOf(finished) });
      await expectStatus(`${path} with a session`, response, 200);
      const name = path === '/_pb/ui/' ? uiManifest.entry : path.slice('/_pb/ui/'.length);
      if (name === 'manifest.json') assert.deepEqual(await response.json(), uiManifest);
      else
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          await readFile(join(stagedAssets.directory, name)),
          `${path} differs from the staged file`,
        );
    }
    for (const name of ['index.html', 'manifest.json', ...referenced]) {
      await expectStatus(
        `raw /${name} without credentials`,
        await dispatch(`/${name}`, limitMs),
        404,
      );
      await expectStatus(
        `raw /${name} with a session`,
        await send(`/${name}`, limitMs, { cookie: cookiesOf(finished) }),
        404,
      );
    }
    console.log(
      `smoke:cloudflare UI document, manifest and ${uiPaths.length - 2} assets require a session and match the staged output`,
    );

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
    execFileSync(
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
      { cwd: repoRoot, stdio: 'pipe' },
    );
    await disposeMiniflare();
    disposed = false;
    mf = await createMiniflare(join(routeOut, 'worker.js'));
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
