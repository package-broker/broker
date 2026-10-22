import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { deferredDispatch } from '@package-broker/core/authz/token-use';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '@package-broker/core/plugin';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import {
  formatMasterKey,
  generateMasterKey,
  parseMasterKey,
} from '@package-broker/core/secrets/master-key';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import { describeError } from './entry.js';
import { createNodeServer, type NodeBroker } from './index.js';
import { startNode } from './startup.js';

const handlers = vi.hoisted(() => ({
  captured: [] as Array<(request: Request) => Promise<Response> | Response>,
}));

vi.mock('@hono/node-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hono/node-server')>();
  return {
    ...actual,
    getRequestListener: (...args: Parameters<typeof actual.getRequestListener>) => {
      handlers.captured.push(args[0] as (request: Request) => Promise<Response> | Response);
      return actual.getRequestListener(...args);
    },
  };
});

const selfTest = vi.hoisted(() => ({ fail: false }));
const created = vi.hoisted(() => ({
  options: [] as Array<{ readonly auth?: { readonly env: Readonly<Record<string, unknown>> } }>,
}));

vi.mock('@package-broker/core/auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@package-broker/core/auth/password')>();
  const { SecretsConfigError } = await import('@package-broker/core/secrets/master-key');
  return {
    ...actual,
    selfTestPasswordHashing: (...args: Parameters<typeof actual.selfTestPasswordHashing>) =>
      selfTest.fail
        ? Promise.reject(new SecretsConfigError('malformed', 'PASSWORD_ITERATIONS'))
        : actual.selfTestPasswordHashing(...args),
  };
});

vi.mock('./index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index.js')>();
  return {
    ...actual,
    createNodeServer: (...args: Parameters<typeof actual.createNodeServer>) => {
      created.options.push(args[1] ?? {});
      return actual.createNodeServer(...args);
    },
  };
});

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const NEWER_KEY = formatMasterKey(generateMasterKey(2));
const SENTINEL = 'SENTINEL_PROVIDER_FAILURE_7f3a';
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function migrationSources(): Promise<MigrationSource[]> {
  const names = ['0001_init.sql'];
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
}

function plugin(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id: 'sso',
    package: '@test/sso',
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['node'],
    ...overrides,
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function cookieHeader(responses: readonly Response[]): string {
  const jar = new Map<string, string>();
  for (const response of responses) {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] as string;
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

const recorded = vi.hoisted(() => ({ closes: [] as string[] }));

vi.mock('./db/better-sqlite3-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/better-sqlite3-executor.js')>();
  return {
    ...actual,
    openBetterSqliteExecutor: (path: string, options?: { readonly busyTimeoutMs?: number }) => {
      const opened = actual.openBetterSqliteExecutor(path, options);
      return {
        executor: opened.executor,
        close: async (): Promise<void> => {
          recorded.closes.push(path);
          await opened.close();
        },
      };
    },
  };
});

