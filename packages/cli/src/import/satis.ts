import { createHash } from 'node:crypto';
import { isCredentialValue } from '@package-broker/core/audit/redact';
import { PROJECT_SLUG_PATTERN } from '@package-broker/core/authz/project-path';
import { PackageNameError, packageKey } from '@package-broker/core/catalogue/names';
import { MAX_PATTERN_BYTES } from '@package-broker/core/catalogue/patterns';
import {
  canonicalManifest,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_ITEMS,
  parseManifest,
  planHash,
  type ParsedManifest,
} from '@package-broker/core/import/manifest';
import { isCanonicalUrl, sortConfigLists } from '@package-broker/core/import/source-config';

export const DIAGNOSTIC_TEXT = {
  invalid_satis_config: 'Invalid or unsupported Satis configuration; see the field path.',
  invalid_repository_url: 'Use a canonical repository URL without credentials, query or fragment.',
  repository_driver_required:
    'Declare the Git driver and package name in the local repository map; remote probing is disabled.',
  repository_package_required:
    'Declare the Composer package name for this repository in the local repository map.',
  unsupported_github_repository:
    'Use one concrete GitHub repository and supply its package mapping.',
  unsupported_driver_options:
    'Only a concrete Git HTTPS repository is supported; remove API driver options.',
  selection_required:
    'Provide explicit package names or supported vendor filters for this Composer repository.',
  inline_package_unsupported:
    'Inline package definitions cannot be imported; publish them to a Composer repository first.',
  local_repository_unsupported:
    'Local path repositories cannot be imported; publish them to a reachable repository first.',
  artifact_repository_unsupported:
    'Artifact directories cannot be imported; publish their packages to a Composer repository first.',
  repository_transport_unsupported:
    'This importer supports HTTPS Git and Composer repositories only.',
  package_filter_unsupported: 'Use a canonical package name or a single vendor/* filter.',
  require_all_composer_unsupported:
    'Enumerate the Composer packages or vendor filters before planning; require-all cannot be expanded offline.',
  conflicting_selection: 'Choose require-all or explicit require filters.',
  dependency_resolution_unsupported:
    'Dependency expansion requires a resolver and cannot be represented by this import plan.',
  dev_dependency_resolution_unsupported:
    'Development dependency expansion is not supported by this import plan.',
  only_dependencies_unsupported:
    'A dependencies-only selection requires dependency resolution and is not supported.',
  stability_filter_unsupported:
    "Set minimum-stability to 'dev' in a reviewed package-only configuration; this plan cannot preserve a stability filter.",
  archive_policy_unsupported:
    'Satis archive settings are not transferable; remove them from a reviewed package-only configuration and configure Broker storage separately.',
  empty_selection: 'No packages are selected; no manifest was written.',
  ambiguous_package_owner:
    'Assign each package or vendor filter to one source in the local repository map.',
  selection_coverage:
    'Repository selections must cover the requested filters without adding packages.',
  duplicate_repository: 'Each repository may be configured only once.',
  source_name_collision: 'Two repositories produce the same source name.',
  invalid_repository_map: 'Invalid repository map; see the field path.',
  invalid_credential_map:
    'Use a supported credential reference and explicit repository binding; inline material is forbidden.',
  invalid_project: 'Use a valid project slug.',
  invalid_baseline: 'The baseline is not a valid Satis import manifest.',
  incomplete_baseline: 'Supply the full retained baseline manifest for this import.',
  existing_source_change:
    'This plan changes an existing source; review it through source administration before importing further additions.',
  destructive_delta_unsupported:
    'This change removes or replaces imported configuration; reconcile it in the UI before creating a new baseline.',
  override_mode_unsupported:
    'Override mode needs an ownership marker the import manifest cannot carry; use merge mode.',
  single_run_limit_exceeded:
    'This plan exceeds a single-run import limit. Queue-backed multi-part import requires the T669 follow-up; no manifest was written.',
  manifest_invalid: 'The planned manifest was refused by the import manifest validator.',
} as const;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_TEXT;
export type DiagnosticFile =
  'satis' | 'repository-map' | 'credentials' | 'baseline' | 'options' | 'plan';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly file: DiagnosticFile;
  readonly pointer: string;
  readonly cap?: string;
}

export const WARNING_TEXT = {
  version_constraint_ignored:
    'The version constraint is not enforced; the broker serves all upstream versions of this package.',
  blacklist_ignored:
    'The blacklist entry is not enforced; the broker serves all upstream versions of this package.',
} as const;

export interface PlanWarning {
  readonly code: keyof typeof WARNING_TEXT;
  readonly package: string;
  readonly pointer: string;
}

export interface PlanSummary {
  readonly sources: readonly { name: string; kind: string; target: string }[];
  readonly existingSources: readonly string[];
  readonly names: readonly string[];
  readonly attachments: readonly { project: string; source: string }[];
  readonly unselectedRepositories: number;
  readonly ignoredPresentationKeys: number;
  readonly disabledDefaultRepositories: number;
  readonly noChanges: boolean;
}

