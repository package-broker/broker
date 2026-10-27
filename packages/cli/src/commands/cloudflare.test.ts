import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { ScalarStatement, StatementResult } from '@package-broker/core/db/port';
import { sha256Hex } from '@package-broker/db-sqlite/migrations/source';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import {
  InventoryStore,
  InventoryTransaction,
  emptyInventory,
  installIdentity,
} from './cloudflare/inventory.js';
import {
  runCloudflareBootstrap,
  runCloudflareMigrate,
  migrateCloudflare,
  bootstrapCloudflare,
} from './cloudflare.js';

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

async function writeBuiltInit(root: string, sql: string): Promise<void> {
  await mkdir(join(root, 'generated'), { recursive: true });
  await mkdir(join(root, 'migrations', 'core'), { recursive: true });
  await writeFile(join(root, 'migrations', 'core', '0001_init.sql'), sql);
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

it.each([
  [undefined, 300_000],
  ['480000', 480_000],
] as const)(
  'uses the migration timeout %s for requests and recovery reads',
  async (configured, expected) => {
    await writeBuiltInit(outDir, await realInit());
    const { harness, close } = await createHarness();
    const budgets = new WeakMap<AbortSignal, number>();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const signal = new AbortController().signal;
      budgets.set(signal, ms);
      return signal;
    });
    const requests: {
      body: { sql?: string; batch?: ScalarStatement[] };
      timeout: number | undefined;
      recovery: boolean;
    }[] = [];
    let lost = false;
    const send: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { sql?: string; batch?: ScalarStatement[] };
      requests.push({ body, timeout: budgets.get(init!.signal!), recovery: lost });
      const response = await harness.fetch(input, init);
      if (!lost && body.batch?.some((s) => s.sql.includes('CREATE TABLE organization'))) {
        lost = true;
        throw new TypeError('connection closed after commit');
      }
      return response;
    };
    const env = {
      ...ENV,
      ...(configured === undefined ? {} : { PB_D1_MIGRATION_TIMEOUT_MS: configured }),
    };
    try {
      const result = await migrateCloudflare({
        databaseId: DATABASE_ID,
        outDir,
        dryRun: false,
        env,
        fetch: send,
      });

      expect(result.exitCode).toBe(0);
      expect(lost).toBe(true);
      expect(requests.some((r) => r.body.batch !== undefined)).toBe(true);
      expect(requests.some((r) => r.recovery && r.body.sql?.includes('schema_migration'))).toBe(
        true,
      );
      expect(requests.map((r) => r.timeout)).toEqual(requests.map(() => expected));

      requests.length = 0;
      const bootstrapResult = await bootstrapCloudflare({
        databaseId: DATABASE_ID,
        slug: 'demo',
        name: 'Demo',
        env,
        fetch: send,
      });
      expect(bootstrapResult.exitCode).toBe(0);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.map((r) => r.timeout)).toEqual(requests.map(() => 35_000));
    } finally {
      await close();
    }
  },
);

it.each(['0', '-1', '1.5', '600001', 'NaN', 'Infinity', 'bad', ''])(
  'rejects invalid migration timeout %j before sending requests',
  async (timeout) => {
    await writeBuiltInit(outDir, await realInit());
    const send = vi.fn();
    const result = await migrateCloudflare({
      databaseId: DATABASE_ID,
      outDir,
      dryRun: false,
      env: { ...ENV, PB_D1_MIGRATION_TIMEOUT_MS: timeout },
      fetch: send,
    });

    expect(result.exitCode).toBe(2);
    expect(send).not.toHaveBeenCalled();
  },
);

