import github from '../packages/plugin-github/dist/index.js';
import { auditTrail } from '../packages/plugin-audit-trail/dist/index.js';
import matrixScanner from '../fixtures/client-matrix-scanner.mjs';
import { createJobLoop } from '../packages/runtime-node/dist/jobs/loop.js';
import { runJoinedJourneys } from './client-matrix-joined.mjs';
import { createJoinedFixture } from './client-matrix-joined-fixture.mjs';
import { runManagement } from './client-matrix-management.mjs';
import {
  runApiGate,
  assertRuntimeParity,
  assertIntegrationEvidence,
} from './client-matrix-api.mjs';
import { runLogin, saveLoginCapture } from './client-matrix-login.mjs';
import { hashPassword } from '../packages/core/dist/auth/password.js';
import { sha256Hex } from '../packages/core/dist/auth/primitives.js';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { glob, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createKeyring } from '../packages/core/dist/secrets/keyring.js';
import { verifyKeyring } from '../packages/core/dist/secrets/keyring-verifier.js';
import { createKeyringVerifierStore } from '../packages/db-sqlite/dist/repositories/keyring-verifier.js';
import { parseMasterKey } from '../packages/core/dist/secrets/master-key.js';
import { formatToken } from '../packages/core/dist/secrets/token-format.js';
import { hashToken } from '../packages/core/dist/secrets/token-hash.js';
import { ulid } from '../packages/core/dist/ids.js';
import { resolveRegistryConfig } from '../packages/core/dist/registry/registry-config.js';
import { createBlobStore, createBlobUploadAdmission } from '../packages/core/dist/platform/blob.js';
import { createOrganizationBootstrap } from '../packages/db-sqlite/dist/repositories/organization.js';
import { createBlobRepository } from '../packages/db-sqlite/dist/repositories/blob.js';
import { createJobRepository } from '../packages/db-sqlite/dist/repositories/job.js';
import {
  discoveredMigrations,
  openMigratedDatabase,
} from '../packages/db-sqlite/dist/testing/migrated-database.js';
import { migrate } from '../packages/db-sqlite/dist/migrations/runner.js';
import { createNodeServerWithSeams } from '../packages/runtime-node/dist/testing/node-server.js';
import { openFilesystemByteStore } from '../packages/runtime-node/dist/blob/filesystem.js';
import { createLruCache } from '../packages/runtime-node/dist/cache/lru.js';
import { createD1Executor } from '../packages/runtime-cloudflare/dist/db/d1-executor.js';
import {
  prepareClient,
  preparePublisher,
  harnessAssert as assert,
  PACKAGES,
  PUBLISH_PACKAGES,
  clientCommands,
  checkResult,
  checkTraffic,
  checkVersion,
  checkInstalledPackage,
  observeResponse,
  fixtureReply,
  runCommand,
  matrixStep,
  safeFailureReason,
} from './client-matrix.mjs';

const root = resolve(import.meta.dirname, '..');
const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const keyring = createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
const require = createRequire(
  new URL('../packages/runtime-cloudflare/package.json', import.meta.url),
);
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

