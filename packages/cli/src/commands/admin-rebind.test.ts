import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScalarStatement, StatementResult } from '@package-broker/core/db/port';
import { orgContext } from '@package-broker/core/db/port';
import type { LoginPlan } from '@package-broker/core/db/users';
import { isoTimestamp, systemClock, ulid } from '@package-broker/core/ids';
import { createLoginWriter } from '@package-broker/db-sqlite/repositories/login';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { openBetterSqliteExecutor } from '@package-broker/runtime-node/db/better-sqlite3-executor';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { runAdminRebindProvider, type AdminTarget } from './admin.js';

const ACCOUNT_ID = '0f3e9b7c2d14a6e85b1c9d07a3f24e68';
const DATABASE_ID = '5c1a77e2-9f40-4b8d-a3c6-1e2f7d90b4a5';
const API_TOKEN = 'tok_Zq8vLk2NwX4pRt7Y';
const ENV = { CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID };
const SENTINEL = 'sentinel-7d2f9c41-private-detail';
const PROVIDER = 'dex';
const OTHER_PROVIDER = 'cf';
const ANCHOR = 'oidc:https://dex.example.test';
const NEW_ANCHOR = 'oidc:https://dex-new.example.test';
const OTHER_ANCHOR = `access:team.example.test/${'a'.repeat(64)}`;
const NOW = '2026-10-15T12:00:00.000Z';
const EXPIRES = '2026-10-16T00:00:00.000Z';
const MISMATCH =
  'admin rebind-provider: anchor_mismatch; no binding with that provider and expected anchor; nothing changed';
const UNKNOWN =
  'admin rebind-provider: outcome unknown; the swap may have applied; a re-run that reports anchor_mismatch means it did or the anchor is wrong';

let dir: string;

function hash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

