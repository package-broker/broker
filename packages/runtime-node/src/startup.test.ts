import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { formatToken } from '@package-broker/core/secrets/token-format';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { BLOB_DELETE_TIMEOUT_MS, BLOB_PURGE_LEASE_SECONDS, blobPurgeTiming } from './startup.js';
import { createBlobLifecycle } from '@package-broker/core/platform/blob-lifecycle';
import type { ByteStore } from '@package-broker/core/platform/blob';
import { access, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  SUPPORTED_PLUGIN_API,
  type PluginDefinition,
  type PluginPorts,
} from '@package-broker/core/plugin';
import { AUTH_REASON_CODES, type AuthReasonCode } from '@package-broker/core/auth/reason-codes';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { MigrationChecksumError } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { createObservability, type ObsRecord } from '@package-broker/core/platform/observability';
import { encodeMetrics } from '@package-broker/core/platform/otlp';
import {
  AUTH_EVENTS,
  AlreadyBootstrappedError,
  NODE_RUNTIME_EVENTS,
  StartupConfigError,
  sinkLog,
  registeredAuthReason,
  startNode,
  type StartOptions,
} from './startup.js';
import type { StdioStream } from './observability/stdio.js';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import type { NodeBroker } from './index.js';
import { JOB_DRAIN_MS } from './jobs/loop.js';

const recorded = vi.hoisted(() => ({
  closes: [] as string[],
  events: [] as Array<Readonly<Record<string, unknown>>>,
  usesAfterClose: 0,
}));

