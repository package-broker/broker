import type { Sealed } from '../secrets/cipher.js';
import type { OrgContext, Statement } from './port.js';

export interface CredentialRecord {
  readonly id: string;
  readonly projectId: string | null;
  readonly kind: string;
  readonly sealed: Sealed;
  readonly aad: string;
  readonly rotatedAt: string | null;
}

/**
 * Stores sealed credentials. Rows are decrypted only through `CredentialStore.read`, which
 * recomputes the AAD and compares it with the stored one; no other caller opens `sealed` directly.
 */
export interface CredentialRepository {
  /**
   * Throws TypeError before any SQL when `kind` or `id` is not a valid credential AAD part, the
   * nonce is not 12 bytes, or `aad` differs from `credentialAad` of the row and `ctx`; RangeError
   * when the key version is not a positive safe integer. The statement inserts nothing when
   * `projectId` belongs to another organization, so a batch caller checks that its `changes` is 1.
   */
  insertStatement(ctx: OrgContext, row: CredentialRecord & { readonly now: string }): Statement;
  /**
   * Same validation as `insertStatement`. Throws DbError `foreign_key` when `projectId` does not
   * belong to the context organization.
   */
  insert(ctx: OrgContext, row: CredentialRecord & { readonly now: string }): Promise<void>;
  get(ctx: OrgContext, id: string): Promise<CredentialRecord | null>;
  /** Rows with `key_version < version`, ordered by id, after `afterId`. `limit` is an integer from 1 to 500. */
  listBelowVersion(
    ctx: OrgContext,
    version: number,
    afterId: string | null,
    limit: number,
  ): Promise<CredentialRecord[]>;
  /**
   * False when the row is gone or its key version is no longer `expectedVersion`. Throws
   * RangeError when `sealed.keyVersion` is not greater than `expectedVersion`.
   */
  reseal(
    ctx: OrgContext,
    id: string,
    expectedVersion: number,
    sealed: Sealed,
    now: string,
  ): Promise<boolean>;
  /** Throws DbError `foreign_key` while a source still references the credential. */
  delete(ctx: OrgContext, id: string): Promise<boolean>;
}