export interface PlanInput {
  readonly satis: string;
  readonly repositoryMap?: string;
  readonly credentials?: string;
  readonly baseline?: string;
  readonly project?: string;
  readonly mode?: 'merge' | 'override';
}

export type PlanResult =
  | {
      readonly ok: true;
      readonly manifest: ParsedManifest;
      readonly canonical: string;
      readonly hash: string;
      readonly summary: PlanSummary;
      readonly warnings: readonly PlanWarning[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
      readonly warnings: readonly PlanWarning[];
    };

type Obj = Record<string, unknown>;
type Json = Obj;
type Kind = 'vcs' | 'git' | 'github' | 'gitlab' | 'bitbucket' | 'composer';

const GIT_KINDS = ['vcs', 'git', 'github', 'gitlab', 'bitbucket'] as const;
const REFUSED_TYPES = {
  package: 'inline_package_unsupported',
  path: 'local_repository_unsupported',
  artifact: 'artifact_repository_unsupported',
} as const;
const PRESENTATION_KEYS = ['name', 'description', 'homepage', 'output-html'] as const;
const ROOT_KEYS = [
  'repositories',
  'require',
  'require-all',
  'require-dependencies',
  'require-dev-dependencies',
  'blacklist',
  'only-dependencies',
  'minimum-stability',
  'archive',
  ...PRESENTATION_KEYS,
];
const CREDENTIAL_KINDS = ['http_basic', 'bearer', 'github_app'];
const SOURCE_CONFIG_LIST_LIMIT = 64;
const ATTACHMENT_PRECEDENCE = 1000;
const GITHUB_REPOSITORY =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
const VENDOR_FILTER = /^[a-z0-9][a-z0-9_.-]*\/\*$/;
const ENV_REF = /^env:[A-Z_][A-Z0-9_]{0,127}$/;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (object: Obj, key: string): unknown =>
  Object.hasOwn(object, key) ? object[key] : undefined;
const sha = (...tuple: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values: Iterable<string>): string[] => [...values].sort(compare);

function composerKey(name: string): string | null {
  try {
    return packageKey(name, { ecosystem: 'composer' });
  } catch (error) {
    if (error instanceof PackageNameError) return null;
    throw error;
  }
}

function isVendorFilter(value: string): boolean {
  return VENDOR_FILTER.test(value) && composerKey(`${value.slice(0, -2)}/x`) !== null;
}

function covers(filter: string, name: string): boolean {
  return name.startsWith(filter.slice(0, -1));
}

function hasDuplicateKeys(text: string): boolean {
  const stack: (Set<string> | null)[] = [];
  const quoted = /"(?:[^"\\]|\\.)*"/y;
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === '"') {
      quoted.lastIndex = at;
      const match = quoted.exec(text);
      if (match === null) return false;
      at += match[0].length;
      const top = stack[stack.length - 1];
      if (top) {
        let next = at;
        while (/\s/.test(text[next] ?? '')) next += 1;
        if (text[next] === ':') {
          const key = JSON.parse(match[0]) as string;
          if (top.has(key)) return true;
          top.add(key);
        }
      }
      continue;
    }
    if (char === '{') stack.push(new Set());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    at += 1;
  }
  return false;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return hasDuplicateKeys(text) ? { ok: false } : { ok: true, value };
  } catch {
    return { ok: false };
  }
}

interface GithubForm {
  readonly owner: string;
  readonly repo: string;
}

function githubForm(url: string): GithubForm | null {
  const match = GITHUB_REPOSITORY.exec(url);
  if (match === null) return null;
  const owner = (match[1] ?? '').toLowerCase();
  const repo = (match[2] ?? '').toLowerCase();
  return repo.startsWith('.') ? null : { owner, repo };
}

function identityOf(url: string): string {
  const form = githubForm(url);
  return form === null ? url : `https://github.com/${form.owner}/${form.repo}`;
}

type UrlClass = 'ok' | 'transport' | 'invalid';

function classifyUrl(url: string): UrlClass {
  // eslint-disable-next-line no-control-regex
  if (url === '' || /[\u0000- \u007f]/.test(url)) return 'invalid';
  if (!/^https:\/\//.test(url)) return 'transport';
  if (githubForm(url) !== null || isCanonicalUrl(url)) return 'ok';
  return 'invalid';
}

const TOKEN_ENV_PREFIXES = ['AKIA', 'ASIA', 'GHP_', 'GHO_', 'GHS_', 'GITHUB_PAT_', 'XOX', 'GLPAT'];
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;

const SOURCE_CONFIG_ENTRY_LENGTH_LIMIT = 200;

function listCap(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  if (list.length > SOURCE_CONFIG_LIST_LIMIT) return 'SOURCE_CONFIG_LIST_LIMIT';
  const long = (list as unknown[]).some(
    (entry) => typeof entry === 'string' && entry.length > SOURCE_CONFIG_ENTRY_LENGTH_LIMIT,
  );
  return long ? 'SOURCE_CONFIG_ENTRY_LENGTH_LIMIT' : null;
}

function isReference(ref: string): boolean {
  if (/\p{Cc}/u.test(ref)) return false;
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    return (
      ENV_REF.test(ref) &&
      !TOKEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
      !isCredentialValue(name)
    );
  }
  if (!ref.startsWith('file:')) return false;
  const path = ref.slice(5);
  return (
    ABSOLUTE_PATH.test(path) &&
    !path.split(/[\\/]/).includes('..') &&
    Buffer.byteLength(path) <= 1024 &&
    !isCredentialValue(path)
  );
}

