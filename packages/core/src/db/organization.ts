import type { OrgContext, OrgId } from './port.js';

/** A slug of 1 to 64 characters: lowercase alphanumerics with interior hyphens only. */
export const ORG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface OrganizationSettings {
  readonly retentionRemovedUpstreamDays: number;
  readonly tokenDefaultExpiryDays: number;
  readonly tokenCiReadonlyExpiryDays: number;
}

export interface OrganizationIdentity {
  readonly id: OrgId;
  readonly slug: string;
  readonly name: string;
}

export interface Organization extends OrganizationIdentity {
  readonly settings: OrganizationSettings;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BootstrapInput {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly now: string;
}

export type BootstrapResult = OrganizationIdentity & { readonly created: boolean };

export interface OrganizationRepository {
  get(ctx: OrgContext): Promise<Organization | null>;
  updateSettings(
    ctx: OrgContext,
    patch: Partial<OrganizationSettings> & { readonly name?: string },
    now: string,
  ): Promise<Organization | null>;
}

/** Not tenant-scoped on purpose: callers are bootstrap, the org resolver and the readiness probe. */
export interface OrganizationBootstrap {
  findSingleton(): Promise<OrganizationIdentity | null>;
  /** Rejects an invalid slug with TypeError before SQL. Two calls when the row already exists. */
  bootstrap(input: BootstrapInput): Promise<BootstrapResult>;
}
