export interface AbsenceTally {
  /** Packages the sync described. */
  readonly total: number;
  /** Packages whose describe answered `not_found` with `definitive: true`. */
  readonly definitiveAbsent: number;
}

export interface MassAbsencePolicy {
  /** Largest share of definitively absent packages a sync may finalize, from 0 to 1. */
  readonly maxShare: number;
  /** Syncs describing fewer packages than this are not guarded. */
  readonly minPackages: number;
}

export class MassAbsenceError extends Error {
  override readonly name = 'MassAbsenceError';
  constructor(
    readonly total: number,
    readonly definitiveAbsent: number,
    readonly maxShare: number,
  ) {
    super(`sync stopped: ${definitiveAbsent} of ${total} packages are definitively absent`);
  }
}

const isCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export function exceedsAbsenceShare(tally: AbsenceTally, policy: MassAbsencePolicy): boolean {
  const { total, definitiveAbsent } = tally;
  const { maxShare, minPackages } = policy;
  if (!Number.isFinite(maxShare) || maxShare < 0 || maxShare > 1) {
    throw new RangeError('maxShare must be a number from 0 to 1');
  }
  if (!isCount(minPackages)) throw new RangeError('minPackages must be a non-negative integer');
  if (!isCount(total) || !isCount(definitiveAbsent) || definitiveAbsent > total) {
    throw new RangeError('tally counts must be non-negative integers with absent not above total');
  }
  if (total < minPackages) return false;
  return definitiveAbsent / total > maxShare;
}

/** Call before a sync finalizes; a throw means no package of the sync may be marked removed. */
export function assertNoMassAbsence(tally: AbsenceTally, policy: MassAbsencePolicy): void {
  if (exceedsAbsenceShare(tally, policy)) {
    throw new MassAbsenceError(tally.total, tally.definitiveAbsent, policy.maxShare);
  }
}