it('1. applies core:0001_init once and skips it on the second run', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    expect(await migrate(harness.fetch)).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({
        applied: ['core:0001_init'],
        skipped: [],
        unknown: [],
        pending: [],
      }),
    );
    expect(await migrate(harness.fetch)).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({
        applied: [],
        skipped: ['core:0001_init'],
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
        pending: ['core:0001_init'],
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
    'outcome unknown: the change may have been applied; re-run pb cloudflare migrate to read the recorded state; if the re-run reports the lock held by the holder printed above, it expires 10 minutes after the last applied migration; wait and run migrate again',
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

async function addManifestRoutes(root: string, routes: unknown): Promise<void> {
  const manifestPath = join(root, 'generated', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  await writeFile(manifestPath, JSON.stringify({ ...manifest, routes }));
}

it('exits 2 with zero requests when a route permission is unknown', async () => {
  await writeBuiltInit(outDir, await realInit());
  await addManifestRoutes(outDir, [
    {
      method: 'GET',
      path: '/widgets',
      plugin: 'widgets',
      permission: 'org:typo',
      boundary: 'organization',
    },
  ]);
  const { harness, close } = await createHarness();
  try {
    expect(await migrate(harness.fetch)).toBe(2);
    expect(harness.requests).toHaveLength(0);
    const printed = vi.mocked(console.error).mock.calls.map((call) => call.join(' '));
    expect(printed.some((line) => line.startsWith('error: ') && line.includes('org:typo'))).toBe(
      true,
    );
  } finally {
    await close();
  }
});

it('warns and migrates when the manifest has no route table', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    expect(await migrate(harness.fetch)).toBe(0);
    const printed = vi.mocked(console.error).mock.calls.map((call) => call.join(' '));
    expect(printed.some((line) => line.startsWith('warning: '))).toBe(true);
  } finally {
    await close();
  }
});

it('returns typed migrate and org results without console output', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    const result = await migrateCloudflare({
      databaseId: DATABASE_ID,
      outDir,
      dryRun: false,
      env: ENV,
      fetch: harness.fetch,
    });
    expect(result.exitCode).toBe(0);
    expect(result.value?.applied).toContain('core:0001_init');
    expect(result.output.migrations_applied).toEqual(result.value?.applied);
    const organization = await bootstrapCloudflare({
      databaseId: DATABASE_ID,
      slug: 'demo',
      name: 'Demo',
      env: ENV,
      fetch: harness.fetch,
    });
    expect(organization.value).toMatchObject({ created: true, slug: 'demo' });
    const mismatch = await bootstrapCloudflare({
      databaseId: DATABASE_ID,
      slug: 'other',
      name: 'Other',
      env: ENV,
      fetch: harness.fetch,
    });
    expect(mismatch.exitCode).toBe(5);
    expect(mismatch.output.error).toMatchObject({
      code: 'organization_slug_mismatch',
      stage: 'org_bootstrap',
    });
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it('keeps provider lock-release warnings out of typed results and diagnostic callbacks', async () => {
  await writeBuiltInit(outDir, await realInit());
  const pendingSql = 'CREATE TABLE pending_lock_probe (id TEXT PRIMARY KEY) STRICT;';
  await writeFile(join(outDir, 'migrations/core/0002_lock_probe.sql'), pendingSql);
  const manifestPath = join(outDir, 'generated/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    migrations: { id: string; name: string; checksum: string; phase: string }[];
  };
  manifest.migrations.push({
    id: 'core:0002_lock_probe',
    name: '0002_lock_probe.sql',
    checksum: await sha256Hex(pendingSql),
    phase: 'expand',
  });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const { harness, close } = await createHarness();
  const sentinels = [
    'person@example.com',
    'https://user:password@example.com/private',
    'PROVIDER_BODY_SENTINEL',
    API_TOKEN,
    ACCOUNT_ID,
  ];
  const send = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { sql?: string };
    if (body.sql?.startsWith('UPDATE migration_lock SET holder = NULL'))
      return d1Failure(sentinels.join(' '));
    return harness.fetch(input, init);
  });
  const diagnostic = vi.fn();
  try {
    const result = await migrateCloudflare({
      databaseId: DATABASE_ID,
      outDir,
      dryRun: false,
      env: ENV,
      fetch: send,
      diagnostic,
    });
    expect(result.exitCode).toBe(0);
    expect(result.value?.applied).toContain('core:0001_init');
    expect(result.diagnostics).toContain(
      'warn: migration warning; inspect migration state and lock expiry before continuing',
    );
    expect(diagnostic.mock.calls.flat()).toEqual(result.diagnostics);
    for (const sentinel of sentinels) {
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(sentinel);
    }
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it('loads cwd-relative migration output with a configuration in another directory', async () => {
  await writeBuiltInit(outDir, await realInit());
  const { harness, close } = await createHarness();
  try {
    const result = await migrateCloudflare({
      databaseId: DATABASE_ID,
      configPath: join(dir, 'fixtures/minimal.config.ts'),
      outDir: relative(process.cwd(), outDir),
      dryRun: true,
      env: ENV,
      fetch: harness.fetch,
    });
    expect(result.exitCode).toBe(0);
    expect(result.value?.pending).toContain('core:0001_init');
    expect(harness.requests.length).toBeGreaterThan(0);
  } finally {
    await close();
  }
});

it('attributes missing migration credentials to the migrate stage', async () => {
  const fetch = vi.fn();
  const result = await migrateCloudflare({
    workerName: 'broker',
    outDir,
    dryRun: false,
    env: {},
    fetch,
  });
  expect(result).toMatchObject({
    exitCode: 2,
    output: { command: 'migrate', error: { code: 'invalid_input', stage: 'migrate' } },
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('refuses a completed D1 receipt with unknown jurisdiction before any migration request', async () => {
  await mkdir(resolve('.pb'), { recursive: true });
  const project = await mkdtemp(resolve('.pb/migrate-jurisdiction-test-'));
  try {
    const output = join(project, '.pb/cloudflare');
    await writeBuiltInit(output, await realInit());
    const identity = installIdentity({ accountId: ACCOUNT_ID, workerName: 'broker' });
    const store = await InventoryStore.create({ project, outDir: output, identity });
    const inventory = emptyInventory(identity, Date.now());
    inventory.resources.d1 = {
      name: 'broker-production-db',
      id: DATABASE_ID,
      jurisdiction: null,
      state: 'complete',
      evidence: { source: 'adopted', operation_id: null, verified_at: new Date().toISOString() },
    };
    await mkdir(store.directory, { recursive: true });
    await writeFile(store.path, JSON.stringify(inventory));
    const before = await readFile(store.path);
    const fetch = vi.fn();
    const onBeforeApply = vi.fn();
    const result = await migrateCloudflare({
      workerName: 'broker',
      configPath: join(project, 'broker.config.ts'),
      outDir: output,
      dryRun: false,
      env: ENV,
      fetch,
      onBeforeApply,
    });
    expect(result).toMatchObject({
      exitCode: 2,
      output: { command: 'migrate', error: { code: 'invalid_inventory', stage: 'migrate' } },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(onBeforeApply).not.toHaveBeenCalled();
    expect(await readFile(store.path)).toEqual(before);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

it('emits the common JSON migrate envelope on success and error without provider data', async () => {
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
        json: true,
      }),
    ).toBe(0);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
      schema_version: 1,
      command: 'migrate',
      status: 'planned',
      database_id: DATABASE_ID,
    });
    vi.mocked(console.log).mockClear();
    expect(
      await runCloudflareMigrate({
        databaseId: DATABASE_ID,
        outDir,
        dryRun: false,
        env: ENV,
        fetch: unreadableBody(),
        json: true,
      }),
    ).toBe(6);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
      status: 'error',
      error: { code: 'outcome_unknown', stage: 'migrate' },
    });
    expect(console.error).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});

it('plans an absent inventory DB without requests, locks or state writes', async () => {
  await mkdir(resolve('.pb'), { recursive: true });
  const project = await mkdtemp(resolve('.pb/migrate-test-'));
  try {
    const output = join(project, '.pb/cloudflare');
    await writeBuiltInit(output, await realInit());
    const fetch = vi.fn();
    const result = await migrateCloudflare({
      workerName: 'broker',
      configPath: join(project, 'broker.config.ts'),
      outDir: output,
      dryRun: true,
      env: ENV,
      fetch,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      output: { status: 'planned', remote_state: 'absent', database_id: null },
    });
    expect(result.value?.pending).toContain('core:0001_init');
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      readFile(join(project, '.pb/state/cloudflare/inventory.broker.production.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

it('returns one JSON usage envelope for invalid new command invocations', async () => {
  for (const args of [
    ['cloudflare', 'provision', '--json'],
    ['cloudflare', 'provision', '--json', '--bad'],
    ['cloudflare', 'migrate', '--json'],
    ['cloudflare', 'migrate', '--json', '--bad'],
    ['cloudflare', 'migrate', '--json', '--database-id', DATABASE_ID, '--jurisdiction', 'invalid'],
  ]) {
    vi.mocked(console.log).mockClear();
    expect(await run(args)).toBe(2);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toMatchObject({
      schema_version: 1,
      status: 'error',
      command: args[1],
      error: { code: 'invalid_input', stage: args[1] },
    });
  }
});

it('keeps route validation sentinels out of typed results and diagnostic callbacks', async () => {
  await writeBuiltInit(outDir, await realInit());
  const sentinels = [
    API_TOKEN,
    ACCOUNT_ID,
    'person@example.com',
    'https://user:password@example.com/private',
  ];
  await addManifestRoutes(outDir, [
    {
      method: 'GET',
      path: `/${sentinels.join('/')}`,
      plugin: sentinels.join(' '),
      permission: 'org:typo',
      boundary: 'organization',
    },
  ]);
  const diagnostic = vi.fn();
  const fetch = vi.fn();
  const result = await migrateCloudflare({
    databaseId: DATABASE_ID,
    outDir,
    dryRun: false,
    env: ENV,
    fetch,
    diagnostic,
  });
  expect(result).toMatchObject({ exitCode: 2, output: { error: { stage: 'migrate' } } });
  expect(result.diagnostics).toContain(
    'error: manifest route validation failed; run pb build again',
  );
  expect(diagnostic.mock.calls.flat()).toEqual(result.diagnostics);
  for (const sentinel of sentinels) {
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(sentinel);
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(console.log).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
});

it.each([
  ['success', 'throws'],
  ['failure', 'throws'],
  ['success', 'rejects'],
  ['failure', 'rejects'],
])(
  'releases the install lock during migration %s when a diagnostic callback %s',
  async (outcome, callback) => {
    await mkdir(resolve('.pb'), { recursive: true });
    const project = await mkdtemp(resolve('.pb/migrate-diagnostic-test-'));
    const { harness, close } = await createHarness();
    try {
      const output = join(project, '.pb/cloudflare');
      await writeBuiltInit(output, await realInit());
      await addManifestRoutes(output, []);
      const identity = installIdentity({ accountId: ACCOUNT_ID, workerName: 'broker' });
      const store = await InventoryStore.create({ project, outDir: output, identity });
      const inventory = emptyInventory(identity, Date.now());
      inventory.resources.d1 = {
        name: 'broker-production-db',
        id: DATABASE_ID,
        jurisdiction: 'eu',
        state: 'complete',
        evidence: { source: 'adopted', operation_id: null, verified_at: new Date().toISOString() },
      };
      await store.write(inventory);
      const rejectedDeliveries: ReturnType<typeof vi.fn>[] = [];
      const diagnostic = vi.fn(() => {
        if (callback === 'rejects') {
          const delivery = Promise.reject(new Error('DIAGNOSTIC_CALLBACK_SENTINEL'));
          // Observe rejection even on regression so the assertion identifies the missing handler.
          void delivery.catch(() => undefined);
          rejectedDeliveries.push(vi.spyOn(delivery, 'catch'));
          return delivery;
        }
        throw new Error('DIAGNOSTIC_CALLBACK_SENTINEL');
      });
      const fetch =
        outcome === 'success' ? harness.fetch : vi.fn(async () => d1Failure('provider failure'));
      const result = await migrateCloudflare({
        workerName: 'broker',
        configPath: join(project, 'broker.config.ts'),
        outDir: output,
        dryRun: false,
        env: ENV,
        fetch,
        diagnostic,
      });
      expect(result.exitCode).toBe(outcome === 'success' ? 0 : 1);
      expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/^lock holder /));
      if (callback === 'rejects') {
        expect(rejectedDeliveries.length).toBeGreaterThan(0);
        for (const handled of rejectedDeliveries) expect(handled).toHaveBeenCalled();
      }
      expect(JSON.stringify(result)).not.toContain('DIAGNOSTIC_CALLBACK_SENTINEL');
      await expect(readFile(store.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const release = await store.lock(Date.now());
      await release();
    } finally {
      await close();
      await rm(project, { recursive: true, force: true });
    }
  },
);

it('preserves applied migration IDs across retries under one lease and resets for a new lease', async () => {
  await mkdir(resolve('.pb'), { recursive: true });
  const project = await mkdtemp(resolve('.pb/migrate-retry-test-'));
  const { harness, close } = await createHarness();
  let transaction: InventoryTransaction | undefined;
  try {
    const output = join(project, '.pb/cloudflare');
    await writeBuiltInit(output, await realInit());
    const identity = installIdentity({ accountId: ACCOUNT_ID, workerName: 'broker' });
    const store = await InventoryStore.create({ project, outDir: output, identity });
    const inventory = emptyInventory(identity, Date.now());
    inventory.resources.d1 = {
      name: 'broker-production-db',
      id: DATABASE_ID,
      jurisdiction: 'eu',
      state: 'complete',
      evidence: { source: 'adopted', operation_id: null, verified_at: new Date().toISOString() },
    };
    await store.write(inventory);
    const options = {
      workerName: 'broker',
      configPath: join(project, 'broker.config.ts'),
      outDir: output,
      dryRun: false,
      env: ENV,
      fetch: harness.fetch,
    };
    transaction = await InventoryTransaction.begin(store, Date.now());
    const first = await migrateCloudflare({ ...options, transaction });
    expect(first.exitCode).toBe(0);
    expect(first.value?.applied).toContain('core:0001_init');
    expect((await store.read())?.migrations.applied_this_transaction).toEqual(first.value?.applied);
    const retry = await migrateCloudflare({ ...options, transaction });
    expect(retry.exitCode).toBe(0);
    expect(retry.value?.applied).toEqual([]);
    expect(retry.value?.skipped).toEqual(first.value?.applied);
    expect((await store.read())?.migrations.applied_this_transaction).toEqual(first.value?.applied);
    await transaction.close();

    transaction = await InventoryTransaction.begin(store, Date.now());
    expect((await migrateCloudflare({ ...options, transaction })).exitCode).toBe(0);
    expect((await store.read())?.migrations.applied_this_transaction).toEqual([]);
    expect((await store.read())?.migrations.ledger.map((entry) => entry.id)).toEqual(
      first.value?.applied,
    );
  } finally {
    await transaction?.close();
    await close();
    await rm(project, { recursive: true, force: true });
  }
});

it('uses inventory DB identity, journals contract boundaries before apply, and rejects unacknowledged contracts', async () => {
  await mkdir(resolve('.pb'), { recursive: true });
  const project = await mkdtemp(resolve('.pb/migrate-state-test-'));
  const { harness, close } = await createHarness();
  try {
    const output = join(project, '.pb/cloudflare');
    await writeBuiltInit(output, await realInit());
    const sql = '-- pb:phase contract\nCREATE TABLE contract_widget (id INTEGER);\n';
    await writeFile(join(output, 'migrations/core/0007_contract.sql'), sql);
    const manifestPath = join(output, 'generated/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.migrations.push({
      id: 'core:0007_contract',
      name: '0007_contract.sql',
      checksum: await sha256Hex(sql),
      phase: 'contract',
    });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const identity = installIdentity({ accountId: ACCOUNT_ID, workerName: 'broker' });
    const store = await InventoryStore.create({ project, outDir: output, identity });
    const inventory = emptyInventory(identity, Date.now());
    inventory.resources.d1 = {
      name: 'broker-production-db',
      id: DATABASE_ID,
      jurisdiction: 'eu',
      state: 'complete',
      evidence: { source: 'adopted', operation_id: null, verified_at: new Date().toISOString() },
    };
    await store.write(inventory);
    const options = {
      workerName: 'broker',
      configPath: join(project, 'broker.config.ts'),
      outDir: output,
      dryRun: false,
      env: ENV,
      fetch: harness.fetch,
    };
    const rejected = await migrateCloudflare(options);
    expect(rejected.exitCode).toBe(11);
    expect(harness.requests).toHaveLength(1);
    expect((harness.requests[0] as { sql: string }).sql).toMatch(/^\s*SELECT/);
    let boundaryObserved = false;
    const applied = await migrateCloudflare({
      ...options,
      allowContract: ['core:0007_contract'],
      onBeforeApply: async (source) => {
        if (source.phase === 'contract') {
          const journal = await store.read();
          expect(journal?.migrations.rollback_compatible).toBe(false);
          expect(journal?.migrations.contract_ids).toContain(source.id);
          boundaryObserved = true;
        }
      },
    });
    expect(applied.exitCode).toBe(0);
    expect(applied.output.database_id).toBe(DATABASE_ID);
    expect(boundaryObserved).toBe(true);
    expect((await store.read())?.migrations.ledger.map((entry) => entry.id)).toContain(
      'core:0007_contract',
    );
    const before = await readFile(store.path, 'utf8');
    expect((await migrateCloudflare({ ...options, dryRun: true })).exitCode).toBe(0);
    expect(await readFile(store.path, 'utf8')).toBe(before);
    const count = harness.requests.length;
    expect(
      (await migrateCloudflare({ ...options, databaseId: '11111111-1111-4111-8111-111111111111' }))
        .exitCode,
    ).toBe(8);
    expect(harness.requests).toHaveLength(count);
  } finally {
    await close();
    await rm(project, { recursive: true, force: true });
  }
});

it.each(
  [
    [
      {
        method: 'GET',
        path: '/widgets',
        plugin: 'widgets',
        permission: 'org:typo',
        boundary: 'organization',
      },
    ],
    'malformed-route-table',
  ].map((routes) => [routes]),
)('rejects invalid routes before planning an absent inventory DB: %j', async (routes) => {
  await mkdir(resolve('.pb'), { recursive: true });
  const project = await mkdtemp(resolve('.pb/migrate-test-'));
  try {
    const output = join(project, '.pb/cloudflare');
    await writeBuiltInit(output, await realInit());
    await addManifestRoutes(output, routes);
    const fetch = vi.fn();
    const result = await migrateCloudflare({
      workerName: 'broker',
      configPath: join(project, 'broker.config.ts'),
      outDir: output,
      dryRun: true,
      env: ENV,
      fetch,
    });
    expect(result).toMatchObject({
      exitCode: 2,
      output: { status: 'error', error: { code: 'invalid_input', stage: 'migrate' } },
    });
    expect(result.value).toBeNull();
    expect(result.output.plan).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      readFile(join(project, '.pb/state/cloudflare/inventory.broker.production.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

it('redacts the complete token before sanitizing overlapping email text in legacy diagnostics', async () => {
  const token = 'prefix:person@example.com:suffix';
  const send = vi.fn();
  const code = await runCloudflareBootstrap({
    databaseId: DATABASE_ID,
    slug: token,
    name: 'Demo',
    env: { ...ENV, CLOUDFLARE_API_TOKEN: token },
    fetch: send,
  });
  expect(code).toBe(2);
  expect(send).not.toHaveBeenCalled();
  const diagnostics = JSON.stringify(vi.mocked(console.error).mock.calls);
  expect(diagnostics).toContain('[redacted]');
  for (const fragment of [token, 'prefix:', ':suffix', 'person@example.com'])
    expect(diagnostics).not.toContain(fragment);
});

it('verification-only migration refuses pending schema and records a matching live ledger without applying', async () => {
  await mkdir(resolve('.pb'), { recursive: true });
  const project = await mkdtemp(resolve('.pb/migrate-verify-test-'));
  const { harness, close } = await createHarness();
  try {
    const output = join(project, '.pb/cloudflare');
    await writeBuiltInit(output, await realInit());
    const identity = installIdentity({ accountId: ACCOUNT_ID, workerName: 'broker' });
    const store = await InventoryStore.create({ project, outDir: output, identity });
    const inventory = emptyInventory(identity, Date.now());
    inventory.resources.d1 = {
      name: 'broker-production-db',
      id: DATABASE_ID,
      jurisdiction: 'eu',
      state: 'complete',
      evidence: { source: 'adopted', operation_id: null, verified_at: new Date().toISOString() },
    };
    await store.write(inventory);
    const onBeforeApply = vi.fn();
    const options = {
      workerName: 'broker',
      configPath: join(project, 'broker.config.ts'),
      outDir: output,
      dryRun: false,
      env: ENV,
      fetch: harness.fetch,
      onBeforeApply,
    };
    expect(await migrateCloudflare({ ...options, verifyOnly: true })).toMatchObject({
      exitCode: 11,
      output: { error: { code: 'configuration_conflict', stage: 'migrate' } },
    });
    expect(onBeforeApply).not.toHaveBeenCalled();
    expect((await store.read())?.migrations.ledger).toEqual([]);
    const applied = await migrateCloudflare(options);
    expect(applied.exitCode).toBe(0);
    const j = (await store.read())!;
    j.migrations.ledger = [];
    await store.write(j);
    onBeforeApply.mockClear();
    const verified = await migrateCloudflare({ ...options, verifyOnly: true });
    expect(verified.exitCode).toBe(0);
    expect(verified.value?.applied).toEqual([]);
    expect(onBeforeApply).not.toHaveBeenCalled();
    expect((await store.read())?.migrations.ledger.map((entry) => entry.id)).toEqual(
      applied.value?.applied,
    );
    expect((await store.read())?.migrations.applied_this_transaction).toEqual([]);
  } finally {
    await close();
    await rm(project, { recursive: true, force: true });
  }
});
