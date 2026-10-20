import type { OrgContext, ScalarStatement } from './port.js';

export type UpstreamForm =
  'composer-p2' | 'composer-p2-dev' | 'composer-v1-provider' | 'npm-packument';

export interface UpstreamState {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly contentSha256: string | null;
  readonly checkedAt: string;
  readonly freshUntil: string;
  readonly notFoundCount: number;
  readonly firstNotFoundAt: string | null;
}

export interface PublishedValidators {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly contentSha256: string | null;
}

export interface UpstreamStateRepository {
  get(ctx: OrgContext, packageId: string, form: UpstreamForm): Promise<UpstreamState | null>;
  publishStatements(
    ctx: OrgContext,
    packageId: string,
    form: UpstreamForm,
    validators: PublishedValidators,
    ttlSeconds: number,
  ): ScalarStatement[];
  touchStatements(
    ctx: OrgContext,
    packageId: string,
    form: UpstreamForm,
    ttlSeconds: number,
  ): ScalarStatement[];
  notFoundStatements(
    ctx: OrgContext,
    packageId: string,
    form: UpstreamForm,
    ttlSeconds: number,
  ): ScalarStatement[];
  /** Clears the 404 evidence of every form of the package; creates no rows and keeps validators. */
  resetNotFoundStatements(ctx: OrgContext, packageId: string): ScalarStatement[];
}
