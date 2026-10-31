import type { BrokerConfig } from '../config.js';
import type { Platform } from '../plugin.js';

export interface BrokerAuditConfig {
  readonly policy?: 'availability' | 'required';
  readonly acceptNoDurableAudit?: true;
  readonly capacity?: { readonly maxJournalBytes?: number };
  readonly alerts?: { readonly webhookEnv?: string };
  readonly egress?: { readonly allowPrivate?: readonly string[] };
}

export const MIN_AUDIT_JOURNAL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CLOUDFLARE_AUDIT_JOURNAL_BYTES = 4 * 1024 * 1024 * 1024;

// The journal plus its 1% reserve (§2.8) must fit in D1's 10 GB database limit.
export const MAX_CLOUDFLARE_AUDIT_JOURNAL_BYTES = Math.floor(10_000_000_000 / 1.01);

export function auditJournalBudgetProblem(budget: unknown, target: Platform): string | null {
  if (
    typeof budget !== 'number' ||
    !Number.isSafeInteger(budget) ||
    budget < MIN_AUDIT_JOURNAL_BYTES
  ) {
    return 'audit.capacity.maxJournalBytes: must be a safe integer of at least 64 MiB';
  }
  if (target === 'cloudflare' && budget > MAX_CLOUDFLARE_AUDIT_JOURNAL_BYTES) {
    return 'audit.capacity.maxJournalBytes: exceeds the Cloudflare database limit with reserve';
  }
  return null;
}

const CORE_ENV_NAMES = new Set([
  'DB',
  'STORAGE',
  'JOBS',
  'ASSETS',
  'ANALYTICS',
  'MCP_RATE_LIMIT',
  'DEPLOYMENT_ID',
  'COMPOSER_AUTH',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_GLOBAL',
  'COMPOSER_HOME',
  'PP_API_KEY_FILE',
  'PP_API_SECRET_FILE',
  'HOME',
  'PATH',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/;
const SINK_ID = /^[a-z0-9-]{1,32}(?![\s\S])/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && ENV_NAME.test(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  at: string,
): string[] {
  return Object.keys(value)
    .filter((key) => !keys.includes(key))
    .map(() => `${at}: contains an unknown key`);
}

function ownData(source: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) throw new Error();
  return descriptor.value as unknown;
}

function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (ancestors.has(value)) throw new Error();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
      const length = ownData(value, 'length');
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 1024)
        throw new Error();
      return Array.from({ length }, (_, index) =>
        snapshot(ownData(value, String(index)), ancestors),
      );
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error();
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, snapshot(ownData(value, key), ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

/** Capture only the inputs used by audit validation and resolution, without invoking accessors. */
export function snapshotAuditBuildConfig(config: BrokerConfig, target: Platform): BrokerConfig {
  const plugins = ownData(config, 'plugins');
  if (!Array.isArray(plugins)) throw new Error();
  const length = ownData(plugins, 'length');
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 1024)
    throw new Error();
  const ports = ownData(config, 'platformPorts');
  const platform = object(ports) ? ownData(ports, target) : undefined;
  const telemetry = object(platform) ? ownData(platform, 'observability') : undefined;
  return snapshot({
    platform: ownData(config, 'platform'),
    audit: ownData(config, 'audit'),
    plugins: Array.from({ length }, (_, index) => {
      const plugin = ownData(plugins, String(index));
      if (!object(plugin)) throw new Error();
      return {
        auditTrail: ownData(plugin, 'auditTrail'),
        auditSinks: ownData(plugin, 'auditSinks'),
      };
    }),
    platformPorts: {
      [target]: {
        observability: object(telemetry)
          ? {
              endpointEnv: ownData(telemetry, 'endpointEnv'),
              headersEnv: ownData(telemetry, 'headersEnv'),
            }
          : telemetry,
      },
    },
  }) as BrokerConfig;
}

