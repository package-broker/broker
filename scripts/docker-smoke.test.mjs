import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { parsePublicOrigin } from '@package-broker/core/kernel/public-origin';
import { SOURCE_API_SPECS } from '@package-broker/core/api/routes/sources-schemas';
import { SOURCE_ATTACHMENT_API_SPECS } from '@package-broker/core/api/routes/source-attachment-schemas';
import { SOURCE_NAMES_API_SPECS } from '@package-broker/core/api/routes/source-names-schemas';
import { isCanonicalUrl, isConfigOf } from '@package-broker/core/import/source-config';
import { parseSourceConfig } from '@package-broker/core/sources/config';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { createPolicyFetch } from '@package-broker/core/sources/policy-fetch';
import { readComposerRoot } from '@package-broker/core/ingest/composer/root';
import { describeComposerV2 } from '@package-broker/core/ingest/composer/v2-package';
import { fixtureHandler } from '../fixtures/docker-smoke/server.mjs';
import {
  docker,
  functionalSmoke,
  parseArgs,
  prepareFunctionalFiles,
  scrubDiagnostics,
  smoke,
  totpCode,
  verifyComposerInstall,
  verifyNoSecrets,
} from './docker-smoke.mjs';

const execute = promisify(execFile);
const setupToken = 's'.repeat(43);
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const readToken = 'pbpat_v1_01ARZ3NDEKTSV4RRFFQ69G5FAV_' + 'r'.repeat(43);
const sourceId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const installed = "<?php\nreturn 'docker-smoke-installed';\n";
const lock = {
  packages: [
    {
      name: 'docker-smoke/fixture',
      version: '1.0.0',
      dist: { url: 'http://broker:8787/smoke/dist/docker-smoke/fixture/version/r1.tar' },
    },
  ],
};

function migrationHarness(
  outputs,
  {
    exitCode = 0,
    logFailure = false,
    smokeOptions = { '--image': 'pb:test' },
    functional,
    failAt,
  } = {},
) {
  const calls = [];
  const messages = [];
  const stopped = new Set();
  let logIndex = 0;
  const run = (args, check, options) => {
    calls.push({ args, check, options });
    return docker(args, check, {
      ...options,
      execute: async (file, command) => {
        assert.equal(file, 'docker');
        assert.deepEqual(command, args);
        if (check === failAt) throw new Error('private subprocess error');
        if (args[0] === 'logs') {
          if (logFailure) throw Object.assign(new Error('private logs'), { code: 1 });
          return outputs[logIndex++];
        }
        let stdout = '';
        if (args[0] === 'stop') stopped.add(args.at(-1));
        if (args[0] === 'inspect') {
          stdout = JSON.stringify([
            {
              State: {
                Running: !stopped.has(args[1]),
                Health: { Status: 'healthy' },
                ExitCode: stopped.size > 1 ? exitCode : 0,
              },
              NetworkSettings: {
                Ports: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '32781' }] },
              },
            },
          ]);
        }
        if (args[0] === 'exec') stdout = JSON.stringify({ uid: 1000, init: 'tini' });
        return { stdout, stderr: '' };
      },
    });
  };
  return {
    calls,
    messages,
    run: () => smoke(smokeOptions, { run, functional, log: (line) => messages.push(line) }),
  };
}

const migrationOutput = (events, stream = 'stdout') => ({
  stdout: '',
  stderr: '',
  [stream]: events
    .map((event) => JSON.stringify({ level: 'info', holder: 'runner', ...event }))
    .join('\n'),
});
const initApplied = { id: 'core:0001_init', message: 'applied core:0001_init' };
const lockAcquired = { message: 'migration lock acquired' };
const protectedApplied = { id: 'core:0002_next', message: 'applied core:0002_next' };
const lockWaiting = { message: 'migration lock is held by runner, waiting' };

