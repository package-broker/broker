import { describe, expect, it, vi } from 'vitest';
import { assertFinalizeAllowed, DEFAULT_MAX_ABSENCE_SHARE } from './finalize-guard.js';

describe('finalize candidate evidence', () => {
  it('defaults to a quarter with no small-run exemption', () => {
    expect(DEFAULT_MAX_ABSENCE_SHARE).toBe(0.25);
    expect(() =>
      assertFinalizeAllowed(1, {
        attemptedCandidates: 2,
        successfulCandidates: 1,
        definitiveAbsent: 1,
      }),
    ).toThrow('sync stopped');
  });

  it('allows the exact share boundary', () => {
    expect(() =>
      assertFinalizeAllowed(3, {
        attemptedCandidates: 4,
        successfulCandidates: 3,
        definitiveAbsent: 1,
      }),
    ).not.toThrow();
  });

  it('allows an authenticated empty listing without authorizing a sweep', () => {
    expect(() =>
      assertFinalizeAllowed(0, {
        attemptedCandidates: 0,
        successfulCandidates: 0,
        definitiveAbsent: 0,
      }),
    ).not.toThrow();
  });

  it('refuses all-failed candidates instead of treating them as an empty listing', () => {
    expect(() =>
      assertFinalizeAllowed(0, {
        attemptedCandidates: 4,
        successfulCandidates: 0,
        definitiveAbsent: 0,
      }),
    ).toThrow('no successful candidates');
  });

  it('refuses missing evidence', () => {
    expect(() => assertFinalizeAllowed(1, undefined as never)).toThrow();
  });

  it('refuses a successful count that differs from the marked count', () => {
    expect(() =>
      assertFinalizeAllowed(1, {
        attemptedCandidates: 4,
        successfulCandidates: 2,
        definitiveAbsent: 0,
      }),
    ).toThrow('candidate count mismatch');
  });

  it.each([
    { attemptedCandidates: -1, successfulCandidates: 0, definitiveAbsent: 0 },
    { attemptedCandidates: 1.5, successfulCandidates: 1, definitiveAbsent: 0 },
    { attemptedCandidates: 1, successfulCandidates: -1, definitiveAbsent: 0 },
    { attemptedCandidates: 1, successfulCandidates: 1, definitiveAbsent: -1 },
    { attemptedCandidates: 1, successfulCandidates: 1, definitiveAbsent: 1 },
  ])('rejects invalid evidence %j', (evidence) => {
    expect(() => assertFinalizeAllowed(1, evidence)).toThrow(RangeError);
  });

  it('counts and records a guard refusal without including source or package data', () => {
    const observability = { counter: vi.fn(), log: vi.fn() };
    expect(() =>
      assertFinalizeAllowed(
        2,
        {
          attemptedCandidates: 4,
          successfulCandidates: 2,
          definitiveAbsent: 2,
        },
        { observability },
      ),
    ).toThrow('sync stopped');
    expect(observability.counter).toHaveBeenCalledExactlyOnceWith(
      'pb.ingest.mass_absence',
      undefined,
      1,
    );
    expect(observability.log).toHaveBeenCalledExactlyOnceWith({
      level: 'warn',
      event: 'ingest.mass_absence',
      reason_code: 'mass_absence',
    });
  });

  it('counts mass absence when every candidate is definitively absent', () => {
    const observability = { counter: vi.fn(), log: vi.fn() };
    expect(() =>
      assertFinalizeAllowed(
        0,
        {
          attemptedCandidates: 4,
          successfulCandidates: 0,
          definitiveAbsent: 4,
        },
        { observability },
      ),
    ).toThrow('sync stopped');
    expect(observability.counter).toHaveBeenCalledTimes(1);
    expect(observability.log).toHaveBeenCalledTimes(1);
  });

  it('honors a configured share', () => {
    expect(() =>
      assertFinalizeAllowed(
        2,
        {
          attemptedCandidates: 4,
          successfulCandidates: 2,
          definitiveAbsent: 2,
        },
        { maxAbsenceShare: 0.5 },
      ),
    ).not.toThrow();
  });
});
