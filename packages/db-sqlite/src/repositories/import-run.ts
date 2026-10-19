import { sql, type SqlBool } from 'kysely';
import { REAUTH_WINDOW_MS } from '@package-broker/core/auth/session';
import {
  fenceKind,
  runFenced,
  type MutationFence,
  type TokenMutationFence,
} from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  IMPORT_RUN_JOB,
  validImportApprovalTimestamp,
  type ImportRun,
  type ImportRunOperation,
  type ImportRunStore,
  type ImportRunWrite,
  type ImportRunWriteOutcome,
} from '@package-broker/core/import/run-service';
import { parseSha256, type BlobStore } from '@package-broker/core/platform/blob';
import { ulid } from '@package-broker/core/ids';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { actorHolds } from './actor-authority.js';
import { importWriteAuthority } from './import-authority.js';

const CLOCK = sql`unixepoch('now', 'subsec')`;
type CreateFence = MutationFence | TokenMutationFence;
const COLUMNS = [
  'id',
  'org_id',
  'state',
  'plan_hash',
  'approved_at',
  'approved_by_user_id',
  'accepted_at',
  'before_image_expires_at',
] as const;
interface Row {
  id: string;
  org_id: ImportRun['orgId'];
  state: ImportRun['state'];
  plan_hash: string | null;
  approved_at: string | null;
  approved_by_user_id: string | null;
  accepted_at: string | null;
  before_image_expires_at: string | null;
}
const runOf = (row: Row): ImportRun => ({
  id: row.id,
  orgId: row.org_id,
  state: row.state,
  planHash: row.plan_hash,
  approvedAt: row.approved_at,
  approvedByUserId: row.approved_by_user_id,
  acceptedAt: row.accepted_at,
  beforeImageExpiresAt: row.before_image_expires_at,
});

