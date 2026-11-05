import { raiseAuditAlert, type AuditHealthPort } from './health.js';
import type { OrgContext } from '../db/port.js';
import { requirePlatformPorts } from '../plugin.js';
import { JobError, type JobDefinition, type Jobs } from '../platform/jobs.js';
import { sha256Hex } from '../auth/primitives.js';
import { payloadMatches } from './wire.js';
import { type AuditRow, type ChainBreak, verifyChain } from './chain.js';

export interface AuditVerifySnapshot {
  chain_id: string;
  epoch: number;
  incarnation: number;
  mode_generation: number;
  boundary_seq: number;
  boundary_prev_hash: string;
  stored_seq: number;
  stored_hash: string;
  head_seq: number;
  head_hash: string;
}

export interface AuditVerificationScope {
  fromSeq: number;
  throughSeq: number;
  bodies: number;
  withheld: number;
}

export interface AuditVerifyReader {
  snapshot(ctx: OrgContext): Promise<AuditVerifySnapshot>;
  markVerified(
    ctx: OrgContext,
    completedAt: string,
    scope: AuditVerificationScope,
    snapshot: AuditVerifySnapshot,
  ): Promise<boolean>;
  clearVerification(ctx: OrgContext, snapshot?: AuditVerifySnapshot): Promise<boolean | void>;
  page(ctx: OrgContext, afterSeq: number, limit: number): Promise<readonly AuditRow[]>;
}

interface VerifyCursor {
  snapshot: AuditVerifySnapshot;
  nextSeq: number;
  prevHash: string;
  bodies: number;
  withheld: number;
  runId: string;
}

type VerifyPayload = { cursor?: VerifyCursor };

const HASH = /^[0-9a-f]{64}$/;
const SNAPSHOT_KEYS = [
  'chain_id',
  'epoch',
  'incarnation',
  'mode_generation',
  'boundary_seq',
  'boundary_prev_hash',
  'stored_seq',
  'stored_hash',
  'head_seq',
  'head_hash',
] as const;

