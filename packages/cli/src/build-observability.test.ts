import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from './build.js';
import { run } from './cli.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(observability: unknown) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pb-observability-'));
  dirs.push(cwd);
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(cwd, 'node_modules'),
    'dir',
  );
  const configPath = path.join(cwd, 'broker.config.ts');
  await writeFile(
    configPath,
    `export default ${JSON.stringify({ platform: 'node', plugins: [], observability })};`,
  );
  const runtimeEntry = path.join(cwd, 'entry.ts');
  await writeFile(runtimeEntry, "export { observability } from '#pb-manifest';");
  return { cwd, configPath, runtimeEntry };
}

describe('build observability', () => {
  for (const target of ['node', 'cloudflare'] as const) {
    it.each([true, false, undefined])(`carries %s through the ${target} manifest`, async (flag) => {
      const observability = flag === undefined ? undefined : { trustInboundTraceparent: flag };
      const result = await build({ ...(await fixture(observability)), target });
      const bundled = (await import(/* @vite-ignore */ pathToFileURL(result.bundle).href)) as {
        observability?: unknown;
      };
      expect(bundled.observability).toEqual(observability);
    });

    it.each(['private-invalid-value', 1, null, {}, []])(
      `rejects a non-boolean flag for ${target} without echoing it`,
      async (flag) => {
        const options = await fixture({ trustInboundTraceparent: flag });
        const failure: unknown = await build({ ...options, target }).catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
          'invalid broker config:\nobservability.trustInboundTraceparent: must be a boolean',
        );
        await expect(
          readFile(path.join(options.cwd, '.pb', target, 'generated', 'manifest.ts')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
  }

  it('prints the validation message, not the value, and exits 2 for a non-boolean flag', async () => {
    const secret = 'SENTINEL-flag-value';
    const { cwd, configPath } = await fixture({ trustInboundTraceparent: secret });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    expect(await run(['build', '--config', configPath])).toBe(2);
    const printed = error.mock.calls.map((call) => call.join(' '));
    expect(printed).toEqual(['error: observability.trustInboundTraceparent: must be a boolean']);
    expect(printed.join('\n')).not.toContain(secret);
  });
});
