import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import * as authPrimitives from '@package-broker/core/auth/primitives';
import type { ScalarStatement, StatementResult } from '@package-broker/core/db/port';
import { isoTimestamp, systemClock, ulid } from '@package-broker/core/ids';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import * as adminRepository from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { openBetterSqliteExecutor } from '@package-broker/runtime-node/db/better-sqlite3-executor';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import {
  bootstrapAdmin,
  runAdminBootstrap,
  runAdminResetLocal,
  runGenerateMasterKey,
} from './admin.js';

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

it('4a. a first-time bootstrap seeds the admin role without reporting a top-up', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  expect(output().stderr).not.toContain('topped up');
});

it('4b. bootstrap on a set-up organization reports the admin permissions it topped up and exits 0', async () => {
  const file = await sqliteFile();
  const tokenFile = join(dir, 'setup.token');
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  await opened.executor.batch([
    {
      sql: 'UPDATE local_login SET password_hash = ?, setup_hash = NULL, setup_expires_at = NULL',
      params: [PASSWORD_HASH],
    },
    {
      sql: "DELETE FROM role_permission WHERE permission IN ('org:projects:archive', 'project:service-principals:write') AND role_id IN (SELECT id FROM role WHERE key = 'organization_admin')",
      params: [],
    },
  ]);
  await opened.close();
  const loginBefore = await sqliteQuery(file, 'SELECT * FROM local_login');
  vi.mocked(console.log).mockClear();
  vi.mocked(console.error).mockClear();

  expect(
    await runAdminBootstrap({
      email: EMAIL,
      target: sqliteTarget(file),
      tokenFile,
      stdoutIsTTY: true,
    }),
  ).toBe(0);

  expect(output().stderr).toContain('topped up 2 organization_admin permissions');
  expect(output().stderr).not.toContain('nothing changed');
  expect(lastJson()).toEqual({ result: 'already_set_up', toppedUp: 2 });
  expect(output().stdout).not.toContain('setupToken');
  expect(existsSync(tokenFile)).toBe(false);
  expect(await sqliteQuery(file, 'SELECT * FROM local_login')).toEqual(loginBefore);
  const restored = await sqliteQuery<{ n: number }>(
    file,
    "SELECT count(*) AS n FROM role_permission p JOIN role r ON r.id = p.role_id WHERE r.key = 'organization_admin' AND p.permission IN ('org:projects:archive', 'project:service-principals:write')",
  );
  expect(restored[0]?.n).toBe(2);

  vi.mocked(console.error).mockClear();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(6);
  expect(output().stderr).toContain('nothing changed');
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
  ).toBe(7);
  expect(output().stderr).not.toContain(SENTINEL);
  expect(output().stderr).toMatch(/^admin reset-local: outcome unknown; re-running is safe$/m);
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
    expect(output().stderr.split('\n')).toEqual([
      expect.stringContaining('mode is unknown'),
      'admin bootstrap: outcome unknown; re-running is safe',
    ]);
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

it('30. a fetch rejection after the request was handed over exits 7 and removes the token file', async () => {
  const tokenFile = join(dir, 'rejected.token');
  const harness = await createHarness({
    override: (call) => {
      if (call === 2) throw new TypeError(`fetch failed ${SENTINEL}`);
      return undefined;
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
    expect(output().stderr.split('\n')).toEqual([
      expect.stringContaining('mode is unknown'),
      'admin bootstrap: outcome unknown; re-running is safe',
    ]);
    expect(existsSync(tokenFile)).toBe(false);
  } finally {
    await harness.database.close();
  }
});

it('31. a bad API token exits 2 before anything is sent', async () => {
  const harness = await createHarness();
  try {
    const code = await runAdminBootstrap({
      email: EMAIL,
      target: {
        kind: 'cloudflare',
        databaseId: DATABASE_ID,
        env: { ...ENV, CLOUDFLARE_API_TOKEN: 'bad token' },
        fetch: harness.fetch,
      },
      stdoutIsTTY: true,
    });
    expect(code).toBe(2);
    expect(output().stderr).not.toContain('outcome unknown');
  } finally {
    await harness.database.close();
  }
});

it('32. cleanup leaves a token file that was replaced by another inode', async () => {
  const tokenFile = join(dir, 'replaced.token');
  const other = join(dir, 'other.token');
  writeFileSync(other, 'replacement');
  const harness = await createHarness({
    override: (call) => {
      if (call === 2) {
        renameSync(other, tokenFile);
        return d1Failure('boom');
      }
      return undefined;
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
    ).toBe(1);
    expect(await readFile(tokenFile, 'utf8')).toBe('replacement');
  } finally {
    await harness.database.close();
  }
});

it('33. cleanup removes the token file whose device and inode still match', async () => {
  const tokenFile = join(dir, 'matching.token');
  const harness = await createHarness({
    override: (call) => (call === 2 ? d1Failure('boom') : undefined),
  });
  try {
    expect(
      await runAdminBootstrap({
        email: EMAIL,
        target: cloudflareTarget(harness.fetch),
        tokenFile,
        stdoutIsTTY: true,
      }),
    ).toBe(1);
    expect(existsSync(tokenFile)).toBe(false);
  } finally {
    await harness.database.close();
  }
});

it('34. the token file and its parent directory are both fsynced', async () => {
  const probe = await open(join(dir, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const original = prototype.sync;
  const kinds: string[] = [];
  vi.spyOn(prototype, 'sync').mockImplementation(async function (this: {
    stat: () => Promise<{ isDirectory: () => boolean }>;
  }) {
    kinds.push((await this.stat()).isDirectory() ? 'directory' : 'file');
    return original.call(this);
  });
  const tokenFile = join(dir, 'synced.token');
  const harness = await createHarness();
  try {
    expect(
      await runAdminBootstrap({
        email: EMAIL,
        target: cloudflareTarget(harness.fetch),
        tokenFile,
        stdoutIsTTY: true,
      }),
    ).toBe(0);
    expect(kinds).toEqual(['file', 'directory']);
  } finally {
    await harness.database.close();
  }
});

it('35. a signal during the operation is deferred: the file is removed at once and the signal is re-raised only after the operation returns', async () => {
  const tokenFile = join(dir, 'deferred.token');
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const known = new Set(process.listeners('SIGINT'));
  let killedDuring: boolean | null = null;
  let fileDuring: boolean | null = null;
  let handlers = 0;
  const harness = await createHarness({
    override: (call) => {
      if (call === 2) {
        const added = process.listeners('SIGINT').filter((listener) => !known.has(listener));
        handlers = added.length;
        (added[0] as (signal: NodeJS.Signals) => void)('SIGINT');
        killedDuring = kill.mock.calls.length > 0;
        fileDuring = existsSync(tokenFile);
      }
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
    expect(handlers).toBe(1);
    expect(killedDuring).toBe(false);
    expect(fileDuring).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
  } finally {
    await harness.database.close();
  }
});

it('36. a second signal re-raises at once', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const known = new Set(process.listeners('SIGINT'));
  let killsDuring = -1;
  const harness = await createHarness({
    override: (call) => {
      if (call === 2) {
        const [handler] = process.listeners('SIGINT').filter((listener) => !known.has(listener));
        (handler as (signal: NodeJS.Signals) => void)('SIGINT');
        (handler as (signal: NodeJS.Signals) => void)('SIGINT');
        killsDuring = kill.mock.calls.length;
      }
      return undefined;
    },
  });
  try {
    await runAdminBootstrap({
      email: EMAIL,
      target: cloudflareTarget(harness.fetch),
      tokenFile: join(dir, 'twice.token'),
      stdoutIsTTY: true,
    });
    expect(killsDuring).toBe(1);
  } finally {
    await harness.database.close();
  }
});

it('37. a signal that arrived before the operation skips the operation', async () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const known = new Set(process.listeners('SIGTERM'));
  let calls = 0;
  const harness = await createHarness({
    override: (call) => {
      calls = call;
      if (call === 1) {
        const [handler] = process.listeners('SIGTERM').filter((listener) => !known.has(listener));
        (handler as (signal: NodeJS.Signals) => void)('SIGTERM');
      }
      return undefined;
    },
  });
  try {
    const code = await runAdminBootstrap({
      email: EMAIL,
      target: cloudflareTarget(harness.fetch),
      tokenFile: join(dir, 'early-signal.token'),
      stdoutIsTTY: true,
    });
    expect(code).toBe(7);
    expect(calls).toBe(1);
    expect(existsSync(join(dir, 'early-signal.token'))).toBe(false);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  } finally {
    await harness.database.close();
  }
});

it('38. fetch throwing synchronously is not sent: exit 1, not 7', async () => {
  const throwing = (() => {
    throw new TypeError(SENTINEL);
  }) as unknown as typeof fetch;
  const code = await runAdminBootstrap({
    email: EMAIL,
    target: cloudflareTarget(throwing),
    stdoutIsTTY: true,
  });
  expect(code).toBe(1);
  expect(output().stderr).toMatch(/^admin bootstrap: failed \(\w+\)$/);
  expect(output().stderr).not.toContain(SENTINEL);
});

it('39. a non-lost executor error exits 1 with the error name only', async () => {
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
    expect(output().stderr.split('\n')).toEqual([
      expect.stringContaining('mode is unknown'),
      expect.stringMatching(/^admin bootstrap: failed \(\w+\)$/),
    ]);
    expect(output().stderr).not.toContain(SENTINEL);
  } finally {
    await failing.database.close();
  }
});

it('T865. bootstrap names the relative browser setup path and both POST routes without printing a URL or the token', async () => {
  const file = await sqliteFile();
  vi.mocked(console.error).mockClear();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  const printed = lastJson();
  const token = String(printed.setupToken);
  const { stderr } = output();
  expect(stderr).toContain('open /_pb/ui/setup on the broker in a browser');
  expect(stderr).toContain('the token never goes into the address bar');
  expect(stderr).toContain('POST routes named under "next"');
  expect(stderr).not.toMatch(/https?:\/\//);
  expect(stderr).not.toContain(token);
  expect(Object.keys(printed).sort()).toEqual(
    ['expiresAt', 'next', 'result', 'setupToken', 'tokenFile'].sort(),
  );
  expect(printed.next).toEqual([
    'POST /_pb/auth/local/setup/start {"token"}',
    'POST /_pb/auth/local/setup/finish {"token","password","code"}',
  ]);
});

it('exposes typed bootstrap results with dedicated token delivery and no console token', async () => {
  const file = await sqliteFile();
  const delivered: string[] = [];
  const outputs: Readonly<Record<string, unknown>>[] = [];
  const result = await bootstrapAdmin(
    { email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: false },
    {
      diagnostic: () => undefined,
      output: (value) => {
        outputs.push(value);
      },
      deliver: async (token) => {
        delivered.push(token);
      },
    },
  );
  expect(result).toMatchObject({ exitCode: 0, state: 'issued', expiresAt: expect.any(String) });
  expect(delivered).toHaveLength(1);
  expect(outputs[0]?.setupToken).toBeNull();
  expect(
    JSON.stringify(result) + JSON.stringify(outputs) + output().stdout + output().stderr,
  ).not.toContain(delivered[0]);
});

it('reports typed unknown after admin commit followed by dedicated delivery loss', async () => {
  const file = await sqliteFile();
  const result = await bootstrapAdmin(
    { email: EMAIL, target: sqliteTarget(file) },
    {
      diagnostic: () => undefined,
      output: () => undefined,
      deliver: async () => {
        throw new Error(SENTINEL);
      },
    },
  );
  expect(result).toEqual({ exitCode: 7, state: 'unknown', expiresAt: null });
  const users = await sqliteQuery(file, 'SELECT setup_hash FROM local_login');
  expect(users).toHaveLength(1);
  expect(users[0]?.setup_hash).toBeTruthy();
  expect(output().stdout + output().stderr).not.toContain(SENTINEL);
});

it('reports typed organization absence without changing the direct exit 5 contract', async () => {
  const file = await sqliteFile(false);
  const sink = { diagnostic: vi.fn(), output: vi.fn(), deliver: vi.fn() };
  expect(await bootstrapAdmin({ email: EMAIL, target: sqliteTarget(file) }, sink)).toEqual({
    exitCode: 5,
    state: 'error',
    expiresAt: null,
  });
  expect(sink.deliver).not.toHaveBeenCalled();
  expect(await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file) })).toBe(5);
});

it('SSO email bootstrap completes without token delivery, local credentials or identifying output', async () => {
  const generateToken = vi.spyOn(authPrimitives, 'randomToken');
  const hashToken = vi.spyOn(authPrimitives, 'sha256Hex');
  const file = await sqliteFile();
  const sink = { diagnostic: vi.fn(), output: vi.fn(), deliver: vi.fn() };
  const options = { email: EMAIL, signIn: 'sso', target: sqliteTarget(file) };
  expect(await bootstrapAdmin(options, sink)).toEqual({
    exitCode: 0,
    state: 'sso_complete',
    expiresAt: null,
  });
  expect(sink.deliver).not.toHaveBeenCalled();
  expect(sink.output).toHaveBeenLastCalledWith({
    signIn: 'sso',
    result: 'created',
    toppedUp: 0,
    next: [expect.stringContaining('/_pb/ui/login')],
  });
  expect(await sqliteQuery(file, 'SELECT email FROM user_account')).toEqual([{ email: EMAIL }]);
  expect(await sqliteQuery(file, 'SELECT subject_type, subject_value FROM access_grant')).toEqual([
    { subject_type: 'email', subject_value: EMAIL },
  ]);
  for (const table of ['local_login', 'session', 'credential'])
    expect(await sqliteQuery(file, `SELECT * FROM ${table}`)).toEqual([]);
  expect(await runAdminBootstrap(options)).toBe(0);
  expect(lastJson().result).toBe('already_admin');
  expect(generateToken).not.toHaveBeenCalled();
  expect(hashToken).not.toHaveBeenCalled();
  expect(
    JSON.stringify(sink.diagnostic.mock.calls) +
      JSON.stringify(sink.output.mock.calls) +
      output().stdout +
      output().stderr,
  ).not.toContain(EMAIL);
  expect(sink.diagnostic).toHaveBeenCalledWith(
    expect.stringContaining('configuration is not validated here'),
  );
  expect(JSON.stringify(sink.diagnostic.mock.calls) + output().stderr).not.toContain(
    'unused local setup token',
  );
  expect(await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file) })).toBe(0);
  expect(generateToken).toHaveBeenCalledTimes(1);
  expect(hashToken).toHaveBeenCalledTimes(1);
  expect(hashToken).toHaveBeenCalledWith(generateToken.mock.results[0]?.value);
});