function auditDefinitions(config: BrokerConfig, problems: string[]) {
  const sinkIds = new Set<string>();
  const destinations = new Set<string>();
  let toggle = false;
  let malformed = false;
  try {
    const plugins = ownData(config, 'plugins');
    if (!Array.isArray(plugins)) throw new Error();
    const length = ownData(plugins, 'length');
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 1024)
      throw new Error();
    for (let index = 0; index < length; index++) {
      try {
        const plugin = ownData(plugins, String(index));
        if (!object(plugin)) throw new Error();
        const sinks = snapshot(ownData(plugin, 'auditSinks'));
        if (sinks !== undefined) {
          if (!Array.isArray(sinks)) throw new Error();
          for (const sink of sinks as unknown[]) {
            if (!object(sink) || typeof sink.id !== 'string') throw new Error();
            if (sinkIds.has(sink.id)) problems.push('audit: duplicate sink id');
            sinkIds.add(sink.id);
            if (Array.isArray(sink.envNames)) {
              for (const name of sink.envNames as unknown[]) {
                if (typeof name === 'string') destinations.add(name.toUpperCase());
              }
            }
            if (object(sink.destination)) {
              for (const key of ['urlEnv', 'endpointEnv', 'headersEnv']) {
                const name = sink.destination[key];
                if (typeof name === 'string') destinations.add(name.toUpperCase());
              }
            }
          }
        }
        const trail = snapshot(ownData(plugin, 'auditTrail'));
        if (object(trail) && trail.toggleEnv !== undefined) {
          toggle = true;
          if (typeof trail.toggleEnv === 'string') destinations.add(trail.toggleEnv.toUpperCase());
        }
      } catch {
        malformed = true;
      }
    }
  } catch {
    malformed = true;
  }
  if (malformed) problems.push('audit: sink definitions are malformed');
  return { sinkIds, destinations, toggle };
}

function alertEnv(value: unknown, destinations: ReadonlySet<string>): value is string {
  if (!envName(value)) return false;
  const name = value.toUpperCase();
  return (
    !name.startsWith('PB_') &&
    !name.startsWith('OTEL_EXPORTER_OTLP_') &&
    !CORE_ENV_NAMES.has(name) &&
    !destinations.has(name)
  );
}

function telemetryEndpoint(
  config: BrokerConfig,
  target: Platform,
  destinations: Set<string>,
  problems: string[],
): unknown {
  try {
    const ports = ownData(config, 'platformPorts');
    const platform = object(ports) ? ownData(ports, target) : undefined;
    const telemetry = object(platform) ? ownData(platform, 'observability') : undefined;
    const endpoint = object(telemetry) ? ownData(telemetry, 'endpointEnv') : undefined;
    const headers = object(telemetry) ? ownData(telemetry, 'headersEnv') : undefined;
    for (const name of [endpoint, headers]) {
      if (typeof name === 'string') destinations.add(name.toUpperCase());
    }
    return endpoint;
  } catch {
    problems.push('audit: telemetry configuration is malformed');
    return undefined;
  }
}

