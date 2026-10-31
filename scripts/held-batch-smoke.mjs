import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { planMigrations } from '@package-broker/db-sqlite/migrations/plan';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createD1Executor } from '@package-broker/runtime-cloudflare/db/d1-executor';

const root = fileURLToPath(new URL('..', import.meta.url));
const key = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const wrongKey = 'pbmk_v1_'.concat(
  Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString('base64url'),
);
const hostilePort =
  'T767-secret\nBearer t767-credential\r\nhttps://user:password@host.test/private';

export function assertPrivate(text) {
  for (const value of [
    'T767-secret',
    't767-credential',
    'user:password',
    'account@t767.test',
    'pbmk_v',
    key.slice(8),
    wrongKey.slice(8),
  ]) {
    assert.ok(!text.includes(value), 'private value escaped into output');
  }
}

export function checkHeldResponses(responses) {
  assert.equal(responses.length, 2, 'both overlapping responses must be checked');
  const ids = new Set();
  for (const { status, body, requestId } of responses) {
    assert.equal(status, 500, 'hostile plugin must produce 500');
    assert.match(requestId ?? '', /^[a-f0-9-]{36}$/, 'request id must be generated');
    assert.deepEqual(body, {
      error: { code: 'internal', message: 'Internal error', requestId },
    });
    assert.ok(!ids.has(requestId), 'overlapping requests must have distinct request ids');
    ids.add(requestId);
    assertPrivate(JSON.stringify(body));
  }
}

async function bounded(promise, label, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function overlap(send, release = async () => {}) {
  let settled = false;
  const slow = send('/fixture/held/slow').then((response) => {
    settled = true;
    return response;
  });
  slow.catch(() => {});
  try {
    let entered = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await send('/fixture/held/state');
      assert.equal(state.status, 200, 'fixture state must be reachable');
      if ((await state.json()).entered) {
        entered = true;
        break;
      }
      await delay(20);
    }
    assert.ok(entered, 'slow request must enter the barrier');
    const fast = await bounded(send('/fixture/held/fast'), 'independent request');
    assert.equal(settled, false, 'slow request must still be held when fast request completes');
    await send('/fixture/held/release');
    await release();
    const responses = await Promise.all([slow, fast]);
    const results = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        body: await response.json(),
      })),
    );
    checkHeldResponses(results);
    return results.map(({ requestId }) => requestId);
  } finally {
    await send('/fixture/held/release').catch(() => {});
    await release();
    await bounded(
      slow.catch(() => {}),
      'held request cleanup',
    );
  }
}

function checkLogs(output, ids) {
  assertPrivate(output);
  const records = output.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  for (const id of ids) {
    assert.ok(
      records.some(
        (row) => row.event === 'http.error' && row.request_id === id && row.error_name === 'Error',
      ),
      'each hostile request must have a safe correlated error log',
    );
  }
  assert.ok(output.includes('t767.flush_rejected'), 'rejected flush must actually execute');
}

async function injectFlush(out, target) {
  const path = join(out, target === 'node' ? 'server.js' : 'worker.js');
  const text = await readFile(path, 'utf8');
  const anchor = target === 'node' ? 'await telemetry?.flush();' : 'await application.flush();';
  assert.equal(text.split(anchor).length, 2, 'flush fault injection must match exactly once');
  await writeFile(
    path,
    text.replace(
      anchor,
      `await (async () => { console.log(JSON.stringify({event: 't767.flush_rejected'})); throw new Error('T767-secret flush'); })();`,
    ),
  );
}

