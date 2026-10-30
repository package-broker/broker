import * as z from 'zod';
import { auditEvent, type AuditEvent } from '../../audit/actions.js';
import type { AuditLedgerEntry } from '../../audit/ledger.js';
import type {
  AuditHeadV1,
  AuditJournalReader,
  AuditJournalItemV1,
} from '../../audit/plugin-api.js';
import type { SessionService } from '../../auth/session.js';
import { authenticatedActorOf, organizationActorOf } from '../../authz/access-context.js';
import { mutationFence, type MutationFence } from '../../authz/fence.js';
import type { OrgContext } from '../../db/port.js';
import type { RouteDefinition } from '../../plugin.js';
import { apiRoute } from '../route.js';
import { auditCall, type ApiRouteDeps } from './context.js';

export interface AuditExportSnapshot {
  readonly head: AuditHeadV1;
  readonly policy: 'availability' | 'required';
  readonly modeGeneration: number;
}

export interface AuditExportStore {
  journal(org: OrgContext): AuditJournalReader;
  rateAvailable(org: OrgContext, userId: string): Promise<boolean>;
  snapshot(org: OrgContext): Promise<AuditExportSnapshot>;
  dispositions(
    org: OrgContext,
    snapshot: AuditExportSnapshot,
    from: number,
    to: number,
  ): Promise<readonly AuditLedgerEntry[]>;
  record(
    org: OrgContext,
    fence: MutationFence,
    snapshot: AuditExportSnapshot,
    event: AuditEvent,
    entries: readonly AuditLedgerEntry[],
  ): Promise<
    'recorded' | 'forbidden' | 'conflict' | 'rate_limited' | 'payload_too_large' | 'unavailable'
  >;
}

export interface AuditExportDeps extends ApiRouteDeps {
  readonly store: AuditExportStore;
  readonly sessions: Pick<SessionService, 'authenticate' | 'isReauthFresh'>;
  readonly alert: (org: OrgContext) => void;
}

const sequence = z
  .string()
  .max(16)
  .regex(/^[1-9][0-9]*$/);
const querySchema = z.strictObject({ from_seq: sequence.optional(), to_seq: sequence.optional() });
const hash = z.string();
const integer = z.number().int().nonnegative();
const identity = {
  chain_id: z.string(),
  epoch: integer,
  org_id: z.string(),
  seq: integer,
  prev_hash: hash,
  hash,
};
const metadata = {
  id: z.string(),
  created_at: z.string(),
  actor_type: z.string(),
  actor_id: z.string().nullable(),
  action: z.string(),
  target_type: z.string(),
  target_id: z.string().nullable(),
  project_id: z.string().nullable(),
};
const responseSchema = z.strictObject({
  schema: z.literal('audit-chain/1'),
  snapshot: z.strictObject({
    chainId: z.string(),
    epoch: integer,
    headSeq: integer,
    headHash: hash,
    boundarySeq: integer,
    boundaryPrevHash: hash,
  }),
  fromSeq: integer,
  toSeq: integer,
  next_from_seq: integer.nullable(),
  items: z.array(
    z.union([
      z.strictObject({
        kind: z.literal('event'),
        ...identity,
        ...metadata,
        token_selector: z.string().nullable(),
        payload_json: z.string(),
        source_ip: z.string().nullable().optional(),
      }),
      z.strictObject({
        kind: z.literal('withheld'),
        ...identity,
        ...metadata,
        marker_id: z.string(),
        reason_code: z.string(),
      }),
      z.strictObject({
        kind: z.literal('withheld'),
        ...identity,
        marker_id: z.string(),
        reason_code: z.literal('unreadable'),
      }),
    ]),
  ),
  dispositions: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      chainId: z.string(),
      epoch: integer,
      fromSeq: integer,
      toSeq: integer,
      count: integer,
      sinkId: z.string().nullable(),
      reasonCode: z.string(),
      policy: z.string(),
      modeGeneration: integer,
      actorType: z.string(),
      actorId: z.string().nullable(),
      createdAt: z.string(),
      resolvesId: z.string().nullable().optional(),
      capacity: z
        .strictObject({
          prevHash: hash,
          hash,
          affectedSinkIds: z.array(z.string()),
          affectedSinkIdsOverflow: z.literal(true).optional(),
        })
        .optional(),
    }),
  ),
});

const wireNames: Readonly<Record<string, string>> = {
  chainId: 'chain_id',
  orgId: 'org_id',
  prevHash: 'prev_hash',
  createdAt: 'created_at',
  actorType: 'actor_type',
  actorId: 'actor_id',
  tokenSelector: 'token_selector',
  targetType: 'target_type',
  targetId: 'target_id',
  projectId: 'project_id',
  payloadJson: 'payload_json',
  sourceIp: 'source_ip',
  markerId: 'marker_id',
  reasonCode: 'reason_code',
};
function exportItem(item: AuditJournalItemV1): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => [wireNames[key] ?? key, value]),
  );
}

