import type { OrgContext } from '../db/port.js';
import type { ScopeLevel } from './scope.js';

export const TOKEN_LIST_MAX_LIMIT = 100;

export type TokenListStatus = 'active' | 'expired' | 'revoked';

export interface TokenListItem {
  readonly id: string;
  readonly kind: 'pat' | 'svc';
  readonly name: string;
  readonly scope: ScopeLevel;
  readonly readOnly: boolean;
  readonly status: TokenListStatus;
  readonly projectMode: 'all' | 'selected' | null;
  readonly projectCount: number;
  readonly projectId: string | null;
  readonly userId: string | null;
  readonly createdByUserId: string | null;
  readonly servicePrincipalId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export interface TokenPage {
  readonly items: readonly TokenListItem[];
  readonly next: string | null;
}

export interface TokenListPage {
  readonly after: string | null;
  readonly limit: number;
  readonly status?: TokenListStatus;
  readonly now: string;
}

export interface TokenReader {
  getOwn(
    ctx: OrgContext,
    userId: string,
    tokenId: string,
    now: string,
  ): Promise<TokenListItem | null>;
  getProject(
    ctx: OrgContext,
    projectId: string,
    tokenId: string,
    now: string,
  ): Promise<TokenListItem | null>;
  getOrganization(ctx: OrgContext, tokenId: string, now: string): Promise<TokenListItem | null>;
  listOwn(ctx: OrgContext, userId: string, page: TokenListPage): Promise<TokenPage>;
  listProject(ctx: OrgContext, projectId: string, page: TokenListPage): Promise<TokenPage>;
  listOrganization(
    ctx: OrgContext,
    page: TokenListPage & { readonly kind?: 'pat' | 'svc' },
  ): Promise<TokenPage>;
}

export interface NpmTokenRevokeInput {
  readonly tokenId: string;
  readonly selector: string;
  readonly userId: string;
  readonly targetId: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly requestId: string;
}

export interface NpmTokenAdapters {
  readonly reader: Pick<TokenReader, 'listOwn'>;
  revokeOwn(ctx: OrgContext, input: NpmTokenRevokeInput): Promise<boolean>;
}