interface MapEntry {
  readonly index: number;
  readonly identity: string;
  readonly driver: string | undefined;
  readonly package: string | undefined;
  readonly installationId: number | undefined;
  readonly packages: string[] | undefined;
  readonly patterns: string[] | undefined;
  readonly distHosts: string[];
  readonly project: string | undefined;
}

interface CredentialEntry {
  readonly index: number;
  readonly kind: string;
  readonly ref: string;
}

interface Repo {
  readonly index: number;
  readonly kind: Kind;
  readonly url: string;
  readonly identity: string;
  readonly hash: string;
  readonly entry: MapEntry | undefined;
  readonly credential: CredentialEntry | undefined;
}

interface PlannedSource {
  readonly repo: Repo;
  readonly item: Json;
  readonly names: string[];
}

export async function planSatisImport(input: PlanInput): Promise<PlanResult> {
  const diagnostics: Diagnostic[] = [];
  const warnings: PlanWarning[] = [];
  const refuse = (file: DiagnosticFile, code: DiagnosticCode, pointer: string, cap?: string) => {
    diagnostics.push(cap === undefined ? { file, code, pointer } : { file, code, pointer, cap });
  };
  const fail = (): PlanResult => ({ ok: false, diagnostics, warnings });

  if (input.mode === 'override') {
    refuse('options', 'override_mode_unsupported', '/mode');
    return fail();
  }
  if (input.project !== undefined && !PROJECT_SLUG_PATTERN.test(input.project)) {
    refuse('options', 'invalid_project', '/project');
  }

  const satisJson = parseJson(input.satis);
  if (!satisJson.ok || !isObj(satisJson.value)) {
    refuse('satis', 'invalid_satis_config', '');
    return fail();
  }
  const root = satisJson.value;

  let ignoredPresentationKeys = 0;
  let disabledDefaultRepositories = 0;
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.includes(key)) refuse('satis', 'invalid_satis_config', '');
  }
  for (const key of PRESENTATION_KEYS) {
    const value = own(root, key);
    if (value === undefined) continue;
    if (typeof value === (key === 'output-html' ? 'boolean' : 'string'))
      ignoredPresentationKeys += 1;
    else refuse('satis', 'invalid_satis_config', `/${key}`);
  }

  const flag = (key: string, code: DiagnosticCode): void => {
    const value = own(root, key);
    if (value === undefined || value === false) return;
    refuse('satis', value === true ? code : 'invalid_satis_config', `/${key}`);
  };
  const requireAll = ((): boolean => {
    const value = own(root, 'require-all');
    if (value === undefined) return false;
    if (typeof value !== 'boolean') refuse('satis', 'invalid_satis_config', '/require-all');
    return value === true;
  })();
  flag('require-dependencies', 'dependency_resolution_unsupported');
  flag('require-dev-dependencies', 'dev_dependency_resolution_unsupported');
  flag('only-dependencies', 'only_dependencies_unsupported');
  if (own(root, 'minimum-stability') !== 'dev') {
    refuse('satis', 'stability_filter_unsupported', '/minimum-stability');
  }
  if (own(root, 'archive') !== undefined) refuse('satis', 'archive_policy_unsupported', '/archive');

  const exactRoots = new Set<string>();
  const filterRoots = new Set<string>();
  const requireValue = own(root, 'require');
  if (requireValue !== undefined) {
    if (!isObj(requireValue)) refuse('satis', 'invalid_satis_config', '/require');
    else {
      for (const [rawName, constraint] of Object.entries(requireValue)) {
        const name = rawName.includes('*') ? rawName : (composerKey(rawName) ?? '');
        if (typeof constraint !== 'string') refuse('satis', 'invalid_satis_config', '/require');
        else if (isVendorFilter(name)) filterRoots.add(name);
        else if (!name.includes('*') && name !== '') exactRoots.add(name);
        else {
          refuse('satis', 'package_filter_unsupported', '/require');
          continue;
        }
        if (typeof constraint === 'string' && constraint !== '*') {
          warnings.push({ code: 'version_constraint_ignored', package: name, pointer: '/require' });
        }
      }
    }
  }
  const blacklist = own(root, 'blacklist');
  if (blacklist !== undefined) {
    if (!isObj(blacklist)) refuse('satis', 'invalid_satis_config', '/blacklist');
    else {
      for (const [rawName, constraint] of Object.entries(blacklist)) {
        if (typeof constraint !== 'string') refuse('satis', 'invalid_satis_config', '/blacklist');
        else {
          const name = composerKey(rawName) ?? (isVendorFilter(rawName) ? rawName : '(unnamed)');
          warnings.push({ code: 'blacklist_ignored', package: name, pointer: '/blacklist' });
        }
      }
    }
  }
  if (requireAll && (exactRoots.size > 0 || filterRoots.size > 0)) {
    refuse('satis', 'conflicting_selection', '/require-all');
  }

  const mapEntries = readRepositoryMap(input.repositoryMap, refuse);
  const credentialEntries = readCredentials(input.credentials, refuse);

  const repositories = own(root, 'repositories');
  const repos: Repo[] = [];
  const seen = new Map<string, number>();
  if (!Array.isArray(repositories)) refuse('satis', 'invalid_satis_config', '/repositories');
  else {
    repositories.forEach((entry: unknown, index: number) => {
      const pointer = `/repositories/${index}`;
      if (!isObj(entry)) return refuse('satis', 'invalid_satis_config', pointer);
      const keys = Object.keys(entry);
      if (keys.length === 1 && keys[0] === 'packagist.org' && entry['packagist.org'] === false) {
        disabledDefaultRepositories += 1;
        return;
      }
      const type = own(entry, 'type');
      if (typeof type !== 'string')
        return refuse('satis', 'invalid_satis_config', `${pointer}/type`);
      if (Object.hasOwn(REFUSED_TYPES, type)) {
        return refuse('satis', REFUSED_TYPES[type as keyof typeof REFUSED_TYPES], pointer);
      }
      if (type !== 'composer' && !(GIT_KINDS as readonly string[]).includes(type)) {
        return refuse('satis', 'invalid_satis_config', `${pointer}/type`);
      }
      const url = own(entry, 'url');
      if (keys.some((key) => key !== 'type' && key !== 'url') || typeof url !== 'string') {
        return refuse('satis', 'invalid_satis_config', pointer);
      }
      const urlClass = classifyUrl(url);
      if (urlClass === 'transport') {
        return refuse('satis', 'repository_transport_unsupported', `${pointer}/url`);
      }
      if (urlClass === 'invalid')
        return refuse('satis', 'invalid_repository_url', `${pointer}/url`);
      const kind = type as Kind;
      const isGithubHost = /^https:\/\/github\.com(?:\/|$)/.test(url);
      if (kind !== 'composer' && (kind === 'github' || isGithubHost) && githubForm(url) === null) {
        return refuse('satis', 'unsupported_github_repository', `${pointer}/url`);
      }
      const identity = identityOf(url);
      const previous = seen.get(identity);
      if (previous !== undefined) return refuse('satis', 'duplicate_repository', pointer);
      seen.set(identity, index);
      const hash = sha('satis-repository-v1', identity);
      repos.push({
        index,
        kind,
        url,
        identity,
        hash,
        entry: mapEntries.byIdentity.get(identity),
        credential: credentialEntries.byIdentity.get(identity),
      });
    });
  }

  for (const [identity, entry] of mapEntries.byIdentity) {
    if (!seen.has(identity))
      refuse('repository-map', 'invalid_repository_map', `/repositories/${entry.index}`);
  }
  for (const [identity, entry] of credentialEntries.byIdentity) {
    if (!seen.has(identity))
      refuse('credentials', 'invalid_credential_map', `/repositories/${entry.index}`);
  }

  const names = new Set<string>();
  for (const repo of repos) {
    const name = `satis-${repo.hash.slice(0, 58)}`;
    if (names.has(name)) refuse('satis', 'source_name_collision', `/repositories/${repo.index}`);
    names.add(name);
  }

  const gitRepos = repos.filter((repo) => repo.kind !== 'composer');
  const composerRepos = repos.filter((repo) => repo.kind === 'composer');
  for (const repo of gitRepos) checkGitRepo(repo, refuse);
  for (const repo of composerRepos) {
    const entry = repo.entry;
    if (
      entry !== undefined &&
      (entry.package !== undefined ||
        entry.driver !== undefined ||
        entry.installationId !== undefined)
    ) {
      refuse('repository-map', 'invalid_repository_map', `/repositories/${entry.index}`);
    }
    if (repo.credential?.kind === 'github_app') {
      refuse('credentials', 'invalid_credential_map', `/repositories/${repo.credential.index}`);
    }
    if (
      composerRepos.length > 1 &&
      entry?.packages === undefined &&
      entry?.patterns === undefined
    ) {
      refuse('satis', 'selection_required', `/repositories/${repo.index}`);
    }
  }
  if (requireAll && composerRepos.length > 0) {
    refuse('satis', 'require_all_composer_unsupported', '/require-all');
  }
  if (!requireAll && exactRoots.size === 0 && filterRoots.size === 0 && diagnostics.length === 0) {
    refuse('satis', 'empty_selection', '/require');
  }

  if (diagnostics.length > 0) return fail();

  const planned = selectSources({
    gitRepos,
    composerRepos,
    exactRoots: sorted(exactRoots),
    filterRoots: sorted(filterRoots),
    requireAll,
    refuse,
  });
  if (planned === null) return fail();
  if (planned.length === 0) {
    refuse('satis', 'empty_selection', '/require');
    return fail();
  }

  for (const source of planned) {
    const config = source.item.config as { selection?: { packages: string[]; patterns: string[] } };
    const pointer = `/repositories/${source.repo.index}`;
    for (const list of [config.selection?.packages, config.selection?.patterns]) {
      const cap = listCap(list);
      if (cap !== null) refuse('satis', 'single_run_limit_exceeded', pointer, cap);
    }
    if (source.names.some((pattern) => Buffer.byteLength(pattern) > MAX_PATTERN_BYTES)) {
      refuse('satis', 'single_run_limit_exceeded', pointer, 'MAX_PATTERN_BYTES');
    }
  }
  if (diagnostics.length > 0) return fail();

  const attachProject = (repo: Repo): string | undefined => repo.entry?.project ?? input.project;
  const itemsOut: Json[] = [];
  const summary = {
    sources: [] as { name: string; kind: string; target: string }[],
    existingSources: [] as string[],
    names: [] as string[],
    attachments: [] as { project: string; source: string }[],
  };

  const baseline = input.baseline === undefined ? null : readBaseline(input.baseline, refuse);
  if (diagnostics.length > 0) return fail();

  const baselineSources = baseline?.sources ?? new Map<string, string>();
  const baselineNames = baseline?.names ?? new Set<string>();
  const nameKey = (source: string, pattern: string): string => `${source}\0${pattern}`;
  const baselineAttachments = baseline?.attachments ?? new Set<string>();
  const plannedNames = new Set<string>();

  for (const source of planned) {
    const name = source.item.name as string;
    const ref = source.item.external_ref as string;
    const known = baselineSources.get(name);
    const sourceRef = known === undefined ? { ref } : { existing: { project: null, name } };
    if (known === undefined) {
      itemsOut.push(source.item);
      summary.sources.push({
        name,
        kind: source.item.source_type as string,
        target: describeTarget(source.item),
      });
    } else {
      if (known !== stable(source.item)) {
        refuse('satis', 'existing_source_change', `/repositories/${source.repo.index}`);
        continue;
      }
      summary.existingSources.push(name);
    }
    for (const pattern of source.names) {
      plannedNames.add(nameKey(name, pattern));
      if (known !== undefined) {
        if (!baselineNames.has(nameKey(name, pattern))) {
          refuse('satis', 'existing_source_change', `/repositories/${source.repo.index}`);
        }
        continue;
      }
      itemsOut.push({
        type: 'name',
        external_ref: `satis:name:${sha('satis-name-v1', pattern)}`,
        source: sourceRef,
        ecosystem: 'composer',
        pattern,
      });
      summary.names.push(pattern);
    }
    const project = attachProject(source.repo);
    if (project === undefined) continue;
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      refuse(
        'repository-map',
        'invalid_repository_map',
        `/repositories/${source.repo.entry?.index ?? 0}`,
      );
      continue;
    }
    if (baselineAttachments.has(`${project}\0${name}`)) continue;
    itemsOut.push({
      type: 'attachment',
      external_ref: `satis:attachment:${sha('satis-attachment-v1', project, source.repo.hash)}`,
      project: { existing: project },
      source: sourceRef,
      precedence: ATTACHMENT_PRECEDENCE,
    });
    summary.attachments.push({ project, source: name });
  }
  if (baseline !== null) {
    for (const name of baselineSources.keys()) {
      if (!planned.some((source) => source.item.name === name)) {
        refuse('baseline', 'destructive_delta_unsupported', '');
      }
    }
    for (const key of baselineNames) {
      if (!plannedNames.has(key)) refuse('baseline', 'destructive_delta_unsupported', '');
    }
  }
  if (diagnostics.length > 0) return fail();

  if (itemsOut.length > MAX_MANIFEST_ITEMS) {
    refuse('satis', 'single_run_limit_exceeded', '', 'MAX_MANIFEST_ITEMS');
    return fail();
  }

  const parsed = parseManifest({
    version: 1,
    source_system: 'satis',
    items: itemsOut,
    widening: [],
  });
  if (!parsed.ok) {
    for (const detail of parsed.details) refuse('plan', 'manifest_invalid', detail.path);
    return fail();
  }
  const canonical = canonicalManifest(parsed.data);
  if (Buffer.byteLength(canonical) > MAX_MANIFEST_BYTES) {
    refuse('satis', 'single_run_limit_exceeded', '', 'MAX_MANIFEST_BYTES');
    return fail();
  }

  const selectedIdentities = new Set(planned.map((source) => source.repo.identity));
  return {
    ok: true,
    manifest: parsed.data,
    canonical,
    hash: await planHash(parsed.data),
    warnings: sortedWarnings(warnings),
    summary: {
      sources: summary.sources.sort((a, b) => compare(a.name, b.name)),
      existingSources: sorted(summary.existingSources),
      names: sorted(summary.names),
      attachments: summary.attachments.sort(
        (a, b) => compare(a.project, b.project) || compare(a.source, b.source),
      ),
      unselectedRepositories: repos.filter((repo) => !selectedIdentities.has(repo.identity)).length,
      ignoredPresentationKeys,
      disabledDefaultRepositories,
      noChanges: itemsOut.length === 0,
    },
  };
}

