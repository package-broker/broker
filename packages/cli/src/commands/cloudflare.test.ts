import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScalarStatement, StatementResult } from '@package-broker/core/db/port';
import { sha256Hex } from '@package-broker/db-sqlite/migrations/source';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { runCloudflareBootstrap, runCloudflareMigrate } from './cloudflare.js';

const ACCOUNT_ID = '0f3e9b7c2d14a6e85b1c9d07a3f24e68';
const DATABASE_ID = '5c1a77e2-9f40-4b8d-a3c6-1e2f7d90b4a5';
const API_TOKEN = 'tok_Zq8vLk2NwX4pRt7Y';
const ENV = { CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID };

let dir: string;
let outDir: string;
const originalCwd = process.cwd();

type Responder = (body: unknown, init?: RequestInit) => Response | Promise<Response>;

interface Harness {
  readonly fetch: typeof fetch;
  readonly requests: unknown[];
  readonly query: <R = Record<string, unknown>>(sql: string) => Promise<R[]>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function d1Success(results: readonly StatementResult[]): Response {
  return json(200, {
    result: results.map((result) => ({
      results: result.rows,
      success: true,
      meta: { changes: result.changes, last_row_id: 0, duration: 0.1 },
    })),
    errors: [],
    messages: [],
    success: true,
  });
}

function d1Failure(message: string): Response {
  return json(400, { result: [], success: false, errors: [{ code: 7500, message }], messages: [] });
}

function sqliteText(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

async function createHarness(
  respond?: Responder,
): Promise<{ harness: Harness; close: () => Promise<void> }> {
  const opened = openNodeSqliteExecutor();
  const requests: unknown[] = [];

  const sqlite: Responder = async (request) => {
    const parsed = request as { sql?: string; params?: []; batch?: ScalarStatement[] };
    const statements = parsed.batch ?? [{ sql: parsed.sql ?? '', params: parsed.params ?? [] }];
    try {
      return d1Success(await opened.executor.batch(statements));
    } catch (error) {
      return d1Failure(sqliteText(error));
    }
  };

  const fakeFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const sent: unknown = JSON.parse(String(init?.body));
    requests.push(sent);
    return (respond ?? sqlite)(sent, init);
  };

  return {
    harness: {
      fetch: fakeFetch as typeof fetch,
      requests,
      query: <R = Record<string, unknown>>(sql: string) =>
        opened.executor.all<R>({ sql, params: [] }),
    },
    close: () => opened.close(),
  };
}

async function realInit(): Promise<string> {
  return readFile(new URL('../../../db-sqlite/migrations/0001_init.sql', import.meta.url), 'utf8');
}

async function epochSql(): Promise<string> {
  return readFile(
    new URL('../../../db-sqlite/migrations/0004_cache_epoch.sql', import.meta.url),
    'utf8',
  );
}

async function writeBuiltInit(root: string, sql: string): Promise<void> {
  const epoch = await epochSql();
  await mkdir(join(root, 'generated'), { recursive: true });
  await mkdir(join(root, 'migrations', 'core'), { recursive: true });
  await writeFile(join(root, 'migrations', 'core', '0001_init.sql'), sql);
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

function migrate(send: typeof fetch): Promise<number> {
  return runCloudflareMigrate({
    databaseId: DATABASE_ID,
    outDir,
    dryRun: false,
    env: ENV,
    fetch: send,
  });
}

function bootstrap(slug: string, name: string, send: typeof fetch): Promise<number> {
  return runCloudflareBootstrap({ databaseId: DATABASE_ID, slug, name, env: ENV, fetch: send });
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = await mkdtemp(join(tmpdir(), 'pb-cloudflare-'));
  outDir = join(dir, 'built');
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('1. applies core:0001_init once and skips it on the second run', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    expect(await migrate(harness.fetch)).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({
        applied: ['core:0001_init', 'core:0004_cache_epoch'],
        skipped: [],
        unknown: [],
        pending: [],
      }),
    );
    expect(await migrate(harness.fetch)).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({
        applied: [],
        skipped: ['core:0001_init', 'core:0004_cache_epoch'],
        unknown: [],
        pending: [],
      }),
    );
  } finally {
    await close();
  }
});

