import type { AuditSinkDefinition, AuditTrailDefinition, PluginDefinition } from '../plugin.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/;
const SINK_NAME = /^[a-z0-9-]{1,32}(?![\s\S])/;

// G13 enables this only when runtime audit consumers are installed.
export const AUDIT_PLUGINS_AVAILABLE = false;

const AUDIT_DESTINATIONS = new Set([
  'PB_AUDIT_OTLP_ENDPOINT',
  'PB_AUDIT_OTLP_HEADERS',
  'PB_AUDIT_WEBHOOK_URL',
  'PB_AUDIT_WEBHOOK_HEADERS',
]);
const CORE_ENV_NAMES = new Set([
  'DB',
  'STORAGE',
  'JOBS',
  'ASSETS',
  'ANALYTICS',
  'MCP_RATE_LIMIT',
  'DEPLOYMENT_ID',
  'COMPOSER_AUTH',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
]);

function reservedEnv(name: string): boolean {
  return (
    name.startsWith('PB_') || name.startsWith('OTEL_EXPORTER_OTLP_') || CORE_ENV_NAMES.has(name)
  );
}

export interface PluginGateSnapshot {
  readonly apiVersion: number;
  readonly binds: readonly string[];
}

function ownData(source: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new Error();
  return descriptor.value as unknown;
}

export function snapshotPluginGate(
  plugin: PluginDefinition,
  problems: string[],
): PluginGateSnapshot {
  try {
    const apiVersion = ownData(plugin, 'apiVersion');
    const value = ownData(plugin, 'binds');
    const binds: string[] = [];
    if (value !== undefined) {
      if (!Array.isArray(value)) throw new Error();
      const length = ownData(value, 'length');
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 1024)
        throw new Error();
      for (let i = 0; i < length; i++) {
        const port = ownData(value, String(i));
        if (typeof port !== 'string') throw new Error();
        binds.push(port);
      }
    }
    if (typeof apiVersion !== 'number') throw new Error();
    return Object.freeze({ apiVersion, binds: Object.freeze(binds) });
  } catch {
    problems.push(
      `plugin "${plugin.id}" apiVersion or binds is malformed; own data properties required`,
    );
    return Object.freeze({ apiVersion: NaN, binds: Object.freeze([]) });
  }
}

interface Owned<T> {
  readonly plugin: string;
  readonly definition: T;
}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw new Error();
  return Object.fromEntries(
    keys.map((key) => [key, (value as Record<string, unknown>)[key as string]]),
  );
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error();
  const length = value.length;
  if (!Number.isInteger(length) || length < 0 || length > 1024) throw new Error();
  return Array.from({ length }, (_, index) => {
    if (!Object.hasOwn(value, index)) throw new Error();
    return (value as unknown[])[index];
  });
}

function envName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && ENV_NAME.test(value);
}

function snapshotTrail(value: unknown): AuditTrailDefinition {
  const entry = object(value, ['toggleEnv', 'create']);
  if (typeof entry.create !== 'function') throw new Error();
  if (entry.toggleEnv !== undefined && !envName(entry.toggleEnv)) throw new Error();
  return Object.freeze(entry) as unknown as AuditTrailDefinition;
}