function sortedWarnings(warnings: readonly PlanWarning[]): PlanWarning[] {
  const rank = { version_constraint_ignored: 0, blacklist_ignored: 1 } as const;
  return [...warnings].sort((a, b) => rank[a.code] - rank[b.code] || compare(a.package, b.package));
}

function describeTarget(item: Json): string {
  const config = item.config as { repository?: string };
  return typeof item.url === 'string' ? item.url : (config.repository ?? '');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compare)
      .map((key) => [key, sortKeys((value as Obj)[key])]),
  );
}

function stable(item: Obj): string {
  return JSON.stringify(
    sortKeys({
      ecosystem: item.ecosystem,
      source_type: item.source_type,
      project: item.project,
      url: item.url,
      credential_ref: item.credential_ref,
      config: sortConfigLists(item.config),
    }),
  );
}

type Refuse = (file: DiagnosticFile, code: DiagnosticCode, pointer: string, cap?: string) => void;

function checkGitRepo(repo: Repo, refuse: Refuse): void {
  const { entry, kind } = repo;
  const pointer = `/repositories/${repo.index}`;
  const driverOk = entry?.driver === 'git';
  if (kind === 'vcs' && !driverOk) return refuse('satis', 'repository_driver_required', pointer);
  if (entry?.package === undefined) return refuse('satis', 'repository_package_required', pointer);
  if (entry.driver !== undefined && !driverOk) {
    return refuse('satis', 'unsupported_driver_options', pointer);
  }
  if (entry.packages !== undefined || entry.patterns !== undefined || entry.distHosts.length > 0) {
    refuse('repository-map', 'invalid_repository_map', `/repositories/${entry.index}`);
  }
  if (entry.installationId !== undefined && githubForm(repo.identity) === null) {
    refuse('repository-map', 'invalid_repository_map', `/repositories/${entry.index}`);
  }
  const credential = repo.credential;
  if (
    credential !== undefined &&
    (credential.kind === 'github_app') !== (entry.installationId !== undefined)
  ) {
    refuse('credentials', 'invalid_credential_map', `/repositories/${credential.index}`);
  }
  if (entry.installationId !== undefined && credential === undefined) {
    refuse('credentials', 'invalid_credential_map', '');
  }
}

