import type { BlobReplacer } from '@package-broker/core/ingest/dist-fetch';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { replaceBlobStatements } from './catalogue-reblob.js';

export function createBlobReplacer(executor: SqlExecutor): BlobReplacer {
  return {
    async replaceBlob(ctx, guard, request) {
      const plan = replaceBlobStatements(ctx, guard, request);
      for (const statement of plan.statements) {
        if (statement.params.length > 100) throw new RangeError('statement exceeds 100 parameters');
      }
      return plan.result(await executor.batch(plan.statements));
    },
  };
}
