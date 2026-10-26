import { describe, expect, it } from 'vitest';
import type { DbErrorKind } from '../db/errors.js';
import { INPUT_PLUGIN } from './authorize.js';
import {
  AUDIT_EVENTS,
  KERNEL_EVENTS,
  KERNEL_REASON_CODES,
  dbReason,
  denyReason,
  engineStatusReason,
  isEngineFailure,
  envelopeReason,
  hookErrorReason,
  mostSpecificReason,
} from './obs-codes.js';

const CODE = /^[a-z][a-z0-9_.]{0,63}$/;
const ENGINE = 'core:authorization';

describe('vocabularies', () => {
  it('has exactly the 5 audit events', () => {
    expect([...AUDIT_EVENTS].sort()).toEqual([
      'audit.chain_broken',
      'audit.seal.contended',
      'audit.sealed',
      'audit.verified',
      'audit.verify_partial',
    ]);
    expect(Object.isFrozen(AUDIT_EVENTS)).toBe(true);
    for (const value of AUDIT_EVENTS) expect(value).toMatch(CODE);
    expect(() => (AUDIT_EVENTS as Set<string>).add('x.y')).toThrow();
    expect(() => (AUDIT_EVENTS as Set<string>).delete('audit.sealed')).toThrow();
    expect(() => (AUDIT_EVENTS as Set<string>).clear()).toThrow();
    expect(AUDIT_EVENTS.size).toBe(5);
  });

  it('has exactly the 5 kernel events', () => {
    expect([...KERNEL_EVENTS].sort()).toEqual(
      ['authz.denied', 'authz.error', 'health.schema_drift', 'http.error', 'http.request'].sort(),
    );
  });

  it('has exactly the 24 reason codes', () => {
    expect([...KERNEL_REASON_CODES].sort()).toEqual(
      [
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
        'error.upstream_refused',
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
      ].sort(),
    );
    expect(KERNEL_REASON_CODES.size).toBe(24);
  });

  it('matches the port CODE pattern for every value', () => {
    for (const value of [...KERNEL_EVENTS, ...KERNEL_REASON_CODES]) {
      expect(value).toMatch(CODE);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(KERNEL_EVENTS)).toBe(true);
    expect(Object.isFrozen(KERNEL_REASON_CODES)).toBe(true);
    expect(() => (KERNEL_EVENTS as Set<string>).add('x.y')).toThrow();
    expect(() => (KERNEL_REASON_CODES as Set<string>).delete('hook.error')).toThrow();
    expect(KERNEL_EVENTS.has('x.y')).toBe(false);
  });
});

describe('mapping functions', () => {
  it.each([
    [401, 'authz.unauthenticated'],
    [403, 'authz.forbidden'],
    [404, 'authz.not_found'],
  ])('maps engine status %i to %s', (status, code) => {
    expect(engineStatusReason(status)).toBe(code);
  });

  it('maps an unexpected engine status to authz.forbidden', () => {
    expect(engineStatusReason(418)).toBe('authz.forbidden');
  });

  it.each([
    ['invalid_hook_result', 'hook.invalid_result'],
    ['hook_error', 'hook.error'],
    ['plan limit reached for acme', 'hook.denied'],
    ['', 'hook.denied'],
  ])('maps deny reason %j to %s without carrying the text', (reason, code) => {
    expect(denyReason(reason)).toBe(code);
  });

  it.each([
    ['authz.engine_error', true],
    ['authz.input_invalid', true],
    ['authz.forbidden', false],
    ['authz.unauthenticated', false],
    ['authz.not_found', false],
    ['hook.error', false],
    ['hook.denied', false],
  ] as const)('classifies %s as an engine failure: %s', (code, failure) => {
    expect(isEngineFailure(code)).toBe(failure);
  });

  it('maps hook error plugin labels', () => {
    expect(hookErrorReason(ENGINE, ENGINE)).toBe('authz.engine_error');
    expect(hookErrorReason(INPUT_PLUGIN, ENGINE)).toBe('authz.input_invalid');
    expect(hookErrorReason('acme-billing', ENGINE)).toBe('hook.error');
  });

  it.each([
    ['not_bootstrapped', 'error.not_bootstrapped'],
    ['misconfigured', 'error.misconfigured'],
    ['unavailable', 'error.unavailable'],
    ['internal', 'error.internal'],
    ['something_else', 'error.internal'],
  ])('maps envelope code %s to %s', (code, reason) => {
    expect(envelopeReason(code)).toBe(reason);
  });

  it.each<DbErrorKind>([
    'unique',
    'foreign_key',
    'not_null',
    'check',
    'busy',
    'too_big',
    'unknown',
  ])('maps DbError kind %s to db.%s', (kind) => {
    expect(dbReason(kind)).toBe(`db.${kind}`);
  });

  it('maps an unrecognized DbError kind to db.unknown', () => {
    expect(dbReason('exotic' as DbErrorKind)).toBe('db.unknown');
    expect(dbReason('constructor' as DbErrorKind)).toBe('db.unknown');
  });

  it('only returns registered codes', () => {
    const results = [
      engineStatusReason(500),
      denyReason('free text'),
      hookErrorReason('p', ENGINE),
      envelopeReason('zzz'),
      dbReason('zzz' as DbErrorKind),
    ];
    for (const code of results) expect(KERNEL_REASON_CODES.has(code)).toBe(true);
  });
});

describe('mostSpecificReason', () => {
  it('prefers a hook code over authz.forbidden', () => {
    expect(mostSpecificReason('authz.forbidden', 'hook.denied')).toBe('hook.denied');
    expect(mostSpecificReason('hook.error', 'authz.forbidden')).toBe('hook.error');
  });

  it('prefers authz.engine_error over authz.forbidden', () => {
    expect(mostSpecificReason('authz.forbidden', 'authz.engine_error')).toBe('authz.engine_error');
    expect(mostSpecificReason('authz.engine_error', 'authz.forbidden')).toBe('authz.engine_error');
  });

  it('prefers authz.input_invalid over authz.forbidden', () => {
    expect(mostSpecificReason('authz.forbidden', 'authz.input_invalid')).toBe(
      'authz.input_invalid',
    );
  });

  it('prefers any code over undefined', () => {
    expect(mostSpecificReason(undefined, 'route.not_found')).toBe('route.not_found');
    expect(mostSpecificReason('route.not_found', undefined)).toBe('route.not_found');
    expect(mostSpecificReason(undefined, undefined)).toBeUndefined();
  });

  it('keeps the later code when both are equally specific', () => {
    expect(mostSpecificReason('hook.denied', 'hook.error')).toBe('hook.error');
    expect(mostSpecificReason('error.internal', 'health.not_ready')).toBe('health.not_ready');
  });

  it('ranks the outcome codes below the failure and hook codes', () => {
    for (const weak of ['authz.unauthenticated', 'authz.forbidden', 'authz.not_found'] as const) {
      for (const strong of [
        'authz.engine_error',
        'authz.input_invalid',
        'hook.denied',
        'hook.invalid_result',
        'hook.error',
      ] as const) {
        expect(mostSpecificReason(weak, strong)).toBe(strong);
        expect(mostSpecificReason(strong, weak)).toBe(strong);
      }
    }
  });
});