interface SelectArgs {
  readonly gitRepos: readonly Repo[];
  readonly composerRepos: readonly Repo[];
  readonly exactRoots: readonly string[];
  readonly filterRoots: readonly string[];
  readonly requireAll: boolean;
  readonly refuse: Refuse;
}

function selectSources(args: SelectArgs): PlannedSource[] | null {
  const { gitRepos, composerRepos, exactRoots, filterRoots, requireAll, refuse } = args;
  const before = { failed: false };
  const fail = (code: DiagnosticCode, pointer: string, file: DiagnosticFile = 'satis'): void => {
    before.failed = true;
    refuse(file, code, pointer);
  };

  const packageOf = (repo: Repo): string => repo.entry?.package as string;
  const byPackage = new Map<string, Repo[]>();
  for (const repo of gitRepos)
    byPackage.set(packageOf(repo), [...(byPackage.get(packageOf(repo)) ?? []), repo]);
  for (const owners of byPackage.values()) {
    if (owners.length > 1) fail('ambiguous_package_owner', '', 'repository-map');
  }

  const explicit = composerRepos.filter(
    (repo) => repo.entry?.packages !== undefined || repo.entry?.patterns !== undefined,
  );
  const implicit =
    composerRepos.length === 1 && explicit.length === 0 ? composerRepos[0] : undefined;
  const packagesOf = (repo: Repo): string[] => repo.entry?.packages ?? [];
  const patternsOf = (repo: Repo): string[] => repo.entry?.patterns ?? [];
  const claims = (repo: Repo, name: string): boolean =>
    packagesOf(repo).includes(name) || patternsOf(repo).some((filter) => covers(filter, name));

  for (const repo of explicit) {
    const pointer = `/repositories/${repo.entry?.index ?? 0}/selection`;
    for (const name of packagesOf(repo)) {
      const rootFilter = filterRoots.find((filter) => covers(filter, name));
      if (!exactRoots.includes(name) && rootFilter === undefined) {
        fail('selection_coverage', pointer, 'repository-map');
      } else if (rootFilter !== undefined && !patternsOf(repo).includes(rootFilter)) {
        fail('ambiguous_package_owner', pointer, 'repository-map');
      }
    }
    for (const filter of patternsOf(repo)) {
      if (!filterRoots.includes(filter)) fail('selection_coverage', pointer, 'repository-map');
    }
  }

  const gitMatches = (predicate: (name: string) => boolean): Repo[] =>
    gitRepos.filter((repo) => predicate(packageOf(repo)));
  const selectedGit = new Set<Repo>();
  const implicitPackages = new Set<string>();
  const implicitFilters = new Set<string>();

  if (requireAll) for (const repo of gitRepos) selectedGit.add(repo);
  for (const name of exactRoots) {
    const git = gitMatches((candidate) => candidate === name);
    const composer = explicit.filter((repo) => claims(repo, name));
    if (git.length + composer.length > 1) fail('ambiguous_package_owner', '/require');
    else if (git.length === 1) selectedGit.add(git[0] as Repo);
    else if (composer.length === 0 && implicit === undefined)
      fail('selection_coverage', '/require');
    else if (composer.length === 0) implicitPackages.add(name);
  }
  for (const filter of filterRoots) {
    const git = gitMatches((candidate) => covers(filter, candidate));
    const composer = explicit.filter((repo) => patternsOf(repo).includes(filter));
    const foreign = explicit.filter(
      (repo) =>
        !patternsOf(repo).includes(filter) && packagesOf(repo).some((name) => covers(filter, name)),
    );
    if ((git.length > 0 && composer.length > 0) || composer.length > 1 || foreign.length > 0) {
      fail('ambiguous_package_owner', '/require');
    } else if (git.length > 0) for (const repo of git) selectedGit.add(repo);
    else if (composer.length === 0 && implicit === undefined)
      fail('selection_coverage', '/require');
    else if (composer.length === 0) implicitFilters.add(filter);
  }
  if (before.failed) return null;

  const planned: PlannedSource[] = [];
  for (const repo of selectedGit) planned.push(gitSource(repo));
  for (const repo of composerRepos) {
    const isImplicit = repo === implicit;
    const filters = isImplicit ? [...implicitFilters] : patternsOf(repo);
    const packages = (isImplicit ? [...implicitPackages] : packagesOf(repo)).filter(
      (name) => !filters.some((filter) => covers(filter, name)),
    );
    if (packages.length === 0 && filters.length === 0) continue;
    planned.push(composerSource(repo, sorted(packages), sorted(filters)));
  }
  return planned;
}

