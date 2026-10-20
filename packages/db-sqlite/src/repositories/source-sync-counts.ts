import type { SourceSyncDeps } from '@package-broker/core/ingest/source-sync-job';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import { openMatches, unseenSourcePackages } from './catalogue-reconcile.js';
import { markedRows } from './ingest-finalize.js';

export type SourceSyncCounts = Pick<SourceSyncDeps, 'markedCount' | 'unseenExistingCount'>;

function requireSourceId(sourceId: string): void {
  if (typeof sourceId !== 'string' || sourceId === '') {
    throw new RangeError('source id must be a non-empty string');
  }
}

export function markedCountStatement(ctx: OrgContext, sourceId: string, stamp: string): Statement {
  requireSourceId(sourceId);
  return compile(
    db.selectNoFrom(markedRows(ctx, { kind: 'source', sourceId }, stamp).as('marked')),
  );
}

export function unseenExistingCountStatement(
  ctx: OrgContext,
  sourceId: string,
  stamp: string,
): Statement {
  requireSourceId(sourceId);
  return compile(
    db.selectNoFrom([
      unseenSourcePackages(ctx, sourceId).as('unseen'),
      openMatches(ctx, { kind: 'source', sourceId }, stamp).as('listing_open'),
    ]),
  );
}

function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('a count read must return a non-negative safe integer');
  }
  return value;
}

export function createSourceSyncCounts(executor: SqlExecutor): SourceSyncCounts {
  return {
    async markedCount(ctx, sourceId, stamp) {
      const [row] = await executor.all<{ marked: number }>(
        markedCountStatement(ctx, sourceId, stamp),
      );
      return safeCount(row?.marked);
    },
    async unseenExistingCount(ctx, sourceId, stamp) {
      const [row] = await executor.all<{ unseen: number; listing_open: number }>(
        unseenExistingCountStatement(ctx, sourceId, stamp),
      );
      if (row?.listing_open !== 1) throw new Error('the source listing is not open for this stamp');
      return safeCount(row.unseen);
    },
  };
}
