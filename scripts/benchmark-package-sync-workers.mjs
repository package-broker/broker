import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, platform, release, arch, totalmem } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { planMigrations } from '@package-broker/db-sqlite/migrations/plan';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor } from '@package-broker/runtime-cloudflare/db/d1-executor';

// Run after pnpm build && pnpm bundle. No hosted service or public registry is contacted.
const require = createRequire(
  import.meta.resolve('@package-broker/runtime-cloudflare/package.json'),
);
const { Miniflare, Response, convertV4MiniflareOptions } = require('miniflare');
const runFile = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, '.pb', 'cloudflare');
const workerScript = join(outDir, 'worker.js');
// Composer p2 caps a document at 16 MiB and 20,000 versions (core ingest/composer/v2-package.ts).
const sizes = {
  npm: { versionCount: 100_000, fixtureBytes: 32 * 1024 * 1024 },
  composer: { versionCount: 20_000, fixtureBytes: 16 * 1024 * 1024 - 64 * 1024 },
};
const jobType = 'core:package-sync:v1';
const queueName = 'pb-benchmark-package-sync';
const sampleIntervalMs = 100;
const memoryLimitMiB = 128;
const wrangler = await readFile(join(root, 'packages/runtime-cloudflare/wrangler.toml'), 'utf8');
const configuredCpuMs = /^\s*cpu_ms\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(wrangler);
const cpuLimitMs = configuredCpuMs === null ? 30_000 : Number(configuredCpuMs[1]);
const children = new Set();
const childChannel = channel('child_process');
const trackChild = ({ process: child }) => {
  child.once('spawn', () => {
    if (!child.spawnargs.some((arg) => /^workerd(?:\.exe)?$/.test(basename(arg)))) return;
    children.add(child);
    child.once('close', () => children.delete(child));
  });
};
childChannel.subscribe(trackChild);

function fixture(ecosystem) {
  const { versionCount, fixtureBytes } = sizes[ecosystem];
  const key = ecosystem === 'npm' ? 'pkg' : 'acme/pkg';
  const versions = Array.from({ length: versionCount }, (_, n) => ({
    name: key,
    version: `1.0.${n}`,
    dist:
      ecosystem === 'npm'
        ? {
            integrity: `sha512-${'A'.repeat(86)}==`,
            tarball: `https://registry.npmjs.org/pkg/-/pkg-1.0.${n}.tgz`,
          }
        : { type: 'zip', url: `https://archives.example.test/pkg-1.0.${n}.zip` },
    description: '',
  }));
  const document = () =>
    JSON.stringify(
      ecosystem === 'npm'
        ? { name: key, versions: Object.fromEntries(versions.map((v) => [v.version, v])) }
        : { packages: { [key]: versions } },
    );
  const padding = Math.floor((fixtureBytes - Buffer.byteLength(document())) / versionCount);
  assert.ok(padding >= 0, 'fixture exceeds target size');
  for (const version of versions) version.description = 'x'.repeat(padding);
  versions.at(-1).description += 'x'.repeat(fixtureBytes - Buffer.byteLength(document()));
  const bytes = Buffer.from(document());
  assert.equal(bytes.byteLength, fixtureBytes);
  return { key, bytes, versionCount };
}

function cpuMilliseconds(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  assert.ok(match, 'unsupported ps CPU time format');
  return (
    (Number(match[1] ?? 0) * 86400 +
      Number(match[2] ?? 0) * 3600 +
      Number(match[3]) * 60 +
      Number(match[4])) *
    1000
  );
}

async function sample(pid) {
  const { stdout } = await runFile('ps', ['-o', 'rss=,time=', '-p', String(pid)]);
  const fields = stdout.trim().split(/\s+/);
  assert.equal(fields.length, 2, 'workerd process disappeared');
  const rssMiB = Number(fields[0]) / 1024;
  assert.ok(Number.isFinite(rssMiB) && rssMiB > 0, 'invalid ps RSS');
  return { rssMiB, cpuMs: cpuMilliseconds(fields[1]) };
}

