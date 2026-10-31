import { runApiGate, assertRuntimeParity } from './client-matrix-api.mjs';
import { runLogin, saveLoginCapture } from './client-matrix-login.mjs';
import { hashPassword } from '../packages/core/dist/auth/password.js';
import { sha256Hex } from '../packages/core/dist/auth/primitives.js';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

export async function seed(executor) {
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
  for (const held of [false, true]) {
    const sourceId = ulid();
    await sql(
      "INSERT INTO source (id, org_id, name, ecosystem, type, require_publish_approval, default_visible_to_new_projects) VALUES (?, ?, ?, 'npm', 'hosted', ?, 1)",
      [sourceId, orgId, held ? 'Held publishes' : 'Active publishes', Number(held)],
    );
    await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
      orgId,
      projectId,
      sourceId,
    ]);
    for (const name of PUBLISH_PACKAGES.filter((name) => name.endsWith(held ? 'held' : 'active'))) {
      await sql(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'npm', ?)",
        [ulid(), orgId, sourceId, name],
      );
    }
  }
  const oidcPublisherId = ulid();
  const oidcPrincipal = ulid();
  await sql('INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES (?,?,?,?)', [
    oidcPrincipal,
    orgId,
    'Trusted publisher',
    userId,
  ]);
  await sql(
    "INSERT INTO service_principal_permission (org_id,service_principal_id,permission) VALUES (?,?,'org:packages:publish')",
    [orgId, oidcPrincipal],
  );
  await sql(
    "INSERT INTO trusted_publisher (id,org_id,package_name,repository_id,repository_owner_id,repository,workflow,environment,service_principal_id,created_by_user_id) VALUES (?,?,'matrix-publish-active','123','456','fixture/repository','publish.yml','',?,?)",
    [oidcPublisherId, orgId, oidcPrincipal, userId],
  );
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

async function frontServer(routes) {
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
      if (!(onLogin && url.pathname.endsWith('/-/whoami')))
        await observeResponse(routes, request, response, auditStatus);
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

async function bootNode(directory, origin, audits, cleanup) {
  const db = await openMigratedDatabase();
  cleanup.push(() => db.close());
  const seeded = await seed(db.executor);
  const broker = createNodeServerWithSeams(
    [],
    {
      executor: db.executor,
      auth: { keyring, publicOrigin: origin, env: {} },
      platformServices: {
        blob: await openMatrixBlobStore(db.executor, directory, origin),
        cache: createLruCache({}),
        jobStore: createJobRepository(db.executor),
      },
      registry: { config: resolveRegistryConfig(undefined, 'node', origin) },
      log: () => undefined,
    },
    { transport: (input, init) => fixtureReply(new Request(input, init), audits) },
  );
  cleanup.push(() => broker.close());
  await broker.ready();
  broker.server.listen(0, '127.0.0.1');
  await once(broker.server, 'listening');
  const base = `http://127.0.0.1:${broker.server.address().port}`;
  return {
    ...seeded,
    dispatch: async (request) =>
      fetch(base + new URL(request.url).pathname + new URL(request.url).search, {
        method: request.method,
        headers: { ...Object.fromEntries(request.headers), host: new URL(origin).host },
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
        signal: AbortSignal.timeout(30_000),
      }),
  };
}

async function bootWorker(directory, origin, audits, cleanup, options) {
  const out = join(directory, 'worker');
  const built = await runCommand(
    process.execPath,
    [
      join(root, 'packages/cli/dist/bin.js'),
      'build',
      '--config',
      'fixtures/client-matrix.config.ts',
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
      bindings: { PB_MASTER_KEY: KEY, PB_PUBLIC_URL: origin, DEPLOYMENT_ID: 'client-matrix' },
      outboundService: (request) => fixtureReply(request, audits),
      handleStructuredLogs: () => undefined,
    }),
  );
  cleanup.push(() => mf.dispose());
  const executor = createD1Executor(await mf.getD1Database('DB'));
  await migrate(executor, await discoveredMigrations(), { holder: 'client-matrix' });
  const seeded = await seed(executor);
  return {
    ...seeded,
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

export async function runMatrix({ client, version, verboseSteps = false, debug = false }) {
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
      const { project, env } = await step('prepare client', () =>
        prepareClient(directory, client, `${front.origin}/alpha/npm/`, broker.token),
      );
      await step('version', async () => {
        const installed = await runCommand(client, ['--version'], project, env, { debug });
        checkVersion(installed, client, version);
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
        });
      }
      await step('npm API routes', async () => {
        const evidence = await runApiGate(broker, front.origin);
        if (target === 'node') nodeEvidence = evidence;
        else assertRuntimeParity(nodeEvidence, evidence, { debug });
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
      integrationEvidence.push({ target, login: nodeLogin.status, routesVerified: true });
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
  return integrationEvidence;
}
