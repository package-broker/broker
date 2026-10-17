import { describe, expect, it } from 'vitest';
import { createOutboundPolicy } from './url-policy.js';
import {
  UPSTREAM_DEFAULTS,
  checkRetentionOverride,
  parseSourceConfig,
  type SourceType,
} from './config.js';

const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const parse = (
  type: SourceType,
  ecosystem: 'composer' | 'npm',
  url: string | null,
  config: unknown,
  options: { runtime?: 'node' | 'cloudflare'; hasCredential?: boolean } = {},
) =>
  parseSourceConfig(type, ecosystem, url, JSON.stringify(config), {
    runtime: options.runtime ?? 'node',
    policy,
    hasCredential: options.hasCredential ?? false,
  });

function problems(result: ReturnType<typeof parse>): string[] {
  if (result.ok) throw new Error('expected problems');
  return result.problems.map((p) => p.field);
}

const github = { provider: 'github', repository: 'acme/widgets' };

describe('minimal valid configs', () => {
  it('parses vcs github, git and ssh', () => {
    const gh = parse('vcs', 'composer', null, {
      ...github,
      installationId: 7,
      packageName: 'acme/widgets',
    });
    expect(gh.ok && gh.config).toMatchObject({
      provider: 'github',
      installationId: 7,
      refs: { tags: true, branches: [] },
    });
    expect(
      parse('vcs', 'composer', null, {
        provider: 'git',
        repository: 'https://git.example.com/a/b.git',
      }).ok,
    ).toBe(true);
    expect(
      parse('vcs', 'composer', null, {
        provider: 'ssh',
        repository: 'ssh://git@host.example.com:2222/srv/repo.git',
      }).ok,
    ).toBe(true);
    expect(
      parse('vcs', 'composer', null, {
        provider: 'ssh',
        repository: 'git@host.example.com:srv/repo.git',
      }).ok,
    ).toBe(true);
  });

  it('parses composer_repository with defaults', () => {
    const r = parse('composer_repository', 'composer', 'https://repo.example.com/', {});
    expect(r.ok && r.config).toMatchObject({
      selection: { packages: [], patterns: [], expandPatterns: false },
      distHosts: [],
      mirrorsFallback: false,
    });
    const full = parse('composer_repository', 'composer', 'https://repo.example.com', {
      selection: { packages: ['acme/a'], patterns: ['acme/*'], expandPatterns: true },
      distHosts: ['dist.example.com'],
      mirrorsFallback: true,
    });
    expect(full.ok).toBe(true);
  });

  it('parses proxies and npm_registry', () => {
    expect(parse('packagist_proxy', 'composer', UPSTREAM_DEFAULTS.packagist.url, {}).ok).toBe(true);
    const tok = parse(
      'packagist_proxy',
      'composer',
      UPSTREAM_DEFAULTS.packagist.url,
      { githubToken: true },
      { hasCredential: true },
    );
    expect(tok.ok && tok.config).toEqual({ githubToken: true });
    expect(parse('npmjs_proxy', 'npm', UPSTREAM_DEFAULTS.npmjs.url, {}).ok).toBe(true);
    expect(parse('npm_registry', 'npm', 'https://npm.example.com', { scopes: ['@acme'] }).ok).toBe(
      true,
    );
  });

  it('exposes the upstream defaults', () => {
    expect(UPSTREAM_DEFAULTS.packagist.url).toBe('https://repo.packagist.org');
    expect(UPSTREAM_DEFAULTS.npmjs.url).toBe('https://registry.npmjs.org');
    expect(UPSTREAM_DEFAULTS.metadataTtlSeconds).toBe(300);
    expect(UPSTREAM_DEFAULTS.negativeTtlSeconds).toBe(30);
    expect(UPSTREAM_DEFAULTS.metadataMaxBytes).toBe(32 * 1024 * 1024);
    expect(UPSTREAM_DEFAULTS.archiveMaxBytes).toBe(64 * 1024 * 1024);
  });
});