export function brokerAuditProblems(config: BrokerConfig, target: Platform): string[] {
  const problems: string[] = [];
  const { sinkIds, destinations } = auditDefinitions(config, problems);
  let value: unknown;
  try {
    value = snapshot(ownData(config, 'audit'));
  } catch {
    return [...problems, 'audit: configuration is malformed'];
  }
  if (value === undefined) return problems;
  if (!object(value)) return [...problems, 'audit: must be an object'];
  const telemetry = telemetryEndpoint(config, target, destinations, problems);
  problems.push(
    ...unknownKeys(
      value,
      ['policy', 'acceptNoDurableAudit', 'capacity', 'alerts', 'egress'],
      'audit',
    ),
  );
  if (
    value.policy !== undefined &&
    !['availability', 'required'].includes(value.policy as string)
  ) {
    problems.push('audit.policy: must be availability or required');
  }
  if (value.acceptNoDurableAudit !== undefined && value.acceptNoDurableAudit !== true) {
    problems.push('audit.acceptNoDurableAudit: must be true when specified');
  }
  if (value.policy === 'required' && value.acceptNoDurableAudit === true) {
    problems.push('audit: required policy forbids acceptNoDurableAudit');
  }

  for (const [name, keys] of [
    ['capacity', ['maxJournalBytes']],
    ['alerts', ['webhookEnv']],
    ['egress', ['allowPrivate']],
  ] as const) {
    const section = value[name];
    if (section === undefined) continue;
    if (!object(section)) {
      problems.push('audit.' + name + ': must be an object');
      continue;
    }
    problems.push(...unknownKeys(section, keys, 'audit.' + name));
    if (name === 'capacity' && section.maxJournalBytes !== undefined) {
      const problem = auditJournalBudgetProblem(section.maxJournalBytes, target);
      if (problem !== null) problems.push(problem);
    }
    if (
      name === 'alerts' &&
      section.webhookEnv !== undefined &&
      !alertEnv(section.webhookEnv, destinations)
    ) {
      problems.push(
        envName(section.webhookEnv)
          ? 'audit.alerts.webhookEnv: must not be a reserved or destination variable'
          : 'audit.alerts.webhookEnv: must be an environment variable name',
      );
    }
    if (name === 'egress' && section.allowPrivate !== undefined) {
      const ids: unknown = section.allowPrivate;
      if (!Array.isArray(ids)) {
        problems.push('audit.egress.allowPrivate: must be a list of sink ids');
      } else {
        if (Array.from(ids).some((id: unknown) => typeof id !== 'string' || !SINK_ID.test(id))) {
          problems.push('audit.egress.allowPrivate: contains an invalid sink id');
        }
        if (new Set(ids).size !== ids.length) {
          problems.push('audit.egress.allowPrivate: sink ids must be unique');
        }
        if (ids.some((id: unknown) => typeof id === 'string' && !sinkIds.has(id))) {
          problems.push('audit.egress.allowPrivate: references an undeclared sink');
        }
        if (ids.length > 0 && target !== 'node') {
          problems.push('audit.egress.allowPrivate: private egress is available only on Node');
        }
      }
    }
  }

  if (value.policy === 'required') {
    const webhook = object(value.alerts) && alertEnv(value.alerts.webhookEnv, destinations);
    if (!webhook && !envName(telemetry)) {
      problems.push('audit: required policy needs a telemetry OTLP endpoint or alerts.webhookEnv');
    }
  }
  return problems;
}

export const AUDIT_WARNING_EVENTS = {
  trail_toggle_ignored: 'audit.trail_toggle_ignored',
  capacity_unbounded: 'audit.capacity_unbounded',
} as const;

export type AuditWarningCode = keyof typeof AUDIT_WARNING_EVENTS;

export interface BrokerAuditWarning {
  readonly code: AuditWarningCode;
  readonly message: string;
}

export function auditWarningEvent(code: AuditWarningCode) {
  return AUDIT_WARNING_EVENTS[code];
}

export function brokerAuditWarnings(config: BrokerConfig, target: Platform): BrokerAuditWarning[] {
  try {
    const audit = snapshot(ownData(config, 'audit'));
    const definitions = auditDefinitions(config, []);
    const warnings: BrokerAuditWarning[] = [];
    if (object(audit) && audit.policy === 'required') {
      if (definitions.toggle)
        warnings.push({
          code: 'trail_toggle_ignored',
          message: 'audit: trail toggleEnv is ignored under required policy',
        });
    } else if (
      target === 'node' &&
      config.plugins.some((plugin) => plugin.auditTrail) &&
      (!object(audit) || !object(audit.capacity) || audit.capacity.maxJournalBytes === undefined)
    ) {
      warnings.push({
        code: 'capacity_unbounded',
        message:
          'audit.capacity.maxJournalBytes: unset; Node audit capacity enforcement is disabled',
      });
    }
    return warnings;
  } catch {
    return [];
  }
}
