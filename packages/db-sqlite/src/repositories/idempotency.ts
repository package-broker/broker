import type { IdempotencyRecord } from '@package-broker/core/api/idempotency';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface IdempotencyRepository {
  find(
    ctx: OrgContext,
    principalKey: string,
    key: string,
    now: string,
  ): Promise<IdempotencyRecord | null>;
  purgeExpired(ctx: OrgContext, now: string, limit: number): Promise<number>;
}

function boundedKey(field: string, value: string, max: number): void {
  if (
    typeof value !== 'string' ||
    value.includes('\u0000') ||
    value.length < 1 ||
    [...value].length > max
  ) {
    throw new TypeError(`${field} has an invalid length`);
  }
}

function timestamp(value: string): void {
  if (
    typeof value !== 'string' ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError('Timestamp must be UTC with millisecond precision');
  }
}

export function idempotencyInsertStatement(
  ctx: OrgContext,
  record: IdempotencyRecord,
): ScalarStatement {
  boundedKey('principalKey', record.principalKey, 80);
  boundedKey('key', record.key, 128);
  if (
    typeof record.requestHash !== 'string' ||
    record.requestHash.length !== 64 ||
    !/^[0-9a-f]{64}$/.test(record.requestHash)
  ) {
    throw new TypeError('requestHash must be 64 lowercase hexadecimal characters');
  }
  if (!Number.isInteger(record.status) || record.status < 100 || record.status > 599) {
    throw new TypeError('status must be an integer from 100 to 599');
  }
  if (typeof record.responseJson !== 'string') throw new TypeError('responseJson must be JSON');
  try {
    JSON.parse(record.responseJson);
  } catch {
    throw new TypeError('responseJson must be JSON');
  }
  timestamp(record.createdAt);
  timestamp(record.expiresAt);
  return {
    sql: `INSERT INTO api_idempotency
      (org_id, principal_key, key, route, request_hash, status, response_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      ctx.orgId,
      record.principalKey,
      record.key,
      record.route,
      record.requestHash,
      record.status,
      record.responseJson,
      record.createdAt,
      record.expiresAt,
    ],
  };
}

export function createIdempotencyRepository(executor: ScalarSqlExecutor): IdempotencyRepository {
  return {
    async find(ctx, principalKey, key, now) {
      boundedKey('principalKey', principalKey, 80);
      boundedKey('key', key, 128);
      timestamp(now);
      const [row] = await executor.all<IdempotencyRecord>({
        sql: `SELECT principal_key AS principalKey, key, route, request_hash AS requestHash,
          status, response_json AS responseJson, created_at AS createdAt, expires_at AS expiresAt
          FROM api_idempotency
          WHERE org_id = ? AND principal_key = ? AND key = ? AND expires_at > ?`,
        params: [ctx.orgId, principalKey, key, now],
      });
      return row ?? null;
    },
    async purgeExpired(ctx, now, limit) {
      timestamp(now);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new TypeError('limit must be an integer from 1 to 500');
      }
      const [result] = await executor.batch([
        {
          sql: `DELETE FROM api_idempotency WHERE org_id = ? AND (principal_key, key) IN (
          SELECT principal_key, key FROM api_idempotency
          WHERE org_id = ? AND expires_at <= ? ORDER BY expires_at LIMIT ?
        )`,
          params: [ctx.orgId, ctx.orgId, now, limit],
        },
      ]);
      return result?.changes ?? 0;
    },
  };
}
