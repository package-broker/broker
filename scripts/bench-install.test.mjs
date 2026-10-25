import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, stat, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPhpVersion,
  brokerLock,
  command,
  composerEnvironment,
  marketplacePackages,
  resolveArgs,
  schedule,
  generateAuth,
  generateProject,
  markdown,
  parseOptions,
  plan,
  redactResults,
  rewriteLockedPackage,
  statistics,
  startBroker,
} from './bench-install.mjs';

const scratch = fileURLToPath(new URL('../.pb', import.meta.url));
await mkdir(scratch, { recursive: true });

test('options validate counts, scenario names, duplicates and missing values', () => {
  assert.equal(parseOptions([]).runs, 5);
  assert.deepEqual(
    parseOptions([
      '--runs',
      '2',
      '--scenarios',
      'broker-proxy',
      '--out',
      'result.json',
      '--dry-run',
    ]).scenarios,
    ['broker-proxy'],
  );
  assert.equal(parseOptions(['--help']).help, true);
  for (const args of [
    ['--runs', '0'],
    ['--runs', '1.5'],
    ['--runs', '9007199254740992'],
    ['--runs'],
    ['--scenarios', 'unknown'],
    ['--scenarios', 'broker-proxy,broker-proxy'],
    ['--out', '--help'],
    ['--what'],
  ])
    assert.throws(() => parseOptions(args));
});

test('plans include cache states and omit Marketplace measurements without both keys', () => {
  const entries = plan(parseOptions([]), false);
  assert.deepEqual(entries[0].states, ['cold', 'warm']);
  assert.deepEqual(entries[1].states, ['cold', 'warm-broker', 'warm']);
  assert.deepEqual(
    entries.map((entry) => entry.skipped),
    [false, false, true, true, false, false, true, true],
  );
  assert.ok(plan(parseOptions([]), true).every((entry) => !entry.skipped));
});

test('statistics exclude failed runs and handle odd, even and empty samples', () => {
  const run = (wallMs, exitCode = 0) => ({ wallMs, exitCode });
  assert.deepEqual(statistics([run(9), run(1), run(5), run(999, 1)]), {
    successful: 3,
    medianMs: 5,
    minMs: 1,
    maxMs: 9,
  });
  assert.equal(statistics([run(2), run(6)]).medianMs, 4);
  assert.equal(statistics([]), null);
  assert.equal(statistics([run(2, 1)]), null);
});

test('project generation replaces inherited repositories without mutating the fixture', () => {
  const input = {
    require: { 'vendor/package': '1' },
    repositories: [{ url: 'https://old.test' }],
    config: { 'sort-packages': true },
  };
  const original = structuredClone(input);
  assert.equal(Object.hasOwn(generateProject(input), 'repositories'), false);

  const broker = generateProject(input, 'http://127.0.0.1:123');
  assert.deepEqual(broker.repositories, [
    { type: 'composer', url: 'http://127.0.0.1:123/bench' },
    { 'packagist.org': false },
  ]);
  assert.equal(broker.config['allow-plugins'], false);
  assert.equal(broker.config['secure-http'], false);
  assert.deepEqual(input, original);
});

test('auth generation scopes Marketplace credentials upstream and token credentials to broker', () => {
  const keys = { publicKey: 'public-secret', privateKey: 'private-secret' };
  assert.deepEqual(generateAuth(), { 'http-basic': {} });
  assert.deepEqual(generateAuth(keys), {
    'http-basic': { 'repo.magento.com': { username: keys.publicKey, password: keys.privateKey } },
  });
  assert.deepEqual(
    generateAuth({ ...keys, brokerOrigin: 'http://127.0.0.1:123', token: 'read-token' }),
    { 'http-basic': { '127.0.0.1:123': { username: 'token', password: 'read-token' } } },
  );
});

