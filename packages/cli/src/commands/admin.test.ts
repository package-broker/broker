import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import type { ScalarStatement, StatementResult } from '@package-broker/core/db/port';
import { isoTimestamp, systemClock, ulid } from '@package-broker/core/ids';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { openBetterSqliteExecutor } from '@package-broker/runtime-node/db/better-sqlite3-executor';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { runAdminBootstrap, runAdminResetLocal, runGenerateMasterKey } from './admin.js';

const ACCOUNT_ID = '0f3e9b7c2d14a6e85b1c9d07a3f24e68';
const DATABASE_ID = '5c1a77e2-9f40-4b8d-a3c6-1e2f7d90b4a5';
const API_TOKEN = 'tok_Zq8vLk2NwX4pRt7Y';
const ENV = { CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID };
const EMAIL = 'admin@example.test';
const SENTINEL = 'sentinel-7d2f9c41-private-detail';
const PASSWORD_HASH = 'pbkdf2-sha256$i=100000$v=1$c2FsdA$aGFzaA';

let dir: string;

interface Output {
  readonly stdout: string;
  readonly stderr: string;
}

function output(): Output {
  return {
    stdout: vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(' '))
      .join('\n'),
    stderr: vi
      .mocked(console.error)
      .mock.calls.map((call) => call.join(' '))
      .join('\n'),
  };
}

function lastJson(): Record<string, unknown> {
  return JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<
    string,
    unknown
  >;
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

type Responder = (
  call: number,
  init?: RequestInit,
) => Response | Promise<Response | undefined> | undefined;

interface Harness {
  readonly fetch: typeof fetch;
  readonly database: MigratedDatabase;
  readonly query: <R = Record<string, unknown>>(sql: string) => Promise<R[]>;
}

async function createHarness(
  options: { org?: boolean; override?: Responder } = {},
): Promise<Harness> {
  const database = await openMigratedDatabase();
  if (options.org !== false) await seedOrganization(database);
  let call = 0;
  const fakeFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    call += 1;
    const forced = await options.override?.(call, init);
    if (forced !== undefined) return forced;
    const parsed = JSON.parse(String(init?.body)) as {
      sql?: string;
      params?: [];
      batch?: ScalarStatement[];
    };
    const statements = parsed.batch ?? [{ sql: parsed.sql ?? '', params: parsed.params ?? [] }];
    try {
      return d1Success(await database.executor.batch(statements));
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      return d1Failure(cause instanceof Error ? cause.message : String(error));
    }
  };
  return {
    fetch: fakeFetch as typeof fetch,
    database,
    query: (sql) => database.executor.all({ sql, params: [] }),
  };
}

async function seedOrganization(database: MigratedDatabase): Promise<void> {
  await createOrganizationBootstrap(database.executor).bootstrap({
    id: ulid(),
    slug: 'demo',
    name: 'Demo',
    now: isoTimestamp(systemClock.now()),
  });
}

async function sqliteFile(withOrganization = true): Promise<string> {
  const file = join(dir, 'db.sqlite');
  const database = await openMigratedDatabase({ file });
  if (withOrganization) await seedOrganization(database);
  await database.close();
  return file;
}

async function sqliteQuery<R = Record<string, unknown>>(file: string, sql: string): Promise<R[]> {
  const opened = openBetterSqliteExecutor(file);
  try {
    return await opened.executor.all<R>({ sql, params: [] });
  } finally {
    await opened.close();
  }
}

function sqliteTarget(file: string) {
  return { kind: 'sqlite', file } as const;
}

