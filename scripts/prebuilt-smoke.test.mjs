import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INSTALL_NOT_RUN,
  discoverTarball,
  copyMetafile,
  installNeedsNetwork,
  loadExpectedRecord,
  parseExpectedRecord,
  runPrebuiltSmoke,
} from './prebuilt-smoke.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const expected = {
  schemaVersion: 1,
  package: '@package-broker/dist-cloudflare',
  version: '2.0.0-rc.0',
  artifactSha256: 'a'.repeat(64),
  prebuiltJsonSha256: 'b'.repeat(64),
};

async function fixture(t) {
  await mkdir(join(ROOT, '.pb'), { recursive: true });
  const root = await mkdtemp(join(ROOT, '.pb', 'prebuilt-smoke-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('discovers the tarball without depending on pack stdout or a hardcoded version', () => {
  for (const name of [
    'package-broker-dist-2.0.0-rc.0.tgz',
    'package-broker-dist-cloudflare-3.1.4.tgz',
  ])
    assert.equal(discoverTarball(['notes.txt', name, 'package.json']), name);
  for (const names of [[], ['notes.txt'], ['one.tgz', 'two.tgz']])
    assert.throws(() => discoverTarball(names), /exactly one packed tarball/);
});

test('loads the staged CLI expected record and reports missing staging', async (t) => {
  const root = await fixture(t);
  const path = join(root, 'prebuilt-expected.json');
  await assert.rejects(loadExpectedRecord(path), /pnpm stage:prebuilt --write-cli-expected/);
  await writeFile(path, JSON.stringify(expected));
  assert.deepEqual(await loadExpectedRecord(path), expected);
  await writeFile(path, 'invalid private input');
  await assert.rejects(loadExpectedRecord(path), { message: 'Invalid prebuilt expected record' });
});

test('rejects malformed expected records before packing', () => {
  const invalid = [null, [], {}, 'secret', { ...expected, extra: true }];
  for (const key of Object.keys(expected)) {
    const record = { ...expected };
    delete record[key];
    invalid.push(record);
  }
  for (const [key, value] of [
    ['schemaVersion', 2],
    ['package', '@package-broker/dist'],
    ['version', 42],
    ['version', ''],
    ['artifactSha256', 'a'.repeat(63)],
    ['artifactSha256', ['a'.repeat(64)]],
    ['prebuiltJsonSha256', 'x'.repeat(64)],
    ['prebuiltJsonSha256', ['b'.repeat(64)]],
  ])
    invalid.push({ ...expected, [key]: value });
  for (const record of invalid)
    assert.throws(() => parseExpectedRecord(JSON.stringify(record)), {
      message: 'Invalid prebuilt expected record',
    });
  assert.throws(() => parseExpectedRecord('private input'), {
    message: 'Invalid prebuilt expected record',
  });
});

test('classifies network failures but never successful installs or unrelated failures', () => {
  for (const code of [
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ETIMEDOUT',
    'ENOTCACHED',
  ]) {
    for (const output of [
      { stderr: `npm error code ${code}` },
      { stdout: `prebuild-install ${code}` },
      { error: { code } },
    ]) {
      assert.equal(installNeedsNetwork({ status: 1, ...output }), true);
      assert.equal(installNeedsNetwork({ status: 0, ...output }), false);
    }
  }
  for (const output of [
    { stderr: 'gyp ERR! build error' },
    { stderr: 'npm error code ERESOLVE' },
    { stderr: 'better-sqlite3 failed to compile' },
    { error: { code: 'ENOENT' } },
    {},
  ])
    assert.equal(installNeedsNetwork({ status: 1, ...output }), false);
});

for (const [diagnostic, message] of [
  ['npm error code ENOTFOUND\nprivate-registry-output', INSTALL_NOT_RUN],
  ['gyp ERR! build error\nprivate-build-output', 'npm install failed'],
]) {
  test(`install failure emits the right classification and cleans up: ${message}`, async (t) => {
    const root = await fixture(t);
    const cli = join(root, 'packages/cli/dist');
    await mkdir(cli, { recursive: true });
    await writeFile(join(cli, 'prebuilt-expected.json'), JSON.stringify(expected));
    for (const pkg of ['prebuilt', 'prebuilt-cloudflare'])
      await mkdir(join(root, 'packages', pkg), { recursive: true });
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'pnpm'),
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { join, relative } from 'node:path';\nwriteFileSync(join(process.argv.at(-1), 'packed.tgz'), 'fixture');\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, 'npm'),
      `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(diagnostic)});\nprocess.exitCode = 1;\n`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      await assert.rejects(runPrebuiltSmoke({ root }), (error) => {
        assert.equal(error.message, message);
        assert.equal(error.exitCode, 1);
        return true;
      });
    } finally {
      process.env.PATH = originalPath;
    }
    assert.deepEqual(await readdir(join(root, '.pb')), []);
  });
}