function snapshotSink(value: unknown): AuditSinkDefinition {
  const entry = object(value, [
    'id',
    'kind',
    'destination',
    'envNames',
    'activation',
    'custody',
    'sourceIp',
    'maxBatchEvents',
    'skipAfter',
    'create',
  ]);
  if (
    typeof entry.id !== 'string' ||
    !SINK_NAME.test(entry.id) ||
    typeof entry.kind !== 'string' ||
    !SINK_NAME.test(entry.kind) ||
    !['build', 'env'].includes(entry.activation as string) ||
    !['delivery', 'durable'].includes(entry.custody as string) ||
    !['include', 'omit'].includes(entry.sourceIp as string) ||
    typeof entry.create !== 'function'
  )
    throw new Error();
  for (const [key, max] of [
    ['maxBatchEvents', 100],
    ['skipAfter', 10],
  ] as const) {
    const n = entry[key];
    if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max)) {
      throw new Error();
    }
  }
  const destination = object(entry.destination, [
    'protocol',
    'urlEnv',
    'endpointEnv',
    'headersEnv',
  ]);
  if (destination.protocol === 'https-json') {
    if (!envName(destination.urlEnv) || Object.hasOwn(destination, 'endpointEnv'))
      throw new Error();
  } else if (destination.protocol === 'otlp-http-json') {
    if (Object.hasOwn(destination, 'urlEnv')) throw new Error();
  } else throw new Error();
  const names: string[] = [];
  for (const key of ['urlEnv', 'endpointEnv', 'headersEnv']) {
    const name = destination[key];
    if (name === undefined) continue;
    if (!envName(name) || names.includes(name)) throw new Error();
    if (CORE_ENV_NAMES.has(name) || (name.startsWith('PB_') && !AUDIT_DESTINATIONS.has(name)))
      throw new Error();
    if (destination.protocol === 'https-json' && name.startsWith('OTEL_EXPORTER_OTLP_'))
      throw new Error();
    names.push(name);
  }
  entry.destination = Object.freeze(destination);
  if (entry.envNames !== undefined) {
    const extras = array(entry.envNames);
    if (extras.some((name) => !envName(name)) || new Set(extras).size !== extras.length)
      throw new Error();
    entry.envNames = Object.freeze(extras);
  }
  return Object.freeze(entry) as unknown as AuditSinkDefinition;
}

export function collectAuditDefinitions(
  plugins: readonly PluginDefinition[],
  gates: readonly PluginGateSnapshot[],
  problems: string[],
) {
  let trail: Owned<AuditTrailDefinition> | null = null;
  const sinks: Owned<AuditSinkDefinition>[] = [];
  const ids = new Set<string>();
  for (const [index, plugin] of plugins.entries()) {
    const problem = (message: string): void => {
      problems.push(`plugin "${plugin.id}" ${message}`);
    };
    try {
      const trailValue: unknown = plugin.auditTrail;
      const sinkValue: unknown = plugin.auditSinks;
      const gate = gates[index]!;
      const bound = gate.binds.includes('audit-trail');
      if (
        (bound || trailValue !== undefined || sinkValue !== undefined) &&
        !(gate.apiVersion >= 4)
      ) {
        problem('audit definitions and audit-trail binding require apiVersion 4');
      }
      if (bound !== (trailValue !== undefined)) {
        problem('auditTrail is required if and only if audit-trail is bound');
      }
      if (trailValue !== undefined) {
        const definition = snapshotTrail(trailValue);
        if (trail !== null) problem('only one audit trail may be declared');
        else trail = Object.freeze({ plugin: plugin.id, definition });
      }
      if (sinkValue !== undefined) {
        for (const value of array(sinkValue)) {
          const definition = snapshotSink(value);
          if (ids.has(definition.id)) problem('audit sink ids must be unique');
          ids.add(definition.id);
          sinks.push(Object.freeze({ plugin: plugin.id, definition }));
        }
      }
    } catch {
      problem('audit definition is malformed');
    }
  }
  const destinations = new Set<string>();
  for (const { plugin, definition } of sinks) {
    for (const [key, value] of Object.entries(definition.destination)) {
      if (key !== 'protocol' && typeof value === 'string') {
        if (destinations.has(value))
          problems.push(
            `plugin "${plugin}" audit destination variables must not be shared between sinks`,
          );
        destinations.add(value);
      }
    }
  }
  for (const { plugin, definition } of sinks) {
    if (definition.envNames?.some((name) => reservedEnv(name) || destinations.has(name)))
      problems.push(
        `plugin "${plugin}" audit sink envNames contain a reserved or destination variable`,
      );
  }
  if (trail?.definition.toggleEnv !== undefined) {
    const name = trail.definition.toggleEnv;
    if (
      (reservedEnv(name) && name !== 'PB_AUDIT_TRAIL') ||
      AUDIT_DESTINATIONS.has(name) ||
      destinations.has(name)
    ) {
      problems.push(
        `plugin "${trail.plugin}" audit trail toggleEnv contains a reserved or destination variable`,
      );
    }
  }
  return Object.freeze({ trail, sinks: Object.freeze(sinks) });
}
