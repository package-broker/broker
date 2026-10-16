import type { MutationFence } from '../authz/fence.js';
import type { OrgContext } from './port.js';

export type FencedRefusal = 'authority' | 'conflict' | 'indeterminate';

export type GrantSubject =
  | { readonly type: 'email'; readonly value: string }
  | { readonly type: 'group'; readonly provider: string; readonly value: string };

export interface OrganizationGrant {
  readonly id: string;
  readonly subject: GrantSubject;
  readonly roleId: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  /** The value a `MutationFence` carries as `expected.grant` to change or revoke this grant. */
  readonly revision: number;
}

export interface GrantRepository {
  /** Organization-scope grants only, oldest first. */
  listOrganization(ctx: OrgContext): Promise<OrganizationGrant[]>;
  /**
   * TypeError before SQL for an e-mail value that `normalizeEmail` would change or refuse, a group
   * provider that fails `isValidProviderId` (that it is a configured provider is the caller's
   * check), a group value that is not 1 to 256 code points, is not equal to its trimmed form or holds
   * control or format characters, and a `now` that is not `YYYY-MM-DDTHH:MM:SS.mmmZ`. TypeError
   * after the insert is refused when `createdBy` is not a user of the organization; nothing is
   * stored. `role_scope_mismatch` covers a role that is missing, belongs to another organization or
   * is not organization-scoped; `duplicate` covers an existing grant for the subject and an
   * existing id.
   *
   * Runs as one fenced batch that re-reads the acting user's live authority: `org:grants:write`, a
   * role whose permissions are a subset of the actor's (an organization admin is exempt), and an
   * organization admin for a protected role. `authority` leaves nothing stored.
   */
  createOrganization(
    ctx: OrgContext,
    fence: MutationFence,
    input: {
      readonly id: string;
      readonly subject: GrantSubject;
      readonly roleId: string;
      readonly createdBy: string | null;
      readonly now: string;
      readonly opId: string;
    },
  ): Promise<'created' | 'duplicate' | 'role_scope_mismatch' | FencedRefusal>;
  /**
   * One fenced batch. `fence.expected.grant` is the grant revision; a different revision answers
   * `conflict`. Needs `org:grants:write` but no subset of the removed role; a protected role is
   * admin-only. `last_holder`: no other active holder of a protected role would remain; nothing
   * changes.
   */
  deleteOrganization(
    ctx: OrgContext,
    fence: MutationFence,
    id: string,
    opId: string,
  ): Promise<'deleted' | 'not_found' | 'last_holder' | FencedRefusal>;
  /**
   * One fenced batch with the revision comparison of `deleteOrganization`; a non-admin needs the
   * current and the replacement role to be subsets of its live permissions and neither protected.
   * Precedence of refusals: `authority`, `conflict`, `not_found`, `role_scope_mismatch`,
   * `last_holder`.
   */
  changeRole(
    ctx: OrgContext,
    fence: MutationFence,
    id: string,
    roleId: string,
    now: string,
    opId: string,
  ): Promise<'updated' | 'not_found' | 'last_holder' | 'role_scope_mismatch' | FencedRefusal>;
  /**
   * Also revokes the user's live sessions in the same batch. Suspending a suspended user answers
   * `suspended` and does not rewrite `updated_at`.
   */
  suspendUser(
    ctx: OrgContext,
    userId: string,
    now: string,
  ): Promise<'suspended' | 'not_found' | 'last_holder'>;
  /** Sets the status back to `active` and nothing else; false when the user is not suspended. */
  reactivateUser(ctx: OrgContext, userId: string, now: string): Promise<boolean>;
  countProtectedHolders(ctx: OrgContext): Promise<number>;
}
