import type { ProjectActor } from '../authz/project-actor.js';
import {
  CATALOGUE_PAGE_MAX,
  type CatalogueVersion,
  type DistTagsLookup,
  type DistTarget,
  type ListedPackage,
  type PackageResolution,
  type PageBinding,
  type PageChanged,
  type ResolvedPackage,
  type VersionLookup,
} from '../db/catalogue.js';
import { effectiveDate } from '../registry/policy/age.js';
import {
  RegistryPolicyBoundError,
  RegistryPolicyChangedError,
  RegistryPolicyDeniedError,
  RegistryPolicyUnavailableError,
} from '../registry/policy/errors.js';
import type { RegistryReadSession } from '../registry/policy/session.js';
import { versionFact, type VersionFact } from '../registry/policy/types.js';
import { displayName, packageKey, type NameEcosystem } from './names.js';
import type { PackageAccess } from './package-access.js';

/** Package candidates one request may evaluate for a listing or search. */
export const MAX_PACKAGE_CANDIDATES = 1000;

const CHANGED: PageChanged = Object.freeze({ changed: true });

/** Counts package candidates against the bound; a new attempt starts the count again. */
export function candidateBound(attempt: () => number): () => void {
  let seen = attempt();
  let count = 0;
  return () => {
    const now = attempt();
    if (now !== seen) {
      seen = now;
      count = 0;
    }
    count += 1;
    if (count > MAX_PACKAGE_CANDIDATES) throw new RegistryPolicyBoundError();
  };
}

function keyOf(ecosystem: NameEcosystem, rawName: string): string | null {
  try {
    return packageKey(rawName, { ecosystem, legacyCase: ecosystem === 'npm' });
  } catch {
    return null;
  }
}

function nameOf(ecosystem: NameEcosystem, key: string): string {
  return ecosystem === 'npm' ? displayName(key) : key;
}

function sameBinding(left: PageBinding, right: PageBinding): boolean {
  return (
    left.packageId === right.packageId && left.sourceId === right.sourceId && left.rev === right.rev
  );
}

function bindingOf(pkg: ResolvedPackage): PageBinding {
  return { packageId: pkg.packageId, sourceId: pkg.sourceId, rev: pkg.rev };
}

/** The immutable policy facts of a catalogue version; an unusable date fails closed. */
export function catalogueFact(pkg: ResolvedPackage, version: CatalogueVersion): VersionFact {
  const dates = effectiveDate({
    publishedAt: version.publishedAt,
    publishedAtBasis: version.publishedAtBasis,
    createdAt: version.createdAt,
  });
  try {
    return versionFact({
      packageId: pkg.packageId,
      sourceId: pkg.sourceId,
      packageKey: pkg.key,
      versionId: version.versionId,
      version: version.version,
      normalizedVersion: version.versionNormalized,
      revision: version.revision,
      ...dates,
    });
  } catch {
    throw new RegistryPolicyUnavailableError();
  }
}

/** The policy facts of a dist target, always those of the current version row. */
export function distFact(packageKey: string, target: DistTarget): VersionFact {
  const facts = target.facts;
  if (facts === undefined) throw new RegistryPolicyUnavailableError();
  const dates = effectiveDate({
    publishedAt: facts.publishedAt,
    publishedAtBasis: facts.publishedAtBasis,
    createdAt: facts.createdAt,
  });
  try {
    return versionFact({
      packageId: target.packageId,
      sourceId: target.sourceId,
      packageKey,
      versionId: target.versionId,
      version: facts.version,
      normalizedVersion: facts.versionNormalized,
      revision: target.revision,
      ...dates,
    });
  } catch {
    throw new RegistryPolicyUnavailableError();
  }
}

/**
 * The catalogue as a policy-governed read sees it, for the one actor the session was opened for.
 * Authorization stays with the wrapped access; policy only subtracts. Paths not yet governed fail
 * closed rather than fall through to raw results.
 */
