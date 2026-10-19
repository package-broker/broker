import type { CatalogueWriteGuard, FinalizeEvidence } from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';
import type { IngestSessionHandle } from './session.js';

export type IngestFinalizeRefusal =
  | 'mass_absence'
  | 'no_success'
  | 'candidate_count_mismatch'
  | 'incomplete'
  | 'count_mismatch'
  | 'session_unavailable'
  | 'no_stamp'
  | 'no_package'
  | 'superseded';

export type IngestFinalizeResult =
  | {
      readonly status: 'complete';
      readonly empty: boolean;
      readonly validatorsPublished: number;
    }
  | { readonly status: 'refused'; readonly reason: IngestFinalizeRefusal };

export interface IngestFinalizeInput extends FinalizeEvidence {
  readonly expectedCount: number;
  readonly upstreamComplete: boolean;
  readonly validatorTtlSeconds: number;
}

export interface IngestFinalizer {
  finalize(
    ctx: OrgContext,
    session: IngestSessionHandle,
    input: IngestFinalizeInput,
    /** The caller's write guard (session plus job lease); it runs inside the finalize batch. */
    guard?: CatalogueWriteGuard,
  ): Promise<IngestFinalizeResult>;
}