it('SSO group CLI bootstrap seeds the provider grant without a user or local enrollment', async () => {
  const file = await sqliteFile();
  expect(
    await run([
      'admin',
      'bootstrap',
      '--sign-in',
      'sso',
      '--group',
      'ops@example.test',
      '--provider',
      'dex',
      '--sqlite',
      file,
    ]),
  ).toBe(0);
  expect(
    await sqliteQuery(
      file,
      'SELECT subject_type, subject_value, subject_provider FROM access_grant',
    ),
  ).toEqual([
    { subject_type: 'group', subject_value: 'ops@example.test', subject_provider: 'dex' },
  ]);
  expect(await sqliteQuery(file, 'SELECT * FROM user_account')).toEqual([]);
  expect(await sqliteQuery(file, 'SELECT * FROM local_login')).toEqual([]);
  expect(output().stdout + output().stderr).not.toContain('ops@example.test');
});

it('rejects invalid sign-in options before opening the target or creating a token file', async () => {
  const tokenFile = join(dir, 'unused.token');
  for (const extra of [
    { signIn: '' },
    { signIn: SENTINEL },
    { signIn: 'SSO' },
    { signIn: 'sso', tokenFile },
    { signIn: 'sso', group: 'ops', provider: 'dex' },
    { group: 'ops', provider: 'dex' },
    { signIn: 'sso', provider: 'dex' },
  ]) {
    expect(
      await runAdminBootstrap({ email: EMAIL, target: sqliteTarget('missing'), ...extra }),
    ).toBe(2);
  }
  for (const extra of [
    { group: 'ops' },
    { group: '', provider: 'dex' },
    { group: ' ops', provider: 'dex' },
    { group: 'ops\n', provider: 'dex' },
    { group: 'ops', provider: 'invalid provider' },
  ])
    expect(
      await runAdminBootstrap({ signIn: 'sso', target: sqliteTarget('missing'), ...extra }),
    ).toBe(2);
  expect(existsSync(tokenFile)).toBe(false);
  expect(output().stdout + output().stderr).not.toContain(SENTINEL);
});