test('results select measured fields and remove credentials, URLs, emails and IPs', () => {
  const credential = 'secret-credential-value';
  const input = {
    environment: {
      os: 'linux',
      cpuModel: credential,
      node: 'v24',
      php: 'PHP 8.4',
      composer: 'Composer version 2.8',
      date: '2026-10-25T12:00:00.000Z',
      brokerCommit: 'a'.repeat(40),
      cpuCount: 4,
      ramBytes: 1024,
      auth: credential,
    },
    runs: [
      {
        scenario: 'broker-proxy',
        state: 'cold',
        repetition: 1,
        wallMs: 10,
        exitCode: 0,
        packageCount: 103,
        measurement: 'install',
        timedOut: false,
        output: credential,
        auth: generateAuth({ publicKey: credential, privateKey: credential }),
      },
    ],
    auth: credential,
  };
  const secrets = [credential, 'broker-token-sentinel', 'pbmk_v1_master-sentinel'];
  const results = redactResults(input, secrets);
  for (const secret of secrets) {
    const copy = structuredClone(input);
    copy.environment.cpuModel = secret;
    assert.ok(!JSON.stringify(redactResults(copy, secrets)).includes(secret));
  }
  assert.ok(!JSON.stringify(results).includes(credential));
  assert.equal(results.runs[0].packageCount, 103);
  assert.equal(Object.hasOwn(results.runs[0], 'bytesDownloaded'), false);
  assert.equal(results.environment.brokerCommit, 'a'.repeat(40));
  for (const value of ['https://user:pass@example.test/', 'user@example.test', '127.0.0.1']) {
    input.environment.cpuModel = value;
    assert.ok(!JSON.stringify(redactResults(input, [credential])).includes(value));
  }
  input.runs[0].wallMs = credential;
  assert.equal(redactResults(input, [credential]).runs[0].wallMs, null);
});

test('locked archives require broker URLs and the pinned reference and strip source fallback', () => {
  const origin = 'http://127.0.0.1:123';
  const pkg = {
    name: 'vendor/pkg',
    version: 'v1.0',
    dist: { reference: 'abc' },
    source: { url: 'https://upstream.test' },
  };
  const dist = { url: origin + '/bench/dist/vendor/pkg/id.1.zip', reference: 'abc', type: 'zip' };
  const result = rewriteLockedPackage(pkg, [{ version: 'v1.0', dist }], origin);
  assert.deepEqual(result.dist, dist);
  assert.equal(result.source, undefined);
  assert.deepEqual(
    rewriteLockedPackage(pkg, [{ version: 'v0', dist }, { version: 'v1.0' }], origin).dist,
    dist,
  );
  for (const url of [
    'https://upstream.test/a.zip',
    origin + '/wrong/path',
    'http://user:password@127.0.0.1:123/bench/dist/pkg',
    dist.url + '?token=secret',
  ])
    assert.throws(() =>
      rewriteLockedPackage(pkg, [{ version: 'v1.0', dist: { ...dist, url } }], origin),
    );
  assert.throws(() =>
    rewriteLockedPackage(pkg, [{ version: 'v1.0', dist: { ...dist, reference: 'other' } }], origin),
  );
  assert.throws(() => rewriteLockedPackage(pkg, [], origin));
  assert.throws(() =>
    rewriteLockedPackage(
      pkg,
      [
        { version: 'v0', dist },
        { version: 'v1.0', dist: '__unset' },
      ],
      origin,
    ),
  );
});

test('summary separates install and resolve and excludes failed timings', () => {
  const summary = markdown([
    { measurement: 'install', scenario: 'broker-proxy', state: 'cold', wallMs: 999, exitCode: 1 },
  ]);
  assert.match(summary, /0\/1/);
  assert.ok(!summary.includes('999'));
  assert.match(summary, /resolve/);
});

test('help and dry-run work with no Composer, PHP or broker available and expose no keys', () => {
  const script = fileURLToPath(new URL('./bench-install.mjs', import.meta.url));
  for (const flag of ['--help', '--dry-run']) {
    const result = spawnSync(process.execPath, [script, flag], {
      encoding: 'utf8',
      env: {
        PATH: '',
        PB_BENCH_MAGENTO_PUBLIC_KEY: 'public-sentinel',
        PB_BENCH_MAGENTO_PRIVATE_KEY: 'private-sentinel',
      },
    });
    assert.equal(result.status, 0);
    assert.ok(!result.stdout.includes('sentinel'));
    assert.match(result.stdout, flag === '--help' ? /--runs/ : /warm-broker/);
  }
});