async function nodeSmoke(out) {
  await symlink(join(root, 'packages/runtime-node/node_modules'), join(out, 'node_modules'), 'dir');
  let base = 'http://127.0.0.1:8787';
  const env = {
    ...process.env,
    PORT: '8787',
    PB_SQLITE_PATH: join(out, 'db.sqlite'),
    PB_BLOB_ROOT: join(out, 'blobs'),
    PB_MASTER_KEY: key,
    PB_PUBLIC_URL: base,
    PB_ORG_SLUG: 'smoke',
    PB_ORG_NAME: 'Smoke',
    DEPLOYMENT_ID: 't767',
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith('PB_MASTER_KEY_') || name === 'NODE_OPTIONS') delete env[name];
  }
  async function run(overrides, work) {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: out,
      env: { ...env, ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exit = once(child, 'close');
    try {
      await work(child, () => output, exit);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await bounded(exit, 'child cleanup');
      }
    }
  }
  const untouched = join(out, 'port-must-not-create', 'db.sqlite');
  await run({ PORT: hostilePort, PB_SQLITE_PATH: untouched }, async (_, output, exit) => {
    assert.equal((await bounded(exit, 'hostile PORT exit'))[0], 1);
    assert.match(output(), /PORT must be an integer between 1 and 65535/);
    assertPrivate(output());
    await assert.rejects(stat(dirname(untouched)), { code: 'ENOENT' });
  });
  console.log('smoke:node hostile PORT rejected before migrations without leaking its value');
  if (process.argv.includes('--port-only')) return;
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  env.PORT = String(port);
  env.PB_PUBLIC_URL = base;
  await run({}, async (child, output, exit) => {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      assert.equal(child.exitCode, null, 'valid candidate must stay alive');
      try {
        const response = await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(1000) });
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* starting */
      }
      await delay(50);
    }
    assert.ok(ready, 'valid candidate must become ready');
    const ids = await overlap((path) =>
      fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) }),
    );
    child.kill('SIGTERM');
    assert.equal((await bounded(exit, 'shutdown after rejected flush'))[0], 0);
    checkLogs(output(), ids);
  });
  for (const master of ['', wrongKey]) {
    await run({ PB_MASTER_KEY: master }, async (_, output, exit) => {
      assert.equal(
        (await bounded(exit, 'bad keyring exit'))[0],
        1,
        'bad keyring must prevent listening',
      );
      assertPrivate(output());
      assert.match(output(), /startup.failed/);
    });
  }
}

async function workerSmoke(out) {
  const require = createRequire(join(root, 'packages/runtime-cloudflare/package.json'));
  const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
  const wrapper = join(out, 'wrapper.js');
  await writeFile(
    wrapper,
    `import worker from './worker.js';
const log = console.log.bind(console), error = console.error.bind(console);
console.log = value => log(typeof value === 'string' ? value : JSON.stringify(value));
console.error = value => error(typeof value === 'string' ? value : JSON.stringify(value));
const pending = [];
export default { async fetch(request, env, ctx) {
 if (new URL(request.url).pathname === '/fixture/drain') {
   await Promise.all(pending);
   return Response.json({drained: true});
 }

 const mode = request.headers.get('x-t767-key');
 const bindings = {...env};
 if (mode === 'missing') delete bindings.PB_MASTER_KEY;
 if (mode === 'wrong') bindings.PB_MASTER_KEY = ${JSON.stringify(wrongKey)};
 return worker.fetch(request, bindings, {
   waitUntil(promise) {
     pending.push(promise);
     promise.catch(() => {});
     ctx.waitUntil(promise);
   },
 });
}};`,
  );
  let output = '';
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: out,
      modules: [
        { type: 'ESModule', path: wrapper },
        { type: 'ESModule', path: join(out, 'worker.js') },
      ],
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      r2Buckets: ['STORAGE'],
      queueProducers: { JOBS: 't767-jobs' },
      outboundService: async () => {
        await released;
        return new Response('released');
      },
      bindings: { PB_MASTER_KEY: key, PB_PUBLIC_URL: 'https://broker.test', DEPLOYMENT_ID: 't767' },
      handleStructuredLogs: ({ message }) => {
        output += `${message}\n`;
      },
    }),
  );
  try {
    const executor = createD1Executor(await mf.getD1Database('DB'));
    const manifest = JSON.parse(await readFile(join(out, 'generated/manifest.json'), 'utf8'));
    const sources = [],
      owners = [];
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
    await migrate(executor, await planMigrations(sources, owners), { holder: 't767' });
    await createOrganizationBootstrap(executor).bootstrap({
      id: 't767-org',
      slug: 'smoke',
      name: 'Smoke',
      now: new Date().toISOString(),
    });
    const send = (path, headers) =>
      bounded(mf.dispatchFetch(`https://broker.test${path}`, { headers }), 'Worker request');
    const ids = await overlap(send, async () => release());
    for (const mode of ['missing', 'wrong']) {
      const response = await send('/fixture/held/fast', { 'x-t767-key': mode });
      assert.equal(response.status, 503, `${mode} keyring must fail before plugin dispatch`);
      const body = await response.text();
      assertPrivate(body);
      assert.match(body, /misconfigured/);
    }
    assert.equal(
      (await send('/health/ready')).status,
      200,
      'invalid keyrings must not poison valid cached application',
    );
    const drained = await bounded(send('/fixture/drain'), 'Worker deferred work');
    assert.equal(drained.status, 200, 'rejected telemetry flush must not reject waitUntil');
    assert.deepEqual(await drained.json(), { drained: true });
    for (let attempt = 0; ; attempt++) {
      try {
        checkLogs(output, ids);
        break;
      } catch (error) {
        if (attempt >= 40) throw error;
        await delay(50);
      }
    }
  } finally {
    await bounded(mf.dispose(), 'Worker disposal');
  }
}