function cloudflareTarget(send: typeof fetch) {
  return { kind: 'cloudflare', databaseId: DATABASE_ID, env: ENV, fetch: send } as const;
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = await mkdtemp(join(tmpdir(), 'pb-admin-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('1. generate-master-key prints a parseable key, differs per run and honours --key-version', async () => {
  expect(await runGenerateMasterKey({})).toBe(0);
  expect(await runGenerateMasterKey({})).toBe(0);
  const keys = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
  for (const key of keys) expect(parseMasterKey(key, 'PB_MASTER_KEY').version).toBe(1);
  expect(await runGenerateMasterKey({ keyVersion: '2' })).toBe(0);
  const versioned = String(vi.mocked(console.log).mock.calls.at(-1)?.[0]);
  expect(versioned.startsWith('pbmk_v2_')).toBe(true);
  expect(parseMasterKey(versioned, 'PB_MASTER_KEY').version).toBe(2);
  const lines = output().stderr.split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain('PB_MASTER_KEY');
  for (const key of keys) expect(output().stderr).not.toContain(key);
});

it('2. generate-master-key refuses an invalid version with exit 2 and prints no key', async () => {
  for (const keyVersion of ['0', '-1', 'abc', '1.5', '', '99999999999']) {
    expect(await runGenerateMasterKey({ keyVersion })).toBe(2);
  }
  expect(console.log).not.toHaveBeenCalled();
});

it('3. bootstrap on SQLite stores the SHA-256 of the printed token and names both next steps', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  const printed = lastJson();
  const token = String(printed.setupToken);
  expect(token).toHaveLength(43);
  expect(printed.result).toBe('created');
  expect(printed.tokenFile).toBeNull();
  expect(Date.parse(String(printed.expiresAt)) - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
  expect(Date.parse(String(printed.expiresAt)) - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
  expect(printed.next).toEqual([
    'POST /_pb/auth/local/setup/start {"token"}',
    'POST /_pb/auth/local/setup/finish {"token","password","code"}',
  ]);
  const rows = await sqliteQuery<{ setup_hash: string; setup_expires_at: string }>(
    file,
    'SELECT setup_hash, setup_expires_at FROM local_login',
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.setup_hash).toBe(await sha256Hex(token));
  expect(rows[0]?.setup_expires_at).toBe(printed.expiresAt);
  const admins = await sqliteQuery(
    file,
    "SELECT 1 FROM access_grant g JOIN role r ON r.id = g.role_id WHERE r.key = 'organization_admin' AND g.subject_value = 'admin@example.test'",
  );
  expect(admins).toHaveLength(1);
  const { stderr } = output();
  expect(stderr).not.toContain(token);
  expect(stderr).not.toContain('example.test');
  expect(stderr).toContain('does not check');
  expect(stderr).toContain('existing administrators');
});

it('4. bootstrap refreshes a pending setup and exits 6 without changes once the password is set', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  expect(lastJson().result).toBe('refreshed');

  const opened = openBetterSqliteExecutor(file);
  await opened.executor.batch([
    {
      sql: 'UPDATE local_login SET password_hash = ?, setup_hash = NULL, setup_expires_at = NULL',
      params: [PASSWORD_HASH],
    },
  ]);
  await opened.close();
  const before = await sqliteQuery(file, 'SELECT * FROM local_login');
  vi.mocked(console.log).mockClear();
  vi.mocked(console.error).mockClear();

  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(6);
  expect(console.log).not.toHaveBeenCalled();
  expect(output().stderr).toContain('already_set_up');
  expect(output().stderr).toContain('pb admin reset-local');
  expect(await sqliteQuery(file, 'SELECT * FROM local_login')).toEqual(before);
});

it('5. --token-file writes a 0600 file with the token and keeps it out of stdout and stderr', async () => {
  const file = await sqliteFile();
  const tokenFile = join(dir, 'setup.token');
  expect(
    await runAdminBootstrap({
      email: EMAIL,
      target: sqliteTarget(file),
      tokenFile,
      stdoutIsTTY: false,
    }),
  ).toBe(0);
  const token = (await readFile(tokenFile, 'utf8')).trim();
  expect(token).toHaveLength(43);
  expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  const printed = lastJson();
  expect(printed.setupToken).toBeNull();
  expect(printed.tokenFile).toBe(tokenFile);
  const { stdout, stderr } = output();
  expect(stdout).not.toContain(token);
  expect(stderr).not.toContain(token);
  expect(stderr).not.toContain('non-terminal');
  const rows = await sqliteQuery<{ setup_hash: string }>(
    file,
    'SELECT setup_hash FROM local_login',
  );
  expect(rows[0]?.setup_hash).toBe(await sha256Hex(token));
});

it('6. --token-file refuses an existing path with exit 2 and leaves file and database untouched', async () => {
  const file = await sqliteFile();
  const tokenFile = join(dir, 'existing.token');
  await writeFile(tokenFile, 'keep me', { mode: 0o644 });
  expect(
    await runAdminBootstrap({
      email: EMAIL,
      target: sqliteTarget(file),
      tokenFile,
      stdoutIsTTY: true,
    }),
  ).toBe(2);
  expect(await readFile(tokenFile, 'utf8')).toBe('keep me');
  expect((await stat(tokenFile)).mode & 0o777).toBe(0o644);
  expect(await sqliteQuery(file, 'SELECT * FROM local_login')).toEqual([]);
  expect(console.log).not.toHaveBeenCalled();
});

it('7. no token file is left behind when the command does not issue a token', async () => {
  const file = await sqliteFile(false);
  const tokenFile = join(dir, 'never.token');
  expect(
    await runAdminBootstrap({
      email: EMAIL,
      target: sqliteTarget(file),
      tokenFile,
      stdoutIsTTY: true,
    }),
  ).not.toBe(0);
  expect(existsSync(tokenFile)).toBe(false);
});

it('8. a non-terminal stdout without --token-file gets one warning on stderr', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: false }),
  ).toBe(0);
  const warnings = output()
    .stderr.split('\n')
    .filter((line) => line.includes('non-terminal'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).not.toContain(String(lastJson().setupToken));
});