function output(): { stdout: string; stderr: string } {
  const text = (spy: typeof console.log) =>
    vi
      .mocked(spy)
      .mock.calls.map((call) => call.join(' '))
      .join('\n');
  return { stdout: text(console.log), stderr: text(console.error) };
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

type Responder = (call: number) => Response | undefined;

interface Harness {
  readonly fetch: typeof fetch;
  readonly database: MigratedDatabase;
  readonly query: <R = Record<string, unknown>>(sql: string) => Promise<R[]>;
}

async function seedLogins(database: MigratedDatabase | null, file: string | null): Promise<void> {
  const opened = file === null ? null : openBetterSqliteExecutor(file);
  const executor = database?.executor ?? opened?.executor;
  if (executor === undefined) throw new Error('no executor');
  try {
    const org = await createOrganizationBootstrap(executor).findSingleton();
    if (org === null) throw new Error('organization missing');
    const ctx = orgContext(org.id);
    const writer = createLoginWriter(executor);
    const logins = [
      ['01J0USERX0000000000000000X', 'x@example.test', 'sub-x', PROVIDER, ANCHOR],
      ['01J0USERY0000000000000000Y', 'y@example.test', 'sub-y', PROVIDER, ANCHOR],
      ['01J0USERZ0000000000000000Z', 'z@example.test', 'sub-z', OTHER_PROVIDER, OTHER_ANCHOR],
    ] as const;
    for (const [index, [userId, email, subject, provider, anchor]] of logins.entries()) {
      const identityId = `01J0IDENT${String(index)}00000000000000X`;
      const plan: LoginPlan = {
        audit: {
          id: ulid(),
          occurredAt: NOW,
          action: 'session.login',
          actor: { type: 'user', id: userId },
          target: { type: 'session', id: `01J0SESS${String(index)}000000000000000XX` },
          tokenSelector: null,
          sourceIp: null,
          projectId: null,
          payloadJson: '{"op_id":"fixture","request_id":"fixture"}',
        },
        userId,
        createUser: true,
        autoJoin: true,
        email,
        displayName: null,
        identityId,
        provider,
        trustAnchor: anchor,
        subject,
        emailVerified: true,
        groups: ['readers'],
        evidenceTime: '2026-10-15T11:59:00.000Z',
        session: {
          id: `01J0SESS${String(index)}000000000000000XX`,
          userId,
          identityId,
          secretHash: hash(`secret-${String(index)}`),
          csrfHash: hash(`csrf-${String(index)}`),
          expiresAt: EXPIRES,
          ip: null,
          userAgent: null,
          now: NOW,
        },
        previousSecretHash: null,
        now: NOW,
      };
      expect(await writer.commit(ctx, plan)).toBe('created');
    }
  } finally {
    await opened?.close();
  }
}

async function createHarness(options: { override?: Responder } = {}): Promise<Harness> {
  const database = await openMigratedDatabase();
  await seedOrganization(database);
  await seedLogins(database, null);
  let call = 0;
  const fakeFetch = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    call += 1;
    const forced = options.override?.(call);
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

async function sqliteFile(options: { organization?: boolean; logins?: boolean } = {}) {
  const file = join(dir, 'db.sqlite');
  const database = await openMigratedDatabase({ file });
  if (options.organization !== false) await seedOrganization(database);
  await database.close();
  if (options.organization !== false && options.logins !== false) await seedLogins(null, file);
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

const STATE_SQL = [
  'SELECT * FROM identity ORDER BY id',
  'SELECT * FROM session ORDER BY id',
  'SELECT * FROM user_group ORDER BY user_id, provider, group_name',
  'SELECT * FROM identity_provider_binding ORDER BY provider',
  'SELECT * FROM user_account ORDER BY id',
];

async function sqliteState(file: string): Promise<unknown[]> {
  const state: unknown[] = [];
  for (const sql of STATE_SQL) state.push(await sqliteQuery(file, sql));
  return state;
}

function sqliteTarget(file: string) {
  return { kind: 'sqlite', file } as const;
}

function cloudflareTarget(send: typeof fetch) {
  return { kind: 'cloudflare', databaseId: DATABASE_ID, env: ENV, fetch: send } as const;
}

function options(
  target: AdminTarget,
  overrides: Partial<Parameters<typeof runAdminRebindProvider>[0]> = {},
) {
  return {
    provider: PROVIDER,
    confirm: PROVIDER,
    expectedAnchor: ANCHOR,
    newAnchor: NEW_ANCHOR,
    target,
    ...overrides,
  };
}

function cliArgs(file: string, extra: string[] = []): string[] {
  return [
    'admin',
    'rebind-provider',
    '--provider',
    PROVIDER,
    '--confirm',
    PROVIDER,
    '--expected-anchor',
    ANCHOR,
    '--new-anchor',
    NEW_ANCHOR,
    '--sqlite',
    file,
    ...extra,
  ];
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = await mkdtemp(join(tmpdir(), 'pb-rebind-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

it('1. SQLite: rebinding after a seeded login exits 0, prints the counts and swaps the anchor', async () => {
  const file = await sqliteFile();
  expect(await runAdminRebindProvider(options(sqliteTarget(file)))).toBe(0);
  expect(lastJson()).toEqual({ provider: PROVIDER, identities: 2, sessions: 2 });
  expect(output().stderr).toBe('');
  expect(await sqliteQuery(file, 'SELECT provider FROM identity ORDER BY provider')).toEqual([
    { provider: OTHER_PROVIDER },
  ]);
  expect(await sqliteQuery(file, 'SELECT identity_id FROM session')).toHaveLength(1);
  expect(await sqliteQuery(file, 'SELECT provider FROM user_group')).toEqual([
    { provider: OTHER_PROVIDER },
  ]);
  expect(
    await sqliteQuery(
      file,
      'SELECT provider, anchor FROM identity_provider_binding ORDER BY provider',
    ),
  ).toEqual([
    { provider: OTHER_PROVIDER, anchor: OTHER_ANCHOR },
    { provider: PROVIDER, anchor: NEW_ANCHOR },
  ]);
  expect(await sqliteQuery(file, 'SELECT id FROM user_account')).toHaveLength(3);
});

it('2. without --confirm or with another value the command exits 2 and deletes nothing', async () => {
  const file = await sqliteFile();
  const before = await sqliteState(file);
  const wrong = ['cf', '', 'DEX', undefined as unknown as string];
  for (const confirm of wrong) {
    vi.mocked(console.error).mockClear();
    expect(await runAdminRebindProvider(options(sqliteTarget(file), { confirm }))).toBe(2);
    expect(output().stderr).toBe('admin rebind-provider: confirm_mismatch');
  }
  const withoutConfirm = cliArgs(file).filter((_, i) => i !== 4 && i !== 5);
  vi.mocked(console.error).mockClear();
  expect(await run(withoutConfirm)).toBe(2);
  expect(output().stderr).toContain('Usage:');
  vi.mocked(console.error).mockClear();
  expect(await run(cliArgs(file).map((a, i) => (i === 5 ? 'cf' : a)))).toBe(2);
  expect(output().stderr).toBe('admin rebind-provider: confirm_mismatch');
  expect(console.log).not.toHaveBeenCalled();
  expect(await sqliteState(file)).toEqual(before);
});

it('3. the anchors are required and validated before the database is opened', async () => {
  const missing = join(dir, 'missing.sqlite');
  const cases: [Partial<Parameters<typeof runAdminRebindProvider>[0]>, string][] = [
    [{ provider: 'local', confirm: 'local' }, 'invalid_provider'],
    [{ provider: 'Not Valid', confirm: 'Not Valid' }, 'invalid_provider'],
    [{ expectedAnchor: 'not-an-anchor' }, 'invalid_anchor'],
    [{ newAnchor: 'not-an-anchor' }, 'invalid_anchor'],
    [{ expectedAnchor: '' }, 'invalid_anchor'],
    [{ newAnchor: undefined as unknown as string }, 'invalid_anchor'],
    [{ newAnchor: ANCHOR }, 'anchors_equal'],
  ];
  for (const [override, code] of cases) {
    vi.mocked(console.error).mockClear();
    expect(await runAdminRebindProvider(options(sqliteTarget(missing), override))).toBe(2);
    expect(output().stderr).toBe(`admin rebind-provider: ${code}`);
  }
  for (const flag of ['--expected-anchor', '--new-anchor']) {
    const args = cliArgs(missing);
    args.splice(args.indexOf(flag), 2);
    vi.mocked(console.error).mockClear();
    expect(await run(args)).toBe(2);
    expect(output().stderr).toContain('Usage:');
  }
  expect(console.log).not.toHaveBeenCalled();
});

it('4. an anchor mismatch exits 6 with a fixed message and changes nothing', async () => {
  const file = await sqliteFile();
  const before = await sqliteState(file);
  expect(
    await runAdminRebindProvider(
      options(sqliteTarget(file), { expectedAnchor: 'oidc:https://other.example.test' }),
    ),
  ).toBe(6);
  expect(console.log).not.toHaveBeenCalled();
  expect(output().stderr).toBe(MISMATCH);
  expect(await sqliteState(file)).toEqual(before);
});

it('5. a provider without a binding is an anchor mismatch', async () => {
  const file = await sqliteFile();
  const before = await sqliteState(file);
  expect(
    await runAdminRebindProvider(
      options(sqliteTarget(file), { provider: 'absent', confirm: 'absent' }),
    ),
  ).toBe(6);
  expect(await sqliteState(file)).toEqual(before);
});

it('6. a second run with the same anchors exits 6 and does not delete again', async () => {
  const file = await sqliteFile();
  expect(await runAdminRebindProvider(options(sqliteTarget(file)))).toBe(0);
  vi.mocked(console.log).mockClear();
  const after = await sqliteState(file);
  expect(await runAdminRebindProvider(options(sqliteTarget(file)))).toBe(6);
  expect(console.log).not.toHaveBeenCalled();
  expect(await sqliteState(file)).toEqual(after);
});

it('7. --cloudflare over the D1 HTTP transport reaches the same state', async () => {
  const harness = await createHarness();
  try {
    expect(await runAdminRebindProvider(options(cloudflareTarget(harness.fetch)))).toBe(0);
    expect(lastJson()).toEqual({ provider: PROVIDER, identities: 2, sessions: 2 });
    expect(await harness.query('SELECT provider FROM identity')).toEqual([
      { provider: OTHER_PROVIDER },
    ]);
    expect(
      await harness.query('SELECT provider, anchor FROM identity_provider_binding'),
    ).toContainEqual({
      provider: PROVIDER,
      anchor: NEW_ANCHOR,
    });
    expect(output().stderr).toBe('');
  } finally {
    await harness.database.close();
  }
});

it('8. --cloudflare with a mismatching anchor exits 6 and changes nothing', async () => {
  const harness = await createHarness();
  try {
    const before = await harness.query('SELECT * FROM identity ORDER BY id');
    expect(
      await runAdminRebindProvider(
        options(cloudflareTarget(harness.fetch), { expectedAnchor: NEW_ANCHOR, newAnchor: ANCHOR }),
      ),
    ).toBe(6);
    expect(await harness.query('SELECT * FROM identity ORDER BY id')).toEqual(before);
  } finally {
    await harness.database.close();
  }
});

it('9. exits 5 when the organization is missing', async () => {
  const file = await sqliteFile({ organization: false });
  expect(await runAdminRebindProvider(options(sqliteTarget(file)))).toBe(5);
  expect(output().stderr).toBe(
    'admin rebind-provider: organization not found; run pb bootstrap or pb cloudflare bootstrap first',
  );
  expect(console.log).not.toHaveBeenCalled();
});

it('10. a missing database file is a usage error; a garbage file exits 1 with a fixed message', async () => {
  const missing = join(dir, 'missing.sqlite');
  expect(await runAdminRebindProvider(options(sqliteTarget(missing)))).toBe(2);
  expect(output().stderr).toContain('sqlite_file_not_found');
  vi.mocked(console.error).mockClear();
  const garbage = join(dir, 'garbage.sqlite');
  await writeFile(garbage, `${SENTINEL} `.repeat(200));
  expect(await runAdminRebindProvider(options(sqliteTarget(garbage)))).toBe(1);
  expect(output().stderr).toMatch(/^admin rebind-provider: failed \(\w+\)$/);
  expect(output().stderr).not.toContain(SENTINEL);
  expect(output().stderr).not.toContain(dir);
});

it('11. --cloudflare without credentials exits 2 and never calls the transport', async () => {
  const send = vi.fn();
  expect(
    await runAdminRebindProvider(
      options({
        kind: 'cloudflare',
        databaseId: DATABASE_ID,
        env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
        fetch: send as unknown as typeof fetch,
      }),
    ),
  ).toBe(2);
  expect(send).not.toHaveBeenCalled();
  expect(output().stderr).toContain('CLOUDFLARE_API_TOKEN');
});

it('12. a lost D1 response exits 7 with the fixed message', async () => {
  const harness = await createHarness({
    override: (call) => {
      if (call !== 2) return undefined;
      const response = new Response('{}', { status: 200 });
      vi.spyOn(response, 'text').mockRejectedValue(new Error(SENTINEL));
      return response;
    },
  });
  try {
    expect(await runAdminRebindProvider(options(cloudflareTarget(harness.fetch)))).toBe(7);
    expect(output().stderr).toBe(UNKNOWN);
    expect(console.log).not.toHaveBeenCalled();
  } finally {
    await harness.database.close();
  }
});

it('12b. a committed swap whose response is lost exits 7; the re-run exits 6 and changes nothing', async () => {
  let call = 0;
  let inner: typeof fetch | null = null;
  const lossy = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    call += 1;
    const response = await (inner as typeof fetch)(input as Parameters<typeof fetch>[0], init);
    if (call !== 2) return response;
    const lost = new Response('{}', { status: 200 });
    vi.spyOn(lost, 'text').mockRejectedValue(new Error(SENTINEL));
    return lost;
  }) as typeof fetch;
  const harness = await createHarness();
  inner = harness.fetch;
  try {
    expect(await runAdminRebindProvider(options(cloudflareTarget(lossy)))).toBe(7);
    expect(output().stderr).toBe(UNKNOWN);
    expect(output().stderr).not.toContain(SENTINEL);
    expect(console.log).not.toHaveBeenCalled();
    expect(await harness.query('SELECT provider FROM identity')).toEqual([
      { provider: OTHER_PROVIDER },
    ]);
    const after = await harness.query('SELECT * FROM identity_provider_binding ORDER BY provider');
    expect(after).toContainEqual(
      expect.objectContaining({ provider: PROVIDER, anchor: NEW_ANCHOR }),
    );
    vi.mocked(console.error).mockClear();
    expect(await runAdminRebindProvider(options(cloudflareTarget(harness.fetch)))).toBe(6);
    expect(output().stderr).toBe(MISMATCH);
    expect(console.log).not.toHaveBeenCalled();
    expect(
      await harness.query('SELECT * FROM identity_provider_binding ORDER BY provider'),
    ).toEqual(after);
    expect(await harness.query('SELECT provider FROM identity')).toEqual([
      { provider: OTHER_PROVIDER },
    ]);
  } finally {
    await harness.database.close();
  }
});

it('13. executor errors print the error name only, never messages, anchors or the token', async () => {
  const failing = await createHarness({
    override: (call) => (call === 2 ? d1Failure(`near "${SENTINEL}": syntax error`) : undefined),
  });
  try {
    expect(await runAdminRebindProvider(options(cloudflareTarget(failing.fetch)))).toBe(1);
    const { stdout, stderr } = output();
    for (const text of [stdout, stderr]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(API_TOKEN);
      expect(text).not.toContain('example.test');
    }
    expect(stderr).toMatch(/^admin rebind-provider: failed \(\w+\)$/);
    expect(stdout).toBe('');
  } finally {
    await failing.database.close();
  }
  vi.mocked(console.error).mockClear();
  const throwing = (async () => {
    throw new Error(SENTINEL);
  }) as unknown as typeof fetch;
  expect(await runAdminRebindProvider(options(cloudflareTarget(throwing)))).toBe(7);
  expect(output().stderr).not.toContain(SENTINEL);
  expect(output().stderr).toBe(
    'admin rebind-provider: outcome unknown; the swap may have applied; a re-run that reports anchor_mismatch means it did or the anchor is wrong',
  );
});

it('14. the CLI routes rebind-provider and rejects ambiguous targets and foreign flags', async () => {
  const file = await sqliteFile();
  const before = await sqliteState(file);
  expect(await run(cliArgs(file, ['--cloudflare']))).toBe(2);
  expect(await run(cliArgs(file, ['--database-id', DATABASE_ID]))).toBe(2);
  expect(await run(cliArgs(file, ['--email', 'a@example.test']))).toBe(2);
  expect(await run(cliArgs(file, ['--token-file', join(dir, 't')]))).toBe(2);
  expect(await run(cliArgs(file).filter((a) => a !== '--sqlite' && a !== file))).toBe(2);
  expect(await run(cliArgs(file, ['--bogus']))).toBe(2);
  expect(await sqliteState(file)).toEqual(before);
  expect(await run(cliArgs(file))).toBe(0);
  expect(lastJson()).toEqual({ provider: PROVIDER, identities: 2, sessions: 2 });
});

it('15. run() with --cloudflare --database-id reads the credentials from the environment', async () => {
  const harness = await createHarness();
  vi.stubEnv('CLOUDFLARE_API_TOKEN', API_TOKEN);
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', ACCOUNT_ID);
  vi.stubGlobal('fetch', harness.fetch);
  try {
    const args = cliArgs('unused').slice(0, -2);
    expect(await run([...args, '--cloudflare', '--database-id', DATABASE_ID])).toBe(0);
    expect(await harness.query('SELECT provider FROM identity')).toEqual([
      { provider: OTHER_PROVIDER },
    ]);
  } finally {
    await harness.database.close();
  }
});

it('16. the usage text lists the command and the exit codes', async () => {
  expect(await run(['--help'])).toBe(0);
  const usage = output().stdout;
  expect(usage).toContain('pb admin rebind-provider --provider <id> --confirm <id>');
  expect(usage).toContain('--expected-anchor <anchor> --new-anchor <anchor>');
  expect(usage).toContain('pb admin bootstrap/reset-local: 0');
  expect(usage).toContain('no binding with that provider and expected anchor; nothing changed');
  expect(usage).toContain('the swap may have applied');
});

it('17. a non-lost executor error exits 1 with the error name only', async () => {
  const failing = await createHarness({
    override: (call) => (call === 2 ? d1Failure(`near "${SENTINEL}": syntax error`) : undefined),
  });
  try {
    expect(await runAdminRebindProvider(options(cloudflareTarget(failing.fetch)))).toBe(1);
    expect(output().stderr).toMatch(/^admin rebind-provider: failed \(\w+\)$/);
    expect(output().stderr).not.toContain(SENTINEL);
  } finally {
    await failing.database.close();
  }
});