export function auditExportRoutes(deps?: AuditExportDeps): readonly RouteDefinition[] {
  return [
    apiRoute(
      {
        method: 'GET',
        path: '/_pb/audit/export',
        permission: 'org:audit:export',
        boundary: 'organization',
        api: {
          operationId: 'exportAudit',
          summary: 'Export retained audit records',
          tags: ['audit'],
          query: querySchema,
          responses: { 200: responseSchema },
        },
      },
      async ({ ctx, query }) => {
        if (deps === undefined) return { error: 'unavailable' };
        const org = ctx.org;
        const actor = authenticatedActorOf(ctx);
        const organization = organizationActorOf(ctx);
        if (org === null || actor === null) return { error: 'unauthorized' };
        if (
          organization?.isOrganizationAdmin !== true ||
          !organization.permissions.has('org:audit:export')
        )
          return { error: 'forbidden' };
        const session = await deps.sessions.authenticate(org, ctx.request);
        if (
          session === null ||
          session.session.id !== actor.sessionId ||
          session.session.userId !== actor.userId
        )
          return { error: 'unauthorized' };
        if (!deps.sessions.isReauthFresh(session)) return { error: 'reauth_required' };
        if (!(await deps.store.rateAvailable(org, actor.userId))) return { error: 'rate_limited' };
        const snapshot = await deps.store.snapshot(org);
        const { head } = snapshot;
        const from = Number(query.from_seq ?? (head.headSeq === 0 ? 0 : head.boundarySeq));
        const to = Number(query.to_seq ?? Math.max(from, Math.min(head.headSeq, from + 1999)));
        if (
          !Number.isSafeInteger(from) ||
          !Number.isSafeInteger(to) ||
          (from < 1 && head.headSeq !== 0) ||
          to < from ||
          to - from >= 2000
        )
          return { error: 'invalid_request' };
        if (
          (head.headSeq !== 0 && from < head.boundarySeq) ||
          (head.headSeq === 0
            ? query.from_seq !== undefined || query.to_seq !== undefined
            : to > head.headSeq)
        )
          return { error: 'conflict' };
        const reader = deps.store.journal(org);
        const items: AuditJournalItemV1[] = [];
        let after = from - 1;
        while (head.headSeq > 0 && after < to) {
          const page = await reader.list({
            projectId: null,
            afterSeq: after,
            limit: Math.min(2000, to - after),
          });
          for (const item of page.items) {
            if (
              item.chainId !== head.chainId ||
              item.epoch !== head.epoch ||
              item.orgId !== org.orgId
            )
              return { error: 'conflict' };
            if (item.seq <= to) items.push(item);
          }
          const last = page.items.at(-1)?.seq;
          if (last === undefined || page.next === null || last >= to) break;
          if (last <= after) return { error: 'unavailable' };
          after = last;
        }
        const dispositions =
          head.headSeq === 0 ? [] : await deps.store.dispositions(org, snapshot, from, to);
        if (dispositions.length > 2000) return { error: 'payload_too_large' };
        const now = deps.clock.now().toISOString();
        const withheld = items.filter((item) => item.kind === 'withheld').length;
        const entries: AuditLedgerEntry[] = [
          {
            id: deps.ids.ulid(),
            kind: 'export',
            chainId: head.chainId,
            epoch: head.epoch,
            fromSeq: Math.max(1, from),
            toSeq: Math.max(1, to),
            count: items.length,
            sinkId: null,
            reasonCode: 'api_export',
            policy: snapshot.policy,
            modeGeneration: snapshot.modeGeneration,
            actorType: 'user',
            actorId: actor.userId,
            createdAt: now,
          },
        ];
        const event = auditEvent({
          id: deps.ids.ulid(),
          now,
          action: 'audit.export',
          actor: { type: 'user', id: actor.userId },
          target: { type: 'organization', id: org.orgId },
          context: auditCall(ctx, deps).audit,
          changes: {
            from_seq: { new: from },
            to_seq: { new: to },
            count: { new: items.length },
            withheld: { new: withheld },
            format: { new: 'api' },
          },
        });
        if (!event.ok) return { error: 'unavailable' };
        const result = await deps.store.record(
          org,
          mutationFence(actor, {}),
          snapshot,
          event.event,
          entries,
        );
        if (result !== 'recorded') return { error: result };
        if (withheld > 0) deps.alert(org);
        const { chainId, epoch, headSeq, headHash, boundarySeq, boundaryPrevHash } = head;
        return {
          status: 200,
          body: {
            schema: 'audit-chain/1',
            snapshot: { chainId, epoch, headSeq, headHash, boundarySeq, boundaryPrevHash },
            fromSeq: from,
            toSeq: to,
            next_from_seq: to < headSeq ? to + 1 : null,
            items: items.map(exportItem),
            dispositions,
          },
        };
      },
    ),
  ];
}
