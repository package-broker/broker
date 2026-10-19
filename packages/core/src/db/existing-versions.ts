import type { OrgContext } from './port.js';

export interface ExistingVersionsQuery {
  readonly packageId: string;
  readonly after: string | null;
  readonly withMetadata: boolean;
  readonly limit: number;
}

export interface ExistingVersion {
  readonly versionNormalized: string;
  readonly id: string;
  readonly revision: number;
  readonly status: string;
  readonly npmIntegrity: string | null;
  readonly composerShasum: string | null;
  readonly metadataJson?: string;
}

export interface ExistingVersionsPage {
  readonly rows: readonly ExistingVersion[];
  readonly next: string | null;
}

export interface ExistingVersionsReader {
  existingVersions(ctx: OrgContext, query: ExistingVersionsQuery): Promise<ExistingVersionsPage>;
}