describe('named problems', () => {
  it('reports one problem per invalid vcs field', () => {
    expect(problems(parse('vcs', 'composer', null, { provider: 'svn', repository: 'x' }))).toEqual([
      'provider',
    ]);
    expect(
      problems(parse('vcs', 'composer', null, { provider: 'github', repository: 'nope' })),
    ).toEqual(['repository']);
    expect(problems(parse('vcs', 'composer', null, { ...github, installationId: 0 }))).toEqual([
      'installationId',
    ]);
    expect(problems(parse('vcs', 'composer', null, { ...github, installationId: 1.5 }))).toEqual([
      'installationId',
    ]);
    expect(
      problems(
        parse('vcs', 'composer', null, {
          provider: 'git',
          repository: 'https://git.example.com/a',
          installationId: 1,
        }),
      ),
    ).toEqual(['installationId']);
    expect(
      problems(parse('vcs', 'composer', null, { ...github, packageName: 'Bad Name' })),
    ).toEqual(['packageName']);
    expect(
      problems(parse('vcs', 'composer', null, { ...github, refs: { tags: 'yes', branches: [] } })),
    ).toEqual(['refs.tags']);
    expect(
      problems(
        parse('vcs', 'composer', null, { ...github, refs: { tags: true, branches: ['-x'] } }),
      ),
    ).toEqual(['refs.branches']);
    expect(
      parse('vcs', 'composer', null, { ...github, refs: { tags: true, branches: ['main', '*'] } })
        .ok,
    ).toBe(true);
  });

  it('reports unknown keys', () => {
    expect(problems(parse('vcs', 'composer', null, { ...github, extra: 1 }))).toEqual(['config']);
    expect(
      problems(parse('npmjs_proxy', 'npm', UPSTREAM_DEFAULTS.npmjs.url, { token: 'x' })),
    ).toEqual(['config']);
    expect(
      JSON.stringify(parse('npmjs_proxy', 'npm', UPSTREAM_DEFAULTS.npmjs.url, { sekret_key_1: 1 })),
    ).not.toContain('sekret_key_1');
    expect(
      problems(
        parse('vcs', 'composer', null, { ...github, refs: { tags: true, branches: [], z: 1 } }),
      ),
    ).toEqual(['refs']);
  });

  it('reports composer_repository field problems', () => {
    const url = 'https://repo.example.com';
    expect(
      problems(parse('composer_repository', 'composer', url, { distHosts: ['https://x.com'] })),
    ).toEqual(['distHosts']);
    expect(
      problems(parse('composer_repository', 'composer', url, { distHosts: ['127.0.0.1'] })),
    ).toEqual(['distHosts']);
    expect(
      problems(parse('composer_repository', 'composer', url, { mirrorsFallback: 'no' })),
    ).toEqual(['mirrorsFallback']);
    expect(
      problems(
        parse('composer_repository', 'composer', url, {
          selection: { packages: ['bad'], patterns: [], expandPatterns: false },
        }),
      ),
    ).toEqual(['selection.packages']);
    expect(
      problems(
        parse('composer_repository', 'composer', url, {
          selection: { packages: [], patterns: [''], expandPatterns: false },
        }),
      ),
    ).toEqual(['selection.patterns']);
    expect(
      problems(
        parse('composer_repository', 'composer', url, {
          selection: { packages: [], patterns: [], expandPatterns: 1 },
        }),
      ),
    ).toEqual(['selection.expandPatterns']);
  });

  it('requires at least one well-formed npm scope', () => {
    const url = 'https://npm.example.com';
    expect(problems(parse('npm_registry', 'npm', url, {}))).toEqual(['scopes']);
    expect(problems(parse('npm_registry', 'npm', url, { scopes: [] }))).toEqual(['scopes']);
    expect(problems(parse('npm_registry', 'npm', url, { scopes: ['acme'] }))).toEqual(['scopes']);
  });

  it('bounds list and entry sizes', () => {
    const url = 'https://repo.example.com';
    const many = Array.from({ length: 65 }, (_, i) => `h${i}.example.com`);
    expect(problems(parse('composer_repository', 'composer', url, { distHosts: many }))).toEqual([
      'distHosts',
    ]);
    expect(
      problems(
        parse('composer_repository', 'composer', url, { distHosts: [`${'a'.repeat(201)}.com`] }),
      ),
    ).toEqual(['distHosts']);
    expect(
      problems(
        parse('vcs', 'composer', null, {
          ...github,
          refs: { tags: true, branches: ['b'.repeat(201)] },
        }),
      ),
    ).toEqual(['refs.branches']);
    expect(
      problems(
        parse('npm_registry', 'npm', 'https://npm.example.com', {
          scopes: Array.from({ length: 65 }, (_, i) => `@s${i}`),
        }),
      ),
    ).toEqual(['scopes']);
  });

  it('refuses hosted and malformed JSON', () => {
    expect(problems(parse('hosted', 'composer', null, {}))).toEqual(['type']);
    const opts = { runtime: 'node', policy, hasCredential: false } as const;
    const bad = parseSourceConfig('vcs', 'composer', null, '{nope', opts);
    expect(bad.ok).toBe(false);
    expect(problems(parseSourceConfig('vcs', 'composer', null, '[]', opts))).toEqual(['config']);
  });
});

