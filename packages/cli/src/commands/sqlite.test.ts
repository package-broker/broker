import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@package-broker/db-sqlite/migrations/source';
import { openBetterSqliteExecutor } from '@package-broker/runtime-node/db/better-sqlite3-executor';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { runBootstrapSqlite, runMigrateSqlite } from './sqlite.js';

let dir: string;
let file: string;
let outDir: string;
const originalCwd = process.cwd();

async function writeBuiltOutput(root: string): Promise<void> {
  const sql = await readFile(
    new URL('../../../db-sqlite/migrations/0001_init.sql', import.meta.url),
    'utf8',
  );
  await mkdir(join(root, 'generated'), { recursive: true });
  await mkdir(join(root, 'migrations', 'core'), { recursive: true });
  await writeFile(join(root, 'migrations', 'core', '0001_init.sql'), sql);
  const epoch = await readFile(
    new URL('../../../db-sqlite/migrations/0004_cache_epoch.sql', import.meta.url),
    'utf8',
  );
  await writeFile(join(root, 'migrations', 'core', '0004_cache_epoch.sql'), epoch);
  await writeFile(
    join(root, 'generated', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      migrations: [
        {
          id: 'core:0001_init',
          name: '0001_init.sql',
          checksum: await sha256Hex(sql),
          phase: 'expand',
        },
        {
          id: 'core:0004_cache_epoch',
          name: '0004_cache_epoch.sql',
          checksum: await sha256Hex(epoch),
          phase: 'expand',
        },
      ],
    }),
  );
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = await mkdtemp(join(tmpdir(), 'pb-sqlite-'));
  file = join(dir, 'db.sqlite');
  outDir = join(dir, 'built');
  await writeBuiltOutput(outDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('applies a migration once and skips it on the second run', async () => {
  expect(await runMigrateSqlite({ file, outDir, dryRun: false })).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(
    JSON.stringify({
      applied: ['core:0001_init', 'core:0004_cache_epoch'],
      skipped: [],
      unknown: [],
      pending: [],
    }),
  );
  expect(await runMigrateSqlite({ file, outDir, dryRun: false })).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(
    JSON.stringify({
      applied: [],
      skipped: ['core:0001_init', 'core:0004_cache_epoch'],
      unknown: [],
      pending: [],
    }),
  );
});

it('rejects tampered SQL before creating a database', async () => {
  await writeFile(join(outDir, 'migrations', 'core', '0001_init.sql'), 'SELECT 1;');
  expect(await runMigrateSqlite({ file, outDir, dryRun: false })).toBe(3);
  expect(existsSync(file)).toBe(false);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringMatching(/^BuiltManifestError: .*checksum/),
  );
  expect(console.log).not.toHaveBeenCalled();
});

it('lists pending migrations without creating tables for a dry run', async () => {
  expect(await run(['migrate', '--sqlite', file, '--out', outDir, '--dry-run'])).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(
    JSON.stringify({
      applied: [],
      skipped: [],
      unknown: [],
      pending: ['core:0001_init', 'core:0004_cache_epoch'],
    }),
  );
  const opened = openBetterSqliteExecutor(file);
  try {
    expect(
      await opened.executor.all({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table'",
        params: [],
      }),
    ).toEqual([]);
  } finally {
    await opened.close();
  }
});

it('bootstraps idempotently and rejects a different organization slug', async () => {
  expect(await runMigrateSqlite({ file, outDir, dryRun: false })).toBe(0);
  expect(await run(['bootstrap', '--sqlite', file, '--slug', 'demo', '--name', 'Demo'])).toBe(0);
  const first = vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;
  expect(JSON.parse(first)).toEqual({
    created: true,
    id: expect.any(String),
    slug: 'demo',
    name: 'Demo',
  });
  expect(await runBootstrapSqlite({ file, slug: 'demo', name: 'Changed' })).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(
    JSON.stringify({ ...JSON.parse(first), created: false }),
  );
  expect(await runBootstrapSqlite({ file, slug: 'other', name: 'Other' })).toBe(5);
  expect(console.error).toHaveBeenLastCalledWith(
    'AlreadyBootstrapped: organization already bootstrapped as demo',
  );
});

it('rejects an invalid slug', async () => {
  expect(await runBootstrapSqlite({ file, slug: 'Invalid Slug', name: 'Demo' })).toBe(2);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringMatching(/^TypeError: invalid organization slug/),
  );
});

it.each([['migrate'], ['bootstrap'], ['bootstrap', '--sqlite', 'db', '--slug', 'demo']])(
  'requires command options: %j',
  async (...args) => {
    expect(await run(args)).toBe(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  },
);

it.each([
  ['migrate', '--sqlite'],
  ['bootstrap', '--sqlite'],
  ['bootstrap', '--sqlite', 'db', '--slug'],
  ['bootstrap', '--sqlite', 'db', '--slug', 'demo', '--name'],
])('requires values for present command options: %j', async (...args) => {
  expect(await run(args)).toBe(2);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  expect(console.log).not.toHaveBeenCalled();
});

it('reports non-checksum manifest errors as exit 1', async () => {
  await writeFile(join(outDir, 'generated', 'manifest.json'), '{}');
  expect(await runMigrateSqlite({ file, outDir, dryRun: false })).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^BuiltManifestError:/));
  expect(existsSync(file)).toBe(false);
});

it('lets concurrent fresh migrations succeed or report a busy lock, never an error', async () => {
  const codes = await Promise.all([
    runMigrateSqlite({ file, outDir, dryRun: false }),
    runMigrateSqlite({ file, outDir, dryRun: false }),
  ]);
  expect(codes).toContain(0);
  for (const code of codes) expect([0, 4]).toContain(code);
});

it('maps a busy database to exit 4 with the DbError label', async () => {
  const holder = openBetterSqliteExecutor(file);
  try {
    await holder.executor.all({ sql: 'BEGIN IMMEDIATE', params: [] });
    expect(await runMigrateSqlite({ file, outDir, dryRun: false })).toBe(4);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^DbError: .*locked/));
  } finally {
    await holder.executor.all({ sql: 'ROLLBACK', params: [] });
    await holder.close();
  }
}, 20_000);

it('falls back to .pb/node when --out is empty', async () => {
  await writeBuiltOutput(join(dir, '.pb', 'node'));
  process.chdir(dir);
  expect(await run(['migrate', '--sqlite', file, '--out', '', '--dry-run'])).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(
    JSON.stringify({
      applied: [],
      skipped: [],
      unknown: [],
      pending: ['core:0001_init', 'core:0004_cache_epoch'],
    }),
  );
});

it.each([['--help'], ['-h']])('prints usage to stdout for %s and exits 0', async (flag) => {
  expect(await run([flag])).toBe(0);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  expect(console.error).not.toHaveBeenCalled();
});

it.each([
  [{ name: 'Weird', message: 'boom' }, 'Weird: boom'],
  [{ code: 7 }, 'Error: [object Object]'],
  ['boom', 'Error: boom'],
] as const)('renders a non-Error throw as %s', async (thrown, expected) => {
  vi.mocked(console.log).mockImplementation(() => {
    throw thrown;
  });
  expect(await runMigrateSqlite({ file, outDir, dryRun: false })).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expected);
});