export async function seed(executor, { joined = false } = {}) {
  await verifyKeyring(keyring, createKeyringVerifierStore(executor));
  const orgId = ulid();
  const projectId = ulid();
  const userId = ulid();
  const serviceId = ulid();
  const publicSource = ulid();
  await createOrganizationBootstrap(executor).bootstrap({
    id: orgId,
    slug: 'matrix',
    name: 'Matrix',
    now: new Date().toISOString(),
  });
  const sql = (sql, params) => executor.batch([{ sql, params }]);
  await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'alpha', 'Alpha')", [
    projectId,
    orgId,
  ]);
  await sql('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
    userId,
    orgId,
    'fixture@matrix.test',
  ]);
  await sql(
    'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
    [serviceId, orgId, 'matrix-bot', projectId, userId],
  );
  for (const permission of ['project:read', 'project:packages:read']) {
    await sql(
      'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
      [orgId, serviceId, permission],
    );
  }
  const token = formatToken('svc', 'abcdefghijkl', crypto.getRandomValues(new Uint8Array(32)));
  await sql(
    `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json,
    read_only, service_principal_id, project_id, created_by_user_id, expires_at, project_mode)
    VALUES (?, ?, 'svc', 'abcdefghijkl', ?, 1, 'matrix', '["read"]', 1, ?, ?, ?, ?, 'all')`,
    [
      ulid(),
      orgId,
      await hashToken(keyring, 1, token),
      serviceId,
      projectId,
      userId,
      new Date(Date.now() + 3_600_000).toISOString(),
    ],
  );
  for (const [id, name, type, url, config] of [
    [publicSource, 'npmjs', 'npmjs_proxy', 'https://registry.npmjs.org', '{}'],
    [ulid(), 'private', 'npm_registry', 'https://npm.matrix.test', '{"scopes":["@matrix"]}'],
  ]) {
    await sql(
      "INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json) VALUES (?, ?, ?, 'npm', ?, ?, ?)",
      [id, orgId, name, type, url, config],
    );
    if (type === 'npm_registry') {
      await sql(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'npm', '@matrix/*')",
        [ulid(), orgId, id],
      );
    }
    await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
      orgId,
      projectId,
      id,
    ]);
  }
  const publishPrincipal = ulid();
  await sql(
    'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
    [publishPrincipal, orgId, 'matrix-publisher', userId],
  );
  await sql(
    "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, 'org:packages:publish')",
    [orgId, publishPrincipal],
  );
  for (const permission of ['project:packages:read', 'project:packages:manage'])
    await sql(
      'INSERT INTO service_principal_permission (org_id,service_principal_id,permission) VALUES (?,?,?)',
      [orgId, publishPrincipal, permission],
    );
  const publishToken = formatToken(
    'svc',
    'publishabcde',
    crypto.getRandomValues(new Uint8Array(32)),
  );
  await sql(
    `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, service_principal_id, expires_at, project_mode) VALUES (?, ?, 'svc', 'publishabcde', ?, 1, 'publish', '["write"]', 0, ?, ?, 'all')`,
    [
      ulid(),
      orgId,
      await hashToken(keyring, 1, publishToken),
      publishPrincipal,
      new Date(Date.now() + 3600000).toISOString(),
    ],
  );
  const manageToken = formatToken(
    'svc',
    'manageabcdef',
    crypto.getRandomValues(new Uint8Array(32)),
  );
  await sql(
    `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, service_principal_id, expires_at, project_mode) VALUES (?, ?, 'svc', 'manageabcdef', ?, 1, 'manage', '["full"]', 0, ?, ?, 'all')`,
    [
      ulid(),
      orgId,
      await hashToken(keyring, 1, manageToken),
      publishPrincipal,
      new Date(Date.now() + 3600000).toISOString(),
    ],
  );
  const oidcPublisherId = ulid();
  if (!joined) {
    const oidcPrincipal = ulid();
    await sql(
      'INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES (?,?,?,?)',
      [oidcPrincipal, orgId, 'Trusted publisher', userId],
    );
    await sql(
      "INSERT INTO service_principal_permission (org_id,service_principal_id,permission) VALUES (?,?,'org:packages:publish')",
      [orgId, oidcPrincipal],
    );
    await sql(
      "INSERT INTO trusted_publisher (id,org_id,package_name,repository_id,repository_owner_id,repository,workflow,environment,service_principal_id,created_by_user_id) VALUES (?,?,'matrix-publish-active','123','456','fixture/repository','publish.yml','',?,?)",
      [oidcPublisherId, orgId, oidcPrincipal, userId],
    );
  }
  const sessionSecret = 's'.repeat(43);
  const csrf = 'c'.repeat(43);
  const roleId = ulid();
  const credentialId = ulid();
  await sql(
    "INSERT INTO role (id,org_id,key,name,scope,protects_last_holder) VALUES (?,?,'matrix-admin','Matrix admin','organization',1)",
    [roleId, orgId],
  );
  for (const permission of [
    'project:read',
    'project:packages:read',
    'project:packages:write',
    'org:read',
    'org:packages:read',
    'org:packages:approve',
    'org:packages:publish',
    'org:service-principals:write',
    'org:sources:read',
    'org:sources:write',
    'project:sources:write',
    'org:packages:manage',
    'project:packages:manage',
  ])
    await sql('INSERT INTO role_permission (org_id,role_id,permission) VALUES (?,?,?)', [
      orgId,
      roleId,
      permission,
    ]);
  await sql(
    "INSERT INTO access_grant (id,org_id,subject_type,subject_value,scope,role_id) VALUES (?,?,'email','fixture@matrix.test','organization',?)",
    [ulid(), orgId, roleId],
  );
  await sql(
    "INSERT INTO credential (id,org_id,kind,ciphertext,nonce,key_version,aad) VALUES (?,?,'totp',x'00',x'000000000000000000000000',1,'test')",
    [credentialId, orgId],
  );
  await sql(
    "INSERT INTO local_login (user_id,org_id,password_hash,totp_credential_id,totp_enabled_at,last_login_at) VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    [userId, orgId, await hashPassword('matrix fixture password', keyring), credentialId],
  );
  await sql(
    "INSERT INTO session (id,org_id,user_id,secret_hash,csrf_hash,expires_at,last_seen_at,reauth_at) VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    [ulid(), orgId, userId, await sha256Hex(sessionSecret), await sha256Hex(csrf)],
  );
  return {
    token,
    publishToken,
    manageToken,
    orgId,
    projectId,
    oidcPublisherId,
    prepareRequestProject: async () => {
      const requestProjectId = ulid();
      await sql("INSERT INTO project (id,org_id,slug,name) VALUES (?,?,'beta','Beta')", [
        requestProjectId,
        orgId,
      ]);
      await sql(
        "INSERT INTO project_source (org_id,project_id,source_id) SELECT org_id,?,id FROM source WHERE org_id=? AND type='hosted'",
        [requestProjectId, orgId],
      );
    },
    browserHeaders: (origin) => ({
      cookie: `__Host-pb_session=${sessionSecret}; __Host-pb_csrf=${csrf}`,
      'x-csrf-token': csrf,
      origin,
      'content-type': 'application/json',
    }),
    inspectLogin: () =>
      executor.all({
        sql: `SELECT t.project_mode, p.project_id, l.state, l.token_ciphertext FROM npm_login_session l JOIN token t ON t.org_id=l.org_id AND t.id=l.token_id JOIN token_project p ON p.org_id=t.org_id AND p.token_id=t.id WHERE l.org_id=?`,
        params: [orgId],
      }),
    // The API gate narrows these packages to request-only access, which removes alpha's
    // default membership; management runs as alpha again.
    prepareManagement: (name) =>
      executor.batch([
        {
          sql: "UPDATE package SET visible_to_new_projects=1,new_project_access_mode='none',rev=rev+1 WHERE org_id=? AND name=? AND ecosystem='npm'",
          params: [orgId, name],
        },
        {
          sql: "INSERT INTO project_package (org_id,project_id,package_id,origin,ecosystem,name) SELECT org_id,?,id,'explicit',ecosystem,name FROM package WHERE org_id=? AND name=? AND ecosystem='npm' ON CONFLICT DO NOTHING",
          params: [projectId, orgId, name],
        },
        {
          sql: 'UPDATE cache_epoch SET version=hex(randomblob(16)) WHERE org_id=?',
          params: [orgId],
        },
      ]),
    // Clients revalidate the packument; a changed publish time must change its validators.
    agePublish: (name, old) =>
      executor.batch([
        {
          sql: "UPDATE version SET published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?) WHERE org_id=? AND package_id IN (SELECT id FROM package WHERE org_id=? AND name=?)",
          params: [old ? '-73 hours' : '-1 minute', orgId, orgId, name],
        },
        {
          sql: "UPDATE package SET rev=rev+1 WHERE org_id=? AND name=? AND ecosystem='npm'",
          params: [orgId, name],
        },
        {
          sql: 'UPDATE cache_epoch SET version=hex(randomblob(16)) WHERE org_id=?',
          params: [orgId],
        },
      ]),
    backendVersion: () => executor.all({ sql: 'SELECT sqlite_version() AS version', params: [] }),
    inspectRepositoryBuild: (sourceId) =>
      executor.all({
        sql: `SELECT j.state AS status, b.refetchable FROM job j
        JOIN source s ON s.org_id=j.org_id AND s.id=json_extract(j.payload_json, '$.sourceId')
        LEFT JOIN package p ON p.org_id=s.org_id AND p.source_id=s.id
        LEFT JOIN version v ON v.org_id=p.org_id AND v.package_id=p.id AND v.id=json_extract(j.payload_json, '$.versionId')
        LEFT JOIN blob b ON b.org_id=v.org_id AND b.id=v.blob_id
        WHERE j.org_id=? AND s.id=? AND j.type='core:npm-vcs-build:v1' AND j.state IN ('succeeded','dead')`,
        params: [orgId, sourceId],
      }),
    inspectPublish: async (name) =>
      executor.all({
        sql: `SELECT v.status, b.refetchable FROM version v JOIN package p ON p.id = v.package_id AND p.org_id = v.org_id JOIN blob b ON b.id = v.blob_id AND b.org_id = v.org_id WHERE v.org_id = ? AND p.name = ?`,
        params: [orgId, name],
      }),
    detach: () =>
      sql('DELETE FROM project_source WHERE org_id = ? AND project_id = ? AND source_id = ?', [
        orgId,
        projectId,
        publicSource,
      ]),
  };
}

