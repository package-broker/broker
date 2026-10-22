import type { OrgContext } from '../db/port.js';
import type { JobDefinition } from '../platform/jobs.js';
import { AUDIT_GENESIS_HASH, type AuditRow, type ChainBreak, verifyChain } from './chain.js';

export interface AuditVerifyReader {
  markVerified(ctx: OrgContext, completedAt: string): Promise<void>;
  page(ctx: OrgContext, afterSeq: number, limit: number): Promise<readonly AuditRow[]>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export function auditVerifyJob(reader: AuditVerifyReader): JobDefinition<{}> {
  return {
    name: 'audit-verify',
    version: 1,
    schedule: { everySeconds: 86400 },
    maxAttempts: 2,
    validate: () => ({}),
    async handler(_payload, ctx) {
      let headSeq = 0;
      let headHash = AUDIT_GENESIS_HASH;
      let rows = 0;
      const partial = (): void =>
        ctx.observability.log({ level: 'warn', event: 'audit.verify_partial', rows });
      const broken = (seq: number, reason: ChainBreak['reason'] | 'org_mismatch'): void => {
        ctx.observability.log({ level: 'error', event: 'audit.chain_broken', seq, reason });
        ctx.observability.counter('pb.audit.chain_broken');
      };
      while (!ctx.signal.aborted) {
        const page = await reader.page(ctx.org, headSeq, 500);
        const first = page[0];
        if (first === undefined) {
          if (ctx.signal.aborted) return partial();
          await reader.markVerified(ctx.org, ctx.ports.clock.now().toISOString());
          ctx.observability.log({
            level: 'info',
            event: 'audit.verified',
            head_seq: headSeq,
            head_hash: headHash,
            rows,
          });
          return;
        }
        const invalidIndex = page.findIndex((row) => !Number.isSafeInteger(row.seq) || row.seq < 1);
        const validRows = invalidIndex === -1 ? page : page.slice(0, invalidIndex);
        const validFirst = validRows[0];
        if (validFirst !== undefined && validFirst.seq !== headSeq + 1) {
          return broken(validFirst.seq, 'seq_gap');
        }
        const foreignIndex = validRows.findIndex((row) => row.org_id !== ctx.org.orgId);
        const ownRows = foreignIndex === -1 ? validRows : validRows.slice(0, foreignIndex);
        const failure = await verifyChain(ownRows, headHash);
        if (failure !== null) return broken(failure.seq, failure.reason);
        if (foreignIndex !== -1) return broken(page[foreignIndex]!.seq, 'org_mismatch');
        if (invalidIndex !== -1) {
          return broken(validRows[validRows.length - 1]?.seq ?? headSeq, 'seq_gap');
        }
        const last = page[page.length - 1]!;
        headSeq = last.seq;
        headHash = last.hash;
        rows += page.length;
      }
      partial();
    },
  };
}
