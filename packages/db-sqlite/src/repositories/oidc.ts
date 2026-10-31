import type {
  OidcRepository,
  OidcReplayReservation,
  TrustedPublisherMatch,
  TrustedPublisherBinding,
} from '@package-broker/core/db/oidc';
import { isWorkflowFilename } from '@package-broker/core/registry/npm/oidc/verify';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { sql, type SqlBool } from 'kysely';
import { assertCheck, compile, db } from '../kysely.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const invalid = (): never => {
  throw new TypeError('invalid_oidc_input');
};
function text(value: string, max: number, empty = false): void {
  if (
    typeof value !== 'string' ||
    (!empty && value === '') ||
    value.length > max ||
    new TextEncoder().encode(value).length > max ||
    /\p{Cc}/u.test(value)
  )
    invalid();
}
function time(now: string): void {
  if (typeof now !== 'string' || now.length !== 24) invalid();
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== now) invalid();
}

export function findTrustedPublishersStatement(
  ctx: OrgContext,
  input: TrustedPublisherMatch,
): Statement {
  text(input.packageName, 214);
  text(input.repositoryId, 20);
  text(input.repositoryOwnerId, 20);
  if (!isWorkflowFilename(input.workflow)) invalid();
  text(input.environment, 255, true);
  return compile(
    db
      .selectFrom('trusted_publisher')
      .select([
        'id',
        'package_name as packageName',
        'repository_id as repositoryId',
        'repository_owner_id as repositoryOwnerId',
        'workflow',
        'environment',
        'service_principal_id as servicePrincipalId',
        'ref_pattern as refPattern',
        'revision',
      ])
      .where('trusted_publisher.org_id', '=', ctx.orgId)
      .where('package_name', '=', input.packageName)
      .where('repository_id', '=', input.repositoryId)
      .where('repository_owner_id', '=', input.repositoryOwnerId)
      .where('workflow', '=', input.workflow)
      .where(
        sql<string>`lower(environment)`,
        '=',
        input.environment.replace(/[A-Z]/g, (ch) => ch.toLowerCase()),
      )
      .where('disabled_at', 'is', null)
      .limit(2),
  );
}

/** The replay primary key is the refusal: a collision aborts the entire issuance batch. */
export function oidcReplayStatements(
  ctx: OrgContext,
  input: OidcReplayReservation,
): readonly Statement[] {
  if (
    input.issuer !== ISSUER ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt < 0 ||
    input.expiresAt > 253402297199 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  )
    invalid();
  text(input.jti, 256);
  text(input.trustedPublisherId, 128);
  time(input.now);
  const exp = new Date((input.expiresAt + 3600) * 1000).toISOString();
  const insert = db
    .insertInto('oidc_replay')
    .columns(['issuer', 'jti', 'org_id', 'trusted_publisher_id', 'expires_at'])
    .expression(
      db
        .selectFrom('trusted_publisher')
        .select([
          sql<string>`${input.issuer}`.as('issuer'),
          sql<string>`${input.jti}`.as('jti'),
          'org_id',
          'id',
          sql<string>`${exp}`.as('expires_at'),
        ])
        .where('trusted_publisher.org_id', '=', ctx.orgId)
        .where('id', '=', input.trustedPublisherId)
        .where('revision', '=', input.expectedRevision)
        .where('disabled_at', 'is', null)
        .where(
          sql<SqlBool>`exists (select 1 from service_principal where service_principal.id = trusted_publisher.service_principal_id and service_principal.org_id = trusted_publisher.org_id and service_principal.status = 'active')`,
        ),
    );
  return [compile(insert), ...assertCheck(sql<SqlBool>`changes() = 1`)];
}

export function purgeOidcReplayStatement(ctx: OrgContext, now: string): Statement {
  time(now);
  return compile(
    db
      .deleteFrom('oidc_replay')
      .where(
        sql<SqlBool>`(issuer, jti) in (${db.selectFrom('oidc_replay').select(['issuer', 'jti']).where('oidc_replay.org_id', '=', ctx.orgId).where('expires_at', '<=', now).orderBy('expires_at').orderBy('issuer').orderBy('jti').limit(100)})`,
      )
      .returning('jti'),
  );
}

export function createOidcRepository(executor: SqlExecutor): OidcRepository {
  return {
    find: (ctx, input) =>
      executor.all<TrustedPublisherBinding>(findTrustedPublishersStatement(ctx, input)),
    reserveStatements(ctx, input) {
      const statements = oidcReplayStatements(ctx, input);
      return Object.freeze({
        appendTo: (batch: readonly Statement[]) => [...batch, ...statements],
      });
    },
    async purge(ctx, now) {
      return (await executor.all(purgeOidcReplayStatement(ctx, now))).length;
    },
  };
}
