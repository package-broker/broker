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
  'authz.denied',
  'authz.error',
]);

const REASON_CODES = [
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
  'error.internal',
  'db.unique',
  'db.foreign_key',
  'db.not_null',
  'db.check',
  'db.busy',
  'db.too_big',
  'db.unknown',
  'health.not_ready',
  'request.aborted',
  'http.handler_status',
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
