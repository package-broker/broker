import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const runtime = process.argv[2] ?? 'node';
assert.ok(['node', 'cloudflare'].includes(runtime));
const directory = `packages/runtime-${runtime}/src/restore-rehearsal`;
const cases =
  runtime === 'node'
    ? [
        [
          'broken-database',
          'rehearsal.test.support.ts',
          'await copyFile(source.database, target.database);',
          `await copyFile(source.database, target.database);
          const broken = openBetterSqliteExecutor(target.database);
          try {await broken.executor.batch([{sql:'UPDATE local_login SET password_hash = NULL WHERE org_id = ?',params:[manifest.objects[0]!.orgId]}]);} finally {await broken.close();}`,
          'restore-rehearsal.test.ts',
          '1: sign-in',
        ],
        [
          'omit-blobs',
          'rehearsal.test.support.ts',
          'if (!options.skipBlobs) await cp',
          'if (options.skipBlobs) await cp',
          'restore-rehearsal.test.ts',
          '3: a restore',
        ],
        [
          'strip-keys',
          'rehearsal.test.support.ts',
          'if (!options.skipKeys) {',
          'if (options.skipKeys) {',
          'restore-rehearsal.test.ts',
          '1: sign-in',
        ],
        [
          'wrong-key-control',
          'rehearsal.test.support.ts',
          'if (options.masterKey !== undefined)',
          'if (false)',
          'restore-rehearsal.test.ts',
          '2a: a well-formed wrong',
        ],
        [
          'empty-target-guard',
          'rehearsal.test.support.ts',
          'throw new RestoreTargetNotEmptyError();',
          'void 0;',
          'inventory.test.ts',
          'refuses non-empty',
        ],
        [
          'digest-oracle',
          'fixture.test.support.ts',
          'digest(bytes) === seeded.sha256',
          'true',
          'restore-rehearsal.test.ts',
          '2d: same-length',
        ],
      ]
    : [
        [
          'omit-blobs',
          'rehearsal.test.support.ts',
          'if (!options.skipBlobs)',
          'if (options.skipBlobs)',
          'restore-rehearsal.test.ts',
          '1: restored',
        ],
        [
          'strip-keys',
          'rehearsal.test.support.ts',
          'if (!options.skipKeys) {',
          'if (options.skipKeys) {',
          'restore-rehearsal.test.ts',
          '1: restored',
        ],
        [
          'wrong-key-control',
          'rehearsal.test.support.ts',
          'if (options.masterKey !== undefined)',
          'if (false)',
          'restore-rehearsal.test.ts',
          '2a: wrong',
        ],
        [
          'empty-target-guard',
          'rehearsal.test.support.ts',
          'throw new RestoreTargetNotEmptyError();',
          'void 0;',
          'restore-rehearsal.test.ts',
          '5: refuses',
        ],
        [
          'digest-oracle',
          'fixture.test.support.ts',
          'digest(bytes) === seeded.sha256',
          'true',
          'restore-rehearsal.test.ts',
          'same-length corrupt',
        ],
      ];
const selected = process.argv[3] ? cases.filter(([name]) => name === process.argv[3]) : cases;
assert.ok(selected.length);
for (const [name, file, before, after, test, filter] of selected) {
  const path = resolve(root, directory, file);
  const original = await readFile(path, 'utf8');
  assert.ok(original.includes(before), `mutation location missing: ${name}`);
  try {
    await writeFile(path, original.replaceAll(before, after));
    const result = spawnSync(
      'pnpm',
      [
        'vitest',
        'run',
        '--project',
        `runtime-${runtime}`,
        `${directory.slice(directory.indexOf('/src/') + 1)}/${test}`,
        '-t',
        filter,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    process.stdout.write(
      `\nMUTATION ${runtime}/${name}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
    assert.notEqual(result.status, 0, `mutation survived: ${name}`);
    assert.match(
      result.stdout + result.stderr,
      /AssertionError:/,
      'collection, setup and listener failures are not mutation proof',
    );
    process.stdout.write(`MUTATION ${name}: killed by behavioral assertion\n`);
  } finally {
    await writeFile(path, original);
  }
}
