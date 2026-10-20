import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalManifest,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_ITEMS,
  parseManifest,
  planHash,
} from '@package-broker/core/import/manifest';
import { DIAGNOSTIC_TEXT, planSatisImport, type PlanInput, type PlanResult } from './satis.js';

const GIT_URL = 'https://git.example.test/acme/lib.git';
const COMPOSER_URL = 'https://repo.example.test/';
const SENTINEL = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';

type Json = Record<string, unknown>;
const text = (value: unknown): string => JSON.stringify(value);
const gitMap = (url = GIT_URL, name = 'acme/lib', extra: Json = {}): Json => ({
  url,
  driver: 'git',
  package: name,
  ...extra,
});
const repoMap = (...repositories: Json[]): string => text({ version: 1, repositories });
const satisOf = (repositories: unknown[], extra: Json = {}): string =>
  text({ 'minimum-stability': 'dev', repositories, ...extra });

async function plan(input: Partial<PlanInput> & { satis: string }): Promise<PlanResult> {
  return planSatisImport(input);
}

async function okPlan(input: Partial<PlanInput> & { satis: string }) {
  const result = await plan(input);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}

const itemsOf = (result: Extract<PlanResult, { ok: true }>, type: string): Json[] =>
  (result.manifest.items as unknown as Json[]).filter((entry) => entry.type === type);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('supported repository types', () => {
  const vcsKinds: [string, string, string][] = [
    ['vcs', GIT_URL, GIT_URL],
    ['git', GIT_URL, GIT_URL],
    ['gitlab', GIT_URL, GIT_URL],
    ['bitbucket', GIT_URL, GIT_URL],
    ['github', 'https://github.com/Acme/Lib', 'https://github.com/acme/lib.git'],
    ['git', 'https://github.com/acme/lib.git/', 'https://github.com/acme/lib.git'],
  ];
  it.each(vcsKinds)(
    '%s %s maps to one Git source with its registered name',
    async (type, url, repository) => {
      const result = await okPlan({
        satis: satisOf([{ type, url }], { require: { 'acme/lib': '*' } }),
        repositoryMap: repoMap(gitMap(url)),
      });
      const [source] = itemsOf(result, 'source');
      expect(source).toMatchObject({
        ecosystem: 'composer',
        source_type: 'vcs',
        project: null,
        url: null,
        credential_ref: null,
        config: {
          provider: 'git',
          repository,
          installationId: null,
          packageName: 'acme/lib',
          refs: { tags: true, branches: ['*'] },
        },
      });
      expect(String(source?.name)).toMatch(/^satis-[0-9a-f]{58}$/);
      expect(String(source?.external_ref)).toMatch(/^satis:source:[0-9a-f]{64}$/);
      expect(itemsOf(result, 'name')).toEqual([
        expect.objectContaining({
          pattern: 'acme/lib',
          ecosystem: 'composer',
          source: { ref: source?.external_ref },
        }),
      ]);
      expect(itemsOf(result, 'attachment')).toEqual([]);
      expect(result.manifest).toMatchObject({ version: 1, source_system: 'satis', widening: [] });
    },
  );

  it('maps a sole Composer repository to a finite package and vendor selection', async () => {
    const result = await okPlan({
      satis: satisOf([{ type: 'composer', url: COMPOSER_URL }], {
        require: { 'Acme/Lib': '*', 'other/*': '*' },
      }),
    });
    const [source] = itemsOf(result, 'source');
    expect(source).toMatchObject({
      source_type: 'composer_repository',
      url: COMPOSER_URL,
      config: {
        selection: { packages: ['acme/lib'], patterns: ['other/*'], expandPatterns: false },
        distHosts: [],
        mirrorsFallback: false,
      },
    });
    expect(itemsOf(result, 'name').map((entry) => entry.pattern)).toEqual(['acme/lib', 'other/*']);
  });

  it('takes distribution hosts and package selection from the repository map', async () => {
    const result = await okPlan({
      satis: satisOf([{ type: 'composer', url: COMPOSER_URL }], { require: { 'acme/*': '*' } }),
      repositoryMap: repoMap({
        url: COMPOSER_URL,
        selection: { packages: [], patterns: ['acme/*'] },
        distHosts: ['downloads.example.test'],
      }),
    });
    expect(itemsOf(result, 'source')[0]?.config).toMatchObject({
      selection: { packages: [], patterns: ['acme/*'] },
      distHosts: ['downloads.example.test'],
    });
  });

  it('require-all selects every mapped Git repository', async () => {
    const other = 'https://git.example.test/acme/other.git';
    const result = await okPlan({
      satis: satisOf(
        [
          { type: 'git', url: GIT_URL },
          { type: 'git', url: other },
        ],
        {
          'require-all': true,
        },
      ),
      repositoryMap: repoMap(gitMap(), gitMap(other, 'acme/other')),
    });
    expect(itemsOf(result, 'source')).toHaveLength(2);
    expect(itemsOf(result, 'name').map((entry) => entry.pattern)).toEqual([
      'acme/lib',
      'acme/other',
    ]);
  });

  it('a vendor filter selects the finite set of mapped Git repositories it matches', async () => {
    const other = 'https://git.example.test/zed/other.git';
    const result = await okPlan({
      satis: satisOf(
        [
          { type: 'git', url: GIT_URL },
          { type: 'git', url: other },
        ],
        {
          require: { 'acme/*': '*' },
        },
      ),
      repositoryMap: repoMap(gitMap(), gitMap(other, 'zed/other')),
    });
    expect(itemsOf(result, 'name').map((entry) => entry.pattern)).toEqual(['acme/lib']);
    expect(result.summary.unselectedRepositories).toBe(1);
  });

  it('accepts the disabling packagist entry and creates no source for it', async () => {
    const result = await okPlan({
      satis: satisOf([{ 'packagist.org': false }, { type: 'git', url: GIT_URL }], {
        require: { 'acme/lib': '*' },
      }),
      repositoryMap: repoMap(gitMap()),
    });
    expect(itemsOf(result, 'source')).toHaveLength(1);
  });

  it('counts presentation keys without copying their values', async () => {
    const result = await okPlan({
      satis: satisOf([{ type: 'git', url: GIT_URL }], {
        require: { 'acme/lib': '*' },
        name: 'Presentation Sentinel',
        description: 'd',
        homepage: 'https://home.example.test',
        'output-html': true,
      }),
      repositoryMap: repoMap(gitMap()),
    });
    expect(result.summary.ignoredPresentationKeys).toBe(4);
    expect(result.canonical).not.toContain('Presentation Sentinel');
  });

  it('uses an explicit GitHub App configuration when the map supplies an installation', async () => {
    const result = await okPlan({
      satis: satisOf([{ type: 'github', url: 'https://github.com/Acme/Lib' }], {
        require: { 'acme/lib': '*' },
      }),
      repositoryMap: repoMap(
        gitMap('https://github.com/acme/lib', 'acme/lib', { github: { installationId: 7 } }),
      ),
      credentials: text({
        version: 1,
        repositories: [
          { url: 'https://github.com/acme/lib', kind: 'github_app', ref: 'env:GITHUB_APP' },
        ],
      }),
    });
    expect(itemsOf(result, 'source')[0]).toMatchObject({
      credential_ref: 'env:GITHUB_APP',
      config: { provider: 'github', repository: 'acme/lib', installationId: 7 },
    });
  });
});