function sourceBase(repo: Repo): Json {
  return {
    type: 'source',
    external_ref: `satis:source:${repo.hash}`,
    name: `satis-${repo.hash.slice(0, 58)}`,
    ecosystem: 'composer',
    project: null,
    credential_ref: repo.credential?.ref ?? null,
  };
}

function gitSource(repo: Repo): PlannedSource {
  const packageName = repo.entry?.package as string;
  const form = githubForm(repo.identity);
  const app = repo.entry?.installationId;
  const config =
    app !== undefined && form !== null
      ? { provider: 'github', repository: `${form.owner}/${form.repo}`, installationId: app }
      : {
          provider: 'git',
          repository: form === null ? repo.url : `${repo.identity}.git`,
          installationId: null,
        };
  return {
    repo,
    names: [packageName],
    item: {
      ...sourceBase(repo),
      source_type: 'vcs',
      url: null,
      config: { ...config, packageName, refs: { tags: true, branches: ['*'] } },
    },
  };
}

function composerSource(repo: Repo, packages: string[], patterns: string[]): PlannedSource {
  return {
    repo,
    names: [...packages, ...patterns],
    item: {
      ...sourceBase(repo),
      source_type: 'composer_repository',
      url: repo.url,
      config: {
        selection: { packages, patterns, expandPatterns: false },
        distHosts: repo.entry?.distHosts ?? [],
        mirrorsFallback: false,
      },
    },
  };
}

