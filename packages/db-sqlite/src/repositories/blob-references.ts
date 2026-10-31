import { PUBLISH_PURGE_WINDOW_DAYS } from '@package-broker/core/db/publishes';
import type {
  OrgContext,
  ScalarSqlExecutor,
  ScalarStatement,
  ScalarSqlValue,
} from '@package-broker/core/db/port';

export const RETENTION_CANDIDATE_LIMIT = 50;
export const ORPHAN_GRACE_DAYS = 7;

export interface RetentionCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface RetentionPage {
  readonly limit: number;
  readonly after?: RetentionCursor | null;
}

export interface RetentionBlob extends RetentionCursor {
  readonly sha256: string;
}

export interface RetentionCandidate extends RetentionBlob {
  readonly orphan: boolean;
  readonly retentionDaysOverride: number | null;
}

export interface EligibleCondition {
  readonly sql: string;
  readonly params: readonly ScalarSqlValue[];
}

export interface BlobReferenceReader {
  candidates(ctx: OrgContext, page: RetentionPage): Promise<readonly RetentionCandidate[]>;
  scheduledIneligible(ctx: OrgContext, page: RetentionPage): Promise<readonly RetentionBlob[]>;
  stillEligible(ctx: OrgContext, sha256: string): Promise<boolean>;
}

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INNER_ALIASES = new Set([
  'bref_v',
  'bref_p',
  'bref_s',
  'bref_r',
  'bref_ir',
  'bref_ru',
  'bref_ing',
  'bref_up',
  'bref_rel',
]);
const SHA256 = /^[0-9a-f]{64}$/;
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function invalid(): never {
  throw new TypeError('invalid blob reference query');
}

function consistency(blob: string): string {
  return `bref_v.org_id = ${blob}.org_id AND bref_p.org_id = bref_v.org_id AND bref_s.org_id = bref_p.org_id`;
}

function references(blob: string, columns: string, where: (consistent: string) => string): string {
  const joins = `LEFT JOIN package bref_p ON bref_p.id = bref_v.package_id LEFT JOIN source bref_s ON bref_s.id = bref_p.source_id`;
  const direct = consistency(blob);
  const viaRevision = `${direct} AND bref_r.org_id = bref_v.org_id`;
  return `SELECT ${columns} FROM version bref_v ${joins}
    WHERE bref_v.blob_id = ${blob}.id ${where(direct)}
  UNION ALL
  SELECT ${columns} FROM version_revision bref_r JOIN version bref_v ON bref_v.id = bref_r.version_id ${joins}
    WHERE bref_r.blob_id = ${blob}.id ${where(viaRevision)}`;
}

function orphanSql(blob: string): string {
  return `(NOT EXISTS (
    SELECT 1 FROM version bref_v
    WHERE bref_v.blob_id = ${blob}.id)
  AND NOT EXISTS (
    SELECT 1 FROM version_revision bref_r
    WHERE bref_r.blob_id = ${blob}.id))`;
}

function checkedAlias(blobRef: string): void {
  if (
    typeof blobRef !== 'string' ||
    !ALIAS.test(blobRef) ||
    INNER_ALIASES.has(blobRef.toLowerCase())
  ) {
    invalid();
  }
}

export function blobOrphanCondition(_ctx: OrgContext, blobRef: string): EligibleCondition {
  checkedAlias(blobRef);
  if (!Number.isSafeInteger(ORPHAN_GRACE_DAYS) || ORPHAN_GRACE_DAYS <= 0) invalid();
  return {
    sql: `(${orphanSql(blobRef)}
    AND (${blobRef}.refetchable = 1 OR (${blobRef}.refetchable = 0 AND ${blobRef}.storage_key LIKE 'npm-publish/%'))
    AND julianday(COALESCE(${blobRef}.published_at, ${blobRef}.created_at)) <= julianday('now', '-${ORPHAN_GRACE_DAYS} days')
    AND NOT EXISTS (
      SELECT 1 FROM ingest_session bref_ing
      WHERE bref_ing.org_id = ${blobRef}.org_id AND bref_ing.snapshot_blob_sha256 = ${blobRef}.sha256)
    AND NOT EXISTS (
      SELECT 1 FROM upstream_state bref_up
      WHERE bref_up.org_id = ${blobRef}.org_id AND bref_up.content_sha256 = ${blobRef}.sha256))`,
    params: [],
  };
}

const NEVER = '9999-12-31T23:59:59.999Z';
const REJECTED_HOSTED =
  "COALESCE(bref_s.type = 'hosted' AND bref_v.status = 'tombstoned' AND bref_v.tombstone_reason IN ('rejected', 'expired', 'scan_denied'), 0)";

export function blobPrematureCondition(_ctx: OrgContext, blobRef: string): EligibleCondition {
  checkedAlias(blobRef);
  const stamp = (status: string, column: string) =>
    `CASE WHEN ${status} THEN COALESCE(${column}, '${NEVER}') ELSE '' END`;
  const release = `max(${stamp(`bref_v.status = 'tombstoned'`, 'bref_v.tombstoned_at')}, ${stamp(`bref_v.status = 'removed_upstream'`, 'bref_v.removed_upstream_at')}, ${stamp(`bref_p.status = 'removed_upstream'`, 'bref_p.removed_upstream_at')})`;
  const columns = `${release} AS rel, COALESCE(bref_s.retention_days_override, 0) AS ov, (${REJECTED_HOSTED}) AS rejected_hosted`;
  return {
    sql: `EXISTS (SELECT 1 FROM (${references(blobRef, columns, () => '')}) bref_rel
    WHERE bref_rel.rel <> ''
    AND ${blobRef}.purge_after < COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', bref_rel.rel, '+' || CASE WHEN bref_rel.rejected_hosted THEN ${PUBLISH_PURGE_WINDOW_DAYS} ELSE max((SELECT o.retention_removed_upstream_days FROM organization o WHERE o.id = ${blobRef}.org_id), bref_rel.ov) END || ' days'), '${NEVER}'))`,
    params: [],
  };
}