describe('url rules', () => {
  const ok = { selection: undefined };
  it('refuses userinfo, http, fragment and scheme-relative urls', () => {
    for (const url of [
      'https://user:pw@repo.example.com',
      'https://user@repo.example.com',
      'https://@repo.example.com',
      'http://repo.example.com',
      'ftp://repo.example.com',
      '//repo.example.com',
      'https://repo.example.com/#frag',
      'repo.example.com',
      'https://',
    ]) {
      expect(problems(parse('composer_repository', 'composer', url, ok)), url).toEqual(['url']);
    }
  });

  it('refuses a query on every source url, credential-like or not', () => {
    for (const q of [
      'x=1',
      'token=1',
      'Access_Token=1',
      'auth=1',
      'key=1',
      'api.key=1',
      'ApiKey=1',
      'password=1',
      'secret=1',
      'x_token=1',
      'api key=1',
      'token[]=1',
      'a=1&token=2',
    ]) {
      expect(
        problems(parse('composer_repository', 'composer', `https://repo.example.com/p?${q}`, {})),
        q,
      ).toEqual(['url']);
    }
    expect(
      problems(parse('composer_repository', 'composer', 'https://repo.example.com/p?x=1', {})),
    ).toEqual(['url']);
    expect(
      problems(parse('npm_registry', 'npm', 'https://npm.example.com/?x=1', { scopes: ['@a'] })),
    ).toEqual(['url']);
  });

  it('requires a url for composer_repository and npm_registry, none for vcs', () => {
    expect(problems(parse('composer_repository', 'composer', null, {}))).toEqual(['url']);
    expect(problems(parse('npm_registry', 'npm', null, { scopes: ['@a'] }))).toEqual(['url']);
    expect(problems(parse('vcs', 'composer', 'https://x.example.com', github))).toEqual(['url']);
  });

  it('refuses git urls with userinfo, query or fragment', () => {
    for (const repository of [
      'https://u:p@git.example.com/a.git',
      'https://git.example.com/a.git?x=1',
      'https://git.example.com/a.git#x',
      'http://git.example.com/a.git',
    ]) {
      expect(
        problems(parse('vcs', 'composer', null, { provider: 'git', repository })),
        repository,
      ).toEqual(['repository']);
    }
  });

  it('refuses unsafe ssh repositories', () => {
    for (const repository of [
      'ssh://git@-oProxyCommand=x/repo',
      '-oProxyCommand=x@host:repo',
      'git@-host:repo',
      'ssh://git@host/repo;rm -rf',
      'ssh://git@host/$(id)',
      'ssh://git@host/`id`',
      'ssh://git@host/a b',
      'git@host:a|b',
      'GIT@host:repo',
      'ssh://git@host:99999/repo',
      'ssh://host/repo',
      'ssh://git:pw@host/repo',
      'ssh://git@host/repo#f',
    ]) {
      expect(
        problems(parse('vcs', 'composer', null, { provider: 'ssh', repository })),
        repository,
      ).toEqual(['repository']);
    }
  });

  it('refuses ssh on cloudflare', () => {
    const cfg = { provider: 'ssh', repository: 'git@host.example.com:repo.git' };
    expect(problems(parse('vcs', 'composer', null, cfg, { runtime: 'cloudflare' }))).toEqual([
      'provider',
    ]);
    expect(parse('vcs', 'composer', null, cfg, { runtime: 'node' }).ok).toBe(true);
  });
});