export function createImportRunStore(options: {
  readonly executor: SqlExecutor;
  readonly blobs: BlobStore;
  readonly providerAnchors: readonly ProtectedHolderProvider[];
}): ImportRunStore {
  const { executor, blobs } = options;
  const anchors = [...options.providerAnchors];
  function session(fence: CreateFence): MutationFence {
    if (fenceKind(fence) !== 'session')
      throw new TypeError('import operation requires a session fence');
    return fence as MutationFence;
  }
  function fresh(ctx: OrgContext, fence: CreateFence): Guard {
    if (fenceKind(fence) !== 'session') return sql<SqlBool>`0`;
    const actor = session(fence);
    return sql<SqlBool>`exists (select 1 from session irs where irs.org_id = ${ctx.orgId}
      and irs.id = ${actor.sessionId} and irs.user_id = ${actor.userId}
      and unixepoch(irs.reauth_at, 'subsec') between ${CLOCK} - ${REAUTH_WINDOW_MS / 1000} and ${CLOCK})`;
  }
  function authority(ctx: OrgContext, fence: CreateFence, operation: ImportRunOperation): Guard {
    if (operation === 'createRun') return importWriteAuthority(ctx, fence, anchors);
    if (fenceKind(fence) !== 'session') throw new TypeError('invalid import fence');
    return actorHolds(ctx, session(fence), {
      permission: 'org:import:approve',
      projectId: null,
      providerAnchors: anchors,
    });
  }
  function target(ctx: OrgContext, id: string) {
    return db
      .selectFrom('import_run')
      .select(COLUMNS)
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', id);
  }
  function expected(ctx: OrgContext, input: ImportRunWrite): Guard {
    const e = input.expected;
    if (e.orgId !== ctx.orgId || e.id !== input.runId) return sql<SqlBool>`0`;
    return sql<SqlBool>`exists ${target(ctx, input.runId)
      .where('state', '=', e.state)
      .where('plan_hash', 'is', e.planHash)
      .where('approved_at', 'is', e.approvedAt)
      .where('approved_by_user_id', 'is', e.approvedByUserId)
      .where('accepted_at', 'is', e.acceptedAt)
      .where('before_image_expires_at', 'is', e.beforeImageExpiresAt)}`;
  }
  const probe = (guard: Guard) =>
    compile(db.selectNoFrom(sql<number>`case when ${guard} is 1 then 0 else 1 end`.as('failed')));
  async function transition(
    ctx: OrgContext,
    fence: MutationFence,
    operation: Exclude<ImportRunOperation, 'createRun'>,
    input: ImportRunWrite,
  ): Promise<ImportRunWriteOutcome> {
    session(fence);
    const allowed = authority(ctx, fence, operation);
    const visible = sql<SqlBool>`exists ${target(ctx, input.runId)}`;
    const reauth = fresh(ctx, fence);
    // Missing targets take precedence over authority failures on both initial reads and failed batches.
    const inspect = async () =>
      executor.all<{ present: number; allowed: number; fresh: number }>(
        compile(
          db.selectNoFrom([
            sql<number>`case when ${visible} then 1 else 0 end`.as('present'),
            sql<number>`case when ${allowed} then 1 else 0 end`.as('allowed'),
            sql<number>`case when ${reauth} then 1 else 0 end`.as('fresh'),
          ]),
        ),
      );
    const [access] = await inspect();
    if (access?.present !== 1) return { ok: false, reason: 'not_found' };
    if (access.allowed !== 1) return { ok: false, reason: 'authority' };
    if (access.fresh !== 1) return { ok: false, reason: 'reauth_required' };
    const e = input.expected;
    const approvalTime = validImportApprovalTimestamp(input.now, Date.now());
    let valid: Guard = sql<SqlBool>`0`;
    let update: Record<string, string> = {};
    const mutations: Statement[] = [];
    switch (operation) {
      case 'approveRun':
        valid = sql<SqlBool>`${approvalTime && e.state === 'planned' && e.approvedAt === null && input.approvedByUserId === fence.userId && input.approvedAt === input.now && input.credentialWindowUntil === new Date(Date.parse(input.now) + 3600000).toISOString() ? 1 : 0} = 1 and unixepoch(${input.now}, 'subsec') <= ${CLOCK} + 60`;
        update = {
          approved_by_user_id: fence.userId,
          approved_at: input.now,
          credential_window_until: input.credentialWindowUntil ?? '',
        };
        break;
      case 'requestApply':
        valid = sql<SqlBool>`${e.state === 'planned' && validImportApprovalTimestamp(e.approvedAt, Date.parse(input.now)) ? 1 : 0} = 1 and unixepoch(${e.approvedAt}, 'subsec') <= ${CLOCK} + 60`;
        update = { state: 'applying' };
        break;
      case 'cancelRun':
        valid = sql<SqlBool>`${e.state === 'planned' ? 1 : 0} = 1`;
        update = { state: 'cancelled' };
        break;
      case 'acceptRun':
        valid = sql<SqlBool>`${e.state === 'verified' && e.acceptedAt === null ? 1 : 0} = 1`;
        update = { accepted_at: input.now };
        break;
      case 'requestRollback':
        valid = sql<SqlBool>`${['failed', 'applied', 'verified'].includes(e.state) ? 1 : 0} = 1
          and (${e.beforeImageExpiresAt} is null or unixepoch(${e.beforeImageExpiresAt}, 'subsec') > ${CLOCK})`;
        break;
    }
    mutations.push(
      ...assertCheck(visible),
      ...assertCheck(reauth),
      ...assertCheck(expected(ctx, input)),
      ...assertCheck(sql<SqlBool>`(${valid})`),
    );
    if (operation === 'requestApply' || operation === 'requestRollback') {
      const type = operation === 'requestApply' ? IMPORT_RUN_JOB.apply : IMPORT_RUN_JOB.rollback;
      const resource = IMPORT_RUN_JOB.resourceKey(input.runId);
      mutations.push(
        ...assertCheck(
          sql<SqlBool>`not exists (select 1 from job irj where irj.org_id = ${ctx.orgId} and irj.resource_key = ${resource} and irj.state in ('queued', 'running'))`,
        ),
      );
      mutations.push(
        compile(
          db.insertInto('job').values({
            id: ulid(),
            org_id: ctx.orgId,
            type,
            resource_key: resource,
            payload_json: JSON.stringify(IMPORT_RUN_JOB.payload(input.runId)),
            created_at: input.now,
            updated_at: input.now,
          }),
        ),
      );
    }
    if (Object.keys(update).length > 0)
      mutations.push(
        compile(
          db
            .updateTable('import_run')
            .set({ ...update, updated_at: input.now })
            .where('org_id', '=', ctx.orgId)
            .where('id', '=', input.runId),
        ),
      );
    mutations.push(input.audit, ...(input.idempotency === undefined ? [] : [input.idempotency]));
    const outcome = await runFenced(executor, fence, assertGuard(allowed, ctx), mutations, {
      authority: probe(allowed),
      conflict: probe(sql<SqlBool>`(${expected(ctx, input)} and ${valid})`),
    });
    if (outcome.ok || outcome.reason === 'indeterminate') return outcome;
    const [current] = await inspect();
    if (current?.present !== 1) return { ok: false, reason: 'not_found' };
    if (current.allowed !== 1) return { ok: false, reason: 'authority' };
    if (current.fresh !== 1) return { ok: false, reason: 'reauth_required' };
    return outcome.reason === 'unclassified' ? { ok: false, reason: 'conflict' } : outcome;
  }
  return {
    async inspect(ctx, fence, operation, runId) {
      const allowed = authority(ctx, fence, operation);
      const reauth = fresh(ctx, fence);
      const [access] = await executor.all<{ allowed: number; fresh: number; run: string | null }>(
        compile(
          db.selectNoFrom([
            sql<number>`case when ${allowed} then 1 else 0 end`.as('allowed'),
            sql<number>`case when ${reauth} then 1 else 0 end`.as('fresh'),
            sql<
              string | null
            >`(select json_object('id', id, 'org_id', org_id, 'state', state, 'plan_hash', plan_hash,
          'approved_at', approved_at, 'approved_by_user_id', approved_by_user_id, 'accepted_at', accepted_at,
          'before_image_expires_at', before_image_expires_at) from import_run where org_id = ${ctx.orgId} and id = ${runId})`.as(
              'run',
            ),
          ]),
        ),
      );
      return {
        run: access?.run == null ? null : runOf(JSON.parse(access.run) as Row),
        allowed: access?.allowed === 1,
        reauthFresh: access?.fresh === 1,
      };
    },
    async createRun(ctx, fence, input) {
      const allowed = authority(ctx, fence, 'createRun');
      const token = fenceKind(fence) === 'token' ? (fence as TokenMutationFence) : null;
      const user =
        token === null
          ? session(fence).userId
          : token.tokenKind === 'pat'
            ? token.principalId
            : null;
      const sp = token?.tokenKind === 'svc' ? token.principalId : null;
      const bytes = new TextEncoder().encode(input.manifest);
      const digest = parseSha256(
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join(''),
      );
      if (digest !== input.planHash) return { ok: false, reason: 'conflict' };
      const [access] = await executor.all<{ denied: number }>(
        compile(db.selectNoFrom(sql<number>`case when ${allowed} then 0 else 1 end`.as('denied'))),
      );
      if (access?.denied !== 0) return { ok: false, reason: 'authority' };
      const [existingBlob] = await executor.all<{ refetchable: number }>(
        compile(
          db
            .selectFrom('blob')
            .select('refetchable')
            .where('org_id', '=', ctx.orgId)
            .where('sha256', '=', digest),
        ),
      );
      if (existingBlob?.refetchable === 1) return { ok: false, reason: 'conflict' };
      await blobs.put(
        ctx,
        digest,
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { size: bytes.length, mediaType: 'application/json', refetchable: false },
      );
      const manifest = sql<SqlBool>`exists (select 1 from blob irb where irb.org_id = ${ctx.orgId} and irb.sha256 = ${digest} and irb.refetchable = 0 and irb.deleted_at is null and irb.purge_after is null)`;
      return runFenced(
        executor,
        fence,
        assertGuard(allowed, ctx),
        [
          ...assertCheck(manifest),
          compile(
            db.insertInto('import_run').values({
              id: input.id,
              org_id: ctx.orgId,
              source_system: input.sourceSystem,
              plan_hash: input.planHash,
              manifest_blob_sha256: digest,
              planned_count: input.plannedCount,
              started_by_user_id: user,
              started_by_service_principal_id: sp,
              created_at: input.now,
              updated_at: input.now,
            }),
          ),
          input.audit,
          ...(input.idempotency === undefined ? [] : [input.idempotency]),
        ],
        {
          authority: probe(allowed),
          conflict: probe(manifest),
          collision: compile(
            db.selectNoFrom(sql<number>`exists ${target(ctx, input.id)}`.as('collision')),
          ),
        },
      );
    },
    approveRun: (ctx, fence, input) => transition(ctx, fence, 'approveRun', input),
    requestApply: (ctx, fence, input) => transition(ctx, fence, 'requestApply', input),
    cancelRun: (ctx, fence, input) => transition(ctx, fence, 'cancelRun', input),
    acceptRun: (ctx, fence, input) => transition(ctx, fence, 'acceptRun', input),
    requestRollback: (ctx, fence, input) => transition(ctx, fence, 'requestRollback', input),
  };
}
