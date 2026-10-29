import { PackageNameError, packageKey } from '../catalogue/names.js';
import { isValidPattern } from '../catalogue/patterns.js';
import { classifyUrl, type OutboundPolicy } from './url-policy.js';

export type SourceType =
  'vcs' | 'composer_repository' | 'npm_registry' | 'packagist_proxy' | 'npmjs_proxy' | 'hosted';
export type SourceEcosystem = 'composer' | 'npm';

export const UPSTREAM_DEFAULTS = {
  packagist: { url: 'https://repo.packagist.org' },
  npmjs: { url: 'https://registry.npmjs.org' },
  metadataTtlSeconds: 300,
  negativeTtlSeconds: 30,
  metadataMaxBytes: 32 * 1024 * 1024,
  archiveMaxBytes: 64 * 1024 * 1024,
} as const;

export interface VcsConfig {
  readonly provider: 'github' | 'git' | 'ssh';
  readonly repository: string;
  readonly installationId?: number;
  readonly repositoryId?: number;
  readonly packageName?: string;
  readonly refs: { readonly tags: boolean; readonly branches: readonly string[] };
}
export type VcsProvider = VcsConfig['provider'];
export interface ComposerRepositoryConfig {
  readonly selection: {
    readonly packages: readonly string[];
    readonly patterns: readonly string[];
    readonly expandPatterns: boolean;
  };
  readonly distHosts: readonly string[];
  readonly mirrorsFallback: boolean;
}
export interface PackagistProxyConfig {
  readonly githubToken: boolean;
}
export type NpmjsProxyConfig = Record<string, never>;
export interface NpmRegistryConfig {
  readonly scopes: readonly string[];
  readonly distHosts: readonly string[];
}

export type SourceConfig =
  | VcsConfig
  | ComposerRepositoryConfig
  | PackagistProxyConfig
  | NpmjsProxyConfig
  | NpmRegistryConfig;

export interface SourceConfigProblem {
  readonly field: string;
  readonly message: string;
}

export type SourceConfigResult =
  | {
      readonly ok: true;
      readonly config: SourceConfig;
      readonly warnings?: readonly SourceConfigProblem[];
    }
  | { readonly ok: false; readonly problems: readonly SourceConfigProblem[] };

export interface ParseSourceConfigOptions {
  readonly runtime: 'node' | 'cloudflare';
  readonly policy: OutboundPolicy;
  readonly hasCredential: boolean;
  readonly managed?: boolean;
}

const SERVED_VCS_PROVIDERS: Readonly<
  Record<ParseSourceConfigOptions['runtime'], readonly VcsProvider[]>
> = Object.freeze({
  node: Object.freeze(['github', 'git', 'ssh'] as const),
  cloudflare: Object.freeze(['github'] as const),
});

/** The VCS providers whose sources this runtime both syncs and serves as installable dists. */
export function servedVcsProviders(
  runtime: ParseSourceConfigOptions['runtime'],
): readonly VcsProvider[] {
  return SERVED_VCS_PROVIDERS[runtime];
}

/** The served VCS providers that have a registered provider among `registered`, in served order. */
export function reportedVcsProviders(
  runtime: ParseSourceConfigOptions['runtime'],
  registered: Iterable<{ readonly id: string; readonly sourceTypes: readonly string[] }>,
): readonly VcsProvider[] {
  const ids = new Set(
    [...registered]
      .filter((provider) => provider.sourceTypes.includes('vcs'))
      .map((provider) => provider.id),
  );
  return servedVcsProviders(runtime).filter((provider) => ids.has(provider));
}

const MAX_ENTRIES = 64;
const MAX_ENTRY_LENGTH = 200;
// Sized from the per-field caps: the widest config (composer_repository: packages,
// patterns and distHosts) holds 3 lists x 64 entries x (200 chars + quotes/comma), ~39 KB;
// rounded up to 64 KiB.
const MAX_CONFIG_LENGTH = 65536;
const hasUnsafeChars = (text: string): boolean =>
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0020\u007f]/.test(text) || text !== text.trim();

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class Collector {
  readonly problems: SourceConfigProblem[] = [];
  readonly flagged = new Set<string>();
  add(field: string, message: string): void {
    if (this.flagged.has(field)) return;
    this.flagged.add(field);
    this.problems.push({ field, message });
  }
}

function rejectUnknown(
  c: Collector,
  obj: Obj,
  allowed: readonly string[],
  parent = 'config',
): void {
  if (Object.keys(obj).some((key) => !allowed.includes(key))) c.add(parent, 'unknown key');
}