export function createPolicyPackageAccess(
  access: PackageAccess,
  session: RegistryReadSession,
): PackageAccess {
  const own = (actor: ProjectActor, ecosystem: NameEcosystem) =>
    actor === session.actor && ecosystem === session.ecosystem;

  async function direct(
    found: VersionLookup | null,
    readKind: 'version' | 'tag',
  ): Promise<VersionLookup | null> {
    if (found === null) return null;
    await session.request(found.pkg.key);
    const fact = catalogueFact(found.pkg, found.version);
    const [verdict] = await session.evaluate([fact]);
    if (verdict === undefined) throw new RegistryPolicyUnavailableError();
    if (verdict.allowed) return found;
    await session.denyDirect(readKind, fact, verdict);
    return null;
  }

  /** Policy-filtered pages; a session change propagates so the caller's retry sees it. */
  async function filtered(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    rawName: string,
    query: Parameters<PackageAccess['versions']>[3],
  ): Promise<PackageResolution | PageChanged | null> {
    const first = await access.versions(actor, ecosystem, rawName, query);
    if (first === null || 'changed' in first) return first;
    const binding = query.binding ?? first.binding;
    if (!sameBinding(binding, first.binding)) return CHANGED;
    await session.request(first.pkg.key);
    let page: PackageResolution = first;
    for (;;) {
      const facts = page.versions.map((version) => catalogueFact(page.pkg, version));
      const verdicts = await session.evaluate(facts);
      const allowed = page.versions.filter((_, index) => {
        const verdict = verdicts[index];
        if (verdict === undefined) throw new RegistryPolicyUnavailableError();
        if (!verdict.allowed) session.hidden(facts[index]!, verdict);
        return verdict.allowed;
      });
      if (allowed.length > 0 || page.next === null) {
        return { pkg: first.pkg, versions: allowed, next: page.next, binding };
      }
      const next = await access.versions(actor, ecosystem, rawName, {
        ...query,
        binding,
        after: page.next,
      });
      if (next === null || 'changed' in next || !sameBinding(binding, next.binding)) return CHANGED;
      page = next;
    }
  }

  const versions: PackageAccess['versions'] = async (actor, ecosystem, rawName, query) => {
    if (!own(actor, ecosystem)) return null;
    try {
      return await filtered(actor, ecosystem, rawName, query);
    } catch (error) {
      if (error instanceof RegistryPolicyChangedError) return CHANGED;
      throw error;
    }
  };

  const candidate = candidateBound(() => session.attempt());

  /**
   * A listed package is shown only when its own selected winner has a permitted version. A
   * package-specific request denial hides it; another winner is never consulted.
   */
  async function witness(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    item: ListedPackage,
  ): Promise<boolean> {
    candidate();
    let page: PackageResolution | PageChanged | null;
    try {
      page = await filtered(actor, ecosystem, nameOf(ecosystem, item.key), {
        limit: CATALOGUE_PAGE_MAX,
      });
    } catch (error) {
      if (error instanceof RegistryPolicyDeniedError) return false;
      throw error;
    }
    if (page === null || 'changed' in page) return false;
    if (page.pkg.packageId !== item.packageId || page.pkg.sourceId !== item.sourceId) return false;
    return page.versions.length > 0;
  }

  async function anyPermitted(
    actor: ProjectActor,
    ecosystem: NameEcosystem,
    rawName: string,
    binding: PageBinding,
  ) {
    const page = await filtered(actor, ecosystem, rawName, { limit: CATALOGUE_PAGE_MAX });
    if (page === null || 'changed' in page || !sameBinding(binding, page.binding)) {
      session.invalidate();
    }
    return page.versions.length > 0;
  }

  return {
    resolve: (actor, ecosystem, rawName) => access.resolve(actor, ecosystem, rawName),

    versions,

    async version(actor, ecosystem, rawName, versionNormalized) {
      if (!own(actor, ecosystem)) return null;
      return direct(await access.version(actor, ecosystem, rawName, versionNormalized), 'version');
    },

    async tag(actor, ecosystem, rawName, tag) {
      if (!own(actor, ecosystem)) return null;
      return direct(await access.tag(actor, ecosystem, rawName, tag), 'tag');
    },

    async distTags(actor, ecosystem, rawName): Promise<DistTagsLookup | null> {
      if (!own(actor, ecosystem)) return null;
      const listed = await access.distTags(actor, ecosystem, rawName);
      if (listed === null) return null;
      const binding = bindingOf(listed.pkg);
      await session.request(listed.pkg.key);
      const targets = [...new Set(Object.values(listed.tags))];
      const permitted = new Set<string>();
      for (const target of targets) {
        const found = await access.version(actor, ecosystem, rawName, target);
        if (found === null || !sameBinding(binding, bindingOf(found.pkg))) session.invalidate();
        const fact = catalogueFact(found.pkg, found.version);
        const [verdict] = await session.evaluate([fact]);
        if (verdict === undefined) throw new RegistryPolicyUnavailableError();
        if (verdict.allowed) permitted.add(target);
        else session.hidden(fact, verdict);
      }
      const tags = Object.create(null) as Record<string, string>;
      for (const [tag, target] of Object.entries(listed.tags)) {
        if (permitted.has(target)) tags[tag] = target;
      }
      if (
        Object.keys(tags).length === 0 &&
        !(await anyPermitted(actor, ecosystem, rawName, binding))
      ) {
        return null;
      }
      return { pkg: listed.pkg, tags };
    },

    async list(actor, ecosystem, query) {
      if (!own(actor, ecosystem)) return { items: [], next: null, openNamespace: true };
      await session.request(null);
      let after = query.after;
      for (;;) {
        const raw = await access.list(actor, ecosystem, {
          limit: query.limit,
          ...(after === undefined ? {} : { after }),
        });
        const items: ListedPackage[] = [];
        for (const item of raw.items) {
          if (await witness(actor, ecosystem, item)) items.push(item);
        }
        if (items.length > 0 || raw.next === null) {
          return { items, next: raw.next, openNamespace: raw.openNamespace };
        }
        after = raw.next;
      }
    },

    async search(actor, ecosystem, query) {
      if (!own(actor, ecosystem)) return [];
      await session.request(null);
      const found: ListedPackage[] = [];
      for (const item of await access.search(actor, ecosystem, query)) {
        if (await witness(actor, ecosystem, item)) found.push(item);
      }
      return found;
    },

    async dist(actor, ecosystem, rawName, request) {
      if (!own(actor, ecosystem)) return null;
      const key = keyOf(ecosystem, rawName);
      if (key === null) return null;
      const target = await access.dist(actor, ecosystem, rawName, request);
      if (target === null) return null;
      await session.request(key);
      const fact = distFact(key, target);
      const [verdict] = await session.evaluate([fact]);
      if (verdict === undefined) throw new RegistryPolicyUnavailableError();
      if (verdict.allowed) return target;
      await session.denyDirect('dist', fact, verdict);
      return null;
    },
  };
}
