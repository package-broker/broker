import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import { SecretsConfigError } from '@package-broker/core/secrets/master-key';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryRuntime } from './entry.js';
import { createShutdown, describeError, isMainEntry, parsePort, runEntry } from './entry.js';
import type { NodeBroker } from './index.js';
import { startNode, StartupConfigError } from './startup.js';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';

const manifest: Promise<{ plugins: []; migrations: [] }> = Promise.resolve({
  plugins: [],
  migrations: [],
});

function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeBroker(close: () => Promise<void> = () => Promise.resolve()): {
  readonly broker: NodeBroker;
  readonly listen: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const listen = vi.fn();
  const closeMock = vi.fn(close);
  const broker = {
    plugins: [],
    server: { listen } as unknown as Server,
    ready: () => Promise.resolve(),
    close: closeMock,
  } as unknown as NodeBroker;
  return { broker, listen, close: closeMock };
}

interface Harness {
  readonly runtime: EntryRuntime;
  readonly error: ReturnType<typeof vi.fn>;
  readonly exit: ReturnType<typeof vi.fn>;
  readonly signals: Map<string, () => void>;
}

function harness(start: EntryRuntime['start']): Harness {
  const signals = new Map<string, () => void>();
  const error = vi.fn();
  const exit = vi.fn();
  return {
    error,
    exit,
    signals,
    runtime: {
      start: vi.fn(start),
      exit,
      error,
      onSignal: (signal, listener) => signals.set(signal, listener),
    },
  };
}

function signalHandler(signals: Map<string, () => void>, name: string): () => void {
  const handler = signals.get(name);
  if (handler === undefined) throw new Error(`${name} handler was not registered`);
  return handler;
}

describe('parsePort', () => {
  it('falls back to the default when PORT is unset', () => {
    expect(parsePort(undefined)).toBe(8787);
  });

  it.each(['1', '80', '8787', '65535'])('accepts %s', (raw) => {
    expect(parsePort(raw)).toBe(Number(raw));
  });

  it.each(['', '0', '65536', '80.5', 'abc', '-1', ' 80', '80 ', '+80', '1e3', '0x50'])(
    'rejects %o instead of choosing a random port',
    (raw) => {
      expect(() => parsePort(raw)).toThrowError(/PORT must be an integer between 1 and 65535/);
    },
  );
});

describe('describeError', () => {
  it('formats errors and non-errors', () => {
    expect(describeError(new TypeError('bad'))).toBe('TypeError: bad');
    expect(describeError('plain')).toBe('plain');
  });
});

