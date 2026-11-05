import type { OrgContext } from '../db/port.js';

export type ClaimProbeTarget =
  string | { readonly type: 'new_npmjs_proxy'; readonly userAgent: string | null };

export type SourcePackageProbe = (
  org: OrgContext,
  sourceId: ClaimProbeTarget,
  key: string,
  signal: AbortSignal,
  mode?: 'claim',
) => Promise<
  'found' | 'not_found' | 'unsupported_package' | 'unavailable' | 'upstream_refused' | 'bad_gateway'
>;
