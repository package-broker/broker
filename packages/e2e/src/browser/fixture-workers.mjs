import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.env.PB_E2E_REPO_ROOT;
const port = Number(process.env.PB_E2E_PORT);
const email = process.env.PB_E2E_EMAIL;
if (!repoRoot || !Number.isInteger(port) || !email) {
  console.error('fixture-workers: PB_E2E_REPO_ROOT, PB_E2E_PORT and PB_E2E_EMAIL are required');
  process.exit(2);
}

const outDir = join(repoRoot, '.pb', 'cloudflare');
const worker = join(outDir, 'worker.js');
const origin = `https://127.0.0.1:${port}`;
const requireFrom = createRequire(join(repoRoot, 'packages', 'runtime-cloudflare', 'package.json'));
const load = (specifier) => import(pathToFileURL(requireFrom.resolve(specifier)).href);

const { Miniflare, convertV4MiniflareOptions } = await load('miniflare');
const { DEFAULT_ROLES } = await load('@package-broker/core/authz/permissions');
const { orgContext } = await load('@package-broker/core/db/port');
const { ulid } = await load('@package-broker/core/ids');
const { bootstrapAdmin } = await load('@package-broker/db-sqlite/repositories/admin-bootstrap');
const { createOrganizationBootstrap } = await load(
  '@package-broker/db-sqlite/repositories/organization',
);
const { loadMigrationSource } = await load('@package-broker/db-sqlite/migrations/source');
const { planMigrations } = await load('@package-broker/db-sqlite/migrations/plan');
const { migrate } = await load('@package-broker/db-sqlite/migrations/runner');
const { createD1Executor } = await load('@package-broker/runtime-cloudflare/db/d1-executor');

const manifest = JSON.parse(await readFile(join(outDir, 'generated', 'manifest.json'), 'utf8'));
const owners = [];
const sources = [];
for (const entry of manifest.migrations) {
  const owner = entry.id.slice(0, entry.id.indexOf(':'));
  if (!owners.includes(owner)) owners.push(owner);
  sources.push(
    await loadMigrationSource(
      owner,
      entry.name,
      await readFile(join(outDir, 'migrations', owner, entry.name), 'utf8'),
    ),
  );
}

const record = JSON.parse(await readFile(join(outDir, 'assets.json'), 'utf8')).descriptor;
const assets = { ...record, directory: resolve(outDir, record.directory) };
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    rootPath: dirname(worker),
    modules: true,
    scriptPath: basename(worker),
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
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
    r2Buckets: ['STORAGE'],
    queueProducers: { JOBS: 'pb-e2e-jobs' },
    analyticsEngineDatasets: { ANALYTICS: { dataset: 'pb-e2e' } },
    bindings: {
      PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      PB_PUBLIC_URL: origin,
      DEPLOYMENT_ID: 'e2e',
    },
  }),
  host: '127.0.0.1',
  port,
  https: true,
});

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  try {
    await mf.dispose();
  } finally {
    process.exit(code);
  }
}
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));

try {
  await mf.ready;
  const executor = createD1Executor(await mf.getD1Database('DB'));
  await migrate(executor, await planMigrations(sources, owners), { holder: 'e2e' });
  const orgId = ulid();
  const now = new Date();
  await createOrganizationBootstrap(executor).bootstrap({
    id: orgId,
    slug: 'e2e',
    name: 'E2E',
    now: now.toISOString(),
  });
  const token = randomBytes(32).toString('base64url');
  const bootstrapped = await bootstrapAdmin(executor, orgContext(orgId), {
    email,
    userId: ulid(),
    setupHash: createHash('sha256').update(token).digest('hex'),
    setupExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    grantId: ulid(),
    roleIds: Object.fromEntries(DEFAULT_ROLES.map(({ key }) => [key, ulid()])),
    opId: ulid(),
    now: now.toISOString(),
  });
  if (bootstrapped !== 'created') throw new Error(`admin bootstrap returned ${bootstrapped}`);
  process.stdout.write(`PB_E2E_READY ${JSON.stringify({ origin, token })}\n`);
} catch (error) {
  console.error(`fixture-workers: ${error instanceof Error ? error.message : 'failed'}`);
  await stop(1);
}