for (const target of ['node', 'cloudflare']) {
  for (const change of ['none', 'chunk', 'migration', 'extra', 'missing', 'asset']) {
    test(`metafile ${target}: validates the whole payload (${change})`, async (t) => {
      const root = await fixture(t);
      const built = join(root, '.pb', target);
      const installed = join(root, 'installed');
      for (const dir of [built, installed]) {
        await mkdir(join(dir, 'migrations'), { recursive: true });
        await mkdir(join(dir, 'assets'), { recursive: true });
        for (const [name, bytes] of [
          [target === 'node' ? 'server.js' : 'worker.js', 'entry'],
          ['chunk.js', 'chunk'],
          ['migrations/0001.sql', 'schema'],
          ['build-info.json', '{}'],
          ['assets/index.html', 'asset'],
        ])
          await writeFile(join(dir, name), bytes);
      }
      await writeFile(join(built, 'metafile.json'), '{"inputs":{}}');
      await writeFile(join(built, 'package.json'), '{}');
      await writeFile(join(built, 'server.js.map'), 'omitted diagnostic');
      if (target === 'cloudflare') await writeFile(join(installed, 'prebuilt.json'), '{}');
      if (change === 'chunk') await writeFile(join(installed, 'chunk.js'), 'changed');
      if (change === 'migration')
        await writeFile(join(installed, 'migrations/0001.sql'), 'changed');
      if (change === 'extra') await writeFile(join(installed, 'extra.txt'), 'extra');
      if (change === 'missing') await rm(join(installed, 'chunk.js'));
      if (change === 'asset') await writeFile(join(installed, 'assets/index.html'), 'changed');
      if (['none', 'asset'].includes(change)) {
        await copyMetafile(root, target, installed);
        assert.equal(await readFile(join(installed, 'metafile.json'), 'utf8'), '{"inputs":{}}');
      } else {
        await assert.rejects(copyMetafile(root, target, installed), {
          message:
            'Smoke metafile needs matching payloads; re-run pnpm bundle && pnpm stage:prebuilt',
        });
        await assert.rejects(readFile(join(installed, 'metafile.json')), { code: 'ENOENT' });
      }
    });
  }
}

test('runner preserves the installed Node layout and selects prebuilt mode for both smokes', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'packages/cli/dist'), { recursive: true });
  await writeFile(join(root, 'packages/cli/dist/prebuilt-expected.json'), JSON.stringify(expected));
  const calls = [];
  const run = (program, args, options, label) => {
    calls.push({ program, args, options, label });
    if (program === 'pnpm') writeFileSync(join(args.at(-1), 'fixture.tgz'), 'tarball');
    if (label === 'smoke:prebuilt Node leg') {
      assert.equal(existsSync(join(options.env.SMOKE_NODE_DIR, 'package.json')), false);
      assert.equal(existsSync(join(options.env.SMOKE_NODE_DIR, 'node_modules')), false);
    }
  };
  const materialize = async ({ project }) => {
    for (const [target, pkg] of [
      ['node', 'dist'],
      ['cloudflare', 'dist-cloudflare'],
    ]) {
      const packageDir = join(project, 'node_modules/@package-broker', pkg);
      const out = join(packageDir, target);
      const built = join(root, '.pb', target);
      await mkdir(out, { recursive: true });
      await mkdir(built, { recursive: true });
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: `@package-broker/${pkg}`,
          exports: { './package.json': './package.json', './prebuilt.json': './prebuilt.json' },
        }),
      );
      await writeFile(join(packageDir, 'prebuilt.json'), JSON.stringify(expected));
      for (const dir of [out, built])
        await writeFile(join(dir, target === 'node' ? 'server.js' : 'worker.js'), 'entry');
      await writeFile(join(built, 'metafile.json'), '{}');
    }
    return {
      artifactSha256: expected.artifactSha256,
      outDir: join(project, 'node_modules/@package-broker/dist-cloudflare/cloudflare'),
    };
  };
  await runPrebuiltSmoke({ root, run, materialize });
  const smokes = calls.filter(({ label }) => /smoke:prebuilt .* leg/.test(label));
  assert.equal(smokes.length, 2);
  for (const { options } of smokes) assert.equal(options.env.SMOKE_PREBUILT, '1');
  assert.match(
    smokes[0].options.env.SMOKE_NODE_DIR,
    /project\/node_modules\/@package-broker\/dist\/node$/,
  );
  assert.deepEqual(await readdir(join(root, '.pb')), ['cloudflare', 'node']);
});

test('Node prebuilt startup uses the installed entry and hoisted resolution from another cwd', async (t) => {
  const root = await fixture(t);
  const runtime = join(root, 'project/node_modules/@package-broker/dist/node');
  const dependency = join(root, 'project/node_modules/smoke-hoisted');
  await mkdir(runtime, { recursive: true });
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(root, 'project/node_modules/@package-broker/dist/package.json'),
    JSON.stringify({ type: 'module' }),
  );
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ exports: './index.mjs' }));
  await writeFile(join(dependency, 'index.mjs'), "export default 'hoisted';");
  const marker = join(root, 'started.json');
  await writeFile(
    join(runtime, 'server.js'),
    `
import { writeFileSync } from 'node:fs';
import value from 'smoke-hoisted';
writeFileSync(process.env.SMOKE_TEST_MARKER, JSON.stringify({ cwd: process.cwd(), value }));
process.exit(31);
`,
  );
  // Startup exits before serving HTTP; avoid binding a port in restricted sandboxes.
  const preload = join(root, 'no-network.mjs');
  await writeFile(
    preload,
    `
import net from 'node:net';
net.createServer = () => ({
  once() {},
  listen(_port, ready) { ready(); },
  address() { return { port: 32000 }; },
  close(done) { done(); },
});
globalThis.fetch = () => new Promise(() => {});
`,
  );
  const result = spawnSync(
    process.execPath,
    ['--import', preload, join(ROOT, 'scripts/node-bundle-smoke.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        SMOKE_PREBUILT: '1',
        SMOKE_OFFLINE: '1',
        SMOKE_NODE_DIR: relative(ROOT, runtime),
        SMOKE_TEST_MARKER: marker,
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /server exited with code 31 before becoming ready/);
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { cwd: runtime, value: 'hoisted' });
  assert.equal(existsSync(join(runtime, 'package.json')), false);
  assert.equal(existsSync(join(runtime, 'node_modules')), false);
});