vi.mock('./db/better-sqlite3-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/better-sqlite3-executor.js')>();
  return {
    ...actual,
    openBetterSqliteExecutor: (path: string, options?: { readonly busyTimeoutMs?: number }) => {
      const opened = actual.openBetterSqliteExecutor(path, options);
      let closed = false;
      const executor = new Proxy(opened.executor, {
        get(target, property, receiver): unknown {
          const member: unknown = Reflect.get(target, property, receiver);
          if (typeof member !== 'function') return member;
          return (...args: unknown[]): unknown => {
            if (closed) recorded.usesAfterClose += 1;
            return (member as (...inner: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      return {
        executor,
        close: async (): Promise<void> => {
          closed = true;
          recorded.closes.push(path);
          await opened.close();
        },
      };
    },
  };
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function canTakeWriteLock(path: string): Promise<boolean> {
  const reopened = openBetterSqliteExecutor(path);
  try {
    await reopened.executor.batch([{ sql: 'SELECT 1', params: [] }]);
    return true;
  } finally {
    await reopened.close();
  }
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function healthyPlugin(): PluginDefinition {
  return {
    id: 'healthy',
    package: '@test/healthy',
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['node'],
  };
}

const REQUEST_ID = '0b0e5d2e-6d0e-4f7e-9a53-0c6f4b0f5a11';

function authSink(): {
  readonly records: ObsRecord[];
  readonly log: ReturnType<typeof sinkLog>;
} {
  const records: ObsRecord[] = [];
  const sink = { emit: (record: ObsRecord) => void records.push(record) };
  const log = sinkLog((scope) =>
    createObservability(
      sink,
      {
        deploymentId: 'test-deployment',
        runtime: 'node',
        requestId: scope?.requestId ?? null,
        ...(scope?.plugin === undefined ? {} : { plugin: scope.plugin }),
      },
      { events: NODE_RUNTIME_EVENTS, reasonCodes: AUTH_REASON_CODES, routeTemplates: new Set() },
    ),
  );
  return { records, log };
}

function logs(records: readonly ObsRecord[]): Array<Record<string, unknown>> {
  return records.flatMap((record) => (record.kind === 'log' ? [{ ...record.record }] : []));
}

function counters(records: readonly ObsRecord[]): ObsRecord[] {
  return records.filter((record) => record.kind === 'counter');
}

describe('auth sink log', () => {
  const finishDetails = [
    'invalid_grant',
    'invalid_client',
    'invalid_request',
    'unauthorized_client',
    'unsupported_grant_type',
    'invalid_scope',
    'token_endpoint_error',
  ];

  it.each(finishDetails)('keeps finish detail %s as reason_code', (detail) => {
    const { records, log } = authSink();
    log({
      level: 'warn',
      event: 'auth.login.refused',
      requestId: REQUEST_ID,
      provider: 'oidc',
      reason: 'provider_error',
      detail,
    });
    expect(logs(records)[0]).toMatchObject({
      event: 'auth.login.refused',
      request_id: REQUEST_ID,
      reason_code: detail,
    });
  });

  it('counts finish failures in distinct series for each detail', () => {
    const { records, log } = authSink();
    for (const detail of finishDetails) {
      log({
        level: 'warn',
        event: 'auth.login.refused',
        provider: 'oidc',
        reason: 'provider_error',
        detail,
      });
    }
    expect(counters(records)).toEqual(
      finishDetails.map((detail) => ({
        kind: 'counter',
        name: 'pb.auth.login',
        labels: { provider: 'oidc', outcome: 'refused', detail },
        value: 1,
      })),
    );
    expect(
      encodeMetrics(counters(records), {
        service: 'package-broker',
        deploymentId: 'test-deployment',
        runtime: 'node',
      }),
    ).toMatchObject({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: finishDetails.map((detail) => ({
                name: 'pb.auth.login',
                sum: {
                  dataPoints: [
                    {
                      attributes: expect.arrayContaining([
                        { key: 'detail', value: { stringValue: detail } },
                      ]),
                    },
                  ],
                },
              })),
            },
          ],
        },
      ],
    });
  });

  it.each([
    ['provider_error', 'unregistered_detail'],
    ['provider_error', { secret: 'private_detail' }],
    ['provider_error', 'discovery_failed'],
    ['invalid_token', 'invalid_grant'],
  ])('omits inapplicable metric details for reason %s and detail %j', (reason, detail) => {
    const { records, log } = authSink();
    log({
      level: 'warn',
      event: 'auth.login.refused',
      provider: 'oidc',
      reason,
      detail,
    });
    expect(counters(records)).toEqual([
      {
        kind: 'counter',
        name: 'pb.auth.login',
        labels: { provider: 'oidc', outcome: 'refused' },
        value: 1,
      },
    ]);
  });

  it('only forwards reasons from the core auth reason set', () => {
    expectTypeOf(registeredAuthReason).returns.toEqualTypeOf<AuthReasonCode | undefined>();
    expectTypeOf<string>().not.toExtend<AuthReasonCode>();
  });

  it('23: an SSO start failure keeps its detail as reason_code', () => {
    const { records, log } = authSink();
    log({
      level: 'warn',
      event: 'auth.login.refused',
      requestId: REQUEST_ID,
      provider: 'oidc',
      reason: 'provider_error',
      detail: 'discovery_failed',
    });
    expect(logs(records)[0]).toMatchObject({
      event: 'auth.login.refused',
      request_id: REQUEST_ID,
      reason_code: 'discovery_failed',
    });
  });

  it('24: reason is used when detail is null, and an unregistered value only drops the field', () => {
    const { records, log } = authSink();
    log({
      level: 'warn',
      event: 'auth.login.refused',
      requestId: REQUEST_ID,
      reason: 'not_invited',
      detail: null,
    });
    log({
      level: 'warn',
      event: 'auth.login.refused',
      requestId: REQUEST_ID,
      reason: 'free_text',
    });
    const [first, second] = logs(records);
    expect(first).toMatchObject({ reason_code: 'not_invited' });
    expect(second).toMatchObject({ event: 'auth.login.refused', request_id: REQUEST_ID });
    expect(second).not.toHaveProperty('reason_code');
    expect(JSON.stringify(records)).not.toContain('free_text');
  });

  it('25: pluginId becomes the plugin scope and an unregistered hook code is dropped', () => {
    const { records, log } = authSink();
    log({ level: 'warn', event: 'auth.hook.denied', pluginId: 'sso-gate', code: 'free_text' });
    expect(logs(records)[0]).toMatchObject({ event: 'auth.hook.denied', plugin: 'sso-gate' });
    expect(logs(records)[0]).not.toHaveProperty('reason_code');
  });

  it('26: login records count by provider and outcome; userId and sessionId stay out', () => {
    const { records, log } = authSink();
    log({
      level: 'info',
      event: 'auth.login.succeeded',
      requestId: REQUEST_ID,
      provider: 'oidc',
      userId: 'user-1',
      sessionId: 'session-1',
    });
    log({ level: 'warn', event: 'auth.login.refused', requestId: REQUEST_ID, provider: 'oidc' });
    expect(counters(records)).toEqual([
      {
        kind: 'counter',
        name: 'pb.auth.login',
        labels: { provider: 'oidc', outcome: 'succeeded' },
        value: 1,
      },
      {
        kind: 'counter',
        name: 'pb.auth.login',
        labels: { provider: 'oidc', outcome: 'refused' },
        value: 1,
      },
    ]);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('user-1');
    expect(serialized).not.toContain('session-1');
  });

  it('27: request_id is read in snake case too, and an invalid request id falls back to none', () => {
    const { records, log } = authSink();
    log({ level: 'info', event: 'auth.reauth.succeeded', request_id: REQUEST_ID });
    log({ level: 'info', event: 'auth.reauth.succeeded', requestId: 'not a uuid' });
    const [first, second] = logs(records);
    expect(first).toMatchObject({ request_id: REQUEST_ID });
    expect(second).toMatchObject({ request_id: null });
  });

  it('28: AUTH_EVENTS covers every auth event core emits', async () => {
    const coreSource = join(
      dirname(require.resolve('@package-broker/db-sqlite/package.json')),
      '..',
      'core',
      'src',
    );
    const emitted = new Set<string>();
    for (const directory of ['auth', 'authz']) {
      for (const name of await readdir(join(coreSource, directory))) {
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
        const text = await readFile(join(coreSource, directory, name), 'utf8');
        for (const match of text.matchAll(/event: '(auth\.[a-z0-9_.]+)'/g))
          emitted.add(match[1] ?? '');
        for (const match of text.matchAll(/log\('(token_touch_failed)'\)/g))
          emitted.add(match[1] ?? '');
      }
    }
    expect(emitted.size).toBeGreaterThan(8);
    expect([...emitted].filter((event) => !AUTH_EVENTS.includes(event as never))).toEqual([]);
    expect(AUTH_EVENTS).toContain('token_touch_failed');
  });
});

describe('startNode', () => {
  let directory: string;
  const running: NodeBroker[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-startup-'));
    recorded.closes.length = 0;
    recorded.events.length = 0;
    recorded.usesAfterClose = 0;
  });

  afterEach(async () => {
    for (const broker of running.splice(0)) await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  function databasePath(name = 'broker.sqlite'): string {
    return join(directory, name);
  }

  async function initSource(sql?: string): Promise<MigrationSource> {
    const text = sql ?? (await readFile(join(migrationsDirectory, '0001_init.sql'), 'utf8'));
    return loadMigrationSource('core', '0001_init.sql', text);
  }

  async function listen(broker: NodeBroker): Promise<string> {
    running.push(broker);
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
    const { port } = broker.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it.each([undefined, false])(
    'MCP disabled (%s) matches the unknown core route',
    async (enabled) => {
      const broker = await startNode({
        plugins: [],
        migrations: [await initSource()],
        ...(enabled === undefined ? {} : { mcp: { enabled } }),
        env: {
          PB_SQLITE_PATH: databasePath(),
          PB_ORG_SLUG: 'acme',
          PB_ORG_NAME: 'Acme',
          PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          PB_PUBLIC_URL: 'http://127.0.0.1',
        },
        log: () => undefined,
      });
      running.push(broker);
      const kernel = await broker.ready();
      const snapshot = async (path: string) => {
        const response = await kernel.fetch(
          new Request(`http://127.0.0.1${path}`, { method: 'POST' }),
        );
        const body = (await response.json()) as { error: { requestId?: string } };
        delete body.error.requestId;
        const headers = Object.fromEntries(response.headers);
        delete headers['x-request-id'];
        return { status: response.status, body, headers };
      };
      const missing = await snapshot('/_pb/unknown');
      expect(missing.status).toBe(404);
      expect(await snapshot('/_pb/mcp')).toEqual(missing);
    },
  );

  it('MCP enabled initializes with a read token and dispatches the runtime tools', async () => {
    const key = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const path = databasePath();
    const broker = await startNode({
      plugins: [],
      migrations: [await initSource()],
      mcp: { enabled: true },
      env: {
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: key,
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
      log: () => undefined,
    });
    running.push(broker);
    const opened = openBetterSqliteExecutor(path);
    let token: string;
    try {
      const executor = opened.executor;
      const org = await createOrganizationBootstrap(executor).findSingleton();
      const orgId = org!.id;
      const selector = 'abcdefghijkl';
      token = formatToken('svc', selector, new Uint8Array(32).fill(7));
      const hash = await hashToken(createKeyring([parseMasterKey(key, 'PB_MASTER_KEY')]), 1, token);
      await executor.batch([
        {
          sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
          params: ['mcp-user', orgId, 'reader@example.test'],
        },
        {
          sql: 'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
          params: ['mcp-service', orgId, 'MCP reader', 'mcp-user'],
        },
        {
          sql: `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name,
          scopes_json, read_only, service_principal_id, expires_at, project_mode)
          VALUES (?, ?, 'svc', ?, ?, 1, 'MCP reader', '["read"]', 1, ?, ?, 'all')`,
          params: [
            'mcp-token',
            orgId,
            selector,
            hash,
            'mcp-service',
            new Date(Date.now() + 3600000).toISOString(),
          ],
        },
      ]);
    } finally {
      await opened.close();
    }
    const kernel = await broker.ready();
    const initialized = await kernel.fetch(
      new Request('http://127.0.0.1/_pb/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        }),
      }),
    );
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { capabilities: { tools: {} } },
    });
    const call = async (method: string, params: unknown = {}) =>
      kernel.fetch(
        new Request('http://127.0.0.1/_pb/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
        }),
      );
    const listed = await call('tools/list');
    expect(await listed.json()).toMatchObject({
      result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'whoami' })]) },
    });
    const rest = await kernel.fetch(
      new Request('http://127.0.0.1/_pb/me', { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(rest.status).toBe(200);
    const tool = await call('tools/call', { name: 'whoami' });
    expect(await tool.json()).toMatchObject({
      result: { content: [{ type: 'text', text: await rest.text() }] },
    });
  });

  it('1: migrates, bootstraps, resolves ready, and close() closes the database', async () => {
    const path = databasePath();
    const broker = await startNode({
      plugins: [healthyPlugin()],
      migrations: [await initSource()],
      env: {
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
      log: (event) => {
        recorded.events.push(event);
      },
    });

    const base = await listen(broker);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });

    await broker.close();

    expect(recorded.closes).toEqual([path]);
    expect(
      recorded.events.some(
        (event) => event['level'] === 'info' && event['id'] === 'core:0001_init',
      ),
    ).toBe(true);
    await expect(canTakeWriteLock(path)).resolves.toBe(true);
  });

  it('2: PB_MIGRATE=off leaves a fresh database not ready', async () => {
    const path = databasePath();
    const broker = await startNode({
      plugins: [healthyPlugin()],
      migrations: [],
      env: {
        PB_SQLITE_PATH: path,
        PB_MIGRATE: 'off',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
    });

    const base = await listen(broker);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await errorCode(ready)).toBe('not_ready');
  });

  it('3: an edited applied migration rejects with MigrationChecksumError and closes the database', async () => {
    const path = databasePath();
    const first = await startNode({
      plugins: [],
      migrations: [await initSource()],
      env: {
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
    });
    await first.close();
    recorded.closes.length = 0;

    const edited = await initSource(`${(await initSource()).sql}\n-- edited\n`);
    const failure = await rejection(
      startNode({
        plugins: [],
        migrations: [edited],
        env: {
          PB_SQLITE_PATH: path,
          PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          PB_PUBLIC_URL: 'http://127.0.0.1',
        },
      }),
    );

    expect(failure).toBeInstanceOf(MigrationChecksumError);
    expect(recorded.closes).toEqual([path]);
    await expect(canTakeWriteLock(path)).resolves.toBe(true);
  });

  it('4: a restart with another slug rejects AlreadyBootstrappedError', async () => {
    const path = databasePath();
    const first = await startNode({
      plugins: [],
      migrations: [await initSource()],
      env: {
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
    });
    await first.close();
    recorded.closes.length = 0;

    const failure = await rejection(
      startNode({
        plugins: [],
        migrations: [await initSource()],
        env: {
          PB_SQLITE_PATH: path,
          PB_ORG_SLUG: 'other',
          PB_ORG_NAME: 'Other',
          PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          PB_PUBLIC_URL: 'http://127.0.0.1',
        },
      }),
    );

    expect(failure).toBeInstanceOf(AlreadyBootstrappedError);
    expect((failure as AlreadyBootstrappedError).slug).toBe('acme');
    expect(recorded.closes).toEqual([path]);
  });

  it('5: a plugin init failure rejects before listening and closes the database once', async () => {
    const path = databasePath();
    const listenSpy = vi.spyOn(Server.prototype, 'listen');
    try {
      const broken: PluginDefinition = {
        id: 'broken',
        package: '@test/broken',
        apiVersion: SUPPORTED_PLUGIN_API[0],
        platforms: ['node'],
        init() {
          throw new Error('init failed');
        },
      };

      const failure = await rejection(
        startNode({
          plugins: [broken],
          migrations: [await initSource()],
          env: {
            PB_SQLITE_PATH: path,
            PB_ORG_SLUG: 'acme',
            PB_ORG_NAME: 'Acme',
            PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
            PB_PUBLIC_URL: 'http://127.0.0.1',
          },
        }),
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('init failed');
      expect(listenSpy).not.toHaveBeenCalled();
      expect(recorded.closes).toEqual([path]);
      await expect(canTakeWriteLock(path)).resolves.toBe(true);
    } finally {
      listenSpy.mockRestore();
    }
  });

  it('6: rejects when only one organization variable is set', async () => {
    const path = databasePath();
    const failure = await rejection(
      startNode({
        plugins: [],
        migrations: [await initSource()],
        env: {
          PB_SQLITE_PATH: path,
          PB_ORG_SLUG: 'acme',
          PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          PB_PUBLIC_URL: 'http://127.0.0.1',
        },
      }),
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('PB_ORG_SLUG and PB_ORG_NAME must be set together');
    expect(recorded.closes).toEqual([path]);
  });

  describe('platform ports', () => {
    const MASTER = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const ports: PlatformPortConfig = {
      blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1_048_576 },
      cache: { adapter: 'lru', maxBytes: 1_048_576 },
      jobs: { adapter: 'database', maxRunning: 1 },
      observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
    };

    let blobRoot = '';

    beforeEach(async () => {
      blobRoot = join(await realpath(directory), 'blobs');
      seen = {};
    });

    function capture(): { lines: () => Record<string, unknown>[]; stream: StdioStream } {
      const chunks: string[] = [];
      return {
        lines: () => chunks.flatMap((chunk) => chunk.split('\n').filter(Boolean)).map(parseLine),
        stream: {
          write(chunk: string) {
            chunks.push(chunk);
            return true;
          },
          on: () => undefined,
        },
      };
    }

    function parseLine(line: string): Record<string, unknown> {
      return JSON.parse(line) as Record<string, unknown>;
    }

    function env(path: string, extra: Record<string, string> = {}): Record<string, string> {
      return {
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: MASTER,
        PB_PUBLIC_URL: 'http://127.0.0.1',
        PB_BLOB_ROOT: blobRoot,
        DEPLOYMENT_ID: 'test-deployment',
        ...extra,
      };
    }

    let seen: { blob?: boolean; cache?: boolean; platform?: boolean; handler?: PluginPorts } = {};

    function probePlugin(): PluginDefinition {
      return {
        id: 'worker',
        package: '@test/worker',
        apiVersion: SUPPORTED_PLUGIN_API[0],
        platforms: ['node'],
        register(registry) {
          registry.job({
            name: 'x',
            version: 1,
            validate: (input: unknown) => input,
            handler: async (_payload, context) => {
              seen.handler = context.ports;
              context.observability.log({ level: 'info', event: 'http.error' });
              throw new Error('handler secret-value');
            },
          });
          registry.route({
            method: 'GET',
            path: '/probe/run',
            permission: null,
            handler: async (ctx) => {
              seen.platform = ctx.ports.platform !== undefined;
              seen.blob = ctx.ports.platform?.blob !== undefined;
              seen.cache = ctx.ports.platform?.cache !== undefined;
              const enqueued =
                ctx.org === null || ctx.ports.platform === undefined
                  ? null
                  : await ctx.ports.platform.jobs.enqueue(
                      ctx.org,
                      'worker:x:v1',
                      {},
                      {
                        idempotencyKey: 'probe-1',
                      },
                    );
              return Response.json({ enqueued: enqueued !== null });
            },
          });
        },
      };
    }

    async function start(
      extraEnv: Record<string, string>,
      platformPorts: PlatformPortConfig | null | undefined,
      extra: Partial<StartOptions> = {},
    ): Promise<NodeBroker> {
      return startNode({
        plugins: [probePlugin()],
        migrations: [await initSource()],
        env: env(databasePath(), extraEnv),
        ...(platformPorts === undefined ? {} : { platformPorts }),
        stdout: capture().stream,
        stderr: capture().stream,
        ...extra,
      });
    }

    it('7: builds blob, cache, jobs and observability and scopes them per plugin on both paths', async () => {
      const out = capture();
      const err = capture();
      const broker = await start({}, ports, { stdout: out.stream, stderr: err.stream });
      const base = await listen(broker);

      const response = await fetch(`${base}/probe/run`);
      expect(await response.json()).toEqual({ enqueued: true });
      expect(seen).toMatchObject({ platform: true, blob: true, cache: true });

      await vi.waitFor(
        () => {
          expect(err.lines().some((line) => line['event'] === 'job.handler_failed')).toBe(true);
        },
        { timeout: 5000, interval: 50 },
      );
      expect(seen.handler?.platform).toBeDefined();
      const all = [...out.lines(), ...err.lines()];
      const pluginRecord = all.find((line) => line['event'] === 'http.error');
      expect(pluginRecord).toMatchObject({ plugin: 'worker', deployment_id: 'test-deployment' });
      expect(pluginRecord?.['job_id']).toEqual(expect.any(String));
      const runnerRecord = err.lines().find((line) => line['event'] === 'job.handler_failed');
      expect(runnerRecord).toMatchObject({
        job_id: pluginRecord?.['job_id'],
        error_name: 'Error',
        deployment_id: 'test-deployment',
      });
      expect(JSON.stringify(all)).not.toContain('secret-value');
    });

    it('8: platformPorts omitted or null leaves platform services disabled', async () => {
      for (const platformPorts of [undefined, null] as const) {
        const broker = await startNode({
          plugins: [
            {
              ...healthyPlugin(),
              register: (registry) => {
                registry.route({
                  method: 'GET',
                  path: '/probe/platform',
                  permission: null,
                  handler: (ctx) => Response.json({ platform: ctx.ports.platform !== undefined }),
                });
              },
            },
          ],
          migrations: [await initSource()],
          env: { ...env(databasePath(`n-${String(platformPorts)}.sqlite`)), DEPLOYMENT_ID: '' },
          ...(platformPorts === undefined ? {} : { platformPorts }),
        });
        const base = await listen(broker);
        expect(await (await fetch(`${base}/probe/platform`)).json()).toEqual({ platform: false });
        await broker.close();
      }
    });

    it('9: a missing or unusable configured service fails startup and closes the database', async () => {
      const s3Blob = {
        adapter: 's3',
        endpointEnv: 'PB_S3_ENDPOINT',
        regionEnv: 'PB_S3_REGION',
        bucketEnv: 'PB_S3_BUCKET',
        accessKeyIdEnv: 'PB_S3_KEY',
        secretAccessKeyEnv: 'PB_S3_SECRET',
        maxBytes: 1_048_576,
      } as const;
      const blank = (name: string): Record<string, string> => ({ [name]: '' });
      const cases: Array<[string, Record<string, string>, PlatformPortConfig, string]> = [
        ['blob root unset', blank('PB_BLOB_ROOT'), ports, 'PB_BLOB_ROOT'],
        ['deployment id unset', blank('DEPLOYMENT_ID'), ports, 'DEPLOYMENT_ID'],
        ['deployment id invalid', { DEPLOYMENT_ID: 'has space' }, ports, 'DEPLOYMENT_ID'],
        ['s3 variables unset', {}, { ...ports, blob: s3Blob }, 'PB_S3_ENDPOINT'],
        [
          's3 session token variable unset',
          {
            PB_S3_ENDPOINT: 'https://s3.example.com',
            PB_S3_REGION: 'eu-west-1',
            PB_S3_BUCKET: 'bucket',
            PB_S3_KEY: 'key',
            PB_S3_SECRET: 'secret',
          },
          { ...ports, blob: { ...s3Blob, sessionTokenEnv: 'PB_S3_TOKEN' } },
          'PB_S3_TOKEN',
        ],
        [
          's3 session token variable empty',
          {
            PB_S3_ENDPOINT: 'https://s3.example.com',
            PB_S3_REGION: 'eu-west-1',
            PB_S3_BUCKET: 'bucket',
            PB_S3_KEY: 'key',
            PB_S3_SECRET: 'secret',
            PB_S3_TOKEN: '',
          },
          { ...ports, blob: { ...s3Blob, sessionTokenEnv: 'PB_S3_TOKEN' } },
          'PB_S3_TOKEN',
        ],
        ['stanza for another target', {}, { ...ports, cache: { adapter: 'cache-api' } }, 'cache'],
      ];
      for (const [name, extra, stanza, variable] of cases) {
        recorded.closes.length = 0;
        const path = databasePath(`m-${name.replaceAll(' ', '-')}.sqlite`);
        const failure = await rejection(
          startNode({
            plugins: [probePlugin()],
            migrations: [await initSource()],
            env: env(path, extra),
            platformPorts: stanza,
            stdout: capture().stream,
            stderr: capture().stream,
          }),
        );
        expect(failure, name).toBeInstanceOf(StartupConfigError);
        expect((failure as StartupConfigError).message, name).toContain(variable);
        expect(recorded.closes, name).toEqual([path]);
      }
    });

    describe('inbound traceparent', () => {
      const TRACE_ID = 'ab'.repeat(16);
      const TRACEPARENT = `00-${TRACE_ID}-${'cd'.repeat(8)}-01`;

      async function traceIds(observability: StartOptions['observability']): Promise<unknown[]> {
        const out = capture();
        const err = capture();
        const broker = await start({}, ports, {
          stdout: out.stream,
          stderr: err.stream,
          ...(observability === undefined ? {} : { observability }),
        });
        const base = await listen(broker);
        await fetch(`${base}/nope`, { headers: { traceparent: TRACEPARENT } });
        const ids = [...out.lines(), ...err.lines()]
          .filter((line) => line['event'] === 'http.request')
          .map((line) => line['trace_id']);
        expect(ids.length).toBeGreaterThan(0);
        return ids;
      }

      it('ignores the header by default', async () => {
        for (const id of await traceIds(undefined)) expect(id).not.toBe(TRACE_ID);
      });

      it('ignores the header when the flag is false', async () => {
        for (const id of await traceIds({ trustInboundTraceparent: false })) {
          expect(id).not.toBe(TRACE_ID);
        }
      });

      it('adopts the header trace id when the flag is true', async () => {
        for (const id of await traceIds({ trustInboundTraceparent: true })) {
          expect(id).toBe(TRACE_ID);
        }
      });

      it('fails startup on a non-boolean flag', async () => {
        const failure = await rejection(
          start({}, ports, {
            observability: {
              trustInboundTraceparent: 'yes',
            } as unknown as StartOptions['observability'],
          }),
        );
        expect(failure).toBeInstanceOf(StartupConfigError);
        expect((failure as StartupConfigError).message).toContain('observability');
        expect((failure as StartupConfigError).message).not.toContain('yes');
      });

      it('fails startup on an unknown observability key', async () => {
        const failure = await rejection(
          start({}, ports, {
            observability: { sampleRate: true } as unknown as StartOptions['observability'],
          }),
        );
        expect(failure).toBeInstanceOf(StartupConfigError);
        expect((failure as StartupConfigError).message).toContain('observability');
      });
    });

    it('10: an unusable blob root fails startup', async () => {
      const file = join(directory, 'not-a-directory');
      await writeFile(file, 'x');
      const failure = await rejection(start({ PB_BLOB_ROOT: file }, ports));
      expect(failure).toBeInstanceOf(StartupConfigError);
      expect((failure as StartupConfigError).variable).toBe('PB_BLOB_ROOT');
    });

    it('11: flushes OTLP on a 1 s timer and before the database closes', async () => {
      const calls: Array<{ url: string; closesAtCall: number }> = [];
      const fetchImpl = (url: string | Request | URL): Promise<Response> => {
        calls.push({ url: String(url), closesAtCall: recorded.closes.length });
        return Promise.resolve(new Response('{}', { status: 200 }));
      };
      const withOtlp: PlatformPortConfig = {
        ...ports,
        observability: {
          adapter: 'stdio',
          deploymentIdEnv: 'DEPLOYMENT_ID',
          endpointEnv: 'PB_OTLP_ENDPOINT',
          headersEnv: 'PB_OTLP_HEADERS',
        },
      };
      const broker = await start(
        { PB_OTLP_ENDPOINT: 'http://127.0.0.1:4318', PB_OTLP_HEADERS: '{"x-token":"abc"}' },
        withOtlp,
        { fetch: fetchImpl, stdout: capture().stream, stderr: capture().stream },
      );
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), {
        timeout: 4000,
        interval: 50,
      });
      expect(calls[0]?.url.startsWith('http://127.0.0.1:4318/v1/')).toBe(true);

      const base = await listen(broker);
      expect((await fetch(`${base}/health/ready`)).status).toBe(200);
      const before = calls.length;
      await broker.close();

      expect(calls.length).toBeGreaterThan(before);
      expect(calls.slice(before).every((call) => call.closesAtCall === 0)).toBe(true);
      expect(calls.every((call) => call.closesAtCall === 0)).toBe(true);
      expect(recorded.closes).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(recorded.usesAfterClose).toBe(0);
    });

    it('13: the flush timer and the job loop are gone after close()', async () => {
      const calls: string[] = [];
      const fetchImpl = (url: string | Request | URL): Promise<Response> => {
        calls.push(String(url));
        return Promise.resolve(new Response('{}', { status: 200 }));
      };
      const withOtlp: PlatformPortConfig = {
        ...ports,
        observability: {
          adapter: 'stdio',
          deploymentIdEnv: 'DEPLOYMENT_ID',
          endpointEnv: 'PB_OTLP_ENDPOINT',
        },
      };
      const broker = await start({ PB_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }, withOtlp, {
        fetch: fetchImpl,
        stdout: capture().stream,
        stderr: capture().stream,
      });
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), {
        timeout: 4000,
        interval: 50,
      });
      await broker.close();
      const settled = calls.length;
      await new Promise((resolve) => setTimeout(resolve, 2300));
      expect(calls.length).toBe(settled);
      expect(recorded.usesAfterClose).toBe(0);
    });

    async function allSources(): Promise<MigrationSource[]> {
      const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql'));
      return Promise.all(
        names
          .sort()
          .map(async (name) =>
            loadMigrationSource(
              'core',
              name,
              await readFile(join(migrationsDirectory, name), 'utf8'),
            ),
          ),
      );
    }

    async function refusedLogin(base: string): Promise<void> {
      const response = await fetch(`${base}/_pb/auth/local/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
        body: JSON.stringify({
          email: 'someone@example.com',
          password: 'hunter2-hunter2',
          code: '123456',
        }),
      });
      expect(response.status).toBe(401);
    }

    it('17: auth records go to the sink with no secret fields and never to the legacy log', async () => {
      const out = capture();
      const err = capture();
      const legacy: Array<Readonly<Record<string, unknown>>> = [];
      const broker = await start({}, ports, {
        migrations: await allSources(),
        stdout: out.stream,
        stderr: err.stream,
        log: (entry) => {
          legacy.push(entry);
        },
      });
      const base = await listen(broker);
      await refusedLogin(base);

      const all = [...out.lines(), ...err.lines()];
      const record = all.find((line) => line['event'] === 'auth.login.refused');
      expect(record).toMatchObject({
        level: 'info',
        deployment_id: 'test-deployment',
        runtime: 'node',
      });
      expect(record?.['request_id']).toEqual(expect.any(String));
      const serialized = JSON.stringify(all);
      for (const secret of ['someone@example.com', 'hunter2', '123456']) {
        expect(serialized).not.toContain(secret);
      }
      expect(legacy.some((entry) => String(entry['event'] ?? '').startsWith('auth.'))).toBe(false);
    });

    it('18: migrate output stays on the legacy log and is absent from the sink', async () => {
      const out = capture();
      const err = capture();
      const legacy: Array<Readonly<Record<string, unknown>>> = [];
      await start({}, ports, {
        stdout: out.stream,
        stderr: err.stream,
        log: (entry) => {
          legacy.push(entry);
        },
      });
      expect(legacy.some((entry) => entry['id'] === 'core:0001_init')).toBe(true);
      const sunk = JSON.stringify([...out.lines(), ...err.lines()]);
      expect(sunk).not.toContain('core:0001_init');
      expect(sunk).not.toContain('"holder"');
    });

    it('19: an auth record without telemetry still reaches the legacy log', async () => {
      const legacy: Array<Readonly<Record<string, unknown>>> = [];
      const broker = await start({}, null, {
        plugins: [healthyPlugin()],
        migrations: await allSources(),
        log: (entry) => {
          legacy.push(entry);
        },
      });
      const base = await listen(broker);
      await refusedLogin(base);
      expect(legacy.some((entry) => entry['event'] === 'auth.login.refused')).toBe(true);
    });

    it('20: close() reports a handler that never settles through the sink before the database closes', async () => {
      const out = capture();
      const err = capture();
      let started = false;
      const closesAtReport: number[] = [];
      const stuck: PluginDefinition = {
        id: 'stuck',
        package: '@test/stuck',
        apiVersion: SUPPORTED_PLUGIN_API[0],
        platforms: ['node'],
        register(registry) {
          registry.job({
            name: 'x',
            version: 1,
            validate: (input: unknown) => input,
            handler: () => {
              started = true;
              return new Promise<void>(() => undefined);
            },
          });
          registry.route({
            method: 'GET',
            path: '/stuck/run',
            permission: null,
            handler: async (ctx) => {
              if (ctx.org !== null && ctx.ports.platform !== undefined) {
                await ctx.ports.platform.jobs.enqueue(
                  ctx.org,
                  'stuck:x:v1',
                  {},
                  { idempotencyKey: 'stuck-1' },
                );
              }
              return Response.json({});
            },
          });
        },
      };
      const stderr: StdioStream = {
        write(chunk: string) {
          if (chunk.includes('shutdown.jobs_abandoned'))
            closesAtReport.push(recorded.closes.length);
          return err.stream.write(chunk);
        },
        on: () => undefined,
      };
      const broker = await startNode({
        plugins: [stuck],
        migrations: [await initSource()],
        env: env(databasePath()),
        platformPorts: ports,
        stdout: out.stream,
        stderr,
      });
      const base = await listen(broker);
      await fetch(`${base}/stuck/run`);
      await vi.waitFor(() => expect(started).toBe(true), { timeout: 5000, interval: 25 });

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const closing = broker.close();
        await vi.advanceTimersByTimeAsync(JOB_DRAIN_MS);
        await closing;
      } finally {
        vi.useRealTimers();
      }

      expect(closesAtReport).toEqual([0]);
      expect(recorded.closes).toHaveLength(1);
      const record = err.lines().find((line) => line['event'] === 'shutdown.jobs_abandoned');
      expect(record).toMatchObject({ level: 'warn', deployment_id: 'test-deployment' });
      const counter = out
        .lines()
        .find((line) => line['name'] === 'pb.jobs.abandoned' && line['kind'] === 'counter');
      expect(counter).toMatchObject({ value: 1 });
    });

    it('21: a clean close reports nothing abandoned', async () => {
      const out = capture();
      const err = capture();
      const broker = await start({}, ports, { stdout: out.stream, stderr: err.stream });
      await broker.close();
      const all = [...out.lines(), ...err.lines()];
      expect(all.some((line) => line['event'] === 'shutdown.jobs_abandoned')).toBe(false);
      expect(all.some((line) => line['name'] === 'pb.jobs.abandoned')).toBe(false);
    });

    it('22: an init failure after telemetry is up is reported through the sink by error name only', async () => {
      const out = capture();
      const err = capture();
      const failure = await rejection(
        startNode({
          plugins: [healthyPlugin()],
          migrations: [await initSource()],
          env: { ...env(databasePath()), PB_ORG_NAME: undefined },
          platformPorts: ports,
          stdout: out.stream,
          stderr: err.stream,
        }),
      );
      expect(failure).toBeInstanceOf(Error);
      const all = [...out.lines(), ...err.lines()];
      const record = all.find((line) => line['event'] === 'startup.failed');
      expect(record).toMatchObject({
        level: 'error',
        error_name: 'Error',
        deployment_id: 'test-deployment',
      });
      expect(JSON.stringify(all)).not.toContain('PB_ORG_SLUG');
    });

    it('14: a keyring error leaves no blob staging directory behind', async () => {
      const failure = await rejection(start({ PB_MASTER_KEY: 'not-a-key' }, ports));
      expect(failure).toBeInstanceOf(Error);
      expect(await pathExists(join(blobRoot, '.staging'))).toBe(false);
      expect(await pathExists(blobRoot)).toBe(false);
    });

    it('15: a relative or non-normalized blob root fails startup with a path-free reason', async () => {
      for (const root of ['relative/blobs', `${blobRoot}/../blobs`]) {
        const failure = await rejection(start({ PB_BLOB_ROOT: root }, ports));
        expect(failure).toBeInstanceOf(StartupConfigError);
        expect((failure as StartupConfigError).variable).toBe('PB_BLOB_ROOT');
        expect((failure as Error).message).toContain('must be a normalized absolute path');
        expect((failure as Error).message).not.toContain(root);
      }
    });

    it('16: invalid PB_OTLP_HEADERS names the variable and never echoes the value', async () => {
      const withOtlp: PlatformPortConfig = {
        ...ports,
        observability: {
          adapter: 'stdio',
          deploymentIdEnv: 'DEPLOYMENT_ID',
          endpointEnv: 'PB_OTLP_ENDPOINT',
          headersEnv: 'PB_OTLP_HEADERS',
        },
      };
      const failure = await rejection(
        start(
          {
            PB_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
            PB_OTLP_HEADERS: '{"x-token": secret-value',
          },
          withOtlp,
        ),
      );
      expect(failure).toBeInstanceOf(StartupConfigError);
      expect((failure as StartupConfigError).variable).toBe('PB_OTLP_HEADERS');
      expect((failure as Error).message).not.toContain('secret-value');
    });

    it('12: a bad OTLP configuration fails startup without leaking the value', async () => {
      const withOtlp: PlatformPortConfig = {
        ...ports,
        observability: {
          adapter: 'stdio',
          deploymentIdEnv: 'DEPLOYMENT_ID',
          endpointEnv: 'PB_OTLP_ENDPOINT',
        },
      };
      const failure = await rejection(
        start({ PB_OTLP_ENDPOINT: 'http://collector.example.com/secret-path' }, withOtlp),
      );
      expect(failure).toBeInstanceOf(StartupConfigError);
      expect((failure as Error).message).not.toContain('secret-path');
    });
  });
});

describe('blob purge timing', () => {
  const invalidTimeouts = [900_000, 90_001, 999, 1500.5];
  it.each(invalidTimeouts)('refuses delete timeout %s as misconfigured', (timeout) => {
    expect(() => blobPurgeTiming(timeout, 900)).toThrow(StartupConfigError);
    expect(() => blobPurgeTiming(timeout, 900)).toThrow('blob.deleteTimeoutMs');
  });

  it('accepts the shipped purge timing', () => {
    expect(blobPurgeTiming(BLOB_DELETE_TIMEOUT_MS, BLOB_PURGE_LEASE_SECONDS)).toEqual({
      deleteTimeoutMs: 30_000,
      leaseMs: 900_000,
    });
  });

  it.each([...invalidTimeouts, BLOB_DELETE_TIMEOUT_MS, 1000, 90_000])(
    'agrees with lifecycle validation for delete timeout %s',
    (deleteTimeoutMs) => {
      const metadata = {
        softDelete: async () => false,
        claimPurge: async () => null,
        canStartRemove: async () => false,
        markDeleted: async () => false,
        cancelPurge: async () => false,
        unschedule: async () => false,
        scheduleOrphan: async () => false,
        listDue: async () => [],
      };
      const lifecycle = () =>
        createBlobLifecycle({
          metadata,
          store: {} as ByteStore,
          observability: { counter() {}, histogram() {}, log() {} },
          deleteTimeoutMs,
          leaseMs: BLOB_PURGE_LEASE_SECONDS * 1000,
        });
      const timing = () => blobPurgeTiming(deleteTimeoutMs, BLOB_PURGE_LEASE_SECONDS);
      if (invalidTimeouts.includes(deleteTimeoutMs)) {
        expect(lifecycle).toThrow(TypeError);
        expect(timing).toThrow(StartupConfigError);
      } else {
        expect(lifecycle).not.toThrow();
        expect(timing).not.toThrow();
      }
    },
  );
});

it.each([undefined, true, false])(
  'vulnerability startup switch %s controls scheduler, old work and API projection',
  async (enabled) => {
    const kernelModule = await import('@package-broker/core/kernel/kernel');
    const guarded = await import('./sources/guarded-fetch.js');
    const { discoveredMigrations } =
      await import('@package-broker/db-sqlite/testing/migrated-database');
    const { createOrganizationBootstrap } =
      await import('@package-broker/db-sqlite/repositories/organization');
    const { createJobRepository } = await import('@package-broker/db-sqlite/repositories/job');
    const { orgContext } = await import('@package-broker/core/db/port');
    const { ulid } = await import('@package-broker/core/ids');
    const loopModule = await import('./jobs/loop.js');
    let schedulerOffset = 0;
    const actualLoop = loopModule.createJobLoop;
    vi.spyOn(loopModule, 'createJobLoop').mockImplementation((input) =>
      actualLoop({ ...input, clock: { now: () => new Date(Date.now() + schedulerOffset) } }),
    );
    const actualKernel = kernelModule.createKernel;
    vi.spyOn(kernelModule, 'createKernel').mockImplementation((options) =>
      actualKernel({
        ...options,
        authorization: {
          authorize: async () => ({
            allow: true,
            principal: { kind: 'user', id: 'reader' },
            projectId: null,
          }),
        },
      }),
    );
    let unavailable = true;
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.osv.dev/v1/querybatch');
      expect(await new Request(input, init).json()).toEqual({
        queries: [{ package: { ecosystem: 'npm', name: 'public-control' }, version: '1.2.3' }],
      });
      return unavailable
        ? new Response(null, { status: 503 })
        : Response.json({ results: [{ vulns: [{ id: 'GHSA-test' }] }] });
    });
    vi.spyOn(guarded, 'createGuardedFetch').mockReturnValue(transport);
    const directory = await realpath(await mkdtemp(join(process.cwd(), '.pb-vulnerability-')));
    let broker: Awaited<ReturnType<typeof startNode>> | undefined;
    let database: ReturnType<typeof openBetterSqliteExecutor> | undefined;
    try {
      const path = join(directory, 'broker.sqlite');
      broker = await startNode({
        plugins: [],
        migrations: await discoveredMigrations(),
        ...(enabled === undefined ? {} : { vulnerability: { enabled } }),
        env: {
          PB_SQLITE_PATH: path,
          PB_BLOB_ROOT: join(directory, 'blobs'),
          PB_ORG_SLUG: 'vulnerability',
          PB_ORG_NAME: 'Vulnerability',
          PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          PB_PUBLIC_URL: 'https://broker.test',
          DEPLOYMENT_ID: 'vulnerability-test',
        },
        platformPorts: {
          blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1024 },
          cache: { adapter: 'lru', maxBytes: 1024 },
          jobs: { adapter: 'database', maxRunning: 1 },
          observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
        },
        stdout: { write: () => true, on: () => undefined },
        stderr: { write: () => true, on: () => undefined },
      });
      database = openBetterSqliteExecutor(path);
      const { executor } = database;
      const identity = await createOrganizationBootstrap(executor).findSingleton();
      const org = orgContext(identity!.id);
      const source = ulid(),
        pkg = ulid(),
        version = ulid();
      await executor.batch([
        {
          sql: "INSERT INTO source (id,org_id,name,ecosystem,type,url,config_json) VALUES (?,?,'public','npm','npmjs_proxy','https://registry.npmjs.org','{}')",
          params: [source, org.orgId],
        },
        {
          sql: "INSERT INTO package (id,org_id,source_id,ecosystem,name) VALUES (?,?,?,'npm','public-control')",
          params: [pkg, org.orgId, source],
        },
        {
          sql: "INSERT INTO version (id,org_id,package_id,version,version_normalized,published_at,published_at_basis,metadata_json) VALUES (?,?,?,'1.2.3','1.2.3',?,'upstream','{}')",
          params: [version, org.orgId, pkg, new Date().toISOString()],
        },
      ]);
      const kernel = await broker.ready();
      const definition = kernel.registration.jobs.find(
        (job) => job.qualifiedName === 'core:vulnerability-sync:v1',
      );
      expect(definition?.definition.schedule).toEqual(
        enabled === false ? undefined : { everySeconds: 300 },
      );
      const read = async () => {
        const response = await kernel.fetch(
          new Request(`https://broker.test/_pb/packages/${pkg}/versions`),
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          items: {
            vulnerability: { status: string; reason: string | null; advisoryCount: number };
          }[];
        };
        return body.items[0]!.vulnerability;
      };
      expect(await read()).toMatchObject({
        status: 'unknown',
        reason: enabled === false ? 'disabled' : 'pending',
      });
      expect(transport).not.toHaveBeenCalled();
      const jobs = createJobRepository(executor);
      const enqueue = () =>
        jobs.enqueue(org, {
          id: ulid(),
          type: 'core:vulnerability-sync:v1',
          payloadJson: '{}',
          idempotencyKey: ulid(),
          maxAttempts: 3,
          projectId: null,
          initiatorTokenId: null,
          resourceKey: null,
          runAt: null,
        });
      if (enabled === false) {
        await executor.batch([
          {
            sql: "INSERT INTO vulnerability_result (org_id,version_id,package_id,ecosystem,package_key,version,query_version,mapping_version,assessment,fetched_at,attempted_at,next_attempt_at,generation) VALUES (?,?,?,'npm','public-control','1.2.3','1.2.3',1,'affected',?,?,?,0)",
            params: [
              org.orgId,
              version,
              pkg,
              new Date().toISOString(),
              new Date().toISOString(),
              new Date().toISOString(),
            ],
          },
        ]);
        expect(await read()).toEqual({
          status: 'unknown',
          reason: 'disabled',
          source: null,
          fetchedAt: null,
          lastKnownStatus: null,
          advisoryCount: 0,
          advisories: [],
          detailsComplete: false,
          advisoriesTruncated: false,
        });
        const old = await enqueue();
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect((await jobs.status(org, old.id))?.state).not.toBe('succeeded');
        expect(transport).not.toHaveBeenCalled();
        expect(
          await executor.all({
            sql: "SELECT name FROM job_schedule WHERE org_id = ? AND name = 'core:vulnerability-sync:v1'",
            params: [org.orgId],
          }),
        ).toEqual([]);
      } else {
        await vi.waitFor(async () =>
          expect(
            await executor.all({
              sql: "SELECT name FROM job_schedule WHERE org_id=? AND name='core:vulnerability-sync:v1'",
              params: [org.orgId],
            }),
          ).toHaveLength(1),
        );
        await executor.batch([
          {
            sql: "UPDATE job_schedule SET next_run_at='2000-01-01T00:00:00.000Z' WHERE org_id=? AND name='core:vulnerability-sync:v1'",
            params: [org.orgId],
          },
        ]);
        schedulerOffset = 60_000;
        let scheduledId: string | undefined;
        await vi.waitFor(
          async () => {
            const scheduled = await executor.all<{ id: string }>({
              sql: "SELECT id FROM job WHERE org_id=? AND type='core:vulnerability-sync:v1'",
              params: [org.orgId],
            });
            expect(scheduled).toHaveLength(1);
            scheduledId = scheduled[0]!.id;
          },
          { timeout: 10000, interval: 25 },
        );
        await vi.waitFor(
          async () =>
            expect(await jobs.status(org, scheduledId!)).toMatchObject({ state: 'succeeded' }),
          { timeout: 10000, interval: 25 },
        );
        expect(await read()).toMatchObject({ status: 'unknown', reason: 'upstream_unavailable' });
        unavailable = false;
        await executor.batch([
          {
            sql: "UPDATE vulnerability_result SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE org_id=?",
            params: [org.orgId],
          },
          {
            sql: "UPDATE vulnerability_sync_state SET blocked_until=NULL,next_request_at='2000-01-01T00:00:00.000Z' WHERE org_id=?",
            params: [org.orgId],
          },
        ]);
        const retry = await enqueue();
        await vi.waitFor(
          async () =>
            expect(await jobs.status(org, retry.id)).toMatchObject({ state: 'succeeded' }),
          { timeout: 10000, interval: 25 },
        );
        expect(await read()).toMatchObject({ status: 'affected', advisoryCount: 1 });
        expect(transport).toHaveBeenCalledTimes(2);
        const count = transport.mock.calls.length;
        await read();
        expect(transport).toHaveBeenCalledTimes(count);
      }
    } finally {
      await broker?.close();
      await database?.close();
      await rm(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  },
);
