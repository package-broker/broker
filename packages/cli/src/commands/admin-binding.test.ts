import { mkdtemp, rm } from 'node:fs/promises';
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
import { runAdminShowProviderBinding, type AdminTarget } from './admin.js';

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
const NO_BINDING = 'admin show-provider-binding: no_binding; nothing is bound for that provider';
const UNKNOWN = 'admin show-provider-binding: outcome unknown; re-running is safe';

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

function sqliteTarget(file: string) {
  return { kind: 'sqlite', file } as const;
}

function cloudflareTarget(send: typeof fetch) {
  return { kind: 'cloudflare', databaseId: DATABASE_ID, env: ENV, fetch: send } as const;
}

function options(
  target: AdminTarget,
  overrides: Partial<Parameters<typeof runAdminShowProviderBinding>[0]> = {},
) {
  return { provider: PROVIDER, target, ...overrides };
}

function showArgs(file: string, extra: string[] = []): string[] {
  return ['admin', 'show-provider-binding', '--provider', PROVIDER, '--sqlite', file, ...extra];
}

function rebindArgs(file: string, expectedAnchor: string): string[] {
  return [
    'admin',
    'rebind-provider',
    '--provider',
    PROVIDER,
    '--confirm',
    PROVIDER,
    '--expected-anchor',
    expectedAnchor,
    '--new-anchor',
    NEW_ANCHOR,
    '--sqlite',
    file,
  ];
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  dir = await mkdtemp(join(tmpdir(), 'pb-binding-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

it('1. SQLite: after a seeded login the anchor and createdAt print and exit 0', async () => {
  const file = await sqliteFile();
  expect(await runAdminShowProviderBinding(options(sqliteTarget(file)))).toBe(0);
  const printed = lastJson();
  expect(printed.provider).toBe(PROVIDER);
  expect(printed.anchor).toBe(ANCHOR);
  expect(printed.createdAt).toEqual(expect.any(String));
  expect(output().stderr).toBe('');
});

it('2. the printed anchor feeds rebind-provider --expected-anchor and the swap applies', async () => {
  const file = await sqliteFile();
  expect(await runAdminShowProviderBinding(options(sqliteTarget(file)))).toBe(0);
  const printedAnchor = String(lastJson().anchor);
  expect(printedAnchor).toBe(ANCHOR);

  vi.mocked(console.log).mockClear();
  expect(await run(rebindArgs(file, printedAnchor))).toBe(0);
  expect(lastJson()).toEqual({ provider: PROVIDER, identities: 2, sessions: 2 });

  vi.mocked(console.log).mockClear();
  expect(await runAdminShowProviderBinding(options(sqliteTarget(file)))).toBe(0);
  expect(lastJson()).toMatchObject({ provider: PROVIDER, anchor: NEW_ANCHOR });
});

it('3. a provider without a binding exits 6 with the fixed text and prints nothing', async () => {
  const file = await sqliteFile();
  expect(
    await runAdminShowProviderBinding(options(sqliteTarget(file), { provider: 'absent' })),
  ).toBe(6);
  expect(output().stderr).toBe(NO_BINDING);
  expect(console.log).not.toHaveBeenCalled();
});

it('4. an invalid or reserved provider exits 2 before the target is opened', async () => {
  const missing = join(dir, 'missing.sqlite');
  for (const provider of [
    'local',
    'Not Valid',
    '',
    'a'.repeat(65),
    undefined as unknown as string,
  ]) {
    vi.mocked(console.error).mockClear();
    expect(await runAdminShowProviderBinding(options(sqliteTarget(missing), { provider }))).toBe(2);
    expect(output().stderr).toBe('admin show-provider-binding: invalid_provider');
    expect(output().stderr).not.toContain('sqlite_file_not_found');
  }
  expect(console.log).not.toHaveBeenCalled();
});

it('5. --cloudflare over the D1 HTTP transport reaches the same output', async () => {
  const harness = await createHarness();
  try {
    expect(await runAdminShowProviderBinding(options(cloudflareTarget(harness.fetch)))).toBe(0);
    const printed = lastJson();
    expect(printed.provider).toBe(PROVIDER);
    expect(printed.anchor).toBe(ANCHOR);
    expect(printed.createdAt).toEqual(expect.any(String));
    expect(output().stderr).toBe('');
    expect(output().stderr).not.toContain(API_TOKEN);
  } finally {
    await harness.database.close();
  }
});

it('6. --cloudflare for an unbound provider exits 6', async () => {
  const harness = await createHarness();
  try {
    expect(
      await runAdminShowProviderBinding(
        options(cloudflareTarget(harness.fetch), { provider: 'absent' }),
      ),
    ).toBe(6);
    expect(output().stderr).toBe(NO_BINDING);
    expect(console.log).not.toHaveBeenCalled();
  } finally {
    await harness.database.close();
  }
});

it('7. exits 5 when the organization is missing', async () => {
  const file = await sqliteFile({ organization: false });
  expect(await runAdminShowProviderBinding(options(sqliteTarget(file)))).toBe(5);
  expect(output().stderr).toBe(
    'admin show-provider-binding: organization not found; run pb bootstrap or pb cloudflare bootstrap first',
  );
  expect(console.log).not.toHaveBeenCalled();
});

it('8. a lost D1 response exits 7 with the fixed message and prints nothing', async () => {
  const harness = await createHarness({
    override: (call) => {
      if (call !== 2) return undefined;
      const response = new Response('{}', { status: 200 });
      vi.spyOn(response, 'text').mockRejectedValue(new Error(SENTINEL));
      return response;
    },
  });
  try {
    expect(await runAdminShowProviderBinding(options(cloudflareTarget(harness.fetch)))).toBe(7);
    expect(output().stderr).toBe(UNKNOWN);
    expect(output().stderr).not.toContain(SENTINEL);
    expect(console.log).not.toHaveBeenCalled();
  } finally {
    await harness.database.close();
  }
});

it('9. a missing sqlite file is a usage error and a garbage file exits 1 with a fixed message', async () => {
  const missing = join(dir, 'missing.sqlite');
  expect(await runAdminShowProviderBinding(options(sqliteTarget(missing)))).toBe(2);
  expect(output().stderr).toContain('sqlite_file_not_found');
  vi.mocked(console.error).mockClear();
  const harness = await createHarness({
    override: (call) => (call === 2 ? d1Failure(`near "${SENTINEL}": syntax error`) : undefined),
  });
  try {
    expect(await runAdminShowProviderBinding(options(cloudflareTarget(harness.fetch)))).toBe(1);
    expect(output().stderr).toMatch(/^admin show-provider-binding: failed \(\w+\)$/);
    expect(output().stderr).not.toContain(SENTINEL);
    expect(console.log).not.toHaveBeenCalled();
  } finally {
    await harness.database.close();
  }
});

it('10. the CLI routes show-provider-binding and rejects ambiguous targets and foreign flags', async () => {
  const file = await sqliteFile();
  expect(await run(showArgs(file))).toBe(0);
  expect(lastJson()).toMatchObject({ provider: PROVIDER, anchor: ANCHOR });
  vi.mocked(console.error).mockClear();
  expect(await run(showArgs(file, ['--cloudflare']))).toBe(2);
  expect(await run(showArgs(file, ['--database-id', DATABASE_ID]))).toBe(2);
  expect(await run(showArgs(file, ['--bogus']))).toBe(2);
  expect(await run(showArgs(file, ['--new-anchor', NEW_ANCHOR]))).toBe(2);
  expect(await run(['admin', 'show-provider-binding', '--sqlite', file])).toBe(2);
  expect(output().stderr).toContain('Usage:');
});

it('11. run() with --cloudflare --database-id reads the credentials from the environment', async () => {
  const harness = await createHarness();
  vi.stubEnv('CLOUDFLARE_API_TOKEN', API_TOKEN);
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', ACCOUNT_ID);
  vi.stubGlobal('fetch', harness.fetch);
  try {
    expect(
      await run([
        'admin',
        'show-provider-binding',
        '--provider',
        PROVIDER,
        '--cloudflare',
        '--database-id',
        DATABASE_ID,
      ]),
    ).toBe(0);
    expect(lastJson()).toMatchObject({ provider: PROVIDER, anchor: ANCHOR });
  } finally {
    await harness.database.close();
  }
});

it('12. the usage text lists the command and its exit codes', async () => {
  expect(await run(['--help'])).toBe(0);
  const usage = output().stdout;
  expect(usage).toContain(
    'pb admin show-provider-binding --provider <id> (--sqlite <file> | --cloudflare --database-id <id>)',
  );
  expect(usage).toContain('no_binding; nothing is bound for that provider');
  expect(usage).toContain('re-running is safe');
});
