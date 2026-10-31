import type { BrokerConfig } from '../config.js';
import type { Platform } from '../plugin.js';
import {
  auditJournalBudgetProblem,
  brokerAuditProblems,
  DEFAULT_CLOUDFLARE_AUDIT_JOURNAL_BYTES,
  snapshotAuditBuildConfig,
} from './config.js';

export type AuditPolicy = 'availability' | 'required';
export type AuditMode = 'trail' | 'export' | 'none';

export type AuditEffectiveConfigErrorCode =
  | 'invalid_config'
  | 'invalid_policy_env'
  | 'invalid_acceptance_env'
  | 'invalid_trail_env'
  | 'journal_budget_required'
  | 'required_acceptance'
  | 'durable_path_required'
  | 'alert_path_required'
  | 'none_not_accepted';

export type OrgAuditRefusalCode =
  | 'invalid_stored_policy'
  | 'invalid_sink_state'
  | 'journal_budget_required'
  | 'required_acceptance'
  | 'durable_path_required'
  | 'alert_path_required'
  | 'none_not_accepted';

export class AuditEffectiveConfigError extends Error {
  constructor(readonly code: AuditEffectiveConfigErrorCode) {
    super('Invalid effective audit configuration');
    this.name = 'AuditEffectiveConfigError';
  }
}

export interface EffectiveAuditConfig {
  readonly policy: AuditPolicy;
  readonly policySource: 'build' | 'env' | 'stored';
  readonly persistRaise: boolean;
  readonly mode: AuditMode;
  readonly trailActive: boolean;
  /** Present sinks include blocked sinks so recovery operations remain available. */
  readonly activeSinkIds: readonly string[];
  readonly blockedSinkIds: readonly string[];
  readonly durableSinkIds: readonly string[];
  readonly durablePath: boolean;
  readonly maxJournalBytes: number | null;
  readonly warnings: readonly string[];
}

const validatedAuditBuild = Symbol('ValidatedAuditBuild');

export interface ValidatedAuditBuild {
  readonly [validatedAuditBuild]: true;
  readonly policy: AuditPolicy;
  readonly policySource: 'build' | 'env';
  readonly accepted: boolean;
  /** Build acceptance takes precedence when both sources accept. */
  readonly acceptanceSource: 'build' | 'env' | null;
  readonly trailPresent: boolean;
  readonly trailToggleConfigured: boolean;
  readonly trailEnabled: boolean;
  readonly sinks: readonly { readonly id: string; readonly custody: 'delivery' | 'durable' }[];
  readonly maxJournalBytes: number | null;
}

export interface OrgAuditOptions {
  readonly build: ValidatedAuditBuild;
  /** Read this organization's chain row; null means no row yet. Persist raises before work. */
  readonly storedPolicy: AuditPolicy | null;
  /** Destination resolution and lifecycle reconciliation precede this step. Missing sinks are inactive. */
  readonly sinks: readonly {
    readonly id: string;
    readonly state: 'active' | 'inactive' | 'blocked' | 'disabled' | 'retired';
  }[];
  /** True only after a configured telemetry or alert webhook path was resolved and validated. */
  readonly alertPathActive: boolean;
}

export type OrgAuditResult =
  | { readonly ok: true; readonly effective: EffectiveAuditConfig }
  | { readonly ok: false; readonly code: OrgAuditRefusalCode; readonly persistRaise: boolean };

export const AUDIT_NONE_WARNING =
  'Security events are not durably retained by this broker. Exporting previous history does not cover future activity.';

/** Resolves the shared budget before repositories or capacity jobs are constructed. */
export function resolveAuditJournalBudget(
  audit: BrokerConfig['audit'],
  target: Platform,
  policyEnv?: string,
): number | null {
  const budget =
    audit?.capacity?.maxJournalBytes ??
    (target === 'cloudflare' ? DEFAULT_CLOUDFLARE_AUDIT_JOURNAL_BYTES : null);
  if (budget !== null && auditJournalBudgetProblem(budget, target) !== null) {
    throw new AuditEffectiveConfigError('invalid_config');
  }
  if ((audit?.policy === 'required' || policyEnv === 'required') && budget === null) {
    throw new AuditEffectiveConfigError('journal_budget_required');
  }
  return budget;
}

