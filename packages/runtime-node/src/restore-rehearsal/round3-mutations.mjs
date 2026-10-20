import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cases = [
  {
    name: 'sqlite-sidecars',
    file: 'packages/runtime-node/src/restore-rehearsal/rehearsal.test.support.ts',
    mutate: (source) =>
      source.replace(
        / {4}\(await exists\(paths\.database \+ '-(?:wal|shm|journal)'\)\) \|\|\n/g,
        '',
      ),
    args: ['--project', 'runtime-node', 'src/restore-rehearsal/inventory.test.ts', '-t', 'orphan'],
  },
  ...['node', 'cloudflare'].flatMap((runtime) => [
    {
      name: `${runtime}-text-serialization`,
      file: `packages/runtime-${runtime}/src/restore-rehearsal/sql-snapshot.test.support.ts`,
      mutate: (source) =>
        source.replace(
          'THEN hex(CAST(${quoteId(col.name)} AS BLOB))',
          'THEN hex(CAST(substr(${quoteId(col.name)}, 1) AS BLOB))',
        ),
      args: [
        '--project',
        `runtime-${runtime}`,
        'src/restore-rehearsal/sql-snapshot.test.ts',
        '-t',
        'preserves embedded NULs',
      ],
    },
    {
      name: `${runtime}-totp-clock`,
      file: `packages/runtime-${runtime}/src/restore-rehearsal/fixture.test.support.ts`,
      mutate: (source) =>
        source.replace('systemClock.now = () => new Date(instant);', 'systemClock.now = previous;'),
      args: [
        '--project',
        `runtime-${runtime}`,
        'src/restore-rehearsal/fixture-clock.test.ts',
        '-t',
        'one-millisecond',
      ],
    },
  ]),
];
const sha = (path) =>
  execFileSync('shasum', ['-a', '256', path], { encoding: 'utf8' }).split(/\s/)[0];
const saved = await mkdtemp(join(tmpdir(), 'pb-round3-mutants-'));
try {
  for (const [index, mutant] of cases.entries()) {
    const path = join(root, mutant.file);
    const copy = join(saved, String(index));
    const before = sha(path);
    await cp(path, copy);
    try {
      const source = await readFile(path, 'utf8');
      const mutated = mutant.mutate(source);
      assert.notEqual(mutated, source, `mutation location missing: ${mutant.name}`);
      await writeFile(path, mutated);
      const changed = sha(path);
      assert.notEqual(changed, before);
      const result = spawnSync('pnpm', ['vitest', 'run', ...mutant.args], {
        cwd: root,
        encoding: 'utf8',
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      assert.notEqual(result.status, 0, `mutation survived: ${mutant.name}`);
      assert.match(output, /AssertionError:/, `not a behavioral failure: ${output}`);
      process.stdout.write(
        `${mutant.name}: KILLED (exit ${result.status})\n${output.match(/AssertionError:[^\n]*/)?.[0]}\n${output.match(/Tests\s+[^\n]*/)?.[0]}\nbefore ${before}\nmutant ${changed}\n`,
      );
    } finally {
      await cp(copy, path);
      const restored = sha(path);
      process.stdout.write(`restored ${restored}\n`);
      assert.equal(restored, before);
    }
  }
} finally {
  await rm(saved, { recursive: true, force: true });
}
