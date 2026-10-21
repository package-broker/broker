import { expectTypeOf, it } from 'vitest';
import type { CatalogueWriter, FinalizeResult } from '@package-broker/core/db/catalogue';
import type { IngestFinalizer } from '@package-broker/core/ingest/finalize';

type PortResult = Awaited<ReturnType<CatalogueWriter['finalizeListing']>>;
type CompleteIngestResult = Extract<
  Awaited<ReturnType<IngestFinalizer['finalize']>>,
  { status: 'complete' }
>;

it('exposes a numeric held-back lease count through both core ports', () => {
  expectTypeOf<FinalizeResult['leaseHeldBack']>().toEqualTypeOf<number>();
  expectTypeOf<PortResult['leaseHeldBack']>().toEqualTypeOf<number>();
  expectTypeOf<CompleteIngestResult['leaseHeldBack']>().toEqualTypeOf<number>();
});
