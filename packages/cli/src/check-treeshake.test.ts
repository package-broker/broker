import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Bundle {
  readonly external?: readonly string[];
  readonly text?: string;
  readonly plugin?: boolean;
}

async function writeBundle(dir: string, name: string, bundle: Bundle): Promise<void> {
  const target = path.join(dir, name);
  await mkdir(target, { recursive: true });
  const input = bundle.plugin === true ? 'packages/plugin-x/src/a.js' : 'packages/core/src/a.js';
  const metafile = {
    inputs: { [input]: {} },
    outputs: {
      'bundle.js': { imports: (bundle.external ?? []).map((p) => ({ path: p, external: true })) },
    },
  };
  await writeFile(path.join(target, 'metafile.json'), JSON.stringify(metafile));
  await writeFile(path.join(target, 'bundle.js'), bundle.text ?? 'export default 1;\n');
}

async function check(cloudflare: Bundle): Promise<{ code: number; output: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pb-treeshake-'));
  dirs.push(dir);
  await writeBundle(dir, 'minimal-cloudflare', cloudflare);
  await writeBundle(dir, 'default-cloudflare', { ...cloudflare, plugin: true });
  await writeBundle(dir, 'minimal-node', {});
  await writeBundle(dir, 'default-node', { plugin: true });
  try {
    await run('node', ['scripts/check-treeshake.mjs'], {
      cwd: root,
      env: { ...process.env, PB_CHECK_TREESHAKE_FIXTURE: dir },
    });
    return { code: 0, output: '' };
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    return { code: failure.code, output: failure.stderr };
  }
}

describe('check-treeshake cloudflare node: allow-list', () => {
  it('admits node:async_hooks as an external import and a static import', async () => {
    const result = await check({
      external: ['cloudflare:workers', 'node:async_hooks'],
      text: 'import{AsyncLocalStorage}from"node:async_hooks";export default 1;\n',
    });
    expect(result).toEqual({ code: 0, output: '' });
  });

  it('admits node:buffer and node:zlib as external imports', async () => {
    const result = await check({
      external: ['node:buffer', 'node:zlib'],
      text: 'import{Buffer}from"node:buffer";import{gunzipSync}from"node:zlib";export default 1;\n',
    });
    expect(result).toEqual({ code: 0, output: '' });
  });

  it.each(['node:fs', 'node:child_process', 'node:async_hooks/extra', 'node:zlib/extra'])(
    'still rejects %s as an external import',
    async (specifier) => {
      const result = await check({ external: [specifier] });
      expect(result.code).toBe(1);
      expect(result.output).toContain('external imports other than');
      expect(result.output).toContain(specifier);
    },
  );

  it.each([
    ['from', 'import{readFile}from"node:fs";'],
    ['bare import', 'import "node:fs";'],
    ['dynamic import', 'await import("node:async_hooks");'],
  ])('still rejects a node: specifier in the bundle text (%s)', async (_label, text) => {
    const result = await check({ text });
    expect(result.code).toBe(1);
    expect(result.output).toContain('node:');
  });
});