it('9. exits 5 without an organization and 2 for an invalid e-mail', async () => {
  const empty = await sqliteFile(false);
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(empty), stdoutIsTTY: true }),
  ).toBe(5);
  expect(
    await runAdminResetLocal({ email: EMAIL, target: sqliteTarget(empty), stdoutIsTTY: true }),
  ).toBe(5);
  expect(output().stderr.split('\n')).toEqual([
    'admin bootstrap: organization not found; run pb bootstrap or pb cloudflare bootstrap first',
    'admin reset-local: organization not found; run pb bootstrap or pb cloudflare bootstrap first',
  ]);
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({
      email: 'not-an-email',
      target: sqliteTarget(file),
      stdoutIsTTY: true,
    }),
  ).toBe(2);
  expect(
    await runAdminResetLocal({ email: '', target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(2);
  expect(console.log).not.toHaveBeenCalled();
  expect(await sqliteQuery(file, 'SELECT * FROM user_account')).toEqual([]);
});

it('10. --cloudflare over the D1 HTTP transport reaches the same state', async () => {
  const harness = await createHarness();
  try {
    expect(
      await runAdminBootstrap({
        email: EMAIL,
        target: cloudflareTarget(harness.fetch),
        stdoutIsTTY: true,
      }),
    ).toBe(0);
    const printed = lastJson();
    const token = String(printed.setupToken);
    expect(token).toHaveLength(43);
    const rows = await harness.query<{ setup_hash: string }>('SELECT setup_hash FROM local_login');
    expect(rows[0]?.setup_hash).toBe(await sha256Hex(token));
    expect(output().stderr).not.toContain(API_TOKEN);
  } finally {
    await harness.database.close();
  }
});

it('11. --cloudflare without an organization exits 5', async () => {
  const harness = await createHarness({ org: false });
  try {
    expect(
      await runAdminBootstrap({
        email: EMAIL,
        target: cloudflareTarget(harness.fetch),
        stdoutIsTTY: true,
      }),
    ).toBe(5);
    expect(output().stderr).toContain('organization not found');
  } finally {
    await harness.database.close();
  }
});

it('12. --cloudflare without credentials exits 2 and never calls the transport', async () => {
  const send = vi.fn();
  expect(
    await runAdminBootstrap({
      email: EMAIL,
      target: {
        kind: 'cloudflare',
        databaseId: DATABASE_ID,
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
        fetch: send as unknown as typeof fetch,
      },
      stdoutIsTTY: true,
    }),
  ).toBe(2);
  expect(send).not.toHaveBeenCalled();
  expect(output().stderr).toContain('CLOUDFLARE_API_TOKEN');
});

it('13. a foreign key failure from the batch reads as organization not found', async () => {
  const harness = await createHarness({
    override: (call) => (call === 2 ? d1Failure('FOREIGN KEY constraint failed') : undefined),
  });
  try {
    expect(
      await runAdminBootstrap({
        email: EMAIL,
        target: cloudflareTarget(harness.fetch),
        stdoutIsTTY: true,
      }),
    ).toBe(5);
    expect(output().stderr).toContain('organization not found');
    expect(console.log).not.toHaveBeenCalled();
    vi.mocked(console.error).mockClear();
    const reset = await createHarness({
      override: (call) => (call === 2 ? d1Failure('FOREIGN KEY constraint failed') : undefined),
    });
    try {
      expect(
        await runAdminResetLocal({
          email: EMAIL,
          target: cloudflareTarget(reset.fetch),
          stdoutIsTTY: true,
        }),
      ).toBe(5);
      expect(output().stderr).toContain('organization not found');
    } finally {
      await reset.database.close();
    }
  } finally {
    await harness.database.close();
  }
});

it('14. error text from the executor and the token never reach stdout or stderr', async () => {
  const failing = await createHarness({
    override: (call) => (call === 2 ? d1Failure(`near "${SENTINEL}": syntax error`) : undefined),
  });
  try {
    expect(
      await runAdminBootstrap({
        email: EMAIL,
        target: cloudflareTarget(failing.fetch),
        stdoutIsTTY: true,
      }),
    ).toBe(1);
    const { stdout, stderr } = output();
    for (const text of [stdout, stderr]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(API_TOKEN);
    }
    expect(stderr).toMatch(/^admin bootstrap: [a-z_]+ \(\w+\)$/m);
  } finally {
    await failing.database.close();
  }

  vi.mocked(console.error).mockClear();
  const throwing = (async () => {
    throw new Error(SENTINEL);
  }) as unknown as typeof fetch;
  expect(
    await runAdminResetLocal({
      email: EMAIL,
      target: cloudflareTarget(throwing),
      stdoutIsTTY: true,
    }),
  ).toBe(1);
  expect(output().stderr).not.toContain(SENTINEL);
  expect(output().stderr).toMatch(/^admin reset-local: [a-z_]+ \(\w+\)$/m);
  expect(console.log).not.toHaveBeenCalled();
});

it('15. reset-local issues a new token for a configured admin and clears the password', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  await opened.executor.batch([
    {
      sql: 'UPDATE local_login SET password_hash = ?, setup_hash = NULL, setup_expires_at = NULL',
      params: [PASSWORD_HASH],
    },
  ]);
  await opened.close();
  vi.mocked(console.log).mockClear();

  expect(
    await runAdminResetLocal({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  const printed = lastJson();
  expect(printed.result).toBe('reset');
  const token = String(printed.setupToken);
  const rows = await sqliteQuery<{ password_hash: string | null; setup_hash: string }>(
    file,
    'SELECT password_hash, setup_hash FROM local_login',
  );
  expect(rows[0]?.password_hash).toBeNull();
  expect(rows[0]?.setup_hash).toBe(await sha256Hex(token));
});

it('16. reset-local exits 6 for an unknown user and writes no token file', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  vi.mocked(console.log).mockClear();
  vi.mocked(console.error).mockClear();
  const tokenFile = join(dir, 'reset.token');
  expect(
    await runAdminResetLocal({
      email: 'nobody@example.test',
      target: sqliteTarget(file),
      tokenFile,
      stdoutIsTTY: true,
    }),
  ).toBe(6);
  expect(output().stderr).toContain('not_found');
  expect(console.log).not.toHaveBeenCalled();
  expect(existsSync(tokenFile)).toBe(false);
});

it('17. reset-local reports a missing admin role with its own message and exit code', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminResetLocal({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(8);
  expect(output().stderr).toContain('admin_role_missing');
  expect(output().stderr).toContain('pb admin bootstrap');
  expect(console.log).not.toHaveBeenCalled();
});

it('18. the CLI routes the new commands and rejects ambiguous targets', async () => {
  const file = await sqliteFile();
  expect(await run(['secrets', 'generate-master-key', '--key-version', '3'])).toBe(0);
  expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]).startsWith('pbmk_v3_')).toBe(true);
  expect(await run(['admin', 'bootstrap', '--email', EMAIL, '--sqlite', file])).toBe(0);
  expect(lastJson().result).toBe('created');
  expect(await run(['admin', 'reset-local', '--email', EMAIL, '--sqlite', file])).toBe(0);
  expect(await run(['admin', 'bootstrap', '--email', EMAIL])).toBe(2);
  expect(await run(['admin', 'bootstrap', '--sqlite', file])).toBe(2);
  expect(
    await run(['admin', 'bootstrap', '--email', EMAIL, '--sqlite', file, '--cloudflare']),
  ).toBe(2);
  expect(await run(['admin', 'bootstrap', '--email', EMAIL, '--cloudflare'])).toBe(2);
  expect(await run(['admin', 'reset-local', '--email', EMAIL, '--sqlite', file, '--bogus'])).toBe(
    2,
  );
  expect(await run(['secrets', 'generate-master-key', '--email', EMAIL])).toBe(2);
});