function strictKeys(object: Obj, allowed: readonly string[]): boolean {
  return Object.keys(object).every((key) => allowed.includes(key));
}

function stringList(value: unknown, accept: (entry: string) => boolean): string[] | null {
  if (!Array.isArray(value)) return null;
  const entries: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || !accept(entry)) return null;
    entries.push(entry);
  }
  return entries;
}

function readRepositoryMap(text: string | undefined, refuse: Refuse) {
  const byIdentity = new Map<string, MapEntry>();
  if (text === undefined) return { byIdentity };
  const bad = (pointer: string): void =>
    refuse('repository-map', 'invalid_repository_map', pointer);
  const json = parseJson(text);
  if (!json.ok || !isObj(json.value) || !strictKeys(json.value, ['version', 'repositories'])) {
    bad('');
    return { byIdentity };
  }
  const list = own(json.value, 'repositories');
  if (own(json.value, 'version') !== 1 || !Array.isArray(list)) {
    bad('');
    return { byIdentity };
  }
  (list as unknown[]).forEach((raw, index) => {
    const pointer = `/repositories/${index}`;
    if (
      !isObj(raw) ||
      !strictKeys(raw, ['url', 'driver', 'package', 'github', 'selection', 'distHosts', 'project'])
    ) {
      return bad(pointer);
    }
    const url = own(raw, 'url');
    const driver = own(raw, 'driver');
    const packageName = own(raw, 'package');
    const github = own(raw, 'github');
    const selection = own(raw, 'selection');
    const hosts = own(raw, 'distHosts');
    const project = own(raw, 'project');
    const normalizedPackage = typeof packageName === 'string' ? composerKey(packageName) : null;
    const installation =
      isObj(github) && strictKeys(github, ['installationId'])
        ? own(github, 'installationId')
        : undefined;
    const selectionObject =
      isObj(selection) && strictKeys(selection, ['packages', 'patterns']) ? selection : null;
    const packages =
      selectionObject === null
        ? null
        : stringList(own(selectionObject, 'packages') ?? [], (name) => composerKey(name) === name);
    const patterns =
      selectionObject === null
        ? null
        : stringList(own(selectionObject, 'patterns') ?? [], isVendorFilter);
    const selectionLists = isObj(selection)
      ? [own(selection, 'packages'), own(selection, 'patterns')]
      : [];
    for (const list of [hosts, ...selectionLists]) {
      const cap = listCap(list);
      if (cap !== null) return refuse('repository-map', 'single_run_limit_exceeded', pointer, cap);
    }
    const distHosts =
      hosts === undefined ? [] : stringList(hosts, (host) => /^[a-z0-9.-]{1,253}$/.test(host));
    if (
      typeof url !== 'string' ||
      (driver !== undefined && typeof driver !== 'string') ||
      (packageName !== undefined && normalizedPackage === null) ||
      (github !== undefined &&
        !(
          typeof installation === 'number' &&
          Number.isSafeInteger(installation) &&
          installation > 0
        )) ||
      (selection !== undefined && (packages === null || patterns === null)) ||
      distHosts === null ||
      (project !== undefined &&
        !(typeof project === 'string' && PROJECT_SLUG_PATTERN.test(project)))
    ) {
      return bad(pointer);
    }
    const identity = identityOf(url);
    if (byIdentity.has(identity)) return bad(pointer);
    byIdentity.set(identity, {
      index,
      identity,
      driver: driver as string | undefined,
      package: normalizedPackage ?? undefined,
      installationId: typeof installation === 'number' ? installation : undefined,
      packages: packages ?? undefined,
      patterns: patterns ?? undefined,
      distHosts,
      project: project as string | undefined,
    });
  });
  return { byIdentity };
}

