import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrokerConfig } from '@package-broker/core/config';
import { looksLikeCredential } from '@package-broker/core/platform/credential';
import { safeErrorName, safeRecord } from '@package-broker/core/platform/observability';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import type { PluginDefinition } from '@package-broker/core/plugin';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { SecretsConfigError } from '@package-broker/core/secrets/master-key';
import type { NodeBroker } from './index.js';
import { startNode, StartupConfigError, type StartOptions } from './startup.js';

const DEFAULT_PORT = 8787;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

export interface EntryManifest {
  readonly observability?: BrokerConfig['observability'];
  readonly registry?: BrokerConfig['registry'];
  readonly tokens?: BrokerConfig['tokens'];
  readonly vulnerability?: BrokerConfig['vulnerability'];
  readonly mcp?: BrokerConfig['mcp'];
  readonly plugins: readonly PluginDefinition[];
  readonly migrations: readonly MigrationSource[];
  readonly platformPorts?: PlatformPortConfig | null;
}

export interface EntryRuntime {
  readonly start: (options: StartOptions) => Promise<NodeBroker>;
  readonly exit: (code: number) => void;
  readonly error: (message: string) => void;
  readonly onProcessError?: (
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (error: unknown) => void,
  ) => void;
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
  throw new Error('PORT must be an integer between 1 and 65535');
}

function parseShutdownTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (/^\d+$/.test(raw)) {
    const timeout = Number(raw);
    if (timeout >= 1000 && timeout <= 120000) return timeout;
  }
  throw new Error('PB_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 120000');
}

export function createShutdown(
  close: () => Promise<void>,
  exit: (code: number) => void,
  code = 0,
  options: {
    readonly timeoutMs?: number;
    readonly error?: (message: string) => void;
  } = {},
): () => void {
  let closing = false;
  return () => {
    if (closing) return;
    closing = true;
    let finished = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      (options.error ?? console.error)(
        JSON.stringify({ level: 'error', event: 'shutdown.forced', timeout_ms: timeoutMs }),
      );
      exit(1);
    }, timeoutMs);
    const finish = (exitCode: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      exit(exitCode);
    };
    try {
      close().then(
        () => finish(code),
        () => finish(1),
      );
    } catch {
      finish(1);
    }
  };
}

export async function runEntry(
  manifest: Promise<EntryManifest>,
  env: Readonly<Record<string, string | undefined>>,
  runtime: EntryRuntime,
): Promise<void> {
  let broker: NodeBroker;
  let port: number;
  let timeoutMs: number;
  try {
    const {
      plugins,
      migrations,
      platformPorts,
      observability,
      registry,
      tokens,
      vulnerability,
      mcp,
    } = await manifest;
    try {
      port = parsePort(env['PORT']);
      timeoutMs = parseShutdownTimeout(env['PB_SHUTDOWN_TIMEOUT_MS']);
    } catch (error) {
      runtime.error(describeError(error));
      runtime.exit(1);
      return;
    }
    broker = await runtime.start({
      plugins,
      migrations,
      env,
      log: (entry) => console.log(JSON.stringify(entry)),
      ...(platformPorts == null ? {} : { platformPorts }),
      ...(observability === undefined ? {} : { observability }),
      ...(registry === undefined ? {} : { registry }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(vulnerability === undefined ? {} : { vulnerability }),
      ...(mcp === undefined ? {} : { mcp }),
    });
  } catch (error) {
    runtime.error(failureRecord('startup.failed', error));
    runtime.exit(1);
    return;
  }

  broker.server.listen(port);
  let processFailed = false;
  const stop = createShutdown(
    () => broker.close(),
    (code) => runtime.exit(processFailed ? 1 : code),
    0,
    { timeoutMs, error: runtime.error },
  );
  runtime.onSignal('SIGTERM', stop);
  runtime.onSignal('SIGINT', stop);
  for (const [event, recordEvent] of [
    ['uncaughtException', 'process.uncaught_exception'],
    ['unhandledRejection', 'process.unhandled_rejection'],
  ] as const) {
    runtime.onProcessError?.(event, (error) => {
      runtime.error(failureRecord(recordEvent, error));
      processFailed = true;
      stop();
    });
  }
}

function failureRecord(event: string, error: unknown): string {
  const variable =
    event === 'startup.failed' &&
    (error instanceof StartupConfigError || error instanceof SecretsConfigError)
      ? error.variable
      : undefined;
  const configKey =
    variable !== undefined &&
    variable.length <= 64 &&
    /^[A-Za-z_][A-Za-z0-9_.]*$/.test(variable) &&
    !looksLikeCredential(variable)
      ? variable
      : undefined;
  return JSON.stringify({
    ...safeRecord({
      level: 'error',
      event,
      service: 'package-broker',
      runtime: 'node',
      error_name: safeErrorName(error),
    }),
    ...(configKey === undefined ? {} : { config_key: configKey }),
  });
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
    onProcessError: (event, listener) => process.on(event, listener),
  }).catch((error: unknown) => {
    console.error(failureRecord('startup.failed', error));
    process.exit(1);
  });
}
