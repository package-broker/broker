import type { ProjectActor } from '../authz/project-actor.js';
import {
  POLICY_FACTS_PAGE_MAX,
  type PackageListItem,
  type PolicyVersionFacts,
  type PolicyVersionFactsReader,
  type VersionListItem,
} from '../db/package-admin.js';
import type { OrgContext } from '../db/port.js';
import type { ReadKind, RequestContext } from '../plugin.js';
import { effectiveDate } from '../registry/policy/age.js';
import {
  RegistryPolicyDeniedError,
  RegistryPolicyUnavailableError,
} from '../registry/policy/errors.js';
import type { OrganizationPolicyView } from '../registry/policy/organization.js';
import type { PolicyServing } from '../registry/policy/serving.js';
import { MAX_VERSION_DECISIONS, type RegistryReadSession } from '../registry/policy/session.js';
import { versionFact, type VersionFact } from '../registry/policy/types.js';
import type { NameEcosystem } from './names.js';
import { candidateBound } from './policy-access.js';

/** What the project package, version and readme views need to filter through policy. */
export interface PackageViewPolicy {
  readonly serving: PolicyServing;
  readonly facts: PolicyVersionFactsReader;
}

const LISTED: ReadonlySet<string> = new Set(['active', 'removed_upstream']);

/**
 * Versions one package summary evaluates, newest first. A package with more reports its count as
 * a lower bound; one whose evaluated versions are all denied is hidden.
 */
export const PACKAGE_COUNT_MAX = 100;

/** A package summary as a policy-filtered view reports it. */
export type PolicyPackageSummary = PackageListItem & {
  /** True when only the newest PACKAGE_COUNT_MAX versions were counted: at least `versionCount`. */
  readonly versionCountTruncated: boolean;
};

/** How one kind of view decides; the project and organization views differ only here. */
interface ViewJudge {
  /** False when a package-specific request restriction hides the whole package. */
  admitted(ecosystem: NameEcosystem, packageKey: string): Promise<boolean>;
  permitted(
    ecosystem: NameEcosystem,
    rows: readonly PolicyVersionFacts[],
  ): Promise<PolicyVersionFacts[]>;
  /** Version decisions the request may still make; the views never start one past it. */
  remaining(): number;
  seal(): Promise<void>;
}

export function factOf(row: PolicyVersionFacts): VersionFact {
  const dates = effectiveDate({
    publishedAt: row.publishedAt,
    publishedAtBasis: row.publishedAtBasis,
    createdAt: row.createdAt,
  });
  try {
    return versionFact({
      packageId: row.packageId,
      sourceId: row.sourceId,
      packageKey: row.packageKey,
      versionId: row.versionId,
      version: row.version,
      normalizedVersion: row.versionNormalized,
      revision: row.revision,
      ...dates,
    });
  } catch {
    throw new RegistryPolicyUnavailableError();
  }
}

function views(
  policy: PackageViewPolicy,
  org: OrgContext,
  judge: ViewJudge,
  candidate: () => void,
) {
  return {
    /**
     * A package summary counting only permitted versions among the newest PACKAGE_COUNT_MAX, with
     * the newest permitted listed version as its latest; null when none of them is permitted.
     */
    async summarize(item: PackageListItem): Promise<PolicyPackageSummary | null> {
      candidate();
      if (!(await judge.admitted(item.ecosystem, item.name))) return null;
      const room = Math.min(PACKAGE_COUNT_MAX, judge.remaining());
      if (room < 1) return null;
      const rows = await policy.facts.versionFacts(org, {
        packageId: item.id,
        limit: room + 1,
        newest: true,
      });
      let count = 0;
      let latest: PolicyVersionFacts | null = null;
      for (const row of await judge.permitted(item.ecosystem, rows.slice(0, room))) {
        count += 1;
        if (
          LISTED.has(row.status) &&
          (latest === null ||
            row.publishedAt > latest.publishedAt ||
            (row.publishedAt === latest.publishedAt && row.versionId > latest.versionId))
        ) {
          latest = row;
        }
      }
      if (count === 0) return null;
      return {
        ...item,
        latestVersion: latest?.version ?? null,
        versionCount: count,
        versionCountTruncated: rows.length > room,
      };
    },

    /** Whether a whole page of `limit` summaries still fits the request's decision budget. */
    fits(limit: number): boolean {
      return judge.remaining() >= limit * PACKAGE_COUNT_MAX;
    },

    /**
     * False when a package-specific request restriction hides the package, decided from one fact
     * row before any version page is read.
     */
    async admits(packageId: string): Promise<boolean> {
      const [row] = await policy.facts.versionFacts(org, { packageId, limit: 1 });
      return row === undefined || judge.admitted(row.ecosystem, row.packageKey);
    },

    /** The permitted items of one version page, in page order. */
    async versions(
      packageId: string,
      items: readonly VersionListItem[],
    ): Promise<VersionListItem[]> {
      if (items.length === 0) return [];
      const rows = await policy.facts.versionFacts(org, {
        packageId,
        versionIds: items.map((item) => item.id),
        limit: POLICY_FACTS_PAGE_MAX,
      });
      const first = rows[0];
      if (first === undefined) return [];
      if (!(await judge.admitted(first.ecosystem, first.packageKey))) return [];
      const allowed = new Set(
        (await judge.permitted(first.ecosystem, rows)).map((row) => row.versionId),
      );
      return items.filter((item) => allowed.has(item.id));
    },

    /** Whether one version is permitted; its denial hides content without durable evidence. */
    async permits(packageId: string, versionId: string): Promise<boolean> {
      const [row] = await policy.facts.versionFacts(org, {
        packageId,
        versionIds: [versionId],
        limit: 1,
      });
      if (row === undefined) return false;
      if (!(await judge.admitted(row.ecosystem, row.packageKey))) return false;
      return (await judge.permitted(row.ecosystem, [row])).length === 1;
    },

    seal: () => judge.seal(),
  };
}

