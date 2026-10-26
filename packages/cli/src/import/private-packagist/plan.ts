import { createHash } from 'node:crypto';
import { DEFAULT_ROLES, PERMISSIONS } from '@package-broker/core/authz/permissions';
import { PROJECT_SLUG_PATTERN } from '@package-broker/core/authz/project-path';
import { packageKey } from '@package-broker/core/catalogue/names';
import { MAX_PATTERN_BYTES, matchesPattern } from '@package-broker/core/catalogue/patterns';
import {
  canonicalManifest,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_ITEMS,
  parseManifest,
  planHash,
  type ParsedManifest,
} from '@package-broker/core/import/manifest';
import { isCanonicalUrl } from '@package-broker/core/import/source-config';
import { normalizeEmail } from '@package-broker/core/identity/policy';
import {
  MapError,
  object,
  parsePackagistMap,
  type PackagistMap,
  type CredentialKind,
} from './map.js';
import { canonical } from './snapshot.js';

type Row = Record<string, unknown>;
type Item = ParsedManifest['items'][number];
type SourceItem = Extract<Item, { type: 'source' }>;
type ProjectRef = Extract<Item, { type: 'attachment' }>['project'];
type SourceRef = Extract<Item, { type: 'attachment' }>['source'];
const GRANT_ROLE_RANK = {
  project_developer: 1,
  project_owner: 2,
  organization_admin: 3,
} as const;
type PlannedGrant = Extract<Item, { type: 'grant' }> & {
  readonly role: { readonly existing: keyof typeof GRANT_ROLE_RANK };
};
export interface PlanDiagnostic {
  readonly code: string;
  readonly pointer: string;
  readonly cap?: string;
  readonly detail?: string;
}
export interface SummaryEntry {
  readonly code: string;
  readonly pointer?: string;
  readonly count?: number;
  readonly project?: string;
  readonly source?: string;
  readonly pattern?: string;
  readonly detail?: string;
}
export interface PlanSummary {
  readonly create: SummaryEntry[];
  readonly existing: SummaryEntry[];
  readonly warning: SummaryEntry[];
  readonly needsInput: SummaryEntry[];
  readonly unsupported: SummaryEntry[];
}
export interface PrivatePackagistPlanInput {
  readonly snapshot: unknown;
  readonly map: unknown;
  readonly members?: string;
  readonly baseline?: unknown;
  readonly options?: {
    readonly mode?: 'merge' | 'override';
    readonly includeOrgAdmins?: boolean;
    readonly runtime?: 'workers' | 'node';
    readonly packagist?: string;
    readonly compactSelection?: boolean;
    readonly acceptProjectWidening?: readonly string[];
  };
}
export type PrivatePackagistPlanResult =
  | {
      readonly ok: false;
      readonly diagnostics: readonly PlanDiagnostic[];
      readonly summary: PlanSummary;
    }
  | {
      readonly ok: true;
      readonly diagnostics: readonly PlanDiagnostic[];
      readonly summary: PlanSummary;
      readonly manifest: ParsedManifest;
      readonly canonical: string;
      readonly hash: string;
      readonly credentialsOut: string;
    };