function stringList(
  c: Collector,
  field: string,
  value: unknown,
  entry: (item: string) => boolean,
  minLength = 0,
): string[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES || value.length < minLength) {
    c.add(
      field,
      `must be a list of ${minLength === 0 ? 'up to' : `${minLength} to`} ${MAX_ENTRIES} entries`,
    );
    return [];
  }
  const items = value as unknown[];
  if (new Set(items).size !== items.length) {
    c.add(field, 'contains duplicate entries');
    return [];
  }
  for (const item of items) {
    if (
      typeof item !== 'string' ||
      item.length === 0 ||
      item.length > MAX_ENTRY_LENGTH ||
      !entry(item)
    ) {
      c.add(field, 'contains an invalid entry');
      return [];
    }
  }
  return items as string[];
}

function validComposerName(name: string): boolean {
  try {
    packageKey(name, { ecosystem: 'composer' });
    return true;
  } catch (error) {
    if (error instanceof PackageNameError) return false;
    throw error;
  }
}

function validBranch(name: string): boolean {
  if (name === '*') return true;
  return (
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u0020\u007f~^:?*[\\]/.test(name) &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.startsWith('-') &&
    !name.endsWith('.') &&
    !name.includes('//') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    name !== '@' &&
    name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SSH_USER = /^[a-z0-9._-]{1,32}$/;
const SSH_IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;
const SSH_PATH = /^[A-Za-z0-9._~+/-]+$/;
const NPM_SCOPE = /^@[a-z0-9][a-z0-9._~-]*$/;

function sourceUrl(text: string, policy: OutboundPolicy): URL | null {
  const prefix = /^https?:\/\//.exec(text)?.[0];
  if (prefix === undefined || text.length > 2048 || hasUnsafeChars(text)) return null;
  const authority = text.slice(prefix.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority === '' || authority.includes('@')) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '' || text.includes('#'))
    return null;
  if (url.search !== '' || text.includes('?')) return null;
  if (!classifyUrl(text, policy).ok) return null;
  return url;
}

function validSshRepository(text: string, policy: OutboundPolicy): boolean {
  if (text.length > MAX_ENTRY_LENGTH || hasUnsafeChars(text)) return false;
  let user: string;
  let host: string;
  let path: string;
  let port = 22;
  if (text.startsWith('ssh://')) {
    const match = /^ssh:\/\/([^@/:]+)@(\[[^\]/]*\]|[^/:[\]]+)(?::(\d{1,5}))?\/(.+)$/.exec(text);
    if (!match) return false;
    user = match[1] ?? '';
    host = match[2] ?? '';
    path = match[4] ?? '';
    if (match[3] !== undefined) {
      port = Number(match[3]);
      if (port < 1 || port > 65535) return false;
    }
  } else {
    const match = /^([^@/:]+)@([^/:]+):(.+)$/.exec(text);
    if (!match) return false;
    user = match[1] ?? '';
    host = match[2] ?? '';
    path = match[3] ?? '';
  }
  const bracketed = host.startsWith('[');
  const lowerHost = host.toLowerCase();
  // Classify the real destination host:port so an allowlist entry matches it exactly. A
  // 'port' refusal is the last check and means a public, non-allowlisted host; ssh may use
  // any port there. Private hosts are only admitted by a matching allowlist entry.
  const verdict = classifyUrl(`https://${lowerHost}:${port}/`, policy);
  const hostAllowed = verdict.ok || verdict.reason === 'port';
  return (
    SSH_USER.test(user) &&
    (bracketed ? SSH_IPV6.test(host) : HOSTNAME.test(lowerHost)) &&
    hostAllowed &&
    SSH_PATH.test(path) &&
    !path.startsWith('-') &&
    !path.startsWith('~') &&
    !path.split('/').includes('..')
  );
}

