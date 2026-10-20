import { performance } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { migrate, type MigrateLogEvent } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { openNodeSqliteExecutor } from '@package-broker/db-sqlite/testing/node-sqlite-executor';

const script = new URL('../../../scripts/docker-smoke.mjs', import.meta.url).href;
const {
  parseInspect,
  parseManifest,
  verifyManifest,
  verifyMigrationLogs,
  parseArgs,
  smoke,
  docker,
  migrationLogBarrier,
} = await import(/* @vite-ignore */ script);

const manifest = `Name: registry.test/broker:release
MediaType: application/vnd.oci.image.index.v1+json
Manifests:
  Name: registry.test/broker@sha256:abc
  Platform: linux/amd64
  Name: registry.test/broker@sha256:def
  Platform: linux/arm64/v8
  Platform: unknown/unknown
`;

const migrationLogs = [
  [
    { id: 'core:0001_init', message: 'applied core:0001_init' },
    { message: 'migration lock acquired' },
    { id: 'core:0002_b', message: 'applied core:0002_b' },
    { message: 'migration lock released' },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n'),
  JSON.stringify({ message: 'migration lock is held by other, waiting' }),
];

function inspect(running = true, health = 'healthy', exitCode = 0) {
  return JSON.stringify([
    {
      Config: { Env: ['SECRET=must-never-print'] },
      State: { Running: running, ExitCode: exitCode, Health: { Status: health } },
      NetworkSettings: {
        Ports: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '32781' }] },
      },
    },
  ]);
}

function fakeDocker(failAt?: string, exitCode = 0) {
  const calls: { args: string[]; check: string }[] = [];
  const stopped = new Set<string>();
  let logIndex = 0;
  return {
    calls,
    run: async (args: string[], check: string) => {
      calls.push({ args, check });
      if (check === failAt) throw new Error(`${check}: simulated failure`);
      let stdout = '';
      if (args[0] === 'inspect') stdout = inspect(!stopped.has(args[1]!), 'healthy', exitCode);
      if (args[0] === 'stop') stopped.add(args.at(-1)!);
      if (args[0] === 'exec') stdout = JSON.stringify({ uid: 1000, init: 'tini' });
      if (args[0] === 'logs') stdout = migrationLogs[logIndex++]!;
      if (args[0] === 'buildx') stdout = manifest;
      return { stdout, stderr: '' };
    },
  };
}

function expectCleaned(calls: ReturnType<typeof fakeDocker>['calls']) {
  const createdContainers = calls.filter(({ args }) => args[0] === 'create');
  const createdVolumes = calls.filter(({ args }) => args[0] === 'volume' && args[1] === 'create');
  expect(createdContainers.length).toBeGreaterThan(0);
  for (const { args } of createdContainers) {
    expect(
      calls.some((call) => call.check === 'cleanup-container' && call.args.at(-1) === args[2]),
    ).toBe(true);
  }
  for (const { args } of createdVolumes) {
    expect(
      calls.some((call) => call.check === 'cleanup-volume' && call.args.at(-1) === args[2]),
    ).toBe(true);
  }
}

async function migrationFixture() {
  const opened = openNodeSqliteExecutor();
  const sources = await Promise.all([
    loadMigrationSource(
      'core',
      '0001_init.sql',
      `
      CREATE TABLE schema_migration (id TEXT PRIMARY KEY, name TEXT, checksum TEXT);
      CREATE TABLE migration_lock (id INTEGER PRIMARY KEY, holder TEXT, acquired_at TEXT, expires_at TEXT);
      INSERT INTO migration_lock (id) VALUES (1);
    `,
    ),
    loadMigrationSource('core', '0002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);'),
  ]);
  return { ...opened, sources };
}