function validSnapshot(snapshot: AuditVerifySnapshot): boolean {
  return (
    typeof snapshot.chain_id === 'string' &&
    snapshot.chain_id.length > 0 &&
    [
      snapshot.epoch,
      snapshot.incarnation,
      snapshot.mode_generation,
      snapshot.stored_seq,
      snapshot.head_seq,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    Number.isSafeInteger(snapshot.boundary_seq) &&
    snapshot.boundary_seq >= 1 &&
    snapshot.boundary_seq - 1 <= snapshot.head_seq &&
    snapshot.stored_seq <= snapshot.head_seq &&
    [snapshot.head_hash, snapshot.stored_hash, snapshot.boundary_prev_hash].every(
      (value) => typeof value === 'string' && HASH.test(value),
    )
  );
}

function sameRange(a: AuditVerifySnapshot, b: AuditVerifySnapshot): boolean {
  return SNAPSHOT_KEYS.slice(0, 6).every((key) => a[key] === b[key]);
}

export async function requestVerification(jobs: Jobs, org: OrgContext, now: Date): Promise<void> {
  await jobs.enqueue(
    org,
    'core:audit-verify:v1',
    {},
    {
      idempotencyKey: `audit-verify:${now.toISOString().slice(0, 16)}`,
      resourceKey: 'audit-verify',
    },
  );
}

export function auditVerifyJob(
  reader: AuditVerifyReader,
  health?: Pick<AuditHealthPort, 'raise'>,
): JobDefinition<VerifyPayload> {
  return {
    name: 'audit-verify',
    version: 1,
    schedule: { everySeconds: 86400, resourceKey: 'audit-verify' },
    maxAttempts: 2,
    validate(input) {
      if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      )
        throw new JobError('invalid_payload');
      if (Reflect.ownKeys(input).length === 0) return {};
      if (Reflect.ownKeys(input).length !== 1 || !Object.hasOwn(input, 'cursor'))
        throw new JobError('invalid_payload');
      const cursor = (input as VerifyPayload).cursor;
      if (
        typeof cursor !== 'object' ||
        cursor === null ||
        Object.keys(cursor).sort().join(',') !==
          'bodies,nextSeq,prevHash,runId,snapshot,withheld' ||
        typeof cursor.snapshot !== 'object' ||
        cursor.snapshot === null ||
        Object.keys(cursor.snapshot).sort().join(',') !== [...SNAPSHOT_KEYS].sort().join(',') ||
        !validSnapshot(cursor.snapshot) ||
        cursor.snapshot.stored_seq < cursor.snapshot.boundary_seq - 1 ||
        !Number.isSafeInteger(cursor.nextSeq) ||
        cursor.nextSeq < cursor.snapshot.boundary_seq ||
        cursor.nextSeq - 1 > cursor.snapshot.head_seq ||
        typeof cursor.prevHash !== 'string' ||
        !HASH.test(cursor.prevHash) ||
        ![cursor.bodies, cursor.withheld].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        cursor.bodies + cursor.withheld !== cursor.nextSeq - cursor.snapshot.boundary_seq ||
        typeof cursor.runId !== 'string' ||
        cursor.runId.length < 1 ||
        cursor.runId.length > 160
      )
        throw new JobError('invalid_payload');
      return { cursor };
    },
    async handler(payload, ctx) {
      if (ctx.signal.aborted) {
        ctx.observability.log({ level: 'warn', event: 'audit.verify_partial', rows: 0 });
        return;
      }
      const current = await reader.snapshot(ctx.org);
      if (!validSnapshot(current)) throw new Error('audit verification snapshot invalid');
      if (current.stored_seq < current.boundary_seq - 1) {
        if ((await reader.clearVerification(ctx.org, current)) === false) {
          ctx.observability.log({ level: 'warn', event: 'audit.verify_partial', rows: 0 });
          return;
        }
        await raiseAuditAlert(health, ctx.org, 'audit.chain_integrity');
        ctx.observability.log({
          level: 'error',
          event: 'audit.chain_integrity',
          reason: 'checkpoint_pruned',
        });
        ctx.observability.counter('pb.audit.chain_integrity');
        ctx.observability.log({ level: 'warn', event: 'audit.verify_partial', rows: 0 });
        return;
      }
      const snapshot = payload.cursor?.snapshot ?? { ...current };
      let headSeq =
        payload.cursor === undefined ? snapshot.boundary_seq - 1 : payload.cursor.nextSeq - 1;
      let headHash = payload.cursor?.prevHash ?? snapshot.boundary_prev_hash;
      let bodies = payload.cursor?.bodies ?? 0;
      let withheld = payload.cursor?.withheld ?? 0;
      let rows = bodies + withheld;
      const partial = (): void =>
        ctx.observability.log({ level: 'warn', event: 'audit.verify_partial', rows });
      if (payload.cursor !== undefined && !sameRange(snapshot, current)) return partial();
      const broken = async (
        seq: number,
        reason: ChainBreak['reason'] | 'org_mismatch',
      ): Promise<void> => {
        if (!sameRange(snapshot, await reader.snapshot(ctx.org))) return partial();
        if ((await reader.clearVerification(ctx.org, snapshot)) === false) return partial();
        await raiseAuditAlert(health, ctx.org, 'audit.chain_integrity');
        ctx.observability.log({ level: 'error', event: 'audit.chain_broken', seq, reason });
        ctx.observability.counter('pb.audit.chain_broken');
      };
      if (
        snapshot.stored_seq === snapshot.boundary_seq - 1 &&
        snapshot.stored_hash !== snapshot.boundary_prev_hash
      )
        return broken(snapshot.stored_seq, 'hash');
      if (payload.cursor !== undefined) {
        for (const [seq, hash] of [
          [snapshot.head_seq, snapshot.head_hash],
          [snapshot.stored_seq, snapshot.stored_hash],
        ] as const) {
          if (seq === snapshot.boundary_seq - 1) {
            if (hash !== snapshot.boundary_prev_hash) return broken(seq, 'hash');
            continue;
          }
          const [row] = await reader.page(ctx.org, seq - 1, 1);
          if (row?.seq !== seq) return broken(seq, 'seq_gap');
          if (row.org_id !== ctx.org.orgId) return broken(seq, 'org_mismatch');
          if (row.hash !== hash) return broken(seq, 'hash');
        }
      }
      let pages = 0;
      while (!ctx.signal.aborted) {
        if (pages === 20) {
          const cursor: VerifyCursor = {
            snapshot,
            nextSeq: headSeq + 1,
            prevHash: headHash,
            bodies,
            withheld,
            runId: payload.cursor?.runId ?? ctx.jobId,
          };
          const continuation = await requirePlatformPorts(ctx.ports).jobs.enqueue(
            ctx.org,
            'core:audit-verify:v1',
            { cursor },
            {
              idempotencyKey: `audit-verify:continue:${await sha256Hex(JSON.stringify(cursor))}`,
              resourceKey: 'audit-verify',
            },
          );
          if (continuation.created) {
            ctx.observability.log({
              level: 'info',
              event: 'audit.verify_continued',
              seq: headSeq,
              rows,
            });
          }
          return;
        }
        pages += 1;
        const page = (await reader.page(ctx.org, headSeq, 500)).filter(
          (row) => row.seq <= snapshot.head_seq || !Number.isSafeInteger(row.seq),
        );
        const first = page[0];
        if (first === undefined) {
          if (ctx.signal.aborted) return partial();
          if (headSeq !== snapshot.head_seq) return broken(headSeq, 'seq_gap');
          if (headHash !== snapshot.head_hash) return broken(headSeq, 'hash');
          const saved = await reader.markVerified(
            ctx.org,
            ctx.ports.clock.now().toISOString(),
            {
              fromSeq: snapshot.boundary_seq,
              throughSeq: headSeq,
              bodies,
              withheld,
            },
            snapshot,
          );
          if (!saved) return partial();
          ctx.observability.log({
            level: 'info',
            event: 'audit.verified',
            head_seq: headSeq,
            head_hash: headHash,
            rows,
            from_seq: snapshot.boundary_seq,
            bodies,
            withheld,
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
        const failure = await verifyChain(ownRows, headHash, headSeq + 1);
        if (failure !== null) return broken(failure.seq, failure.reason);
        if (foreignIndex !== -1) return broken(page[foreignIndex]!.seq, 'org_mismatch');
        if (invalidIndex !== -1) {
          return broken(validRows[validRows.length - 1]?.seq ?? headSeq, 'seq_gap');
        }
        const stored = page.find((row) => row.seq === snapshot.stored_seq);
        if (stored !== undefined && stored.hash !== snapshot.stored_hash)
          return broken(stored.seq, 'hash');
        const last = page[page.length - 1]!;
        headSeq = last.seq;
        headHash = last.hash;
        rows += page.length;
        for (const row of page) {
          if (payloadMatches(row)) bodies += 1;
          else withheld += 1;
        }
      }
      partial();
    },
  };
}
