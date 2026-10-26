import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INSTALL_NOT_RUN,
  discoverTarball,
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
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nwriteFileSync(join(process.argv.at(-1), 'packed.tgz'), 'fixture');\n`,
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
