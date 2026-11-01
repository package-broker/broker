import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { checkEvidence, checkInstalled, rehearse } from './npm-restore-rehearsal.mjs';

const evidence = () => ({
  published: true,
  built: true,
  sourceRemoved: true,
  freshTarget: true,
  restoredObjects: 2,
  installed: ['matrix-publish-active', 'restore-built'],
});

test('restore acceptance requires both origins and fresh storage', () => {
  checkEvidence(evidence());
  for (const key of ['published', 'built', 'sourceRemoved', 'freshTarget']) {
    assert.throws(() => checkEvidence({ ...evidence(), [key]: false }));
  }
  assert.throws(() => checkEvidence({ ...evidence(), restoredObjects: 0 }));
  assert.throws(() => checkEvidence({ ...evidence(), installed: ['matrix-publish-active'] }));
});

test('install acceptance rejects wrong names, versions and file bytes', () => {
  const manifest = JSON.stringify({ name: 'restore-built', version: '1.0.0' });
  checkInstalled('restore-built', manifest, 'module.exports = true;\n');
  for (const bad of ['{}', '{', manifest.replace('1.0.0', '2.0.0')]) {
    assert.throws(() => checkInstalled('restore-built', bad, 'module.exports = true;\n'));
  }
  assert.throws(() => checkInstalled('wrong', manifest, 'module.exports = true;\n'));
  assert.throws(() => checkInstalled('restore-built', manifest, 'corrupt'));
});

test('CLI refuses unknown arguments without echoing request data', async () => {
  const run = promisify(execFile);
  const hostile = 'Bearer private-token https://user:password@fixture.test account@fixture.test';
  await assert.rejects(
    run(process.execPath, ['scripts/npm-restore-rehearsal.mjs', hostile]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(
        error.stderr,
        'npm restore rehearsal: FAIL (build prerequisites or rehearsal step failed; private diagnostics suppressed)\n',
      );
      return true;
    },
  );
});

test(
  'storage-only rehearsal restores repository-built storage keys (requires pnpm build)',
  {
    skip: !['core', 'db-sqlite', 'runtime-node', 'runtime-cloudflare'].every((name) =>
      existsSync(new URL(`../packages/${name}/dist/index.js`, import.meta.url)),
    ),
  },
  async () => {
    await rehearse({ storageOnly: true });
  },
);

test(
  'inventory refuses a recorded storage key outside the restored blob directory',
  {
    skip: !existsSync(new URL('../packages/runtime-node/dist/index.js', import.meta.url)),
  },
  async () => {
    const { checkInventory, deploymentPaths, BackupIntegrityError } =
      await import('../packages/runtime-node/dist/restore-rehearsal/rehearsal.test.support.js');
    const paths = deploymentPaths(new URL('../.pb/path-refusal', import.meta.url).pathname);
    for (const storageKey of ['../outside', '/outside', '.']) {
      await assert.rejects(
        checkInventory(paths, [
          {
            orgId: 'fixture',
            sha256: 'a'.repeat(64),
            size: 0,
            mediaType: 'application/gzip',
            storageKey,
          },
        ]),
        BackupIntegrityError,
      );
    }
  },
);