it('2. rolls the whole batch back when the second statement fails', async () => {
  await writeBuiltInit(
    outDir,
    'CREATE TABLE widget (id INTEGER PRIMARY KEY);\nINSERT INTO widget_missing (id) VALUES (1);\n',
  );
  const { harness, close } = await createHarness();
  try {
    expect(await migrate(harness.fetch)).not.toBe(0);
    const tables = await harness.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = tables.map((table) => table.name);
    expect(names).not.toContain('widget');
    expect(names).not.toContain('schema_migration');
    expect(console.log).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it('3. bootstraps once, then reports not created, through the HTTP executor', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    expect(await migrate(harness.fetch)).toBe(0);
    expect(await bootstrap('demo', 'Demo', harness.fetch)).toBe(0);
    const first = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    expect(first).toEqual({ created: true, id: expect.any(String), slug: 'demo', name: 'Demo' });
    expect(await bootstrap('demo', 'Changed', harness.fetch)).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith(JSON.stringify({ ...first, created: false }));
  } finally {
    await close();
  }
});

it('4. reports a missing CLOUDFLARE_API_TOKEN and exits 2', async () => {
  await writeBuiltInit(outDir, await realInit());
  const code = await runCloudflareMigrate({
    databaseId: DATABASE_ID,
    outDir,
    dryRun: false,
    env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  });
  expect(code).toBe(2);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('CLOUDFLARE_API_TOKEN'));
});

it('5. redacts a token echoed by a failing transport', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness(() =>
    d1Failure(`near "${API_TOKEN}": syntax error`),
  );
  try {
    expect(await migrate(harness.fetch)).not.toBe(0);
    const stderr = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(stderr).toContain('[redacted]');
    expect(stderr).not.toContain(API_TOKEN);
    for (const body of harness.requests) {
      expect(JSON.stringify(body)).not.toContain(API_TOKEN);
    }
  } finally {
    await close();
  }
});

it('6. requires --database-id for cloudflare migrate', async () => {
  expect(await run(['cloudflare', 'migrate'])).toBe(2);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
});

async function lastStderr(): Promise<string> {
  return vi.mocked(console.error).mock.calls.flat().join('\n');
}

function unreadableBody(): typeof fetch {
  return (async () => {
    const response = new Response('{}', { status: 200 });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('socket closed'));
    return response;
  }) as typeof fetch;
}

it('7. dry run sends one SELECT and reports the migration as pending', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    const code = await runCloudflareMigrate({
      databaseId: DATABASE_ID,
      outDir,
      dryRun: true,
      env: ENV,
      fetch: harness.fetch,
    });
    expect(code).toBe(0);
    expect(harness.requests).toHaveLength(1);
    const [only] = harness.requests as { sql?: string; batch?: unknown }[];
    expect(only?.batch).toBeUndefined();
    expect(only?.sql).toMatch(/^\s*SELECT/i);
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({
        applied: [],
        skipped: [],
        unknown: [],
        pending: ['core:0001_init', 'core:0004_cache_epoch'],
      }),
    );
  } finally {
    await close();
  }
});

it('8. exits 3 when an applied migration changed on disk', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    expect(await migrate(harness.fetch)).toBe(0);
    await writeBuiltInit(outDir, `${await realInit()}\nCREATE TABLE extra (id INTEGER);\n`);
    expect(await migrate(harness.fetch)).toBe(3);
  } finally {
    await close();
  }
});

it('9. exits 4 when the database reports it is busy', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness(() => d1Failure('database is locked'));
  try {
    expect(await migrate(harness.fetch)).toBe(4);
  } finally {
    await close();
  }
});

it('10. exits 5 when bootstrapped with another slug', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    expect(await migrate(harness.fetch)).toBe(0);
    expect(await bootstrap('demo', 'Demo', harness.fetch)).toBe(0);
    expect(await bootstrap('other', 'Other', harness.fetch)).toBe(5);
    expect(await lastStderr()).toContain('AlreadyBootstrapped');
  } finally {
    await close();
  }
});

it('11. reports a missing CLOUDFLARE_ACCOUNT_ID and exits 2', async () => {
  await writeBuiltInit(outDir, await realInit());
  const code = await runCloudflareMigrate({
    databaseId: DATABASE_ID,
    outDir,
    dryRun: false,
    env: { CLOUDFLARE_API_TOKEN: API_TOKEN },
  });
  expect(code).toBe(2);
  expect(await lastStderr()).toContain('CLOUDFLARE_ACCOUNT_ID');
});

it('12. bootstrap without credentials exits 2 and names the variable', async () => {
  const code = await runCloudflareBootstrap({
    databaseId: DATABASE_ID,
    slug: 'demo',
    name: 'Demo',
    env: {},
  });
  expect(code).toBe(2);
  expect(await lastStderr()).toContain('CLOUDFLARE_API_TOKEN');
});