it('19. a database file that does not exist is a usage error and is not created', async () => {
  const missing = join(dir, 'missing.sqlite');
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(missing), stdoutIsTTY: true }),
  ).toBe(2);
  expect(existsSync(missing)).toBe(false);
});

it('20. a garbage SQLite file and a directory fail with a fixed message and exit 1', async () => {
  const garbage = join(dir, 'garbage.sqlite');
  await writeFile(garbage, `${SENTINEL} `.repeat(200));
  const directory = join(dir, 'a-directory');
  await mkdir(directory);
  for (const target of [garbage, directory]) {
    vi.mocked(console.error).mockClear();
    expect(
      await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(target), stdoutIsTTY: true }),
    ).toBe(1);
    expect(output().stderr).toMatch(/^admin bootstrap: failed \(\w+\)$/);
    expect(output().stderr).not.toContain(SENTINEL);
    expect(output().stderr).not.toContain(dir);
  }
  expect(console.log).not.toHaveBeenCalled();
});

it('21. a lost D1 response exits 7, prints no token and removes the token file', async () => {
  const tokenFile = join(dir, 'lost.token');
  const harness = await createHarness({
    override: (call) => {
      if (call !== 2) return undefined;
      const response = new Response('{}', { status: 200 });
      vi.spyOn(response, 'text').mockRejectedValue(new Error(SENTINEL));
      return response;
    },
  });
  try {
    expect(
      await runAdminBootstrap({
        email: EMAIL,
        target: cloudflareTarget(harness.fetch),
        tokenFile,
        stdoutIsTTY: true,
      }),
    ).toBe(7);
    expect(output().stderr).toBe('admin bootstrap: outcome unknown; re-running is safe');
    expect(console.log).not.toHaveBeenCalled();
    expect(existsSync(tokenFile)).toBe(false);
  } finally {
    await harness.database.close();
  }
});