interface Source {
  item: SourceItem;
  readonly identity: string;
  readonly names: Set<string>;
  readonly credentialIds: Set<number>;
  readonly mirrorIds: Set<number>;
  readonly pointer: string;
  readonly patterns: string[];
  reference: SourceRef;
}
interface Project {
  readonly id: number;
  readonly slug: string;
  readonly reference: ProjectRef;
  readonly pointer: string;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (v: Iterable<string>) => [...v].sort(compare);
const hash = (...tuple: unknown[]) =>
  createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
const ref = (kind: string, ...parts: unknown[]) => `pp:${kind}:${hash(`pp-${kind}-v1`, ...parts)}`;
function json(v: unknown, code = 'invalid_snapshot'): unknown {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
  } catch {
    return refuse(code);
  }
}
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (object(v))
    return `{${Object.keys(v)
      .sort(compare)
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
};
class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly pointer: string,
    readonly cap?: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}
function refuse(code: string, pointer = '', cap?: string, detail?: string): never {
  throw new Refusal(code, pointer, cap, detail);
}
function repository(value: unknown, pointer: string, vcs = false): string {
  if (typeof value !== 'string' || /[\s\p{Cc}\p{Cf}]/u.test(value))
    return refuse('invalid_repository_url', pointer);
  let url = value;
  if (/^[a-z0-9._-]+@[^:]+:.+$/i.test(url)) url = `ssh://${url.replace(':', '/')}`;
  const ssh = url.startsWith('ssh://');
  if (!ssh && !url.startsWith('https://')) refuse('invalid_repository_url', pointer);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('invalid_repository_url', pointer);
  }
  if (
    (ssh ? !/^[a-z0-9._-]{1,32}$/.test(parsed.username) : parsed.username) ||
    parsed.password ||
    /[?#]/.test(url) ||
    !parsed.hostname
  )
    refuse('invalid_repository_url', pointer);
  const github = parsed.hostname.toLowerCase() === 'github.com';
  if (github) parsed.hostname = 'github.com';
  url = parsed.href;
  if (!ssh && !isCanonicalUrl(url)) refuse('invalid_repository_url', pointer);
  if ((!ssh && vcs) || github) {
    let path = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    if (github) {
      path = path.toLowerCase();
      if (!/^\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(path)) refuse('invalid_repository_url', pointer);
    }
    parsed.pathname = path || '/';
    url = parsed.href;
  }
  return url;
}
function readMembers(text: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (text === undefined) return result;
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/(?:\r?\n)+$/, '')
    .split(/\r?\n/);
  const fieldsOf = (line: string, pointer: string): string[] => {
    const match = /^("(?:[^"]|"")*"|[^",]*),("(?:[^"]|"")*"|[^",]*)$/.exec(line);
    if (!match) return refuse('invalid_members', pointer);
    return match
      .slice(1)
      .map((field) => (field.startsWith('"') ? field.slice(1, -1).replaceAll('""', '"') : field));
  };
  if (stable(fieldsOf(lines.shift() ?? '', '/members')) !== stable(['username', 'email']))
    refuse('invalid_members', '/members');
  for (const [i, line] of lines.entries()) {
    const fields = fieldsOf(line, `/members/${i}`);
    const username = fields[0];
    const email = normalizeEmail(fields[1] ?? '');
    if (
      fields.length !== 2 ||
      !username ||
      /[\p{Cc}]/u.test(username) ||
      email === null ||
      result.has(username)
    )
      refuse('invalid_members', `/members/${i}`);
    result.set(username, email);
  }
  return result;
}
function rowsOf(input: unknown): Record<string, Row[]> {
  const value = json(input);
  if (
    !object(value) ||
    value.version !== 1 ||
    !object(value.objects) ||
    typeof value.org !== 'string' ||
    typeof value.versions !== 'boolean' ||
    typeof value.fetchedAt !== 'string'
  )
    refuse('invalid_snapshot');
  const result: Record<string, Row[]> = {};
  for (const [kind, entries] of Object.entries(value.objects)) {
    if (!Array.isArray(entries)) refuse('invalid_snapshot');
    const unique = new Map<string, Row>();
    for (const entry of entries as unknown[]) {
      if (
        !object(entry) ||
        !object(entry.data) ||
        entry.sha256 !== createHash('sha256').update(canonical(entry.data)).digest('hex')
      )
        refuse('invalid_snapshot');
      unique.set(stable(entry.data), entry.data);
    }
    result[kind] = [...unique.entries()].sort(([a], [b]) => compare(a, b)).map(([, v]) => v);
  }
  return result;
}
function credential(
  source: Source,
  map: PackagistMap,
  summary: PlanSummary,
): { kind: CredentialKind; ref: string | null } | undefined {
  const bindings = new Set<string>();
  const matches = map.credentials
    .flatMap((rule, index) => {
      const m = rule.match;
      let score = -1;
      if ('package' in m && [...source.names].some((n) => matchesPattern(m.package, n)))
        score = m.package.includes('*') ? 4_000_000 : 5_000_000;
      if (
        'url_prefix' in m &&
        (source.identity === m.url_prefix ||
          source.identity.startsWith(
            m.url_prefix.endsWith('/') ? m.url_prefix : `${m.url_prefix}/`,
          ))
      )
        score = 3_000_000 + m.url_prefix.length;
      if ('packagist_credential' in m && source.credentialIds.has(m.packagist_credential))
        score = 2_000_000;
      if ('host' in m && new URL(source.identity).hostname === m.host) score = 1_000_000;
      return score < 0 ? [] : [{ rule, index, score }];
    })
    .sort((a, b) => b.score - a.score)
    .filter(({ rule }) => {
      const key = stable([rule.kind, rule.ref]);
      if (bindings.has(key)) return false;
      bindings.add(key);
      return true;
    });
  if (matches.length === 0) return undefined;
  if (matches[1]?.score === matches[0]!.score) refuse('ambiguous_credential', source.pointer);
  const { rule, index } = matches[0]!;
  if ('host' in rule.match) {
    const pointer = `/credentials/${index}`;
    const entry = summary.warning.find(
      (e) => e.code === 'host_credential_coverage' && e.pointer === pointer,
    );
    if (entry)
      summary.warning[summary.warning.indexOf(entry)] = { ...entry, count: entry.count! + 1 };
    else summary.warning.push({ code: 'host_credential_coverage', pointer, count: 1 });
  }
  const provider =
    source.item.source_type === 'vcs'
      ? (source.item.config as { provider: string }).provider
      : null;
  if (
    rule.ref !== null &&
    ((provider === 'github' && !['github_app', 'http_basic'].includes(rule.kind)) ||
      (provider === 'git' && rule.kind !== 'http_basic') ||
      (provider === 'ssh' && rule.kind !== 'ssh_key') ||
      (provider === null && !['http_basic', 'bearer'].includes(rule.kind)))
  )
    refuse('invalid_credential_kind', `/credentials/${index}`);
  return rule;
}