it('13. rejects malformed input before loading the manifest or sending a request', async () => {
  const { harness, close } = await createHarness();
  try {
    const base = { outDir, dryRun: false, fetch: harness.fetch };
    expect(await runCloudflareMigrate({ ...base, databaseId: 'not-a-uuid', env: ENV })).toBe(2);
    expect(await lastStderr()).toContain('--database-id');
    expect(
      await runCloudflareMigrate({
        ...base,
        databaseId: DATABASE_ID,
        env: { ...ENV, CLOUDFLARE_ACCOUNT_ID: 'ABC' },
      }),
    ).toBe(2);
    expect(await lastStderr()).toContain('CLOUDFLARE_ACCOUNT_ID');
    const spaced = 'tok with space';
    expect(
      await runCloudflareMigrate({
        ...base,
        databaseId: DATABASE_ID,
        env: { ...ENV, CLOUDFLARE_API_TOKEN: spaced },
      }),
    ).toBe(2);
    const stderr = await lastStderr();
    expect(stderr).toContain('CLOUDFLARE_API_TOKEN');
    expect(stderr).not.toContain(spaced);
    expect(
      await runCloudflareBootstrap({
        databaseId: 'nope',
        slug: 'demo',
        name: 'Demo',
        env: ENV,
        fetch: harness.fetch,
      }),
    ).toBe(2);
    expect(harness.requests).toHaveLength(0);
  } finally {
    await close();
  }
});

it('14. redacts the token and account id from a non-DbError raised by the manifest step', async () => {
  const leaky = join(dir, `${API_TOKEN}-${ACCOUNT_ID}`);
  const { harness, close } = await createHarness();
  try {
    expect(
      await runCloudflareMigrate({
        databaseId: DATABASE_ID,
        outDir: leaky,
        dryRun: false,
        env: ENV,
        fetch: harness.fetch,
      }),
    ).toBe(1);
    const stderr = await lastStderr();
    expect(stderr).toContain('[redacted]');
    expect(stderr).not.toContain(API_TOKEN);
    expect(stderr).not.toContain(ACCOUNT_ID);
  } finally {
    await close();
  }
});

it('15. exits 6 with a fixed line when the migrate response body is lost', async () => {
  await writeBuiltInit(outDir, await realInit());
  expect(await migrate(unreadableBody())).toBe(6);
  expect(console.error).toHaveBeenCalledWith(
    'outcome unknown: the change may have been applied; re-run pb cloudflare migrate to read the recorded state; if the re-run reports the lock held by the holder printed above, it expires 10 minutes after this run started; wait and run migrate again',
  );
});

it('16. exits 6 with a fixed line when the bootstrap response body is lost', async () => {
  expect(await bootstrap('demo', 'Demo', unreadableBody())).toBe(6);
  expect(console.error).toHaveBeenCalledWith(
    'outcome unknown: the change may have been applied; re-run pb cloudflare bootstrap; it is idempotent',
  );
});

it('17. prints the lock holder once and forwards warnings to stderr', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    expect(await migrate(harness.fetch)).toBe(0);
    const holders = vi
      .mocked(console.error)
      .mock.calls.flat()
      .filter((line) => /^lock holder [0-9A-HJKMNP-TV-Z]{26}$/.test(String(line)));
    expect(holders).toHaveLength(1);

    await harness.query(
      `INSERT INTO schema_migration (id, name, checksum) VALUES ('core:9999_gone', '9999_gone.sql', '${'0'.repeat(64)}')`,
    );
    vi.mocked(console.error).mockClear();
    expect(await migrate(harness.fetch)).toBe(0);
    expect(await lastStderr()).toContain('warn: applied migration core:9999_gone is not shipped');
  } finally {
    await close();
  }
});

it('18. rejects unknown positionals and flags that do not apply', async () => {
  const invalid = [
    ['cloudflare', 'migrate', 'extra', '--database-id', DATABASE_ID],
    ['cloudflare', 'migrate', '--database-id', DATABASE_ID, '--slug', 'demo'],
    [
      'cloudflare',
      'bootstrap',
      '--database-id',
      DATABASE_ID,
      '--slug',
      'a',
      '--name',
      'b',
      '--dry-run',
    ],
    ['cloudflare', 'unknown', '--database-id', DATABASE_ID],
    ['migrate', '--sqlite', 'x.db', '--database-id', DATABASE_ID],
    ['build', 'extra'],
    ['version', '--out', 'x'],
  ];
  for (const argv of invalid) {
    vi.mocked(console.error).mockClear();
    expect(await run(argv)).toBe(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  }
});

it('19. prints no lock holder on a dry run', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    expect(
      await runCloudflareMigrate({
        databaseId: DATABASE_ID,
        outDir,
        dryRun: true,
        env: ENV,
        fetch: harness.fetch,
      }),
    ).toBe(0);
    expect(await lastStderr()).not.toContain('lock holder');
  } finally {
    await close();
  }
});