async function frontServer(routes, observe = async () => {}, { checkRoutes = true } = {}) {
  let dispatch;
  let onLogin;
  let failure;
  let auditStatus = 200;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, origin);
      assert.ok(url.origin === origin, 'Client escaped the registry');
      const body =
        incoming.method === 'GET' || incoming.method === 'HEAD'
          ? undefined
          : Buffer.concat(await Array.fromAsync(incoming));
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        body,
      });
      const loginRequest =
        onLogin && /\/-\/v1\/(?:login|done\/)/.test(url.pathname) ? request.clone() : null;
      const response = await dispatch(request);
      if (loginRequest) await onLogin(loginRequest, response);
      if (checkRoutes && !(onLogin && url.pathname.endsWith('/-/whoami')))
        await observeResponse(routes, request, response, auditStatus);
      await observe(request, response);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const headers = Object.fromEntries(response.headers);
      delete headers['transfer-encoding'];
      delete headers['content-encoding'];
      headers['content-length'] = String(bytes.length);
      outgoing.writeHead(response.status, headers);
      outgoing.end(bytes);
    } catch (error) {
      failure ??= safeFailureReason(error);
      outgoing.writeHead(502).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    login: (handler) => {
      onLogin = handler;
    },
    bind: (handler) => {
      dispatch = handler;
    },
    expectAudit: (status) => {
      auditStatus = status;
    },
    assertHealthy: () => assert.ok(failure === undefined, `Registry bridge failed: ${failure}`),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export async function openMatrixBlobStore(executor, directory, origin) {
  return createBlobStore(
    await openFilesystemByteStore({ root: join(directory, 'blobs') }),
    createBlobRepository(executor, { purgeLeaseSeconds: 900 }),
    {
      admission: createBlobUploadAdmission(),
      maxBytes: resolveRegistryConfig(undefined, 'node', origin).caps.publishTarballBytes,
    },
  );
}

async function bootNode(directory, origin, audits, cleanup, options = {}) {
  const db = await openMigratedDatabase();
  cleanup.push(() => db.close());
  const seeded = await seed(db.executor, options);
  const transport = options.fixture?.fetch ?? ((request) => fixtureReply(request, audits));
  const broker = await createMatrixNodeBroker(db.executor, directory, origin, transport, options);
  cleanup.push(() => broker.close());
  const kernel = await broker.ready();
  if (options.joined) {
    const loop = createJobLoop({
      executor: db.executor,
      jobs: kernel.registration.jobs,
      scope: kernel.jobScope,
      maxRunning: 2,
      observability: { log() {}, counter() {}, histogram() {} },
    });
    loop.start();
    cleanup.push(() => loop.stop());
  }
  broker.server.listen(0, '127.0.0.1');
  await once(broker.server, 'listening');
  const base = `http://127.0.0.1:${broker.server.address().port}`;
  return {
    ...seeded,
    tick: async () => {},
    dispatch: async (request) =>
      fetch(base + new URL(request.url).pathname + new URL(request.url).search, {
        method: request.method,
        headers: { ...Object.fromEntries(request.headers), host: new URL(origin).host },
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
        signal: AbortSignal.timeout(30_000),
      }),
  };
}

export async function createMatrixNodeBroker(executor, directory, origin, transport, options = {}) {
  return createNodeServerWithSeams(
    [auditTrail(), ...(options.joined ? [github(), matrixScanner(transport)] : [])],
    {
      executor,
      auth: { keyring, publicOrigin: origin, env: {} },
      platformServices: {
        blob: await openMatrixBlobStore(executor, directory, origin),
        cache: createLruCache({}),
        jobStore: createJobRepository(executor),
      },
      registry: { config: resolveRegistryConfig(undefined, 'node', origin) },
      log: () => undefined,
    },
    { transport: (input, init) => transport(new Request(input, init)) },
  );
}

async function bootWorker(directory, origin, audits, cleanup, options) {
  const out = join(directory, 'worker');
  const built = await runCommand(
    process.execPath,
    [
      join(root, 'packages/cli/dist/bin.js'),
      'build',
      '--config',
      options.joined
        ? 'fixtures/client-matrix-joined.config.ts'
        : 'fixtures/client-matrix.config.ts',
      '--target',
      'cloudflare',
      '--out',
      out,
    ],
    root,
    process.env,
    options,
  );
  checkResult(built, 'worker bundle');
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: out,
      modules: true,
      scriptPath: 'worker.js',
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      r2Buckets: ['STORAGE'],
      queueProducers: { JOBS: 'matrix-jobs' },
      ...(options.joined
        ? { queueConsumers: { 'matrix-jobs': { maxBatchSize: 1, maxBatchTimeout: 0 } } }
        : {}),
      bindings: { PB_MASTER_KEY: KEY, PB_PUBLIC_URL: origin, DEPLOYMENT_ID: 'client-matrix' },
      outboundService: options.fixture?.fetch ?? ((request) => fixtureReply(request, audits)),
      handleStructuredLogs: () => undefined,
    }),
  );
  cleanup.push(() => mf.dispose());
  const executor = createD1Executor(await mf.getD1Database('DB'));
  await migrate(executor, await discoveredMigrations(), { holder: 'client-matrix' });
  const seeded = await seed(executor, options);
  return {
    ...seeded,
    tick: async () => {
      const worker = await mf.getWorker();
      await worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *' });
    },
    dispatch: (request) =>
      mf.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        duplex: 'half',
        signal: AbortSignal.timeout(30_000),
      }),
  };
}

