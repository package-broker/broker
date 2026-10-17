import { describe, expect, it } from 'vitest';
import { createOutboundPolicy } from '../sources/url-policy.js';
import { parseSourceConfig, type SourceType as RuntimeType } from '../sources/config.js';
import {
  ECOSYSTEM_OF,
  SOURCE_CONFIG_SCHEMAS,
  SOURCE_TYPES,
  isConfigOf,
  sortConfigLists,
  type SourceType,
} from './source-config.js';

const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const options = { runtime: 'node', policy, hasCredential: false } as const;

const vcs = (over: Record<string, unknown> = {}, refs: Record<string, unknown> = {}) => ({
  provider: 'github',
  repository: 'acme/widgets',
  installationId: null,
  packageName: null,
  refs: { tags: true, branches: ['main'], ...refs },
  ...over,
});
const composerRepo = (
  selection: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
) => ({
  selection: {
    packages: ['acme/widget'],
    patterns: ['acme/*'],
    expandPatterns: false,
    ...selection,
  },
  distHosts: ['dist.example.test'],
  mirrorsFallback: false,
  ...over,
});

interface Case {
  readonly label: string;
  readonly type: SourceType;
  readonly url: string | null;
  readonly config: unknown;
  readonly valid: boolean;
  readonly stricterThanRuntime?: true;
}

const URLS: Record<SourceType, string | null> = {
  vcs: null,
  composer_repository: 'https://repo.example.test/',
  npm_registry: 'https://npm.example.test/',
  packagist_proxy: 'https://repo.packagist.org',
  npmjs_proxy: 'https://registry.npmjs.org',
};

const cases: readonly Case[] = [
  { label: 'github', type: 'vcs', url: null, config: vcs(), valid: true },
  {
    label: 'github installation',
    type: 'vcs',
    url: null,
    config: vcs({ installationId: 7 }),
    valid: true,
  },
  {
    label: 'github with an owner only',
    type: 'vcs',
    url: null,
    config: vcs({ repository: 'acme' }),
    valid: false,
  },
  {
    label: 'git over https',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'git', repository: 'https://git.example.test/acme/w.git' }),
    valid: true,
  },
  {
    label: 'git with a query',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'git', repository: 'https://git.example.test/w?x=1' }),
    valid: false,
  },
  {
    label: 'git with userinfo',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'git', repository: 'https://u@git.example.test/w' }),
    valid: false,
  },
  {
    label: 'ssh url form',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'ssh', repository: 'ssh://git@git.example.test/acme/w.git' }),
    valid: true,
  },
  {
    label: 'ssh scp form',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'ssh', repository: 'git@git.example.test:acme/w.git' }),
    valid: false,
    stricterThanRuntime: true,
  },
  {
    label: 'ssh upper-case host',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'ssh', repository: 'ssh://git@Git.example.test/acme/w.git' }),
    valid: false,
    stricterThanRuntime: true,
  },
  {
    label: 'ssh explicit port 22',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'ssh', repository: 'ssh://git@git.example.test:22/acme/w.git' }),
    valid: false,
    stricterThanRuntime: true,
  },
  {
    label: 'ssh other port',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'ssh', repository: 'ssh://git@git.example.test:2222/acme/w.git' }),
    valid: true,
  },
  {
    label: 'git url with an upper-case host',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'git', repository: 'https://Git.example.test/w.git' }),
    valid: false,
    stricterThanRuntime: true,
  },
  {
    label: 'git url with a raw pipe',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'git', repository: 'https://git.example.test/a|b.git' }),
    valid: false,
    stricterThanRuntime: true,
  },
  {
    label: 'github owner with capitals',
    type: 'vcs',
    url: null,
    config: vcs({ repository: 'Acme/widgets' }),
    valid: false,
    stricterThanRuntime: true,
  },
  {
    label: 'composer pattern starting with @',
    type: 'composer_repository',
    url: URLS.composer_repository,
    config: composerRepo({ patterns: ['@acme/*'] }),
    valid: false,
    stricterThanRuntime: true,
  },
  {
    label: 'composer pattern with a run of wildcards',
    type: 'composer_repository',
    url: URLS.composer_repository,
    config: composerRepo({ patterns: ['acme/**'] }),
    valid: false,
    stricterThanRuntime: true,
  },
  {
    label: 'ssh path traversal',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'ssh', repository: 'git@git.example.test:../w' }),
    valid: false,
  },
  {
    label: 'installation id on git',
    type: 'vcs',
    url: null,
    config: vcs({ provider: 'git', repository: 'https://git.example.test/w', installationId: 7 }),
    valid: false,
  },
  {
    label: 'package name with capitals',
    type: 'vcs',
    url: null,
    config: vcs({ packageName: 'Acme/Widget' }),
    valid: false,
    stricterThanRuntime: true,
  },
  {
    label: 'package name',
    type: 'vcs',
    url: null,
    config: vcs({ packageName: 'acme/widget' }),
    valid: true,
  },
  {
    label: 'duplicate branches',
    type: 'vcs',
    url: null,
    config: vcs({}, { branches: ['main', 'main'] }),
    valid: false,
  },
  {
    label: 'branch with a tilde',
    type: 'vcs',
    url: null,
    config: vcs({}, { branches: ['a~b'] }),
    valid: false,
  },
  {
    label: 'composer repository',
    type: 'composer_repository',
    url: URLS.composer_repository,
    config: composerRepo(),
    valid: true,
  },
  {
    label: 'duplicate packages',
    type: 'composer_repository',
    url: URLS.composer_repository,
    config: composerRepo({ packages: ['a/b', 'a/b'] }),
    valid: false,
  },
  {
    label: 'catch-all pattern',
    type: 'composer_repository',
    url: URLS.composer_repository,
    config: composerRepo({ patterns: ['**'] }),
    valid: false,
  },
  {
    label: 'upper-case dist host',
    type: 'composer_repository',
    url: URLS.composer_repository,
    config: composerRepo({}, { distHosts: ['Dist.example.test'] }),
    valid: false,
    stricterThanRuntime: true,
  },
  {
    label: 'npm registry',
    type: 'npm_registry',
    url: URLS.npm_registry,
    config: { scopes: ['@acme'] },
    valid: true,
  },
  {
    label: 'npm registry without scopes',
    type: 'npm_registry',
    url: URLS.npm_registry,
    config: { scopes: [] },
    valid: false,
  },
  {
    label: 'npm scope without @',
    type: 'npm_registry',
    url: URLS.npm_registry,
    config: { scopes: ['acme'] },
    valid: false,
  },
  {
    label: 'packagist proxy',
    type: 'packagist_proxy',
    url: URLS.packagist_proxy,
    config: { githubToken: false },
    valid: true,
  },
  {
    label: 'packagist proxy with a string flag',
    type: 'packagist_proxy',
    url: URLS.packagist_proxy,
    config: { githubToken: 'no' },
    valid: false,
  },
  { label: 'npmjs proxy', type: 'npmjs_proxy', url: URLS.npmjs_proxy, config: {}, valid: true },
  {
    label: 'npmjs proxy with a key',
    type: 'npmjs_proxy',
    url: URLS.npmjs_proxy,
    config: { scopes: [] },
    valid: false,
  },
];

