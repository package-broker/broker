import type { AuditSinkDefinition, AuditTrailDefinition, PluginDefinition } from '../plugin.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SINK_NAME = /^[a-z0-9-]{1,32}$/;

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
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    value === value.trim() &&
    ENV_NAME.test(value)
  );
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
    entry.id !== entry.id.trim() ||
    typeof entry.kind !== 'string' ||
    !SINK_NAME.test(entry.kind) ||
    entry.kind !== entry.kind.trim() ||
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

export function collectAuditDefinitions(plugins: readonly PluginDefinition[], problems: string[]) {
  let trail: Owned<AuditTrailDefinition> | null = null;
  const sinks: Owned<AuditSinkDefinition>[] = [];
  const ids = new Set<string>();
  for (const plugin of plugins) {
    try {
      const trailValue: unknown = plugin.auditTrail;
      const sinkValue: unknown = plugin.auditSinks;
      const bound = plugin.binds?.includes('audit-trail') ?? false;
      if (
        (bound || trailValue !== undefined || sinkValue !== undefined) &&
        plugin.apiVersion !== 4
      ) {
        problems.push('audit definitions and audit-trail binding require apiVersion 4');
      }
      if (bound !== (trailValue !== undefined)) {
        problems.push('auditTrail is required if and only if audit-trail is bound');
      }
      if (trailValue !== undefined) {
        const definition = snapshotTrail(trailValue);
        if (trail !== null) problems.push('only one audit trail may be declared');
        else trail = Object.freeze({ plugin: plugin.id, definition });
      }
      if (sinkValue !== undefined) {
        for (const value of array(sinkValue)) {
          const definition = snapshotSink(value);
          if (ids.has(definition.id)) problems.push('audit sink ids must be unique');
          ids.add(definition.id);
          sinks.push(Object.freeze({ plugin: plugin.id, definition }));
        }
      }
    } catch {
      problems.push('audit definition is malformed');
    }
  }
  const destinations = new Set<string>();
  for (const { definition } of sinks) {
    for (const [key, value] of Object.entries(definition.destination)) {
      if (key !== 'protocol' && typeof value === 'string') destinations.add(value);
    }
  }
  for (const { definition } of sinks) {
    if (
      definition.envNames?.some(
        (name) =>
          name.startsWith('PB_') ||
          name.startsWith('OTEL_EXPORTER_OTLP_') ||
          destinations.has(name),
      )
    )
      problems.push('audit sink envNames contain a reserved or destination variable');
  }
  return Object.freeze({ trail, sinks: Object.freeze(sinks) });
}
