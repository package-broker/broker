import type { IdempotencyRecord } from '../api/idempotency.js';
import type { AuditEvent } from '../audit/actions.js';
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

export interface OrganizationGrantDeleted {
  readonly outcome: 'deleted';
  readonly offboardedUserId: string | null;
}

type MutationInput = { readonly audit?: AuditEvent; readonly idempotency?: IdempotencyRecord };

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
    input: MutationInput & {
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
   * changes. On success `offboardedUserId` is the user of the organization whose e-mail grant was
   * removed when, inside the same batch, no other organization grant reaches them by e-mail or
   * group membership; a group grant answers null.
   */
  deleteOrganization(
    ctx: OrgContext,
    fence: MutationFence,
    input: MutationInput & {
      readonly id: string;
      readonly opId: string;
    },
  ): Promise<OrganizationGrantDeleted | 'not_found' | 'last_holder' | FencedRefusal>;
  /**
   * One fenced batch with the revision comparison of `deleteOrganization`; a non-admin needs the
   * current and the replacement role to be subsets of its live permissions and neither protected.
   * Precedence of refusals: `authority`, `conflict`, `not_found`, `role_scope_mismatch`,
   * `last_holder`.
   */
  changeRole(
    ctx: OrgContext,
    fence: MutationFence,
    input: MutationInput & {
      readonly id: string;
      readonly roleId: string;
      readonly now: string;
      readonly opId: string;
    },
  ): Promise<'updated' | 'not_found' | 'last_holder' | 'role_scope_mismatch' | FencedRefusal>;
  /**
   * One fenced batch: the acting session and `org:users:write`, admin-only reach over a protected
   * holder and the exact remaining-holder check are re-read inside it. Revokes the user's live
   * sessions in the same batch. `suspended` means this call changed the status; a user that was
   * already suspended answers `unchanged` and nothing is written.
   */
  suspendUser(
    ctx: OrgContext,
    fence: MutationFence,
    input: MutationInput & {
      readonly userId: string;
      readonly now: string;
    },
  ): Promise<'suspended' | 'unchanged' | 'not_found' | 'last_holder' | FencedRefusal>;
  /**
   * Fenced like suspendUser, and admin-only for a user who would hold a protected role once
   * active. `reactivated` only when this call moved a suspended user to `active`; an active user
   * answers `unchanged` and an unknown one `not_found`, both without a write.
   */
  reactivateUser(
    ctx: OrgContext,
    fence: MutationFence,
    input: MutationInput & {
      readonly userId: string;
      readonly now: string;
    },
  ): Promise<'reactivated' | 'unchanged' | 'not_found' | FencedRefusal>;
  isProtectedHolder(ctx: OrgContext, userId: string): Promise<boolean>;
  countProtectedHolders(ctx: OrgContext): Promise<number>;
}