it.each(['enabled', 'disabled', undefined] as const)(
  'warns about local mode %s before mutation through structured diagnostics',
  async (localAuth) => {
    const messages: string[] = [];
    let checked = false;
    const harness = await createHarness({
      override: (call) => {
        if (call === 2) {
          if (localAuth === 'enabled') {
            expect(messages).toEqual([]);
          } else {
            expect(messages[0]).toContain(`mode is ${localAuth ?? 'unknown'}`);
            expect(messages[0]).toContain('does not enable');
            expect(messages[0]).toContain(
              localAuth === 'disabled'
                ? 'setup token cannot be used until local sign-in is enabled'
                : 'unusable while it is disabled',
            );
          }
          checked = true;
        }
        return undefined;
      },
    });
    const sink = {
      diagnostic: (message: string) => {
        messages.push(message);
      },
      output: vi.fn(),
      deliver: vi.fn(),
    };
    try {
      expect(
        (
          await bootstrapAdmin(
            {
              email: EMAIL,
              target: cloudflareTarget(harness.fetch),
              ...(localAuth === undefined ? {} : { localAuth }),
            },
            sink,
          )
        ).exitCode,
      ).toBe(0);
      expect(checked).toBe(true);
      expect(sink.deliver).toHaveBeenCalledTimes(1);
    } finally {
      await harness.database.close();
    }
  },
);

