import type { BrokerConfig } from '@package-broker/core';
import {
  AUDIT_NONE_WARNING,
  AuditEffectiveConfigError,
  resolveAuditJournalBudget,
  type AuditMode,
  type AuditPolicy,
  resolveOrgAudit,
  validateAuditBuild,
} from '@package-broker/core/audit/effective';
import { resolveAuditDestination } from '@package-broker/core/audit/sinks/transport';
import {
  auditDestinationNames,
  AUDIT_OTEL_ENDPOINTS,
  auditAlertPathActive,
  auditTelemetryActive,
  validAuditAlertDestination,
} from '@package-broker/core/audit/destinations';
import type { describeAudit } from '../../manifest.js';

function unavailable(): never {
  throw new Error('Audit deployment descriptors cannot create plugins');
}

function invalidConfiguration(): never {
  throw new Error('Invalid audit deployment configuration');
}

type AuditManifest = ReturnType<typeof describeAudit>;
const environmentName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function deploymentAuditConfig(
  value: unknown,
  ports: BrokerConfig['platformPorts'],
): BrokerConfig | null {
  if (value === undefined) return null;
  if (
    !record(value) ||
    !['availability', 'required'].includes(String(value.policy)) ||
    typeof value.acceptNoDurableAudit !== 'boolean' ||
    !Number.isSafeInteger(value.build_generation) ||
    Number(value.build_generation) < 0 ||
    !Array.isArray(value.sinks) ||
    (value.maxJournalBytes !== null && typeof value.maxJournalBytes !== 'number') ||
    (value.trail !== null &&
      (!record(value.trail) ||
        (value.trail.toggleEnv !== null && !environmentName(value.trail.toggleEnv))))
  )
    throw new Error('Invalid audit deployment configuration');
  for (const sink of value.sinks as unknown[]) {
    if (
      !record(sink) ||
      typeof sink.id !== 'string' ||
      !/^[a-z0-9-]{1,32}$/.test(sink.id) ||
      !['build', 'env'].includes(String(sink.activation)) ||
      !['delivery', 'durable'].includes(String(sink.custody)) ||
      !Array.isArray(sink.envNames) ||
      !sink.envNames.every(environmentName) ||
      !record(sink.destination) ||
      !['otlp-http-json', 'https-json'].includes(String(sink.destination.protocol)) ||
      (sink.destination.protocol === 'https-json' && !environmentName(sink.destination.urlEnv)) ||
      ['endpointEnv', 'headersEnv'].some((key) => {
        const destination = sink.destination as Record<string, unknown>;
        return destination[key] !== undefined && !environmentName(destination[key]);
      })
    )
      throw new Error('Invalid audit deployment configuration');
  }
  const audit = value as AuditManifest;
  return {
    platform: 'cloudflare',
    plugins: [
      {
        id: 'audit-deployment',
        package: '@package-broker/cli',
        platforms: ['cloudflare'],
        apiVersion: 4,
        ...(audit.trail === null
          ? {}
          : {
              auditTrail:
                audit.trail.toggleEnv === null
                  ? { create: unavailable }
                  : { toggleEnv: audit.trail.toggleEnv, create: unavailable },
            }),
        auditSinks: audit.sinks.map((sink) => ({ ...sink, sourceIp: 'omit', create: unavailable })),
      },
    ],
    audit: {
      policy: audit.policy,
      ...(audit.acceptNoDurableAudit ? { acceptNoDurableAudit: true } : {}),
      ...(audit.maxJournalBytes === null
        ? {}
        : { capacity: { maxJournalBytes: audit.maxJournalBytes } }),
      ...(audit.alerts === null ? {} : { alerts: audit.alerts }),
      ...(audit.egress === null ? {} : { egress: audit.egress }),
    },
    ...(ports === undefined ? {} : { platformPorts: ports }),
  };
}

const INSTALLED = 'installed, not re-validated' as const;

export interface DeploymentAuditPrediction {
  readonly scope: 'build-level';
  readonly storedPolicy: 'A stored required policy is enforced at run time';
  readonly mode: AuditMode | typeof INSTALLED;
  readonly policy: AuditPolicy | typeof INSTALLED;
  readonly maxJournalBytes: number | null;
  readonly sinks: readonly {
    readonly id: string;
    readonly state: 'active' | 'inactive' | typeof INSTALLED;
  }[];
  readonly warnings: readonly string[];
}

export interface DeploymentAuditPlanEntry {
  readonly stage: 'deploy';
  readonly action: 'predicted_audit';
  readonly audit: DeploymentAuditPrediction;
  readonly name?: never;
  readonly kind?: never;
  readonly jurisdiction?: never;
}

class InstalledAuditValue extends Error {}