export function blobEligibleCondition(ctx: OrgContext, blobRef: string): EligibleCondition {
  checkedAlias(blobRef);
  const orphan = blobOrphanCondition(ctx, blobRef);
  const released = (consistent: string) =>
    `COALESCE(${consistent} AND (bref_v.status IN ('tombstoned', 'removed_upstream') OR bref_p.status = 'removed_upstream'), 0)`;
  return {
    sql: `(${blobRef}.org_id = ?
  AND ((EXISTS (${references(blobRef, '1', (c) => `AND ${c}`)})
  AND NOT EXISTS (${references(blobRef, '1', (c) => `AND NOT ${released(c)}`)})
  AND NOT EXISTS (${references(blobRef, '1', (c) => `AND ${c} AND bref_s.type = 'hosted' AND NOT (${REJECTED_HOSTED})`)}))
  OR ${orphan.sql})
  AND NOT EXISTS (
    SELECT 1 FROM import_run bref_ru CROSS JOIN import_ref bref_ir INDEXED BY import_ref_run_external
      ON bref_ir.import_run_id = bref_ru.id AND bref_ir.org_id = bref_ru.org_id
    WHERE bref_ru.org_id = ${blobRef}.org_id
      AND (bref_ru.before_image_expires_at IS NULL OR bref_ru.before_image_expires_at > ${NOW})
      AND bref_ir.entity_type = 'version'
      AND json_extract(bref_ir.before_image_json, '$.blob_id') = ${blobRef}.id))`,
    params: [ctx.orgId],
  };
}

function overrideSql(blob: string): string {
  const columns = 'bref_s.retention_days_override AS o';
  return `(SELECT max(o) FROM (${references(blob, columns, (c) => `AND ${c}`)}))`;
}

function missingReleaseStampSql(blob: string): string {
  return `EXISTS (${references(
    blob,
    '1',
    (c) => `AND ${c} AND (
    (bref_v.status = 'tombstoned' AND bref_v.tombstoned_at IS NULL)
    OR (bref_v.status = 'removed_upstream' AND bref_v.removed_upstream_at IS NULL)
    OR (bref_p.status = 'removed_upstream' AND bref_p.removed_upstream_at IS NULL))`,
  )})`;
}

function validPage(page: RetentionPage): void {
  const after = page?.after;
  if (
    !Number.isSafeInteger(page?.limit) ||
    page.limit < 1 ||
    page.limit > RETENTION_CANDIDATE_LIMIT ||
    (after !== undefined &&
      after !== null &&
      (typeof after.createdAt !== 'string' || typeof after.id !== 'string'))
  ) {
    invalid();
  }
}

function cursorClause(page: RetentionPage): { sql: string; params: ScalarSqlValue[] } {
  const after = page.after;
  return after === undefined || after === null
    ? { sql: '', params: [] }
    : { sql: 'AND (b.created_at, b.id) > (?, ?)', params: [after.createdAt, after.id] };
}

interface Row {
  readonly id: string;
  readonly sha256: string;
  readonly created_at: string;
  readonly orphan: number;
  readonly override_days?: number | null;
}

export function createBlobReferenceReader(executor: ScalarSqlExecutor): BlobReferenceReader {
  const blob = (row: Row): RetentionBlob => ({
    id: row.id,
    sha256: row.sha256,
    createdAt: row.created_at,
  });

  return {
    async candidates(ctx, page) {
      validPage(page);
      const eligible = blobEligibleCondition(ctx, 'b');
      const cursor = cursorClause(page);
      const rows = await executor.all<Row>({
        sql: `SELECT b.id, b.sha256, b.created_at, ${overrideSql('b')} AS override_days, ${orphanSql('b')} AS orphan
FROM blob b
WHERE ${eligible.sql} AND NOT ${missingReleaseStampSql('b')} AND b.purge_after IS NULL AND b.deleted_at IS NULL ${cursor.sql}
ORDER BY b.created_at, b.id
LIMIT ?`,
        params: [...eligible.params, ...cursor.params, page.limit],
      } satisfies ScalarStatement);
      return rows.map((row) => ({
        ...blob(row),
        retentionDaysOverride: row.override_days ?? null,
        orphan: row.orphan === 1,
      }));
    },

    async scheduledIneligible(ctx, page) {
      validPage(page);
      const eligible = blobEligibleCondition(ctx, 'b');
      const premature = blobPrematureCondition(ctx, 'b');
      const cursor = cursorClause(page);
      const rows = await executor.all<Row>({
        sql: `SELECT b.id, b.sha256, b.created_at FROM blob b
WHERE b.org_id = ? AND b.purge_after IS NOT NULL AND b.deleted_at IS NULL AND (NOT ${eligible.sql} OR ${premature.sql}) ${cursor.sql}
ORDER BY b.created_at, b.id
LIMIT ?`,
        params: [ctx.orgId, ...eligible.params, ...premature.params, ...cursor.params, page.limit],
      } satisfies ScalarStatement);
      return rows.map(blob);
    },

    async stillEligible(ctx, sha256) {
      if (typeof sha256 !== 'string' || !SHA256.test(sha256)) invalid();
      const eligible = blobEligibleCondition(ctx, 'b');
      const rows = await executor.all<{ one: number }>({
        sql: `SELECT 1 AS one FROM blob b WHERE b.sha256 = ? AND ${eligible.sql}`,
        params: [sha256, ...eligible.params],
      } satisfies ScalarStatement);
      return rows.length === 1;
    },
  };
}