export async function fingerprintBuiltInputs(directory = root) {
  const entries = [];
  for await (const path of glob('packages/*/dist/**/*', {
    cwd: directory,
    exclude: ['**/*.map'],
  })) {
    if (!/\.(js|json)$/.test(path)) continue;
    entries.push([
      path,
      createHash('sha256')
        .update(await readFile(join(directory, path)))
        .digest('hex'),
    ]);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  assert.ok(entries.length > 0, 'Built input fingerprint missing');
  return Object.fromEntries(entries);
}

export function acceptanceIdentity(head, status, builtInputs, env = process.env) {
  const workingTreeDirty = status.trim().length > 0;
  return {
    head: head.trim(),
    workingTreeDirty,
    acceptance: !workingTreeDirty,
    reason: workingTreeDirty ? 'Working tree is dirty' : null,
    builtInputs,
    runId: env.PB_GATE_RUN_ID ?? env.GITHUB_RUN_ID ?? null,
  };
}

export async function verifyClientVersion(
  client,
  version,
  prepared,
  options,
  command = runCommand,
) {
  const installed = await command(client, ['--version'], prepared.project, prepared.env, options);
  checkVersion(installed, client, version);
}

export function blockYaml(settings) {
  return Object.entries(settings)
    .map(([key, value]) =>
      Array.isArray(value) && value.length > 0
        ? `${key}:\n${value.map((item) => `  - ${JSON.stringify(item)}`).join('\n')}`
        : `${key}: ${JSON.stringify(value)}`,
    )
    .join('\n')
    .concat('\n');
}

export async function configureJoinedConsumer(consumer, name) {
  // pnpm records fresh packages under minimumReleaseAgeExclude and cannot edit a flow-style mapping.
  const workspace = join(consumer.project, 'pnpm-workspace.yaml');
  await writeFile(workspace, blockYaml(JSON.parse(await readFile(workspace, 'utf8'))));
  const path = join(consumer.project, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(
    path,
    JSON.stringify({
      ...manifest,
      name: 'joined-consumer',
      dependencies: { [name]: '1.0.0' },
    }),
  );
}

export async function runMatrix({ client, version, verboseSteps = false, debug = false }) {
  await rm(join(root, '.pb', 'client-matrix', `acceptance-${client}.json`), { force: true });
  const builtInputs = await fingerprintBuiltInputs();
  const integrationEvidence = [];
  let nodeEvidence;
  let nodeLogin;
  for (const target of ['node', 'cloudflare']) {
    const scratch = join(root, '.pb', 'client-matrix');
    const step = (name, action) => matrixStep(`${target} ${client} ${name}`, action, verboseSteps);
    const directory = await step('scratch directory', async () => {
      await mkdir(scratch, { recursive: true });
      return mkdtemp(join(scratch, 'run-'));
    });
    const cleanup = [];
    const routes = [];
    const audits = [];
    try {
      const front = await step('bridge', () => frontServer(routes));
      cleanup.push(() => front.close());
      const boot = target === 'node' ? bootNode : bootWorker;
      const broker = await step('boot and seed', () =>
        boot(directory, front.origin, audits, cleanup, { debug }),
      );
      front.bind(broker.dispatch);
      await step('configure hosted publishing through API', async () => {
        const call = async (method, path, body, expected, extraHeaders = {}) => {
          const response = await broker.dispatch(
            new Request(front.origin + path, {
              method,
              headers: { ...broker.browserHeaders(front.origin), ...extraHeaders },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
          assert.equal(response.status, expected, 'Hosted source setup failed');
          return expected === 204 ? null : response.json();
        };
        for (const held of [false, true]) {
          const { id } = await call(
            'POST',
            '/_pb/sources',
            {
              name: held ? 'Held publishes' : 'Active publishes',
              ecosystem: 'npm',
              type: 'hosted',
              requirePublishApproval: false,
              defaultVisibleToNewProjects: true,
            },
            201,
          );
          const page = await call('GET', '/_pb/sources', undefined, 200);
          const source = page.items.find((item) => item.id === id);
          assert.equal(source.requirePublishApproval, false, 'Hosted approval default differs');
          await call('PATCH', `/_pb/sources/${id}`, { requirePublishApproval: held }, 204, {
            'If-Match': `"r${source.revision}"`,
          });
          for (const name of PUBLISH_PACKAGES.filter((name) =>
            name.endsWith(held ? 'held' : 'active'),
          ))
            await call('POST', `/_pb/sources/${id}/names`, { pattern: name }, 201);
          await call('POST', `/_pb/sources/${id}/enable`, undefined, 204);
          await call('PUT', `/_pb/projects/alpha/sources/${id}/attachment`, {}, 204);
        }
      });

      const { project, env } = await step('prepare client', () =>
        prepareClient(directory, client, `${front.origin}/alpha/npm/`, broker.token),
      );
      await step('version', async () => {
        await verifyClientVersion(client, version, { project, env }, { debug });
      });
      await step('login', async () => {
        const loginClient = await prepareClient(
          join(directory, 'login'),
          client,
          `${front.origin}/alpha/npm/`,
          '',
        );
        const evidence = await runLogin({ client, ...loginClient, front, broker, debug });
        await saveLoginCapture(scratch, target, evidence);
        if (target === 'node') nodeLogin = evidence;
        else {
          assert.equal(evidence.status, nodeLogin.status, 'Runtime login outcome differs');
          assertRuntimeParity(
            [...new Set(nodeLogin.requests.map((r) => JSON.stringify(r)))].sort(),
            [...new Set(evidence.requests.map((r) => JSON.stringify(r)))].sort(),
          );
          await writeFile(
            join(
              root,
              'packages/core/src/registry/npm/fixtures',
              `web-login-${client}-${version}.json`,
            ),
            JSON.stringify({ ...evidence, runtimes: ['node', 'cloudflare'] }, null, 2) + '\n',
          );
        }
        console.log(`client-matrix: ${target} ${client} login ${evidence.status}`);
      });
      const commands = clientCommands(client);
      for (const name of ['install', 'whoami', 'ping', 'audit']) {
        const command = commands[name];
        if (command === null) {
          console.log(
            `client-matrix: ${target} ${client} ${name} skipped (Yarn 4 has no ping command)`,
          );
          continue;
        }
        await step(name, async () => {
          const result = await runCommand(command.command, command.args, project, env, { debug });
          front.assertHealthy();
          checkResult(result, name, client);
        });
      }
      await step('installed packages', async () => {
        for (const name of PACKAGES) {
          checkInstalledPackage(
            name,
            await readFile(join(project, 'node_modules', name, 'package.json'), 'utf8'),
            await readFile(join(project, 'node_modules', name, 'index.js'), 'utf8'),
          );
        }
      });
      const management = [];
      for (const name of PUBLISH_PACKAGES) {
        await step(`publish ${name}`, async () => {
          const publishRoot = join(directory, 'publish-' + PUBLISH_PACKAGES.indexOf(name));
          const publisher = await preparePublisher(
            publishRoot,
            client,
            `${front.origin}/alpha/npm/`,
            broker.publishToken,
            name,
            { debug },
          );
          const command = commands.publish;
          const result = await runCommand(
            command.command,
            command.args,
            publisher.project,
            publisher.env,
            { debug },
          );
          front.assertHealthy();
          checkResult(result, 'publish', client);
          const held = name.endsWith('held');
          assert.ok(
            routes.includes(`publish:${name}:${held ? 202 : 201}`),
            'Missing real publish traffic',
          );
          const stored = await broker.inspectPublish(name);
          assert.equal(stored.length, 1, 'Missing published version');
          assert.equal(
            stored[0].status,
            held ? 'quarantined' : 'active',
            'Incorrect published state',
          );
          assert.equal(stored[0].refetchable, 0, 'Published blob must not be refetched');
          const read = await broker.dispatch(
            new Request(`${front.origin}/alpha/npm/${encodeURIComponent(name)}`, {
              headers: { authorization: `Bearer ${broker.token}` },
            }),
          );
          assert.equal(read.status, held ? 404 : 200, 'Incorrect published visibility');
          await read.body?.cancel();
          if (!held) management.push({ publisher, name });
        });
      }
      await step('npm API routes', async () => {
        const evidence = await runApiGate(broker, front.origin);
        if (target === 'node') nodeEvidence = evidence;
        else assertRuntimeParity(nodeEvidence, evidence, { debug });
      });
      for (const entry of management)
        await step(`management ${entry.name}`, async () => {
          await broker.prepareManagement(entry.name);
          await runManagement({ broker, origin: front.origin, client, directory, debug, ...entry });
          front.assertHealthy();
        });
      const forwardedBeforeRefusal = audits.length;
      await step('detach proxy', () => broker.detach());
      front.expectAudit(501);
      await step('audit-without-proxy', async () => {
        const refused = await runCommand(
          commands.audit.command,
          commands.audit.args,
          project,
          env,
          { debug },
        );
        checkResult(refused, 'audit-without-proxy');
        assert.equal(audits.length, forwardedBeforeRefusal, 'Refused audit contacted upstream');
        front.assertHealthy();
        checkTraffic(routes, audits, client);
      });
      const joined = await step('joined GA journeys', () =>
        runJoinedRuntime({
          boot,
          directory: join(directory, 'joined'),
          client,
          version,
          cleanup,
          debug,
        }),
      );
      // D1 refuses sqlite_version(); the workerd version in the artifact identifies its SQLite.
      const [backend] = target === 'node' ? await broker.backendVersion() : [{ version: null }];
      integrationEvidence.push({
        target,
        login: nodeLogin.status,
        routesVerified: true,
        joined,
        database: target === 'node' ? 'node:sqlite' : 'D1 (miniflare)',
        sqliteVersion: backend.version,
        blob: target === 'node' ? 'filesystem' : 'R2 (miniflare)',
      });
      console.log(
        `client-matrix: ${target} ${client} audit without proxy refused; all route evidence verified`,
      );
    } finally {
      await step('cleanup', async () => {
        const failures = [];
        for (const close of cleanup.reverse()) {
          try {
            await close();
          } catch {
            failures.push('cleanup failed');
          }
        }
        await rm(directory, { recursive: true, force: true });
        assert.equal(failures.length, 0, 'Client matrix cleanup failed');
      });
    }
  }
  assertIntegrationEvidence(integrationEvidence);
  const head = await runCommand('git', ['rev-parse', 'HEAD'], root, process.env, { debug });
  checkResult(head, 'acceptance head');
  const status = await runCommand('git', ['status', '--porcelain'], root, process.env, { debug });
  checkResult(status, 'acceptance working tree');
  assert.equal(
    JSON.stringify(await fingerprintBuiltInputs()),
    JSON.stringify(builtInputs),
    'Built inputs changed during gate',
  );
  await writeFile(
    join(root, '.pb', 'client-matrix', `acceptance-${client}.json`),
    JSON.stringify(
      {
        ...acceptanceIdentity(head.stdout, status.stdout, builtInputs),
        recordedAt: new Date().toISOString(),
        node: process.version,
        miniflare: require('miniflare/package.json').version,
        workerd: createRequire(require.resolve('miniflare'))('workerd/package.json').version,
        client,
        version,
        runtimes: integrationEvidence,
      },
      null,
      2,
    ) + '\n',
  );
  return integrationEvidence;
}

async function runJoinedRuntime({ boot, directory, client, version, cleanup, debug }) {
  const traffic = [];
  const front = await frontServer(
    [],
    async (request, response) => {
      traffic.push({
        method: request.method,
        path: decodeURIComponent(new URL(request.url).pathname),
        status: response.status,
      });
    },
    { checkRoutes: false },
  );
  cleanup.push(() => front.close());
  const fixture = createJoinedFixture([]);
  try {
    const broker = await boot(directory, front.origin, [], cleanup, {
      debug,
      joined: true,
      fixture,
    });
    front.bind(broker.dispatch);
    let sequence = 0;
    const execute = async (command, prepared) => {
      const result = await runCommand(
        command.command,
        command.args,
        prepared.project,
        prepared.env,
        {
          debug,
        },
      );
      front.assertHealthy();
      return result;
    };
    const evidence = await runJoinedJourneys({
      broker,
      origin: front.origin,
      scanner: fixture.scanner,
      repositoryTag: fixture.tag,
      publish: async (name, token, accepted = true) => {
        const publisher = await preparePublisher(
          join(directory, `publish-${sequence++}`),
          client,
          `${front.origin}/alpha/npm/`,
          token,
          name,
          { debug },
        );
        const start = traffic.length;
        const result = await execute(clientCommands(client).publish, publisher);
        const sent = traffic
          .slice(start)
          .filter((entry) => entry.method === 'PUT' && entry.path === `/alpha/npm/${name}`);
        assert.equal(sent.length, 1, 'Joined native publish traffic missing');
        assert.equal(
          accepted ? sent[0].status === 202 : [401, 403].includes(sent[0].status),
          true,
          'Joined publish result differs',
        );
        assert.equal(result.code === 0, accepted, 'Joined native publish outcome differs');
        if (sent[0].status === 401)
          assert.ok(
            traffic
              .slice(start)
              .filter((entry) => entry.path === '/alpha/npm/-/whoami')
              .every((entry) => entry.status === 401),
            'Refused publish token still authenticates',
          );
      },
      install: async (name, accepted) => {
        const consumer = await prepareClient(
          join(directory, `install-${sequence++}`),
          client,
          `${front.origin}/alpha/npm/`,
          broker.token,
        );
        await configureJoinedConsumer(consumer, name);
        await verifyClientVersion(client, version, consumer, { debug });
        const start = traffic.length;
        const result = await execute(clientCommands(client).install, consumer);
        const sent = traffic.slice(start);
        assert.ok(
          sent.some(
            (entry) =>
              entry.path === `/alpha/npm/${name}` && entry.status === (accepted ? 200 : 404),
          ),
          'Joined native metadata traffic missing',
        );
        assert.equal(result.code === 0, accepted, 'Joined native install outcome differs');
        if (accepted) {
          assert.ok(
            sent.some(
              (entry) => entry.path.startsWith(`/alpha/npm/${name}/-/`) && entry.status === 200,
            ),
            'Joined native archive traffic missing',
          );
          const metadata = JSON.parse(
            await readFile(join(consumer.project, 'node_modules', name, 'package.json'), 'utf8'),
          );
          assert.equal(metadata.name, name, 'Joined installed package name differs');
          assert.equal(metadata.version, '1.0.0', 'Joined installed package version differs');
          assert.equal(
            await readFile(join(consumer.project, 'node_modules', name, 'index.js'), 'utf8'),
            'module.exports = true;\n',
            'Joined installed package bytes differ',
          );
        }
      },
    });
    fixture.assertHealthy();
    fixture.assertTagListing();
    assert.ok(
      fixture.requests.some((request) =>
        request.startsWith('GET /repos/fixture/repository/tarball/'),
      ),
      'Repository archive fetch missing',
    );
    console.log(`client-matrix: ${client} joined GA journeys verified`);
    return evidence;
  } finally {
    fixture.dispose();
    fixture.assertHealthy();
  }
}