test('auth.json is written with mode 0600', async () => {
  const directory = await mkdtemp(join(scratch, 'bench-auth-test-'));
  try {
    const env = await composerEnvironment(
      directory,
      generateAuth({ publicKey: 'public', privateKey: 'private' }),
    );
    const path = join(env.COMPOSER_HOME, 'auth.json');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(await readFile(path, 'utf8'))['http-basic']['repo.magento.com'].password,
      'private',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('brokerLock retries non-JSON and queued metadata and stops at the deadline', async () => {
  const broker = { origin: 'http://127.0.0.1:123', token: 'private' };
  const pkg = { name: 'vendor/pkg', version: '1', dist: { reference: 'abc' } };
  const lock = { packages: [pkg] };
  let time = 0;
  let calls = 0;
  const timing = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    timeoutMs: 500,
  };
  const result = await brokerLock(lock, broker, {
    ...timing,
    fetchMetadata: async () => {
      calls++;
      return {
        ok: true,
        json: async () => {
          if (calls === 1) throw new SyntaxError('Transient non-JSON response');
          return {
            packages: {
              'vendor/pkg':
                calls === 2
                  ? []
                  : [{ ...pkg, dist: { reference: 'abc', url: '/bench/dist/pkg/id.zip' } }],
            },
          };
        },
      };
    },
  });
  assert.equal(calls, 3);
  assert.equal(time, 500);
  assert.match(result.packages[0].dist.url, /127\.0\.0\.1/);
  calls = 0;
  time = 0;
  await assert.rejects(
    brokerLock(lock, broker, {
      ...timing,
      fetchMetadata: async () => {
        calls++;
        return { ok: false };
      },
    }),
    /timed out/,
  );
  assert.equal(time, 500);
  assert.equal(calls, 3);
});

test('schedule is repetition-major and resolve uses update without install', () => {
  const options = parseOptions(['--runs', '2', '--scenarios', 'upstream-direct,broker-proxy']);
  const jobs = schedule(options, false);
  assert.deepEqual(
    jobs.map(({ repetition }) => repetition),
    [1, 1, 1, 1, 2, 2, 2, 2],
  );
  assert.deepEqual(
    jobs.slice(0, 4).map(({ scenario }) => scenario),
    ['upstream-direct', 'broker-proxy', 'upstream-direct', 'broker-proxy'],
  );
  const resolving = jobs.filter(({ measurement }) => measurement === 'resolve');
  assert.deepEqual(resolving[0].argv, [
    'update',
    '--no-install',
    '--no-interaction',
    '--no-scripts',
    '--no-plugins',
  ]);
  assert.deepEqual(resolving[0].argv, resolveArgs);
  assert.deepEqual(resolving[1].states, ['cold', 'warm-broker', 'warm']);
});

test('timeout terminates the child and is recorded as a failed run', async () => {
  const result = await command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 100,
  });
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.equal(statistics([{ ...result, wallMs: 100 }]), null);
  assert.equal(parseOptions([]).timeoutMinutes, 30);
  assert.equal(parseOptions(['--timeout-minutes', '0.5']).timeoutMinutes, 0.5);
  for (const value of ['0', '-1', 'NaN', 'Infinity', '40000'])
    assert.throws(() => parseOptions(['--timeout-minutes', value]));
});

test('Marketplace owns only packages locked to its dist host', () => {
  assert.deepEqual(
    marketplacePackages({
      packages: [
        { name: 'magento/pkg', dist: { url: 'https://repo.magento.com/a.zip' } },
        { name: 'public/pkg', dist: { url: 'https://codeload.github.com/a.zip' } },
        { name: 'metapackage' },
      ],
      'packages-dev': [{ name: 'dev/pkg', dist: { url: 'https://repo.magento.com/b.zip' } }],
    }),
    ['magento/pkg', 'dev/pkg'],
  );
});

test('PHP requirement fails clearly below 8.4.1', () => {
  for (const version of ['8.4.1', '8.5.0', '9.0.0'])
    assert.doesNotThrow(() => assertPhpVersion(version));
  for (const version of ['8.4.0', '8.3.99', '7.4.33', ''])
    assert.throws(() => assertPhpVersion(version), /PHP >= 8.4.1/);
});

