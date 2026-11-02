import { sql } from 'kysely';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import {
  MAX_POLICY_MEMBERS,
  POLICY_LIST_PAGE_MAX,
  POLICY_PROJECT_ID,
  POLICY_RULE_KINDS,
  isPolicyRuleId,
  type PolicyRuleDetail,
  type PolicyRuleRecord,
  type RegistryPolicyCatalog,
} from '@package-broker/core/db/registry-policy';
import { compile, db } from '../kysely.js';
import type { RegistryPolicyRuleTable } from '../schema.js';

type RuleRow = Omit<RegistryPolicyRuleTable, 'org_id' | 'expiry_audited_at' | 'deny_unknown'> & {
  readonly deny_unknown: number;
  readonly revision: number;
  readonly member_count: number;
};

const COLUMNS = [
  'r.id',
  'r.project_id',
  'r.ecosystem',
  'r.package_key',
  'r.kind',
  'r.min_age_seconds',
  'r.client_family',
  'r.client_min_version',
  'r.deny_unknown',
  'r.reason_code',
  'r.incident_id',
  'r.expires_at',
  'r.disabled_at',
  'r.disabled_reason',
  'r.revision',
  'r.created_at',
  'r.updated_at',
] as const;

function record(row: RuleRow): PolicyRuleRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ecosystem: row.ecosystem,
    packageKey: row.package_key,
    kind: row.kind,
    minAgeSeconds: row.min_age_seconds,
    clientFamily: row.client_family,
    clientMinVersion: row.client_min_version,
    denyUnknown: row.deny_unknown === 1,
    reasonCode: row.reason_code,
    incidentId: row.incident_id,
    expiresAt: row.expires_at,
    disabledAt: row.disabled_at,
    disabledReason: row.disabled_reason,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    memberCount: row.member_count,
  };
}

function rules(ctx: OrgContext) {
  return db
    .selectFrom('registry_policy_rule as r')
    .select(COLUMNS)
    .select((eb) =>
      eb
        .selectFrom('registry_policy_version as c')
        .select(sql<number>`count(*)`.as('n'))
        .where('c.org_id', '=', ctx.orgId)
        .whereRef('c.rule_id', '=', 'r.id')
        .as('member_count'),
    )
    .where('r.org_id', '=', ctx.orgId);
}

/** Stored rules of one organization for management, disabled ones included. */
export function createRegistryPolicyCatalog(executor: SqlExecutor): RegistryPolicyCatalog {
  return {
    async list(ctx, query) {
      if (
        !Number.isSafeInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > POLICY_LIST_PAGE_MAX
      ) {
        throw new RangeError('limit is out of range');
      }
      if (query.projectId !== null && !POLICY_PROJECT_ID.test(query.projectId)) {
        throw new TypeError('projectId is invalid');
      }
      if (query.after !== undefined && !isPolicyRuleId(query.after)) {
        throw new TypeError('after is invalid');
      }
      const kinds = query.kinds.filter((kind) =>
        (POLICY_RULE_KINDS as readonly string[]).includes(kind),
      );
      if (kinds.length !== query.kinds.length) throw new TypeError('kinds are invalid');
      if (kinds.length === 0) return { items: [], next: null };
      let select = rules(ctx).where('r.kind', 'in', kinds);
      select =
        query.projectId === null
          ? select.where('r.project_id', 'is', null)
          : select.where('r.project_id', '=', query.projectId);
      if (query.after !== undefined) select = select.where('r.id', '>', query.after);
      const rows = await executor.all<RuleRow>(
        compile(select.orderBy('r.id').limit(query.limit + 1)),
      );
      const page = rows.slice(0, query.limit).map(record);
      return {
        items: page,
        next: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      };
    },

    async get(ctx, id): Promise<PolicyRuleDetail | null> {
      if (!isPolicyRuleId(id)) return null;
      const [rows, members] = await executor.batch([
        compile(rules(ctx).where('r.id', '=', id)),
        compile(
          db
            .selectFrom('registry_policy_version as m')
            .select('m.version_normalized')
            .where('m.org_id', '=', ctx.orgId)
            .where('m.rule_id', '=', id)
            .orderBy('m.version_normalized')
            .limit(MAX_POLICY_MEMBERS + 1),
        ),
      ]);
      const row = (rows?.rows ?? [])[0] as unknown as RuleRow | undefined;
      if (row === undefined) return null;
      const list = ((members?.rows ?? []) as unknown as { version_normalized: string }[]).map(
        (member) => member.version_normalized,
      );
      if (list.length > MAX_POLICY_MEMBERS) throw new RangeError('rule has too many members');
      return { ...record(row), members: list };
    },
  };
}
