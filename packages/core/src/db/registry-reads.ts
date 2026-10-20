import type { OrgContext } from './port.js';

export interface VersionIdentity {
  readonly packageName: string;
  readonly version: string;
}

export interface RegistryReads {
  /** True when a registered name of the source's ecosystem matches the key. */
  covers(ctx: OrgContext, sourceId: string, key: string): Promise<boolean>;
  /** The served name and version of a version row; null when absent, foreign, mismatched or not servable. */
  versionById(
    ctx: OrgContext,
    ref: { readonly packageId: string; readonly versionId: string },
  ): Promise<VersionIdentity | null>;
}