describe('proxies', () => {
  it('refuses non-default urls', () => {
    for (const url of [
      'https://mirror.example.com',
      'https://repo.packagist.org/',
      'http://repo.packagist.org',
      null,
    ]) {
      expect(problems(parse('packagist_proxy', 'composer', url, {})), String(url)).toEqual(['url']);
    }
    expect(problems(parse('npmjs_proxy', 'npm', 'https://registry.npmjs.org/x', {}))).toEqual([
      'url',
    ]);
    expect(problems(parse('npmjs_proxy', 'npm', UPSTREAM_DEFAULTS.packagist.url, {}))).toEqual([
      'url',
    ]);
  });

  it('refuses credentials other than the packagist github token flag', () => {
    expect(
      problems(
        parse('packagist_proxy', 'composer', UPSTREAM_DEFAULTS.packagist.url, {
          githubToken: 'abc',
        }),
      ),
    ).toEqual(['githubToken']);
    expect(
      problems(
        parse('packagist_proxy', 'composer', UPSTREAM_DEFAULTS.packagist.url, { password: 'x' }),
      ),
    ).toEqual(['config']);
    expect(
      problems(parse('npmjs_proxy', 'npm', UPSTREAM_DEFAULTS.npmjs.url, { githubToken: true })),
    ).toEqual(['config']);
  });
});

describe('round 2', () => {
  it('refuses unknown type and ecosystem', () => {
    expect(problems(parse('nope' as SourceType, 'composer', null, {}))).toEqual(['type']);
    expect(problems(parse('vcs', 'pypi' as 'npm', null, github))).toEqual(['ecosystem']);
  });

  it('refuses vcs for npm', () => {
    expect(problems(parse('vcs', 'npm', null, github))).toEqual(['ecosystem']);
  });

  it('classifies urls and dist hosts through the outbound policy', () => {
    for (const url of [
      'https://127.0.0.1/',
      'https://0x7f.1/',
      'https://0177.0.0.1/',
      'https://repo.example.com:8443/',
      'https://intranet/',
      'https://a.internal/',
    ]) {
      expect(problems(parse('composer_repository', 'composer', url, {})), url).toEqual(['url']);
    }
    for (const host of ['10.0.0.1', '0x7f.1', 'intranet', 'a.local']) {
      expect(
        problems(
          parse('composer_repository', 'composer', 'https://repo.example.com', {
            distHosts: [host],
          }),
        ),
        host,
      ).toEqual(['distHosts']);
    }
    expect(
      problems(
        parse('vcs', 'composer', null, { provider: 'git', repository: 'https://127.0.0.1/a.git' }),
      ),
    ).toEqual(['repository']);
    expect(problems(parse('npm_registry', 'npm', 'https://10.1.1.1', { scopes: ['@a'] }))).toEqual([
      'url',
    ]);
  });

  it('bounds the raw config length', () => {
    const big = JSON.stringify({ ...github, packageName: 'a/' + 'b'.repeat(66000) });
    const r = parseSourceConfig('vcs', 'composer', null, big, {
      runtime: 'node',
      policy,
      hasCredential: false,
    });
    expect(problems(r)).toEqual(['config']);
  });

  it('refuses dot repository names and ssh dot segments', () => {
    expect(
      problems(parse('vcs', 'composer', null, { provider: 'github', repository: 'acme/.' })),
    ).toEqual(['repository']);
    expect(
      problems(parse('vcs', 'composer', null, { provider: 'github', repository: 'acme/..' })),
    ).toEqual(['repository']);
    expect(
      problems(
        parse('vcs', 'composer', null, {
          provider: 'ssh',
          repository: 'git@host.example.com:a/../b',
        }),
      ),
    ).toEqual(['repository']);
    expect(
      problems(
        parse('vcs', 'composer', null, {
          provider: 'ssh',
          repository: 'ssh://git@host.example.com/../b',
        }),
      ),
    ).toEqual(['repository']);
  });

  it('applies the credential rule to proxies', () => {
    expect(
      problems(
        parse('npmjs_proxy', 'npm', UPSTREAM_DEFAULTS.npmjs.url, {}, { hasCredential: true }),
      ),
    ).toEqual(['credential']);
    expect(
      problems(
        parse(
          'packagist_proxy',
          'composer',
          UPSTREAM_DEFAULTS.packagist.url,
          {},
          { hasCredential: true },
        ),
      ),
    ).toEqual(['credential']);
    expect(
      parse(
        'packagist_proxy',
        'composer',
        UPSTREAM_DEFAULTS.packagist.url,
        { githubToken: true },
        { hasCredential: true },
      ).ok,
    ).toBe(true);
  });

  it('refuses whitespace, control characters, patterns and duplicates', () => {
    expect(
      problems(parse('composer_repository', 'composer', ' https://repo.example.com', {})),
    ).toEqual(['url']);
    expect(
      problems(parse('composer_repository', 'composer', 'https://repo.example.com/a b', {})),
    ).toEqual(['url']);
    expect(
      problems(
        parse('vcs', 'composer', null, {
          provider: 'git',
          repository: 'https://git.example.com/a\u0001',
        }),
      ),
    ).toEqual(['repository']);
    expect(
      problems(
        parse('composer_repository', 'composer', 'https://repo.example.com', {
          selection: { packages: [], patterns: ['UPPER/*'], expandPatterns: false },
        }),
      ),
    ).toEqual(['selection.patterns']);
    expect(
      problems(
        parse('composer_repository', 'composer', 'https://repo.example.com', {
          distHosts: ['a.example.com', 'a.example.com'],
        }),
      ),
    ).toEqual(['distHosts']);
    expect(
      problems(parse('npm_registry', 'npm', 'https://npm.example.com', { scopes: ['@a', '@a'] })),
    ).toEqual(['scopes']);
    expect(
      problems(
        parse('vcs', 'composer', null, {
          ...github,
          refs: { tags: true, branches: ['main', 'main'] },
        }),
      ),
    ).toEqual(['refs.branches']);
    expect(
      problems(
        parse('composer_repository', 'composer', 'https://repo.example.com', {
          selection: { packages: [], patterns: ['a/*', 'a/*'], expandPatterns: false },
        }),
      ),
    ).toEqual(['selection.patterns']);
  });
});