describe('createShutdown', () => {
  it('closes once and exits 0 only after the close resolved', async () => {
    const gate = deferred();
    const close = vi.fn(() => gate.promise);
    const exit = vi.fn();
    createShutdown(close, exit)();
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ignores later signals while the first close is still running', async () => {
    const gate = deferred();
    const close = vi.fn(() => gate.promise);
    const exit = vi.fn();
    const stop = createShutdown(close, exit);
    stop();
    stop();
    stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(exit).toHaveBeenCalledWith(0);
    stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when the close fails', async () => {
    const close = vi.fn(() => Promise.reject(new Error('boom')));
    const exit = vi.fn();
    createShutdown(close, exit)();
    await flush();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('runEntry', () => {
  it('writes migration events from a temporary database start to stdout as JSON lines', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pb-entry-'));
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let broker: NodeBroker | undefined;
    const masterKey = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const privateData = 'postgres://user:password@host/db\naccount@example.test';
    try {
      const require = createRequire(import.meta.url);
      const migrationsDirectory = join(
        dirname(require.resolve('@package-broker/db-sqlite/package.json')),
        'migrations',
      );
      const migrations = await Promise.all(
        readdirSync(migrationsDirectory)
          .filter((name) => name.endsWith('.sql'))
          .sort()
          .map((name) =>
            loadMigrationSource(
              'core',
              name,
              readFileSync(join(migrationsDirectory, name), 'utf8'),
            ),
          ),
      );
      const test = harness(async (options) => {
        broker = await startNode(options);
        vi.spyOn(broker.server, 'listen').mockReturnValue(broker.server);
        return broker;
      });
      await runEntry(
        Promise.resolve({ plugins: [], migrations }),
        {
          PB_SQLITE_PATH: join(directory, 'broker.sqlite'),
          PB_MASTER_KEY: masterKey,
          PB_PUBLIC_URL: 'http://127.0.0.1',
          PRIVATE_DATA: privateData,
        },
        test.runtime,
      );
      expect(test.error).not.toHaveBeenCalled();
      expect(test.exit).not.toHaveBeenCalled();
      expect(broker?.server.listen).toHaveBeenCalledExactlyOnceWith(8787);
      const records = stdout.mock.calls.map((call) => {
        const line: unknown = call[0];
        expect(typeof line).toBe('string');
        expect(line).not.toContain('\n');
        return JSON.parse(line as string) as Record<string, unknown>;
      });
      const applied = records.filter((record) => record['id'] !== undefined);
      expect(applied.map((record) => record['id'])).toEqual(migrations.map(({ id }) => id));
      const holder = applied[0]?.['holder'];
      expect(holder).toEqual(expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/));
      for (const { id } of migrations) {
        expect(applied).toContainEqual({ level: 'info', message: `applied ${id}`, id, holder });
      }
      expect(records).toContainEqual({ level: 'info', message: 'migration lock acquired', holder });
      expect(records).toContainEqual({ level: 'info', message: 'migration lock released', holder });
      const output = JSON.stringify(stdout.mock.calls);
      for (const value of [masterKey, 'password', 'account@example.test', privateData]) {
        expect(output).not.toContain(value);
      }
    } finally {
      await broker?.close();
      stdout.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never prints a hostile PORT value to stderr', async () => {
    const sentinel = 'PORT-SENTINEL\npostgres://user:password@host/db\naccount@example.test';
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { broker } = fakeBroker();
      const test = harness(() => Promise.resolve(broker));
      await runEntry(manifest, { PORT: sentinel }, { ...test.runtime, error: console.error });
      expect(stderr).toHaveBeenCalledExactlyOnceWith(
        'Error: PORT must be an integer between 1 and 65535',
      );
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('PORT-SENTINEL');
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('password');
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('account@example.test');
      expect(test.runtime.start).not.toHaveBeenCalled();
      expect(test.exit).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([
    new StartupConfigError('PB_PUBLIC_URL', 'private request data'),
    new StartupConfigError('PB_BLOB_ROOT', 'postgres://user:password@host/db'),
    new StartupConfigError('platformPorts', 'private config value'),
    new SecretsConfigError('malformed', 'PB_MASTER_KEY'),
    new SecretsConfigError('missing', 'PB_MASTER_KEY_FILE'),
  ])('names the failed startup config key without printing the message: %s', async (failure) => {
    const test = harness(() => Promise.reject(failure));
    await runEntry(manifest, {}, test.runtime);
    expect(test.error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        level: 'error',
        event: 'startup.failed',
        service: 'package-broker',
        runtime: 'node',
        error_name:
          failure instanceof StartupConfigError ? 'StartupConfigError' : 'SecretsConfigError',
        config_key: failure.variable,
      }),
    );
    expect(test.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([
    'postgres://user:password@host/db',
    'account@example.test',
    'bad\nkey',
    'AKIA1234567890ABCDEF',
  ])('omits an unsafe config key %s', async (key) => {
    const test = harness(() => Promise.reject(new StartupConfigError(key, 'private data')));
    await runEntry(manifest, {}, test.runtime);
    expect(test.error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        level: 'error',
        event: 'startup.failed',
        service: 'package-broker',
        runtime: 'node',
        error_name: 'StartupConfigError',
      }),
    );
    expect(test.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([true, false, undefined])('forwards observability flag %s', async (trusted) => {
    const { broker } = fakeBroker();
    const test = harness(() => Promise.resolve(broker));
    const observability = trusted === undefined ? undefined : { trustInboundTraceparent: trusted };
    const input = {
      plugins: [],
      migrations: [],
      ...(observability === undefined ? {} : { observability }),
    };
    await runEntry(Promise.resolve(input), {}, test.runtime);
    expect(test.runtime.start).toHaveBeenCalledExactlyOnceWith({
      plugins: [],
      migrations: [],
      env: {},
      log: expect.any(Function),
      ...(observability === undefined ? {} : { observability }),
    });
    const options = vi.mocked(test.runtime.start).mock.calls[0]?.[0];
    if (observability === undefined) {
      expect(options).not.toHaveProperty('observability');
    } else {
      expect(options?.observability).toBe(observability);
    }
    expect(test.exit).not.toHaveBeenCalled();
  });

  it('forwards registry', async () => {
    const { broker } = fakeBroker();
    const test = harness(() => Promise.resolve(broker));
    const registry = { timers: { metadataTtlSeconds: 120 } };
    await runEntry(Promise.resolve({ plugins: [], migrations: [], registry }), {}, test.runtime);
    const options = vi.mocked(test.runtime.start).mock.calls[0]?.[0];
    expect(options?.registry).toBe(registry);
    expect(test.exit).not.toHaveBeenCalled();
  });

  it('forwards tokens', async () => {
    const { broker } = fakeBroker();
    const test = harness(() => Promise.resolve(broker));
    const tokens = { maxLifetimeDays: { personal: 30, service: 60 } };
    await runEntry(Promise.resolve({ plugins: [], migrations: [], tokens }), {}, test.runtime);
    expect(vi.mocked(test.runtime.start).mock.calls[0]?.[0].tokens).toBe(tokens);
    expect(test.exit).not.toHaveBeenCalled();
  });

  it('omits tokens when the manifest has none', async () => {
    const { broker } = fakeBroker();
    const test = harness(() => Promise.resolve(broker));
    await runEntry(Promise.resolve({ plugins: [], migrations: [] }), {}, test.runtime);
    expect(vi.mocked(test.runtime.start).mock.calls[0]?.[0]).not.toHaveProperty('tokens');
  });

  it('omits registry when the manifest has none', async () => {
    const { broker } = fakeBroker();
    const test = harness(() => Promise.resolve(broker));
    await runEntry(Promise.resolve({ plugins: [], migrations: [] }), {}, test.runtime);
    expect(vi.mocked(test.runtime.start).mock.calls[0]?.[0]).not.toHaveProperty('registry');
  });

  it('listens on the default port and registers both signals', async () => {
    const { broker, listen } = fakeBroker();
    const test = harness(() => Promise.resolve(broker));
    await runEntry(manifest, {}, test.runtime);
    expect(listen).toHaveBeenCalledWith(8787);
    expect(test.exit).not.toHaveBeenCalled();
    expect(test.signals.has('SIGTERM')).toBe(true);
    expect(test.signals.has('SIGINT')).toBe(true);
  });

  it('listens on a valid PORT', async () => {
    const { broker, listen } = fakeBroker();
    const test = harness(() => Promise.resolve(broker));
    await runEntry(manifest, { PORT: '9123' }, test.runtime);
    expect(listen).toHaveBeenCalledWith(9123);
  });

  it('fails with a message, closes the database and exits 1 on an invalid PORT', async () => {
    const close = vi.fn(() => Promise.resolve());
    const { broker, listen } = fakeBroker(close);
    const test = harness(() => Promise.resolve(broker));
    await runEntry(manifest, { PORT: 'abc' }, test.runtime);
    expect(listen).not.toHaveBeenCalled();
    expect(test.runtime.start).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(test.error).toHaveBeenCalledWith(expect.stringContaining('PORT must be an integer'));
    expect(test.exit).toHaveBeenCalledWith(1);
    expect(test.signals.size).toBe(0);
  });

  it('exits 1 without listening when start-up rejects', async () => {
    const test = harness(() => Promise.reject(new Error('init failed')));
    await runEntry(manifest, {}, test.runtime);
    expect(test.error).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'error',
        event: 'startup.failed',
        service: 'package-broker',
        runtime: 'node',
        error_name: 'Error',
      }),
    );
    expect(test.exit).toHaveBeenCalledWith(1);
    expect(test.signals.size).toBe(0);
  });

  it('starts exactly one close when both signals arrive', async () => {
    const close = vi.fn(() => Promise.resolve());
    const { broker } = fakeBroker(close);
    const test = harness(() => Promise.resolve(broker));
    await runEntry(manifest, {}, test.runtime);
    signalHandler(test.signals, 'SIGTERM')();
    signalHandler(test.signals, 'SIGINT')();
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(test.exit).toHaveBeenCalledWith(0);
  });
});

describe('isMainEntry', () => {
  it('matches the module behind a symlinked path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-main-entry-'));
    try {
      const real = join(dir, 'real.mjs');
      writeFileSync(real, '');
      const link = join(dir, 'link.mjs');
      symlinkSync(real, link);
      expect(isMainEntry(real, pathToFileURL(real).href)).toBe(true);
      expect(isMainEntry(link, pathToFileURL(real).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is not main for a different file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-main-entry-'));
    try {
      const real = join(dir, 'real.mjs');
      const other = join(dir, 'other.mjs');
      writeFileSync(real, '');
      writeFileSync(other, '');
      expect(isMainEntry(other, pathToFileURL(real).href)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is not main for a missing argv[1] or an unresolvable path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-main-entry-'));
    try {
      const real = join(dir, 'real.mjs');
      writeFileSync(real, '');
      const url = pathToFileURL(real).href;
      expect(isMainEntry(undefined, url)).toBe(false);
      expect(isMainEntry(join(dir, 'missing.mjs'), url)).toBe(false);
      const dangling = join(dir, 'dangling.mjs');
      symlinkSync(join(dir, 'gone.mjs'), dangling);
      expect(isMainEntry(dangling, url)).toBe(false);
      expect(isMainEntry(real, 'not-a-file-url')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('entry platform ports and failure handling', () => {
  const platformPorts: PlatformPortConfig = {
    blob: { adapter: 'filesystem', rootEnv: 'BLOB_ROOT', maxBytes: 1024 },
    cache: { adapter: 'lru', maxBytes: 1024 },
    jobs: { adapter: 'database', maxRunning: 1 },
    observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
  };

  function expectRecord(error: ReturnType<typeof vi.fn>, event: string): void {
    expect(error).toHaveBeenCalledTimes(1);
    const line: unknown = error.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');
    expect(JSON.parse(line as string)).toEqual({
      level: 'error',
      event,
      service: 'package-broker',
      runtime: 'node',
      error_name: 'Error',
    });
    expect(line).not.toMatch(/postgres|pw|host/);
  }

  it('forwards the exact configured platform ports object', async () => {
    const { broker } = fakeBroker();
    const start = vi.fn(() => Promise.resolve(broker));
    const test = harness(start);
    await runEntry(
      Promise.resolve({ plugins: [], migrations: [], platformPorts }),
      {},
      test.runtime,
    );
    expect(start.mock.calls).toHaveLength(1);
    expect(test.runtime.start).toHaveBeenCalledWith({
      plugins: [],
      migrations: [],
      env: {},
      log: expect.any(Function),
      platformPorts,
    });
    const options = vi.mocked(test.runtime.start).mock.calls[0]?.[0];
    expect(options?.platformPorts).toBe(platformPorts);
  });

  it.each([null, undefined])('disables platform services for %s', async (ports) => {
    const { broker } = fakeBroker();
    const test = harness(() => Promise.resolve(broker));
    const input =
      ports === undefined
        ? { plugins: [], migrations: [] }
        : { plugins: [], migrations: [], platformPorts: ports };
    await runEntry(Promise.resolve(input), {}, test.runtime);
    expect(test.runtime.start).toHaveBeenCalledWith({
      plugins: [],
      migrations: [],
      env: {},
      log: expect.any(Function),
    });
  });

  it('sanitizes a rejected start before exiting', async () => {
    const test = harness(() => Promise.reject(new Error('postgres://user:pw@host/db')));
    await runEntry(manifest, {}, test.runtime);
    expectRecord(test.error, 'startup.failed');
    expect(test.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(test.error.mock.invocationCallOrder[0]).toBeLessThan(
      test.exit.mock.invocationCallOrder[0]!,
    );
  });

  it('sanitizes a rejected manifest import without starting', async () => {
    const { broker } = fakeBroker();
    const test = harness(() => Promise.resolve(broker));
    await runEntry(Promise.reject(new Error('postgres://user:pw@host/db')), {}, test.runtime);
    expectRecord(test.error, 'startup.failed');
    expect(test.runtime.start).not.toHaveBeenCalled();
    expect(test.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('rejects invalid PORT before migration or bootstrap can run', async () => {
    const migrate = vi.fn();
    const bootstrap = vi.fn();
    const { broker } = fakeBroker();
    const test = harness(() => {
      migrate();
      bootstrap();
      return Promise.resolve(broker);
    });
    await runEntry(manifest, { PORT: 'invalid' }, test.runtime);
    expect(test.runtime.start).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(test.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('uses the requested failure exit code after a successful close', async () => {
    const close = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    createShutdown(close, exit, 1)();
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([
    ['uncaughtException', 'process.uncaught_exception'],
    ['unhandledRejection', 'process.unhandled_rejection'],
  ] as const)('sanitizes %s and closes only once while closing', async (event, recordEvent) => {
    const gate = deferred();
    const { broker, close, listen } = fakeBroker(() => gate.promise);
    const test = harness(() => Promise.resolve(broker));
    const listeners = new Map<string, (error: unknown) => void>();
    const onProcessError = vi.fn((name: string, listener: (error: unknown) => void) => {
      expect(listen).toHaveBeenCalledTimes(1);
      listeners.set(name, listener);
    });
    await runEntry(manifest, {}, { ...test.runtime, onProcessError });
    expect(onProcessError).toHaveBeenCalledTimes(2);
    expect(listeners.has('uncaughtException')).toBe(true);
    expect(listeners.has('unhandledRejection')).toBe(true);
    const listener = listeners.get(event);
    expect(listener).toBeDefined();
    listener!(new Error('postgres://user:pw@host/db'));
    expectRecord(test.error, recordEvent);
    expect(close).toHaveBeenCalledTimes(1);
    expect(test.exit).not.toHaveBeenCalled();
    listener!(new Error('postgres://user:pw@host/db'));
    signalHandler(test.signals, 'SIGTERM')();
    expect(close).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flush();
    expect(test.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('shutdown deadline', () => {
  afterEach(() => vi.useRealTimers());

  it.each([undefined, '1000', '120000'])(
    'forces exit at timeout %s after either signal',
    async (raw) => {
      vi.useFakeTimers();
      const gate = deferred();
      const { broker, close } = fakeBroker(() => gate.promise);
      const test = harness(() => Promise.resolve(broker));
      const timeout = raw === undefined ? 8000 : Number(raw);
      await runEntry(manifest, { PB_SHUTDOWN_TIMEOUT_MS: raw }, test.runtime);
      signalHandler(test.signals, 'SIGINT')();
      await vi.advanceTimersByTimeAsync(timeout - 1);
      signalHandler(test.signals, 'SIGTERM')();
      expect(close).toHaveBeenCalledTimes(1);
      expect(test.exit).not.toHaveBeenCalled();
      expect(test.error).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(test.error).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({ level: 'error', event: 'shutdown.forced', timeout_ms: timeout }),
      );
      expect(test.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(test.error.mock.invocationCallOrder[0]).toBeLessThan(
        test.exit.mock.invocationCallOrder[0]!,
      );
      gate.resolve();
      await vi.advanceTimersByTimeAsync(timeout);
      expect(test.exit).toHaveBeenCalledTimes(1);
      expect(test.error).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['resolve', 'reject', 'throw'] as const)(
    'clears the deadline when close finishes: %s',
    async (result) => {
      vi.useFakeTimers();
      const error = vi.fn();
      const exit = vi.fn();
      const close = vi.fn(() => {
        if (result === 'throw') throw new Error('close failed');
        return result === 'resolve' ? Promise.resolve() : Promise.reject(new Error('close failed'));
      });
      createShutdown(close, exit, 0, { error })();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledExactlyOnceWith(result === 'resolve' ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(8000);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    '999',
    '120001',
    '1000.5',
    '-1000',
    ' 1000',
    '1000 ',
    '+1000',
    '1e3',
    '0x3e8',
    'secret-value',
  ])('rejects invalid timeout %o before startup without echoing it', async (raw) => {
    const { broker, listen } = fakeBroker();
    const test = harness(() => Promise.resolve(broker));
    await runEntry(manifest, { PB_SHUTDOWN_TIMEOUT_MS: raw }, test.runtime);
    expect(test.runtime.start).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(test.signals.size).toBe(0);
    expect(test.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(test.error).toHaveBeenCalledExactlyOnceWith(
      'Error: PB_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 120000',
    );
  });
});