describe('migration scheduling regressions', () => {
  it('covers the real runner no-pending path without inventing a lock event', async () => {
    const db = await migrationFixture();
    const logs: MigrateLogEvent[][] = [[], []];
    try {
      await migrate(db.executor, db.sources, { holder: 'first', log: (e) => logs[0]!.push(e) });
      const result = await migrate(db.executor, db.sources, {
        holder: 'late',
        log: (e) => logs[1]!.push(e),
      });
      expect(result.applied).toEqual([]);
      expect(result.pending).toEqual([]);
      expect(logs[1]).toEqual([]);
      // A silent late runner is healthy, but does not prove the smoke exercised contention.
      expect(() =>
        verifyMigrationLogs(logs.map((rows) => rows.map((e) => JSON.stringify(e)).join('\n'))),
      ).toThrow('second container');
    } finally {
      await db.close();
    }
  });

  it('accepts real initialization by one runner and protected applications by its peer', async () => {
    const db = await migrationFixture();
    const logs: MigrateLogEvent[][] = [[], []];
    let release!: () => void;
    let initialized!: () => void;
    const paused = new Promise<void>((resolve) => {
      initialized = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    let waiting!: () => void;
    let finished!: () => void;
    const peerLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const firstWaiting = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const peerFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let firstRead = true;
    const first = migrate(
      {
        ...db.executor,
        async all(statement) {
          if (firstRead && statement.sql === 'SELECT id, checksum FROM schema_migration') {
            firstRead = false;
            initialized();
            await resumed;
          }
          return db.executor.all(statement);
        },
      },
      db.sources,
      {
        holder: 'initializer',
        log: (e) => {
          logs[0]!.push(e);
          if (e.message.endsWith(', waiting')) waiting();
        },
        sleep: () => peerFinished,
      },
    );
    try {
      await paused;
      const peer = migrate(db.executor, db.sources, {
        holder: 'peer',
        log: (e) => logs[1]!.push(e),
        onBeforeApply: async () => {
          locked();
          await firstWaiting;
        },
      }).finally(finished);
      await peerLocked;
      release();
      await Promise.all([first, peer]);
      expect(logs[0]!.filter((e) => e.message.startsWith('applied ')).map((e) => e.id)).toEqual([
        'core:0001_init',
      ]);
      expect(logs[1]!.filter((e) => e.message.startsWith('applied ')).map((e) => e.id)).toEqual([
        'core:0002_b',
      ]);
      expect(logs[0]!.some((e) => e.message.endsWith(', waiting'))).toBe(true);
      expect(() =>
        verifyMigrationLogs(logs.map((rows) => rows.map((e) => JSON.stringify(e)).join('\n'))),
      ).not.toThrow();
    } finally {
      release();
      waiting();
      finished();
      await first;
      await db.close();
    }
  });

  it('holds the first acquired lock until the late peer reaches the lock loop', () => {
    const files = new Set<string>();
    const fs = {
      existsSync: (name: string) => files.has(name),
      writeFileSync: (name: string) => {
        files.add(name);
      },
    };
    const peer = migrationLogBarrier(1, fs);
    const wait = vi.fn(() =>
      peer(JSON.stringify({ message: 'migration lock is held by first, waiting' })),
    );
    const first = migrationLogBarrier(0, fs, { wait });
    first('not-json');
    first(JSON.stringify({ message: 'applied core:0001_init' }));
    expect(files.size).toBe(0);
    first(JSON.stringify({ message: 'migration lock acquired' }));
    expect(wait).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(2);
    expect(() => peer(JSON.stringify({ message: 'migration lock acquired' }))).not.toThrow();
  });

  it('fails the coordinated startup if the peer never participates', () => {
    let time = 0;
    const fail = vi.fn(() => {
      throw new Error('barrier deadline');
    });
    const first = migrationLogBarrier(
      0,
      { existsSync: () => false, writeFileSync: () => {} },
      {
        now: () => time,
        wait: () => {
          time += 5000;
        },
        fail,
      },
    );
    expect(() => first(JSON.stringify({ message: 'migration lock acquired' }))).toThrow(
      'barrier deadline',
    );
    expect(fail).toHaveBeenCalledOnce();
    expect(time).toBeLessThan(30_000);
  });
});

describe('Docker smoke parsing (no daemon)', () => {
  it('projects inspect state without retaining environment or health log data', () => {
    expect(parseInspect(inspect())).toEqual({
      running: true,
      health: 'healthy',
      exitCode: 0,
      port: 32781,
    });
    expect(parseInspect(JSON.stringify([{ State: { Running: false, ExitCode: 137 } }]))).toEqual({
      running: false,
      health: 'missing',
      exitCode: 137,
      port: undefined,
    });
  });

  it.each(['environment-secret', '{}', '[]', '[{},{}]', '[{}]'])(
    'rejects malformed inspect output without echoing it: %s',
    (output) => {
      expect(() => parseInspect(output)).toThrow(/^inspect:/);
      expect(() => parseInspect(output)).not.toThrow('environment-secret');
    },
  );

  it('parses descriptor platforms, including the arm64 variant', () => {
    expect(parseManifest(manifest)).toEqual(['linux/amd64', 'linux/arm64']);
    expect(() => verifyManifest(manifest)).not.toThrow();
  });

  it.each(['linux/amd64', 'linux/arm64'])('names a missing platform: %s', (platform) => {
    const output = manifest.replace(new RegExp(`^.*Platform: ${platform}.*$`, 'gm'), '');
    expect(() => verifyManifest(output)).toThrow(`manifest: missing platform(s): ${platform}`);
  });

  it('does not accept platform names in annotations or another OS', () => {
    expect(() =>
      verifyManifest('Name: linux/amd64\nAnnotation: linux/arm64\nPlatform: windows/amd64'),
    ).toThrow('linux/amd64, linux/arm64');
  });

  it('requires one applier, unique migration IDs, and a second lock participant', () => {
    expect(() => verifyMigrationLogs(migrationLogs)).not.toThrow();
    expect(() => verifyMigrationLogs(['', ''])).toThrow('migration-lock:');
    expect(() => verifyMigrationLogs(['null\n{}\nnot-json', ''])).toThrow('migration-lock:');
    expect(() => verifyMigrationLogs([migrationLogs[0], migrationLogs[0]])).toThrow(
      'migration-lock:',
    );
    expect(() =>
      verifyMigrationLogs([`${migrationLogs[0]}\n${migrationLogs[0]}`, migrationLogs[1]]),
    ).toThrow('migration applied twice');
    expect(() => verifyMigrationLogs([migrationLogs[0], ''])).toThrow('second container');
    expect(() =>
      verifyMigrationLogs([
        migrationLogs[0]!.replace('migration lock acquired', 'other'),
        migrationLogs[1],
      ]),
    ).toThrow('applier did not report');
  });

  it('accepts a manifest-only invocation and rejects ambiguous arguments without echoing values', () => {
    expect(parseArgs(['--verify-manifest', 'pb:release'])).toEqual({
      '--verify-manifest': 'pb:release',
    });
    for (const args of [
      [],
      ['--image'],
      ['--image', '--verify-manifest'],
      ['--unknown', 'secret'],
      ['--image', 'a', '--image', 'b'],
    ]) {
      expect(() => parseArgs(args)).toThrow(/^arguments:/);
    }
  });
});

describe('Docker smoke lifecycle (simulated Docker)', () => {
  const fetchReady = async () => new Response(null, { status: 200 });

  it('checks three containers on two volumes and removes all resources', async () => {
    const fake = fakeDocker();
    const messages: string[] = [];
    // The request stub is installed only for the duration of this run.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchReady;
    try {
      await smoke(
        { '--image': 'pb:test' },
        { run: fake.run, log: (line: string) => messages.push(line) },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fake.calls.filter(({ args }) => args[0] === 'create')).toHaveLength(3);
    for (const { args } of fake.calls.filter(({ args }) => args[0] === 'create')) {
      // Readiness resolves the singleton organization, so an empty volume needs bootstrap settings.
      expect(args).toEqual(
        expect.arrayContaining(['PB_ORG_SLUG=docker-smoke', 'PB_ORG_NAME=Docker smoke']),
      );
    }
    expect(
      fake.calls.filter(({ args }) => args[0] === 'volume' && args[1] === 'create'),
    ).toHaveLength(2);
    expect(fake.calls.filter(({ args }) => args[0] === 'stop')).toHaveLength(3);
    expect(messages.join('\n')).not.toContain('pbmk_v1_');
    expectCleaned(fake.calls);
  });

  it.each([
    'container-create',
    'startup',
    'identity',
    'shutdown',
    'concurrent-start',
    'migration-logs',
  ])('cleans up after %s fails', async (check) => {
    const fake = fakeDocker(check);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchReady;
    try {
      await expect(
        smoke({ '--image': 'pb:test' }, { run: fake.run, log: () => {} }),
      ).rejects.toThrow(check);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expectCleaned(fake.calls);
  });

  it('rejects forced shutdown even if docker stop succeeds', async () => {
    const fake = fakeDocker(undefined, 137);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchReady;
    try {
      await expect(
        smoke({ '--image': 'pb:test' }, { run: fake.run, log: () => {} }),
      ).rejects.toThrow('shutdown: expected container exit 0');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expectCleaned(fake.calls);
  });

  it.each([
    { check: 'non-root', identity: { uid: 0, init: 'tini' } },
    { check: 'pid-1', identity: { uid: 1000, init: 'node' } },
    { check: 'health', state: inspect(true, 'unhealthy') },
    { check: 'health', state: inspect(false) },
    { check: 'readiness', status: 503 },
  ])('rejects a failed $check and cleans up', async ({ check, identity, state, status }) => {
    const fake = fakeDocker();
    const run = async (args: string[], label: string) => {
      const result = await fake.run(args, label);
      if (identity && args[0] === 'exec') result.stdout = JSON.stringify(identity);
      if (state && args[0] === 'inspect') result.stdout = state;
      return result;
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: status ?? 200 });
    try {
      await expect(smoke({ '--image': 'pb:test' }, { run, log: () => {} })).rejects.toThrow(check);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expectCleaned(fake.calls);
  });

  it('cleans up without the aborted signal after interruption', async () => {
    const fake = fakeDocker();
    const controller = new AbortController();
    const cleanupSignals: unknown[] = [];
    const run = async (args: string[], check: string, options?: { signal?: AbortSignal }) => {
      const result = await fake.run(args, check);
      if (check === 'startup') {
        controller.abort();
        throw new Error('interrupted');
      }
      if (check.startsWith('cleanup-')) cleanupSignals.push(options?.signal);
      return result;
    };
    await expect(
      smoke({ '--image': 'pb:test' }, { run, signal: controller.signal, log: () => {} }),
    ).rejects.toThrow('interrupted');
    expectCleaned(fake.calls);
    expect(cleanupSignals).toEqual([undefined, undefined]);
  });

  it('attempts every removal when cleanup fails', async () => {
    const fake = fakeDocker('cleanup-container');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchReady;
    try {
      await expect(
        smoke({ '--image': 'pb:test' }, { run: fake.run, log: () => {} }),
      ).rejects.toThrow('cleanup:');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expectCleaned(fake.calls);
  });

  it('installs the barrier in both paired container commands before starting them', async () => {
    const fake = fakeDocker();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchReady;
    try {
      await smoke({ '--image': 'pb:test' }, { run: fake.run, log: () => {} });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const creates = fake.calls.filter(({ args }) => args[0] === 'create');
    expect(creates[0]!.args.at(-1)).toBe('pb:test');
    for (const [index, { args }] of creates.slice(1).entries()) {
      expect(args.slice(args.indexOf('pb:test') + 1, -1)).toEqual([
        'node',
        '--require',
        './umask.cjs',
        '--eval',
      ]);
      const code = args.at(-1)!;
      // Run the actual Docker command up to its server import with an in-memory shared volume.
      const files = new Set<string>();
      const fs = {
        existsSync: (path: string) => files.has(path),
        writeFileSync: (path: string) => {
          files.add(path);
        },
      };
      const peer = migrationLogBarrier(1 - index, fs);
      const output = { log: vi.fn() };
      const argv: string[] = [];
      runInNewContext(
        code,
        {
          require: (name: string) =>
            name === 'node:fs' ? fs : { resolve: () => '/app/server.js' },
          console: output,
          process: { exit: vi.fn(), argv },
          Atomics: {
            wait: () =>
              peer(JSON.stringify({ message: 'migration lock is held by first, waiting' })),
          },
        },
        {
          importModuleDynamically: () => {
            throw new Error('server import stub');
          },
        },
      );
      expect(argv[1]).toBe('/app/server.js');
      output.log(JSON.stringify({ message: 'migration lock acquired' }));
      expect(files.size).toBe(2);
    }
  });

  it.each([45_000.25, 59_999.75])(
    'polls near the health deadline with a positive integer timeout at %s ms',
    async (nearDeadline) => {
      const fake = fakeDocker();
      let time = 0;
      let polls = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchReady;
      const timeouts: number[] = [];
      const run = async (args: string[], check: string, options?: { timeout?: number }) => {
        const result = await fake.run(args, check);
        if (args[0] === 'inspect' && polls++ < 2) {
          timeouts.push(options!.timeout!);
          if (polls === 1) {
            time = nearDeadline;
            result.stdout = inspect(true, 'starting');
          }
        }
        return result;
      };
      try {
        await smoke({ '--image': 'pb:test' }, { run, log: () => {} });
        expect(timeouts).toHaveLength(2);
        for (const timeout of timeouts) {
          expect(Number.isInteger(timeout)).toBe(true);
          expect(timeout).toBeGreaterThan(0);
          expect(timeout).toBeLessThanOrEqual(15_000);
        }
      } finally {
        clock.mockRestore();
        globalThis.fetch = originalFetch;
      }
    },
  );

  it('preserves the original check in the outer message if cleanup also fails', async () => {
    const fake = fakeDocker('container-create');
    const run = async (args: string[], check: string) => {
      if (check === 'cleanup-container') throw new Error('cleanup-container: simulated failure');
      return fake.run(args, check);
    };
    await expect(smoke({ '--image': 'missing' }, { run, log: () => {} })).rejects.toThrow(
      /^container-create: simulated failure; cleanup:/,
    );
    expect(fake.calls.some(({ check }) => check === 'cleanup-volume')).toBe(true);
  });

  it.each([
    {
      args: ['rm', '--force', '--volumes', 'absent'],
      check: 'cleanup-container',
      resource: 'container',
    },
    { args: ['volume', 'rm', '--force', 'absent'], check: 'cleanup-volume', resource: 'volume' },
  ])(
    'treats an already absent $resource as cleaned without exposing Docker output',
    async ({ args, check, resource }) => {
      const execute = async () => {
        throw Object.assign(new Error('secret'), {
          code: 1,
          stderr: `Error response from daemon: No such ${resource}: absent\n`,
        });
      };
      await expect(docker(args, check, { execute })).resolves.toEqual({ stdout: '', stderr: '' });
      await expect(
        docker(args, check, {
          execute: async () => {
            throw Object.assign(new Error('secret'), {
              code: 1,
              stderr: 'permission denied: secret',
            });
          },
        }),
      ).rejects.toThrow(`${check}: Docker command failed`);
    },
  );

  it('reports container-create when failed creation leaves no container to remove', async () => {
    const fake = fakeDocker('container-create');
    const run = async (args: string[], check: string) => {
      if (check === 'cleanup-container')
        return docker(args, check, {
          execute: async () => {
            throw Object.assign(new Error('secret'), {
              code: 1,
              stderr: `Error response from daemon: No such container: ${args.at(-1)}\n`,
            });
          },
        });
      return fake.run(args, check);
    };
    await expect(smoke({ '--image': 'missing' }, { run, log: () => {} })).rejects.toThrow(
      /^container-create: simulated failure$/,
    );
  });

  it('verifies a manifest without creating containers or volumes', async () => {
    const fake = fakeDocker();
    await smoke({ '--verify-manifest': 'pb:release' }, { run: fake.run, log: () => {} });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual(['buildx', 'imagetools', 'inspect', 'pb:release']);
  });
});
