import { sql } from 'kysely';
import type { SourceSyncDeps } from '@package-broker/core/ingest/source-sync-job';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';

export type SourceSyncReads = Pick<SourceSyncDeps, 'existingKeys' | 'staleHeldKeys'>;

const NAMES_PER_STATEMENT = 98;

function requireSourceId(sourceId: string): void {
  if (typeof sourceId !== 'string' || sourceId === '') {
    throw new RangeError('source id must be a non-empty string');
  }
}

export function existingKeysStatement(
  ctx: OrgContext,
  sourceId: string,
  names: readonly string[],
): Statement {
  requireSourceId(sourceId);
  if (names.length < 1 || names.length > NAMES_PER_STATEMENT) {
    throw new RangeError('existing keys statement requires between 1 and 98 names');
  }
  return compile(
    db
      .selectFrom('package')
      .select('name')
      .where('org_id', '=', ctx.orgId)
      .where('source_id', '=', sourceId)
      .where('name', 'in', names),
  );
}

export function staleHeldKeysStatement(
  ctx: OrgContext,
  sourceId: string,
  query: { readonly after: string | null; readonly limit: number },
): Statement {
  requireSourceId(sourceId);
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit >= Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError('limit must be a positive safe integer with room for a lookahead');
  }
  return compile(
    db
      .selectFrom('package as p')
      .innerJoin('source as s', (join) =>
        join.onRef('s.id', '=', 'p.source_id').onRef('s.org_id', '=', 'p.org_id'),
      )
      .select('p.name')
      .where('p.org_id', '=', ctx.orgId)
      .where('p.source_id', '=', sourceId)
      .where(
        'p.ecosystem',
        '=',
        sql<
          'npm' | 'composer'
        >`case when s.type in ('npmjs_proxy', 'npm_registry') then 'npm' else 'composer' end`,
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('upstream_state as u')
              .select('u.package_id')
              .whereRef('u.org_id', '=', 'p.org_id')
              .whereRef('u.package_id', '=', 'p.id')
              // These are the default forms used by upstreamForm for sources without listings.
              .where(
                'u.form',
                '=',
                sql<
                  'npm-packument' | 'composer-p2'
                >`case when s.type in ('npmjs_proxy', 'npm_registry') then 'npm-packument' else 'composer-p2' end`,
              )
              .where('u.not_found_count', '=', 0)
              .where('u.fresh_until', '>', sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`),
          ),
        ),
      )
      .$if(query.after !== null, (qb) => qb.where('p.name', '>', query.after!))
      .orderBy('p.name', 'asc')
      .limit(query.limit + 1),
  );
}

export function createSourceSyncReads(executor: SqlExecutor): SourceSyncReads {
  return {
    async existingKeys(ctx, sourceId, names) {
      requireSourceId(sourceId);
      const keys = new Set<string>();
      for (let offset = 0; offset < names.length; offset += NAMES_PER_STATEMENT) {
        const rows = await executor.all<{ name: string }>(
          existingKeysStatement(ctx, sourceId, names.slice(offset, offset + NAMES_PER_STATEMENT)),
        );
        for (const row of rows) keys.add(row.name);
      }
      return keys;
    },
    async staleHeldKeys(ctx, sourceId, query) {
      const rows = await executor.all<{ name: string }>(
        staleHeldKeysStatement(ctx, sourceId, query),
      );
      const keys = rows.slice(0, query.limit).map((row) => row.name);
      return { keys, next: rows.length > query.limit ? keys[keys.length - 1]! : null };
    },
  };
}