describe('refusals', () => {
  const git = (type: string, url = GIT_URL) => ({ type, url });
  const withReq = (repositories: unknown[], extra: Json = {}) =>
    satisOf(repositories, { require: { 'acme/lib': '*' }, ...extra });

  const rows: [string, string, string | undefined, keyof typeof DIAGNOSTIC_TEXT, string][] = [
    [
      'vcs without a driver assertion',
      withReq([git('vcs')]),
      repoMap({ url: GIT_URL, package: 'acme/lib' }),
      'repository_driver_required',
      'Declare the Git driver and package name in the local repository map; remote probing is disabled.',
    ],
    [
      'git without a package name',
      withReq([git('git')]),
      undefined,
      'repository_package_required',
      'Declare the Composer package name for this repository in the local repository map.',
    ],
    [
      'github owner URL',
      withReq([git('github', 'https://github.com/acme')]),
      undefined,
      'unsupported_github_repository',
      'Use one concrete GitHub repository and supply its package mapping.',
    ],
    [
      'gitlab with a non-git driver',
      withReq([git('gitlab')]),
      repoMap({ url: GIT_URL, driver: 'svn', package: 'acme/lib' }),
      'unsupported_driver_options',
      'Only a concrete Git HTTPS repository is supported; remove API driver options.',
    ],
    [
      'bitbucket with a non-git driver',
      withReq([git('bitbucket')]),
      repoMap({ url: GIT_URL, driver: 'hg', package: 'acme/lib' }),
      'unsupported_driver_options',
      'Only a concrete Git HTTPS repository is supported; remove API driver options.',
    ],
    [
      'inline package',
      withReq([{ type: 'package', package: { name: 'acme/inline' } }]),
      undefined,
      'inline_package_unsupported',
      'Inline package definitions cannot be imported; publish them to a Composer repository first.',
    ],
    [
      'path repository',
      withReq([{ type: 'path', url: '../local' }]),
      undefined,
      'local_repository_unsupported',
      'Local path repositories cannot be imported; publish them to a reachable repository first.',
    ],
    [
      'artifact repository',
      withReq([{ type: 'artifact', url: 'archives' }]),
      undefined,
      'artifact_repository_unsupported',
      'Artifact directories cannot be imported; publish their packages to a Composer repository first.',
    ],
    [
      'ssh transport',
      withReq([git('git', 'ssh://git@git.example.test/acme/lib.git')]),
      undefined,
      'repository_transport_unsupported',
      'This importer supports HTTPS Git and Composer repositories only.',
    ],
    [
      'scp transport',
      withReq([git('git', 'git@git.example.test:acme/lib.git')]),
      undefined,
      'repository_transport_unsupported',
      'This importer supports HTTPS Git and Composer repositories only.',
    ],
    [
      'http transport',
      withReq([git('composer', 'http://repo.example.test/')]),
      undefined,
      'repository_transport_unsupported',
      'This importer supports HTTPS Git and Composer repositories only.',
    ],
    [
      'url userinfo',
      withReq([git('git', 'https://user:pw@git.example.test/acme/lib.git')]),
      undefined,
      'invalid_repository_url',
      'Use a canonical repository URL without credentials, query or fragment.',
    ],
    [
      'url query',
      withReq([git('git', `${GIT_URL}?token=x`)]),
      undefined,
      'invalid_repository_url',
      'Use a canonical repository URL without credentials, query or fragment.',
    ],
    [
      'composer without a selection',
      satisOf(
        [
          { type: 'composer', url: COMPOSER_URL },
          { type: 'composer', url: 'https://two.example.test/' },
        ],
        {
          require: { 'acme/lib': '*' },
        },
      ),
      undefined,
      'selection_required',
      'Provide explicit package names or supported vendor filters for this Composer repository.',
    ],
    [
      'require-all with a Composer repository',
      satisOf([{ type: 'composer', url: COMPOSER_URL }], { 'require-all': true }),
      undefined,
      'require_all_composer_unsupported',
      'Enumerate the Composer packages or vendor filters before planning; require-all cannot be expanded offline.',
    ],
    [
      'require-all with require',
      satisOf([git('git')], { 'require-all': true, require: { 'acme/lib': '*' } }),
      repoMap(gitMap()),
      'conflicting_selection',
      'Choose require-all or explicit require filters.',
    ],
    [
      'invalid require key',
      withReq([git('git')], { require: { '**': '*' } }),
      repoMap(gitMap()),
      'package_filter_unsupported',
      'Use a canonical package name or a single vendor/* filter.',
    ],
    [
      'require-dependencies',
      withReq([git('git')], { 'require-dependencies': true }),
      repoMap(gitMap()),
      'dependency_resolution_unsupported',
      'Dependency expansion requires a resolver and cannot be represented by this import plan.',
    ],
    [
      'require-dev-dependencies',
      withReq([git('git')], { 'require-dev-dependencies': true }),
      repoMap(gitMap()),
      'dev_dependency_resolution_unsupported',
      'Development dependency expansion is not supported by this import plan.',
    ],
    [
      'only-dependencies',
      withReq([git('git')], { 'only-dependencies': true }),
      repoMap(gitMap()),
      'only_dependencies_unsupported',
      'A dependencies-only selection requires dependency resolution and is not supported.',
    ],
    [
      'stable minimum-stability',
      withReq([git('git')], { 'minimum-stability': 'stable' }),
      repoMap(gitMap()),
      'stability_filter_unsupported',
      "Set minimum-stability to 'dev' in a reviewed package-only configuration; this plan cannot preserve a stability filter.",
    ],
    [
      'archive settings',
      withReq([git('git')], { archive: {} }),
      repoMap(gitMap()),
      'archive_policy_unsupported',
      'Satis archive settings are not transferable; remove them from a reviewed package-only configuration and configure Broker storage separately.',
    ],
    [
      'unknown repository field',
      withReq([{ type: 'git', url: GIT_URL, options: {} }]),
      repoMap(gitMap()),
      'invalid_satis_config',
      'Invalid or unsupported Satis configuration; see the field path.',
    ],
    [
      'unknown root key',
      withReq([git('git')], { config: {} }),
      repoMap(gitMap()),
      'invalid_satis_config',
      'Invalid or unsupported Satis configuration; see the field path.',
    ],
    [
      'empty selection',
      satisOf([git('git')]),
      repoMap(gitMap()),
      'empty_selection',
      'No packages are selected; no manifest was written.',
    ],
  ];

  it.each(rows)('%s', async (_name, satis, repositoryMap, code, expectedText) => {
    const result = await plan({ satis, ...(repositoryMap === undefined ? {} : { repositoryMap }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((entry) => entry.code)).toContain(code);
    expect(DIAGNOSTIC_TEXT[code]).toBe(expectedText);
  });

  it('absent minimum-stability is refused', async () => {
    const result = await plan({
      satis: text({ repositories: [git('git')], require: { 'acme/lib': '*' } }),
      repositoryMap: repoMap(gitMap()),
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
      'stability_filter_unsupported',
    );
  });

  it('reports every refused entry and still produces no manifest', async () => {
    const result = await plan({
      satis: withReq([
        { type: 'path', url: '../a' },
        { type: 'artifact', url: 'b' },
        { type: 'package', package: {} },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics.map((entry) => [entry.code, entry.pointer])).toEqual(
      [
        ['local_repository_unsupported', '/repositories/0'],
        ['artifact_repository_unsupported', '/repositories/1'],
        ['inline_package_unsupported', '/repositories/2'],
      ],
    );
  });

  it('diagnostics never echo input values, urls or unknown keys', async () => {
    const secretUrl = 'https://user:pw-sentinel@git.example.test/acme/lib.git';
    const result = await plan({
      satis: text({
        repositories: [{ type: 'git', url: secretUrl, 'key-sentinel': SENTINEL }],
        'root-sentinel': SENTINEL,
      }),
    });
    expect(result.ok).toBe(false);
    const dump = JSON.stringify(result);
    for (const value of ['pw-sentinel', 'key-sentinel', 'root-sentinel', SENTINEL, 'user:']) {
      expect(dump).not.toContain(value);
    }
  });

  it('malformed JSON and duplicate keys fail without a parser excerpt', async () => {
    for (const satis of [
      '{"repositories": [sentinel-text',
      '{"repositories":[],"repositories":[]}',
    ]) {
      const result = await plan({ satis });
      expect(result.ok).toBe(false);
      expect(result.ok ? [] : result.diagnostics.map((entry) => entry.code)).toEqual([
        'invalid_satis_config',
      ]);
      expect(JSON.stringify(result)).not.toContain('sentinel-text');
    }
  });

  it('refuses override mode because the manifest has no ownership marker', async () => {
    const result = await plan({
      satis: withReq([git('git')]),
      repositoryMap: repoMap(gitMap()),
      mode: 'override',
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toEqual([
      'override_mode_unsupported',
    ]);
  });
});

describe('version filters', () => {
  it('imports with a warning naming every constrained and blacklisted package', async () => {
    const result = await okPlan({
      satis: satisOf([{ type: 'composer', url: COMPOSER_URL }], {
        require: { 'acme/lib': '^1.0', 'acme/other': '*', 'vendor/*': '2.*' },
        blacklist: { 'acme/bad': '1.0.0' },
      }),
    });
    expect(result.warnings.map(({ code, package: name }) => [code, name])).toEqual([
      ['version_constraint_ignored', 'acme/lib'],
      ['version_constraint_ignored', 'vendor/*'],
      ['blacklist_ignored', 'acme/bad'],
    ]);
    expect(itemsOf(result, 'name').map((entry) => entry.pattern)).toEqual([
      'acme/lib',
      'acme/other',
      'vendor/*',
    ]);
  });
});

describe('determinism and core validation', () => {
  const two = 'https://git.example.test/acme/two.git';
  const input = {
    satis: satisOf(
      [
        { type: 'git', url: GIT_URL },
        { type: 'git', url: two },
      ],
      {
        require: { 'acme/lib': '*', 'acme/two': '*' },
      },
    ),
    repositoryMap: repoMap(gitMap(), gitMap(two, 'acme/two')),
    project: 'client-a',
  };

  it('writes a manifest that passes parseManifest and whose hash equals planHash', async () => {
    const result = await okPlan(input);
    const parsed = parseManifest(JSON.parse(result.canonical));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(canonicalManifest(parsed.data)).toBe(result.canonical);
    expect(result.hash).toBe(await planHash(parsed.data));
  });

  it('is byte-identical across runs and independent of repository order', async () => {
    const first = await okPlan(input);
    const second = await okPlan(input);
    const reordered = await okPlan({
      ...input,
      satis: satisOf(
        [
          { type: 'git', url: two },
          { type: 'git', url: GIT_URL },
        ],
        {
          require: { 'acme/two': '*', 'acme/lib': '*' },
        },
      ),
    });
    expect(second.canonical).toBe(first.canonical);
    expect(reordered.canonical).toBe(first.canonical);
    expect(reordered.hash).toBe(first.hash);
  });

  it('renames nothing when only the project choice changes', async () => {
    const withProject = await okPlan(input);
    const without = await okPlan({ satis: input.satis, repositoryMap: input.repositoryMap });
    const names = (result: typeof withProject) =>
      itemsOf(result, 'source').map((entry) => entry.name);
    expect(names(withProject)).toEqual(names(without));
  });

  it('turns a core refusal into a value-free diagnostic', async () => {
    const result = await plan({
      satis: satisOf([{ type: 'git', url: GIT_URL }], { require: { 'acme/lib': '*' } }),
      repositoryMap: repoMap(gitMap(GIT_URL, 'acme/lib', { project: 'Bad Slug' })),
    });
    expect(result.ok).toBe(false);
  });
});

describe('projects', () => {
  const satis = satisOf([{ type: 'git', url: GIT_URL }], { require: { 'acme/lib': '*' } });

  it('attaches each source to the default project with precedence 1000', async () => {
    const result = await okPlan({ satis, repositoryMap: repoMap(gitMap()), project: 'client-a' });
    const [source] = itemsOf(result, 'source');
    expect(itemsOf(result, 'attachment')).toEqual([
      expect.objectContaining({
        project: { existing: 'client-a' },
        source: { ref: source?.external_ref },
        precedence: 1000,
        external_ref: expect.stringMatching(/^satis:attachment:[0-9a-f]{64}$/) as unknown,
      }),
    ]);
    expect(itemsOf(result, 'project')).toEqual([]);
  });

  it('lets the repository map override the default project per repository', async () => {
    const result = await okPlan({
      satis,
      repositoryMap: repoMap(gitMap(GIT_URL, 'acme/lib', { project: 'client-b' })),
      project: 'client-a',
    });
    expect(itemsOf(result, 'attachment').map((entry) => entry.project)).toEqual([
      { existing: 'client-b' },
    ]);
  });

  it.each(['Client A', '', '-x'])('refuses the project slug %j', async (project) => {
    const result = await plan({ satis, repositoryMap: repoMap(gitMap()), project });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toEqual([
      'invalid_project',
    ]);
  });
});

describe('ownership', () => {
  const repos = [
    { type: 'composer', url: COMPOSER_URL },
    { type: 'composer', url: 'https://two.example.test/' },
  ];
  const selections = (a: Json, b: Json) =>
    repoMap(
      { url: COMPOSER_URL, selection: a },
      { url: 'https://two.example.test/', selection: b },
    );

  it('assigns each root selector to one explicitly mapped Composer owner', async () => {
    const result = await okPlan({
      satis: satisOf(repos, { require: { 'a/lib': '*', 'b/*': '*' } }),
      repositoryMap: selections(
        { packages: ['a/lib'], patterns: [] },
        { packages: [], patterns: ['b/*'] },
      ),
    });
    expect(itemsOf(result, 'source')).toHaveLength(2);
  });

  it('refuses a package claimed by two owners', async () => {
    const result = await plan({
      satis: satisOf(repos, { require: { 'a/lib': '*' } }),
      repositoryMap: selections(
        { packages: ['a/lib'], patterns: [] },
        { packages: ['a/lib'], patterns: [] },
      ),
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
      'ambiguous_package_owner',
    );
  });

  it('refuses a Git package inside a Composer-owned vendor filter', async () => {
    const result = await plan({
      satis: satisOf(
        [
          { type: 'composer', url: COMPOSER_URL },
          { type: 'git', url: GIT_URL },
        ],
        {
          require: { 'acme/*': '*' },
        },
      ),
      repositoryMap: repoMap(
        { url: COMPOSER_URL, selection: { packages: [], patterns: ['acme/*'] } },
        gitMap(),
      ),
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
      'ambiguous_package_owner',
    );
  });

  it('refuses selections that add packages or leave a filter uncovered', async () => {
    for (const [a, b] of [
      [
        { packages: ['a/lib', 'x/extra'], patterns: [] },
        { packages: [], patterns: ['b/*'] },
      ],
      [
        { packages: ['a/lib'], patterns: [] },
        { packages: [], patterns: [] },
      ],
    ] as [Json, Json][]) {
      const result = await plan({
        satis: satisOf(repos, { require: { 'a/lib': '*', 'b/*': '*' } }),
        repositoryMap: selections(a, b),
      });
      expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
        'selection_coverage',
      );
    }
  });

  it('refuses a root package with no configured owner', async () => {
    const result = await plan({
      satis: satisOf([{ type: 'git', url: GIT_URL }], {
        require: { 'acme/lib': '*', 'zzz/missing': '*' },
      }),
      repositoryMap: repoMap(gitMap()),
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
      'selection_coverage',
    );
  });

  it.each([
    [
      'an entry without a configured repository',
      repoMap(gitMap(), gitMap('https://x.example.test/a/b.git', 'a/b')),
    ],
    ['duplicate entries', repoMap(gitMap(), gitMap())],
    ['an unknown entry field', repoMap(gitMap(GIT_URL, 'acme/lib', { token: 'x' }))],
  ])('refuses a repository map with %s', async (_name, repositoryMap) => {
    const result = await plan({
      satis: satisOf([{ type: 'git', url: GIT_URL }], { require: { 'acme/lib': '*' } }),
      repositoryMap,
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
      'invalid_repository_map',
    );
  });

  it('refuses the same repository configured twice', async () => {
    const result = await plan({
      satis: satisOf(
        [
          { type: 'git', url: GIT_URL },
          { type: 'github', url: 'https://github.com/a/b' },
          { type: 'git', url: 'https://github.com/A/B.git' },
        ],
        {
          require: { 'a/b': '*' },
        },
      ),
      repositoryMap: repoMap(gitMap('https://github.com/a/b', 'a/b')),
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
      'duplicate_repository',
    );
  });
});

describe('credential references', () => {
  const base = {
    satis: satisOf([{ type: 'git', url: GIT_URL }], { require: { 'acme/lib': '*' } }),
    repositoryMap: repoMap(gitMap()),
  };
  const creds = (entry: Json) =>
    text({ version: 1, repositories: [{ url: GIT_URL, kind: 'http_basic', ...entry }] });

  it.each(['env:REGISTRY_TOKEN', 'file:/etc/pb/auth.json', 'file:/etc/pb/auth json'])(
    'copies the reference %s and nothing else',
    async (ref) => {
      const result = await okPlan({ ...base, credentials: creds({ ref }) });
      expect(itemsOf(result, 'source')[0]?.credential_ref).toBe(ref);
    },
  );

  it.each([
    ['a raw token', { ref: SENTINEL }],
    ['a token inside a file reference', { ref: `file:/secrets/${SENTINEL}` }],
    ['a retired scheme', { ref: ['op', '//vault/item/field'].join(':') }],
    ['a lowercase environment name', { ref: 'env:token' }],
    ['an inline password field', { ref: 'env:TOKEN', password: SENTINEL }],
    ['an inline token field', { ref: 'env:TOKEN', token: SENTINEL }],
    ['an unknown kind', { ref: 'env:TOKEN', kind: 'secret' }],
  ])('refuses %s without echoing it', async (_name, entry) => {
    const result = await plan({ ...base, credentials: creds(entry) });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics.map((item) => item.code)).toEqual([
      'invalid_credential_map',
    ]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain('vault');
  });

  it('refuses a binding for a repository that is not configured', async () => {
    const result = await plan({
      ...base,
      credentials: text({
        version: 1,
        repositories: [{ url: 'https://other.example.test/a/b.git', kind: 'bearer', ref: 'env:T' }],
      }),
    });
    expect(result.ok === false && result.diagnostics.map((item) => item.code)).toEqual([
      'invalid_credential_map',
    ]);
  });

  it('keeps credential-looking parts of satis.json out of the output', async () => {
    const result = await plan({
      satis: text({
        'minimum-stability': 'dev',
        repositories: [
          {
            type: 'git',
            url: GIT_URL,
            options: { http: { header: [`Authorization: token ${SENTINEL}`] } },
          },
        ],
        require: { 'acme/lib': '*' },
      }),
      repositoryMap: base.repositoryMap,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});

describe('baseline', () => {
  const two = 'https://git.example.test/acme/two.git';
  const nameOf = (url: string) => (url === GIT_URL ? 'acme/lib' : 'acme/two');
  const satis = (...urls: string[]) =>
    satisOf(
      urls.map((url) => ({ type: 'git', url })),
      {
        require: Object.fromEntries(urls.map((url) => [nameOf(url), '*'])),
      },
    );
  const mapOf = (...urls: string[]) => repoMap(...urls.map((url) => gitMap(url, nameOf(url))));
  const map = mapOf(GIT_URL);
  const both = mapOf(GIT_URL, two);

  async function baselineFor(project?: string): Promise<string> {
    const first = await okPlan({
      satis: satis(GIT_URL),
      repositoryMap: map,
      ...(project === undefined ? {} : { project }),
    });
    return first.canonical;
  }

  it('plans an empty delta when nothing changed', async () => {
    const baseline = await baselineFor('client-a');
    const result = await okPlan({
      satis: satis(GIT_URL),
      repositoryMap: map,
      project: 'client-a',
      baseline,
    });
    expect(result.manifest.items).toEqual([]);
    expect(result.summary.noChanges).toBe(true);
  });

  it('plans only the added source, with its name and attachment', async () => {
    const baseline = await baselineFor('client-a');
    const result = await okPlan({
      satis: satis(GIT_URL, two),
      repositoryMap: both,
      project: 'client-a',
      baseline,
    });
    expect(itemsOf(result, 'source')).toHaveLength(1);
    expect(itemsOf(result, 'name').map((entry) => entry.pattern)).toEqual(['acme/two']);
    expect(itemsOf(result, 'attachment')).toHaveLength(1);
  });

  it('attaches an unchanged imported source to a new project by natural key', async () => {
    const baseline = await baselineFor('client-a');
    const result = await okPlan({
      satis: satis(GIT_URL),
      repositoryMap: map,
      project: 'client-b',
      baseline,
    });
    expect(itemsOf(result, 'source')).toEqual([]);
    const [attachment] = itemsOf(result, 'attachment');
    expect(attachment).toMatchObject({
      project: { existing: 'client-b' },
      source: { existing: { project: null, name: expect.stringMatching(/^satis-/) as unknown } },
    });
  });

  it('refuses a change to an existing source', async () => {
    const baseline = await baselineFor();
    const result = await plan({
      satis: satis(GIT_URL),
      repositoryMap: map,
      credentials: text({
        version: 1,
        repositories: [{ url: GIT_URL, kind: 'http_basic', ref: 'env:NEW' }],
      }),
      baseline,
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
      'existing_source_change',
    );
  });

  it('refuses the removal of an imported repository', async () => {
    const baseline = await baselineFor();
    const result = await plan({ satis: satis(two), repositoryMap: mapOf(two), baseline });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
      'destructive_delta_unsupported',
    );
  });

  it('refuses a delta baseline whose sources are only referenced', async () => {
    const baseline = await baselineFor('client-a');
    const delta = await okPlan({
      satis: satis(GIT_URL),
      repositoryMap: map,
      project: 'client-b',
      baseline,
    });
    const result = await plan({
      satis: satis(GIT_URL),
      repositoryMap: map,
      baseline: delta.canonical,
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
      'incomplete_baseline',
    );
  });

  it('refuses a baseline from another source system or with other item types', async () => {
    for (const baseline of [
      text({ version: 1, source_system: 'other', items: [], widening: [] }),
      text({
        version: 1,
        source_system: 'satis',
        items: [{ type: 'project', external_ref: 'p', slug: 'p', name: 'P' }],
        widening: [],
      }),
      'not json',
    ]) {
      const result = await plan({ satis: satis(GIT_URL), repositoryMap: map, baseline });
      expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
        'invalid_baseline',
      );
    }
  });
});

describe('single-run caps', () => {
  function many(count: number) {
    const repositories: unknown[] = [];
    const entries: Json[] = [];
    for (let index = 0; index < count; index += 1) {
      const url = `https://git.example.test/vendor${index}/repo.git`;
      repositories.push({ type: 'git', url });
      entries.push(gitMap(url, `vendor${index}/repo`));
    }
    return {
      satis: satisOf(repositories, { 'require-all': true }),
      repositoryMap: repoMap(...entries),
    };
  }

  it('names MAX_MANIFEST_ITEMS above the item cap', async () => {
    const result = await plan(many(MAX_MANIFEST_ITEMS / 2 + 1));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics.map((entry) => [entry.code, entry.cap])).toEqual([
      ['single_run_limit_exceeded', 'MAX_MANIFEST_ITEMS'],
    ]);
  });

  it('names MAX_MANIFEST_BYTES above the byte cap', async () => {
    const result = await plan({ ...many(1500), project: 'client-a' });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics.map((entry) => [entry.code, entry.cap])).toEqual([
      ['single_run_limit_exceeded', 'MAX_MANIFEST_BYTES'],
    ]);
    expect(MAX_MANIFEST_BYTES).toBe(1048576);
  });

  it('accepts a plan just under both caps', async () => {
    const result = await okPlan(many(100));
    expect(Buffer.byteLength(result.canonical)).toBeLessThanOrEqual(MAX_MANIFEST_BYTES);
  });

  it('names the source config list limit for a selection over 64 entries', async () => {
    const names = Array.from({ length: 65 }, (_value, index) => `acme/p${index}`);
    const result = await plan({
      satis: satisOf([{ type: 'composer', url: COMPOSER_URL }], {
        require: Object.fromEntries(names.map((name) => [name, '*'])),
      }),
    });
    expect(result.ok ? [] : result.diagnostics.map((entry) => [entry.code, entry.cap])).toEqual([
      ['single_run_limit_exceeded', 'SOURCE_CONFIG_LIST_LIMIT'],
    ]);
  });
});

describe('offline', () => {
  it('makes no network request', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network access attempted');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await okPlan({
      satis: satisOf(
        [
          { type: 'git', url: GIT_URL },
          { type: 'composer', url: COMPOSER_URL },
        ],
        {
          require: { 'acme/lib': '*', 'other/*': '*' },
        },
      ),
      repositoryMap: repoMap(gitMap()),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('round 2 refusals', () => {
  const composer = [{ type: 'composer', url: COMPOSER_URL }];
  const capsOf = (result: PlanResult) =>
    result.ok ? [] : result.diagnostics.map((entry) => [entry.code, entry.file, entry.cap]);

  it.each([
    [
      'more than 64 distribution hosts',
      Array.from({ length: 65 }, (_v, i) => `h${i}.example.test`),
      'SOURCE_CONFIG_LIST_LIMIT',
    ],
    [
      'a distribution host over 200 characters',
      [`${'a'.repeat(201)}.example.test`],
      'SOURCE_CONFIG_ENTRY_LENGTH_LIMIT',
    ],
  ])('names the cap for %s in the repository map', async (_name, distHosts, cap) => {
    const result = await plan({
      satis: satisOf(composer, { require: { 'acme/lib': '*' } }),
      repositoryMap: repoMap({ url: COMPOSER_URL, distHosts }),
    });
    expect(capsOf(result)).toEqual([['single_run_limit_exceeded', 'repository-map', cap]]);
  });

  it('names the cap for an over-long selection entry in the repository map', async () => {
    const result = await plan({
      satis: satisOf(composer, { require: { 'acme/lib': '*' } }),
      repositoryMap: repoMap({
        url: COMPOSER_URL,
        selection: { packages: [`a/${'b'.repeat(200)}`] },
      }),
    });
    expect(capsOf(result)).toEqual([
      ['single_run_limit_exceeded', 'repository-map', 'SOURCE_CONFIG_ENTRY_LENGTH_LIMIT'],
    ]);
  });

  it('names MAX_PATTERN_BYTES for a registered name over 50 bytes', async () => {
    const result = await plan({
      satis: satisOf(composer, { require: { [`acme/${'a'.repeat(60)}`]: '*' } }),
    });
    expect(capsOf(result)).toEqual([['single_run_limit_exceeded', 'satis', 'MAX_PATTERN_BYTES']]);
  });

  it('refuses a GitHub repository whose name starts with a dot', async () => {
    const result = await plan({
      satis: satisOf([{ type: 'github', url: 'https://github.com/acme/.git' }], {
        require: { 'acme/lib': '*' },
      }),
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toContain(
      'unsupported_github_repository',
    );
  });

  const refs: [string, string][] = [
    ['an AWS-style environment name', 'env:AKIAIOSFODNN7EXAMPLE'],
    ['a temporary AWS-style environment name', 'env:ASIAIOSFODNN7EXAMPLE'],
    ['a GitHub PAT-style environment name', 'env:GHP_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    ['a GitHub fine-grained environment name', 'env:GITHUB_PAT_0123456789ABCDEF'],
    ['a Slack-style environment name', 'env:XOXB_0123456789'],
    ['a GitLab-style environment name', 'env:GLPAT_0123456789ABCDEF'],
    ['a relative file path', 'file:./auth.json'],
    ['a bare file value', 'file:hunter2'],
    ['a file path with a parent segment', 'file:/etc/pb/../auth.json'],
    ['a Windows path with a parent segment', 'file:C:\\pb\\..\\auth.json'],
  ];
  it.each(refs)('refuses %s without echoing it', async (_name, ref) => {
    const result = await plan({
      satis: satisOf([{ type: 'git', url: GIT_URL }], { require: { 'acme/lib': '*' } }),
      repositoryMap: repoMap(gitMap()),
      credentials: text({ version: 1, repositories: [{ url: GIT_URL, kind: 'bearer', ref }] }),
    });
    expect(result.ok === false && result.diagnostics.map((entry) => entry.code)).toEqual([
      'invalid_credential_map',
    ]);
    expect(JSON.stringify(result)).not.toContain(ref.slice(4));
  });

  it('accepts absolute POSIX and Windows file references', async () => {
    for (const ref of ['file:/run/secrets/token', 'file:C:\\pb\\token']) {
      const result = await okPlan({
        satis: satisOf([{ type: 'git', url: GIT_URL }], { require: { 'acme/lib': '*' } }),
        repositoryMap: repoMap(gitMap()),
        credentials: text({ version: 1, repositories: [{ url: GIT_URL, kind: 'bearer', ref }] }),
      });
      expect(itemsOf(result, 'source')[0]?.credential_ref).toBe(ref);
    }
  });
});
