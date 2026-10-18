import { describe, expect, it } from 'vitest';
import { MassAbsenceError, assertNoMassAbsence, exceedsAbsenceShare } from './absence-guard.js';

describe('exceedsAbsenceShare', () => {
  const policy = { maxShare: 0.25, minPackages: 0 };

  it('allows a share at or below the limit', () => {
    expect(exceedsAbsenceShare({ total: 100, definitiveAbsent: 0 }, policy)).toBe(false);
    expect(exceedsAbsenceShare({ total: 100, definitiveAbsent: 25 }, policy)).toBe(false);
  });

  it('trips on a share above the limit', () => {
    expect(exceedsAbsenceShare({ total: 100, definitiveAbsent: 26 }, policy)).toBe(true);
    expect(exceedsAbsenceShare({ total: 4, definitiveAbsent: 4 }, policy)).toBe(true);
  });

  it('allows 29 of 100 at 0.29 and rejects 30', () => {
    expect(
      exceedsAbsenceShare({ total: 100, definitiveAbsent: 29 }, { maxShare: 0.29, minPackages: 0 }),
    ).toBe(false);
    expect(
      exceedsAbsenceShare({ total: 100, definitiveAbsent: 30 }, { maxShare: 0.29, minPackages: 0 }),
    ).toBe(true);
  });

  it('never trips on an empty sync', () => {
    expect(exceedsAbsenceShare({ total: 0, definitiveAbsent: 0 }, policy)).toBe(false);
  });

  it('skips the guard below the configured sample size', () => {
    const small = { maxShare: 0.25, minPackages: 10 };
    expect(exceedsAbsenceShare({ total: 9, definitiveAbsent: 9 }, small)).toBe(false);
    expect(exceedsAbsenceShare({ total: 10, definitiveAbsent: 10 }, small)).toBe(true);
  });

  it('allows everything at a limit of 1 and nothing at 0', () => {
    expect(
      exceedsAbsenceShare({ total: 5, definitiveAbsent: 5 }, { maxShare: 1, minPackages: 0 }),
    ).toBe(false);
    expect(
      exceedsAbsenceShare({ total: 5, definitiveAbsent: 1 }, { maxShare: 0, minPackages: 0 }),
    ).toBe(true);
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a limit of %s',
    (maxShare) => {
      expect(() =>
        exceedsAbsenceShare({ total: 1, definitiveAbsent: 0 }, { maxShare, minPackages: 0 }),
      ).toThrow(RangeError);
    },
  );

  it.each([
    { total: -1, definitiveAbsent: 0 },
    { total: 1.5, definitiveAbsent: 0 },
    { total: 2, definitiveAbsent: 3 },
    { total: 2, definitiveAbsent: -1 },
    { total: Number.NaN, definitiveAbsent: 0 },
  ])('refuses the tally %j', (tally) => {
    expect(() => exceedsAbsenceShare(tally, { maxShare: 0.5, minPackages: 0 })).toThrow(RangeError);
  });

  it('refuses a minimum sample that is not a non-negative integer', () => {
    expect(() =>
      exceedsAbsenceShare({ total: 1, definitiveAbsent: 0 }, { maxShare: 0.5, minPackages: -1 }),
    ).toThrow(RangeError);
  });
});

describe('assertNoMassAbsence', () => {
  it('returns when the share is within the limit', () => {
    expect(() =>
      assertNoMassAbsence({ total: 10, definitiveAbsent: 2 }, { maxShare: 0.5, minPackages: 0 }),
    ).not.toThrow();
  });

  it('throws MassAbsenceError carrying the tally and limit', () => {
    expect(() =>
      assertNoMassAbsence({ total: 10, definitiveAbsent: 6 }, { maxShare: 0.5, minPackages: 0 }),
    ).toThrow(MassAbsenceError);
    try {
      assertNoMassAbsence({ total: 10, definitiveAbsent: 6 }, { maxShare: 0.5, minPackages: 0 });
    } catch (error) {
      expect(error).toMatchObject({ total: 10, definitiveAbsent: 6, maxShare: 0.5 });
    }
  });
});