it('SSO rerun warns about unused setup tokens before mutation and preserves them', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  const before = await sqliteQuery(file, 'SELECT * FROM local_login');
  const diagnostics: string[] = [];
  const original = adminRepository.bootstrapSsoAdmin;
  let checked = false;
  vi.spyOn(adminRepository, 'bootstrapSsoAdmin').mockImplementationOnce(async (...args) => {
    expect(diagnostics).toContainEqual(
      expect.stringContaining('existing unused local setup token unchanged'),
    );
    checked = true;
    return original(...args);
  });
  expect(
    (
      await bootstrapAdmin(
        { email: EMAIL, signIn: 'sso', target: sqliteTarget(file) },
        { diagnostic: (text) => diagnostics.push(text), output: vi.fn(), deliver: vi.fn() },
      )
    ).state,
  ).toBe('sso_complete');
  expect(checked).toBe(true);
  expect(await sqliteQuery(file, 'SELECT * FROM local_login')).toEqual(before);
});

it('reset-local warns about revocation before the operation and ignores ambient Worker mode', async () => {
  let checked = false;
  const harness = await createHarness({
    override: (call) => {
      if (call === 2) {
        expect(output().stderr).toContain('mode is unknown');
        expect(output().stderr).toContain('revokes all sessions');
        checked = true;
      }
      return undefined;
    },
  });
  vi.stubEnv('PB_AUTH_LOCAL', 'disabled');
  try {
    expect(
      await runAdminResetLocal({ email: EMAIL, target: cloudflareTarget(harness.fetch) }),
    ).toBe(8);
    expect(checked).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    await harness.database.close();
  }
});