it('22. the token file holds the token before the batch runs and is removed when the batch fails', async () => {
  const tokenFile = join(dir, 'early.token');
  let seen = '';
  let seenMode = 0;
  const ok = await createHarness({
    override: async (call) => {
      if (call === 2) {
        seen = readFileSync(tokenFile, 'utf8');
        seenMode = (await stat(tokenFile)).mode & 0o777;
      }
      return undefined;
    },
  });
  try {
    expect(
      await runAdminBootstrap({
        email: EMAIL,
        target: cloudflareTarget(ok.fetch),
        tokenFile,
        stdoutIsTTY: true,
      }),
    ).toBe(0);
    expect(seen).toHaveLength(44);
    expect(seenMode).toBe(0o600);
    expect(await readFile(tokenFile, 'utf8')).toBe(seen);
  } finally {
    await ok.database.close();
  }

  const failedFile = join(dir, 'failed.token');
  const failing = await createHarness({
    override: (call) => (call === 2 ? d1Failure('boom') : undefined),
  });
  try {
    expect(
      await runAdminBootstrap({
        email: EMAIL,
        target: cloudflareTarget(failing.fetch),
        tokenFile: failedFile,
        stdoutIsTTY: true,
      }),
    ).toBe(1);
    expect(existsSync(failedFile)).toBe(false);
  } finally {
    await failing.database.close();
  }
});

