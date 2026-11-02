import { sql, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import {
  MAX_POLICY_MEMBERS,
  MAX_POLICY_NAMESPACE_MEMBERS,
  MAX_POLICY_NAMESPACE_RULES,
  MAX_POLICY_RULES,
  POLICY_ECOSYSTEMS,
  RegistryPolicyStoreError,
  isPolicyPackageKey,
  type PolicyNamespaceQuery,
  type PolicyRule,
  type PolicySnapshot,
  type RegistryPolicyReader,
} from '@package-broker/core/db/registry-policy';
import { compile, db, type Database } from '../kysely.js';
import type { RegistryPolicyRuleTable } from '../schema.js';

interface RuleRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly ecosystem: PolicyRule['ecosystem'];
  readonly package_key: string | null;
  readonly kind: PolicyRule['kind'];
  readonly min_age_seconds: number | null;
  readonly client_family: PolicyRule['clientFamily'];
  readonly client_min_version: string | null;
  readonly deny_unknown: number;
  readonly reason_code: PolicyRule['reasonCode'];
  readonly incident_id: string | null;
  readonly expires_at: string | null;
  readonly revision: number;
}

interface MemberRow {
  readonly rule_id: string;
  readonly version_normalized: string;
}

function applicable(
  ctx: OrgContext,
  query: PolicyNamespaceQuery,
  packageKey: string | null | undefined,
) {
  return (eb: ExpressionBuilder<Database & { r: RegistryPolicyRuleTable }, 'r'>) =>
    eb.and([
      eb('r.ecosystem', '=', query.ecosystem),
      eb('r.disabled_at', 'is', null),
      query.projectId === null
        ? eb('r.project_id', 'is', null)
        : eb.or([
            eb('r.project_id', 'is', null),
            eb.and([
              eb('r.project_id', '=', query.projectId),
              eb.exists(
                eb
                  .selectFrom('project as p')
                  .select(sql.lit(1).as('one'))
                  .where('p.org_id', '=', ctx.orgId)
                  .whereRef('p.id', '=', 'r.project_id'),
              ),
            ]),
          ]),
      ...(packageKey === undefined
        ? []
        : [
            packageKey === null
              ? eb('r.package_key', 'is', null)
              : eb.or([eb('r.package_key', 'is', null), eb('r.package_key', '=', packageKey)]),
          ]),
    ]) as unknown as SqlBool;
}

function validScope(query: PolicyNamespaceQuery): boolean {
  return (
    (POLICY_ECOSYSTEMS as readonly string[]).includes(query.ecosystem) &&
    (query.projectId === null ||
      (typeof query.projectId === 'string' && query.projectId.length > 0))
  );
}

/**
 * Enabled rules, their members and the epoch in one batch from the primary. `packageKey`
 * undefined reads every package key; the rule and member caps are those of the caller.
 */
async function readRules(
  executor: SqlExecutor,
  ctx: OrgContext,
  query: PolicyNamespaceQuery,
  packageKey: string | null | undefined,
  caps: { readonly rules: number; readonly members: number },
): Promise<PolicySnapshot | null> {
  const filter = applicable(ctx, query, packageKey);
  const [epochs, rules, members] = await executor.batch([
    compile(db.selectFrom('cache_epoch').select('version').where('org_id', '=', ctx.orgId)),
    compile(
      db
        .selectFrom('registry_policy_rule as r')
        .select([
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
          'r.revision',
        ])
        .where('r.org_id', '=', ctx.orgId)
        .where((eb) => filter(eb) as never)
        .orderBy('r.id')
        .limit(caps.rules + 1),
    ),
    compile(
      db
        .selectFrom('registry_policy_version as m')
        .innerJoin('registry_policy_rule as r', (join) =>
          join.onRef('r.org_id', '=', 'm.org_id').onRef('r.id', '=', 'm.rule_id'),
        )
        .select(['m.rule_id', 'm.version_normalized'])
        .where('m.org_id', '=', ctx.orgId)
        .where((eb) => filter(eb) as never)
        .orderBy('m.rule_id')
        .orderBy('m.version_normalized')
        .limit(caps.members + 1),
    ),
  ]);
  const epochRows = (epochs?.rows ?? []) as { version: string }[];
  const ruleRows = (rules?.rows ?? []) as unknown as RuleRow[];
  const memberRows = (members?.rows ?? []) as unknown as MemberRow[];
  if (epochRows.length !== 1 || typeof epochRows[0]?.version !== 'string') {
    throw new RegistryPolicyStoreError();
  }
  if (ruleRows.length > caps.rules || memberRows.length > caps.members) return null;
  const byRule = new Map<string, string[]>(ruleRows.map((row) => [row.id, []]));
  for (const row of memberRows) {
    const list = byRule.get(row.rule_id);
    if (list === undefined || list.length >= MAX_POLICY_MEMBERS) {
      throw new RegistryPolicyStoreError();
    }
    list.push(row.version_normalized);
  }
  return {
    epoch: epochRows[0].version,
    rules: ruleRows.map((row) => ({
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
      revision: row.revision,
      members: byRule.get(row.id) ?? [],
    })),
  };
}

/** Enabled rules, their members and the epoch, read in one batch from the primary. */
export function createRegistryPolicyReader(executor: SqlExecutor): RegistryPolicyReader {
  return {
    async snapshot(ctx, query) {
      if (
        !validScope(query) ||
        (query.packageKey !== null && !isPolicyPackageKey(query.ecosystem, query.packageKey))
      ) {
        throw new TypeError('policy snapshot query is invalid');
      }
      const snapshot = await readRules(executor, ctx, query, query.packageKey, {
        rules: MAX_POLICY_RULES,
        members: MAX_POLICY_RULES * MAX_POLICY_MEMBERS,
      });
      if (snapshot === null) throw new RegistryPolicyStoreError();
      return snapshot;
    },

    async namespace(ctx, query) {
      if (!validScope(query)) throw new TypeError('policy namespace query is invalid');
      return readRules(
        executor,
        ctx,
        { ecosystem: query.ecosystem, projectId: query.projectId },
        undefined,
        { rules: MAX_POLICY_NAMESPACE_RULES, members: MAX_POLICY_NAMESPACE_MEMBERS },
      );
    },
  };
}