describe('node auth wiring', () => {
  let directory: string;
  let path: string;
  const running: NodeBroker[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-auth-wiring-'));
    path = join(directory, 'broker.sqlite');
    recorded.closes.length = 0;
    handlers.captured.length = 0;
    created.options.length = 0;
    selfTest.fail = false;
  });

  afterEach(async () => {
    for (const broker of running.splice(0)) await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('calls register once per server build with auth', async () => {
    const register = vi.fn((registry: Parameters<NonNullable<PluginDefinition['register']>>[0]) => {
      registry.route({
        method: 'GET',
        path: '/registered',
        permission: null,
        needsOrg: false,
        handler: () => new Response('ok'),
      });
    });
    const broker = createNodeServer([plugin({ register })], {
      auth: {
        keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
        publicOrigin: 'http://127.0.0.1',
        env: {},
      },
    });
    running.push(broker);
    const kernel = await broker.ready();

    expect(register).toHaveBeenCalledTimes(1);
    expect((await kernel.fetch(new Request('http://127.0.0.1/registered'))).status).toBe(200);
    expect((await kernel.fetch(new Request('http://127.0.0.1/_pb/auth/providers'))).status).toBe(
      200,
    );
  });

  it('refuses to start when a plugin register throws, calling it once', async () => {
    let calls = 0;
    const listenSpy = vi.spyOn(Server.prototype, 'listen');
    try {
      const failure = await rejection(
        start({}, [
          plugin({
            register() {
              calls += 1;
              throw new Error(SENTINEL);
            },
          }),
        ]),
      );

      expect(failure).toBeInstanceOf(KernelConfigError);
      expect(calls).toBe(1);
      expect(String(failure)).not.toContain(SENTINEL);
      expect(listenSpy).not.toHaveBeenCalled();
      expect(recorded.closes).toEqual([path]);
    } finally {
      listenSpy.mockRestore();
    }
  });

  function env(overrides: Record<string, string | undefined> = {}) {
    return {
      PB_SQLITE_PATH: path,
      PB_ORG_SLUG: 'acme',
      PB_ORG_NAME: 'Acme',
      PB_MASTER_KEY: KEY,
      PB_PUBLIC_URL: 'http://127.0.0.1',
      ...overrides,
    };
  }

  async function start(
    overrides: Record<string, string | undefined> = {},
    plugins: readonly PluginDefinition[] = [],
  ): Promise<NodeBroker> {
    const broker = await startNode({
      plugins,
      migrations: await migrationSources(),
      env: env(overrides),
    });
    running.push(broker);
    return broker;
  }

  async function listen(broker: NodeBroker, port: number): Promise<string> {
    await new Promise<void>((resolve) => broker.server.listen(port, '127.0.0.1', resolve));
    return `http://127.0.0.1:${port}`;
  }

  async function seedAdmin(): Promise<string> {
    const opened = openBetterSqliteExecutor(path);
    try {
      const org = await createOrganizationBootstrap(opened.executor).findSingleton();
      if (org === null) throw new Error('organization missing');
      const token = randomBytes(32).toString('base64url');
      const roleIds = Object.fromEntries(DEFAULT_ROLES.map((role) => [role.key, ulid()])) as Record<
        DefaultRoleKey,
        string
      >;
      const now = new Date();
      await bootstrapAdmin(opened.executor, orgContext(org.id), {
        email: EMAIL,
        userId: ulid(),
        setupHash: createHash('sha256').update(token).digest('hex'),
        setupExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        grantId: ulid(),
        roleIds,
        opId: ulid(),
        now: now.toISOString(),
      });
      return token;
    } finally {
      await opened.close();
    }
  }

  async function post(
    base: string,
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, ...headers },
      body: JSON.stringify(body),
    });
  }

  async function tableNames(): Promise<string[]> {
    const opened = openBetterSqliteExecutor(path);
    try {
      const rows = await opened.executor.all<{ name: string }>({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table'",
        params: [],
      });
      return rows.map((row) => row.name);
    } finally {
      await opened.close();
    }
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it('1: local setup and login over HTTP give a session that GET /_pb/session accepts', async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const broker = await start({ PB_PUBLIC_URL: base });
    await listen(broker, port);
    const token = await seedAdmin();

    const started = await post(base, '/_pb/auth/local/setup/start', { token });
    expect(started.status).toBe(200);
    const { secret } = (await started.json()) as { secret: string };
    const totpSecret = base32Decode(secret);
    const step = Math.floor(Date.now() / 30_000);

    const finished = await post(base, '/_pb/auth/local/setup/finish', {
      token,
      password: PASSWORD,
      code: await totpCode(totpSecret, step),
    });
    expect(finished.status).toBe(204);

    const login = await post(base, '/_pb/auth/local/login', {
      email: EMAIL,
      password: PASSWORD,
      code: await totpCode(totpSecret, step + 1),
    });
    expect(login.status).toBe(204);
    const cookie = cookieHeader([login]);
    expect(cookie).toContain('__Host-pb_session=');

    const session = await fetch(`${base}/_pb/session`, { headers: { cookie } });
    expect(session.status).toBe(200);
    const body = (await session.json()) as { user: { email?: string } };
    expect(body.user).toBeDefined();

    const anonymous = await fetch(`${base}/_pb/session`);
    expect(anonymous.status).toBe(401);
  });

  it.each([
    ['a trailing slash', (port: number) => `http://127.0.0.1:${port}/`, '127.0.0.1'],
    ['an uppercase scheme and host', (port: number) => `HTTP://LOCALHOST:${port}/`, 'localhost'],
  ])('2: PB_PUBLIC_URL with %s derives the canonical origin', async (_name, url, host) => {
    const port = await freePort();
    const broker = await start({ PB_PUBLIC_URL: url(port) });
    const base = await listen(broker, port);
    const origin = `http://${host}:${port}`;

    const accepted = await post(base, '/_pb/auth/local/setup/start', { token: 'x' }, { origin });
    expect(accepted.status).toBe(401);
    const refused = await post(
      base,
      '/_pb/auth/local/setup/start',
      { token: 'x' },
      { origin: 'http://example.com' },
    );
    expect(refused.status).toBe(403);
  });

  it('3: PB_MASTER_KEY_FILE with a trailing newline works, and so does PB_MASTER_KEY_PREVIOUS_FILE', async () => {
    const currentFile = join(directory, 'master-key');
    const previousFile = join(directory, 'master-key-previous');
    await writeFile(currentFile, `${NEWER_KEY}\n`);
    await writeFile(previousFile, `${KEY}\n`);
    const broker = await start({
      PB_MASTER_KEY: undefined,
      PB_MASTER_KEY_FILE: currentFile,
      PB_MASTER_KEY_PREVIOUS_FILE: previousFile,
    });
    const base = await listen(broker, await freePort());

    expect((await fetch(`${base}/_pb/auth/providers`)).status).toBe(200);
  });

  it('4: a key file without a trailing newline works', async () => {
    const currentFile = join(directory, 'master-key');
    await writeFile(currentFile, KEY);
    const broker = await start({ PB_MASTER_KEY: undefined, PB_MASTER_KEY_FILE: currentFile });
    const base = await listen(broker, await freePort());

    expect((await fetch(`${base}/_pb/auth/providers`)).status).toBe(200);
  });

  describe('start-up refusals', () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly setup?: () => Promise<Record<string, string | undefined>>;
      readonly overrides?: Record<string, string | undefined>;
      readonly plugins?: readonly PluginDefinition[];
      readonly mentions: string;
      readonly afterMigrations?: true;
    }> = [
      { name: 'a missing key', overrides: { PB_MASTER_KEY: undefined }, mentions: 'PB_MASTER_KEY' },
      { name: 'an empty key', overrides: { PB_MASTER_KEY: '' }, mentions: 'PB_MASTER_KEY' },
      {
        name: 'a malformed key',
        overrides: { PB_MASTER_KEY: 'pbmk_v1_NOT_A_REAL_KEY_VALUE' },
        mentions: 'PB_MASTER_KEY',
      },
      {
        name: 'both PB_MASTER_KEY and PB_MASTER_KEY_FILE',
        setup: async () => {
          const file = join(directory, 'key');
          await writeFile(file, KEY);
          return { PB_MASTER_KEY_FILE: file };
        },
        mentions: 'PB_MASTER_KEY_FILE',
      },
      {
        name: 'both PB_MASTER_KEY_PREVIOUS and its file',
        setup: async () => {
          const file = join(directory, 'previous');
          await writeFile(file, KEY);
          return {
            PB_MASTER_KEY: NEWER_KEY,
            PB_MASTER_KEY_PREVIOUS: KEY,
            PB_MASTER_KEY_PREVIOUS_FILE: file,
          };
        },
        mentions: 'PB_MASTER_KEY_PREVIOUS_FILE',
      },
      {
        name: 'an unreadable key file',
        overrides: { PB_MASTER_KEY: undefined, PB_MASTER_KEY_FILE: '/nonexistent/pb-key' },
        mentions: 'PB_MASTER_KEY_FILE is unreadable (ENOENT)',
      },
      {
        name: 'a key file that is a directory',
        setup: async () => {
          const folder = join(directory, 'folder');
          await mkdir(folder);
          return { PB_MASTER_KEY: undefined, PB_MASTER_KEY_FILE: folder };
        },
        mentions: 'PB_MASTER_KEY_FILE is not a regular file',
      },
      {
        name: 'a key file with a malformed key',
        setup: async () => {
          const file = join(directory, 'key');
          await writeFile(file, `${SENTINEL}\n`);
          return { PB_MASTER_KEY: undefined, PB_MASTER_KEY_FILE: file };
        },
        mentions: 'PB_MASTER_KEY_FILE',
      },
      {
        name: 'a key file with two trailing newlines',
        setup: async () => {
          const file = join(directory, 'key');
          await writeFile(file, `${KEY}\n\n`);
          return { PB_MASTER_KEY: undefined, PB_MASTER_KEY_FILE: file };
        },
        mentions: 'PB_MASTER_KEY_FILE',
      },
      {
        name: 'an unreadable previous key file',
        overrides: {
          PB_MASTER_KEY: NEWER_KEY,
          PB_MASTER_KEY_PREVIOUS_FILE: '/nonexistent/pb-key-previous',
        },
        mentions: 'PB_MASTER_KEY_PREVIOUS_FILE',
      },
      {
        name: 'a previous key that is not older',
        overrides: { PB_MASTER_KEY: KEY, PB_MASTER_KEY_PREVIOUS: NEWER_KEY },
        mentions: 'PB_MASTER_KEY_PREVIOUS',
      },
      {
        name: 'a missing PB_PUBLIC_URL',
        overrides: { PB_PUBLIC_URL: undefined },
        mentions: 'PB_PUBLIC_URL',
      },
      {
        name: 'an empty PB_PUBLIC_URL',
        overrides: { PB_PUBLIC_URL: '' },
        mentions: 'PB_PUBLIC_URL',
      },
      {
        name: 'http on a public host',
        overrides: { PB_PUBLIC_URL: 'http://example.com' },
        mentions: 'PB_PUBLIC_URL',
      },
      {
        name: 'a relative URL',
        overrides: { PB_PUBLIC_URL: '/broker' },
        mentions: 'PB_PUBLIC_URL',
      },
      {
        name: 'another scheme',
        overrides: { PB_PUBLIC_URL: 'ftp://example.com' },
        mentions: 'PB_PUBLIC_URL',
      },
      {
        name: 'a path',
        overrides: { PB_PUBLIC_URL: 'https://example.com/broker' },
        mentions: 'PB_PUBLIC_URL',
      },
      {
        name: 'a query',
        overrides: { PB_PUBLIC_URL: 'https://example.com/?x=1' },
        mentions: 'PB_PUBLIC_URL',
      },
      {
        name: 'credentials',
        overrides: { PB_PUBLIC_URL: 'https://user:pass@example.com' },
        mentions: 'PB_PUBLIC_URL',
      },
      {
        name: 'a provider factory that throws',
        plugins: [
          plugin({
            binds: ['identity'],
            identityProviders: () => {
              throw new Error(SENTINEL);
            },
          }),
        ],
        mentions: 'identity',
        afterMigrations: true,
      },
      {
        name: 'a trailing question mark',
        overrides: { PB_PUBLIC_URL: 'https://example.com/?' },
        mentions: 'PB_PUBLIC_URL',
      },
      {
        name: 'a trailing fragment marker',
        overrides: { PB_PUBLIC_URL: 'https://example.com/#' },
        mentions: 'PB_PUBLIC_URL',
      },
      {
        name: 'a key file larger than 4 KiB',
        setup: async () => {
          const file = join(directory, 'key');
          await writeFile(file, `${KEY}${'A'.repeat(5000)}`);
          return { PB_MASTER_KEY: undefined, PB_MASTER_KEY_FILE: file };
        },
        mentions: 'PB_MASTER_KEY_FILE is larger than 4096 bytes',
      },
      {
        name: 'an empty key file',
        setup: async () => {
          const file = join(directory, 'key');
          await writeFile(file, '\n');
          return { PB_MASTER_KEY: undefined, PB_MASTER_KEY_FILE: file };
        },
        mentions: 'PB_MASTER_KEY_FILE has empty content',
      },
    ];

    it.each(cases)('5: $name rejects, closes the database and never listens', async (testCase) => {
      const extra = (await testCase.setup?.()) ?? {};
      const listenSpy = vi.spyOn(Server.prototype, 'listen');
      try {
        const failure = await rejection(
          start({ ...testCase.overrides, ...extra }, testCase.plugins ?? []),
        );

        expect(failure).toBeInstanceOf(Error);
        const printed = `${describeError(failure)}\n${(failure as Error).stack ?? ''}`;
        expect(printed).toContain(testCase.mentions);
        for (const secret of [
          KEY,
          KEY.slice(8),
          NEWER_KEY.slice(8),
          SENTINEL,
          'NOT_A_REAL_KEY_VALUE',
          'user:pass',
          '/nonexistent/pb-key',
        ]) {
          expect(printed).not.toContain(secret);
        }
        expect(listenSpy).not.toHaveBeenCalled();
        expect(recorded.closes).toEqual([path]);
        const tables = await tableNames();
        if (testCase.afterMigrations === undefined) {
          expect(tables).toEqual([]);
        } else {
          expect(tables).toContain('organization');
        }
      } finally {
        listenSpy.mockRestore();
      }
    });
  });

  describe('key variable pairs', () => {
    type State = 'unset' | 'empty' | 'set';
    const STATES: readonly State[] = ['unset', 'empty', 'set'];
    const pairs = [
      { variable: 'PB_MASTER_KEY', fileVariable: 'PB_MASTER_KEY_FILE', required: true },
      {
        variable: 'PB_MASTER_KEY_PREVIOUS',
        fileVariable: 'PB_MASTER_KEY_PREVIOUS_FILE',
        required: false,
      },
    ] as const;
    const permutations = pairs.flatMap((pair) =>
      STATES.flatMap((direct) => STATES.map((file) => ({ ...pair, direct, file }))),
    );

    function expectation(pair: (typeof permutations)[number]): string | null {
      if (pair.direct !== 'unset' && pair.file !== 'unset') return 'are both set';
      if (pair.direct === 'empty') return `${pair.variable} is empty`;
      if (pair.file === 'empty') return `${pair.fileVariable} is empty`;
      if (pair.direct === 'unset' && pair.file === 'unset' && pair.required) {
        return 'PB_MASTER_KEY is missing';
      }
      return null;
    }

    it.each(permutations)(
      '$variable is $direct and $fileVariable is $file',
      async (permutation) => {
        const file = join(directory, 'key-file');
        await writeFile(file, `${KEY}\n`);
        const overrides: Record<string, string | undefined> = {
          PB_MASTER_KEY: permutation.required ? undefined : NEWER_KEY,
          PB_MASTER_KEY_FILE: undefined,
        };
        overrides[permutation.variable] = {
          unset: undefined,
          empty: '',
          set: KEY,
        }[permutation.direct];
        overrides[permutation.fileVariable] = {
          unset: undefined,
          empty: '',
          set: file,
        }[permutation.file];
        const expected = expectation(permutation);

        const failure = await rejection(start(overrides));

        if (expected === null) {
          expect(failure).toBeUndefined();
        } else {
          expect(failure).toBeInstanceOf(Error);
          expect(describeError(failure)).toContain(expected);
        }
      },
    );
  });

  describe('start-up order', () => {
    it('refuses to start when the PBKDF2 self-test fails, naming PASSWORD_ITERATIONS', async () => {
      selfTest.fail = true;
      const listenSpy = vi.spyOn(Server.prototype, 'listen');
      try {
        const failure = await rejection(start());

        expect(failure).toBeInstanceOf(Error);
        expect(describeError(failure)).toContain('PASSWORD_ITERATIONS');
        expect(listenSpy).not.toHaveBeenCalled();
        expect(recorded.closes).toEqual([path]);
        expect(await tableNames()).toEqual([]);
      } finally {
        listenSpy.mockRestore();
      }
    });

    it('passes only PB_IDP_ entries of the environment to the auth options', async () => {
      await start({ PB_IDP_EXAMPLE_CLIENT_ID: 'visible', PB_MASTER_KEY_PREVIOUS: undefined });

      const auth = created.options.at(-1)?.auth;
      expect(auth).toBeDefined();
      expect(Object.keys(auth?.env ?? {})).toEqual(['PB_IDP_EXAMPLE_CLIENT_ID']);
    });
  });

  it('6: providers see only PB_IDP_ variables, never the master key', async () => {
    const seen: Array<string | undefined> = [];
    const broker = await start(
      { PB_IDP_EXAMPLE_CLIENT_ID: 'visible', PB_MASTER_KEY_PREVIOUS: undefined },
      [
        plugin({
          binds: ['identity'],
          identityProviders: (ctx) => {
            seen.push(
              ctx.env('PB_IDP_EXAMPLE_CLIENT_ID'),
              ctx.env('PB_MASTER_KEY'),
              ctx.env('PB_PUBLIC_URL'),
              ctx.env('PB_SQLITE_PATH'),
            );
            return [];
          },
        }),
      ],
    );
    await broker.ready();

    expect(seen).toEqual(['visible', undefined, undefined, undefined]);
  });

  describe('createNodeServer', () => {
    function bare(options: Parameters<typeof createNodeServer>[1] = {}): NodeBroker {
      const broker = createNodeServer([], { log: () => undefined, ...options });
      running.push(broker);
      return broker;
    }

    it('7: without auth no /_pb/auth route is mounted', async () => {
      const kernel = await bare().ready();

      for (const route of ['/_pb/auth/providers', '/_pb/session']) {
        const response = await kernel.fetch(new Request(`http://127.0.0.1${route}`));
        expect(response.status).toBe(404);
      }
    });

    it('8: with auth the provider list is served', async () => {
      const keyring = createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
      const kernel = await bare({
        auth: { keyring, publicOrigin: 'http://127.0.0.1', env: {} },
      }).ready();

      const response = await kernel.fetch(new Request('http://127.0.0.1/_pb/auth/providers'));
      expect(response.status).toBe(200);
    });

    it('8a: the services carry the anchors of the providers the auth module uses', async () => {
      const keyring = createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
      const trustAnchor = `access:team.example.com/${'ab'.repeat(32)}`;
      const broker = createNodeServer(
        [
          plugin({
            binds: ['identity'],
            identityProviders: () => [
              {
                id: 'access',
                kind: 'cloudflare-access',
                displayName: 'Access',
                trustAnchor,
                policy: {
                  verifiedDomains: ['example.test', 'other.test'],
                  emailAuthoritativeDomains: ['example.test'],
                  autoJoin: false,
                },
                supportsReauth: false,
                start: () => Promise.resolve({ kind: 'direct' }),
                finish: () => Promise.resolve({ ok: false, reason: 'provider_error' }),
              },
            ],
          }),
        ],
        { log: () => undefined, auth: { keyring, publicOrigin: 'http://127.0.0.1', env: {} } },
      );
      running.push(broker);
      const services = await broker.services();

      expect(await services.providerAnchors.anchors(orgContext(ulid()))).toEqual([
        {
          provider: 'access',
          anchor: trustAnchor,
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test'],
        },
      ]);
      expect(services.dispatch).toBe(deferredDispatch);
      expect(await broker.services()).toBe(services);
    });

    it('8b: without auth the services carry no provider anchors', async () => {
      const services = await bare().services();
      expect(await services.providerAnchors.anchors(orgContext(ulid()))).toEqual([]);
    });

    it('9: a non-canonical publicOrigin fails the kernel build', async () => {
      const keyring = createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
      const failure = await rejection(
        bare({ auth: { keyring, publicOrigin: 'http://127.0.0.1/', env: {} } }).ready(),
      );

      expect(failure).toBeInstanceOf(TypeError);
    });

    it('10: a kernel build failure answers 503 misconfigured on GET and without a body on HEAD', async () => {
      const broken = plugin({ apiVersion: 999 as PluginDefinition['apiVersion'] });
      const unusable = createNodeServer([broken], { log: () => undefined });
      running.push(unusable);
      await rejection(unusable.ready());
      const handle = handlers.captured.at(-1);
      expect(handle).toBeDefined();

      const get = await (handle as NonNullable<typeof handle>)(
        new Request('http://127.0.0.1/health/ready'),
      );
      expect(get.status).toBe(503);
      expect(((await get.json()) as { error: { code: string } }).error.code).toBe('misconfigured');

      const head = await (handle as NonNullable<typeof handle>)(
        new Request('http://127.0.0.1/health/ready', { method: 'HEAD' }),
      );
      expect(head.status).toBe(503);
      expect(head.body).toBeNull();
    });

    it('11: the same 503 reaches a real client on GET and HEAD', async () => {
      const unusable = createNodeServer(
        [plugin({ apiVersion: 999 as PluginDefinition['apiVersion'] })],
        {
          log: () => undefined,
        },
      );
      running.push(unusable);
      await rejection(unusable.ready());
      const base = await listen(unusable, await freePort());

      const get = await fetch(`${base}/health/ready`);
      expect(get.status).toBe(503);
      expect(((await get.json()) as { error: { code: string } }).error.code).toBe('misconfigured');
      const head = await fetch(`${base}/health/ready`, { method: 'HEAD' });
      expect(head.status).toBe(503);
      expect(await head.text()).toBe('');
    });
  });
});