export function mutateCandidate(text, mutation, target) {
  if (mutation.startsWith('port-')) assert.equal(target, 'node');
  const flushAnchor = "throw new Error('T767-secret flush'); })();\n      } catch {";
  const edits = {
    'port-echo': [
      'throw new Error("PORT must be an integer between 1 and 65535");',
      'throw new Error("PORT must be an integer between 1 and 65535: " + raw2);',
    ],
    'port-late': [
      'port = parsePort(env["PORT"]);',
      'await runtime.start({ plugins, migrations, env, ...(platformPorts == null ? {} : { platformPorts }) }); port = parsePort(env["PORT"]);',
    ],
    'error-echo': [
      'function errorResponse(error2, requestId, log, format = "nested") {',
      'function errorResponse(error2, requestId, log, format = "nested") { console.error(error2.message);',
    ],
    'missing-key':
      target === 'node'
        ? [
            'if (direct === "")\n      throw new StartupConfigError(variable, "is empty");',
            `if (direct === "") return { value: ${JSON.stringify(key)}, fromFile: false };`,
          ]
        : [
            'function readMasterKeys(input) {',
            `function readMasterKeys(input) { if (!input.current) input = {...input, current: ${JSON.stringify(key)}};`,
          ],
    'wrong-key': [
      'async function verifyKeyring(keyring, store, options = {}) {',
      'async function verifyKeyring(keyring, store, options = {}) { return {keyVersion: keyring.currentVersion};',
    ],
    'shared-id': [
      'const requestId = crypto.randomUUID();',
      'const requestId = "aaaaaaaa-1234-1234-1234-123456789012";',
    ],
    overlap: ['await barrier();', 'await Promise.resolve();'],
    'flush-escape': [flushAnchor, flushAnchor.replace('catch {', 'catch (error) { throw error;')],
  };
  assert.ok(Object.hasOwn(edits, mutation), 'unknown held-batch mutation');
  const [before, after] = edits[mutation];
  if (mutation === 'shared-id') {
    assert.ok(text.includes(before), 'request id mutation anchor missing');
    return text.replaceAll(before, after);
  }
  assert.equal(text.split(before).length, 2, `${mutation} must match exactly once`);
  return text.replace(before, after);
}

export async function checkHeldBatch(target) {
  assert.ok(['node', 'cloudflare'].includes(target));
  await mkdir(join(root, '.pb'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.pb', 't767-'));
  try {
    execFileSync(
      process.execPath,
      [
        join(root, 'packages/cli/dist/bin.js'),
        'build',
        '--config',
        join(root, 'fixtures/held-batch.config.ts'),
        '--target',
        target,
        '--out',
        scratch,
      ],
      { cwd: root, stdio: 'pipe' },
    );
    await injectFlush(scratch, target);
    const mutation = process.env['T767_MUTATION'];
    if (mutation !== undefined) {
      const path = join(scratch, target === 'node' ? 'server.js' : 'worker.js');
      await writeFile(path, mutateCandidate(await readFile(path, 'utf8'), mutation, target));
    }
    await (target === 'node' ? nodeSmoke(scratch) : workerSmoke(scratch));
    if (!process.argv.includes('--port-only'))
      console.log(
        `smoke:${target} held batch: hostile plugin, bad keyrings, overlap and rejected flush passed`,
      );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkHeldBatch(process.argv[2]);
}
