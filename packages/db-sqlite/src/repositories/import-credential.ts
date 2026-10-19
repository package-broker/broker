import { sql, type SqlBool } from 'kysely';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import type {
  CredentialTarget,
  ImportCredentialStore,
} from '@package-broker/core/import/credentials';
import { parseSha256, type BlobStore } from '@package-broker/core/platform/blob';
import {
  assertCheck,
  assertGuard,
  compile,
  db,
  runOrgFenced,
  type Guard,
  type ProtectedHolderProvider,
} from '../kysely.js';
import { importWriteAuthority } from './import-authority.js';

const CLOCK = sql`unixepoch('now', 'subsec')`;
const probe = (condition: Guard) =>
  compile(db.selectNoFrom(sql<number>`case when ${condition} is 1 then 0 else 1 end`.as('failed')));

export function createImportCredentialRepository(
  executor: SqlExecutor,
  options: {
    readonly blobs: Pick<BlobStore, 'get'>;
    readonly providerAnchors: readonly ProtectedHolderProvider[];
  },
): ImportCredentialStore {
  const anchors = [...options.providerAnchors];
  const target = (ctx: OrgContext, runId: string) =>
    db
      .selectFrom('import_run as icr')
      .select('icr.id')
      .where('icr.org_id', '=', ctx.orgId)
      .where('icr.id', '=', runId);
  const source = (ctx: OrgContext, runId: string, externalRef: string) =>
    db
      .selectFrom('import_ref as icf')
      .innerJoin('source as ics', (join) =>
        join.onRef('ics.id', '=', 'icf.entity_id').onRef('ics.org_id', '=', 'icf.org_id'),
      )
      .where('icf.org_id', '=', ctx.orgId)
      .where('icf.import_run_id', '=', runId)
      .where('icf.entity_type', '=', 'source')
      .where('icf.external_ref', '=', externalRef)
      .where('icf.action', '=', 'create')
      .where('icf.rolled_back_at', 'is', null);
  return {
    async inspect(ctx, fence, runId, externalRef) {
      const allowed = importWriteAuthority(ctx, fence, anchors);
      const sourceJson = source(ctx, runId, externalRef).select(
        sql<string>`json_object('id', ics.id, 'projectId', ics.project_id, 'credentialId', ics.credential_id)`.as(
          'source',
        ),
      );
      const runJson = target(ctx, runId)
        .clearSelect()
        .select(
          sql<string>`json_object('approvedAt', icr.approved_at,
          'credentialWindowUntil', icr.credential_window_until,
          'manifest', icr.manifest_blob_sha256, 'source', (${sourceJson}))`.as('target'),
        );
      const [row] = await executor.all<{ allowed: number; target: string | null }>(
        compile(
          db.selectNoFrom([
            sql<number>`case when ${allowed} then 1 else 0 end`.as('allowed'),
            runJson.as('target'),
          ]),
        ),
      );
      if (row?.target == null) return { target: null, allowed: row?.allowed === 1 };
      const stored = JSON.parse(row.target) as {
        approvedAt: string | null;
        credentialWindowUntil: string | null;
        manifest: string;
        source: CredentialTarget['source'];
      };
      const blob = await options.blobs.get(ctx, parseSha256(stored.manifest));
      if (blob === null) throw new Error('import manifest unavailable');
      return {
        allowed: row.allowed === 1,
        target: {
          approvedAt: stored.approvedAt,
          credentialWindowUntil: stored.credentialWindowUntil,
          manifest: await new Response(blob.body).text(),
          source: stored.source,
        },
      };
    },
    async setCredential(ctx, fence, input) {
      const allowed = importWriteAuthority(ctx, fence, anchors);
      const visible = sql<SqlBool>`exists ${target(ctx, input.runId)}`;
      const expected = sql<SqlBool>`exists ${target(ctx, input.runId)
        .where('icr.approved_at', '=', input.expected.approvedAt)
        .where('icr.credential_window_until', '=', input.expected.credentialWindowUntil)}`;
      const window = sql<SqlBool>`exists ${target(ctx, input.runId).where(
        sql<SqlBool>`unixepoch(icr.credential_window_until, 'subsec') > ${CLOCK}`,
      )}`;
      const bound = sql<SqlBool>`exists ${source(ctx, input.runId, input.externalRef)
        .select('ics.id')
        .where('ics.id', '=', input.sourceId)}`;
      const unset = sql<SqlBool>`exists ${db
        .selectFrom('source as ics')
        .select('ics.id')
        .where('ics.org_id', '=', ctx.orgId)
        .where('ics.id', '=', input.sourceId)
        .where('ics.credential_id', 'is', null)}`;
      const outcome = await runOrgFenced(
        executor,
        ctx,
        fence,
        assertGuard(allowed, ctx),
        [
          ...assertCheck(visible),
          ...assertCheck(expected),
          ...assertCheck(window),
          ...assertCheck(bound),
          ...assertCheck(unset),
          input.credential.statement,
          ...assertCheck(sql<SqlBool>`exists (select 1 from credential as icc
            join source as ics on icc.project_id is ics.project_id
            where icc.id = ${input.credential.id} and icc.org_id = ${ctx.orgId}
            and ics.id = ${input.sourceId} and ics.org_id = ${ctx.orgId})`),
          compile(
            db
              .updateTable('source')
              .set({ credential_id: input.credential.id })
              .where('org_id', '=', ctx.orgId)
              .where('id', '=', input.sourceId)
              .where('credential_id', 'is', null)
              .returning('id'),
          ),
          input.audit,
          ...(input.idempotency === undefined ? [] : [input.idempotency]),
        ],
        {
          authority: probe(allowed),
          conflict: probe(sql<SqlBool>`(${expected} and ${window} and ${unset})`),
        },
      );
      if (outcome.ok || outcome.reason === 'indeterminate') return outcome;
      const [current] = await executor.all<{ present: number; bound: number }>(
        compile(
          db.selectNoFrom([
            sql<number>`case when ${visible} then 1 else 0 end`.as('present'),
            sql<number>`case when ${bound} then 1 else 0 end`.as('bound'),
          ]),
        ),
      );
      if (current?.present !== 1 || current.bound !== 1) return { ok: false, reason: 'not_found' };
      return outcome;
    },
  };
}