for (const [label, outputs] of [
  ['silent peer', [migrationOutput([initApplied]), migrationOutput([])]],
  [
    'initialization race recovery warning',
    [
      migrationOutput([initApplied]),
      migrationOutput([
        {
          level: 'warn',
          id: 'core:0001_init',
          message:
            "core:0001_init is already recorded; another runner applied it, or this runner's own response was lost",
        },
      ]),
    ],
  ],
  [
    'second container applies on stderr',
    [migrationOutput([]), migrationOutput([initApplied], 'stderr')],
  ],
]) {
  test(`migration smoke accepts the current init-only image logs: ${label}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
    const h = migrationHarness(outputs);
    await h.run();
    assert.equal(
      h.messages.at(-1),
      'smoke:docker migration initialization: one applier, both healthy; no post-initialization migrations to exercise the lock',
    );
    assert.equal(h.calls.filter(({ args }) => args[0] === 'stop').length, 3);
    assert.equal(h.calls.filter(({ check }) => check === 'cleanup-container').length, 3);
    assert.equal(h.calls.filter(({ check }) => check === 'cleanup-volume').length, 2);
  });
}

test('migration smoke still requires contention for post-initialization migrations', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const h = migrationHarness([
    migrationOutput([initApplied, lockWaiting]),
    migrationOutput([lockAcquired, protectedApplied], 'stderr'),
  ]);
  await h.run();
  assert.equal(
    h.messages.at(-1),
    'smoke:docker migration-lock: one protected applier, second lock participant, both healthy',
  );
});

for (const [label, outputs, error] of [
  [
    'no applications despite successful Docker commands',
    [migrationOutput([]), migrationOutput([])],
    'expected exactly one migration applier',
  ],
  [
    'duplicate initialization across containers',
    [migrationOutput([initApplied]), migrationOutput([initApplied])],
    'migration applied twice',
  ],
  [
    'duplicate initialization in one container',
    [migrationOutput([initApplied, initApplied]), migrationOutput([])],
    'migration applied twice',
  ],
  [
    'two protected appliers',
    [
      migrationOutput([initApplied, lockAcquired, protectedApplied]),
      migrationOutput([
        lockAcquired,
        { id: 'core:0003_other', message: 'applied core:0003_other' },
      ]),
    ],
    'expected exactly one migration applier',
  ],
  [
    'silent peer after protected applications',
    [migrationOutput([initApplied, lockAcquired, protectedApplied]), migrationOutput([])],
    'second container',
  ],
  [
    'protected applier without a lock',
    [migrationOutput([initApplied, protectedApplied]), migrationOutput([lockWaiting])],
    'applier did not report',
  ],
  [
    'unmatched application message',
    [migrationOutput([{ ...initApplied, message: 'applied something else' }]), migrationOutput([])],
    'expected exactly one migration applier',
  ],
]) {
  test(`migration smoke rejects ${label} and cleans up`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
    const h = migrationHarness(outputs);
    await assert.rejects(h.run(), new RegExp(`migration-lock: ${error}`));
    assert.equal(h.messages.length, 1);
    assert.equal(h.calls.filter(({ check }) => check === 'cleanup-container').length, 3);
    assert.equal(h.calls.filter(({ check }) => check === 'cleanup-volume').length, 2);
  });
}

test('migration smoke rejects a failed Docker logs command', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const h = migrationHarness([], { logFailure: true });
  await assert.rejects(h.run(), /migration-logs: Docker command failed/);
});

test('migration smoke still requires exit zero after valid initialization logs', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const h = migrationHarness([migrationOutput([initApplied]), migrationOutput([])], {
    exitCode: 137,
  });
  await assert.rejects(h.run(), /shutdown: expected container exit 0/);
  assert.equal(h.calls.filter(({ args }) => args[0] === 'logs').length, 2);
  assert.equal(h.calls.filter(({ check }) => check === 'cleanup-container').length, 3);
});

function harness({
  failAt,
  leak,
  httpFailure,
  apiResponses = {},
  composerExit = '0',
  mutateLock,
  abort,
  setupFile = setupToken,
  setupSecret = totpSecret,
  sessionCookies = true,
  health = 'healthy',
  running = true,
  probeResponses = [{ status: 200 }],
  abortDuringProbe,
  httpStderr = '',
  malformedHttp = false,
  diagnosticLogs = () => 'startup error: EACCES /data/broker.sqlite\n',
  diagnosticState = () =>
    '{"Status":"exited","Running":false,"ExitCode":1,"OOMKilled":false,"Error":""}\n',
  metadataResponses = [
    { status: 200, body: { packages: { 'docker-smoke/fixture': [{ version: '1.0.0' }] } } },
  ],
  abortDuringIngestion,
  sourceStatus = ({ ingested }) => ({
    id: sourceId,
    attached: true,
    status: 'active',
    pollIntervalSeconds: 60,
    lastSuccessAt: ingested ? '2026-10-23T10:00:00.000Z' : null,
  }),
  registeredNames = [{ pattern: 'docker-smoke/fixture' }],
  tokenRequiresReauth = false,
  beforeTokenElapsed = 0,
  abortDuringReauthWait,
} = {}) {
  const calls = [];
  const requests = [];
  const messages = [];
  const events = [];
  const waits = [];
  let clock = 0;
  let metadataAttempt = 0;
  let metadataFound = false;
  let probeAttempt = 0;
  let healthAttempt = 0;
  let directory;
  let password;
  let code;
  let reauthCode;
  let reauthenticated = false;
  let tokenAttempt = 0;
  const epoch = 1_111_111_109_000;
  let brokerOrigin;
  let mountedCertificate;
  const run = async (args, check, options) => {
    calls.push({ args, check, options });
    events.push(check);
    return docker(args, check, {
      ...options,
      execute: async () => {
        if (check === failAt) {
          abort?.abort();
          throw Object.assign(new Error(`subprocess ${readToken}`), {
            stdout: leak === 'failed-command' ? readToken : '',
            stderr: 'private subprocess output',
          });
        }
        let stdout = '';
        if (check === 'functional-create-broker') {
          const mount = args.find((arg) => arg.includes('target=/tmp/fixture.crt'));
          const source = mount
            .split(',')
            .find((part) => part.startsWith('source='))
            .slice(7);
          mountedCertificate = { mode: (await stat(source)).mode & 0o777, mount };
          brokerOrigin = args
            .find((arg) => arg.startsWith('PB_PUBLIC_URL='))
            .slice('PB_PUBLIC_URL='.length);
        }
        if (check === 'functional-token-file') await writeFile(args.at(-1), setupFile);
        if (check === 'functional-health') {
          assert.ok(args.includes('--format'));
          assert.ok(!args[args.indexOf('--format') + 1].includes('.Config'));
          const states = Array.isArray(health) ? health : [health];
          const values = {
            '.State.Running': running,
            '.State.Health.Status': states[Math.min(healthAttempt++, states.length - 1)],
            '.NetworkSettings.Ports': {},
          };
          stdout = args[args.indexOf('--format') + 1].replace(
            /\{\{json ([^}]+)\}\}/g,
            (_, field) => {
              assert.ok(Object.hasOwn(values, field));
              return JSON.stringify(values[field]);
            },
          );
        }
        if (check === 'functional-http') {
          assert.equal(args[0], 'exec');
          assert.equal(args[2], 'node');
          assert.equal(args[3], '--eval');
          await runInNewContext(args[4], {
            process: { argv: ['node', args[5]], stdout: { write: (value) => (stdout = value) } },
            fetch: request,
            AbortSignal,
          });
          if (malformedHttp) stdout = `invalid response ${readToken}`;
          return { stdout, stderr: httpStderr };
        }
        if (check === 'functional-bootstrap' && leak === 'setup-token') stdout = setupToken;
        if (check === 'functional-composer') {
          const project = JSON.parse(await readFile(join(directory, 'composer.json'), 'utf8'));
          assert.deepEqual(project.repositories, [
            { type: 'composer', url: `${brokerOrigin}/smoke` },
            { 'packagist.org': false },
          ]);
          const auth = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'));
          assert.equal(auth['http-basic'][new URL(brokerOrigin).host].password, readToken);
          assert.equal((await stat(join(directory, 'auth.json'))).mode & 0o777, 0o600);
          const selectedLock = structuredClone(lock);
          selectedLock.packages[0].dist.url = `${brokerOrigin}${new URL(selectedLock.packages[0].dist.url).pathname}`;
          mutateLock?.(selectedLock);
          await writeFile(join(directory, 'composer.lock'), JSON.stringify(selectedLock));
          await mkdir(join(directory, 'vendor/docker-smoke/fixture'), { recursive: true });
          await mkdir(join(directory, 'vendor/composer'), { recursive: true });
          await writeFile(join(directory, 'vendor/docker-smoke/fixture/installed.php'), installed);
          await writeFile(join(directory, 'vendor/composer/installed.json'), '{}');
          stdout =
            leak === 'read-token'
              ? readToken
              : leak === 'basic-auth'
                ? Buffer.from(`token:${readToken}`).toString('base64')
                : 'Installed docker-smoke/fixture (1.0.0)';
        }
        if (check === 'functional-composer-exit') stdout = composerExit;
        if (check === 'functional-logs') {
          stdout =
            { password, 'totp-secret': totpSecret, code, 'reauth-code': reauthCode }[leak] ?? '';
        }
        if (check === 'functional-diagnostic-logs' || check === 'functional-diagnostic-state') {
          const render = check === 'functional-diagnostic-logs' ? diagnosticLogs : diagnosticState;
          stdout = render({ password, code, calls });
        }
        return { stdout, stderr: '' };
      },
    });
  };
  const request = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ url, path, init, body });
    events.push(path);
    if (path === '/health/ready') {
      abortDuringProbe?.abort();
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      const response = probeResponses[Math.min(probeAttempt++, probeResponses.length - 1)];
      clock += response.elapsed ?? 0;
      if (response.error) throw response.error;
      return new Response(response.body ?? null, { status: response.status });
    }
    if (path === httpFailure) return new Response(readToken, { status: 403 });
    if (path === '/_pb/me/tokens' && tokenAttempt++ === 0) {
      clock += beforeTokenElapsed;
      if (tokenRequiresReauth) {
        return Response.json({ error: { code: 'reauth_required' } }, { status: 403 });
      }
    }
    if (apiResponses[path]) {
      const response =
        typeof apiResponses[path] === 'function' ? apiResponses[path](body) : apiResponses[path];
      return new Response(response.text ?? JSON.stringify(response.body), {
        status: response.status,
      });
    }
    if (path === '/smoke/p2/docker-smoke/fixture.json') {
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(
        init.headers.authorization,
        `Basic ${Buffer.from(`token:${readToken}`).toString('base64')}`,
      );
      assert.equal(init.headers.cookie, undefined);
      assert.ok(init.signal instanceof AbortSignal);
      abortDuringIngestion?.abort();
      const response = metadataResponses[Math.min(metadataAttempt++, metadataResponses.length - 1)];
      metadataFound = response.body?.packages?.['docker-smoke/fixture']?.some(
        (pkg) => pkg.version === '1.0.0',
      );
      return Response.json(response.body, { status: response.status });
    }
    if (path.endsWith('/setup/start')) {
      assert.deepEqual(body, { token: setupToken });
      return Response.json({ secret: setupSecret });
    }
    if (path.endsWith('/setup/finish')) {
      password = body.password;
      code = body.code;
      assert.equal(body.token, setupToken);
      assert.equal(code, totpCode(totpSecret, epoch + clock));
      assert.ok(password.length >= 32);
      const headers = new Headers();
      if (!sessionCookies) return new Response(null, { status: 204, headers });
      headers.append('set-cookie', `__Host-pb_session=${'a'.repeat(43)}; Path=/; Secure; HttpOnly`);
      headers.append('set-cookie', `__Host-pb_csrf=${'c'.repeat(43)}; Path=/; Secure`);
      return new Response(null, { status: 204, headers });
    }
    assert.ok(init.headers.cookie.includes('__Host-pb_session='));
    assert.equal(init.headers['x-csrf-token'], 'c'.repeat(43));
    assert.equal(init.headers.authorization, undefined);
    if (path === '/_pb/auth/local/reauth') {
      assert.equal(body.password, password);
      assert.equal(body.code, totpCode(totpSecret, epoch + clock));
      assert.ok(Math.floor((epoch + clock) / 30_000) > Math.floor(epoch / 30_000));
      assert.deepEqual(Object.keys(body).sort(), ['code', 'password']);
      reauthCode = body.code;
      reauthenticated = true;
      return new Response(null, { status: 204 });
    }
    if (path === '/_pb/session') return Response.json({});
    if (path === '/_pb/projects') return Response.json({ id: 'project-id' }, { status: 201 });
    if (path === '/_pb/sources') return Response.json({ id: sourceId }, { status: 201 });
    if (path === '/_pb/projects/smoke/sources') {
      return Response.json({
        items: [sourceStatus({ ingested: metadataFound, afterIngestion: metadataAttempt > 0 })],
        next: null,
      });
    }
    if (path.endsWith('/names'))
      return Response.json(
        init.method === 'GET' ? { items: registeredNames, next: null } : { id: sourceId },
        { status: init.method === 'GET' ? 200 : 201 },
      );
    if (path.endsWith('/enable') || path.endsWith('/attachment'))
      return new Response(null, { status: 204 });
    if (path === '/_pb/me/tokens') {
      if (tokenRequiresReauth) assert.ok(reauthenticated);
      return Response.json({ token: readToken }, { status: 201 });
    }
    throw new Error('Unexpected route');
  };
  return {
    calls,
    requests,
    messages,
    events,
    waits,
    mountedCertificate: () => mountedCertificate,
    directory: () => directory,
    run: () =>
      functionalSmoke(
        { '--image': 'pb:test' },
        {
          run,
          signal: abort?.signal,
          now: () => clock,
          wallNow: () => epoch + clock,
          wait: async (ms, _, { signal } = {}) => {
            signal?.throwIfAborted();
            if (tokenAttempt && !reauthenticated) abortDuringReauthWait?.abort();
            signal?.throwIfAborted();
            waits.push(ms);
            clock += ms;
          },
          prepare: async (path) => {
            directory = path;
            await writeFile(join(path, 'fixture.crt'), 'test certificate', { mode: 0o600 });
          },
          log: (message) => messages.push(message),
        },
      ),
  };
}

async function assertCleaned(h) {
  const { calls } = h;
  for (const { args } of calls.filter(({ args }) => args[0] === 'create')) {
    const name = args[args.indexOf('--name') + 1];
    assert.ok(
      calls.some((call) => call.check === 'cleanup-container' && call.args.at(-1) === name),
    );
  }
  for (const { args } of calls.filter(({ args }) => args[0] === 'volume' && args[1] === 'create')) {
    assert.ok(
      calls.some((call) => call.check === 'cleanup-volume' && call.args.at(-1) === args.at(-1)),
    );
  }
  const network = calls.find(({ check }) => check === 'functional-network').args.at(-1);
  assert.ok(calls.some((call) => call.check === 'cleanup-network' && call.args.at(-1) === network));
  assert.ok(
    calls
      .filter(({ check }) => check.startsWith('cleanup-'))
      .every(({ options }) => options.signal === undefined),
  );
  await assert.rejects(stat(h.directory()), { code: 'ENOENT' });
}

test('functional flag accepts an optional image and rejects duplicate flags', () => {
  for (const args of [
    ['--image', 'pb:test', '--functional'],
    ['--functional', '--image', 'pb:test'],
  ]) {
    assert.deepEqual(parseArgs(args), { '--functional': true, '--image': 'pb:test' });
  }
  assert.deepEqual(parseArgs(['--functional']), { '--functional': true });
  assert.deepEqual(parseArgs(['--verify-manifest', 'pb:test', '--functional']), {
    '--functional': true,
    '--verify-manifest': 'pb:test',
  });
  for (const args of [
    ['--image', 'pb:test', '--functional', '--functional'],
    ['--functional', '--image'],
  ]) {
    assert.throws(() => parseArgs(args), /^Error: arguments:/);
  }
});

test('functional without an image builds the smoke config and prepares Composer before running', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  let selectedOptions;
  const h = migrationHarness([migrationOutput([initApplied]), migrationOutput([])], {
    smokeOptions: parseArgs(['--functional']),
    functional: async (options) => (selectedOptions = options),
  });
  await h.run();
  const build = h.calls.find(({ check }) => check === 'smoke-image-build');
  assert.deepEqual(build.args.slice(0, -1), [
    'build',
    '--build-arg',
    'CONFIG=fixtures/docker-smoke/broker.config.ts',
    '--tag',
    'pb:docker-smoke',
  ]);
  assert.equal(build.args.at(-1), new URL('../', import.meta.url).pathname);
  assert.equal(build.options.timeout, 600_000);
  assert.deepEqual(h.calls[1].args, ['pull', 'composer:2']);
  assert.equal(selectedOptions['--image'], 'pb:docker-smoke');
  for (const { args } of h.calls.filter(({ args }) => args[0] === 'create')) {
    assert.ok(args.includes(selectedOptions['--image']));
  }
});

test('an explicit image is reused without building or pulling', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  let selectedOptions;
  const h = migrationHarness([migrationOutput([initApplied]), migrationOutput([])], {
    smokeOptions: parseArgs(['--functional', '--image', 'pb:existing']),
    functional: async (options) => (selectedOptions = options),
  });
  await h.run();
  assert.equal(selectedOptions['--image'], 'pb:existing');
  assert.ok(!h.calls.some(({ args }) => ['build', 'pull'].includes(args[0])));
});

for (const failAt of ['smoke-image-build', 'smoke-composer-image']) {
  test(`${failAt} failure stops before creating smoke resources`, async () => {
    const h = migrationHarness([], { smokeOptions: parseArgs(['--functional']), failAt });
    await assert.rejects(h.run(), new RegExp(`${failAt}: Docker command failed`));
    assert.ok(!h.calls.some(({ args }) => ['create', 'volume', 'network'].includes(args[0])));
  });
}

for (const beforeTokenElapsed of [0, 45_000]) {
  test(`reauthenticates with a fresh TOTP step and retries token issuance once after ${beforeTokenElapsed} ms`, async () => {
    const h = harness({ tokenRequiresReauth: true, beforeTokenElapsed });
    await h.run();
    const paths = h.requests.map(({ path }) => path);
    const first = paths.indexOf('/_pb/me/tokens');
    assert.deepEqual(paths.slice(first, first + 3), [
      '/_pb/me/tokens',
      '/_pb/auth/local/reauth',
      '/_pb/me/tokens',
    ]);
    const reauth = h.requests[first + 1];
    assert.equal(reauth.init.method, 'POST');
    assert.equal(reauth.init.headers.origin, 'http://127.0.0.1:8787');
    assert.deepEqual(h.requests[first].body, h.requests[first + 2].body);
    assert.notEqual(
      reauth.body.code,
      h.requests.find(({ path }) => path.endsWith('/setup/finish')).body.code,
    );
    assert.deepEqual(h.waits, beforeTokenElapsed ? [] : [1_000]);
    assert.equal(paths.filter((path) => path === '/_pb/me/tokens').length, 2);
    assert.ok(h.messages.at(-1).includes('Composer install passed'));
    verifyNoSecrets(h.messages, [totpSecret, reauth.body.password, reauth.body.code]);
    await assertCleaned(h);
  });
}

test('a second reauth_required stops after one reauth and one token retry', async () => {
  const h = harness({
    tokenRequiresReauth: true,
    apiResponses: {
      '/_pb/me/tokens': { status: 403, body: { error: { code: 'reauth_required' } } },
    },
  });
  await assert.rejects(h.run(), { message: 'functional: session read token failed (HTTP 403)' });
  assert.equal(h.requests.filter(({ path }) => path === '/_pb/me/tokens').length, 2);
  assert.equal(h.requests.filter(({ path }) => path.endsWith('/reauth')).length, 1);
  assert.ok(!h.calls.some(({ check }) => check === 'functional-create-composer'));
  await assertCleaned(h);
});

for (const code of ['forbidden', undefined]) {
  test(`token denial ${code} does not trigger reauthentication or retry`, async () => {
    const h = harness({
      apiResponses: { '/_pb/me/tokens': { status: 403, body: { error: { code } } } },
    });
    await assert.rejects(h.run(), { message: 'functional: session read token failed (HTTP 403)' });
    assert.equal(h.requests.filter(({ path }) => path === '/_pb/me/tokens').length, 1);
    assert.ok(!h.requests.some(({ path }) => path.endsWith('/reauth')));
    await assertCleaned(h);
  });
}

test('failed reauth suppresses credential-bearing response fields and prevents token retry', async () => {
  let credentials;
  const h = harness({
    tokenRequiresReauth: true,
    apiResponses: {
      '/_pb/auth/local/reauth': (body) => {
        credentials = [body.password, body.code, totpSecret];
        return {
          status: 401,
          body: {
            error: {
              code: body.password,
              details: [{ path: `${totpSecret}/${body.code}` }],
              message: JSON.stringify(body),
            },
          },
        };
      },
    },
  });
  await assert.rejects(h.run(), (error) => {
    assert.equal(error.message, 'functional: session reauthentication failed (HTTP 401)');
    verifyNoSecrets([error.message], credentials);
    return true;
  });
  assert.equal(h.requests.filter(({ path }) => path === '/_pb/me/tokens').length, 1);
  verifyNoSecrets(h.messages, credentials);
  assert.ok(!h.calls.some(({ check }) => check === 'functional-create-composer'));
  await assertCleaned(h);
});

test('interruption while waiting for a fresh TOTP prevents reauth and token retry', async () => {
  const abort = new AbortController();
  const h = harness({ tokenRequiresReauth: true, abort, abortDuringReauthWait: abort });
  await assert.rejects(h.run(), { message: 'functional: session reauthentication failed' });
  assert.equal(h.requests.filter(({ path }) => path === '/_pb/me/tokens').length, 1);
  assert.ok(!h.requests.some(({ path }) => path.endsWith('/reauth')));
  await assertCleaned(h);
});

test('the reauth TOTP code remains covered by the secret sentinel and diagnostics scrubber', async () => {
  const h = harness({ tokenRequiresReauth: true, leak: 'reauth-code' });
  await assert.rejects(h.run(), /secret-output: sensitive value found/);
  const reauth = h.requests.find(({ path }) => path.endsWith('/reauth')).body;
  verifyNoSecrets(h.messages, [totpSecret, reauth.password, reauth.code]);
  await assertCleaned(h);
});

test('TOTP matches RFC 6238 SHA1 vectors truncated to six digits', () => {
  assert.equal(totpCode(totpSecret, 59_000), '287082');
  assert.equal(totpCode(totpSecret, 1_111_111_109_000), '081804');
  assert.equal(totpCode(totpSecret, 20_000_000_000_000), '353130');
  assert.throws(() => totpCode('invalid-secret'), /invalid TOTP secret/);
});

test('diagnostic scrubbing removes known credentials, repeated values and overlapping secrets', () => {
  const secrets = [
    setupToken,
    totpSecret,
    readToken,
    'smoke-password',
    '123456',
    'session-value',
    'csrf-value',
  ];
  const output = `EACCES /data/broker.sqlite\n${secrets.join('\n')}\n${secrets.join(' ')}\nexit code 1`;
  const scrubbed = scrubDiagnostics(output, [...secrets, 'smoke', undefined, '']);
  verifyNoSecrets([scrubbed], secrets);
  assert.ok(!scrubbed.includes('-password'));
  assert.ok(scrubbed.includes('EACCES /data/broker.sqlite'));
  assert.ok(scrubbed.includes('exit code 1'));
  assert.ok(scrubbed.includes('[redacted]'));
});

test('diagnostic scrubbing covers credentials not yet read by the smoke and account emails', () => {
  const sensitive = [
    `PB_MASTER_KEY=pbmk_v1_${'k'.repeat(43)}`,
    `setup value ${setupToken}`,
    `TOTP ${totpSecret}`,
    `read value ${readToken}`,
    'password=short-password',
    '{"setupToken":"short-setup-token","secret":"short-totp-secret"}',
    'Cookie: session=short-cookie',
    'Authorization: Basic short-auth',
    'https://user:short-password@fixture:8443/private',
    'account docker-smoke@example.test',
  ];
  const scrubbed = scrubDiagnostics(sensitive.join('\n'), []);
  for (const value of [
    setupToken,
    totpSecret,
    readToken,
    'k'.repeat(43),
    'short-password',
    'short-setup-token',
    'short-totp-secret',
    'short-cookie',
    'short-auth',
    'docker-smoke@example.test',
  ])
    assert.ok(!scrubbed.includes(value));
});

for (const [options, alias] of [
  [{ running: false }, 'broker'],
  [{ failAt: 'functional-fixture-start' }, 'fixture'],
  [{ composerExit: '1' }, 'composer'],
]) {
  test(`functional failures print the ${alias} log tail and exit state before removing containers`, async () => {
    const h = harness(options);
    await assert.rejects(h.run(), /functional:/);
    const containerMessages = h.messages.filter((line) => !line.includes('source status:'));
    assert.equal(containerMessages.length, alias === 'broker' ? 3 : 2);
    assert.ok(
      containerMessages.every((line) =>
        line.startsWith(`smoke:docker functional diagnostics (${alias}):`),
      ),
    );
    assert.ok(
      h.messages.some((line) =>
        line.includes('last 40 log lines:\nstartup error: EACCES /data/broker.sqlite'),
      ),
    );
    assert.ok(h.messages.some((line) => line.includes('"ExitCode":1')));
    const create = h.calls.find(({ check }) => check === `functional-create-${alias}`).args;
    const name = create[create.indexOf('--name') + 1];
    const logs = h.calls.find(
      ({ check, args }) => check === 'functional-diagnostic-logs' && args.at(-1) === name,
    );
    assert.deepEqual(logs.args, ['logs', '--tail', '40', name]);
    const state = h.calls.find(
      ({ check, args }) => check === 'functional-diagnostic-state' && args.at(-1) === name,
    );
    for (const field of ['Status', 'Running', 'ExitCode', 'OOMKilled', 'Error'])
      assert.ok(state.args[2].includes(`.State.${field}`));
    assert.ok(!state.args[2].includes('.Config'));
    for (const call of [logs, state]) {
      assert.equal(call.options.signal, undefined);
      assert.ok(
        h.calls.indexOf(call) < h.calls.findIndex(({ check }) => check === 'cleanup-container'),
      );
    }
    await assertCleaned(h);
  });
}

test('both log and exit-state diagnostics redact generated credentials even on sentinel failure', async () => {
  let values;
  const render = ({ password, code, calls }) => {
    const broker = calls.find(({ check }) => check === 'functional-create-broker').args;
    values = [
      setupToken,
      totpSecret,
      readToken,
      password,
      code,
      'a'.repeat(43),
      'c'.repeat(43),
      broker.find((arg) => arg.startsWith('PB_MASTER_KEY=')).slice('PB_MASTER_KEY='.length),
      Buffer.from(`token:${readToken}`).toString('base64'),
    ];
    return `startup failed\n${values.join('\n')}\n`;
  };
  const h = harness({ composerExit: '1', diagnosticLogs: render, diagnosticState: render });
  await assert.rejects(h.run(), /secret-output:/);
  const containerMessages = h.messages.filter((line) => !line.includes('source status:'));
  assert.equal(containerMessages.length, 2);
  verifyNoSecrets(h.messages, values);
  assert.ok(containerMessages.every((line) => line.includes('startup failed\n[redacted]')));
  await assertCleaned(h);
});

for (const failAt of ['functional-diagnostic-logs', 'functional-diagnostic-state']) {
  test(`unavailable ${failAt} does not hide the original failure or prevent cleanup`, async () => {
    const h = harness({ running: false, failAt });
    await assert.rejects(h.run(), { message: 'functional: broker startup failed' });
    assert.ok(
      h.messages.some((line) => line.includes('unavailable (Docker command failed or timed out)')),
    );
    verifyNoSecrets(h.messages, [readToken]);
    await assertCleaned(h);
  });
}

test('functional broker startup matches the lifecycle environment, volume and user without host ports', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const lifecycle = migrationHarness([migrationOutput([initApplied]), migrationOutput([])]);
  await lifecycle.run();
  const h = harness();
  await h.run();
  const passing = lifecycle.calls.find(({ check }) => check === 'container-create').args;
  const functional = h.calls.find(({ check }) => check === 'functional-create-broker').args;
  for (const args of [passing, functional]) {
    assert.ok(args.some((arg) => /^type=volume,source=pb-smoke-.+,target=\/data$/.test(arg)));
    assert.ok(!args.includes('--user'));
    assert.equal(args.at(-1), 'pb:test');
    assert.ok(args.some((arg) => /^PB_MASTER_KEY=pbmk_v1_[A-Za-z0-9_-]{43}$/.test(arg)));
  }
  assert.equal(passing[passing.indexOf('--publish') + 1], '127.0.0.1::8787');
  assert.ok(!functional.includes('--publish'));
  const env = (args) =>
    args.filter(
      (arg, index) =>
        args[index - 1] === '--env' &&
        !arg.startsWith('PB_MASTER_KEY=') &&
        !arg.startsWith('NODE_EXTRA_CA_CERTS='),
    );
  assert.deepEqual(env(functional), env(passing));
  await assertCleaned(h);
});

test('runs bootstrap and session-only source management, then installs on an internal network', async () => {
  const h = harness();
  await h.run();
  const network = h.calls.find(({ check }) => check === 'functional-network');
  assert.ok(network.args.includes('--internal'));
  const creates = h.calls.filter(({ args }) => args[0] === 'create');
  assert.equal(creates.length, 3);
  for (const { args } of creates) {
    assert.equal(
      args[args.indexOf('--network') + 1],
      args.includes('composer:2')
        ? `container:${creates[1].args[creates[1].args.indexOf('--name') + 1]}`
        : network.args.at(-1),
    );
    assert.equal(args[args.indexOf('--pull') + 1], 'never');
  }
  const bootstrap = h.calls.find(({ check }) => check === 'functional-bootstrap').args;
  assert.deepEqual(bootstrap.slice(2), [
    'pb',
    'admin',
    'bootstrap',
    '--sqlite',
    '/data/broker.sqlite',
    '--email',
    'docker-smoke@example.test',
    '--token-file',
    '/data/setup-token',
  ]);
  assert.ok(creates[1].args.some((arg) => arg.includes('target=/data')));
  const paths = h.requests.map(({ path }) => path);
  assert.deepEqual(paths, [
    '/health/ready',
    '/_pb/auth/local/setup/start',
    '/_pb/auth/local/setup/finish',
    '/_pb/session',
    '/_pb/projects',
    '/_pb/sources',
    `/_pb/sources/${sourceId}/names`,
    `/_pb/sources/${sourceId}/enable`,
    `/_pb/projects/smoke/sources/${sourceId}/attachment`,
    '/_pb/projects/smoke/sources',
    `/_pb/sources/${sourceId}/names`,
    '/_pb/me/tokens',
    '/smoke/p2/docker-smoke/fixture.json',
    '/_pb/projects/smoke/sources',
  ]);
  assert.equal(h.requests.find(({ path }) => path.endsWith('/attachment')).init.method, 'PUT');
  assert.deepEqual(h.requests.find(({ path }) => path === '/_pb/me/tokens').body, {
    name: 'Docker smoke read',
    scope: 'read',
    readOnly: true,
    lifetimeDays: 1,
    projectMode: 'selected',
    projectIds: ['project-id'],
  });
  const source = h.requests.find(({ path }) => path === '/_pb/sources').body;
  assert.equal(source.url, 'https://fixture:8443/');
  const composer = creates[2].args;
  assert.ok(composer.includes('composer:2'));
  assert.ok(composer.includes('install'));
  assert.ok(composer.includes('--no-plugins'));
  assert.ok(composer.includes('--no-scripts'));
  assert.equal(h.messages.length, 2);
  verifyNoSecrets(h.messages, [setupToken, totpSecret, readToken]);
  await assertCleaned(h);
});

test('source creation, registered name and attachment bodies match their OpenAPI schemas', async () => {
  const document = JSON.parse(
    await readFile(new URL('../packages/ui/openapi.json', import.meta.url)),
  );
  const h = harness();
  await h.run();
  for (const spec of [
    SOURCE_API_SPECS.find(({ api }) => api.operationId === 'createOrganizationSource'),
    SOURCE_NAMES_API_SPECS.find(({ api }) => api.operationId === 'addRegisteredName'),
    SOURCE_ATTACHMENT_API_SPECS.find(({ api }) => api.operationId === 'attachSource'),
  ]) {
    const path = spec.path.replace(/:project\b/, 'smoke').replace(/:source\b/, sourceId);
    const request = h.requests.find((request) => request.path === path);
    assert.equal(request.init.method, spec.method);
    const operation = Object.values(document.paths)
      .flatMap((methods) => Object.values(methods))
      .find(({ operationId }) => operationId === spec.api.operationId);
    const schema = spec.api.body.toJSONSchema();
    delete schema.$schema;
    assert.deepEqual(schema, operation.requestBody.content['application/json'].schema);
    assert.deepEqual(spec.api.body.parse(request.body), request.body);
  }
  const namesIndex = h.requests.findIndex(({ path }) => path.endsWith('/names'));
  const enableIndex = h.requests.findIndex(({ path }) => path.endsWith('/enable'));
  const attachmentIndex = h.requests.findIndex(({ path }) => path.endsWith('/attachment'));
  assert.ok(namesIndex < enableIndex && enableIndex < attachmentIndex);
  assert.deepEqual(h.requests[namesIndex].body, { pattern: 'docker-smoke/fixture' });
  assert.equal(h.requests[enableIndex].body, undefined);
  assert.deepEqual(h.requests[attachmentIndex].body, {});
  assert.equal(h.requests.find(({ path }) => path === '/_pb/sources').body.pollIntervalSeconds, 60);
  await assertCleaned(h);
});

test('fixture source is canonical and passes runtime validation only with the fixture outbound policy', async () => {
  const h = harness();
  await h.run();
  const body = h.requests.find(({ path }) => path === '/_pb/sources').body;
  assert.equal(isCanonicalUrl(body.url), true);
  assert.equal(isConfigOf(body.type, body.config), true);
  const parse = (url, allowPrivateHosts) =>
    parseSourceConfig(body.type, body.ecosystem, url, JSON.stringify(body.config), {
      runtime: 'node',
      hasCredential: false,
      policy: createOutboundPolicy({
        runtime: 'node',
        allowPrivateHosts,
        selfOrigins: ['http://127.0.0.1:8787'],
      }),
    });
  assert.deepEqual(parse(body.url, ['fixture:8443']), { ok: true, config: body.config });
  for (const result of [
    parse(body.url, []),
    parse(body.url.replace('https:', 'http:'), ['fixture:8443']),
    parse(body.url, ['fixture']),
  ]) {
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.problems.map(({ field }) => field),
      ['url'],
    );
  }
  await assertCleaned(h);
});

test('uses a Node-accepted public origin reachable by Composer with matching API and auth origins', async () => {
  const h = harness();
  await h.run();
  const broker = h.calls.find(({ check }) => check === 'functional-create-broker').args;
  const origin = broker
    .find((arg) => arg.startsWith('PB_PUBLIC_URL='))
    .slice('PB_PUBLIC_URL='.length);
  assert.equal(parsePublicOrigin(origin, { http: 'loopback' }), origin);
  assert.equal(origin, 'http://127.0.0.1:8787');
  for (const { url } of h.requests) assert.equal(new URL(url).origin, origin);
  for (const { init } of h.requests.filter(({ path }) => path.startsWith('/_pb/'))) {
    assert.equal(init.headers.origin, origin);
  }
  const composer = h.calls.find(({ check }) => check === 'functional-create-composer').args;
  assert.equal(
    composer[composer.indexOf('--network') + 1],
    `container:${broker[broker.indexOf('--name') + 1]}`,
  );
  assert.ok(!composer.includes('--network-alias'));
  await assertCleaned(h);
});

test('a private host certificate is mounted outside the data volume and readable before nonroot startup', async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.mountedCertificate(), {
    mode: 0o644,
    mount: `type=bind,source=${join(h.directory(), 'fixture.crt')},target=/tmp/fixture.crt,readonly`,
  });
  assert.ok(!h.calls.some(({ args }) => args[0] === 'cp' && args.at(-1).includes(':/')));
  const broker = h.calls.find(({ check }) => check === 'functional-create-broker').args;
  assert.ok(broker.includes('NODE_EXTRA_CA_CERTS=/tmp/fixture.crt'));
  assert.ok(!broker.includes('--user'));
  await assertCleaned(h);
});

test('functional HTTP uses broker loopback without host fetch, container IPs or published ports', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('host HTTP must not be used');
  });
  const h = harness();
  await h.run();
  const create = h.calls.find(({ check }) => check === 'functional-create-broker').args;
  const broker = create[create.indexOf('--name') + 1];
  assert.ok(!create.includes('--publish'));
  const inspection = h.calls.find(({ check }) => check === 'functional-health');
  assert.ok(!inspection.args[inspection.args.indexOf('--format') + 1].includes('NetworkSettings'));
  const requests = h.calls.filter(({ check }) => check === 'functional-http');
  assert.equal(requests.length, h.requests.length);
  for (const { args, options } of requests) {
    assert.deepEqual(args.slice(0, 4), ['exec', broker, 'node', '--eval']);
    const [url, init, timeout] = JSON.parse(args.at(-1));
    assert.equal(new URL(url).origin, 'http://127.0.0.1:8787');
    assert.equal(init.redirect, 'error');
    assert.equal(options.timeout, timeout);
    assert.ok(options.signal instanceof AbortSignal);
  }
  const [url, init, timeout] = JSON.parse(requests[0].args.at(-1));
  assert.equal(url, 'http://127.0.0.1:8787/health/ready');
  assert.deepEqual(init, { method: 'GET', redirect: 'error' });
  assert.equal(timeout, 2000);
  assert.ok(h.events.indexOf('/health/ready') < h.events.indexOf('functional-bootstrap'));
  await assertCleaned(h);
});

test('startup retries Docker health, connection refusal and HTTP 503 before HTTP 200', async () => {
  const h = harness({
    health: ['starting', 'starting', 'healthy'],
    probeResponses: [
      {
        error: Object.assign(new Error('private connection error'), {
          cause: { code: 'ECONNREFUSED' },
        }),
      },
      { status: 503 },
      { status: 200 },
    ],
  });
  await h.run();
  assert.deepEqual(h.waits, [250, 250, 250, 250]);
  assert.equal(h.requests.filter(({ path }) => path === '/health/ready').length, 3);
  const lastProbe = h.events.lastIndexOf('/health/ready');
  assert.ok(lastProbe < h.events.indexOf('functional-bootstrap'));
  await assertCleaned(h);
});

test('startup deadline reports the last HTTP 403 without its body or starting bootstrap', async () => {
  const h = harness({ probeResponses: [{ status: 403, body: readToken }] });
  await assert.rejects(h.run(), { message: 'functional: broker startup failed' });
  assert.equal(
    h.waits.reduce((sum, ms) => sum + ms, 0),
    60_000,
  );
  assert.ok(
    h.messages.some((line) => line.includes('last result: HTTP 403; Docker health: healthy')),
  );
  assert.ok(!h.calls.some(({ check }) => check === 'functional-bootstrap'));
  verifyNoSecrets(h.messages, [readToken]);
  await assertCleaned(h);
});

for (const [error, expected] of [
  [Object.assign(new Error(readToken), { cause: { code: 'ECONNREFUSED' } }), 'ECONNREFUSED'],
  [Object.assign(new Error(readToken), { name: 'TimeoutError' }), 'TimeoutError'],
  [
    Object.assign(new Error(readToken), { cause: { code: `unsafe ${readToken}` } }),
    'request failed or timed out',
  ],
]) {
  test(`startup reports only an allowed transport error: ${expected}`, async () => {
    const h = harness({ probeResponses: [{ error }] });
    await assert.rejects(h.run(), { message: 'functional: broker startup failed' });
    assert.equal(
      h.waits.reduce((sum, ms) => sum + ms, 0),
      60_000,
    );
    assert.ok(
      h.messages.some((line) => line.includes(`last result: ${expected}; Docker health: healthy`)),
    );
    assert.ok(!h.calls.some(({ check }) => check === 'functional-bootstrap'));
    verifyNoSecrets(h.messages, [readToken]);
    await assertCleaned(h);
  });
}

test('startup inspect, HTTP and retry timeouts fit the remaining monotonic deadline', async () => {
  const h = harness({
    probeResponses: [
      { status: 503, elapsed: 59_700 },
      { status: 503, elapsed: 50 },
    ],
  });
  await assert.rejects(h.run(), { message: 'functional: broker startup failed' });
  assert.deepEqual(h.waits, [250]);
  const requests = h.calls.filter(({ check }) => check === 'functional-http');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.timeout, 50);
  assert.equal(JSON.parse(requests[1].args.at(-1))[2], 50);
  assert.equal(h.calls.filter(({ check }) => check === 'functional-health')[1].options.timeout, 50);
  assert.ok(h.messages.some((line) => line.includes('last result: HTTP 503')));
  await assertCleaned(h);
});

test('an HTTP 200 arriving after the startup deadline still fails before bootstrap', async () => {
  const h = harness({ probeResponses: [{ status: 200, elapsed: 60_001 }] });
  await assert.rejects(h.run(), { message: 'functional: broker startup failed' });
  assert.ok(!h.calls.some(({ check }) => check === 'functional-bootstrap'));
  assert.ok(h.messages.some((line) => line.includes('last result: HTTP 200')));
  await assertCleaned(h);
});

test('startup HTTP interruption prevents bootstrap and still cleans up', async () => {
  const abort = new AbortController();
  const h = harness({ abort, abortDuringProbe: abort });
  await assert.rejects(h.run(), { message: 'functional: broker startup failed' });
  assert.ok(abort.signal.aborted);
  assert.ok(!h.calls.some(({ check }) => check === 'functional-bootstrap'));
  await assertCleaned(h);
});

test('startup waits at most 60 seconds when Docker health remains starting', async () => {
  const h = harness({ health: 'starting' });
  await assert.rejects(h.run(), { message: 'functional: broker startup failed' });
  assert.equal(
    h.waits.reduce((sum, ms) => sum + ms, 0),
    60_000,
  );
  assert.equal(h.requests.length, 0);
  assert.ok(
    h.messages.some((line) => line.includes('last result: not attempted; Docker health: starting')),
  );
  await assertCleaned(h);
});

test('malformed HTTP transport output stays private and fails startup with cleanup', async () => {
  const h = harness({ malformedHttp: true });
  await assert.rejects(h.run(), { message: 'functional: broker startup failed' });
  assert.ok(h.messages.some((line) => line.includes('last result: request failed or timed out')));
  verifyNoSecrets(h.messages, [readToken]);
  await assertCleaned(h);
});

test('the HTTP transport keeps stderr in the secret sentinel while accepting credential responses', async () => {
  const h = harness({ httpStderr: readToken });
  await assert.rejects(h.run(), /secret-output:/);
  assert.ok(
    h.messages.every((line) => line.startsWith('smoke:docker functional diagnostics (broker):')),
  );
  verifyNoSecrets(h.messages, [readToken, setupToken, totpSecret]);
  await assertCleaned(h);
});

test('waits for the fixture version to appear before starting Composer', async () => {
  const h = harness({
    metadataResponses: [
      { status: 404, body: {} },
      { status: 503, body: {} },
      { status: 200, body: { packages: { 'docker-smoke/fixture': [] } } },
      { status: 200, body: { packages: { 'docker-smoke/fixture': [{ version: '0.9.0' }] } } },
      { status: 200, body: { packages: { 'docker-smoke/fixture': [{ version: '1.0.0' }] } } },
    ],
  });
  await h.run();
  const path = '/smoke/p2/docker-smoke/fixture.json';
  assert.equal(h.requests.filter((request) => request.path === path).length, 5);
  assert.equal(h.waits.length, 4);
  assert.ok(h.events.lastIndexOf(path) < h.events.indexOf('functional-create-composer'));
  await assertCleaned(h);
});

for (const row of [
  { attached: false, status: 'active' },
  { attached: true, status: 'paused' },
]) {
  test(`source readback refuses attached=${row.attached}, status=${row.status} before token issuance`, async () => {
    const h = harness({ sourceStatus: () => ({ id: sourceId, ...row }) });
    await assert.rejects(h.run(), { message: 'functional: session source configuration failed' });
    assert.ok(!h.requests.some(({ path }) => path === '/_pb/me/tokens'));
    assert.ok(!h.calls.some(({ check }) => check === 'functional-create-composer'));
    await assertCleaned(h);
  });
}

test('registered-name readback refuses a source without the fixture name', async () => {
  const h = harness({ registeredNames: [{ pattern: 'other/package' }] });
  await assert.rejects(h.run(), { message: 'functional: session source configuration failed' });
  assert.ok(!h.requests.some(({ path }) => path === '/_pb/me/tokens'));
  await assertCleaned(h);
});

test('allows a minute-based poll and dispatch to take longer than the former ingestion deadline', async () => {
  const h = harness({
    metadataResponses: [
      ...Array.from({ length: 260 }, () => ({ status: 404, body: {} })),
      { status: 200, body: { packages: { 'docker-smoke/fixture': [{ version: '1.0.0' }] } } },
    ],
  });
  await h.run();
  assert.equal(
    h.waits.reduce((sum, ms) => sum + ms, 0),
    65_000,
  );
  const reads = h.requests.filter(({ path }) => path === '/_pb/projects/smoke/sources');
  assert.equal(reads.length, 2);
  assert.ok(
    h.events.lastIndexOf('/smoke/p2/docker-smoke/fixture.json') <
      h.events.lastIndexOf(reads[1].path),
  );
  assert.ok(h.events.lastIndexOf(reads[1].path) < h.events.indexOf('functional-create-composer'));
  assert.ok(h.messages.some((line) => line.includes('"lastSuccessAt":"2026-10-23T10:00:00.000Z"')));
  assert.ok(
    h.messages.some((line) => line.includes('"lastErrorCode":"not exposed by source API"')),
  );
  await assertCleaned(h);
});

test('ingestion failure reads the latest source status without exposing other source fields', async () => {
  const h = harness({
    metadataResponses: [{ status: 404, body: {} }],
    sourceStatus: ({ afterIngestion }) => ({
      id: sourceId,
      attached: true,
      status: afterIngestion ? 'failing' : 'active',
      pollIntervalSeconds: 60,
      lastSuccessAt: null,
      name: `private ${readToken}`,
      url: 'https://user:short-password@fixture:8443/',
      email: 'docker-smoke@example.test',
    }),
  });
  await assert.rejects(h.run(), { message: 'functional: fixture ingestion failed' });
  const diagnostic = h.messages.find((line) => line.includes('source status:'));
  assert.ok(diagnostic.includes('"status":"failing"'));
  assert.ok(diagnostic.includes('"lastSuccessAt":null'));
  assert.ok(!diagnostic.includes('private'));
  verifyNoSecrets(h.messages, [readToken, 'short-password', 'docker-smoke@example.test']);
  assert.equal(h.requests.at(-1).path, '/_pb/projects/smoke/sources');
  await assertCleaned(h);
});

test('source status diagnostics scrub unexpected credential values in selected fields', async () => {
  const h = harness({
    sourceStatus: ({ afterIngestion }) => ({
      id: sourceId,
      attached: true,
      status: afterIngestion ? readToken : 'active',
      lastSuccessAt: afterIngestion ? 'docker-smoke@example.test' : null,
    }),
  });
  await h.run();
  assert.ok(
    h.messages.some((line) => line.includes('source status:') && line.includes('[redacted]')),
  );
  verifyNoSecrets(h.messages, [readToken, 'docker-smoke@example.test']);
  await assertCleaned(h);
});

test('a failed final status read preserves the ingestion failure and still cleans up', async () => {
  let reads = 0;
  const h = harness({
    metadataResponses: [{ status: 404, body: {} }],
    apiResponses: {
      '/_pb/projects/smoke/sources': () =>
        ++reads === 1
          ? { status: 200, body: { items: [{ id: sourceId, attached: true, status: 'active' }] } }
          : { status: 503, body: { error: { code: 'unavailable', message: readToken } } },
    },
  });
  await assert.rejects(h.run(), { message: 'functional: fixture ingestion failed' });
  assert.equal(reads, 2);
  assert.ok(h.messages.some((line) => line.includes('source status: unavailable')));
  assert.ok(h.messages.some((line) => line.includes('HTTP 503 GET /_pb/projects/smoke/sources')));
  verifyNoSecrets(h.messages, [readToken]);
  await assertCleaned(h);
});

test('ingestion polling has a bounded timeout and cleans up without starting Composer', async () => {
  const h = harness({ metadataResponses: [{ status: 404, body: {} }] });
  await assert.rejects(h.run(), /^Error: functional: fixture ingestion failed$/);
  assert.equal(
    h.waits.reduce((sum, ms) => sum + ms, 0),
    180_000,
  );
  assert.ok(!h.calls.some(({ check }) => check === 'functional-create-composer'));
  assert.equal(h.messages.length, 5);
  assert.ok(h.messages.some((line) => line.includes('HTTP 404 GET /smoke/p2/')));
  verifyNoSecrets(h.messages, [readToken, setupToken, totpSecret]);
  await assertCleaned(h);
});

test('ingestion HTTP errors suppress response data and prevent Composer from starting', async () => {
  const h = harness({ httpFailure: '/smoke/p2/docker-smoke/fixture.json' });
  await assert.rejects(h.run(), /^Error: functional: fixture ingestion failed$/);
  assert.ok(!h.calls.some(({ check }) => check === 'functional-create-composer'));
  assert.equal(h.messages.length, 5);
  assert.ok(h.messages.some((line) => line.includes('HTTP 403 GET /smoke/p2/')));
  verifyNoSecrets(h.messages, [readToken, setupToken, totpSecret]);
  await assertCleaned(h);
});

test('ingestion polling respects interruption and still cleans up', async () => {
  const abort = new AbortController();
  const h = harness({
    abort,
    abortDuringIngestion: abort,
    metadataResponses: [{ status: 404, body: {} }],
  });
  await assert.rejects(h.run(), /^Error: functional: fixture ingestion failed$/);
  assert.equal(abort.signal.aborted, true);
  assert.ok(!h.calls.some(({ check }) => check === 'functional-create-composer'));
  await assertCleaned(h);
});

for (const failAt of [
  'functional-network',
  'functional-volume',
  'functional-create-fixture',
  'functional-fixture-start',
  'functional-create-broker',
  'functional-start',
  'functional-health',
  'functional-http',
  'functional-bootstrap',
  'functional-token-file',
  'functional-create-composer',
  'functional-composer',
  'functional-composer-exit',
  'functional-logs',
  'cleanup-container',
  'cleanup-volume',
  'cleanup-network',
]) {
  test(`cleans all resources and suppresses subprocess secrets after ${failAt} fails`, async () => {
    const h = harness({ failAt });
    await assert.rejects(h.run(), (error) => {
      assert.ok(!error.message.includes(readToken));
      return /functional/.test(error.message);
    });
    await assertCleaned(h);
    assert.ok(
      h.messages.every((message) => message.startsWith('smoke:docker functional diagnostics (')),
    );
    verifyNoSecrets(h.messages, [readToken, setupToken, totpSecret]);
  });
}

for (const leak of [
  'setup-token',
  'password',
  'totp-secret',
  'code',
  'read-token',
  'basic-auth',
  'failed-command',
]) {
  test(`sentinel detects ${leak} without printing it, including failed subprocess output`, async () => {
    const h = harness({
      leak,
      ...(leak === 'failed-command' ? { failAt: 'functional-composer' } : {}),
    });
    await assert.rejects(
      h.run(),
      /^Error: secret-output: sensitive value found in captured output \(suppressed\)$/,
    );
    await assertCleaned(h);
    assert.ok(h.messages.some((message) => message.includes('exit state:')));
    const alias = ['read-token', 'basic-auth', 'failed-command'].includes(leak)
      ? 'composer'
      : 'broker';
    assert.ok(
      h.messages.every(
        (message) =>
          message.startsWith(`smoke:docker functional diagnostics (${alias}):`) ||
          message.startsWith('smoke:docker functional diagnostics (broker): source status:'),
      ),
    );
    verifyNoSecrets(h.messages, [readToken, setupToken, totpSecret]);
  });
}

test('aborted checks still clean up without passing the aborted signal', async () => {
  const abort = new AbortController();
  const h = harness({ failAt: 'functional-composer', abort });
  await assert.rejects(h.run(), /functional/);
  assert.equal(abort.signal.aborted, true);
  await assertCleaned(h);
});

test('HTTP errors suppress their response bodies and prevent Composer from starting', async () => {
  const h = harness({ httpFailure: '/_pb/sources' });
  await assert.rejects(
    h.run(),
    /^Error: functional: session source configuration failed \(HTTP 403\)$/,
  );
  assert.ok(!h.calls.some(({ check }) => check === 'functional-composer'));
  await assertCleaned(h);
});

for (const [path, method, status, stage, code, paths] of [
  ['/_pb/auth/local/setup/start', 'POST', 400, 'local setup', 'invalid_request', ['/body/token']],
  ['/_pb/session', 'GET', 401, 'session project configuration', 'unauthenticated', []],
  ['/_pb/sources', 'POST', 400, 'session source configuration', 'invalid_request', ['/body/url']],
  [
    `/_pb/sources/${sourceId}/enable`,
    'POST',
    409,
    'session source configuration',
    'activation_requires_registered_names',
    [],
  ],
  [
    `/_pb/projects/smoke/sources/${sourceId}/attachment`,
    'PUT',
    400,
    'session source configuration',
    'invalid_request',
    ['/body/precedence'],
  ],
  ['/_pb/me/tokens', 'POST', 500, 'session read token', 'internal_error', []],
]) {
  test(`HTTP ${status} from ${method} ${path} reports only code and detail paths`, async () => {
    const h = harness({
      apiResponses: {
        [path]: {
          status,
          body: {
            error: {
              code,
              details: paths.map((path) => ({ path, code: 'invalid', value: readToken })),
              message: `private ${readToken}`,
              requestId: setupToken,
            },
            extra: totpSecret,
          },
        },
      },
    });
    await assert.rejects(h.run(), {
      message: `functional: ${stage} failed (HTTP ${status})`,
    });
    const diagnostic = h.messages.find((line) =>
      line.startsWith(`smoke:docker functional diagnostics (broker): HTTP ${status} ${method} `),
    );
    // Long error codes and ULIDs also pass through the credential-shape scrubber.
    const expected = scrubDiagnostics(
      `HTTP ${status} ${method} ${path}: code=${JSON.stringify(code)}; details paths=${JSON.stringify(paths)}`,
      [setupToken, totpSecret, readToken],
    );
    assert.ok(diagnostic?.endsWith(expected));
    assert.equal(
      h.messages.some((line) =>
        line.includes('--build-arg CONFIG=fixtures/docker-smoke/broker.config.ts'),
      ),
      path === '/_pb/sources',
    );
    assert.ok(h.messages.every((line) => !line.includes('private')));
    verifyNoSecrets(h.messages, [setupToken, totpSecret, readToken]);
    assert.ok(!h.calls.some(({ check }) => check === 'functional-create-composer'));
    await assertCleaned(h);
  });
}

test('API error codes and detail paths pass through the credential and email scrubber', async () => {
  const h = harness({
    apiResponses: {
      '/_pb/sources': {
        status: 400,
        body: {
          error: {
            code: `invalid_${setupToken}`,
            details: [
              { path: `/body/${totpSecret}` },
              { path: '/body/docker-smoke@example.test' },
              { path: 'https://user:short-password@fixture:8443/' },
            ],
          },
        },
      },
    },
  });
  await assert.rejects(h.run(), /session source configuration failed \(HTTP 400\)/);
  const diagnostic = h.messages.find((line) => line.includes('HTTP 400 POST /_pb/sources:'));
  assert.ok(diagnostic.includes('[redacted]'));
  verifyNoSecrets(h.messages, [
    setupToken,
    totpSecret,
    readToken,
    'docker-smoke@example.test',
    'short-password',
  ]);
  await assertCleaned(h);
});

for (const [label, response] of [
  ['non-JSON', { text: `non-JSON ${readToken}` }],
  ['null body', { body: null }],
  ['null error', { body: { error: null } }],
  [
    'wrong field types',
    { body: { error: { code: { value: readToken }, details: { path: readToken } } } },
  ],
  [
    'malformed details',
    { body: { error: { code: 'invalid_request', details: [null, {}, { path: 123 }] } } },
  ],
]) {
  test(`malformed API error envelope stays private: ${label}`, async () => {
    const h = harness({ apiResponses: { '/_pb/sources': { status: 400, ...response } } });
    await assert.rejects(h.run(), {
      message: 'functional: session source configuration failed (HTTP 400)',
    });
    const diagnostic = h.messages.find((line) => line.includes('HTTP 400 POST /_pb/sources:'));
    assert.ok(diagnostic.endsWith('details paths=[]'));
    verifyNoSecrets(h.messages, [readToken]);
    await assertCleaned(h);
  });
}

test('retriable non-2xx responses report deduplicated envelopes even when ingestion later succeeds', async () => {
  const h = harness({
    probeResponses: [
      { status: 503, body: JSON.stringify({ error: { code: 'not_ready', details: [] } }) },
      { status: 200 },
    ],
    metadataResponses: [
      { status: 503, body: { error: { code: 'unavailable', details: [] } } },
      { status: 503, body: { error: { code: 'unavailable', details: [] } } },
      { status: 200, body: { packages: { 'docker-smoke/fixture': [{ version: '1.0.0' }] } } },
    ],
  });
  await h.run();
  assert.equal(
    h.messages.filter((line) => line.includes('HTTP 503 GET /health/ready: code="not_ready"'))
      .length,
    1,
  );
  assert.equal(
    h.messages.filter((line) =>
      line.includes('HTTP 503 GET /smoke/p2/docker-smoke/fixture.json: code="unavailable"'),
    ).length,
    1,
  );
  assert.match(h.messages.at(-1), /Composer install passed; secret sentinel passed/);
  await assertCleaned(h);
});

test('a nonzero Composer exit fails even if output files look successful', async () => {
  const h = harness({ composerExit: '1' });
  await assert.rejects(h.run(), /Composer install failed/);
  await assertCleaned(h);
});

test('refuses a lock recording the upstream URL', async () => {
  const h = harness({
    mutateLock: (value) => {
      value.packages[0].dist.url = 'https://fixture:8443/dist/fixture.tar.gz';
    },
  });
  await assert.rejects(h.run(), /Composer install failed/);
  await assertCleaned(h);
});

test('lock and installed-content assertions cannot pass on absent, wrong or credential-bearing data', () => {
  verifyComposerInstall(lock, installed, 'http://broker:8787');
  for (const value of [{}, { packages: [] }, { packages: [{ name: 'other' }] }]) {
    assert.throws(() => verifyComposerInstall(value, installed, 'http://broker:8787'));
  }
  for (const url of [
    'http://user:secret@broker:8787/smoke/dist/docker-smoke/fixture/file',
    'http://broker:8787/smoke/dist/docker-smoke/fixture/file?token=secret',
    'http://broker:8787/other/file',
  ]) {
    const changed = structuredClone(lock);
    changed.packages[0].dist.url = url;
    assert.throws(() => verifyComposerInstall(changed, installed, 'http://broker:8787'));
  }
  assert.throws(() => verifyComposerInstall(lock, '', 'http://broker:8787'));
});

test('fixture serves metadata and a real archive containing the expected PHP file', async () => {
  const get = (url) => {
    let status;
    let body;
    fixtureHandler(
      { url },
      {
        writeHead: (value) => {
          status = value;
        },
        end: (value) => {
          body = value;
        },
      },
    );
    return { status, body };
  };
  const directory = await mkdtemp(join(tmpdir(), 'pb-docker-fixture-test-'));
  try {
    const root = JSON.parse(get('/packages.json').body);
    assert.equal(root['metadata-url'], '/p2/%package%.json');
    assert.deepEqual(root['available-packages'], ['docker-smoke/fixture']);
    const metadataPath = root['metadata-url'].replace('%package%', 'docker-smoke/fixture');
    assert.equal(get(metadataPath).status, 200);
    const metadata = JSON.parse(get(metadataPath).body);
    const devPath = root['metadata-url'].replace('%package%', 'docker-smoke/fixture~dev');
    assert.equal(get(devPath).status, 200);
    assert.deepEqual(JSON.parse(get(devPath).body), { packages: { 'docker-smoke/fixture': [] } });
    const policy = createOutboundPolicy({
      runtime: 'node',
      allowPrivateHosts: ['fixture:8443'],
      selfOrigins: ['http://127.0.0.1:8787'],
    });
    const fetched = [];
    const fetchFixture = createPolicyFetch({
      policy,
      userAgent: 'DockerSmoke',
      fetchImpl: async (url) => {
        assert.equal(new URL(url).origin, 'https://fixture:8443');
        fetched.push(new URL(url).pathname);
        const response = get(new URL(url).pathname);
        return new Response(response.body, { status: response.status });
      },
    });
    const parsedRoot = await readComposerRoot(fetchFixture, {
      url: 'https://fixture:8443/',
      allowedOrigins: [],
      policy,
    });
    assert.equal(parsedRoot.mode, 'v2');
    assert.deepEqual(parsedRoot.availablePackages, ['docker-smoke/fixture']);
    const described = await describeComposerV2(
      fetchFixture,
      { root: parsedRoot, allowedOrigins: [] },
      'docker-smoke/fixture',
      {
        path: 'job',
        dev: true,
        probe: { secrets: [], queryParams: [] },
        clock: { now: () => new Date('2026-10-23T10:00:00.000Z') },
      },
    );
    assert.equal(described.kind, 'found');
    const members = [];
    for await (const member of described.description.members) members.push(member);
    assert.deepEqual(
      members.map(({ version }) => version),
      ['1.0.0'],
    );
    assert.equal(described.description.upstreamComplete, true);
    assert.deepEqual(fetched, ['/packages.json', metadataPath, devPath]);
    const pkg = metadata.packages['docker-smoke/fixture'][0];
    const bytes = get('/dist/fixture.tar.gz').body;
    assert.equal(createHash('sha1').update(bytes).digest('hex'), pkg.dist.shasum);
    assert.equal(pkg.dist.url, 'https://fixture:8443/dist/fixture.tar.gz');
    await writeFile(join(directory, 'archive.tar.gz'), bytes);
    await execute('tar', ['-xzf', join(directory, 'archive.tar.gz'), '-C', directory]);
    assert.equal(await readFile(join(directory, 'fixture/installed.php'), 'utf8'), installed);
    assert.equal(get('/missing').status, 404);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('TLS preparation uses a local SAN certificate and discards openssl errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-docker-tls-test-'));
  try {
    await prepareFunctionalFiles(directory);
    const cert = await execute('openssl', [
      'x509',
      '-in',
      join(directory, 'fixture.crt'),
      '-noout',
      '-ext',
      'subjectAltName',
    ]);
    assert.match(cert.stdout, /DNS:fixture/);
    await assert.rejects(
      prepareFunctionalFiles(dirname(directory), {
        execute: async () => {
          throw new Error(readToken);
        },
      }),
      /^Error: fixture-tls: could not generate local certificate \(requires openssl\)$/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Docker CLI dependency staging resolves private package manifests and runs the real admin command', async () => {
  const { cp } = await import('node:fs/promises');
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'pb-docker-cli-test-'));
  try {
    const dockerfile = await readFile(join(repository, 'Dockerfile'), 'utf8');
    const helper = dockerfile.slice(
      dockerfile.indexOf('async function copyDependencies('),
      dockerfile.indexOf('\nconst manifest = JSON.parse'),
    );
    const copyDependencies = new Function(
      'readFile',
      'cp',
      'createRequire',
      'dirname',
      'join',
      `${helper}\nreturn copyDependencies;`,
    )(readFile, cp, createRequire, dirname, join);
    await cp(join(repository, 'packages/cli/dist'), join(directory, 'dist'), { recursive: true });
    await cp(join(repository, 'packages/cli/package.json'), join(directory, 'package.json'));
    await copyDependencies(directory, join(repository, 'packages/cli/package.json'));
    const cli = join(directory, 'dist/bin.js');
    const version = await execute(process.execPath, [cli, 'version']);
    assert.match(version.stdout, /2\.0\.0/);
    await assert.rejects(
      execute(process.execPath, [
        cli,
        'admin',
        'bootstrap',
        '--sqlite',
        join(directory, 'absent.sqlite'),
        '--email',
        'docker-smoke@example.test',
        '--token-file',
        join(directory, 'setup-token'),
      ]),
      (error) => error.code === 2 && error.stderr.includes('sqlite_file_not_found'),
    );
    await assert.rejects(stat(join(directory, 'setup-token')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an already absent Docker network is considered cleaned', async () => {
  await assert.doesNotReject(
    docker(['network', 'rm', 'absent'], 'cleanup-network', {
      execute: async () => {
        throw Object.assign(new Error('private subprocess output'), {
          code: 1,
          stderr: 'Error response from daemon: network absent not found\n',
        });
      },
    }),
  );
});

for (const [name, options, stage] of [
  ['invalid token file', { setupFile: 'invalid' }, 'admin bootstrap'],
  ['invalid provisioning secret', { setupSecret: 'invalid' }, 'local setup'],
  ['missing session cookies', { sessionCookies: false }, 'local setup'],
  ['unhealthy broker', { health: 'unhealthy' }, 'broker startup'],
  ['exited broker', { running: false }, 'broker startup'],
]) {
  test(`rejects ${name} before Composer starts`, async () => {
    const h = harness(options);
    await assert.rejects(h.run(), { message: `functional: ${stage} failed` });
    assert.ok(!h.calls.some(({ check }) => check === 'functional-composer'));
    await assertCleaned(h);
  });
}
