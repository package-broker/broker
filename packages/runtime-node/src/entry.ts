import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PluginDefinition } from '@package-broker/core/plugin';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { NodeBroker } from './index.js';
import { startNode, type StartOptions } from './startup.js';

const DEFAULT_PORT = 8787;

export interface EntryManifest {
  readonly plugins: readonly PluginDefinition[];
  readonly migrations: readonly MigrationSource[];
}

export interface EntryRuntime {
  readonly start: (options: StartOptions) => Promise<NodeBroker>;
  readonly exit: (code: number) => void;
  readonly error: (message: string) => void;
  readonly onSignal: (signal: 'SIGTERM' | 'SIGINT', listener: () => void) => void;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  if (/^\d+$/.test(raw)) {
    const port = Number(raw);
    if (port >= 1 && port <= 65535) return port;
  }
  throw new Error(`PORT must be an integer between 1 and 65535, received ${JSON.stringify(raw)}`);
}

export function createShutdown(
  close: () => Promise<void>,
  exit: (code: number) => void,
): () => void {
  let closing = false;
  return () => {
    if (closing) return;
    closing = true;
    close().then(
      () => exit(0),
      () => exit(1),
    );
  };
}

export async function runEntry(
  manifest: Promise<EntryManifest>,
  env: Readonly<Record<string, string | undefined>>,
  runtime: EntryRuntime,
): Promise<void> {
  let broker: NodeBroker;
  try {
    const { plugins, migrations } = await manifest;
    broker = await runtime.start({ plugins, migrations, env });
  } catch (error) {
    runtime.error(describeError(error));
    runtime.exit(1);
    return;
  }

  let port: number;
  try {
    port = parsePort(env['PORT']);
  } catch (error) {
    runtime.error(describeError(error));
    await broker.close().catch(() => undefined);
    runtime.exit(1);
    return;
  }

  broker.server.listen(port);
  const stop = createShutdown(
    () => broker.close(),
    (code) => runtime.exit(code),
  );
  runtime.onSignal('SIGTERM', stop);
  runtime.onSignal('SIGINT', stop);
}

export function isMainEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

function isMainModule(): boolean {
  return isMainEntry(process.argv[1], import.meta.url);
}

if (isMainModule()) {
  void runEntry(import(/* @vite-ignore */ '#pb-manifest'), process.env, {
    start: startNode,
    exit: (code) => process.exit(code),
    error: (message) => console.error(message),
    onSignal: (signal, listener) => process.on(signal, listener),
  }).catch((error: unknown) => {
    console.error(describeError(error));
    process.exit(1);
  });
}
