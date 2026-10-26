import type { OrgContext } from '../db/port.js';

export type SourcePackageProbe = (
  org: OrgContext,
  sourceId: string,
  key: string,
  signal: AbortSignal,
) => Promise<
  'found' | 'not_found' | 'unsupported_package' | 'unavailable' | 'upstream_refused' | 'bad_gateway'
>;
