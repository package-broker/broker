import type { DbErrorKind } from '../db/errors.js';
import { INPUT_PLUGIN } from './authorize.js';

// Object.freeze alone leaves Set.prototype.add/delete/clear working, so they are overridden before freezing.
function frozenSet(values: readonly string[]): ReadonlySet<string> {
  const set = new Set(values);
  for (const method of ['add', 'delete', 'clear'] as const) {
    Object.defineProperty(set, method, {
      value: () => {
        throw new TypeError('Kernel vocabulary is frozen');
      },
    });
  }
  return Object.freeze(set);
}

export const KERNEL_EVENTS = frozenSet([
  'http.request',
  'http.error',
  'health.schema_drift',
  'authz.denied',
  'authz.error',
]);

export const AUDIT_EVENTS = frozenSet([
  'audit.effective_unavailable',
  'audit.trail_toggle_ignored',
  'audit.capacity_unbounded',
  'audit.sink_admin_refused',
  'audit.alert',
  'audit.failure_event_invalid',
  'audit.failure_event_failed',
  'audit.failure_event_refused',
  'audit.failure_events_cap',
  'audit.sealed',
  'audit.delivery_partial_success',
  'audit.delivery_loss',
  'audit.chain_integrity',
  'audit.seal_repaired',
  'audit.seal.contended',
  'audit.verified',
  'audit.chain_broken',
  'audit.verify_partial',
  'audit.verify_continued',
  'audit.loss',
]);

const REASON_CODES = [
  'audit.effective_unavailable',
  'no_ip_key_saturated',
  'org_cap_reached',
  'authz.unauthenticated',
  'authz.forbidden',
  'authz.not_found',
  'authz.engine_error',
  'authz.input_invalid',
  'hook.denied',
  'hook.invalid_result',
  'hook.error',
  'route.not_found',
  'error.not_bootstrapped',
  'error.misconfigured',
  'error.unavailable',
  'error.audit_backlog_full',
  'error.internal',
  'error.upstream_refused',
  'db.unique',
  'db.foreign_key',
  'db.not_null',
  'db.check',
  'db.busy',
  'db.backlog_full',
  'db.too_big',
  'db.unknown',
  'health.not_ready',
  'request.aborted',
  'http.handler_status',
  'audit.restore_detected',
  'audit.local_fork',
  'audit.receiver_fork',
  'audit.history_limit',
  'audit.batch_limit',
  'audit.partial_success',
  'audit.skipped',
  'audit.marker_rejected',
  'audit.uncertain',
  'audit.blocked',
  'audit.withheld',
  'audit.capacity',
  'audit.hold_failed',
  'audit.prune_anchor',
  'audit.gap',
  'audit.fork',
  'audit.pending_old',
  'audit.mode_change',
  'audit.policy_change',
  'audit.sink_inactive',
  'audit.config_invalid',
  'audit.mode_none',
  'audit.trail_toggle_ignored',
  'audit.capacity_unbounded',
  'audit.chain_integrity',
] as const;

export type KernelReasonCode = (typeof REASON_CODES)[number];

export const KERNEL_REASON_CODES = frozenSet(REASON_CODES);

export function engineStatusReason(status: number): KernelReasonCode {
  if (status === 401) return 'authz.unauthenticated';
  if (status === 404) return 'authz.not_found';
  return 'authz.forbidden';
}

export function isEngineFailure(code: KernelReasonCode): boolean {
  return code === 'authz.engine_error' || code === 'authz.input_invalid';
}

export function denyReason(reason: string): KernelReasonCode {
  if (reason === 'invalid_hook_result') return 'hook.invalid_result';
  if (reason === 'hook_error') return 'hook.error';
  return 'hook.denied';
}

export function hookErrorReason(plugin: string, enginePlugin: string): KernelReasonCode {
  if (plugin === enginePlugin) return 'authz.engine_error';
  if (plugin === INPUT_PLUGIN) return 'authz.input_invalid';
  return 'hook.error';
}

const ENVELOPE_REASONS: ReadonlyMap<string, KernelReasonCode> = new Map([
  ['not_bootstrapped', 'error.not_bootstrapped'],
  ['misconfigured', 'error.misconfigured'],
  ['unavailable', 'error.unavailable'],
  ['audit_backlog_full', 'error.audit_backlog_full'],
  ['upstream_refused', 'error.upstream_refused'],
]);

export function envelopeReason(code: string): KernelReasonCode {
  return ENVELOPE_REASONS.get(code) ?? 'error.internal';
}

const DB_REASONS: Readonly<Record<DbErrorKind, KernelReasonCode>> = {
  unique: 'db.unique',
  foreign_key: 'db.foreign_key',
  not_null: 'db.not_null',
  check: 'db.check',
  busy: 'db.busy',
  backlog_full: 'db.backlog_full',
  too_big: 'db.too_big',
  unknown: 'db.unknown',
};

export function dbReason(kind: DbErrorKind): KernelReasonCode {
  return Object.hasOwn(DB_REASONS, kind) ? DB_REASONS[kind] : 'db.unknown';
}

const OUTCOME_CODES: ReadonlySet<string> = new Set([
  'authz.unauthenticated',
  'authz.forbidden',
  'authz.not_found',
]);

function rank(code: KernelReasonCode | undefined): number {
  if (code === undefined) return 0;
  return OUTCOME_CODES.has(code) ? 1 : 2;
}

export function mostSpecificReason(
  current: KernelReasonCode | undefined,
  next: KernelReasonCode | undefined,
): KernelReasonCode | undefined {
  return rank(next) >= rank(current) ? (next ?? current) : current;
}