it('23. SIGTERM while the command runs removes the token file, re-raises the signal and exits 7 without output', async () => {
  const tokenFile = join(dir, 'signal.token');
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const termBefore = process.listenerCount('SIGTERM');
  const intBefore = process.listenerCount('SIGINT');
  const harness = await createHarness({
    override: (call) => {
      if (call === 2) process.emit('SIGTERM', 'SIGTERM');
      return undefined;
    },
  });
  try {
    const code = await runAdminBootstrap({
      email: EMAIL,
      target: cloudflareTarget(harness.fetch),
      tokenFile,
      stdoutIsTTY: true,
    });
    expect(code).toBe(7);
    expect(console.log).not.toHaveBeenCalled();
    expect(output().stderr).toContain('outcome unknown; re-running is safe');
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(existsSync(tokenFile)).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(termBefore);
    expect(process.listenerCount('SIGINT')).toBe(intBefore);
  } finally {
    await harness.database.close();
  }
});

it('24. the e-mail is trimmed and lower-cased before it is stored', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({
      email: '  Admin@Example.TEST ',
      target: sqliteTarget(file),
      stdoutIsTTY: true,
    }),
  ).toBe(0);
  const users = await sqliteQuery<{ email: string }>(file, 'SELECT email FROM user_account');
  expect(users).toEqual([{ email: EMAIL }]);
  const grants = await sqliteQuery<{ subject_value: string }>(
    file,
    'SELECT subject_value FROM access_grant',
  );
  expect(grants).toEqual([{ subject_value: EMAIL }]);
});

it('25. a foreign key failure on the SQLite target reads as organization not found', async () => {
  const file = await sqliteFile();
  const opened = openBetterSqliteExecutor(file);
  await opened.executor.batch([
    {
      sql: "CREATE TRIGGER fail_role BEFORE INSERT ON role BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END",
      params: [],
    },
  ]);
  await opened.close();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(5);
  expect(output().stderr).toContain('organization not found');
  expect(console.log).not.toHaveBeenCalled();
});

it('26. --key-version 1000000 is out of range and exits 2', async () => {
  expect(await runGenerateMasterKey({ keyVersion: '1000000' })).toBe(2);
  expect(await run(['secrets', 'generate-master-key', '--key-version', '1000000'])).toBe(2);
  expect(console.log).not.toHaveBeenCalled();
});

it('27. run() with --cloudflare --database-id reads the credentials from the environment', async () => {
  const harness = await createHarness();
  vi.stubEnv('CLOUDFLARE_API_TOKEN', API_TOKEN);
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', ACCOUNT_ID);
  vi.stubGlobal('fetch', harness.fetch);
  try {
    expect(
      await run([
        'admin',
        'bootstrap',
        '--email',
        EMAIL,
        '--cloudflare',
        '--database-id',
        DATABASE_ID,
      ]),
    ).toBe(0);
    expect(lastJson().result).toBe('created');
    expect(await harness.query('SELECT 1 FROM local_login')).toHaveLength(1);
    vi.unstubAllEnvs();
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', ACCOUNT_ID);
    expect(
      await run([
        'admin',
        'reset-local',
        '--email',
        EMAIL,
        '--cloudflare',
        '--database-id',
        DATABASE_ID,
      ]),
    ).toBe(2);
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await harness.database.close();
  }
});

it('28. --token-file in a missing directory exits 1 before any database write', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({
      email: EMAIL,
      target: sqliteTarget(file),
      tokenFile: join(dir, 'missing-dir', 'setup.token'),
      stdoutIsTTY: true,
    }),
  ).toBe(1);
  expect(output().stderr).toMatch(/^admin bootstrap: token_file_failed \(\w+\)$/);
  expect(await sqliteQuery(file, 'SELECT * FROM local_login')).toEqual([]);
  expect(await sqliteQuery(file, 'SELECT * FROM user_account')).toEqual([]);
});

it('29. already_set_up leaves user_account and access_grant unchanged', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  await opened.executor.batch([
    {
      sql: 'UPDATE local_login SET password_hash = ?, setup_hash = NULL, setup_expires_at = NULL',
      params: [PASSWORD_HASH],
    },
  ]);
  await opened.close();
  const snapshot = async () => ({
    users: await sqliteQuery(file, 'SELECT * FROM user_account ORDER BY id'),
    grants: await sqliteQuery(file, 'SELECT * FROM access_grant ORDER BY id'),
    roles: await sqliteQuery(file, 'SELECT * FROM role ORDER BY id'),
  });
  const before = await snapshot();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(6);
  expect(await snapshot()).toEqual(before);
});