export async function planPrivatePackagistImport(
  input: PrivatePackagistPlanInput,
): Promise<PrivatePackagistPlanResult> {
  const summary: PlanSummary = {
    create: [],
    existing: [],
    warning: [],
    needsInput: [],
    unsupported: [],
  };
  try {
    const result = await compile(input, summary);
    for (const entries of Object.values(summary) as SummaryEntry[][])
      entries.sort((a, b) => compare(stable(a), stable(b)));
    return { ...result, summary };
  } catch (error) {
    const diagnostic: PlanDiagnostic =
      error instanceof Refusal
        ? {
            code: error.code,
            pointer: error.pointer,
            ...(error.cap === undefined ? {} : { cap: error.cap }),
            ...(error.detail === undefined ? {} : { detail: error.detail }),
          }
        : error instanceof MapError
          ? {
              code: 'invalid_map',
              pointer: error.pointer,
              ...(error.cap === undefined ? {} : { cap: error.cap }),
            }
          : { code: 'invalid_snapshot', pointer: '' };
    return { ok: false, diagnostics: [diagnostic], summary };
  }
}
async function compile(input: PrivatePackagistPlanInput, summary: PlanSummary) {
  const options = input.options ?? {};
  if (options.mode === 'override') refuse('override_mode_unsupported', '/options/mode');
  const map = parsePackagistMap(input.map);
  const rows = rowsOf(input.snapshot);
  for (const [i, rule] of map.credentials.entries())
    if ('host' in rule.match)
      summary.warning.push({
        code: 'host_credential_coverage',
        pointer: `/credentials/${i}`,
        count: 0,
      });
  const members = readMembers(input.members);
  const baseline =
    input.baseline === undefined ? null : parseManifest(json(input.baseline, 'invalid_baseline'));
  if (baseline !== null && (!baseline.ok || baseline.data.source_system !== 'private-packagist'))
    refuse('invalid_baseline', '/baseline');
  const retained = baseline?.ok ? baseline.data : null;
  const retainedVcsPrecedence = new Map<string, number>();
  if (retained) {
    const oldProjects = new Map(
      retained.items.flatMap((item) =>
        item.type === 'project' ? [[item.external_ref, item.slug] as const] : [],
      ),
    );
    const oldSources = new Map(
      retained.items.flatMap((item) =>
        item.type === 'source' ? [[item.external_ref, item] as const] : [],
      ),
    );
    for (const item of retained.items) {
      if (
        item.type !== 'attachment' ||
        !('ref' in item.source) ||
        oldSources.get(item.source.ref)?.source_type !== 'vcs'
      )
        continue;
      const slug =
        'existing' in item.project ? item.project.existing : oldProjects.get(item.project.ref);
      if (slug !== undefined)
        retainedVcsPrecedence.set(`${slug}\0${item.source.ref}`, item.precedence);
    }
  }

  const items: Item[] = [];
  const widening: { type: 'grant'; external_ref: string }[] = [];
  const projects = new Map<number, Project>();
  for (const [i, row] of (rows.suborganizations ?? []).entries()) {
    const pointer = `/objects/suborganizations/${i}`;
    if (
      typeof row.id !== 'number' ||
      typeof row.urlName !== 'string' ||
      typeof row.name !== 'string' ||
      projects.has(row.id)
    )
      refuse('invalid_snapshot', pointer);
    const mapping = own(map.projects, row.urlName);
    const slug = mapping?.existing ?? mapping?.slug ?? row.urlName;
    if (!PROJECT_SLUG_PATTERN.test(slug) || /[\p{Cc}]/u.test(slug))
      refuse('project_slug_required', pointer);
    const external_ref = ref('project', row.id);
    const reference = mapping?.existing === undefined ? { ref: external_ref } : { existing: slug };
    projects.set(row.id, { id: row.id, slug, reference, pointer });
    if ('ref' in reference) items.push({ type: 'project', external_ref, slug, name: row.name });
    else summary.existing.push({ code: 'project', project: slug });
  }
  const projectSlugs = new Set([...projects.values()].map((p) => p.slug));
  for (const [index, slug] of (options.acceptProjectWidening ?? []).entries())
    if (!projectSlugs.has(slug))
      refuse('unknown_project_acknowledgement', `/options/acceptProjectWidening/${index}`);
  for (const kind of [
    'suborganizationPackages',
    'suborganizationTeams',
    'suborganizationMirroredRepositories',
    'suborganizationTokens',
  ])
    for (const [index, row] of (rows[kind] ?? []).entries())
      if (!projects.has(row.suborganizationId as number))
        refuse('invalid_snapshot', `/objects/${kind}/${index}`);
  const sources = new Map<string, Source>();
  const sourceNames = new Map<string, string>();
  function source(
    identity: string | [string, string],
    type: SourceItem['source_type'],
    url: string | null,
    config: SourceItem['config'],
    pointer: string,
  ): Source {
    const external_ref = ref('source', identity);
    const name = `pp-${external_ref.split(':')[2]!.slice(0, 61)}`;
    if (sourceNames.has(name) && sourceNames.get(name) !== external_ref)
      refuse('source_name_collision', pointer);
    sourceNames.set(name, external_ref);
    const previous = sources.get(external_ref);
    if (previous) {
      if (stable(previous.item.config) !== stable(config)) refuse('conflicting_source', pointer);
      return previous;
    }
    const item: SourceItem = {
      type: 'source',
      external_ref,
      name,
      ecosystem: 'composer',
      project: null,
      source_type: type,
      url,
      credential_ref: null,
      config,
    };
    const result: Source = {
      item,
      identity: Array.isArray(identity) ? identity[0] : identity,
      names: new Set(),
      credentialIds: new Set(),
      mirrorIds: new Set(),
      pointer,
      patterns: [],
      reference: { ref: external_ref },
    };
    sources.set(external_ref, result);
    return result;
  }
  const mirrors = new Map<number, Row>();
  const mirrorCredentials = new Map<number, Set<number>>();
  for (const [collection, index, row] of [
    'mirroredRepositories',
    'suborganizationMirroredRepositories',
  ].flatMap((collection) =>
    (rows[collection] ?? []).map((row, index) => [collection, index, row] as const),
  )) {
    if (typeof row.id !== 'number' || typeof row.url !== 'string') refuse('invalid_snapshot');
    if (
      row.mirroringBehavior !== undefined &&
      (typeof row.mirroringBehavior !== 'string' ||
        !['manual', 'add_on_use', 'admin_managed', 'disabled'].includes(row.mirroringBehavior))
    )
      refuse('unsupported_mirroring_behavior', `/objects/${collection}/${index}`);
    const previous = mirrors.get(row.id);
    if (previous && previous.url !== row.url) refuse('conflicting_source');
    if (!previous) mirrors.set(row.id, row);
    const ids = mirrorCredentials.get(row.id) ?? new Set<number>();
    if (typeof row.credentials === 'number') ids.add(row.credentials);
    mirrorCredentials.set(row.id, ids);
  }
  for (const [index, id] of map.mirrorOrder.entries())
    if (!mirrors.has(id))
      summary.warning.push({ code: 'stale_mirror_order', pointer: `/mirrorOrder/${index}` });
  const packageSources = new Map<Row, Source>();
  const packageRows = [...(rows.packages ?? []), ...(rows.suborganizationPackages ?? [])];
  const reported = new Set<string>();
  for (const [i, pkg] of packageRows.entries()) {
    const pointer = `/packages/${i}`;
    if (typeof pkg.name !== 'string' || !object(pkg.config) || typeof pkg.id !== 'number')
      refuse('invalid_snapshot', pointer);
    const name = pkg.name;
    try {
      if (packageKey(name, { ecosystem: 'composer' }) !== name) refuse('invalid_package', pointer);
    } catch {
      refuse('invalid_package', pointer);
    }
    if (Buffer.byteLength(name) > MAX_PATTERN_BYTES)
      refuse('single_run_limit_exceeded', pointer, 'MAX_PATTERN_BYTES');
    const c = pkg.config;
    if (
      c.defaultSuborganizationAccess !== undefined &&
      (typeof c.defaultSuborganizationAccess !== 'string' ||
        !['active', 'no-access'].includes(c.defaultSuborganizationAccess))
    )
      refuse('unsupported_default_suborganization_access', pointer);
    if (c.customJson !== undefined && c.customJson !== null && c.customJson !== '') {
      summary.unsupported.push({ code: 'inline_package_unsupported', pointer });
      refuse('inline_package_unsupported', pointer);
    }
    if (!reported.has(`pkg:${pkg.id}`)) {
      reported.add(`pkg:${pkg.id}`);
      if (pkg.abandoned) summary.warning.push({ code: 'abandoned', pointer });
      if (pkg.replacementPackage) summary.warning.push({ code: 'replacement_package', pointer });
      if (c.defaultSuborganizationAccess === 'active')
        summary.warning.push({ code: 'auto_visible_to_new_projects', pointer });
    }
    if (c.type === 'artifact' || (Array.isArray(c.artifactIds) && c.artifactIds.length > 0)) {
      if (!reported.has(`artifact:${pkg.id}`)) {
        reported.add(`artifact:${pkg.id}`);
        const artifacts = (rows.artifacts ?? []).filter((a) => a.packageId === pkg.id);
        summary.needsInput.push({
          code: 'needs-upload',
          pointer,
          count: artifacts.length,
          detail: artifacts
            .map((a) => {
              if (
                typeof a.originalFileName !== 'string' ||
                /[\p{Cc}]|[^\s@]+@[^\s@]+\.[^\s@]+/u.test(a.originalFileName)
              )
                return refuse('invalid_snapshot', pointer);
              return a.originalFileName;
            })
            .sort(compare)
            .join(', '),
        });
      }
      continue;
    }
    let s: Source;
    if (['public-mirror', 'public-proxy'].includes(String(pkg.origin))) {
      s = source(
        'packagist',
        'packagist_proxy',
        'https://repo.packagist.org',
        { githubToken: false },
        pointer,
      );
      if (options.packagist !== undefined) {
        if (!/^existing:[a-z0-9][a-z0-9._-]{0,63}$/.test(options.packagist))
          refuse('invalid_packagist', '/options/packagist');
        s.reference = { existing: { project: null, name: options.packagist.slice(9) } };
      }
    } else if (['private-mirror', 'private-proxy'].includes(String(pkg.origin))) {
      const mirror = mirrors.get(c.mirroredRepositoryId as number);
      if (!mirror) refuse('mirror_missing', pointer);
      const url = repository(mirror.url, pointer);
      if (url.startsWith('ssh://')) refuse('ssh_requires_node', pointer);
      s = source(
        url,
        'composer_repository',
        url,
        {
          selection: { packages: [], patterns: [], expandPatterns: false },
          distHosts: [],
          mirrorsFallback: false,
        },
        pointer,
      );
      s.mirrorIds.add(mirror.id as number);
      for (const id of mirrorCredentials.get(mirror.id as number) ?? []) s.credentialIds.add(id);
    } else if (pkg.origin === 'private') {
      if (
        c.type !== undefined &&
        !['vcs', 'git', 'github', 'gitlab', 'bitbucket'].includes(String(c.type))
      )
        refuse('unsupported_package_type', pointer);
      let url = repository(own(map.packages, name)?.url ?? c.url, pointer, true);
      const parsed = new URL(url);
      const installationId =
        parsed.hostname === 'github.com'
          ? own(map.github.installations, parsed.pathname.split('/')[1]!)
          : undefined;
      if (url.startsWith('ssh://')) {
        if (installationId !== undefined) url = `https://github.com${parsed.pathname}`;
        else if (options.runtime !== 'node') refuse('ssh_requires_node', pointer);
      }
      const config = {
        provider:
          installationId !== undefined
            ? ('github' as const)
            : url.startsWith('ssh://')
              ? ('ssh' as const)
              : ('git' as const),
        repository: installationId !== undefined ? parsed.pathname.slice(1) : url,
        installationId: installationId ?? null,
        packageName: name,
        refs: { tags: true, branches: ['*'] },
      };
      s = source([url, name], 'vcs', null, config, pointer);
    } else refuse('unsupported_package_origin', pointer);
    if (typeof c.credentialsId === 'number') s.credentialIds.add(c.credentialsId);
    s.names.add(name);
    packageSources.set(pkg, s);
  }
  for (const [index, [id, mirror]] of [...mirrors].entries()) {
    const used = [...sources.values()].some((s) => s.mirrorIds.has(id));
    summary.warning.push({
      code:
        !used && mirror.mirroringBehavior === 'disabled'
          ? 'disabled_mirror_skipped'
          : 'mirroring_behavior',
      pointer: `/mirrors/${index}`,
      detail: ['manual', 'add_on_use', 'admin_managed', 'disabled'].includes(
        String(mirror.mirroringBehavior),
      )
        ? String(mirror.mirroringBehavior)
        : 'unspecified',
      count: used ? 1 : 0,
    });
  }
  const allSources = [...sources.values()].sort((a, b) =>
    compare(a.item.external_ref, b.item.external_ref),
  );
  const credentialOutput: { external_ref: string; credential_ref: string; kind: CredentialKind }[] =
    [];
  for (const s of allSources) {
    if (s.item.source_type === 'packagist_proxy') continue;
    const binding = credential(s, map, summary);
    if (binding === undefined) {
      const suggestions: Readonly<Record<string, string>> = {
        magento: 'http_basic',
        'http-basic': 'http_basic',
        'bitbucket-app-pw': 'http_basic',
        'github-oauth': 'http_basic or github_app',
        'gitlab-token': 'http_basic or github_app',
        'gitlab-oauth': 'http_basic or github_app',
        'bitbucket-api': 'http_basic or github_app',
        'bearer-token': 'bearer',
        'ssh-key': 'ssh_key',
      };
      const kinds = sorted(
        new Set(
          (rows.credentials ?? [])
            .filter(
              (c) =>
                s.credentialIds.has(c.id as number) || c.domain === new URL(s.identity).hostname,
            )
            .flatMap((c) =>
              typeof c.type === 'string' && Object.hasOwn(suggestions, c.type)
                ? [suggestions[c.type]!]
                : [],
            ),
        ),
      );
      summary.needsInput.push({
        code: 'unbound_credential',
        source: s.item.name,
        ...(kinds.length ? { detail: kinds.join(', ') } : {}),
      });
    } else {
      s.item = { ...s.item, credential_ref: binding.ref };
      if (binding.ref !== null)
        credentialOutput.push({
          external_ref: s.item.external_ref,
          credential_ref: binding.ref,
          kind: binding.kind,
        });
    }
    if (s.item.source_type !== 'composer_repository') continue;
    let packages = sorted(s.names);
    const vendors = new Map<string, string[]>();
    const proxyVendors = new Set<string>();
    for (const n of packages) {
      const vendor = n.split('/')[0]!;
      vendors.set(vendor, [...(vendors.get(vendor) ?? []), n]);
    }
    if (packages.length > 64 && options.compactSelection) {
      const candidates = [...vendors].sort(
        ([a, av], [b, bv]) => bv.length - av.length || compare(a, b),
      );
      for (const [vendor, names] of candidates) {
        if (packages.length + s.patterns.length <= 64) break;
        if (names.length < 2) continue;
        const shared = allSources.filter(
          (other) => other !== s && [...other.names].some((n) => n.startsWith(`${vendor}/`)),
        );
        if (shared.length) {
          if (shared.some((other) => other.item.source_type === 'packagist_proxy'))
            proxyVendors.add(vendor);
          continue;
        }
        packages = packages.filter((n) => !n.startsWith(`${vendor}/`));
        const pattern = `${vendor}/*`;
        if (Buffer.byteLength(pattern) > MAX_PATTERN_BYTES)
          refuse('single_run_limit_exceeded', s.pointer, 'MAX_PATTERN_BYTES');
        s.patterns.push(pattern);
        summary.warning.push({
          code: 'selection_compacted',
          source: s.item.name,
          pattern,
          count: names.length,
        });
      }
    }
    if (packages.length + s.patterns.length > 64)
      refuse(
        'single_run_limit_exceeded',
        s.pointer,
        'SOURCE_CONFIG_LIST_LIMIT',
        proxyVendors.size
          ? `Proxy-served vendors: ${sorted(proxyVendors).join(', ')}. See owner question A (project_package).`
          : undefined,
      );
    const hosts = sorted(
      new Set(
        [...s.mirrorIds].flatMap(
          (id) => own(map.distHosts, String(id)) ?? own(map.distHosts, s.identity) ?? [],
        ),
      ),
    );
    if (hosts.length > 64)
      refuse('single_run_limit_exceeded', s.pointer, 'SOURCE_CONFIG_LIST_LIMIT');
    s.item = {
      ...s.item,
      config: {
        selection: { packages, patterns: sorted(s.patterns), expandPatterns: false },
        distHosts: hosts,
        mirrorsFallback: false,
      },
    };
  }
  const nameOwners = new Map<string, Source>();
  for (const s of allSources) {
    if ('ref' in s.reference) items.push(s.item);
    else summary.existing.push({ code: 'source', source: s.reference.existing.name });
    if (s.item.source_type !== 'packagist_proxy')
      for (const n of sorted(s.names)) if (!nameOwners.has(n)) nameOwners.set(n, s);
  }
  for (const [pattern, s] of nameOwners)
    items.push({
      type: 'name',
      external_ref: ref('name', pattern),
      source: s.reference,
      ecosystem: 'composer',
      pattern,
    });
  const vcs = allSources.filter((s) => s.item.source_type === 'vcs');
  if (vcs.length > 8999) refuse('single_run_limit_exceeded', '', 'MAX_VCS_SOURCES');
  const mirrorSources = allSources.filter((s) => s.item.source_type === 'composer_repository');
  if (mirrorSources.length > 89) refuse('single_run_limit_exceeded', '', 'MAX_MIRRORS');
  if (mirrorSources.some((s) => ![...s.mirrorIds].some((id) => map.mirrorOrder.includes(id))))
    refuse('mirror_order_required', '/mirrorOrder');
  const mirrorRank = (s: Source) =>
    Math.min(...[...s.mirrorIds].map((id) => map.mirrorOrder.indexOf(id)).filter((n) => n >= 0));
  const mirrorSorted = [...mirrorSources].sort(
    (a, b) => mirrorRank(a) - mirrorRank(b) || compare(a.item.external_ref, b.item.external_ref),
  );
  for (const project of projects.values()) {
    const listed = (rows.suborganizationPackages ?? []).filter(
      (pkg) => pkg.suborganizationId === project.id,
    );
    const wanted = listed.flatMap((pkg) => {
      const s = packageSources.get(pkg);
      return s ? [{ name: pkg.name as string, s }] : [];
    });
    const attached = [...new Set(wanted.map((w) => w.s))];
    const conflict = (conflicting: Iterable<Source>): never => {
      for (const s of conflicting)
        summary.warning.push({
          code: 'cross_source_conflict',
          project: project.slug,
          source: s.item.name,
        });
      return refuse('cross_source_conflict', project.pointer);
    };
    const edges = new Map<Source, Set<Source>>(attached.map((s) => [s, new Set()]));
    for (const { name, s } of wanted)
      for (const other of attached) {
        if (other !== s && other.item.source_type !== 'packagist_proxy' && other.names.has(name))
          edges.get(s)!.add(other);
      }
    const ordered: Source[] = [];
    const pending = new Set(attached);
    const projectVcs = attached
      .filter((s) => s.item.source_type === 'vcs')
      .sort((a, b) => compare(a.item.external_ref, b.item.external_ref));
    const vcsPositions = new Map<Source, number>();
    const occupied = new Set<number>();
    for (const s of projectVcs) {
      const position = retainedVcsPrecedence.get(`${project.slug}\0${s.item.external_ref}`);
      if (position !== undefined) {
        vcsPositions.set(s, position);
        occupied.add(position);
      }
    }
    let nextVcsPosition = 1000;
    for (const s of projectVcs) {
      if (vcsPositions.has(s)) continue;
      while (occupied.has(nextVcsPosition)) nextVcsPosition++;
      if (nextVcsPosition > 9998)
        refuse('single_run_limit_exceeded', project.pointer, 'MAX_VCS_SOURCES');
      vcsPositions.set(s, nextVcsPosition);
      occupied.add(nextVcsPosition++);
    }
    const priority = (s: Source) =>
      s.item.source_type === 'vcs'
        ? vcsPositions.get(s)!
        : s.item.source_type === 'composer_repository'
          ? 10000 + 100 * mirrorRank(s)
          : 99999;
    while (pending.size) {
      const ready = [...pending]
        .filter((s) => ![...pending].some((other) => edges.get(other)!.has(s)))
        .sort(
          (a, b) => priority(a) - priority(b) || compare(a.item.external_ref, b.item.external_ref),
        );
      if (!ready.length) conflict(pending);
      const next = ready[0]!;
      ordered.push(next);
      pending.delete(next);
    }
    const localMirrors = ordered.filter((s) => s.item.source_type === 'composer_repository');
    const precedence = (s: Source) =>
      s.item.source_type === 'composer_repository'
        ? 10000 +
          100 *
            mirrorRank(mirrorSorted.filter((m) => attached.includes(m))[localMirrors.indexOf(s)]!)
        : priority(s);
    const conflicting = new Set<Source>();
    for (const s of ordered)
      for (const other of edges.get(s)!)
        if (precedence(s) >= precedence(other)) {
          conflicting.add(s);
          conflicting.add(other);
        }
    if (conflicting.size) conflict(conflicting);
    const projectNames = new Set(listed.map((pkg) => pkg.name as string));
    for (const s of attached) {
      if (s.item.source_type === 'composer_repository') {
        const extra = [...s.names].filter((n) => !projectNames.has(n)).length;
        if (extra > 0 || s.patterns.length > 0) {
          summary.warning.push({
            code: 'project_widening',
            project: project.slug,
            source: s.item.name,
            count: extra,
          });
          if (!options.acceptProjectWidening?.includes(project.slug))
            refuse('project_widening', project.pointer);
        }
      }
      if (s.item.source_type === 'packagist_proxy')
        summary.warning.push({
          code: 'public_proxy_exposure',
          project: project.slug,
          source: s.item.name,
        });
      items.push({
        type: 'attachment',
        external_ref: ref('attachment', project.id, s.item.external_ref),
        project: project.reference,
        source: s.reference,
        precedence: precedence(s),
      });
    }
  }
  addGrants(
    rows,
    map,
    members,
    projects,
    options.includeOrgAdmins === true,
    items,
    widening,
    summary,
  );
  for (const kind of ['customers', 'vendorBundles'])
    if (rows[kind]?.length) summary.unsupported.push({ code: kind, count: rows[kind].length });
  for (const kind of ['synchronizations', 'tokens', 'suborganizationTokens'])
    if (rows[kind]?.length)
      summary.warning.push({ code: `report_only_${kind}`, count: rows[kind].length });
  summary.warning.push({
    code: 'manual_cutover',
    detail:
      'Issue project tokens; configure SSO, monitoring, collaborators and webhooks; verify historical dists with cutover-check.',
  });
  let delta = items;
  let deltaWidening = widening;
  if (retained !== null) {
    const previous = retained;
    for (const item of previous.items) {
      if (
        'source' in item &&
        'existing' in item.source &&
        !(options.packagist === `existing:${item.source.existing.name}`)
      )
        refuse('incomplete_baseline', '/baseline');
    }
    const planned = new Map(items.map((item) => [item.external_ref, item]));
    const prior = new Map(previous.items.map((item) => [item.external_ref, item]));
    for (const old of [...previous.items].sort(
      (a, b) => Number(b.type === 'source') - Number(a.type === 'source'),
    )) {
      const current = planned.get(old.external_ref);
      if (!current) {
        if (
          old.type === 'source' &&
          previous.items.some(
            (n) =>
              n.type === 'name' &&
              'ref' in n.source &&
              n.source.ref === old.external_ref &&
              planned.has(n.external_ref),
          )
        )
          refuse('existing_source_change', '/baseline');
        if (
          old.type === 'source' &&
          old.source_type === 'vcs' &&
          items.some(
            (item) =>
              item.type === 'source' &&
              item.source_type === 'vcs' &&
              (item.config as { packageName: string }).packageName ===
                (old.config as { packageName: string }).packageName,
          )
        )
          refuse('existing_source_change', '/baseline');
        refuse('destructive_delta_unsupported', '/baseline');
      }
      if (stable(old) !== stable(current))
        refuse(
          old.type === 'source' ? 'existing_source_change' : 'destructive_delta_unsupported',
          '/baseline',
        );
    }
    const projectRefs = new Map(
      previous.items.flatMap((item) =>
        item.type === 'project' ? [[item.external_ref, item.slug] as const] : [],
      ),
    );
    const sourceRefs = new Map(
      previous.items.flatMap((item) =>
        item.type === 'source' ? [[item.external_ref, item.name] as const] : [],
      ),
    );
    delta = items
      .filter((item) => !prior.has(item.external_ref))
      .map((item) => {
        const copy = { ...item };
        if (
          'project' in copy &&
          copy.project !== null &&
          'ref' in copy.project &&
          projectRefs.has(copy.project.ref)
        )
          copy.project = { existing: projectRefs.get(copy.project.ref)! };
        if ('source' in copy && 'ref' in copy.source && sourceRefs.has(copy.source.ref))
          copy.source = { existing: { project: null, name: sourceRefs.get(copy.source.ref)! } };
        return copy;
      });
    deltaWidening = widening.filter((w) =>
      delta.some((item) => item.external_ref === w.external_ref),
    );
    for (const old of previous.items) summary.existing.push({ code: old.type, count: 1 });
  }
  if (delta.length > MAX_MANIFEST_ITEMS)
    refuse('single_run_limit_exceeded', '', 'MAX_MANIFEST_ITEMS');
  const parsed = parseManifest({
    version: 1,
    source_system: 'private-packagist',
    items: delta,
    widening: deltaWidening,
  });
  if (!parsed.ok) refuse('manifest_invalid', parsed.details[0]?.path ?? '');
  const bytes = canonicalManifest(parsed.data);
  if (Buffer.byteLength(bytes) > MAX_MANIFEST_BYTES)
    refuse('single_run_limit_exceeded', '', 'MAX_MANIFEST_BYTES');
  for (const item of delta)
    summary.create.push({
      code: item.type,
      count: 1,
      ...(item.type === 'source' ? { source: item.name, detail: item.source_type } : {}),
      ...(item.type === 'project' ? { project: item.slug } : {}),
      ...(item.type === 'name' ? { pattern: item.pattern } : {}),
    });
  const emittedSources = new Set(
    delta.filter((item) => item.type === 'source').map((item) => item.external_ref),
  );
  return {
    ok: true as const,
    diagnostics: [],
    manifest: parsed.data,
    canonical: bytes,
    hash: await planHash(parsed.data),
    credentialsOut: JSON.stringify({
      version: 1,
      sources: credentialOutput.filter((e) => emittedSources.has(e.external_ref)),
    }),
  };
}

