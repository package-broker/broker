import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const path = join(root, 'packages/core/src/architecture.test.ts');
const sha = () => execFileSync('shasum', ['-a', '256', path], { encoding: 'utf8' }).split(/\s/)[0];
const saved = await mkdtemp(join(tmpdir(), 'pb-round4-mutant-'));
const copy = join(saved, 'architecture.test.ts');
const before = sha();
try {
  await cp(path, copy);
  try {
    const source = await readFile(path, 'utf8');
    const narrowed = String.raw`/^packages\/runtime-(?:node|cloudflare)\/src\/restore-rehearsal\/[^/]+\.test\.support\.ts$/`;
    const widened = String.raw`/^packages\/runtime-(?:node|cloudflare)\/src\/.+\.test\.support\.ts$/`;
    assert.equal(source.split(narrowed).length, 2, 'classification location missing or repeated');
    await writeFile(path, source.replace(narrowed, widened));
    const changed = sha();
    assert.notEqual(changed, before);
    const result = spawnSync(
      'pnpm',
      [
        'vitest',
        'run',
        '--project',
        'core',
        'src/architecture.test.ts',
        '-t',
        'host scripts|host helpers',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 1, `unexpected mutant exit: ${output}`);
    assert.match(output, /AssertionError: [^\n]*expected 'script' to be 'source'/);
    assert.match(output, /Tests\s+2 failed \| 2 passed/);
    process.stdout.write(
      `rehearsal-host-classification: KILLED (exit ${result.status})\n${output.match(/AssertionError:[^\n]*/)?.[0]}\n${output.match(/Tests\s+[^\n]*/)?.[0]}\nbefore ${before}\nmutant ${changed}\n`,
    );
  } finally {
    await cp(copy, path);
    const restored = sha();
    process.stdout.write(`restored ${restored}\n`);
    assert.equal(restored, before);
  }
} finally {
  await rm(saved, { recursive: true, force: true });
}