describe('ecosystem match', () => {
  it('refuses mismatched ecosystems', () => {
    expect(problems(parse('packagist_proxy', 'npm', UPSTREAM_DEFAULTS.packagist.url, {}))).toEqual([
      'ecosystem',
    ]);
    expect(problems(parse('npmjs_proxy', 'composer', UPSTREAM_DEFAULTS.npmjs.url, {}))).toEqual([
      'ecosystem',
    ]);
    expect(
      problems(parse('npm_registry', 'composer', 'https://npm.example.com', { scopes: ['@a'] })),
    ).toEqual(['ecosystem']);
    expect(problems(parse('composer_repository', 'npm', 'https://repo.example.com', {}))).toEqual([
      'ecosystem',
    ]);
  });
});

describe('checkRetentionOverride', () => {
  it('accepts null and values at or above the organization retention', () => {
    expect(checkRetentionOverride(null, 30)).toBe(true);
    expect(checkRetentionOverride(30, 30)).toBe(true);
    expect(checkRetentionOverride(31, 30)).toBe(true);
  });
  it('refuses shorter, fractional and negative windows', () => {
    expect(checkRetentionOverride(29, 30)).toBe(false);
    expect(checkRetentionOverride(30.5, 30)).toBe(false);
    expect(checkRetentionOverride(-1, 0)).toBe(false);
  });
});

