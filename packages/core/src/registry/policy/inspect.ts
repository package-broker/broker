import { auditEvent } from '../../audit/actions.js';
import { displayName } from '../../catalogue/names.js';
import type { VersionStatus } from '../../catalogue/version-rules.js';
import type {
  PackageAdminReader,
  PolicyVersionFacts,
  PolicyVersionFactsReader,
} from '../../db/package-admin.js';
import type { PolicyEcosystem, RegistryPolicyReader } from '../../db/registry-policy.js';
import type { Clock } from '../../ids.js';
import { effectiveDate, evaluateMinAge } from './age.js';
import type { PolicyCaller, PolicyManageOutcome } from './manage.js';
import { evaluateMembers } from './members.js';
import type { PolicyReadAuditSink } from './read-audit.js';
import type { RuleDenial } from './rule-scope.js';
import type { AgeBasis } from './types.js';

export const POLICY_INSPECT_PAGE_MAX = 100;

export interface PolicyInspectDeps {
  readonly policy: RegistryPolicyReader;
  readonly facts: PolicyVersionFactsReader;
  readonly packages: Pick<PackageAdminReader, 'listVersions'>;
  readonly audit: PolicyReadAuditSink;
  readonly ids: { ulid(): string };
  readonly clock: Clock;
}

/** Identifiers, status, date basis and fixed reasons only; never manifests, readmes or URLs. */
export interface PolicyInspectVersion {
  readonly id: string;
  readonly version: string;
  readonly revision: number;
  readonly status: VersionStatus;
  readonly ageBasis: AgeBasis | null;
  readonly effectiveAt: string | null;
  readonly permitted: boolean;
  readonly reasons: readonly InspectReason[];
}

/** An organization rule seen through a project route by a caller who may not read it. */
export interface OrganizationRuleReason {
  readonly reason: 'organization_rule';
}

export type InspectReason = RuleDenial | OrganizationRuleReason;

const ORGANIZATION_RULE: OrganizationRuleReason = Object.freeze({ reason: 'organization_rule' });

export interface PolicyInspection {
  readonly packageId: string;
  readonly ecosystem: PolicyEcosystem | null;
  readonly package: string | null;
  readonly versions: readonly PolicyInspectVersion[];
  readonly next: string | null;
}

export interface PolicyInspectService {
  inspect(
    caller: PolicyCaller,
    query: { readonly packageId: string; readonly after?: string; readonly limit: number },
  ): Promise<PolicyManageOutcome<PolicyInspection>>;
}

function datesOf(row: PolicyVersionFacts): ReturnType<typeof effectiveDate> | null {
  try {
    return effectiveDate({
      publishedAt: row.publishedAt,
      publishedAtBasis: row.publishedAtBasis,
      createdAt: row.createdAt,
    });
  } catch {
    return null;
  }
}

/** Package management authority over the route scope; reading packages is not enough. */
function mayInspect(caller: PolicyCaller): boolean {
  if (caller.fence === null) return false;
  if (caller.organizationPermissions.has('org:packages:manage')) return true;
  return caller.routeProjectId !== null && caller.projectPermissions.has('project:packages:manage');
}

/** Organization rule identities stay with callers who manage organization packages. */
function reasonsFor(
  caller: PolicyCaller,
  organizationRules: ReadonlySet<string>,
  denials: readonly RuleDenial[],
): InspectReason[] {
  if (caller.organizationPermissions.has('org:packages:manage')) return [...denials];
  const own = denials.filter((denial) => !organizationRules.has(denial.ruleId));
  return own.length === denials.length ? own : [ORGANIZATION_RULE, ...own];
}

export function createPolicyInspectService(deps: PolicyInspectDeps): PolicyInspectService {
  return {
    async inspect(caller, request) {
      if (!mayInspect(caller)) return { ok: false, error: 'forbidden' };
      const query = { ...request, limit: Math.min(request.limit, POLICY_INSPECT_PAGE_MAX) };
      const visible = await deps.packages.listVersions(caller.org, {
        packageId: query.packageId,
        projectId: caller.routeProjectId,
        limit: 1,
      });
      if (visible === null) return { ok: false, error: 'not_found' };
      const rows = await deps.facts.versionFacts(caller.org, {
        packageId: query.packageId,
        limit: query.limit + 1,
        ...(query.after === undefined ? {} : { after: query.after }),
      });
      const page = rows.slice(0, query.limit);
      const first = page[0];
      const ecosystem = first?.ecosystem ?? null;
      const now = deps.clock.now().toISOString();
      let versions: PolicyInspectVersion[] = [];
      if (first !== undefined && ecosystem !== null) {
        let snapshot;
        try {
          snapshot = await deps.policy.snapshot(caller.org, {
            ecosystem,
            projectId: caller.routeProjectId,
            packageKey: first.packageKey,
          });
        } catch {
          return { ok: false, error: 'unavailable' };
        }
        const organizationRules = new Set(
          snapshot.rules.filter((rule) => rule.projectId === null).map((rule) => rule.id),
        );
        versions = page.map((row) => {
          const dates = datesOf(row);
          const fact = {
            packageId: row.packageId,
            sourceId: row.sourceId,
            packageKey: row.packageKey,
            versionId: row.versionId,
            version: row.version,
            normalizedVersion: row.versionNormalized,
            revision: row.revision,
            publishedAt: dates?.publishedAt ?? row.publishedAt,
            ageBasis: dates?.ageBasis ?? 'first_seen',
          };
          const reasons = reasonsFor(caller, organizationRules, [
            ...(dates === null ? [] : evaluateMinAge(snapshot.rules, fact, now).denials),
            ...evaluateMembers(snapshot.rules, fact, now).denials,
          ]);
          return {
            id: row.versionId,
            version: row.version,
            revision: row.revision,
            status: row.status,
            ageBasis: dates?.ageBasis ?? null,
            effectiveAt: dates?.publishedAt ?? null,
            permitted: dates !== null && reasons.length === 0,
            reasons,
          };
        });
      }
      const built = auditEvent({
        id: deps.ids.ulid(),
        now,
        action: 'policy.inspect',
        actor: { type: 'user', id: caller.principal.id },
        context: caller.audit,
        target: { type: 'package', id: query.packageId },
        projectId: caller.routeProjectId,
        changes: {
          scope: { new: caller.routeProjectId === null ? 'organization' : 'project' },
          ...(ecosystem === null ? {} : { ecosystem: { new: ecosystem } }),
          ...(first === undefined ? {} : { package_key: { new: first.packageKey } }),
          result_count: { new: versions.length },
        },
      });
      if (!built.ok) return { ok: false, error: 'unavailable' };
      try {
        await deps.audit.record(caller.org, [built.event]);
      } catch {
        return { ok: false, error: 'unavailable' };
      }
      return {
        ok: true,
        replayed: false,
        value: {
          packageId: query.packageId,
          ecosystem,
          package:
            first === undefined
              ? null
              : ecosystem === 'npm'
                ? displayName(first.packageKey)
                : first.packageKey,
          versions,
          next: rows.length > query.limit ? (page.at(-1)?.versionId ?? null) : null,
        },
      };
    },
  };
}
