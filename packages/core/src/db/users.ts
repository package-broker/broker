import type { AuditEvent } from '../audit/actions.js';
import type { OrgContext } from './port.js';
import type { NewSession } from './sessions.js';

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'suspended';
  /** `user_account.last_login_at`: the last login by any method. */
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

export interface StoredIdentity {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
  readonly email: string;
  readonly validatedAt: string | null;
}

export interface LoginLookup {
  /** `identity_provider_binding.anchor` for this provider. */
  readonly boundAnchor: string | null;
  readonly identity: StoredIdentity | null;
  readonly identityUser: {
    readonly id: string;
    readonly email: string;
    readonly status: 'active' | 'suspended';
  } | null;
  readonly userByEmail: {
    readonly id: string;
    readonly status: 'active' | 'suspended';
    /** True when this user already has any identity at the asked provider. */
    readonly linkedAtProvider: boolean;
  } | null;
  readonly invited: boolean;
}

export interface ProviderBindingReader {
  /** Null only when no binding exists; failed reads reject. */
  anchor(ctx: OrgContext, provider: string): Promise<string | null>;
}

export interface UserRepository {
  /**
   * One statement. `email` is matched exactly against the stored, already lower-cased e-mail.
   * `invited` is true when an organization or project grant names the e-mail, or one of
   * `(provider, group)`.
   */
  lookupForLogin(
    ctx: OrgContext,
    input: {
      readonly provider: string;
      readonly subject: string;
      readonly email: string;
      readonly groups: readonly string[];
    },
  ): Promise<LoginLookup>;
  getIdentity(ctx: OrgContext, id: string): Promise<StoredIdentity | null>;
  get(ctx: OrgContext, id: string): Promise<User | null>;
  /** Ordered by id; RangeError unless `limit` is an integer from 1 to 200. */
  list(
    ctx: OrgContext,
    page: { readonly afterId: string | null; readonly limit: number },
  ): Promise<User[]>;
}

export interface LoginPlan {
  readonly audit: AuditEvent;
  readonly userId: string;
  readonly createUser: boolean;
  readonly email: string;
  readonly displayName: string | null;
  readonly identityId: string;
  readonly provider: string;
  readonly trustAnchor: string;
  readonly subject: string;
  readonly emailVerified: boolean;
  readonly groups: readonly string[];
  readonly evidenceTime: string;
  readonly session: NewSession;
  readonly previousSecretHash: string | null;
  readonly now: string;
  readonly autoJoin: boolean;
}

export interface LoginWriter {
  commit(ctx: OrgContext, plan: LoginPlan): Promise<'created' | 'refused'>;
}