function parseVcs(
  c: Collector,
  obj: Obj,
  runtime: string,
  policy: OutboundPolicy,
  managed: boolean,
): VcsConfig | null {
  rejectUnknown(c, obj, [
    'provider',
    'repository',
    'installationId',
    'repositoryId',
    'packageName',
    'refs',
  ]);
  const provider = obj.provider;
  if (provider !== 'github' && provider !== 'git' && provider !== 'ssh') {
    c.add('provider', 'must be github, git or ssh');
  } else if (provider === 'ssh' && runtime === 'cloudflare') {
    c.add('provider', 'ssh is not available on cloudflare');
  } else if (provider === 'git' && runtime === 'cloudflare') {
    c.add('provider', 'git is not available on cloudflare: archive building requires node');
  }
  const repository = obj.repository;
  if (typeof repository !== 'string') {
    c.add('repository', 'must be a string');
  } else if (provider === 'github') {
    if (!GITHUB_REPOSITORY.test(repository) || /\/\.{1,2}$/.test(repository))
      c.add('repository', 'must be owner/name');
  } else if (provider === 'git') {
    if (sourceUrl(repository, policy) === null)
      c.add('repository', 'must be an allowed URL without userinfo, query or fragment');
  } else if (provider === 'ssh') {
    if (!validSshRepository(repository, policy))
      c.add('repository', 'must be a valid ssh repository');
  }
  let installationId: number | undefined;
  if (obj.installationId !== undefined) {
    const id = obj.installationId;
    if (provider !== 'github' || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      c.add('installationId', 'only valid for github, as a positive integer');
    } else {
      installationId = id;
    }
  }
  let repositoryId: number | undefined;
  if (obj.repositoryId !== undefined) {
    const id = obj.repositoryId;
    if (provider !== 'github' || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      c.add('repositoryId', 'only valid for github, as a positive integer');
    } else {
      repositoryId = id;
    }
  } else if (managed && provider === 'github') {
    c.add('repositoryId', 'is required for managed github sources');
  }
  let packageName: string | undefined;
  if (obj.packageName !== undefined) {
    if (typeof obj.packageName !== 'string' || !validComposerName(obj.packageName)) {
      c.add('packageName', 'must be vendor/name');
    } else {
      packageName = packageKey(obj.packageName, { ecosystem: 'composer' });
    }
  }
  let tags = true;
  let branches: string[] = [];
  if (obj.refs !== undefined) {
    if (!isObj(obj.refs)) {
      c.add('refs', 'must be an object');
    } else {
      rejectUnknown(c, obj.refs, ['tags', 'branches'], 'refs');
      if (obj.refs.tags !== undefined) {
        if (typeof obj.refs.tags === 'boolean') tags = obj.refs.tags;
        else c.add('refs.tags', 'must be a boolean');
      }
      if (obj.refs.branches !== undefined) {
        branches = stringList(c, 'refs.branches', obj.refs.branches, validBranch);
      }
    }
  }
  if (c.problems.length > 0) return null;
  return {
    provider: provider as VcsConfig['provider'],
    repository: repository as string,
    ...(installationId === undefined ? {} : { installationId }),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(packageName === undefined ? {} : { packageName }),
    refs: { tags, branches },
  };
}

function parseDistHosts(c: Collector, obj: Obj, policy: OutboundPolicy): string[] {
  if (obj.distHosts === undefined) return [];
  const hosts = stringList(c, 'distHosts', obj.distHosts, (h) => {
    const host = h.toLowerCase();
    return HOSTNAME.test(host) && classifyUrl(`https://${host}/`, policy).ok;
  }).map((h) => h.toLowerCase());
  if (new Set(hosts).size !== hosts.length) {
    c.add('distHosts', 'contains duplicate entries');
    return [];
  }
  return hosts;
}

function parseComposerRepository(
  c: Collector,
  obj: Obj,
  policy: OutboundPolicy,
): ComposerRepositoryConfig | null {
  rejectUnknown(c, obj, ['selection', 'distHosts', 'mirrorsFallback']);
  let packages: string[] = [];
  let patterns: string[] = [];
  let expandPatterns = false;
  if (obj.selection !== undefined) {
    if (!isObj(obj.selection)) {
      c.add('selection', 'must be an object');
    } else {
      const sel = obj.selection;
      rejectUnknown(c, sel, ['packages', 'patterns', 'expandPatterns'], 'selection');
      if (sel.packages !== undefined)
        packages = stringList(c, 'selection.packages', sel.packages, validComposerName).map((n) =>
          packageKey(n, { ecosystem: 'composer' }),
        );
      if (new Set(packages).size !== packages.length) {
        c.add('selection.packages', 'contains duplicate entries');
        packages = [];
      }
      if (sel.patterns !== undefined)
        patterns = stringList(
          c,
          'selection.patterns',
          sel.patterns,
          (p) => isValidPattern(p) && !/^[*/]+$/.test(p),
        );
      if (sel.expandPatterns !== undefined) {
        if (typeof sel.expandPatterns === 'boolean') expandPatterns = sel.expandPatterns;
        else c.add('selection.expandPatterns', 'must be a boolean');
      }
    }
  }
  const distHosts = parseDistHosts(c, obj, policy);
  let mirrorsFallback = false;
  if (obj.mirrorsFallback !== undefined) {
    if (typeof obj.mirrorsFallback === 'boolean') mirrorsFallback = obj.mirrorsFallback;
    else c.add('mirrorsFallback', 'must be a boolean');
  }
  if (c.problems.length > 0) return null;
  return { selection: { packages, patterns, expandPatterns }, distHosts, mirrorsFallback };
}