/**
 * Policy for one request to the project package views. A session is opened per ecosystem on first
 * use; every session is sealed before the response. These views serve the browser, so the client
 * floor, which guides package managers, does not apply.
 */
export function createPolicyViews(
  policy: PackageViewPolicy,
  ctx: RequestContext,
  actor: ProjectActor,
  kind: ReadKind,
) {
  const org: OrgContext = { orgId: actor.orgId };
  const sessions = new Map<NameEcosystem, RegistryReadSession>();
  const candidate = candidateBound(() => {
    let retries = 0;
    for (const session of sessions.values()) retries += session.attempt() - 1;
    return retries;
  });

  async function sessionFor(ecosystem: NameEcosystem): Promise<RegistryReadSession> {
    let session = sessions.get(ecosystem);
    if (session === undefined) {
      session = policy.serving.open(ctx, actor, ecosystem, kind, { clientFloor: false });
      sessions.set(ecosystem, session);
    }
    await session.request(null);
    return session;
  }

  const judge: ViewJudge = {
    async admitted(ecosystem, packageKey) {
      const session = await sessionFor(ecosystem);
      try {
        await session.request(packageKey);
        return true;
      } catch (error) {
        if (error instanceof RegistryPolicyDeniedError) return false;
        throw error;
      }
    },

    /** The permitted subset of the rows, in order; hidden rows are counted, never audited. */
    async permitted(ecosystem, rows) {
      const session = await sessionFor(ecosystem);
      const facts = rows.map(factOf);
      const verdicts = await session.evaluate(facts);
      return rows.filter((_, index) => {
        const verdict = verdicts[index];
        if (verdict === undefined) throw new RegistryPolicyUnavailableError();
        if (!verdict.allowed) session.hidden(facts[index]!, verdict);
        return verdict.allowed;
      });
    },

    remaining() {
      let least = MAX_VERSION_DECISIONS;
      for (const session of sessions.values()) least = Math.min(least, session.remaining());
      return least;
    },

    async seal() {
      for (const session of sessions.values()) await session.seal();
    },
  };

  return { sessionFor, ...views(policy, org, judge, candidate) };
}

/**
 * Policy for one attempt of an organization package view, for a caller without the organization
 * package-management permission: organization rules hide denied versions and packages with none
 * left. Managers keep the unfiltered inspection view.
 */
export function createOrganizationPolicyViews(policy: PackageViewPolicy, ctx: RequestContext) {
  if (ctx.org === null) throw new RegistryPolicyUnavailableError();
  const org = ctx.org;
  const opened = new Map<NameEcosystem, OrganizationPolicyView>();
  const viewOf = (ecosystem: NameEcosystem): OrganizationPolicyView => {
    let view = opened.get(ecosystem);
    if (view === undefined) {
      view = policy.serving.organization(ctx, ecosystem);
      opened.set(ecosystem, view);
    }
    return view;
  };
  const judge: ViewJudge = {
    admitted: async () => true,
    async permitted(ecosystem, rows) {
      const answers = await viewOf(ecosystem).permitted(rows.map(factOf));
      return rows.filter((_, index) => answers[index] === true);
    },
    remaining: () => MAX_VERSION_DECISIONS,
    async seal() {
      for (const view of opened.values()) await view.seal();
    },
  };
  return views(
    policy,
    org,
    judge,
    candidateBound(() => 0),
  );
}
