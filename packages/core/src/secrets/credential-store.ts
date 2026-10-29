import {
  isCanonicalCredentialTimestamp,
  type CredentialRecord,
  type CredentialRepository,
} from '../db/credentials.js';
import type { OrgContext, Statement } from '../db/port.js';
import { isoTimestamp, type Clock } from '../ids.js';
import { SecretDecryptError, credentialAad, type SecretCipher } from './cipher.js';

export class CredentialNotFoundError extends Error {
  constructor() {
    super('Credential not found');
    this.name = 'CredentialNotFoundError';
  }
}

export interface CredentialInput {
  readonly kind: string;
  readonly projectId: string | null;
  readonly plaintext: Uint8Array;
}

export type SealedCredential = CredentialRecord & { readonly now: string };

export interface CredentialStore {
  /** Returns the row exactly as `prepare` and `put` insert it, without touching the repository. */
  seal(ctx: OrgContext, input: CredentialInput): Promise<SealedCredential>;
  prepare(
    ctx: OrgContext,
    input: CredentialInput,
  ): Promise<{ readonly id: string; readonly statement: Statement }>;
  put(ctx: OrgContext, input: CredentialInput): Promise<string>;
  read(ctx: OrgContext, id: string): Promise<Uint8Array>;
  readForUpdate(
    ctx: OrgContext,
    id: string,
  ): Promise<{ readonly plaintext: Uint8Array; readonly updatedAt: string }>;
  /**
   * Null for a stale timestamp or missing row at preparation. Execution may still miss the CAS,
   * updating zero rows without aborting the batch. Precede it with an abort-on-mismatch guard
   * on the credential token, alongside connection CAS and fence guards, in the same batch.
   */
  prepareReplace(
    ctx: OrgContext,
    id: string,
    expectedUpdatedAt: string,
    plaintext: Uint8Array,
  ): Promise<Statement | null>;
  /** False for a stale timestamp or missing row. Plaintext remains owned by the caller. */
  replaceMaterial(
    ctx: OrgContext,
    id: string,
    expectedUpdatedAt: string,
    plaintext: Uint8Array,
  ): Promise<boolean>;
  /**
   * Rows that cannot be opened never stop the page and are never modified: `lost` counts an AAD
   * mismatch or a key version that is not loaded, `failed` any other decryption failure. An
   * exception from the repository aborts the page; the caller restarts from the same cursor,
   * which is safe because a reseal is a forward-only compare-and-swap.
   */
  resealBatch(
    ctx: OrgContext,
    page: { readonly afterId: string | null; readonly limit: number },
  ): Promise<{
    readonly resealed: number;
    readonly lost: number;
    readonly failed: number;
    readonly nextAfterId: string | null;
  }>;
}

export interface CredentialStoreDeps {
  readonly repository: CredentialRepository;
  readonly cipher: SecretCipher;
  readonly ids: { ulid(): string };
  readonly clock: Clock;
}

const LOST_PROBLEMS: ReadonlySet<string> = new Set(['aad_mismatch', 'unknown_key_version']);

export function createCredentialStore(deps: CredentialStoreDeps): CredentialStore {
  const { repository, cipher, ids, clock } = deps;

  async function openRow(ctx: OrgContext, row: CredentialRecord): Promise<Uint8Array> {
    let aad: string;
    try {
      aad = credentialAad({ id: row.id, orgId: ctx.orgId, kind: row.kind });
    } catch (error) {
      if (error instanceof TypeError) throw new SecretDecryptError('aad_mismatch');
      throw error;
    }
    if (row.aad !== aad) throw new SecretDecryptError('aad_mismatch');
    return cipher.open(row.sealed, aad);
  }

  async function sealNew(ctx: OrgContext, input: CredentialInput): Promise<SealedCredential> {
    const id = ids.ulid();
    const aad = credentialAad({ id, orgId: ctx.orgId, kind: input.kind });
    const sealed = await cipher.seal(input.plaintext, aad);
    return {
      id,
      projectId: input.projectId,
      kind: input.kind,
      sealed,
      aad,
      rotatedAt: null,
      now: isoTimestamp(clock.now()),
    };
  }

  async function sealReplacement(
    ctx: OrgContext,
    id: string,
    expectedUpdatedAt: string,
    plaintext: Uint8Array,
  ) {
    if (!isCanonicalCredentialTimestamp(expectedUpdatedAt))
      throw new TypeError('Invalid credential timestamp');
    const row = await repository.get(ctx, id);
    if (row === null || row.updatedAt !== expectedUpdatedAt) return null;
    const aad = credentialAad({ id: row.id, orgId: ctx.orgId, kind: row.kind });
    if (row.aad !== aad) throw new SecretDecryptError('aad_mismatch');
    const sealed = await cipher.seal(plaintext, aad);
    return { sealed, now: isoTimestamp(clock.now()) };
  }

  return {
    seal: sealNew,

    async prepare(ctx, input) {
      const row = await sealNew(ctx, input);
      return { id: row.id, statement: repository.insertStatement(ctx, row) };
    },

    async put(ctx, input) {
      const row = await sealNew(ctx, input);
      await repository.insert(ctx, row);
      return row.id;
    },

    async read(ctx, id) {
      const row = await repository.get(ctx, id);
      if (row === null) throw new CredentialNotFoundError();
      return openRow(ctx, row);
    },

    async readForUpdate(ctx, id) {
      const row = await repository.get(ctx, id);
      if (row === null) throw new CredentialNotFoundError();
      return { plaintext: await openRow(ctx, row), updatedAt: row.updatedAt };
    },

    async prepareReplace(ctx, id, expectedUpdatedAt, plaintext) {
      const replacement = await sealReplacement(ctx, id, expectedUpdatedAt, plaintext);
      return replacement === null
        ? null
        : repository.replaceMaterialStatement(
            ctx,
            id,
            expectedUpdatedAt,
            replacement.sealed,
            replacement.now,
          );
    },

    async replaceMaterial(ctx, id, expectedUpdatedAt, plaintext) {
      const replacement = await sealReplacement(ctx, id, expectedUpdatedAt, plaintext);
      if (replacement === null) return false;
      return repository.replaceMaterial(
        ctx,
        id,
        expectedUpdatedAt,
        replacement.sealed,
        replacement.now,
      );
    },

    async resealBatch(ctx, page) {
      const rows = await repository.listBelowVersion(
        ctx,
        cipher.currentVersion,
        page.afterId,
        page.limit,
      );
      let resealed = 0;
      let lost = 0;
      let failed = 0;
      for (const row of rows) {
        let plaintext: Uint8Array;
        try {
          plaintext = await openRow(ctx, row);
        } catch (error) {
          if (!(error instanceof SecretDecryptError)) throw error;
          if (LOST_PROBLEMS.has(error.problem)) lost += 1;
          else failed += 1;
          continue;
        }
        try {
          const sealed = await cipher.seal(plaintext, row.aad);
          const swapped = await repository.reseal(
            ctx,
            row.id,
            row.sealed.keyVersion,
            sealed,
            isoTimestamp(clock.now()),
          );
          if (swapped) resealed += 1;
        } finally {
          plaintext.fill(0);
        }
      }
      const last = rows[rows.length - 1];
      const nextAfterId = rows.length < page.limit || last === undefined ? null : last.id;
      return { resealed, lost, failed, nextAfterId };
    },
  };
}
