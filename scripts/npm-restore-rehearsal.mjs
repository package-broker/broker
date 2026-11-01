import { once } from 'node:events';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  harnessAssert as assert,
  preparePublisher,
  prepareClient,
  runCommand,
} from './client-matrix.mjs';

const names = ['matrix-publish-active', 'restore-built'];
const content = 'module.exports = true;\n';

export function checkInstalled(name, metadata, bytes) {
  let manifest;
  try {
    manifest = JSON.parse(metadata);
  } catch {
    throw new Error('Invalid installed manifest');
  }
  assert.equal(manifest.name, name, 'Installed name mismatch');
  assert.equal(manifest.version, '1.0.0', 'Installed version mismatch');
  assert.equal(bytes, content, 'Installed file mismatch');
}

export function checkEvidence(evidence) {
  for (const key of ['published', 'built', 'sourceRemoved', 'freshTarget'])
    assert.equal(evidence[key], true, 'Restore stage missing');
  assert.equal(evidence.restoredObjects, 2, 'Both blob origins must be restored');
  assert.equal(JSON.stringify(evidence.installed), JSON.stringify(names), 'Both installs required');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function rehearse({ storageOnly = false } = {}) {
  const root = resolve(import.meta.dirname, '..');
  const load = (path) => import(pathToFileURL(join(root, 'packages', path)).href);
  const [
    helpers,
    dbModule,
    migrations,
    runner,
    matrix,
    startup,
    blob,
    blobRepo,
    catalogue,
    guards,
    dist,
    codecs,
    git,
    contexts,
  ] = await Promise.all([
    load('runtime-node/dist/restore-rehearsal/rehearsal.test.support.js'),
    load('runtime-node/dist/db/better-sqlite3-executor.js'),
    load('db-sqlite/dist/testing/migrated-database.js'),
    load('db-sqlite/dist/migrations/runner.js'),
    import('./client-matrix-runtime.mjs'),
    load('runtime-node/dist/startup.js'),
    load('core/dist/platform/blob.js'),
    load('db-sqlite/dist/repositories/blob.js'),
    load('db-sqlite/dist/repositories/catalogue-writer.js'),
    load('db-sqlite/dist/repositories/catalogue-write-package.js'),
    load('core/dist/ingest/dist-fetch.js'),
    load('runtime-node/dist/codec/node-codec.js'),
    load('core/dist/ingest/vcs/git-tar.js'),
    load('core/dist/db/port.js'),
  ]);
  const filesystem = await load('runtime-node/dist/blob/filesystem.js');
  await mkdir(join(root, '.pb'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.pb', 'npm-restore-'));
  const source = helpers.deploymentPaths(join(scratch, 'source'));
  const target = helpers.deploymentPaths(join(scratch, 'restored'));
  const backup = join(scratch, 'backup');
  const key = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
  const probe = createServer();
  let broker;
  let opened;
  try {
    let port = 8787;
    if (!storageOnly) {
      probe.listen(0, '127.0.0.1');
      await once(probe, 'listening');
      port = probe.address().port;
      await new Promise((done) => probe.close(done));
    }
    const origin = `http://127.0.0.1:${port}`;
    const registry = `${origin}/alpha/npm/`;
    const plan = await migrations.discoveredMigrations();
    async function backupSource() {
      const manifest = await helpers.backupDeployment(source, backup);
      manifest.configuration.publicUrl = origin;
      await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
      return manifest;
    }
    async function boot(paths) {
      broker = await startup.startNode({
        plugins: [],
        migrations: plan,
        env: {
          PB_SQLITE_PATH: paths.database,
          PB_BLOB_ROOT: paths.blobRoot,
          PB_MASTER_KEY_FILE: join(paths.secrets, 'master-key'),
          PB_PUBLIC_URL: origin,
          DEPLOYMENT_ID: 'npm-restore-rehearsal',
        },
        platformPorts: {
          blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1048576 },
          cache: { adapter: 'lru' },
          jobs: { adapter: 'database', maxRunning: 1 },
          observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
        },
        stdout: { write: () => true, on: () => undefined },
        stderr: { write: () => true, on: () => undefined },
      });
      await broker.ready();
      broker.server.listen(port, '127.0.0.1');
      await once(broker.server, 'listening');
    }
    await mkdir(source.secrets, { recursive: true, mode: 0o700 });
    await writeFile(join(source.secrets, 'master-key'), key, { mode: 0o600 });
    opened = dbModule.openBetterSqliteExecutor(source.database);
    await runner.migrate(opened.executor, plan, { holder: 'npm-restore' });
    const seeded = await matrix.seed(opened.executor);
    const org = contexts.orgContext(seeded.orgId);
    const sql = (sql, params) => opened.executor.batch([{ sql, params }]);
    // The local tree exercises the shipped Git archive and npm packlist builders without a remote.
    const commit = 'a'.repeat(40);
    const files = {
      'package.json': JSON.stringify({
        name: names[1],
        version: '1.0.0',
        main: 'index.js',
        files: ['index.js'],
      }),
      'index.js': content,
    };
    const archive = await git.gitTarball(
      {
        commit,
        committedAt: '2026-01-01T00:00:00Z',
        skipped: 0,
        entries: Object.keys(files).map((path) => ({
          path,
          oid: path,
          mode: '100644',
          type: 'blob',
        })),
      },
      {
        read: async (oid) => {
          const bytes = new TextEncoder().encode(files[oid]);
          return { size: bytes.length, body: new Blob([bytes]).stream() };
        },
      },
      codecs.nodeCodecs,
      new AbortController().signal,
    );
    const archiveBytes = await new Response(archive).arrayBuffer();
    await sql(
      "INSERT INTO source (id,org_id,name,ecosystem,type) VALUES ('restore-source',?,'Repository fixture','npm','vcs')",
      [seeded.orgId],
    );
    await sql(
      "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('restore-claim',?,'restore-source','npm',?)",
      [seeded.orgId, names[1]],
    );
    await sql(
      "INSERT INTO project_source (org_id,project_id,source_id) VALUES (?,?,'restore-source')",
      [seeded.orgId, seeded.projectId],
    );
    await sql(
      "INSERT INTO package (id,org_id,source_id,ecosystem,name,last_synced_at) VALUES ('restore-package',?,'restore-source','npm',?,'2026-01-01T00:00:00Z')",
      [seeded.orgId, names[1]],
    );
    await sql(
      "INSERT INTO project_package (org_id,project_id,package_id,origin,ecosystem,name) VALUES (?,?,'restore-package','subscription','npm',?)",
      [seeded.orgId, seeded.projectId, names[1]],
    );
    await sql(
      "INSERT INTO version (id,org_id,package_id,version,version_normalized,published_at,published_at_basis,metadata_json,dist_type,source_ref) VALUES ('restore-version',?,'restore-package','1.0.0','1.0.0','2026-01-01T00:00:00Z','broker',?,'tgz',?)",
      [seeded.orgId, JSON.stringify(JSON.parse(files['package.json'])), commit],
    );
    await sql(
      "INSERT INTO dist_tag (org_id,package_id,tag,version_id) VALUES (?,'restore-package','latest','restore-version')",
      [seeded.orgId],
    );
    await sql(
      "INSERT INTO job (id,org_id,type,idempotency_key,state,lease_owner,lease_until,fence) VALUES ('restore-job',?,'core:npm-vcs-build:v1','restore-build','running','restore-worker','2999-01-01T00:00:00Z',1)",
      [seeded.orgId],
    );
    const store = blob.createBlobStore(
      await filesystem.openFilesystemByteStore({ root: source.blobRoot }),
      blobRepo.createBlobRepository(opened.executor),
      { admission: blob.createBlobUploadAdmission(), maxBytes: 64 * 1024 * 1024 },
    );
    const built = await dist.buildNpmVcsDist(
      {
        source: {
          id: 'restore-source',
          type: 'vcs',
          ecosystem: 'npm',
          url: null,
          config: { provider: 'git', refs: { tags: true, branches: [] } },
        },
        providerContext: { codecs: codecs.nodeCodecs, signal: new AbortController().signal },
        provider: {
          openDist: async () => ({
            size: archiveBytes.byteLength,
            body: new Blob([archiveBytes]).stream(),
          }),
        },
        store,
        writer: catalogue.createCatalogueWriter(opened.executor),
        maxBytes: 1048576,
      },
      org,
      guards.createCatalogueWriteGuard(org, {
        id: 'restore-job',
        owner: 'restore-worker',
        fence: 1,
      }),
      {
        versionId: 'restore-version',
        revision: 1,
        packageName: names[1],
        version: '1.0.0',
        previousBlob: null,
        fetch: {
          distType: 'tgz',
          sourceRef: commit,
          upstreamDistUrl: null,
          npmIntegrity: null,
          npmShasum: null,
          composerShasum: null,
        },
      },
    );
    assert.equal(built, 'attached', 'Repository build must attach bytes');
    // Remove upstream fixtures so no restore read can silently repopulate a missing object.
    await sql(
      "DELETE FROM project_source WHERE org_id=? AND source_id IN (SELECT id FROM source WHERE org_id=? AND type IN ('npmjs_proxy','npm_registry'))",
      [seeded.orgId, seeded.orgId],
    );
    await opened.close();
    opened = undefined;
    if (storageOnly) {
      const manifest = await backupSource();
      await helpers.destroyDeployment(source);
      const restored = await helpers.restoreDeployment(backup, target);
      assert.equal(manifest.objects.length, 1, 'Repository blob missing');
      assert.equal(
        restored.missingBlobs.length + restored.corruptBlobs.length,
        0,
        'Storage restore failed',
      );
      console.log(
        'npm restore rehearsal: storage-only PASS (repository build and restore; publish/install acceptance NOT RUN)',
      );
      return;
    }
    await boot(source);
    const publisher = await preparePublisher(
      join(scratch, 'publisher'),
      'npm',
      registry,
      seeded.publishToken,
      names[0],
    );
    const published = await runCommand(
      'npm',
      ['publish', '--provenance=false', '--ignore-scripts'],
      publisher.project,
      publisher.env,
    );
    assert.equal(published.code, 0, 'npm publish failed');
    await broker.close();
    broker = undefined;
    const manifest = await backupSource();
    await helpers.destroyDeployment(source);
    const sourceRemoved = !(await exists(source.root));
    const freshTarget = !(await exists(target.root));
    const result = await helpers.restoreDeployment(backup, target);
    assert.equal(
      result.missingBlobs.length + result.corruptBlobs.length,
      0,
      'Restore inventory failed',
    );
    await boot(target);
    const consumer = await prepareClient(join(scratch, 'consumer'), 'npm', registry, seeded.token);
    await writeFile(
      join(consumer.project, 'package.json'),
      JSON.stringify({
        private: true,
        dependencies: Object.fromEntries(names.map((name) => [name, '1.0.0'])),
      }),
    );
    const installed = await runCommand(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
      consumer.project,
      consumer.env,
    );
    assert.equal(installed.code, 0, 'Restored npm install failed');
    const installedNames = [];
    for (const name of names) {
      checkInstalled(
        name,
        await readFile(join(consumer.project, 'node_modules', name, 'package.json'), 'utf8'),
        await readFile(join(consumer.project, 'node_modules', name, 'index.js'), 'utf8'),
      );
      installedNames.push(name);
    }
    const evidence = {
      published: published.code === 0,
      built: built === 'attached',
      sourceRemoved,
      freshTarget,
      restoredObjects: manifest.objects.length,
      installed: installedNames,
    };
    checkEvidence(evidence);
    console.log(
      'npm restore rehearsal: PASS (published + repository-built; fresh SQLite, keys, blobs; empty-cache npm install)',
    );
    return evidence;
  } finally {
    if (probe.listening) await new Promise((done) => probe.close(done));
    try {
      await broker?.close();
    } finally {
      try {
        await opened?.close();
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.ok(
      process.argv.slice(2).every((arg) => arg === '--storage-only'),
      'Unsupported rehearsal arguments',
    );
    await rehearse({ storageOnly: process.argv.includes('--storage-only') });
  } catch {
    console.error(
      'npm restore rehearsal: FAIL (build prerequisites or rehearsal step failed; private diagnostics suppressed)',
    );
    process.exitCode = 1;
  }
}