function addGrants(
  rows: Record<string, Row[]>,
  map: PackagistMap,
  members: Map<string, string>,
  projects: Map<number, Project>,
  includeAdmins: boolean,
  items: Item[],
  widening: { type: 'grant'; external_ref: string }[],
  summary: PlanSummary,
): void {
  const grants = new Map<string, PlannedGrant>();
  for (const [i, team] of [...(rows.teams ?? []), ...(rows.suborganizationTeams ?? [])].entries()) {
    const pointer = `/teams/${i}`;
    if (
      typeof team.name !== 'string' ||
      typeof team.id !== 'number' ||
      typeof team.permission !== 'string'
    )
      refuse('invalid_snapshot', pointer);
    const permission = team.permission;
    const org = team.suborganizationId === undefined;
    if (
      !(org ? ['owner', 'admin', 'edit', 'view', 'billing'] : ['owner', 'view']).includes(
        permission,
      )
    )
      refuse('unsupported_team_permission', pointer);
    if (['Owners', 'Admins', 'Billing', 'All Organization Members'].includes(team.name)) {
      summary.warning.push({ code: 'built_in_team_skipped', pointer });
      continue;
    }
    const mapping = own(map.teams, team.name);
    if (permission === 'billing') {
      summary.warning.push({ code: 'billing_team', pointer });
      continue;
    }
    if (
      !mapping ||
      (org && ['edit', 'view'].includes(permission) && !mapping.projects?.length) ||
      (org && ['owner', 'admin'].includes(permission) && !includeAdmins)
    ) {
      summary.warning.push({
        code: 'unlisted_team',
        pointer,
        count: Array.isArray(team.members) ? team.members.length : 0,
      });
      continue;
    }
    const targets: (Project | null)[] =
      org && ['owner', 'admin'].includes(permission)
        ? [null]
        : org
          ? (mapping.projects ?? []).map((slug) => {
              const project = [...projects.values()].find((p) => p.slug === slug);
              if (!project) return refuse('unknown_team_project', pointer);
              return project;
            })
          : [
              projects.get(team.suborganizationId as number) ??
                refuse('unknown_team_project', pointer),
            ];
    const subjects: Extract<Item, { type: 'grant' }>['subject'][] = [];
    if (mapping.group) subjects.push({ type: 'group', ...mapping.group });
    else {
      let missing = 0;
      for (const member of Array.isArray(team.members) ? (team.members as unknown[]) : []) {
        if (!object(member) || typeof member.username !== 'string')
          refuse('invalid_snapshot', pointer);
        const email = members.get(member.username);
        if (email) subjects.push({ type: 'email', value: email });
        else missing++;
      }
      if (missing) summary.needsInput.push({ code: 'unmapped_members', pointer, count: missing });
    }
    for (const project of targets)
      for (const subject of subjects) {
        const role =
          project === null
            ? 'organization_admin'
            : permission === 'owner' || (permission === 'edit' && mapping.role === 'project_owner')
              ? 'project_owner'
              : 'project_developer';
        const key = stable([project?.reference ?? null, subject]);
        const grant: PlannedGrant = {
          type: 'grant',
          external_ref: ref('grant', project?.id ?? null, team.id, JSON.parse(stable(subject))),
          scope: project === null ? 'organization' : 'project',
          project: project?.reference ?? null,
          role: { existing: role },
          subject,
        };
        const previous = grants.get(key);
        if (previous && 'existing' in previous.role && previous.role.existing !== role) {
          summary.warning.push({ code: 'grant_merged', pointer, count: 1 });
          const stronger =
            GRANT_ROLE_RANK[previous.role.existing] > GRANT_ROLE_RANK[role]
              ? previous.role
              : grant.role;
          const chosen = compare(grant.external_ref, previous.external_ref) < 0 ? grant : previous;
          grants.set(key, { ...chosen, role: stronger });
        } else if (!previous || compare(grant.external_ref, previous.external_ref) < 0)
          grants.set(key, grant);
      }
  }
  for (const grant of grants.values()) {
    items.push(grant);
    const role = DEFAULT_ROLES.find(
      (r) => 'existing' in grant.role && r.key === grant.role.existing,
    );
    if (
      role?.permissions.some((p) => PERMISSIONS.some((info) => info.name === p && info.sessionOnly))
    ) {
      widening.push({ type: 'grant', external_ref: grant.external_ref });
      summary.warning.push({
        code:
          grant.scope === 'organization'
            ? 'organization_admin_widening'
            : 'project_grant_session_permissions',
        count: 1,
      });
    }
  }
}