/** Deployment validation never reads organization state or creates plugins. */
export function validateAuditBuild(
  config: BrokerConfig,
  env: (name: string) => string | undefined,
  target: Platform,
): ValidatedAuditBuild {
  let captured: BrokerConfig;
  try {
    captured = snapshotAuditBuildConfig(config, target);
  } catch {
    throw new AuditEffectiveConfigError('invalid_config');
  }
  const alertConfigured =
    captured.audit?.alerts?.webhookEnv !== undefined ||
    captured.platformPorts?.[target]?.observability?.endpointEnv !== undefined;
  const problems = brokerAuditProblems(captured, target);
  const missingBuildAlert = captured.audit?.policy === 'required' && !alertConfigured;
  // Static validation also reports the missing build alert; give that case its boot code.
  if (captured.platform !== target || problems.length > (missingBuildAlert ? 1 : 0)) {
    throw new AuditEffectiveConfigError('invalid_config');
  }
  const policyEnv = env('PB_AUDIT_POLICY');
  if (policyEnv !== undefined && policyEnv !== 'required' && policyEnv !== 'availability') {
    throw new AuditEffectiveConfigError('invalid_policy_env');
  }
  const policy =
    captured.audit?.policy === 'required' || policyEnv === 'required' ? 'required' : 'availability';
  const acceptanceEnv = env('PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT');
  if (acceptanceEnv !== undefined && acceptanceEnv !== 'true' && acceptanceEnv !== 'false') {
    throw new AuditEffectiveConfigError('invalid_acceptance_env');
  }
  const trails = captured.plugins.flatMap((plugin) =>
    plugin.auditTrail ? [plugin.auditTrail] : [],
  );
  if (trails.length > 1) throw new AuditEffectiveConfigError('invalid_config');
  const trail = trails[0];
  const toggle = trail?.toggleEnv === undefined ? undefined : env(trail.toggleEnv);
  if (policy !== 'required' && toggle !== undefined && toggle !== 'on' && toggle !== 'off') {
    throw new AuditEffectiveConfigError('invalid_trail_env');
  }
  const maxJournalBytes = resolveAuditJournalBudget(captured.audit, target, policyEnv);
  if (trail !== undefined && maxJournalBytes === null) {
    throw new AuditEffectiveConfigError('journal_budget_required');
  }
  const sinks = captured.plugins.flatMap((plugin) => plugin.auditSinks ?? []);
  if (
    policy === 'required' &&
    trail === undefined &&
    !sinks.some((sink) => sink.custody === 'durable')
  ) {
    throw new AuditEffectiveConfigError('durable_path_required');
  }
  const accepted = captured.audit?.acceptNoDurableAudit === true || acceptanceEnv === 'true';
  if (policy === 'required' && accepted) throw new AuditEffectiveConfigError('required_acceptance');
  if (policy === 'required' && !alertConfigured) {
    throw new AuditEffectiveConfigError('alert_path_required');
  }
  if (
    policy === 'availability' &&
    sinks.length === 0 &&
    (trail === undefined || toggle === 'off') &&
    !accepted
  ) {
    throw new AuditEffectiveConfigError('none_not_accepted');
  }
  return Object.freeze({
    [validatedAuditBuild]: true as const,
    policy,
    policySource: policyEnv === 'required' ? 'env' : 'build',
    accepted,
    acceptanceSource:
      captured.audit?.acceptNoDurableAudit === true
        ? 'build'
        : acceptanceEnv === 'true'
          ? 'env'
          : null,
    trailPresent: trail !== undefined,
    trailToggleConfigured: trail?.toggleEnv !== undefined,
    trailEnabled: trail !== undefined && toggle !== 'off',
    sinks: Object.freeze(sinks.map(({ id, custody }) => Object.freeze({ id, custody }))),
    maxJournalBytes,
  });
}

/** A refusal fences this organization's audit-requiring writes; other organizations can continue. */
export function resolveOrgAudit(options: OrgAuditOptions): OrgAuditResult {
  const { build, storedPolicy } = options;
  if (storedPolicy !== 'required' && storedPolicy !== 'availability' && storedPolicy !== null) {
    return { ok: false, code: 'invalid_stored_policy', persistRaise: build.policy === 'required' };
  }
  const policy = storedPolicy === 'required' ? 'required' : build.policy;
  const policySource = storedPolicy === 'required' ? 'stored' : build.policySource;
  const persistRaise = policy === 'required' && storedPolicy !== 'required';
  const refuse = (code: OrgAuditRefusalCode): OrgAuditResult => ({ ok: false, code, persistRaise });
  if (policy === 'required' && build.accepted) return refuse('required_acceptance');
  if (policy === 'required' && build.maxJournalBytes === null) {
    return refuse('journal_budget_required');
  }
  const trailActive = build.trailPresent && (policy === 'required' || build.trailEnabled);
  const warnings: string[] = [];
  if (policy === 'required' && build.trailToggleConfigured) {
    warnings.push('audit: trail toggleEnv is ignored under required policy');
  }
  const states = new Map(options.sinks.map((sink) => [sink.id, sink.state]));
  if (
    states.size !== options.sinks.length ||
    options.sinks.some(
      (sink) =>
        sink.state !== 'disabled' &&
        sink.state !== 'retired' &&
        !build.sinks.some((definition) => definition.id === sink.id),
    )
  ) {
    return refuse('invalid_sink_state');
  }
  const active = build.sinks.filter((sink) => {
    const state = states.get(sink.id);
    return state === 'active' || state === 'blocked';
  });
  const durable = active.filter((sink) => sink.custody === 'durable');
  const durablePath = trailActive || durable.length > 0;
  const mode = trailActive ? 'trail' : active.length > 0 ? 'export' : 'none';
  if (policy === 'required') {
    if (!durablePath) return refuse('durable_path_required');
    if (!options.alertPathActive) return refuse('alert_path_required');
  }
  if (mode === 'none') {
    if (!build.accepted) return refuse('none_not_accepted');
    warnings.push(AUDIT_NONE_WARNING);
  }
  return {
    ok: true,
    effective: {
      policy,
      policySource,
      persistRaise,
      mode,
      trailActive,
      activeSinkIds: active.map((sink) => sink.id),
      blockedSinkIds: active
        .filter((sink) => states.get(sink.id) === 'blocked')
        .map((sink) => sink.id),
      durableSinkIds: durable.map((sink) => sink.id),
      durablePath,
      maxJournalBytes: build.maxJournalBytes,
      warnings,
    },
  };
}
