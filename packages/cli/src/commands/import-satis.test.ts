import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseManifest, planHash } from '@package-broker/core/import/manifest';
import { run } from '../cli.js';
import { runImportSatisPlan } from './import-satis.js';

const GIT_URL = 'https://git.example.test/acme/lib.git';
const SENTINEL = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
const satisFile = {
  'minimum-stability': 'dev',
  repositories: [{ type: 'git', url: GIT_URL }],
  require: { 'acme/lib': '^1.0' },
};
const mapFile = {
  version: 1,
  repositories: [{ url: GIT_URL, driver: 'git', package: 'acme/lib' }],
};

let dir: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-satis-'));
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation(
    (...args: unknown[]) => void stdout.push(args.join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => void stderr.push(args.join(' ')),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

async function options(extra: Record<string, unknown> = {}) {
  return {
    config: await write('satis.json', satisFile),
    repositoryMap: await write('map.json', mapFile),
    out: join(dir, 'manifest.json'),
    ...extra,
  } as Parameters<typeof runImportSatisPlan>[0];
}

it('writes the canonical manifest and prints a hash equal to planHash of the file', async () => {
  const opts = await options({ project: 'client-a' });
  expect(await runImportSatisPlan(opts)).toBe(0);
  const bytes = await readFile(opts.out, 'utf8');
  const parsed = parseManifest(JSON.parse(bytes));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const hash = await planHash(parsed.data);
  const output = stdout.join('\n');
  expect(output).toContain(`Plan hash: ${hash}`);
  expect(output).toContain('acme/lib');
  expect(output).toContain('client-a');
  expect(output).toContain('version_constraint_ignored');
  expect(output).toContain('paused');
  expect(bytes.endsWith('\n')).toBe(false);
});

it('produces byte-identical output on a second run', async () => {
  const first = await options({ out: join(dir, 'one.json') });
  const second = { ...first, out: join(dir, 'two.json') };
  expect(await runImportSatisPlan(first)).toBe(0);
  expect(await runImportSatisPlan(second)).toBe(0);
  expect(await readFile(first.out, 'utf8')).toBe(await readFile(second.out, 'utf8'));
});

it('refuses to overwrite an existing output and leaves it untouched', async () => {
  const opts = await options();
  await writeFile(opts.out, 'keep');
  expect(await runImportSatisPlan(opts)).toBe(2);
  expect(await readFile(opts.out, 'utf8')).toBe('keep');
  expect(stderr.join('\n')).toContain('output_exists');
  expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

it('prints refused entries with their reasons and writes no manifest', async () => {
  const opts = await options({
    config: await write('bad.json', {
      ...satisFile,
      repositories: [
        { type: 'path', url: '../local' },
        { type: 'git', url: GIT_URL },
      ],
    }),
  });
  expect(await runImportSatisPlan(opts)).toBe(2);
  expect(stdout.join('\n')).toContain('local_repository_unsupported /repositories/0');
  expect(stdout.join('\n')).toContain('Local path repositories cannot be imported');
  expect(stdout.join('\n')).toContain('No manifest was written');
  expect((await readdir(dir)).includes('manifest.json')).toBe(false);
});

it('never prints or writes a credential value', async () => {
  const opts = await options({
    credentials: await write('credentials.json', {
      version: 1,
      repositories: [{ url: GIT_URL, kind: 'bearer', ref: SENTINEL }],
    }),
  });
  expect(await runImportSatisPlan(opts)).toBe(2);
  expect(stdout.join('\n') + stderr.join('\n')).not.toContain(SENTINEL);
  expect((await readdir(dir)).includes('manifest.json')).toBe(false);
});

it('copies only the reference name of an accepted credential', async () => {
  const opts = await options({
    credentials: await write('credentials.json', {
      version: 1,
      repositories: [{ url: GIT_URL, kind: 'bearer', ref: 'env:GIT_TOKEN' }],
    }),
  });
  expect(await runImportSatisPlan(opts)).toBe(0);
  expect(JSON.parse(await readFile(opts.out, 'utf8')).items).toContainEqual(
    expect.objectContaining({ type: 'source', credential_ref: 'env:GIT_TOKEN' }),
  );
});

it('makes no network request', async () => {
  const fetchSpy = vi.fn(() => {
    throw new Error('network access attempted');
  });
  vi.stubGlobal('fetch', fetchSpy);
  expect(await runImportSatisPlan(await options())).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('names the cap for an oversized plan instead of failing with a stack trace', async () => {
  const repositories: unknown[] = [];
  const entries: unknown[] = [];
  for (let index = 0; index < 5001; index += 1) {
    const url = `https://git.example.test/vendor${index}/repo.git`;
    repositories.push({ type: 'git', url });
    entries.push({ url, driver: 'git', package: `vendor${index}/repo` });
  }
  const opts = await options({
    config: await write('big.json', {
      'minimum-stability': 'dev',
      repositories,
      'require-all': true,
    }),
    repositoryMap: await write('bigmap.json', { version: 1, repositories: entries }),
  });
  expect(await runImportSatisPlan(opts)).toBe(2);
  expect(stdout.join('\n')).toContain('MAX_MANIFEST_ITEMS');
  expect(stderr.join('\n')).not.toMatch(/\bat \S+ \(/);
});

it('refuses an input file above the local size budget', async () => {
  const opts = await options({ config: await write('huge.json', ' '.repeat(8 * 1024 * 1024 + 1)) });
  expect(await runImportSatisPlan(opts)).toBe(2);
  expect(stderr.join('\n')).toContain('input_too_large');
});

it('reports an unreadable input by code only', async () => {
  const opts = await options({ config: join(dir, 'missing.json') });
  expect(await runImportSatisPlan(opts)).toBe(2);
  expect(stderr.join('\n')).toContain('input_unreadable');
});

it('refuses override mode', async () => {
  expect(await runImportSatisPlan(await options({ mode: 'override' }))).toBe(2);
  expect(stdout.join('\n')).toContain('override_mode_unsupported');
});

it('dispatches pb import satis plan and rejects incomplete invocations', async () => {
  const out = join(dir, 'cli-manifest.json');
  const config = await write('cli-satis.json', satisFile);
  const map = await write('cli-map.json', mapFile);
  expect(
    await run([
      'import',
      'satis',
      'plan',
      '--config',
      config,
      '--repository-map',
      map,
      '--out',
      out,
    ]),
  ).toBe(0);
  expect(parseManifest(JSON.parse(await readFile(out, 'utf8'))).ok).toBe(true);
  expect(await run(['import', 'satis', 'plan', '--config', config])).toBe(2);
  expect(await run(['import', 'satis', 'plan', '--out', out])).toBe(2);
  expect(
    await run(['import', 'satis', 'plan', '--config', config, '--out', out, '--sqlite', 'x']),
  ).toBe(2);
  expect(
    await run(['import', 'satis', 'plan', '--config', config, '--out', out, '--mode', 'x']),
  ).toBe(2);
  expect(await run(['import', 'satis'])).toBe(2);
});

it('refuses an input that is not a regular file', async () => {
  const opts = await options({ config: dir });
  expect(await runImportSatisPlan(opts)).toBe(2);
  expect(stderr.join('\n')).toContain('input_unreadable');
});