it('SSO failures preserve exit codes and redact request data', async () => {
  const file = await sqliteFile(false);
  expect(await runAdminBootstrap({ email: EMAIL, signIn: 'sso', target: sqliteTarget(file) })).toBe(
    5,
  );
  const harness = await createHarness({
    override: (call) => {
      if (call === 2) return d1Failure(SENTINEL);
      return undefined;
    },
  });
  try {
    expect(
      await runAdminBootstrap({
        email: EMAIL,
        signIn: 'sso',
        target: cloudflareTarget(harness.fetch),
      }),
    ).toBe(1);
    expect(await harness.query('SELECT * FROM access_grant')).toEqual([]);
    expect(console.log).not.toHaveBeenCalled();
    expect(output().stderr).not.toContain(SENTINEL);
    expect(output().stderr).not.toContain(EMAIL);
  } finally {
    await harness.database.close();
  }
});

it('SSO lost mutation response reports unknown without token output', async () => {
  const harness = await createHarness({
    override: (call) => {
      if (call === 3) return Promise.reject(new Error(SENTINEL));
      return undefined;
    },
  });
  const sink = { diagnostic: vi.fn(), output: vi.fn(), deliver: vi.fn() };
  try {
    expect(
      await bootstrapAdmin(
        { email: EMAIL, signIn: 'sso', target: cloudflareTarget(harness.fetch) },
        sink,
      ),
    ).toEqual({ exitCode: 7, state: 'unknown', expiresAt: null });
    expect(sink.output).not.toHaveBeenCalled();
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(JSON.stringify(sink.diagnostic.mock.calls)).not.toContain(SENTINEL);
  } finally {
    await harness.database.close();
  }
});

