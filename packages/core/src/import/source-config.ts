import * as z from 'zod/mini';
import { PackageNameError, packageKey } from '../catalogue/names.js';
import { isValidPattern } from '../catalogue/patterns.js';

export type SourceType =
  'vcs' | 'composer_repository' | 'npm_registry' | 'packagist_proxy' | 'npmjs_proxy';

export const SOURCE_TYPES = [
  'vcs',
  'composer_repository',
  'npm_registry',
  'packagist_proxy',
  'npmjs_proxy',
] as const satisfies readonly SourceType[];

export const ECOSYSTEM_OF: Readonly<Record<SourceType, 'composer' | 'npm'>> = {
  vcs: 'composer',
  composer_repository: 'composer',
  packagist_proxy: 'composer',
  npm_registry: 'npm',
  npmjs_proxy: 'npm',
};

const MAX_ENTRIES = 64;
const MAX_ENTRY_LENGTH = 200;
export const MAX_URL_LENGTH = 2048;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const GITHUB_REPOSITORY = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;
const SSH_USER = /^[a-z0-9._-]{1,32}$/;
const SSH_IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;
const SSH_PATH = /^[A-Za-z0-9._~+/-]+$/;
const NPM_SCOPE = /^@[a-z0-9][a-z0-9._~-]*$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000- \u007f]/;

const LOWERCASE_ESCAPE = /%(?:[a-f]|[0-9A-F][a-f])/;
const BARE_PERCENT = /%(?![0-9A-Fa-f]{2})/;
const RAW_PATH_DELIMITER = /[[\]|]/;
const ESCAPE = /%([0-9A-Fa-f]{2})/g;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

export function isCanonicalUrl(value: string): boolean {
  if (
    value.length > MAX_URL_LENGTH ||
    /[?#]/.test(value) ||
    LOWERCASE_ESCAPE.test(value) ||
    BARE_PERCENT.test(value)
  ) {
    return false;
  }
  for (const match of value.matchAll(ESCAPE)) {
    if (UNRESERVED.test(String.fromCharCode(Number.parseInt(match[1] ?? '', 16)))) return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' &&
    url.password === '' &&
    !url.hostname.endsWith('.') &&
    !RAW_PATH_DELIMITER.test(url.pathname) &&
    url.href === value
  );
}

export function isCanonicalPattern(pattern: string): boolean {
  return isValidPattern(pattern) && !pattern.includes('**');
}

function isComposerKey(name: string): boolean {
  try {
    return packageKey(name, { ecosystem: 'composer' }) === name;
  } catch (error) {
    if (error instanceof PackageNameError) return false;
    throw error;
  }
}

function isBranch(name: string): boolean {
  if (name === '*') return true;
  return (
    // eslint-disable-next-line no-control-regex
    !/[\u0000- \u007f~^:?*[\\]/.test(name) &&
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

function isGitUrl(text: string): boolean {
  const prefix = /^https?:\/\//.exec(text)?.[0];
  if (prefix === undefined || text.length > MAX_URL_LENGTH || UNSAFE_CHARS.test(text)) return false;
  const authority = text.slice(prefix.length).split(/[/?#]/, 1)[0] ?? '';
  if (authority === '' || authority.includes('@') || /[?#]/.test(text)) return false;
  try {
    const url = new URL(text);
    return url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

function isSshRepository(text: string): boolean {
  if (text.length > MAX_ENTRY_LENGTH || UNSAFE_CHARS.test(text)) return false;
  const match = /^ssh:\/\/([^@/:]+)@(\[[^\]/]*\]|[^/:[\]]+)(?::(\d{1,5}))?\/(.+)$/.exec(text);
  if (!match) return false;
  const [, user = '', host = '', port, path = ''] = match;
  if (port !== undefined) {
    const number = Number(port);
    if (String(number) !== port || number < 1 || number > 65535 || number === 22) return false;
  }
  return (
    SSH_USER.test(user) &&
    (host.startsWith('[') ? SSH_IPV6.test(host) : HOSTNAME.test(host)) &&
    SSH_PATH.test(path) &&
    !path.startsWith('-') &&
    !path.startsWith('~') &&
    !path.split('/').includes('..')
  );
}

function stringSet(accepts: (entry: string) => boolean, minLength = 0) {
  return z
    .array(
      z
        .string()
        .check(
          z.refine(
            (entry) => entry.length >= 1 && entry.length <= MAX_ENTRY_LENGTH && accepts(entry),
          ),
        ),
    )
    .check(
      z.minLength(minLength),
      z.maxLength(MAX_ENTRIES),
      z.refine((entries) => new Set(entries).size === entries.length),
    );
}

const vcsConfig = z
  .strictObject({
    provider: z.enum(['github', 'git', 'ssh']),
    repository: z.string(),
    installationId: z.nullable(z.number().check(z.refine((n) => Number.isSafeInteger(n) && n > 0))),
    packageName: z.nullable(z.string().check(z.refine(isComposerKey))),
    refs: z.strictObject({ tags: z.boolean(), branches: stringSet(isBranch) }),
  })
  .check(
    z.refine((config) => {
      const { provider, repository, installationId } = config;
      if (installationId !== null && provider !== 'github') return false;
      if (provider === 'github') {
        return GITHUB_REPOSITORY.test(repository) && !/\/\.{1,2}$/.test(repository);
      }
      return provider === 'git'
        ? isGitUrl(repository) && isCanonicalUrl(repository)
        : isSshRepository(repository);
    }),
  );

const composerRepositoryConfig = z.strictObject({
  selection: z.strictObject({
    packages: stringSet(isComposerKey),
    patterns: stringSet(
      (pattern) =>
        isCanonicalPattern(pattern) && !/^[*/]+$/.test(pattern) && !pattern.startsWith('@'),
    ),
    expandPatterns: z.boolean(),
  }),
  distHosts: stringSet((host) => host === host.toLowerCase() && HOSTNAME.test(host)),
  mirrorsFallback: z.boolean(),
});

const npmRegistryConfig = z.strictObject({ scopes: stringSet((s) => NPM_SCOPE.test(s), 1) });
const packagistProxyConfig = z.strictObject({ githubToken: z.boolean() });
const npmjsProxyConfig = z.strictObject({});

export const SOURCE_CONFIG_SCHEMAS = {
  vcs: vcsConfig,
  composer_repository: composerRepositoryConfig,
  npm_registry: npmRegistryConfig,
  packagist_proxy: packagistProxyConfig,
  npmjs_proxy: npmjsProxyConfig,
} as const;

export const sourceConfig = z.union([
  vcsConfig,
  composerRepositoryConfig,
  npmRegistryConfig,
  packagistProxyConfig,
  npmjsProxyConfig,
]);

export type SourceConfigValue = z.infer<typeof sourceConfig>;

export function isPackagistConfig(config: unknown): config is { githubToken: boolean } {
  return z.safeParse(packagistProxyConfig, config).success;
}

export function isConfigOf(type: SourceType, config: unknown): boolean {
  return z.safeParse(SOURCE_CONFIG_SCHEMAS[type], config).success;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function sortConfigLists<T>(value: T): T {
  if (Array.isArray(value)) return [...value].sort(compareCodeUnits) as T;
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sortConfigLists(entry)]),
  ) as T;
}
