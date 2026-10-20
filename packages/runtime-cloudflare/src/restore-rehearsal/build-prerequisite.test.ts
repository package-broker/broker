import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rehearsalBuildAvailable } from './rehearsal.test.support.js';

describe('rehearsal build prerequisites without built artifacts', () => {
  it('requires every candidate dist entrypoint before enabling the suites', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pb-rehearsal-build-'));
    try {
      expect(rehearsalBuildAvailable(root)).toBe(false);
      const packages = ['core', 'db-sqlite', 'runtime-node', 'runtime-cloudflare'];
      for (const pkg of packages) {
        const dist = join(root, 'packages', pkg, 'dist');
        await mkdir(dist, { recursive: true });
        expect(rehearsalBuildAvailable(root)).toBe(false);
        await writeFile(join(dist, 'index.js'), 'export {};');
      }
      expect(rehearsalBuildAvailable(root)).toBe(true);
      for (const pkg of packages) {
        const entrypoint = join(root, 'packages', pkg, 'dist', 'index.js');
        await rm(entrypoint);
        expect(rehearsalBuildAvailable(root)).toBe(false);
        await writeFile(entrypoint, 'export {};');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