async function measure(pid, invoke) {
  const before = await sample(pid);
  let peak = before.rssMiB;
  let stopped = false;
  let timer;
  let wake;
  const polling = (async () => {
    while (!stopped) {
      await new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, sampleIntervalMs);
      });
      if (stopped) break;
      peak = Math.max(peak, (await sample(pid)).rssMiB);
    }
  })();
  // Attach immediately so a sampling failure is handled while the invocation is running.
  let samplingError;
  void polling.catch((error) => {
    samplingError = error;
  });
  const started = performance.now();
  try {
    const result = await invoke();
    const wallMs = performance.now() - started;
    stopped = true;
    clearTimeout(timer);
    wake?.();
    await polling;
    if (samplingError !== undefined) throw samplingError;
    const after = await sample(pid);
    peak = Math.max(peak, after.rssMiB);
    assert.ok(after.cpuMs >= before.cpuMs, 'workerd CPU counter moved backwards');
    return { result, wallMs, cpuMs: after.cpuMs - before.cpuMs, rssMiB: peak };
  } finally {
    stopped = true;
    clearTimeout(timer);
    wake?.();
    await polling.catch(() => undefined);
  }
}

function socketClosed(error) {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(cause.code)) return true;
  }
  return false;
}

// Miniflare's Node-side binding proxy can reuse a keep-alive socket that workerd has
// already closed after a long invocation; harness reads and the idempotent enqueue are retried.
function retryingExecutor(executor) {
  const retried =
    (method) =>
    async (...args) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await executor[method](...args);
        } catch (error) {
          if (attempt >= 5 || !socketClosed(error)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    };
  return { ...executor, all: retried('all'), batch: retried('batch') };
}

async function migrations() {
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
  return planMigrations(sources, owners);
}

async function benchmark(ecosystem, migrationPlan) {
  const { key, bytes, versionCount } = fixture(ecosystem);
  const origin = ecosystem === 'npm' ? 'https://registry.npmjs.org' : 'https://repo.packagist.org';
  const mainPath = ecosystem === 'npm' ? '/pkg' : '/p2/acme/pkg.json';
  const devPath = '/p2/acme/pkg~dev.json';
  let upstreamRequests = 0;
  let outboundFailure = false;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: dirname(workerScript),
      host: '127.0.0.1',
      modules: true,
      scriptPath: basename(workerScript),
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      r2Buckets: ['STORAGE'],
      queueProducers: { JOBS: queueName },
      analyticsEngineDatasets: { ANALYTICS: { dataset: 'pb-benchmark' } },
      handleStructuredLogs: () => undefined,
      outboundService(request) {
        const url = new URL(request.url);
        const dev = ecosystem === 'composer' && url.pathname === devPath;
        if (url.origin !== origin || (url.pathname !== mainPath && !dev)) {
          outboundFailure = true;
          return new Response(null, { status: 502 });
        }
        upstreamRequests++;
        return new Response(dev ? JSON.stringify({ packages: { [key]: [] } }) : bytes, {
          headers: { 'content-type': 'application/json', etag: '"benchmark"' },
        });
      },
      bindings: {
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'https://broker.test',
        DEPLOYMENT_ID: 'benchmark',
      },
    }),
  );
  try {
    const executor = retryingExecutor(createD1Executor(await mf.getD1Database('DB')));
    assert.equal(children.size, 1, 'expected exactly one workerd child');
    const [child] = children;
    const pid = child.pid;
    assert.ok(pid, 'workerd PID missing');
    await migrate(executor, migrationPlan, { holder: 'benchmark' });
    const ctx = orgContext(ulid());
    await createOrganizationBootstrap(executor).bootstrap({
      id: ctx.orgId,
      slug: 'benchmark',
      name: 'Benchmark',
      now: new Date().toISOString(),
    });
    const sourceId = ulid();
    await executor.batch([
      {
        sql: `INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json, removal_policy)
              VALUES (?, ?, 'benchmark', ?, ?, ?, '{}', 'flag')`,
        params: [
          sourceId,
          ctx.orgId,
          ecosystem,
          ecosystem === 'npm' ? 'npmjs_proxy' : 'packagist_proxy',
          origin,
        ],
      },
    ]);
    const jobs = createJobRepository(executor);
    const id = ulid();
    await jobs.enqueue(ctx, {
      id,
      type: jobType,
      payloadJson: JSON.stringify({ sourceId, key }),
      idempotencyKey: id,
      resourceKey: null,
      runAt: null,
      maxAttempts: 25,
      projectId: null,
      initiatorTokenId: null,
    });
    const entry = await mf.getWorker();
    const applied = async () => {
      const [row] = await executor.all({
        sql: 'SELECT count(*) AS n FROM version WHERE org_id = ?',
        params: [ctx.orgId],
      });
      return row.n;
    };
    console.log(
      `\n### ${ecosystem} — ${bytes.length} bytes / ${versionCount} versions; workerd PID ${pid}`,
    );
    console.log('| Invocation | Wall ms | CPU ms delta | RSS peak MiB | Versions applied |');
    console.log('| ---: | ---: | ---: | ---: | ---: |');
    let invocation = 0;
    let previous = 0;
    let maxCpuMs = 0;
    let peakRssMiB = 0;
    const aboveHalfCpu = [];
    const aboveHalfMemory = [];
    for (;;) {
      const pending = await executor.all({
        sql: "SELECT id FROM job WHERE org_id = ? AND type = ? AND state <> 'succeeded' ORDER BY id",
        params: [ctx.orgId, jobType],
      });
      if (pending.length === 0) break;
      assert.equal(pending.length, 1, 'expected one continuation');
      const job = pending[0].id;
      const status = await jobs.status(ctx, job);
      assert.equal(status.state, 'queued', 'continuation is not queued');
      // Match the durable job notification delivered by the Queues adapter, one message at a time.
      const measured = await measure(pid, () =>
        entry.queue(queueName, [
          { id: job, timestamp: new Date(), attempts: 1, body: { v: 1, org: ctx.orgId, job } },
        ]),
      );
      assert.equal(measured.result.outcome, 'ok', 'queue invocation failed');
      const settled = await jobs.status(ctx, job);
      assert.equal(
        settled.state,
        'succeeded',
        `package-sync job failed: ${JSON.stringify({ lastErrorCode: settled.lastErrorCode, history: settled.history, wallMs: Math.round(measured.wallMs) })}`,
      );
      assert.equal(outboundFailure, false, 'unexpected outbound request refused');
      const total = await applied();
      invocation++;
      console.log(
        `| ${invocation} | ${measured.wallMs.toFixed(1)} | ${measured.cpuMs.toFixed(0)} | ${measured.rssMiB.toFixed(2)} | ${total - previous} |`,
      );
      maxCpuMs = Math.max(maxCpuMs, measured.cpuMs);
      peakRssMiB = Math.max(peakRssMiB, measured.rssMiB);
      if (measured.cpuMs > cpuLimitMs / 2) aboveHalfCpu.push(invocation);
      if (measured.rssMiB > memoryLimitMiB / 2) aboveHalfMemory.push(invocation);
      previous = total;
    }
    assert.ok(invocation > 1, 'fill must span multiple invocations');
    assert.equal(previous, versionCount, 'fill did not apply every version');
    const sessions = await executor.all({
      sql: 'SELECT state FROM ingest_session WHERE org_id = ? AND source_id = ? AND package_key = ?',
      params: [ctx.orgId, sourceId, key],
    });
    assert.deepEqual(
      sessions.map(({ state }) => state),
      ['complete'],
    );
    assert.ok(upstreamRequests > 0, 'upstream fixture was never requested');
    console.log(
      `Summary: ${JSON.stringify({ ecosystem, invocations: invocation, versions: previous, maxCpuMs, peakRssMiB, upstreamRequests, cpuLimitMs, memoryLimitMiB, aboveHalfCpu, aboveHalfMemory })}`,
    );
  } finally {
    await mf.dispose();
  }
}

