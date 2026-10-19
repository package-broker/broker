import { sql, type RawBuilder } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import type {
  PublishedValidators,
  UpstreamForm,
  UpstreamStateRepository,
} from '@package-broker/core/db/upstream-state';

const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_VALIDATOR_LENGTH = 1024;
const hasControl = (value: string): boolean =>
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
const MAX_TTL_SECONDS = 366 * 24 * 60 * 60;

export type {
  PublishedValidators,
  UpstreamState,
  UpstreamStateRepository,
} from '@package-broker/core/db/upstream-state';

interface StateRow {
  readonly etag: string | null;
  readonly last_modified: string | null;
  readonly content_sha256: string | null;
  readonly checked_at: string;
  readonly fresh_until: string;
  readonly not_found_count: number;
  readonly first_not_found_at: string | null;
}

const now = (): RawBuilder<string> => sql<string>`strftime(${sql.lit(FORMAT)}, 'now')`;

const later = (ttlSeconds: number): RawBuilder<string> => {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new RangeError(`ttlSeconds must be an integer between 0 and ${MAX_TTL_SECONDS} seconds`);
  }
  return sql<string>`strftime(${sql.lit(FORMAT)}, 'now', ${sql.lit(`+${ttlSeconds} seconds`)})`;
};

function assertHeaderValue(name: string, value: string | null): void {
  if (value !== null && (value.length > MAX_VALIDATOR_LENGTH || hasControl(value))) {
    throw new TypeError(
      `${name} must be at most ${MAX_VALIDATOR_LENGTH} characters without control characters`,
    );
  }
}

function assertValidators(validators: PublishedValidators): void {
  assertHeaderValue('etag', validators.etag);
  assertHeaderValue('lastModified', validators.lastModified);
  if (validators.contentSha256 !== null && !SHA256.test(validators.contentSha256)) {
    throw new TypeError('contentSha256 must be 64 lowercase hex characters');
  }
}

function upsertFrom(
  ctx: OrgContext,
  packageId: string,
  form: UpstreamForm,
  values: {
    etag: string | null;
    lastModified: string | null;
    contentSha256: string | null;
    notFound: boolean;
  },
  ttlSeconds: number,
): ScalarStatement {
  const freshUntil = later(ttlSeconds);
  return compile(
    db
      .insertInto('upstream_state')
      .columns([
        'org_id',
        'package_id',
        'form',
        'etag',
        'last_modified',
        'content_sha256',
        'checked_at',
        'fresh_until',
        'not_found_count',
        'first_not_found_at',
      ])
      .expression((eb) =>
        eb
          .selectFrom('package')
          .select([
            'package.org_id',
            'package.id',
            eb.val(form).as('form'),
            eb.val(values.etag).as('etag'),
            eb.val(values.lastModified).as('last_modified'),
            eb.val(values.contentSha256).as('content_sha256'),
            now().as('checked_at'),
            freshUntil.as('fresh_until'),
            eb.val(values.notFound ? 1 : 0).as('not_found_count'),
            (values.notFound ? now() : sql<string | null>`null`).as('first_not_found_at'),
          ])
          .where('package.id', '=', packageId)
          .where('package.org_id', '=', ctx.orgId),
      )
      .onConflict((conflict) =>
        conflict
          .columns(['package_id', 'form'])
          .doUpdateSet((eb) =>
            values.notFound
              ? {
                  checked_at: eb.ref('excluded.checked_at'),
                  fresh_until: eb.ref('excluded.fresh_until'),
                  not_found_count: sql<number>`upstream_state.not_found_count + 1`,
                  first_not_found_at: sql<string>`coalesce(upstream_state.first_not_found_at, excluded.first_not_found_at)`,
                }
              : {
                  etag: eb.ref('excluded.etag'),
                  last_modified: eb.ref('excluded.last_modified'),
                  content_sha256: eb.ref('excluded.content_sha256'),
                  checked_at: eb.ref('excluded.checked_at'),
                  fresh_until: eb.ref('excluded.fresh_until'),
                  not_found_count: 0,
                  first_not_found_at: null,
                },
          )
          .where('upstream_state.org_id', '=', ctx.orgId),
      ),
  ) as ScalarStatement;
}

export function createUpstreamStateRepository(
  executor: ScalarSqlExecutor,
): UpstreamStateRepository {
  return {
    async get(ctx, packageId, form) {
      const rows = await executor.all<StateRow>(
        compile(
          db
            .selectFrom('upstream_state')
            .select([
              'etag',
              'last_modified',
              'content_sha256',
              'checked_at',
              'fresh_until',
              'not_found_count',
              'first_not_found_at',
            ])
            .where('org_id', '=', ctx.orgId)
            .where('package_id', '=', packageId)
            .where('form', '=', form),
        ) as ScalarStatement,
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        etag: row.etag,
        lastModified: row.last_modified,
        contentSha256: row.content_sha256,
        checkedAt: row.checked_at,
        freshUntil: row.fresh_until,
        notFoundCount: row.not_found_count,
        firstNotFoundAt: row.first_not_found_at,
      };
    },

    publishStatements(ctx, packageId, form, validators, ttlSeconds) {
      assertValidators(validators);
      return [upsertFrom(ctx, packageId, form, { ...validators, notFound: false }, ttlSeconds)];
    },

    touchStatements(ctx, packageId, form, ttlSeconds) {
      return [
        compile(
          db
            .updateTable('upstream_state')
            .set({
              checked_at: now(),
              fresh_until: later(ttlSeconds),
              not_found_count: 0,
              first_not_found_at: null,
            })
            .where('org_id', '=', ctx.orgId)
            .where('package_id', '=', packageId)
            .where('form', '=', form),
        ) as ScalarStatement,
      ];
    },

    notFoundStatements(ctx, packageId, form, ttlSeconds) {
      return [
        upsertFrom(
          ctx,
          packageId,
          form,
          { etag: null, lastModified: null, contentSha256: null, notFound: true },
          ttlSeconds,
        ),
      ];
    },
  };
}
