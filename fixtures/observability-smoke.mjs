import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { planMigrations } from '@package-broker/db-sqlite/migrations/plan';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor } from '@package-broker/runtime-cloudflare/db/d1-executor';

const root = fileURLToPath(new URL('..', import.meta.url));
const traceId = 'ab'.repeat(16);
const headers = { traceparent: `00-${traceId}-${'cd'.repeat(8)}-01` };
const masterKey = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const selected = process.argv[2];
assert.ok(selected === undefined || ['node', 'cloudflare'].includes(selected));
await mkdir(join(root, '.pb'), { recursive: true });
const scratch = await mkdtemp(join(root, '.pb', 't749-smoke-'));

function check(records, trusted) {
  const requests = records.filter((record) => record?.event === 'http.request');
  assert.ok(requests.length > 0, 'expected an http.request log');
  for (const record of requests) {
    assert.match(record.trace_id, /^[a-f0-9]{32}$/);
    assert.equal(record.trace_id === traceId, trusted, 'inbound trace id trust');
  }
}

async function nodeSmoke(built, trusted) {
  const out = await realpath(await mkdtemp(join(tmpdir(), 'pb-t749-node-')));
  try {
    await cp(built, out, { recursive: true });
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {
      cwd: out,
      stdio: 'pipe',
    });
    await runNode(out, trusted);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

async function runNode(out, trusted) {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const child = spawn(process.execPath, [join(out, 'server.js')], {
    cwd: out,
    env: {
      ...process.env,
      PORT: String(port),
      PB_SQLITE_PATH: join(out, 'db.sqlite'),
      PB_BLOB_ROOT: join(out, 'blobs'),
      PB_MASTER_KEY: masterKey,
      PB_PUBLIC_URL: 'http://127.0.0.1',
      PB_ORG_SLUG: 'smoke',
      PB_ORG_NAME: 'Smoke',
      DEPLOYMENT_ID: 't749',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = once(child, 'exit');
  try {
    let response;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, 'server exited before request');
      try {
        response = await fetch(`http://127.0.0.1:${port}/health/live`, {
          headers,
          signal: AbortSignal.timeout(1000),
        });
        break;
      } catch {
        await delay(100);
      }
    }
    assert.equal(response?.status, 200);
    await response.text();
    child.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      delay(5000).then(() => {
        throw new Error('shutdown timeout');
      }),
    ]);
    assert.equal(result[0], 0);
    const records = output.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    check(records, trusted);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}

async function workerSmoke(out, trusted) {
  const require = createRequire(join(root, 'packages/runtime-cloudflare/package.json'));
  const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
  const records = [];
  // Normalize Worker console objects so the smoke can inspect structured records.
  const wrapper = join(out, 'smoke-worker.js');
  await writeFile(
    wrapper,
    `const log = console.log.bind(console);
const error = console.error.bind(console);
console.log = (value) => log(JSON.stringify(value));
console.error = (value) => error(JSON.stringify(value));
export { default } from './worker.js';\n`,
  );
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: dirname(wrapper),
      modules: [
        { type: 'ESModule', path: wrapper },
        { type: 'ESModule', path: join(out, 'worker.js') },
      ],
      compatibilityDate: '2026-10-01',
      d1Databases: ['DB'],
      r2Buckets: ['STORAGE'],
      queueProducers: { JOBS: 't749-jobs' },
      bindings: {
        PB_MASTER_KEY: masterKey,
        PB_PUBLIC_URL: 'https://broker.test',
        DEPLOYMENT_ID: 't749',
      },
      handleStructuredLogs: ({ message }) => {
        try {
          records.push(JSON.parse(message));
        } catch {
          /* workerd diagnostics */
        }
      },
    }),
  );
  try {
    const manifest = JSON.parse(await readFile(join(out, 'generated/manifest.json'), 'utf8'));
    const sources = [];
    const owners = [];
    for (const entry of manifest.migrations) {
      const owner = entry.id.slice(0, entry.id.indexOf(':'));
      if (!owners.includes(owner)) owners.push(owner);
      sources.push(
        await loadMigrationSource(
          owner,
          entry.name,
          await readFile(join(out, 'migrations', owner, entry.name), 'utf8'),
        ),
      );
    }
    await migrate(
      createD1Executor(await mf.getD1Database('DB')),
      await planMigrations(sources, owners),
      { holder: 't749' },
    );
    const response = await mf.dispatchFetch('https://broker.test/health/live', { headers });
    assert.equal(response.status, 200);
    await response.text();
    for (
      let attempt = 0;
      attempt < 20 && !records.some((record) => record?.event === 'http.request');
      attempt++
    )
      await delay(50);
    check(records, trusted);
  } finally {
    await mf.dispose();
  }
}

try {
  for (const target of selected === undefined ? ['node', 'cloudflare'] : [selected]) {
    for (const trusted of [true, false]) {
      const out = join(scratch, `${target}-${trusted}`);
      execFileSync(
        process.execPath,
        [
          join(root, 'packages/cli/dist/bin.js'),
          'build',
          '--config',
          join(root, `fixtures/observability-${trusted ? 'trusted' : 'base'}.config.ts`),
          '--target',
          target,
          '--out',
          out,
        ],
        { cwd: root, stdio: 'pipe' },
      );
      await (target === 'node' ? nodeSmoke(out, trusted) : workerSmoke(out, trusted));
      console.log(`T749 ${target}: ${trusted ? 'trusted' : 'absent'} flag passed`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
