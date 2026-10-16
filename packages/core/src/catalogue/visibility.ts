import type { CatalogueSourceType } from '../db/catalogue.js';
import type { NameEcosystem } from './names.js';
import { matchesPattern, patternAdmits } from './patterns.js';

export type VisibilityOrigin = 'explicit' | 'pattern' | 'subscription';
export type VisibilityPackageStatus = 'active' | 'removed_upstream';

export interface VisibilityProject {
  readonly id: string;
  readonly orgId: string;
  readonly active: boolean;
}

export interface VisibilitySource {
  readonly id: string;
  readonly orgId: string;
  readonly ecosystem: NameEcosystem;
  readonly type: CatalogueSourceType;
  readonly ownerProjectId: string | null;
  readonly removalPolicy: 'flag' | 'exclude';
  readonly defaultVisible: 0 | 1;
}

export interface VisibilityPackage {
  readonly id: string;
  readonly orgId: string;
  readonly sourceId: string;
  readonly key: string;
  readonly status: VisibilityPackageStatus;
  readonly visible: 0 | 1;
}

export interface VisibilityAttachment {
  readonly projectId: string;
  readonly sourceId: string;
  readonly precedence: number;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
}

export interface VisibilityConfig {
  readonly projects: readonly VisibilityProject[];
  readonly sources: readonly VisibilitySource[];
  readonly packages: readonly VisibilityPackage[];
  readonly attachments: readonly VisibilityAttachment[];
  readonly explicit: readonly { readonly projectId: string; readonly packageId: string }[];
  readonly registeredNames: readonly {
    readonly orgId: string;
    readonly ecosystem: NameEcosystem;
    readonly pattern: string;
  }[];
}

export interface VisibilityRow {
  readonly projectId: string;
  readonly packageId: string;
  readonly origin: VisibilityOrigin;
}

export interface Winner {
  readonly packageId: string;
  readonly sourceId: string;
}

const ORIGIN_RANK: Record<VisibilityOrigin, number> = { explicit: 0, pattern: 1, subscription: 2 };

const isProxy = (source: VisibilitySource): boolean =>
  source.type === 'packagist_proxy' || source.type === 'npmjs_proxy';

const servesProject = (source: VisibilitySource, project: VisibilityProject): boolean =>
  source.orgId === project.orgId &&
  (source.ownerProjectId === null || source.ownerProjectId === project.id);

const compare = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

function patternHits(pattern: string, key: string): boolean {
  try {
    return matchesPattern(pattern, key);
  } catch {
    return true;
  }
}

export function deriveVisibility(config: VisibilityConfig): VisibilityRow[] {
  const projects = new Map(config.projects.map((p) => [p.id, p]));
  const sources = new Map(config.sources.map((s) => [s.id, s]));
  const explicit = new Set(config.explicit.map((e) => `${e.projectId}\0${e.packageId}`));
  const rows = new Map<string, VisibilityRow>();
  for (const attachment of config.attachments) {
    const project = projects.get(attachment.projectId);
    const source = sources.get(attachment.sourceId);
    if (!project || !source || !servesProject(source, project)) {
      continue;
    }
    for (const p of config.packages) {
      if (p.sourceId !== source.id || p.orgId !== source.orgId) {
        continue;
      }
      const slot = `${project.id}\0${p.id}`;
      let origin: VisibilityOrigin | null = null;
      if (explicit.has(slot)) {
        origin = 'explicit';
      } else if (
        patternAdmits(
          { includes: attachment.includes, excludes: attachment.excludes, flag: p.visible },
          p.key,
        )
      ) {
        origin = attachment.includes.length > 0 ? 'pattern' : 'subscription';
      }
      const held = rows.get(slot);
      if (origin && (!held || ORIGIN_RANK[origin] < ORIGIN_RANK[held.origin])) {
        rows.set(slot, { projectId: project.id, packageId: p.id, origin });
      }
    }
  }
  return [...rows.values()].sort(
    (a, b) => compare(a.projectId, b.projectId) || compare(a.packageId, b.packageId),
  );
}

function proxyBlocked(
  config: VisibilityConfig,
  orgId: string,
  ecosystem: NameEcosystem,
  key: string,
): boolean {
  const nonProxy = new Set(
    config.sources
      .filter((s) => s.orgId === orgId && s.ecosystem === ecosystem && !isProxy(s))
      .map((s) => s.id),
  );
  return (
    config.packages.some((p) => p.orgId === orgId && p.key === key && nonProxy.has(p.sourceId)) ||
    config.registeredNames.some(
      (r) => r.orgId === orgId && r.ecosystem === ecosystem && patternHits(r.pattern, key),
    )
  );
}

export function resolveWinner(
  config: VisibilityConfig,
  projectId: string,
  ecosystem: NameEcosystem,
  key: string,
): Winner | null {
  const project = config.projects.find((p) => p.id === projectId);
  if (!project?.active) {
    return null;
  }
  const sources = new Map(config.sources.map((s) => [s.id, s]));
  const packages = new Map(config.packages.map((p) => [p.id, p]));
  const precedence = new Map<string, number>();
  for (const a of config.attachments) {
    if (a.projectId === projectId && !precedence.has(a.sourceId)) {
      precedence.set(a.sourceId, a.precedence);
    }
  }
  const blocked = proxyBlocked(config, project.orgId, ecosystem, key);
  const candidates: { pkg: VisibilityPackage; source: VisibilitySource; precedence: number }[] = [];
  for (const row of deriveVisibility(config)) {
    const pkg = packages.get(row.packageId);
    const source = pkg && sources.get(pkg.sourceId);
    if (row.projectId !== projectId || !pkg || !source) {
      continue;
    }
    const live =
      pkg.status === 'active' ||
      (pkg.status === 'removed_upstream' && source.removalPolicy === 'flag');
    if (
      pkg.key === key &&
      source.ecosystem === ecosystem &&
      live &&
      !(isProxy(source) && blocked)
    ) {
      candidates.push({ pkg, source, precedence: precedence.get(source.id) ?? 0 });
    }
  }
  candidates.sort(
    (a, b) =>
      compare(Number(isProxy(a.source)), Number(isProxy(b.source))) ||
      compare(Number(a.source.ownerProjectId === null), Number(b.source.ownerProjectId === null)) ||
      compare(a.precedence, b.precedence) ||
      compare(a.source.id, b.source.id),
  );
  const first = candidates[0];
  return first ? { packageId: first.pkg.id, sourceId: first.source.id } : null;
}

export function admitProxy(
  config: VisibilityConfig,
  projectId: string,
  ecosystem: NameEcosystem,
  key: string,
): string[] {
  const project = config.projects.find((p) => p.id === projectId);
  if (!project?.active || proxyBlocked(config, project.orgId, ecosystem, key)) {
    return [];
  }
  const sources = new Map(config.sources.map((s) => [s.id, s]));
  const admitted = new Map<string, { id: string; precedence: number }>();
  for (const attachment of config.attachments) {
    const source = sources.get(attachment.sourceId);
    if (
      attachment.projectId === projectId &&
      source &&
      !admitted.has(source.id) &&
      isProxy(source) &&
      source.ecosystem === ecosystem &&
      servesProject(source, project) &&
      patternAdmits(
        {
          includes: attachment.includes,
          excludes: attachment.excludes,
          flag: source.defaultVisible,
        },
        key,
      )
    ) {
      admitted.set(source.id, { id: source.id, precedence: attachment.precedence });
    }
  }
  return [...admitted.values()]
    .sort((a, b) => compare(a.precedence, b.precedence) || compare(a.id, b.id))
    .map((s) => s.id);
}
