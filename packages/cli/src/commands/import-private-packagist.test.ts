import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import {
  runImportPrivatePackagistFetch,
  type ImportPrivatePackagistOptions,
} from './import-private-packagist.js';

let dir: string;
let options: ImportPrivatePackagistOptions;
const key = 'SENTINEL_KEY';
const secret = 'SENTINEL_SECRET';
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-pp-command-'));
  await writeFile(join(dir, 'key'), key, { mode: 0o600 });
  await writeFile(join(dir, 'secret'), secret, { mode: 0o600 });
  options = {
    org: 'acme',
    snapshot: join(dir, 'snapshot.json'),
    apiKeyFile: join(dir, 'key'),
    apiSecretFile: join(dir, 'secret'),
    env: {},
    fetch: vi.fn(async () => Response.json([])),
  };
  stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  expect(JSON.stringify(stdout.mock.calls)).not.toContain(key);
  expect(JSON.stringify(stdout.mock.calls)).not.toContain(secret);
  expect(JSON.stringify(stderr.mock.calls)).not.toContain(key);
  expect(JSON.stringify(stderr.mock.calls)).not.toContain(secret);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it('writes a confidential snapshot with only a count summary and no credentials', async () => {
  expect(await runImportPrivatePackagistFetch(options)).toBe(0);
  const text = await readFile(options.snapshot, 'utf8');
  expect(text).not.toContain(key);
  expect(text).not.toContain(secret);
  expect(stdout).toHaveBeenCalledWith('org_unverified');
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Confidential'));
  expect(await runImportPrivatePackagistFetch(options)).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('output_exists'));
  expect(await readFile(options.snapshot, 'utf8')).toBe(text);
});

it.each(['key', 'secret'])('refuses mode 0644 for the %s file before fetch', async (name) => {
  await chmod(join(dir, name), 0o644);
  expect(await runImportPrivatePackagistFetch(options)).toBe(2);
  expect(options.fetch).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('credential_file'));
  expect(await readdir(dir)).not.toContain('snapshot.json');
});

it('accepts stricter 0400 files and environment file paths', async () => {
  await chmod(join(dir, 'key'), 0o400);
  await chmod(join(dir, 'secret'), 0o400);
  const { apiKeyFile, apiSecretFile, ...rest } = options;
  expect(
    await runImportPrivatePackagistFetch({
      ...rest,
      env: { PP_API_KEY_FILE: apiKeyFile, PP_API_SECRET_FILE: apiSecretFile },
    }),
  ).toBe(0);
});

it.each(['key', 'secret'])(
  'refuses ambiguous flag and environment for %s even if paths match',
  async (name) => {
    expect(
      await runImportPrivatePackagistFetch({
        ...options,
        env: { [name === 'key' ? 'PP_API_KEY_FILE' : 'PP_API_SECRET_FILE']: join(dir, name) },
      }),
    ).toBe(2);
    expect(options.fetch).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('ambiguous_credentials'));
  },
);

it('refuses symlink, missing, oversized and non-regular credential files', async () => {
  await symlink(join(dir, 'secret'), join(dir, 'link'));
  await writeFile(join(dir, 'large'), 'x'.repeat(4097), { mode: 0o600 });
  for (const path of ['link', 'missing', 'large', '.'])
    expect(
      await runImportPrivatePackagistFetch({ ...options, apiSecretFile: join(dir, path) }),
    ).toBe(2);
  expect(options.fetch).not.toHaveBeenCalled();
});

it('keeps credentials out of network errors and diagnostic response bodies', async () => {
  for (const fetch of [
    async () => {
      throw new Error(`${key}:${secret}`);
    },
    async () => new Response(`${key} ${secret}`, { status: 401 }),
  ]) {
    expect(await runImportPrivatePackagistFetch({ ...options, fetch })).toBe(1);
  }
  expect(await readdir(dir)).not.toContain('snapshot.json');
});

it('does not write an unverified snapshot when --require-org-match is set', async () => {
  expect(await runImportPrivatePackagistFetch({ ...options, requireOrgMatch: true })).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('org_unverified'));
  expect(await readdir(dir)).not.toContain('snapshot.json');
});

it('dispatches fetch with flag and environment paths and rejects incomplete or unrelated flags', async () => {
  vi.stubGlobal('fetch', options.fetch);
  vi.stubEnv('PP_API_KEY_FILE', join(dir, 'key'));
  vi.stubEnv('PP_API_SECRET_FILE', join(dir, 'secret'));
  expect(
    await run([
      'import',
      'private-packagist',
      'fetch',
      '--org',
      'acme',
      '--snapshot',
      options.snapshot,
      '--versions',
    ]),
  ).toBe(0);
  for (const args of [
    ['import', 'private-packagist'],
    ['import', 'private-packagist', 'plan'],
    ['import', 'private-packagist', 'fetch', '--org', 'acme'],
    ['import', 'private-packagist', 'fetch', '--snapshot', options.snapshot],
    [
      'import',
      'private-packagist',
      'fetch',
      '--org',
      'acme',
      '--snapshot',
      options.snapshot,
      '--sqlite',
      'x',
    ],
    [
      'import',
      'private-packagist',
      'fetch',
      '--org',
      'acme',
      '--snapshot',
      options.snapshot,
      '--api-key',
      key,
    ],
  ])
    expect(await run(args)).toBe(2);
});

it('dispatches credential file flags and --require-org-match', async () => {
  vi.stubGlobal('fetch', options.fetch);
  vi.stubEnv('PP_API_KEY_FILE', undefined);
  vi.stubEnv('PP_API_SECRET_FILE', undefined);
  const args = [
    'import',
    'private-packagist',
    'fetch',
    '--org',
    'acme',
    '--snapshot',
    options.snapshot,
    '--api-key-file',
    join(dir, 'key'),
    '--api-secret-file',
    join(dir, 'secret'),
  ];
  expect(await run([...args, '--require-org-match'])).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('org_unverified'));
  expect(await run(args)).toBe(0);
});
