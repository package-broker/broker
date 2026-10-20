import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, platform, arch } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_ROLES } from '@package-broker/core/authz/permissions';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { planMigrations } from '@package-broker/db-sqlite/migrations/plan';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor } from '@package-broker/runtime-cloudflare/db/d1-executor';

// Run after pnpm build && pnpm bundle. Every upstream response is synthetic and local.
const require = createRequire(
  import.meta.resolve('@package-broker/runtime-cloudflare/package.json'),
);
const { Miniflare, Response, convertV4MiniflareOptions } = require('miniflare');
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, '.pb', 'cloudflare');
const workerScript = join(outDir, 'worker.js');
const runFile = promisify(execFile);
const sampleIntervalMs = 25;
const children = new Set();
const trackChild = ({ process: child }) => {
  child.once('spawn', () => {
    if (!child.spawnargs.some((arg) => /^workerd(?:\.exe)?$/.test(basename(arg)))) return;
    children.add(child);
    child.once('close', () => children.delete(child));
  });
};
channel('child_process').subscribe(trackChild);

function fixture(bytes, versions) {
  const entries = Array.from({ length: versions }, (_, n) => [
    `1.0.${n}`,
    {
      name: 'pkg',
      version: `1.0.${n}`,
      description: '',
      dist: {
        integrity: `sha512-${'A'.repeat(86)}==`,
        tarball: `https://registry.npmjs.org/pkg/-/pkg-1.0.${n}.tgz`,
      },
    },
  ]);
  const document = { name: 'pkg', versions: Object.fromEntries(entries) };
  const length = () => Buffer.byteLength(JSON.stringify(document));
  const padding = Math.floor((bytes - length()) / versions);
  assert.ok(padding >= 0, 'too many versions for the target byte count');
  for (const [, version] of entries) version.description = 'x'.repeat(padding);
  entries.at(-1)[1].description += 'x'.repeat(bytes - length());
  const result = Buffer.from(JSON.stringify(document));
  assert.equal(result.length, bytes);
  return result;
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

async function benchmark(mib, versionCount, repetition, migrationPlan) {
  const bytes = fixture(mib * 1024 * 1024, versionCount);
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
      queueProducers: { JOBS: 'pb-fill-benchmark' },
      analyticsEngineDatasets: { ANALYTICS: { dataset: 'pb-fill-benchmark' } },
      handleStructuredLogs: () => undefined,
      outboundService(request) {
        if (request.url !== 'https://registry.npmjs.org/pkg') {
          outboundFailure = true;
          return new Response(null, { status: 502 });
        }
        upstreamRequests++;
        return new Response(bytes, {
          headers: { 'content-type': 'application/json', etag: '"fill-benchmark"' },
        });
      },
      bindings: {
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'https://broker.test',
        DEPLOYMENT_ID: 'fill-benchmark',
      },
    }),
  );
  try {
    const executor = createD1Executor(await mf.getD1Database('DB'));
    await migrate(executor, migrationPlan, { holder: 'fill-benchmark' });
    const orgId = ulid();
    const projectId = ulid();
    const sourceId = ulid();
    const now = new Date();
    await createOrganizationBootstrap(executor).bootstrap({
      id: orgId,
      slug: 'benchmark',
      name: 'Benchmark',
      now: now.toISOString(),
    });
    const setupToken = randomBytes(32).toString('base64url');
    assert.equal(
      await bootstrapAdmin(executor, orgContext(orgId), {
        email: 'admin@example.test',
        userId: ulid(),
        setupHash: createHash('sha256').update(setupToken).digest('hex'),
        setupExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        grantId: ulid(),
        roleIds: Object.fromEntries(DEFAULT_ROLES.map(({ key }) => [key, ulid()])),
        opId: ulid(),
        now: now.toISOString(),
      }),
      'created',
    );
    await executor.batch([
      {
        sql: "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'bench', 'Benchmark')",
        params: [projectId, orgId],
      },
      {
        sql: "INSERT INTO source (id, org_id, name, ecosystem, type, url, config_json, removal_policy) VALUES (?, ?, 'npm', 'npm', 'npmjs_proxy', 'https://registry.npmjs.org', '{}', 'flag')",
        params: [sourceId, orgId],
      },
      {
        sql: 'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        params: [orgId, projectId, sourceId],
      },
    ]);
    const post = (path, body) =>
      mf.dispatchFetch(`https://broker.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://broker.test' },
        body: JSON.stringify(body),
      });
    const started = await post('/_pb/auth/local/setup/start', { token: setupToken });
    assert.equal(started.status, 200, 'setup start failed');
    const secret = base32Decode((await started.json()).secret);
    const finished = await post('/_pb/auth/local/setup/finish', {
      token: setupToken,
      password: 'correct horse battery staple 42',
      code: await totpCode(secret, Math.floor(Date.now() / 30_000)),
    });
    assert.equal(finished.status, 204, 'setup finish failed');
    const cookie = finished.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
    assert.ok(cookie, 'missing session');
    assert.equal(children.size, 1, 'expected one workerd process');
    const [child] = children;
    const before = await sample(child.pid);
    const measured = await measure(child.pid, async () => {
      const response = await mf.dispatchFetch('https://broker.test/bench/npm/pkg', {
        headers: { cookie },
      });
      await response.arrayBuffer();
      return response.status;
    });
    const [applied] = await executor.all({
      sql: 'SELECT count(*) AS n FROM version WHERE org_id = ?',
      params: [orgId],
    });
    const queued = await executor.all({
      sql: "SELECT state FROM job WHERE org_id = ? AND type = 'core:package-sync:v1'",
      params: [orgId],
    });
    const validFill =
      !outboundFailure &&
      upstreamRequests >= 1 &&
      applied.n > 0 &&
      (measured.result === 200 ||
        (measured.result === 503 && queued.some((job) => job.state === 'queued')));
    console.log(
      JSON.stringify({
        mib,
        versionCount,
        repetition,
        status: measured.result,
        validFill,
        upstreamRequests,
        applied: applied.n,
        queued: queued.length,
        wallMs: Math.round(measured.wallMs),
        processCpuMs: measured.cpuMs,
        baselineRssMiB: before.rssMiB,
        peakProcessRssMiB: measured.rssMiB,
      }),
    );
    return validFill;
  } finally {
    await mf.dispose();
  }
}

try {
  const repeats = Number(process.env.FILL_BENCH_REPEATS ?? 3);
  assert.ok(Number.isSafeInteger(repeats) && repeats > 0);
  const plan = await migrations();
  console.log(
    JSON.stringify({
      host: `${platform()} ${arch()}`,
      cpu: cpus()[0]?.model,
      sampleIntervalMs,
      note: 'process RSS and process CPU include local D1/R2; neither is an isolate limit measurement',
    }),
  );
  let invalidFills = 0;
  for (let repetition = 1; repetition <= repeats; repetition++) {
    for (const mib of [32, 8, 4]) {
      if (!(await benchmark(mib, 10_000, repetition, plan))) invalidFills++;
    }
  }
  assert.equal(invalidFills, 0, 'one or more fills failed; see the per-case measurements');
} finally {
  channel('child_process').unsubscribe(trackChild);
}