describe('round 3', () => {
  const ssh = (repository: string, options = {}) =>
    parse('vcs', 'composer', null, { provider: 'ssh', repository }, options);

  it('classifies ssh hosts through the outbound policy', () => {
    for (const repo of [
      'git@127.0.0.1:repo',
      'ssh://git@169.254.169.254/repo',
      'ssh://git@localhost/repo',
      'git@intranet:repo',
      'ssh://git@[::1]/repo',
      'ssh://git@[2606:4700::1111/repo',
      'git@host-:repo',
      'git@host.:repo',
      'git@host.example.com:~/repo',
      'ssh://git@host.example.com/~root/repo',
    ]) {
      expect(problems(ssh(repo)), repo).toEqual(['repository']);
    }
    expect(ssh('git@Host.Example.com:repo').ok).toBe(true);
  });

  it('lets an allowlisted private ssh host pass', () => {
    const allow = createOutboundPolicy({
      allowPrivateHosts: ['git.corp.internal:22'],
      runtime: 'node',
      selfOrigins: [],
    });
    const r = parseSourceConfig(
      'vcs',
      'composer',
      null,
      JSON.stringify({ provider: 'ssh', repository: 'git@git.corp.internal:repo' }),
      { runtime: 'node', policy: allow, hasCredential: false },
    );
    expect(r.ok).toBe(true);
  });

  it('matches ssh ports against host:port allowlist entries', () => {
    const allow = createOutboundPolicy({
      allowPrivateHosts: ['git.corp.internal:2222'],
      runtime: 'node',
      selfOrigins: [],
    });
    const ssh = (repository: string) =>
      parseSourceConfig('vcs', 'composer', null, JSON.stringify({ provider: 'ssh', repository }), {
        runtime: 'node',
        policy: allow,
        hasCredential: false,
      });
    expect(ssh('ssh://git@git.corp.internal:2222/repo').ok).toBe(true);
    expect(ssh('ssh://git@git.corp.internal:22/repo').ok).toBe(false);
    expect(ssh('ssh://git@git.corp.internal/repo').ok).toBe(false);
    expect(ssh('git@git.corp.internal:repo').ok).toBe(false);
    const allow22 = createOutboundPolicy({
      allowPrivateHosts: ['git.corp.internal:22'],
      runtime: 'node',
      selfOrigins: [],
    });
    const r = parseSourceConfig(
      'vcs',
      'composer',
      null,
      JSON.stringify({ provider: 'ssh', repository: 'git@git.corp.internal:repo' }),
      { runtime: 'node', policy: allow22, hasCredential: false },
    );
    expect(r.ok).toBe(true);
  });

  it('allows http only for allowlisted hosts', () => {
    expect(
      problems(parse('composer_repository', 'composer', 'http://repo.example.com', {})),
    ).toEqual(['url']);
    const allow = createOutboundPolicy({
      allowPrivateHosts: ['repo.corp.internal:80'],
      runtime: 'node',
      selfOrigins: [],
    });
    const opts = { runtime: 'node', policy: allow, hasCredential: false } as const;
    expect(
      parseSourceConfig('composer_repository', 'composer', 'http://repo.corp.internal/', '{}', opts)
        .ok,
    ).toBe(true);
    expect(
      parseSourceConfig(
        'npm_registry',
        'npm',
        'http://repo.corp.internal/',
        '{"scopes":["@a"]}',
        opts,
      ).ok,
    ).toBe(true);
    expect(
      parseSourceConfig('composer_repository', 'composer', 'http://other.example.com/', '{}', opts)
        .ok,
    ).toBe(false);
  });

  it('stores composer names lowercase and dedupes on the key', () => {
    const sel = (packages: string[]) =>
      parse('composer_repository', 'composer', 'https://repo.example.com', {
        selection: { packages, patterns: [], expandPatterns: false },
      });
    const r = sel(['Acme/Foo']);
    expect(r.ok && r.config).toMatchObject({ selection: { packages: ['acme/foo'] } });
    expect(problems(sel(['Acme/Foo', 'acme/foo']))).toEqual(['selection.packages']);
    const v = parse('vcs', 'composer', null, { ...github, packageName: 'Acme/Widgets' });
    expect(v.ok && v.config).toMatchObject({ packageName: 'acme/widgets' });
  });

  it('refuses wildcard-only patterns', () => {
    for (const pattern of ['*', '*/*', '**']) {
      expect(
        problems(
          parse('composer_repository', 'composer', 'https://repo.example.com', {
            selection: { packages: [], patterns: [pattern], expandPatterns: false },
          }),
        ),
        pattern,
      ).toEqual(['selection.patterns']);
    }
  });

  it('requires githubToken true to come with a credential', () => {
    expect(
      problems(
        parse('packagist_proxy', 'composer', UPSTREAM_DEFAULTS.packagist.url, {
          githubToken: true,
        }),
      ),
    ).toEqual(['credential']);
  });

  it('accepts a config with every list at its boundaries', () => {
    const names = Array.from(
      { length: 64 },
      (_, i) => `v${String(i).padStart(2, '0')}/${'p'.repeat(193)}`,
    );
    const patterns = Array.from(
      { length: 64 },
      (_, i) => `v${String(i).padStart(2, '0')}/${'q'.repeat(190)}*`,
    );
    const hosts = Array.from(
      { length: 64 },
      (_, i) => `h${String(i).padStart(2, '0')}.${'a'.repeat(60)}.example.com`,
    );
    const config = { selection: { packages: names, patterns }, distHosts: hosts };
    const json = JSON.stringify(config);
    expect(json.length).toBeGreaterThan(16384);
    const r = parseSourceConfig(
      'composer_repository',
      'composer',
      'https://repo.example.com',
      json,
      {
        runtime: 'node',
        policy,
        hasCredential: false,
      },
    );
    expect(r.ok, JSON.stringify(!r.ok && r.problems)).toBe(true);
  });

  it('names the config limit in characters', () => {
    const r = parseSourceConfig('vcs', 'composer', null, 'x'.repeat(65537), {
      runtime: 'node',
      policy,
      hasCredential: false,
    });
    expect(!r.ok && r.problems[0]?.message).toContain('65536 characters');
  });
});

