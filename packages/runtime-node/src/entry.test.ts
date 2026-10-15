import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { EntryRuntime } from './entry.js';
import { createShutdown, describeError, isMainEntry, parsePort, runEntry } from './entry.js';
import type { NodeBroker } from './index.js';

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

function harness(start: () => Promise<NodeBroker>): Harness {
  const signals = new Map<string, () => void>();
  const error = vi.fn();
  const exit = vi.fn();
  return {
    error,
    exit,
    signals,
    runtime: { start, exit, error, onSignal: (signal, listener) => signals.set(signal, listener) },
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
    expect(close).toHaveBeenCalledTimes(1);
    expect(test.error).toHaveBeenCalledWith(expect.stringContaining('PORT must be an integer'));
    expect(test.exit).toHaveBeenCalledWith(1);
    expect(test.signals.size).toBe(0);
  });

  it('exits 1 without listening when start-up rejects', async () => {
    const test = harness(() => Promise.reject(new Error('init failed')));
    await runEntry(manifest, {}, test.runtime);
    expect(test.error).toHaveBeenCalledWith('Error: init failed');
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