test('option errors are visible and dry-run contains concrete argv and directories', () => {
  const script = fileURLToPath(new URL('./bench-install.mjs', import.meta.url));
  const invalid = spawnSync(process.execPath, [script, '--runs', '0'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid run count/);
  const result = spawnSync(
    process.execPath,
    [script, '--dry-run', '--scenarios', 'upstream-direct,broker-proxy', '--runs', '1'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  const dry = JSON.parse(result.stdout);
  assert.equal(dry.baseDirectory, join(scratch, 'bench-install'));
  assert.ok(!result.stdout.includes('<session>'));
  const broker = dry.plans.find((entry) => entry.scenario === 'broker-proxy');
  assert.deepEqual(broker.bootstrapArgv.slice(2, 4), ['admin', 'bootstrap']);
  assert.equal(broker.commands[0].argv[0], 'composer');
  assert.deepEqual(dry.plans.find((entry) => entry.measurement === 'resolve').commands[0].argv, [
    'composer',
    ...resolveArgs,
  ]);
});

for (const signal of ['SIGINT', 'SIGTERM'])
  test(
    `${signal} kills Composer and removes the interrupted session`,
    { timeout: 10_000 },
    async () => {
      const directory = await mkdtemp(join(scratch, 'bench-interrupt-test-'));
      const marker = join(directory, 'running.json');
      let child;
      let running;
      try {
        await writeFile(join(directory, 'php'), '#!/bin/sh\necho 8.4.1\n', { mode: 0o700 });
        await writeFile(
          join(directory, 'composer'),
          `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nif (process.argv.includes('--version')) console.log('Composer version 2.8.0');\nelse { writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, home: process.env.COMPOSER_HOME })); setInterval(() => {}, 1000); }\n`,
          { mode: 0o700 },
        );
        const preload = join(directory, 'offline.mjs');
        await writeFile(preload, 'globalThis.fetch = async () => new Response("{}");');
        child = spawn(
          process.execPath,
          [
            '--import',
            preload,
            fileURLToPath(new URL('./bench-install.mjs', import.meta.url)),
            '--runs',
            '1',
            '--scenarios',
            'upstream-direct',
            '--out',
            join(directory, 'results.json'),
          ],
          { env: { PATH: directory }, stdio: 'ignore' },
        );
        const exited = once(child, 'close');
        for (let i = 0; i < 200; i++) {
          running = await readFile(marker, 'utf8')
            .then(JSON.parse)
            .catch(() => undefined);
          if (running) break;
          await delay(10);
        }
        assert.ok(running, 'Composer must start before interruption');
        assert.equal((await stat(join(running.home, 'auth.json'))).mode & 0o777, 0o600);
        child.kill(signal);
        assert.equal((await exited)[0], 130);
        await assert.rejects(stat(running.home), { code: 'ENOENT' });
        const session = running.home.split('/upstream-direct/')[0].replace(/\/install$/, '');
        await assert.rejects(stat(session), { code: 'ENOENT' });
        assert.throws(() => process.kill(running.pid, 0), { code: 'ESRCH' });
      } finally {
        child?.kill('SIGKILL');
        if (running) {
          try {
            process.kill(running.pid, 'SIGKILL');
          } catch (error) {
            assert.equal(error.code, 'ESRCH');
          }
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

const brokerBuilt = await Promise.all(
  ['../.pb/node/server.js', '../packages/cli/dist/bin.js'].map((path) =>
    stat(new URL(path, import.meta.url)).then(
      () => true,
      () => false,
    ),
  ),
).then((available) => available.every(Boolean));

test(
  'broker bundle serves authenticated Composer root and stop removes its directory',
  {
    skip: !brokerBuilt && 'Run pnpm build and pnpm bundle first',
    timeout: 90_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(scratch, 'bench-broker-test-'));
    let broker;
    try {
      try {
        broker = await startBroker(directory, false, {});
      } catch (error) {
        if (error.name === 'LocalUnavailable') {
          t.skip('Sandbox does not permit loopback listeners');
          return;
        }
        throw error;
      }
      const response = await fetch(`${broker.origin}/bench/packages.json`, {
        headers: {
          authorization: `Basic ${Buffer.from(`token:${broker.token}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      await broker.stop();
      await assert.rejects(stat(directory), { code: 'ENOENT' });
    } finally {
      await broker?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('PHP preflight reports missing and nonzero PHP without a version message', async () => {
  const directory = await mkdtemp(join(scratch, 'bench-php-test-'));
  const script = fileURLToPath(new URL('./bench-install.mjs', import.meta.url));
  try {
    for (const php of [null, '#!/bin/sh\necho 8.3.0\nexit 1\n', '#!/bin/sh\necho 8.3.0\n']) {
      if (php) await writeFile(join(directory, 'php'), php, { mode: 0o700 });
      const result = spawnSync(process.execPath, [script, '--scenarios', 'upstream-direct'], {
        encoding: 'utf8',
        env: { PATH: directory },
      });
      assert.equal(result.status, 1);
      if (php?.endsWith('echo 8.3.0\n')) assert.match(result.stderr, /PHP >= 8.4.1/);
      else {
        assert.match(result.stderr, /php not found/);
        assert.doesNotMatch(result.stderr, /PHP >=/);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