describe('round 2 additions', () => {
  const branches = (list: string[]) =>
    parse('vcs', 'composer', null, { ...github, refs: { tags: true, branches: list } });

  it('applies git ref-name rules to branches', () => {
    expect(branches(['feature/a+b', 'release-1.x', '*']).ok).toBe(true);
    for (const bad of [
      'a//b',
      'a.lock',
      'x/a.lock',
      'a.',
      'a..b',
      'a@{b',
      'a\u0007b',
      'a b',
      'a:b',
      '/a',
      'a/',
      '.a',
      '-a',
    ]) {
      expect(problems(branches([bad])), bad).toEqual(['refs.branches']);
    }
  });

  it('uses the canonical composer name grammar', () => {
    const sel = (packages: string[]) =>
      parse('composer_repository', 'composer', 'https://repo.example.com', {
        selection: { packages, patterns: [], expandPatterns: false },
      });
    expect(sel(['acme/foo-bar', 'acme/foo--bar']).ok).toBe(true);
    expect(problems(sel(['./foo']))).toEqual(['selection.packages']);
    expect(problems(sel(['acme/foo---bar']))).toEqual(['selection.packages']);
    expect(
      problems(parse('vcs', 'composer', null, { ...github, packageName: 'acme/foo---bar' })),
    ).toEqual(['packageName']);
  });

  it('accepts bracketed IPv6 ssh authorities', () => {
    const ssh = (repository: string) =>
      parse('vcs', 'composer', null, { provider: 'ssh', repository });
    expect(ssh('ssh://git@[2606:4700::1111]/repo').ok).toBe(true);
    expect(ssh('ssh://git@[2606:4700::1111]:2222/repo').ok).toBe(true);
    expect(problems(ssh('ssh://git@[zz]/repo'))).toEqual(['repository']);
    expect(problems(ssh('ssh://git@[2606:4700::1111]:0/repo'))).toEqual(['repository']);
  });

  it('normalises dist hosts to lowercase', () => {
    const r = parse('composer_repository', 'composer', 'https://repo.example.com', {
      distHosts: ['Dist.Example.COM'],
    });
    expect(r.ok && r.config).toMatchObject({ distHosts: ['dist.example.com'] });
    expect(
      problems(
        parse('composer_repository', 'composer', 'https://repo.example.com', {
          distHosts: ['A.example.com', 'a.example.com'],
        }),
      ),
    ).toEqual(['distHosts']);
  });
});
