import { sql, type Compilable } from 'kysely';
import type { CredentialRecord, CredentialRepository } from '@package-broker/core/db/credentials';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { credentialAad, type Sealed } from '@package-broker/core/secrets/cipher';
import { compile, db } from '../kysely.js';

const MAX_LIMIT = 500;
const NONCE_BYTES = 12;

interface CredentialRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly kind: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly key_version: number;
  readonly aad: string;
  readonly rotated_at: string | null;
}

const COLUMNS = [
  'id',
  'project_id',
  'kind',
  'ciphertext',
  'nonce',
  'key_version',
  'aad',
  'rotated_at',
] as const;

function run<R>(executor: SqlExecutor, query: Compilable): Promise<R[]> {
  return executor.all<R>(compile(query));
}

function toRecord(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    sealed: { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.key_version },
    aad: row.aad,
    rotatedAt: row.rotated_at,
  };
}

function requireKeyVersion(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function requireNonce(nonce: Uint8Array): void {
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) {
    throw new TypeError(`nonce must be ${NONCE_BYTES} bytes`);
  }
}

function insertQuery(
  ctx: OrgContext,
  row: CredentialRecord & { readonly now: string },
): Compilable {
  if (row.aad !== credentialAad({ id: row.id, orgId: ctx.orgId, kind: row.kind })) {
    throw new TypeError('aad does not match the credential id, organization and kind');
  }
  requireNonce(row.sealed.nonce);
  const keyVersion = requireKeyVersion('keyVersion', row.sealed.keyVersion);

  return db
    .insertInto('credential')
    .columns([
      'id',
      'org_id',
      'project_id',
      'kind',
      'ciphertext',
      'nonce',
      'key_version',
      'aad',
      'rotated_at',
      'created_at',
      'updated_at',
    ])
    .expression(
      db
        .selectNoFrom((eb) => [
          eb.val(row.id).as('id'),
          eb.val(ctx.orgId).as('org_id'),
          eb.val(row.projectId).as('project_id'),
          eb.val(row.kind).as('kind'),
          eb.val(row.sealed.ciphertext).as('ciphertext'),
          eb.val(row.sealed.nonce).as('nonce'),
          eb.val(keyVersion).as('key_version'),
          eb.val(row.aad).as('aad'),
          eb.val(row.rotatedAt).as('rotated_at'),
          eb.val(row.now).as('created_at'),
          eb.val(row.now).as('updated_at'),
        ])
        .where((eb) =>
          eb.or([
            eb(eb.val(row.projectId), 'is', null),
            eb.exists(
              eb
                .selectFrom('project')
                .select(sql.lit(1).as('one'))
                .where('id', '=', row.projectId ?? '')
                .where('org_id', '=', ctx.orgId),
            ),
          ]),
        ),
    )
    .returning('id');
}

export function createCredentialRepository(executor: SqlExecutor): CredentialRepository {
  return {
    insertStatement(ctx: OrgContext, row: CredentialRecord & { readonly now: string }): Statement {
      return compile(insertQuery(ctx, row));
    },

    async insert(ctx: OrgContext, row: CredentialRecord & { readonly now: string }): Promise<void> {
      const rows = await run<{ readonly id: string }>(executor, insertQuery(ctx, row));
      if (rows.length === 0) {
        throw new DbError(
          'foreign_key',
          'foreign_key: credential project is not in the organization',
        );
      }
    },

    async get(ctx: OrgContext, id: string): Promise<CredentialRecord | null> {
      const rows = await run<CredentialRow>(
        executor,
        db
          .selectFrom('credential')
          .select(COLUMNS)
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id),
      );
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async listBelowVersion(
      ctx: OrgContext,
      version: number,
      afterId: string | null,
      limit: number,
    ): Promise<CredentialRecord[]> {
      requireLimit(limit);
      requireKeyVersion('version', version);
      let query = db
        .selectFrom('credential')
        .select(COLUMNS)
        .where('org_id', '=', ctx.orgId)
        .where('key_version', '<', version);
      if (afterId !== null) query = query.where('id', '>', afterId);
      const rows = await run<CredentialRow>(executor, query.orderBy('id').limit(limit));
      return rows.map(toRecord);
    },

    async reseal(
      ctx: OrgContext,
      id: string,
      expectedVersion: number,
      sealed: Sealed,
      now: string,
    ): Promise<boolean> {
      requireKeyVersion('expectedVersion', expectedVersion);
      const nextVersion = requireKeyVersion('keyVersion', sealed.keyVersion);
      if (nextVersion <= expectedVersion) {
        throw new RangeError('keyVersion must be greater than expectedVersion');
      }
      requireNonce(sealed.nonce);
      const rows = await run<{ readonly id: string }>(
        executor,
        db
          .updateTable('credential')
          .set({
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            key_version: nextVersion,
            rotated_at: now,
            updated_at: now,
          })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id)
          .where('key_version', '=', expectedVersion)
          .returning('id'),
      );
      return rows.length > 0;
    },

    async delete(ctx: OrgContext, id: string): Promise<boolean> {
      const rows = await run<{ readonly id: string }>(
        executor,
        db
          .deleteFrom('credential')
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', id)
          .returning('id'),
      );
      return rows.length > 0;
    },
  };
}
