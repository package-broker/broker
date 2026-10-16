import { describe, expect, it, vi } from 'vitest';
import { decidePatValidation, describePatValidation } from './pat-validation.js';
import type { PatValidationView } from './pat-validation.js';

const EVIDENCE = '2026-10-16T11:00:00.000Z';

function view(kind: 'pat' | 'svc', validation: PatValidationView['validation']): PatValidationView {
  return { token: { kind }, validation };
}

const sso = (identityId: string | null, fresh: boolean, evidenceAt: string | null = EVIDENCE) =>
  view('pat', { kind: 'sso', identityId, fresh, evidenceAt });
const local = (identityId: string | null, fresh: boolean, evidenceAt: string | null = EVIDENCE) =>
  view('pat', { kind: 'local', identityId, fresh, evidenceAt });

describe('decidePatValidation', () => {
  it('allows a fresh sso PAT bound to an identity', () => {
    expect(decidePatValidation(sso('idn1', true))).toEqual({ allowed: true, mode: 'sso' });
  });

  it('refuses a stale sso PAT', () => {
    expect(decidePatValidation(sso('idn1', false))).toEqual({
      allowed: false,
      mode: 'sso',
      reason: 'stale',
    });
  });

  it('hard-denies an sso PAT whose validation identity is NULL, even when marked fresh', () => {
    expect(decidePatValidation(sso(null, true))).toEqual({
      allowed: false,
      mode: 'sso',
      reason: 'identity_missing',
    });
  });

  it('never resolves an orphaned sso PAT through the local path', () => {
    const result = decidePatValidation(sso(null, true));
    expect(result.mode).toBe('sso');
    expect(result.allowed).toBe(false);
  });

  it('allows a fresh local PAT and refuses a stale one', () => {
    expect(decidePatValidation(local(null, true))).toEqual({ allowed: true, mode: 'local' });
    expect(decidePatValidation(local(null, false))).toEqual({
      allowed: false,
      mode: 'local',
      reason: 'stale',
    });
  });

  it('refuses a local PAT that carries an identity binding', () => {
    expect(decidePatValidation(local('idn1', true))).toEqual({
      allowed: false,
      mode: 'local',
      reason: 'inconsistent',
    });
  });

  it('denies a PAT without a recognised validation origin', () => {
    expect(decidePatValidation(view('pat', null))).toEqual({
      allowed: false,
      mode: 'none',
      reason: 'origin_missing',
    });
    expect(
      decidePatValidation(
        view('pat', { kind: null, identityId: null, fresh: true, evidenceAt: null }),
      ),
    ).toEqual({ allowed: false, mode: 'none', reason: 'origin_missing' });
  });

  it('does not apply to service tokens', () => {
    expect(decidePatValidation(view('svc', null))).toEqual({ allowed: true, mode: 'service' });
  });

  it('is deterministic and does not read the clock', () => {
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('clock read');
    });
    const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('clock read');
    });
    try {
      const access = sso('idn1', true);
      expect(decidePatValidation(access)).toEqual({ allowed: true, mode: 'sso' });
      expect(describePatValidation(access).membershipCheckedAt).toBe(EVIDENCE);
    } finally {
      dateNow.mockRestore();
      performanceNow.mockRestore();
    }
  });
});

describe('describePatValidation', () => {
  it('exposes the freshness mode and the stored evidence time as membershipCheckedAt', () => {
    expect(describePatValidation(sso('idn1', true))).toEqual({
      mode: 'sso',
      fresh: true,
      membershipCheckedAt: EVIDENCE,
    });
    expect(describePatValidation(local(null, false, '2026-10-15T09:00:00.000Z'))).toEqual({
      mode: 'local',
      fresh: false,
      membershipCheckedAt: '2026-10-15T09:00:00.000Z',
    });
  });

  it('reports a null membershipCheckedAt when there is no evidence', () => {
    expect(describePatValidation(sso(null, false, null)).membershipCheckedAt).toBeNull();
    expect(describePatValidation(view('pat', null)).membershipCheckedAt).toBeNull();
  });

  it('reports not fresh for an orphaned sso PAT', () => {
    expect(describePatValidation(sso(null, true)).fresh).toBe(false);
  });

  it('reports service tokens as mode service without evidence', () => {
    expect(describePatValidation(view('svc', null))).toEqual({
      mode: 'service',
      fresh: false,
      membershipCheckedAt: null,
    });
  });
});
