import * as z from 'zod';
import type { OrgContext } from '../../db/port.js';
import { AUDIT_ALERT_CODES, type AuditHealth } from '../../audit/health.js';
import type { AuditStatusReader, EffectiveAuditReader } from '../../audit/status.js';
import { apiRoute } from '../route.js';

export function auditHealthRoutes(reader?: { read(ctx: OrgContext): Promise<AuditHealth> }) {
  return [
    apiRoute(
      {
        method: 'GET',
        path: '/_pb/audit/health',
        permission: 'org:audit:read',
        boundary: 'organization',
        api: {
          operationId: 'getAuditHealth',
          summary: 'Read audit health',
          tags: ['audit'],
          responses: {
            200: z
              .object({
                status: z.enum(['ok', 'degraded', 'failing']),
                codes: z.array(z.enum(AUDIT_ALERT_CODES)),
              })
              .strict(),
          },
        },
      },
      async ({ ctx }) => {
        if (ctx.org === null) throw new TypeError('route requires an organization context');
        if (reader === undefined) return { error: 'audit_trail_unavailable' };
        const health = await reader.read(ctx.org);
        return { status: 200, body: { status: health.status, codes: [...health.codes] } };
      },
    ),
  ];
}

const sequence = z.number().int().nonnegative();
const mode = z.enum(['trail', 'export', 'none']);
const healthSchema = z.strictObject({
  status: z.enum(['ok', 'degraded', 'failing']),
  codes: z.array(z.enum(AUDIT_ALERT_CODES)),
});
const statusSchema = z.strictObject({
  chainId: z.string(),
  epoch: sequence,
  headSeq: sequence,
  headHash: z.string(),
  boundarySeq: sequence,
  boundaryPrevHash: z.string(),
  pendingCount: sequence,
  verification: z
    .strictObject({
      fromSeq: sequence,
      throughSeq: sequence,
      bodies: sequence,
      withheld: sequence,
      verifiedAt: z.string(),
    })
    .nullable(),
  policy: z.enum(['availability', 'required']),
  policySource: z.enum(['build', 'env', 'stored']),
  mode,
  pendingMode: mode.optional(),
  modeSource: z.enum(['build', 'env', 'stored']),
  trailActive: z.boolean(),
  capacity: z.strictObject({
    state: z.enum(['ok', 'warning', 'refusing']),
    journalRows: sequence,
    journalBytes: sequence,
    maxJournalBytes: sequence.nullable(),
  }),
  restorePending: z.boolean(),
  sinks: z.array(
    z.strictObject({
      id: z.string(),
      state: z.enum(['active', 'inactive', 'blocked', 'disabled', 'retired']),
      progressSeq: sequence,
      custodySeq: sequence,
      durableAck: z.boolean(),
      activationSource: z.string(),
    }),
  ),
  ledger: z.array(z.strictObject({ kind: z.string(), count: sequence })),
  health: healthSchema,
});

export function auditStatusRoutes(deps?: {
  readonly reader: AuditStatusReader;
  readonly effective: EffectiveAuditReader;
  readonly health: { read(ctx: OrgContext): Promise<AuditHealth> };
  readonly modeSource: (ctx: OrgContext) => Promise<'build' | 'env' | 'stored'>;
}) {
  return [
    apiRoute(
      {
        method: 'GET',
        path: '/_pb/audit/status',
        permission: 'org:audit:read',
        boundary: 'organization',
        api: {
          operationId: 'getAuditStatus',
          summary: 'Read audit status',
          tags: ['audit'],
          responses: { 200: statusSchema },
        },
      },
      async ({ ctx }) => {
        if (ctx.org === null) throw new TypeError('route requires an organization context');
        if (deps === undefined) return { error: 'audit_trail_unavailable' };
        const snapshot = await deps.reader.read(ctx.org);
        const effective = await deps.effective(ctx.org);
        const health = await deps.health.read(ctx.org);
        return {
          status: 200,
          body: {
            chainId: snapshot.chainId,
            epoch: snapshot.epoch,
            headSeq: snapshot.headSeq,
            headHash: snapshot.headHash,
            boundarySeq: snapshot.boundarySeq,
            boundaryPrevHash: snapshot.boundaryPrevHash,
            pendingCount: snapshot.pendingCount,
            mode: effective.mode,
            ...(snapshot.mode === effective.mode ? {} : { pendingMode: snapshot.mode }),
            restorePending: snapshot.restorePending,
            verification:
              snapshot.verification === null
                ? null
                : {
                    fromSeq: snapshot.verification.fromSeq,
                    throughSeq: snapshot.verification.throughSeq,
                    bodies: snapshot.verification.bodies,
                    withheld: snapshot.verification.withheld,
                    verifiedAt: snapshot.verification.verifiedAt,
                  },
            sinks: snapshot.sinks.map(
              ({ id, state, progressSeq, custodySeq, durableAck, activationSource }) => ({
                id,
                state,
                progressSeq,
                custodySeq,
                durableAck,
                activationSource,
              }),
            ),
            ledger: snapshot.ledger.map(({ kind, count }) => ({ kind, count })),
            policy: effective.policy,
            policySource: effective.policySource,
            modeSource: await deps.modeSource(ctx.org),
            trailActive: effective.trailActive,
            capacity: {
              state: snapshot.capacity.state,
              journalRows: snapshot.capacity.journalRows,
              journalBytes: snapshot.capacity.journalBytes,
              maxJournalBytes: effective.maxJournalBytes,
            },
            health: { status: health.status, codes: [...health.codes] },
          },
        };
      },
    ),
  ];
}