try {
  console.log(
    `Machine: ${platform()} ${release()} ${arch()}; ${cpus()[0]?.model}; ${cpus().length} logical CPUs; ${(totalmem() / 1024 ** 3).toFixed(1)} GiB RAM; Node ${process.version}`,
  );
  console.log(
    'Local workerd process proxy: ps cumulative CPU delta and absolute RSS sampled before, every 100 ms, and after each queue invocation. CPU resolution depends on ps (typically 10 ms). RSS includes all Miniflare services in the child; sampling can miss brief peaks. No per-isolate CPU/memory counters are exposed by the Miniflare queue result.',
  );
  console.log(
    `Reference limits: ${memoryLimitMiB} MiB memory; ${cpuLimitMs} ms CPU (${configuredCpuMs === null ? 'Workers Paid default; no wrangler.toml override' : 'wrangler.toml cpu_ms'}). Summary flags identify invocations above 50%; no limit comparison changes the exit status.`,
  );
  await sample(process.pid);
  const migrationPlan = await migrations();
  for (const ecosystem of ['npm', 'composer']) await benchmark(ecosystem, migrationPlan);
} catch (error) {
  console.error(error instanceof Error ? error.stack : 'benchmark failed');
  for (let cause = error?.cause; cause instanceof Error; cause = cause.cause) {
    console.error(`caused by: ${cause.code ?? cause.name}: ${cause.message}`);
  }
  process.exitCode = 1;
} finally {
  childChannel.unsubscribe(trackChild);
}