function runtimeForm(config: unknown): string {
  return JSON.stringify(config, (_key, value: unknown) => (value === null ? undefined : value));
}

describe('source config schemas agree with parseSourceConfig', () => {
  for (const c of cases) {
    it(`${c.valid ? 'accepts' : 'refuses'} ${c.label}`, () => {
      expect(isConfigOf(c.type, c.config)).toBe(c.valid);
      const runtime = parseSourceConfig(
        c.type as RuntimeType,
        ECOSYSTEM_OF[c.type],
        c.url,
        runtimeForm(c.config),
        options,
      );
      expect(runtime.ok).toBe(c.valid || c.stricterThanRuntime === true);
    });
  }
});

describe('ECOSYSTEM_OF mirror', () => {
  for (const type of SOURCE_TYPES) {
    const sample = cases.find((c) => c.type === type && c.valid);
    it(`${type} matches parseSourceConfig for its ecosystem and refuses the other`, () => {
      if (sample === undefined) throw new Error('no valid sample');
      const mirrored = ECOSYSTEM_OF[type];
      const opposite = mirrored === 'composer' ? 'npm' : 'composer';
      const args = [sample.url, runtimeForm(sample.config), options] as const;
      expect(parseSourceConfig(type, mirrored, ...args).ok).toBe(true);
      const refused = parseSourceConfig(type, opposite, ...args);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.problems.map((p) => p.field)).toContain('ecosystem');
    });
  }

  it('lists every source type once', () => {
    expect(Object.keys(ECOSYSTEM_OF).sort()).toEqual([...SOURCE_TYPES].sort());
    expect(Object.keys(SOURCE_CONFIG_SCHEMAS).sort()).toEqual([...SOURCE_TYPES].sort());
  });
});

describe('config shape', () => {
  it('requires every key', () => {
    const partial: Record<string, unknown> = vcs();
    delete partial.refs;
    expect(isConfigOf('vcs', partial)).toBe(false);
    expect(isConfigOf('vcs', vcs({ extra: 1 }))).toBe(false);
  });

  it('sorts every list and leaves scalars alone', () => {
    const sorted = sortConfigLists(
      composerRepo({ packages: ['b/b', 'a/a'], patterns: ['z/*', 'a/*'] }),
    );
    expect(sorted.selection.packages).toEqual(['a/a', 'b/b']);
    expect(sorted.selection.patterns).toEqual(['a/*', 'z/*']);
    expect(sorted.mirrorsFallback).toBe(false);
  });
});
