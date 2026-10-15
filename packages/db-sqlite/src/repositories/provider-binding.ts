import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import {
  isReservedProviderId,
  isValidProviderId,
  isValidTrustAnchor,
} from '@package-broker/core/identity/port';
import { anchorMatches, compile, db } from '../kysely.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SESSIONS = 0;
const IDENTITIES = 2;
const BINDING = 3;

function providerId(provider: string): void {
  if (
    typeof provider !== 'string' ||
    !isValidProviderId(provider) ||
    isReservedProviderId(provider)
  ) {
    throw new TypeError('provider must be a valid, non-reserved provider id');
  }
}

function trustAnchor(field: string, value: string): void {
  if (typeof value !== 'string' || !isValidTrustAnchor(value)) {
    throw new TypeError(`${field} must be a valid trust anchor`);
  }
}

function timestamp(value: string): void {
  const valid =
    typeof value === 'string' &&
    TIMESTAMP.test(value) &&
    !Number.isNaN(new Date(value).getTime()) &&
    new Date(value).toISOString() === value;
  if (!valid) {
    throw new TypeError('now must be a UTC timestamp with millisecond precision');
  }
}

/**
 * The binding is updated last, so a login planned under the old anchor that commits afterwards is
 * refused. `swapped` is false when the stored anchor is not `expectedAnchor` or there is no binding.
 */
export async function rebindProvider(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  provider: string,
  expectedAnchor: string,
  newAnchor: string,
  now: string,
): Promise<{ readonly swapped: boolean; readonly identities: number; readonly sessions: number }> {
  providerId(provider);
  trustAnchor('expectedAnchor', expectedAnchor);
  trustAnchor('newAnchor', newAnchor);
  if (expectedAnchor === newAnchor) {
    throw new TypeError('newAnchor must differ from expectedAnchor');
  }
  timestamp(now);

  const bound = anchorMatches(ctx, provider, expectedAnchor);
  const statements = [
    db
      .deleteFrom('session')
      .where('session.org_id', '=', ctx.orgId)
      .where('session.identity_id', 'in', (values) =>
        values
          .selectFrom('identity')
          .select('identity.id')
          .where('identity.org_id', '=', ctx.orgId)
          .where('identity.provider', '=', provider),
      )
      .where(bound),
    db
      .deleteFrom('user_group')
      .where('user_group.org_id', '=', ctx.orgId)
      .where('user_group.provider', '=', provider)
      .where(bound),
    db
      .deleteFrom('identity')
      .where('identity.org_id', '=', ctx.orgId)
      .where('identity.provider', '=', provider)
      .where(bound),
    db
      .updateTable('identity_provider_binding')
      .set({ anchor: newAnchor, created_at: now })
      .where('identity_provider_binding.org_id', '=', ctx.orgId)
      .where('identity_provider_binding.provider', '=', provider)
      .where('identity_provider_binding.anchor', '=', expectedAnchor),
  ].map((query) => compile(query) as ScalarStatement);

  const results = await executor.batch(statements);
  return {
    swapped: (results[BINDING]?.changes ?? 0) > 0,
    identities: results[IDENTITIES]?.changes ?? 0,
    sessions: results[SESSIONS]?.changes ?? 0,
  };
}

export interface ProviderBinding {
  readonly anchor: string;
  readonly createdAt: string;
}

/** The trust anchor stored for one provider, or null when nothing is bound. Read-only. */
export async function readProviderBinding(
  executor: ScalarSqlExecutor,
  ctx: OrgContext,
  provider: string,
): Promise<ProviderBinding | null> {
  providerId(provider);

  const statement = compile(
    db
      .selectFrom('identity_provider_binding')
      .select(['identity_provider_binding.anchor', 'identity_provider_binding.created_at'])
      .where('identity_provider_binding.org_id', '=', ctx.orgId)
      .where('identity_provider_binding.provider', '=', provider),
  ) as ScalarStatement;

  const rows = await executor.all<{ anchor: string; created_at: string }>(statement);
  const row = rows[0];
  return row === undefined ? null : { anchor: row.anchor, createdAt: row.created_at };
}