function readCredentials(text: string | undefined, refuse: Refuse) {
  const byIdentity = new Map<string, CredentialEntry>();
  if (text === undefined) return { byIdentity };
  const bad = (pointer: string): void => refuse('credentials', 'invalid_credential_map', pointer);
  const json = parseJson(text);
  if (!json.ok || !isObj(json.value) || !strictKeys(json.value, ['version', 'repositories'])) {
    bad('');
    return { byIdentity };
  }
  const list = own(json.value, 'repositories');
  if (own(json.value, 'version') !== 1 || !Array.isArray(list)) {
    bad('');
    return { byIdentity };
  }
  (list as unknown[]).forEach((raw, index) => {
    const pointer = `/repositories/${index}`;
    if (!isObj(raw) || !strictKeys(raw, ['url', 'kind', 'ref'])) return bad(pointer);
    const url = own(raw, 'url');
    const kind = own(raw, 'kind');
    const ref = own(raw, 'ref');
    if (
      typeof url !== 'string' ||
      typeof kind !== 'string' ||
      !CREDENTIAL_KINDS.includes(kind) ||
      typeof ref !== 'string' ||
      !isReference(ref)
    ) {
      return bad(pointer);
    }
    const identity = identityOf(url);
    if (byIdentity.has(identity)) return bad(pointer);
    byIdentity.set(identity, { index, kind, ref });
  });
  return { byIdentity };
}

interface Baseline {
  readonly sources: Map<string, string>;
  readonly names: Set<string>;
  readonly attachments: Set<string>;
}

function readBaseline(text: string, refuse: Refuse): Baseline | null {
  const json = parseJson(text);
  const parsed = json.ok ? parseManifest(json.value) : null;
  if (parsed === null || !parsed.ok || parsed.data.source_system !== 'satis') {
    refuse('baseline', 'invalid_baseline', '');
    return null;
  }
  const sources = new Map<string, string>();
  const names = new Set<string>();
  const attachments = new Set<string>();
  const sourceNames = new Map<string, string>();
  for (const item of parsed.data.items) {
    if (item.type === 'source') {
      sources.set(item.name, stable(item as unknown as Json));
      sourceNames.set(item.external_ref, item.name);
    } else if (item.type !== 'name' && item.type !== 'attachment') {
      refuse('baseline', 'invalid_baseline', '');
      return null;
    }
  }
  for (const item of parsed.data.items) {
    if (item.type !== 'name' && item.type !== 'attachment') continue;
    if (!('ref' in item.source)) {
      refuse('baseline', 'incomplete_baseline', '');
      return null;
    }
    if (item.type === 'name') {
      names.add(`${sourceNames.get(item.source.ref) ?? ''}\0${item.pattern}`);
    } else if ('existing' in item.project) {
      attachments.add(`${item.project.existing}\0${sourceNames.get(item.source.ref) ?? ''}`);
    }
  }
  return { sources, names, attachments };
}
