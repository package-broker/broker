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
  listOwn(ctx: OrgContext, userId: string, page: TokenListPage): Promise<TokenPage>;
  listProject(ctx: OrgContext, projectId: string, page: TokenListPage): Promise<TokenPage>;
  listOrganization(
    ctx: OrgContext,
    page: TokenListPage & { readonly kind?: 'pat' | 'svc' },
  ): Promise<TokenPage>;
}