function broadPatternWarnings(patterns: readonly string[]): SourceConfigProblem[] {
  const warnings: SourceConfigProblem[] = [];
  patterns.forEach((pattern, i) => {
    const slash = pattern.indexOf('/');
    const vendor = slash < 0 ? '' : pattern.slice(0, slash);
    if (vendor === '' || vendor.includes('*'))
      warnings.push({
        field: `selection.patterns[${i}]`,
        message: 'pattern has no literal vendor segment and may match almost every package',
      });
  });
  return warnings;
}

const ECOSYSTEM_OF: Record<Exclude<SourceType, 'hosted'>, SourceEcosystem> = {
  vcs: 'composer',
  composer_repository: 'composer',
  packagist_proxy: 'composer',
  npm_registry: 'npm',
  npmjs_proxy: 'npm',
};

export function parseSourceConfig(
  type: SourceType,
  ecosystem: SourceEcosystem,
  url: string | null | undefined,
  configJson: string,
  options: ParseSourceConfigOptions,
): SourceConfigResult {
  const c = new Collector();
  const fail = (): SourceConfigResult => ({ ok: false, problems: c.problems });
  const { policy } = options;

  if (type === 'hosted') {
    c.add('type', 'hosted sources are not supported');
    return fail();
  }
  if (!Object.hasOwn(ECOSYSTEM_OF, type)) {
    c.add('type', 'unknown source type');
    return fail();
  }
  if (ecosystem !== 'composer' && ecosystem !== 'npm') {
    c.add('ecosystem', 'must be composer or npm');
    return fail();
  }
  if (ECOSYSTEM_OF[type] !== ecosystem)
    c.add('ecosystem', `must be ${ECOSYSTEM_OF[type]} for ${type}`);

  if (configJson.length > MAX_CONFIG_LENGTH) {
    c.add('config', `is longer than ${MAX_CONFIG_LENGTH} characters`);
    return fail();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    c.add('config', 'must be valid JSON');
    return fail();
  }
  if (!isObj(parsed)) {
    c.add('config', 'must be a JSON object');
    return fail();
  }

  const hasUrl = url !== null && url !== undefined;
  switch (type) {
    case 'vcs': {
      if (hasUrl) c.add('url', 'must be empty for vcs');
      const config = parseVcs(c, parsed, options.runtime, policy, options.managed === true);
      return c.problems.length > 0 || config === null ? fail() : { ok: true, config };
    }
    case 'composer_repository': {
      if (!hasUrl || sourceUrl(url, policy) === null) {
        c.add('url', 'must be an allowed URL without userinfo, query or fragment');
      }
      const config = parseComposerRepository(c, parsed, policy);
      if (c.problems.length > 0 || config === null) return fail();
      const warnings = broadPatternWarnings(config.selection.patterns);
      return warnings.length > 0 ? { ok: true, config, warnings } : { ok: true, config };
    }
    case 'npm_registry': {
      if (!hasUrl || sourceUrl(url, policy) === null) {
        c.add('url', 'must be an allowed URL without userinfo, query or fragment');
      }
      rejectUnknown(c, parsed, ['scopes', 'distHosts']);
      const scopes = stringList(c, 'scopes', parsed.scopes, (s) => NPM_SCOPE.test(s), 1);
      const distHosts = parseDistHosts(c, parsed, policy);
      return c.problems.length > 0 ? fail() : { ok: true, config: { scopes, distHosts } };
    }
    case 'packagist_proxy': {
      if (url !== UPSTREAM_DEFAULTS.packagist.url)
        c.add('url', `must be ${UPSTREAM_DEFAULTS.packagist.url}`);
      rejectUnknown(c, parsed, ['githubToken']);
      if (parsed.githubToken !== undefined && typeof parsed.githubToken !== 'boolean') {
        c.add('githubToken', 'must be a boolean');
      }
      if (parsed.githubToken === true && !options.hasCredential) {
        c.add('credential', 'githubToken requires a credential');
      }
      return c.problems.length > 0
        ? fail()
        : { ok: true, config: { githubToken: parsed.githubToken === true } };
    }
    case 'npmjs_proxy': {
      if (url !== UPSTREAM_DEFAULTS.npmjs.url)
        c.add('url', `must be ${UPSTREAM_DEFAULTS.npmjs.url}`);
      rejectUnknown(c, parsed, []);
      if (options.hasCredential) c.add('credential', 'npmjs_proxy takes no credential');
      return c.problems.length > 0 ? fail() : { ok: true, config: {} };
    }
  }
}

export function checkRetentionOverride(
  override: number | null,
  organizationRetentionDays: number,
): boolean {
  if (override === null) return true;
  return Number.isInteger(override) && override >= 0 && override >= organizationRetentionDays;
}
