import type { FinalizeEvidence } from '../db/catalogue.js';
import { noopObservability, type Observability } from '../platform/observability.js';
import { assertNoMassAbsence, MassAbsenceError } from './absence-guard.js';

export const DEFAULT_MAX_ABSENCE_SHARE = 0.25;

export const INGEST_EVENTS: ReadonlySet<string> = new Set([
  'ingest.mass_absence',
  'ingest.version_skipped',
]);
export const INGEST_REASON_CODES: ReadonlySet<string> = new Set([
  'mass_absence',
  'member_too_large',
]);

export interface FinalizeGuardOptions {
  readonly maxAbsenceShare?: number;
  readonly observability?: Pick<Observability, 'counter' | 'log'>;
}

export class FinalizeEvidenceError extends Error {
  override readonly name = 'FinalizeEvidenceError';
  constructor(readonly reason: 'no_success' | 'candidate_count_mismatch') {
    super(reason === 'no_success' ? 'no successful candidates' : 'candidate count mismatch');
  }
}

export function assertFinalizeAllowed(
  expectedCount: number,
  evidence: FinalizeEvidence,
  options: FinalizeGuardOptions = {},
): void {
  const { attemptedCandidates, successfulCandidates, definitiveAbsent } = evidence ?? {};
  const counts = [expectedCount, attemptedCandidates, successfulCandidates, definitiveAbsent];
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    successfulCandidates > attemptedCandidates ||
    definitiveAbsent > attemptedCandidates - successfulCandidates
  ) {
    throw new RangeError('candidate counts must be non-negative integers within attempted count');
  }
  try {
    assertNoMassAbsence(
      { total: attemptedCandidates, definitiveAbsent },
      {
        maxShare: options.maxAbsenceShare ?? DEFAULT_MAX_ABSENCE_SHARE,
        minPackages: 0,
      },
    );
  } catch (error) {
    if (error instanceof MassAbsenceError) {
      const observability = options.observability ?? noopObservability;
      observability.counter('pb.ingest.mass_absence', undefined, 1);
      observability.log({
        level: 'warn',
        event: 'ingest.mass_absence',
        reason_code: 'mass_absence',
      });
    }
    throw error;
  }
  if (attemptedCandidates > 0 && successfulCandidates === 0) {
    throw new FinalizeEvidenceError('no_success');
  }
  if (successfulCandidates !== expectedCount) {
    throw new FinalizeEvidenceError('candidate_count_mismatch');
  }
}