it('SSO completion delivery failure is safely retryable', async () => {
  const file = await sqliteFile();
  expect(
    await bootstrapAdmin(
      { email: EMAIL, signIn: 'sso', target: sqliteTarget(file) },
      {
        diagnostic: vi.fn(),
        output: () => {
          throw new Error(SENTINEL);
        },
      },
    ),
  ).toEqual({ exitCode: 7, state: 'unknown', expiresAt: null });
  expect(await runAdminBootstrap({ email: EMAIL, signIn: 'sso', target: sqliteTarget(file) })).toBe(
    0,
  );
  expect(lastJson().result).toBe('already_admin');
});

it('SSO bootstrap refuses suspended accounts without changing grants or local credentials', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminBootstrap({ email: EMAIL, target: sqliteTarget(file), stdoutIsTTY: true }),
  ).toBe(0);
  const opened = openBetterSqliteExecutor(file);
  await opened.executor.batch([
    { sql: "UPDATE user_account SET status = 'suspended'", params: [] },
  ]);
  await opened.close();
  const before = await sqliteQuery(file, 'SELECT * FROM local_login');
  vi.mocked(console.log).mockClear();
  expect(await runAdminBootstrap({ email: EMAIL, signIn: 'sso', target: sqliteTarget(file) })).toBe(
    1,
  );
  expect(await sqliteQuery(file, 'SELECT status FROM user_account')).toEqual([
    { status: 'suspended' },
  ]);
  expect(await sqliteQuery(file, 'SELECT * FROM local_login')).toEqual(before);
  expect(console.log).not.toHaveBeenCalled();
  expect(output().stderr).not.toContain(EMAIL);
});