export async function predictDeploymentAudit(
  config: BrokerConfig | null,
  delivered: Readonly<Record<string, string | undefined>>,
  installedNames: readonly string[],
): Promise<DeploymentAuditPrediction | null> {
  const sinks = config?.plugins.flatMap((plugin) => plugin.auditSinks ?? []) ?? [];
  const allowed = new Set(
    sinks.flatMap((sink) => {
      const names = auditDestinationNames(sink.destination);
      return [...(sink.envNames ?? []), names.endpoint, ...(names.headers ? [names.headers] : [])];
    }),
  );
  const toggle = config?.plugins.find((plugin) => plugin.auditTrail)?.auditTrail?.toggleEnv;
  if (config?.plugins.some((plugin) => plugin.auditTrail)) allowed.add('PB_AUDIT_TRAIL');
  if (toggle !== undefined) allowed.add(toggle);
  for (const name of [...Object.keys(delivered), ...installedNames]) {
    if (/^PB_AUDIT_(OTLP_|WEBHOOK_|TRAIL$)/.test(name) && !allowed.has(name))
      throw new Error('Audit secrets are configured for a sink absent from this build');
  }
  if (config === null) return null;
  const installed = new Set(installedNames);
  const read = (name: string) => (Object.hasOwn(delivered, name) ? delivered[name] : undefined);
  const unknown = (name: string) => installed.has(name) && read(name) === undefined;
  const present = (name: string) => Boolean(read(name)) || unknown(name);
  const required = (name: string) => {
    if (!present(name)) throw new Error(`Missing audit environment variable: ${name}`);
  };
  try {
    const maxJournalBytes = resolveAuditJournalBudget(
      config.audit,
      'cloudflare',
      read('PB_AUDIT_POLICY'),
    );
    const warnings: string[] = [];
    const build = (() => {
      try {
        return validateAuditBuild(config, read, 'cloudflare');
      } catch (error) {
        if (!(error instanceof AuditEffectiveConfigError) || error.code !== 'none_not_accepted')
          throw error;
        return {
          ...validateAuditBuild(
            { ...config, audit: { ...config.audit, acceptNoDurableAudit: true } },
            read,
            'cloudflare',
          ),
          accepted: false,
          acceptanceSource: null,
        };
      }
    })();
    if (toggle !== undefined) required(toggle);
    const alert = config.audit?.alerts?.webhookEnv;
    if (alert !== undefined) {
      required(alert);
      if (!unknown(alert) && !validAuditAlertDestination(read(alert)))
        return invalidConfiguration();
    }
    const states: { id: string; state: 'active' | 'inactive' | typeof INSTALLED }[] = [];
    for (const sink of sinks) {
      const names = auditDestinationNames(sink.destination);
      const otlp = sink.destination.protocol === 'otlp-http-json';
      const endpointNames =
        otlp && !AUDIT_OTEL_ENDPOINTS.some((name) => name === names.endpoint)
          ? [names.endpoint, ...AUDIT_OTEL_ENDPOINTS]
          : [names.endpoint];
      if (names.headers !== undefined && present(names.headers) && !present(names.endpoint))
        required(names.endpoint);
      const endpoint = endpointNames.find(present);
      if (
        endpoint === undefined &&
        otlp &&
        ['OTEL_EXPORTER_OTLP_LOGS_HEADERS', 'OTEL_EXPORTER_OTLP_HEADERS'].some(present)
      )
        required(names.endpoint);
      const headers =
        endpoint !== undefined && endpoint !== names.endpoint
          ? (['OTEL_EXPORTER_OTLP_LOGS_HEADERS', 'OTEL_EXPORTER_OTLP_HEADERS'].find(present) ??
            'OTEL_EXPORTER_OTLP_HEADERS')
          : names.headers;
      if (
        sink.activation === 'build' ||
        endpoint !== undefined ||
        (headers !== undefined && present(headers))
      ) {
        required(endpoint ?? names.endpoint);
        if (headers !== undefined) required(headers);
        for (const name of sink.envNames ?? []) required(name);
      }
      let state: 'active' | 'inactive' | typeof INSTALLED;
      try {
        const destination = await resolveAuditDestination({
          id: sink.id,
          runtime: 'cloudflare',
          ...(config.audit === undefined ? {} : { audit: config.audit }),
          destination: sink.destination,
          activation: sink.activation,
          env: (name) => {
            if (unknown(name)) throw new InstalledAuditValue();
            return read(name);
          },
        });
        state =
          destination === null
            ? 'inactive'
            : (sink.envNames ?? []).some(unknown)
              ? INSTALLED
              : 'active';
      } catch (error) {
        if (!(error instanceof InstalledAuditValue)) throw error;
        state = INSTALLED;
      }
      states.push({ id: sink.id, state });
    }
    const telemetry = config.platformPorts?.cloudflare?.observability.endpointEnv;
    const effective = resolveOrgAudit({
      build,
      storedPolicy: null,
      sinks: states.map((sink) => ({
        ...sink,
        state: sink.state === INSTALLED ? 'active' : sink.state,
      })),
      alertPathActive: auditAlertPathActive(
        telemetry !== undefined && (unknown(telemetry) || auditTelemetryActive(read(telemetry))),
        alert !== undefined && unknown(alert)
          ? INSTALLED
          : alert === undefined
            ? undefined
            : read(alert),
      ),
    });
    if (!effective.ok && effective.code !== 'none_not_accepted') return invalidConfiguration();
    if (!effective.ok)
      warnings.push(
        `WARNING: none_not_accepted. ${AUDIT_NONE_WARNING} Writes are fenced at run time; first-admin setup is exempt.`,
      );
    if (
      states.some((sink) => sink.state === INSTALLED) ||
      [toggle, alert, 'PB_AUDIT_POLICY', 'PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT'].some(
        (name) => name !== undefined && unknown(name),
      )
    )
      warnings.push(
        'Installed audit configuration is not re-validated; its values are enforced at run time.',
      );
    return {
      scope: 'build-level',
      storedPolicy: 'A stored required policy is enforced at run time',
      mode:
        (toggle !== undefined && unknown(toggle) && build.policy !== 'required') ||
        unknown('PB_AUDIT_POLICY')
          ? INSTALLED
          : effective.ok
            ? effective.effective.mode
            : 'none',
      policy: unknown('PB_AUDIT_POLICY') ? INSTALLED : build.policy,
      maxJournalBytes,
      sinks: states,
      warnings,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Missing audit environment variable: '))
      throw error;
    return invalidConfiguration();
  }
}
