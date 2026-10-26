import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { admitProxy, type VisibilityConfig } from '@package-broker/core/catalogue/visibility';
import { canonicalManifest, parseManifest, planHash } from '@package-broker/core/import/manifest';
import { isSelected } from '@package-broker/core/ingest/composer/v1-index';
import { credentialBindings } from '../../commands/import.js';
import { canonical, type PackagistSnapshot } from './snapshot.js';
import {
  planPrivatePackagistImport,
  type PrivatePackagistPlanInput,
  type PrivatePackagistPlanResult,
} from './plan.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

type Row = Record<string, unknown>;
type Rows = Record<string, Row[]>;
const fixture = JSON.parse(
  await readFile(
    new URL('../fixtures/private-packagist/plan-snapshot.json', import.meta.url),
    'utf8',
  ),
) as PackagistSnapshot;
const snapshot = (rows: Rows): unknown => ({
  ...fixture,
  objects: Object.fromEntries(
    Object.entries(rows).map(([k, entries]) => [
      k,
      entries.map((data) => ({
        data,
        sha256: createHash('sha256').update(canonical(data)).digest('hex'),
      })),
    ]),
  ),
});
const base = (): Rows =>
  Object.fromEntries(
    Object.entries(fixture.objects).map(([k, entries]) => [
      k,
      entries.map((e) => structuredClone(e.data)),
    ]),
  );
const minimal = (): Rows => ({
  suborganizations: [{ id: 1, name: 'Acme', urlName: 'acme' }],
  packages: [],
  suborganizationPackages: [],
});
const vcs = (
  id = 10,
  name = 'acme/private',
  url = 'https://git.example.test/acme/private',
): Row => ({ id, name, origin: 'private', config: { type: 'vcs', url } });
const mirror = (id = 20, url = 'https://composer.example.test/'): Row => ({
  id,
  name: 'Example mirror',
  url,
  mirroringBehavior: 'manual',
  credentials: 40,
});
const mirrored = (id: number, name: string, mirrorId = 20): Row => ({
  id,
  name,
  origin: 'private-mirror',
  config: { mirroredRepositoryId: mirrorId },
});
const defaults = { version: 1, mirrorOrder: [20, 21] };
async function plan(
  rows = base(),
  map: unknown = defaults,
  rest: Partial<PrivatePackagistPlanInput> = {},
) {
  return planPrivatePackagistImport({ snapshot: snapshot(rows), map, ...rest });
}
async function success(result: PrivatePackagistPlanResult) {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Expected plan');
  expect(parseManifest(JSON.parse(result.canonical)).ok).toBe(true);
  expect(result.canonical).toBe(canonicalManifest(result.manifest));
  expect(result.hash).toBe(await planHash(result.manifest));
  return result;
}
async function refused(result: PrivatePackagistPlanResult, code: string, cap?: string) {
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code, ...(cap ? { cap } : {}) }),
  );
}

it('maps the extended T1021a snapshot without network or credential resolution', async () => {
  const fetch = vi.fn(() => {
    throw new Error('Offline');
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const result = await success(await plan());
    expect(fetch).not.toHaveBeenCalled();
    expect(result.manifest.items.map((i) => i.type)).toEqual(
      expect.arrayContaining(['source', 'project', 'name', 'attachment']),
    );
    expect(result.summary.needsInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'needs-upload', count: 1, detail: 'example-1.0.zip' }),
      ]),
    );
    expect(result.summary.unsupported).toEqual([
      { code: 'customers', count: 1 },
      { code: 'vendorBundles', count: 1 },
    ]);
    expect(result.summary.warning).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'report_only_synchronizations' }),
        expect.objectContaining({ code: 'report_only_tokens' }),
      ]),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
it.each([
  ['default slug', {}, 'acme', false],
  ['slug override', { projects: { acme: { slug: 'mapped' } } }, 'mapped', false],
  ['existing project', { projects: { acme: { existing: 'retained' } } }, 'retained', true],
] as const)('maps projects: %s', async (_, part, slug, existing) => {
  const rows = minimal();
  rows.suborganizationPackages = [{ ...vcs(), suborganizationId: 1 }];
  const result = await success(await plan(rows, { version: 1, ...part }));
  const item = result.manifest.items.find((i) => i.type === 'project');
  if (existing) expect(item).toBeUndefined();
  else expect(item).toMatchObject({ slug });
  const a = result.manifest.items.find((i) => i.type === 'attachment');
  expect(a).toMatchObject({ project: existing ? { existing: slug } : { ref: item!.external_ref } });
});
it.each([
  [
    'github app',
    'https://github.com/Acme/Repo.git',
    { github: { installations: { acme: 42 } } },
    { provider: 'github', repository: 'acme/repo', installationId: 42 },
  ],
  [
    'github HTTPS',
    'https://github.com/Acme/Repo.git',
    {},
    { provider: 'git', repository: 'https://github.com/acme/repo', installationId: null },
  ],
  [
    'other HTTPS',
    'https://git.example.test/acme/repo',
    {},
    { provider: 'git', repository: 'https://git.example.test/acme/repo', installationId: null },
  ],
  [
    'SSH',
    'git@git.example.test:acme/repo',
    {},
    { provider: 'ssh', repository: 'ssh://git@git.example.test/acme/repo', installationId: null },
  ],
] as const)('maps VCS %s', async (_, url, part, config) => {
  const rows = minimal();
  rows.packages = [vcs(10, 'acme/private', url)];
  const result = await success(
    await plan(rows, { version: 1, ...part }, { options: { runtime: 'node' } }),
  );
  expect(result.manifest.items.find((i) => i.type === 'source')).toMatchObject({
    source_type: 'vcs',
    project: null,
    url: null,
    config: { ...config, packageName: 'acme/private', refs: { tags: true, branches: ['*'] } },
  });
});
it('gives two packages in a monorepo distinct sources and stable identities', async () => {
  const rows = minimal();
  rows.suborganizationPackages = [
    { ...vcs(10, 'acme/one'), suborganizationId: 1 },
    { ...vcs(11, 'acme/two'), suborganizationId: 1 },
  ];
  const result = await success(await plan(rows, { version: 1 }));
  const sources = result.manifest.items.filter((i) => i.type === 'source');
  expect(sources).toHaveLength(2);
  expect(new Set(sources.map((s) => s.external_ref)).size).toBe(2);
  for (const s of sources) {
    const packageName = (s.config as { packageName: string }).packageName;
    const digest = createHash('sha256')
      .update(
        JSON.stringify(['pp-source-v1', ['https://git.example.test/acme/private', packageName]]),
      )
      .digest('hex');
    expect(s.external_ref).toBe(`pp:source:${digest}`);
    expect(s.name).toBe(`pp-${digest.slice(0, 61)}`);
  }
});

it.each([
  'git@github.com:Acme/Repo.git',
  'ssh://git@github.com/Acme/Repo.git/',
  'ssh://git@GitHub.com/Acme/Repo.git',
])(
  'uses the canonical GitHub identity for mapped SSH repository %# on both runtimes',
  async (url) => {
    const map = { version: 1, github: { installations: { acme: 42 } } };
    const expected = await success(
      await plan(
        { ...minimal(), packages: [vcs(10, 'acme/private', 'https://github.com/acme/repo')] },
        map,
      ),
    );
    for (const runtime of ['workers', 'node'] as const) {
      const result = await success(
        await plan({ ...minimal(), packages: [vcs(10, 'acme/private', url)] }, map, {
          options: { runtime },
        }),
      );
      expect(result.canonical).toBe(expected.canonical);
      expect(result.hash).toBe(expected.hash);
      expect(result.manifest.items.find((item) => item.type === 'source')?.config).toMatchObject({
        provider: 'github',
        repository: 'acme/repo',
        installationId: 42,
      });
    }
  },
);

it.each(['git@github.com:Acme/Repo.git', 'ssh://git@github.com/Acme/Repo.git/'])(
  'keeps unmapped GitHub SSH repositories on Node %#',
  async (url) => {
    const rows = { ...minimal(), packages: [vcs(10, 'acme/private', url)] };
    const result = await success(
      await plan(rows, { version: 1 }, { options: { runtime: 'node' } }),
    );
    expect(result.manifest.items.find((item) => item.type === 'source')?.config).toMatchObject({
      provider: 'ssh',
      repository: 'ssh://git@github.com/acme/repo',
      installationId: null,
    });
    const refused = await plan(rows, { version: 1 }, { options: { runtime: 'workers' } });
    expect(refused.diagnostics).toEqual([{ code: 'ssh_requires_node', pointer: '/packages/0' }]);
  },
);

it.each([
  'ssh://',
  'ssh://git@[invalid/repo',
  'ssh://git@example.test:invalid/repo',
  'ssh://example.test/repo',
  'ssh://git:secret@example.test/repo',
  'ssh://git@example.test/repo?token=secret',
  'ssh://git@example.test/repo#secret',
  'ssh://git@example.test/repo\u0000',
  'ssh://git@example.test/repo\u200B',
])('refuses malformed SSH URLs with a package pointer before the runtime gate %#', async (url) => {
  for (const runtime of ['node', 'workers'] as const) {
    const result = await plan(
      { ...minimal(), packages: [vcs(10, 'acme/private', url)] },
      { version: 1 },
      { options: { runtime } },
    );
    expect(result.diagnostics).toEqual([
      { code: 'invalid_repository_url', pointer: '/packages/0' },
    ]);
  }
});

it.each([
  ['vcs', 'https://user:secret@git.example.test/repo', 'invalid_repository_url'],
  ['vcs', 'git@git.example.test:acme/repo', 'ssh_requires_node'],
  ['mirror', 'https://user:secret@composer.example.test/', 'invalid_repository_url'],
  ['mirror', 'ssh://git@composer.example.test/repo', 'ssh_requires_node'],
] as const)('keeps package pointers for %s URL refusals %#', async (kind, url, code) => {
  const rows = minimal();
  rows.packages = [kind === 'vcs' ? vcs(10, 'acme/private', url) : mirrored(10, 'acme/private')];
  rows.mirroredRepositories = [mirror(20, url)];
  const result = await plan(rows, defaults);
  expect(result.diagnostics).toEqual([{ code, pointer: '/packages/0' }]);
});

it.each(['manual', 'disabled'])(
  'retains organization mirror behavior %s across scoped rows and shuffles',
  async (mirroringBehavior) => {
    const rows = minimal();
    rows.suborganizations!.push({ id: 2, name: 'Example', urlName: 'example' });
    rows.mirroredRepositories = [{ ...mirror(), mirroringBehavior }];
    rows.suborganizationMirroredRepositories = [
      { ...mirror(), mirroringBehavior: 'add_on_use', suborganizationId: 1 },
      { ...mirror(), mirroringBehavior: 'admin_managed', suborganizationId: 2 },
    ];
    const result = await success(await plan(rows));
    expect(result.summary.warning).toContainEqual({
      code: mirroringBehavior === 'disabled' ? 'disabled_mirror_skipped' : 'mirroring_behavior',
      pointer: '/mirrors/0',
      detail: mirroringBehavior,
      count: 0,
    });
    rows.suborganizationMirroredRepositories.reverse();
    const shuffled = await success(await plan(rows));
    expect(shuffled.summary).toEqual(result.summary);
    expect(shuffled.canonical).toBe(result.canonical);
  },
);

it.each([
  'suborganizationPackages',
  'suborganizationTeams',
  'suborganizationMirroredRepositories',
  'suborganizationTokens',
])('validates project membership for every %s row', async (kind) => {
  const row =
    kind === 'suborganizationPackages'
      ? vcs()
      : kind === 'suborganizationTeams'
        ? { id: 30, name: 'Acme', permission: 'view' }
        : kind === 'suborganizationMirroredRepositories'
          ? mirror()
          : { id: 50 };
  for (const suborganizationId of [999, undefined, '1']) {
    const rows = { ...minimal(), [kind]: [{ ...row, suborganizationId }] };
    const result = await plan(rows);
    expect(result.diagnostics).toEqual([
      { code: 'invalid_snapshot', pointer: `/objects/${kind}/0` },
    ]);
  }
});

it.each(['missing-comma', '"unterminated,email@example.test', 'user,email@example.test,extra'])(
  'reports the CSV data row for malformed fields %#',
  async (line) => {
    const result = await plan(
      minimal(),
      { version: 1 },
      { members: `username,email\nfirst,first@example.test\n${line}\r\n` },
    );
    expect(result.diagnostics).toEqual([{ code: 'invalid_members', pointer: '/members/1' }]);
  },
);

it.each([
  [' username,email\nuser,user@example.test', '/members'],
  ['username,email\nuser,"user@example.test" ', '/members/0'],
])('preserves unquoted outer CSV whitespace %#', async (members, pointer) => {
  const result = await plan(minimal(), { version: 1 }, { members });
  expect(result.diagnostics).toEqual([{ code: 'invalid_members', pointer }]);
});

it.each(['\n', '\r\n'])('accepts BOM and trailing CSV line endings %#', async (ending) => {
  await success(
    await plan(
      minimal(),
      { version: 1 },
      { members: `\uFEFFusername,email${ending}user,user@example.test${ending}${ending}` },
    ),
  );
});
it.each(['gitlab.com', 'bitbucket.org', 'git.example.test'])(
  'normalizes HTTPS VCS suffixes on %s without changing mirror URLs',
  async (host) => {
    const url = `https://${host}/Acme/Repo`;
    const expected = await success(
      await plan({ ...minimal(), packages: [vcs(10, 'acme/one', url)] }),
    );
    for (const suffix of ['.git', '/', '.git/']) {
      const result = await success(
        await plan({ ...minimal(), packages: [vcs(10, 'acme/one', `${url}${suffix}`)] }),
      );
      expect(result.canonical).toBe(expected.canonical);
      expect(result.hash).toBe(expected.hash);
    }
    const rows = mirrorRows(['acme/one']);
    rows.mirroredRepositories = [mirror(20, `${url}.git/`)];
    const result = await success(await plan(rows));
    expect(result.manifest.items.find((item) => item.type === 'source')?.url).toBe(`${url}.git/`);
  },
);
it.each([undefined, 'existing:public'])('maps the public proxy %#', async (packagist) => {
  const rows = minimal();
  rows.suborganizationPackages = [
    { id: 10, name: 'acme/public', origin: 'public-mirror', config: {}, suborganizationId: 1 },
  ];
  const result = await success(
    await plan(rows, { version: 1 }, { options: packagist ? { packagist } : {} }),
  );
  expect(result.summary.warning).toContainEqual(
    expect.objectContaining({ code: 'public_proxy_exposure' }),
  );
  if (packagist)
    expect(result.manifest.items.find((i) => i.type === 'attachment')).toMatchObject({
      source: { existing: { project: null, name: 'public' } },
    });
  else
    expect(result.manifest.items.find((i) => i.type === 'source')).toMatchObject({
      source_type: 'packagist_proxy',
      url: 'https://repo.packagist.org',
      credential_ref: null,
      config: { githubToken: false },
    });
  expect(result.manifest.items.filter((i) => i.type === 'name')).toHaveLength(0);
});
function mirrorRows(names: string[], other: string[] = []): Rows {
  return {
    ...minimal(),
    mirroredRepositories: [mirror(), mirror(21, 'https://mirror.example.test/')],
    packages: [
      ...names.map((n, i) => mirrored(i + 100, n)),
      ...other.map((n, i) => mirrored(i + 1000, n, 21)),
    ],
  };
}
it('unions organization and suborganization mirror lists and uses mapped dist hosts', async () => {
  const rows = mirrorRows(['acme/one']);
  rows.suborganizationPackages = [{ ...mirrored(2, 'acme/two'), suborganizationId: 1 }];
  const result = await success(
    await plan(
      rows,
      { ...defaults, distHosts: { 20: ['dist.example.test'] } },
      { options: { acceptProjectWidening: ['acme'] } },
    ),
  );
  expect(result.manifest.items.find((i) => i.type === 'source')).toMatchObject({
    config: {
      selection: { packages: ['acme/one', 'acme/two'], patterns: [], expandPatterns: false },
      distHosts: ['dist.example.test'],
      mirrorsFallback: false,
    },
  });
});
it('keeps 64 exact selections; refuses 65 without compaction', async () => {
  await success(await plan(mirrorRows(Array.from({ length: 64 }, (_, i) => `acme/p${i}`))));
  await refused(
    await plan(mirrorRows(Array.from({ length: 65 }, (_, i) => `acme/p${i}`))),
    'single_run_limit_exceeded',
    'SOURCE_CONFIG_LIST_LIMIT',
  );
});
it.each([undefined, [], ['unrelated']])(
  'requires vendor opt-in even when the snapshot has no public packages (%j)',
  async (compactVendors) => {
    const rows = mirrorRows(Array.from({ length: 65 }, (_, i) => `unseen/p${i}`));
    const result = await plan(rows, defaults, {
      options: {
        compactSelection: true,
        ...(compactVendors === undefined ? {} : { compactVendors }),
        acceptProjectWidening: ['acme'],
      },
    });
    await refused(result, 'single_run_limit_exceeded', 'SOURCE_CONFIG_LIST_LIMIT');
    expect(result.diagnostics[0]?.detail).toBe(
      'Vendors requiring --compact-vendor opt-in: unseen. See owner question A (project_package).',
    );
    expect(result.summary.warning.filter((e) => e.code === 'selection_compacted')).toEqual([]);
  },
);
it('compacts only named vendors and warns about unseen and future public packages', async () => {
  const rows = mirrorRows([
    ...Array.from({ length: 40 }, (_, i) => `unapproved/p${i}`),
    ...Array.from({ length: 25 }, (_, i) => `approved/p${i}`),
  ]);
  const result = await success(
    await plan(rows, defaults, {
      options: { compactSelection: true, compactVendors: ['approved'] },
    }),
  );
  expect(result.summary.warning.filter((e) => e.code === 'selection_compacted')).toEqual([
    expect.objectContaining({
      pattern: 'approved/*',
      detail: expect.stringContaining('unused or future public packages'),
    }),
  ]);
  expect(result.summary.warning.find((e) => e.code === 'selection_compacted')?.detail).toContain(
    'prevent proxy fallback',
  );
  const source = result.manifest.items.find(
    (i) => i.type === 'source' && i.source_type === 'composer_repository',
  );
  expect(source).toMatchObject({
    config: {
      selection: {
        patterns: ['approved/*'],
        packages: Array.from({ length: 40 }, (_, i) => `unapproved/p${i}`).sort(),
      },
    },
  });
});
it('rejects malformed vendor opt-ins without echoing the value', async () => {
  const result = await plan(
    minimal(),
    { version: 1 },
    {
      options: { compactSelection: true, compactVendors: ['secret@example.test'] },
    },
  );
  expect(result.diagnostics).toEqual([
    { code: 'invalid_compact_vendor', pointer: '/options/compactVendors/0' },
  ]);
});
it('compacts largest vendors first and uses code-unit vendor order for ties', async () => {
  for (const names of [
    [
      ...Array.from({ length: 33 }, (_, i) => `example/p${i}`),
      ...Array.from({ length: 32 }, (_, i) => `acme/p${i}`),
    ],
    [
      ...Array.from({ length: 32 }, (_, i) => `example/p${i}`),
      ...Array.from({ length: 32 }, (_, i) => `acme/p${i}`),
      'other/one',
    ],
  ]) {
    const result = await success(
      await plan(mirrorRows(names), defaults, {
        options: {
          compactSelection: true,
          compactVendors: ['acme', 'example'],
        },
      }),
    );
    const expected =
      names.filter((n) => n.startsWith('example/')).length === 33 ? 'example/*' : 'acme/*';
    expect(
      result.summary.warning.filter((e) => e.code === 'selection_compacted').map((e) => e.pattern),
    ).toEqual([expected]);
    expect(
      result.manifest.items
        .filter((i) => i.type === 'name')
        .map((i) => i.pattern)
        .sort(),
    ).toEqual([...names].sort());
  }
});
it('never compacts a vendor shared with any other planned source', async () => {
  const names = [
    ...Array.from({ length: 40 }, (_, i) => `acme/p${i}`),
    ...Array.from({ length: 25 }, (_, i) => `example/p${i}`),
  ];
  const result = await success(
    await plan(mirrorRows(names, ['acme/foreign']), defaults, {
      options: {
        compactSelection: true,
        compactVendors: ['acme', 'example'],
      },
    }),
  );
  expect(
    result.summary.warning.filter((e) => e.code === 'selection_compacted').map((e) => e.pattern),
  ).toEqual(['example/*']);
  await refused(
    await plan(
      mirrorRows(
        Array.from({ length: 65 }, (_, i) => `acme/p${i}`),
        ['acme/foreign'],
      ),
      defaults,
      {
        options: {
          compactSelection: true,
          compactVendors: ['acme'],
        },
      },
    ),
    'single_run_limit_exceeded',
    'SOURCE_CONFIG_LIST_LIMIT',
  );
});
it.each([undefined, 'existing:public'])(
  'refuses vendor compaction because mirror describe accepts public pattern matches and visibility vetoes the proxy (%s)',
  async (packagist) => {
    const names = Array.from({ length: 65 }, (_, i) => `magento/p${i}`);
    const publicName = 'magento/public';
    expect(isSelected(publicName, { packages: names, patterns: [], expandPatterns: false })).toBe(
      false,
    );
    expect(
      isSelected(publicName, { packages: [], patterns: ['magento/*'], expandPatterns: false }),
    ).toBe(true);
    const routing: VisibilityConfig = {
      projects: [{ id: 'acme', orgId: 'org', active: true }],
      sources: (['composer_repository', 'packagist_proxy'] as const).map((type) => ({
        id: type,
        orgId: 'org',
        ecosystem: 'composer',
        type,
        ownerProjectId: null,
        removalPolicy: 'flag',
        defaultVisible: 1,
      })),
      attachments: [
        {
          projectId: 'acme',
          sourceId: 'packagist_proxy',
          precedence: 99999,
          includes: [],
          excludes: [],
        },
      ],
      registeredNames: names.map((pattern) => ({ orgId: 'org', ecosystem: 'composer', pattern })),
      packages: [],
      explicit: [],
    };
    expect(admitProxy(routing, 'acme', 'composer', publicName)).toEqual(['packagist_proxy']);
    expect(
      admitProxy(
        {
          ...routing,
          packages: [
            {
              id: 'public',
              orgId: 'org',
              sourceId: 'composer_repository',
              ecosystem: 'composer',
              key: publicName,
              status: 'active',
              visible: 1,
            },
          ],
        },
        'acme',
        'composer',
        publicName,
      ),
    ).toEqual([]);
    const rows = mirrorRows(names);
    rows.suborganizationPackages = [
      ...rows.packages!.map((pkg) => ({ ...pkg, suborganizationId: 1 })),
      {
        id: 999,
        name: publicName,
        origin: 'public-mirror',
        config: {},
        suborganizationId: 1,
      },
    ];
    const result = await plan(rows, defaults, {
      options: {
        compactSelection: true,
        compactVendors: ['magento'],
        acceptProjectWidening: ['acme'],
        ...(packagist === undefined ? {} : { packagist }),
      },
    });
    await refused(result, 'single_run_limit_exceeded', 'SOURCE_CONFIG_LIST_LIMIT');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        detail: 'Proxy-served vendors: magento. See owner question A (project_package).',
      }),
    );
    expect(result.summary.warning.filter((e) => e.code === 'selection_compacted')).toEqual([]);
  },
);
it('compacts another vendor when that is enough to leave a proxy-served vendor exact', async () => {
  const rows = mirrorRows([
    ...Array.from({ length: 40 }, (_, i) => `shared/p${i}`),
    ...Array.from({ length: 25 }, (_, i) => `safe/p${i}`),
  ]);
  rows.packages!.push({ id: 999, name: 'shared/public', origin: 'public-proxy', config: {} });
  const result = await success(
    await plan(rows, defaults, {
      options: {
        compactSelection: true,
        compactVendors: ['shared', 'safe'],
      },
    }),
  );
  expect(result.summary.warning.filter((e) => e.code === 'selection_compacted')).toEqual([
    expect.objectContaining({ pattern: 'safe/*' }),
  ]);
  expect(
    result.manifest.items.find(
      (i) => i.type === 'source' && i.source_type === 'composer_repository',
    ),
  ).toMatchObject({
    config: {
      selection: {
        patterns: ['safe/*'],
        packages: Array.from({ length: 40 }, (_, i) => `shared/p${i}`).sort(),
      },
    },
  });
});
it('still refuses uncompactable or oversized compacted lists', async () => {
  const names = Array.from({ length: 65 }, (_, i) => `vendor${i}/one`);
  await refused(
    await plan(mirrorRows(names), defaults, {
      options: {
        compactSelection: true,
        compactVendors: names.map((name) => name.split('/')[0]!),
      },
    }),
    'single_run_limit_exceeded',
    'SOURCE_CONFIG_LIST_LIMIT',
  );
});
it('requires acknowledgement for each project that would see extra mirror packages', async () => {
  const rows = mirrorRows(['acme/one', 'acme/two']);
  rows.suborganizations!.push({ id: 2, name: 'Example', urlName: 'example' });
  rows.suborganizationPackages = [
    { ...mirrored(100, 'acme/one'), suborganizationId: 1 },
    { ...mirrored(101, 'acme/two'), suborganizationId: 2 },
  ];
  await refused(await plan(rows), 'project_widening');
  await refused(
    await plan(rows, defaults, { options: { acceptProjectWidening: ['acme'] } }),
    'project_widening',
  );
  const result = await success(
    await plan(rows, defaults, { options: { acceptProjectWidening: ['acme', 'example'] } }),
  );
  expect(
    result.summary.warning
      .filter((e) => e.code === 'project_widening')
      .map((e) => [e.project, e.count])
      .sort(),
  ).toEqual([
    ['acme', 1],
    ['example', 1],
  ]);
});
it('requires acknowledgement even if a compacted vendor has no known extra packages', async () => {
  const names = Array.from({ length: 65 }, (_, i) => `acme/p${i}`);
  const rows = mirrorRows(names);
  rows.suborganizationPackages = rows.packages!.map((p) => ({ ...p, suborganizationId: 1 }));
  await refused(
    await plan(rows, defaults, {
      options: {
        compactSelection: true,
        compactVendors: ['acme'],
      },
    }),
    'project_widening',
  );
  const result = await success(
    await plan(rows, defaults, {
      options: {
        compactSelection: true,
        compactVendors: ['acme'],
        acceptProjectWidening: ['acme'],
      },
    }),
  );
  expect(result.summary.warning).toContainEqual(
    expect.objectContaining({ code: 'project_widening', count: 0 }),
  );
});
it.each([false, true])(
  'refuses unknown project acknowledgements (existing=%s)',
  async (existing) => {
    const map = {
      ...defaults,
      projects: { acme: existing ? { existing: 'target' } : { slug: 'target' } },
    };
    await success(await plan(minimal(), map, { options: { acceptProjectWidening: ['target'] } }));
    for (const slug of ['acme', 'typo'])
      await refused(
        await plan(minimal(), map, { options: { acceptProjectWidening: ['target', slug] } }),
        'unknown_project_acknowledgement',
      );
  },
);
it.each(['cycle', 'precedence'])(
  'reports the project and sources for a %s conflict',
  async (kind) => {
    const rows = mirrorRows(['acme/one', 'acme/two'], ['acme/one', 'acme/two']);
    rows.suborganizationPackages =
      kind === 'cycle'
        ? [
            { ...mirrored(100, 'acme/one'), suborganizationId: 1 },
            { ...mirrored(1001, 'acme/two', 21), suborganizationId: 1 },
          ]
        : [
            { ...mirrored(100, 'acme/one'), suborganizationId: 1 },
            {
              id: 999,
              name: 'acme/two',
              origin: 'public-mirror',
              config: {},
              suborganizationId: 1,
            },
          ];
    const result = await plan(rows);
    await refused(result, 'cross_source_conflict');
    const conflicts = result.summary.warning.filter(
      (entry) => entry.code === 'cross_source_conflict',
    );
    expect(conflicts).toHaveLength(2);
    for (const entry of conflicts)
      expect(entry).toMatchObject({
        project: 'acme',
        source: expect.stringMatching(/^pp-[a-f0-9]{61}$/),
      });
    expect(new Set(conflicts.map((entry) => entry.source)).size).toBe(2);
  },
);
it('owns shared names once, uses project-specific winners, and rejects cross-use cycles', async () => {
  const rows = mirrorRows(['acme/one', 'acme/two'], ['acme/one', 'acme/two']);
  rows.suborganizationPackages = [
    { ...mirrored(100, 'acme/one'), suborganizationId: 1 },
    { ...mirrored(1001, 'acme/two', 21), suborganizationId: 1 },
  ];
  await refused(await plan(rows), 'cross_source_conflict');
  rows.suborganizationPackages = [
    { ...mirrored(100, 'acme/one'), suborganizationId: 1 },
    { ...mirrored(1001, 'acme/two', 21), suborganizationId: 1 },
  ];
  rows.packages = [
    mirrored(100, 'acme/one'),
    mirrored(101, 'acme/shared'),
    mirrored(1000, 'acme/shared', 21),
  ];
  rows.suborganizationPackages = [
    { ...mirrored(100, 'acme/one'), suborganizationId: 1 },
    { ...mirrored(1000, 'acme/shared', 21), suborganizationId: 1 },
  ];
  const result = await success(
    await plan(rows, defaults, { options: { acceptProjectWidening: ['acme'] } }),
  );
  const shared = result.manifest.items.filter(
    (i) => i.type === 'name' && i.pattern === 'acme/shared',
  );
  expect(shared).toHaveLength(1);
  const sources = result.manifest.items.filter((i) => i.type === 'source');
  const refs = sources.map((s) => s.external_ref).sort();
  expect(shared[0]).toMatchObject({ source: { ref: refs[0] } });
  const attachments = result.manifest.items.filter((i) => i.type === 'attachment');
  expect(new Set(attachments.map((a) => a.precedence)).size).toBe(2);
  const winner = sources.find((s) => s.url === 'https://mirror.example.test/')!;
  expect(
    attachments.find((a) => 'ref' in a.source && a.source.ref === winner.external_ref)?.precedence,
  ).toBe(10000);
});
it('is byte and hash stable across object, list and member shuffles', async () => {
  const rows = base();
  const first = await success(await plan(rows));
  const shuffled = Object.fromEntries(
    Object.entries(rows)
      .reverse()
      .map(([k, entries]) => [
        k,
        [...entries].reverse().map((row) => ({
          ...Object.fromEntries(Object.entries(row).reverse()),
          ...(Array.isArray(row.members) ? { members: [...row.members].reverse() } : {}),
        })),
      ]),
  );
  const second = await success(await plan(shuffled));
  expect(second.canonical).toBe(first.canonical);
  expect(second.hash).toBe(first.hash);
});

it.each([
  [
    'project slug',
    () => ({ ...minimal(), suborganizations: [{ id: 1, name: 'Acme', urlName: 'INVALID' }] }),
    'project_slug_required',
  ],
  [
    'custom JSON',
    () => ({ ...minimal(), packages: [{ ...vcs(), config: { customJson: '{}' } }] }),
    'inline_package_unsupported',
  ],
  [
    'SSH runtime',
    () => ({ ...minimal(), packages: [vcs(10, 'acme/private', 'git@git.example.test:acme/repo')] }),
    'ssh_requires_node',
  ],
  [
    'userinfo',
    () => ({
      ...minimal(),
      packages: [vcs(10, 'acme/private', 'https://user:secret@git.example.test/repo')],
    }),
    'invalid_repository_url',
  ],
  [
    'HTTP',
    () => ({ ...minimal(), packages: [vcs(10, 'acme/private', 'http://git.example.test/repo')] }),
    'invalid_repository_url',
  ],
  [
    'query',
    () => ({
      ...minimal(),
      packages: [vcs(10, 'acme/private', 'https://git.example.test/repo?token=secret')],
    }),
    'invalid_repository_url',
  ],
  [
    'missing mirror',
    () => ({ ...minimal(), packages: [mirrored(10, 'acme/private')] }),
    'mirror_missing',
  ],
  [
    'unsupported type',
    () => ({ ...minimal(), packages: [{ ...vcs(), config: { type: 'pear' } }] }),
    'unsupported_package_type',
  ],
  [
    'unsupported origin',
    () => ({ ...minimal(), packages: [{ ...vcs(), origin: 'unknown' }] }),
    'unsupported_package_origin',
  ],
  [
    'package name',
    () => ({ ...minimal(), packages: [vcs(10, 'NOT CANONICAL')] }),
    'invalid_package',
  ],
] as const)('refuses mapping row %s', async (_, make, code) => {
  await refused(await plan(make(), { version: 1 }), code);
});
it.each([
  [{ options: { mode: 'override' as const } }, 'override_mode_unsupported'],
  [{ members: 'username,email\nacme-user,invalid' }, 'invalid_members'],
  [
    { members: 'username,email\nacme-user,one@example.test\nacme-user,two@example.test' },
    'invalid_members',
  ],
  [{ baseline: '{}' }, 'invalid_baseline'],
  [
    { snapshot: { ...fixture, objects: { packages: [{ data: {}, sha256: 'invalid' }] } } },
    'invalid_snapshot',
  ],
] as const)('refuses offline inputs %#', async (rest, code) => {
  await refused(await plan(minimal(), { version: 1 }, rest), code);
});
it('refuses unknown mirror order and long exact package patterns with named caps', async () => {
  await refused(await plan(mirrorRows(['acme/one']), { version: 1 }), 'mirror_order_required');
  await refused(
    await plan({ ...minimal(), packages: [vcs(10, `acme/${'x'.repeat(46)}`)] }, { version: 1 }),
    'single_run_limit_exceeded',
    'MAX_PATTERN_BYTES',
  );
});
it('warns for each mirror order id absent from the snapshot', async () => {
  const result = await success(
    await plan(mirrorRows(['acme/one']), { version: 1, mirrorOrder: [999, 20, 21, 998] }),
  );
  expect(result.summary.warning.filter((entry) => entry.code === 'stale_mirror_order')).toEqual([
    { code: 'stale_mirror_order', pointer: '/mirrorOrder/0' },
    { code: 'stale_mirror_order', pointer: '/mirrorOrder/3' },
  ]);
});
it.each(['mirroredRepositories', 'suborganizationMirroredRepositories'])(
  'refuses unknown mirroring behavior in %s even if another row for the mirror is supported',
  async (kind) => {
    const rows = minimal();
    rows.mirroredRepositories = [mirror()];
    rows.suborganizationMirroredRepositories = [{ ...mirror(), suborganizationId: 1 }];
    rows[kind]![0]!.mirroringBehavior = 'future';
    const result = await plan(rows);
    await refused(result, 'unsupported_mirroring_behavior');
    expect(result.diagnostics).toEqual([
      { code: 'unsupported_mirroring_behavior', pointer: `/objects/${kind}/0` },
    ]);
  },
);
it.each(['packages', 'suborganizationPackages'])(
  'refuses unknown default suborganization access in %s',
  async (kind) => {
    const rows = minimal();
    rows.packages = [vcs()];
    rows.suborganizationPackages = [{ ...vcs(), suborganizationId: 1 }];
    rows[kind]![0]!.config = { ...(vcs().config as Row), defaultSuborganizationAccess: 'future' };
    await refused(await plan(rows), 'unsupported_default_suborganization_access');
  },
);
it.each(['teams', 'suborganizationTeams'])(
  'refuses unknown %s permission before skipping an unlisted or built-in team',
  async (kind) => {
    for (const name of ['Unlisted', 'Owners']) {
      const rows = minimal();
      rows[kind] = [
        {
          id: 30,
          name,
          permission: 'future',
          ...(kind === 'teams' ? {} : { suborganizationId: 1 }),
        },
      ];
      await refused(await plan(rows, { version: 1 }), 'unsupported_team_permission');
    }
  },
);
it.each([
  ['suborg owner', 'owner', false, {}, 'project_owner'],
  ['suborg view', 'view', false, {}, 'project_developer'],
  ['org edit', 'edit', true, { projects: ['acme'] }, 'project_developer'],
  [
    'org edit explicit owner',
    'edit',
    true,
    { projects: ['acme'], role: 'project_owner' },
    'project_owner',
  ],
  ['org view', 'view', true, { projects: ['acme'] }, 'project_developer'],
  ['org owner', 'owner', true, {}, 'organization_admin'],
  ['org admin', 'admin', true, {}, 'organization_admin'],
] as const)('maps team grants: %s', async (_, permission, org, part, role) => {
  const rows = minimal();
  rows[org ? 'teams' : 'suborganizationTeams'] = [
    {
      id: 30,
      name: 'Acme',
      permission,
      ...(org ? {} : { suborganizationId: 1 }),
      members: [{ id: 300, username: 'acme-user' }],
    },
  ];
  const result = await success(
    await plan(
      rows,
      { version: 1, teams: { Acme: { group: { provider: 'sso', value: 'acme' }, ...part } } },
      { options: { includeOrgAdmins: true } },
    ),
  );
  const grant = result.manifest.items.find((i) => i.type === 'grant');
  expect(grant).toMatchObject({
    role: { existing: role },
    scope: role === 'organization_admin' ? 'organization' : 'project',
    subject: { type: 'group', provider: 'sso', value: 'acme' },
  });
  expect(result.manifest.widening).toEqual([{ type: 'grant', external_ref: grant!.external_ref }]);
});
it.each(['owner', 'admin'])('does not grant org %s without opt-in', async (permission) => {
  const rows = minimal();
  rows.teams = [{ id: 30, name: 'Acme', permission }];
  const result = await success(
    await plan(rows, {
      version: 1,
      teams: { Acme: { group: { provider: 'sso', value: 'acme' } } },
    }),
  );
  expect(result.manifest.items.filter((i) => i.type === 'grant')).toHaveLength(0);
});
it('maps CSV members to normalized email subjects and counts missing members', async () => {
  const rows = minimal();
  rows.suborganizationTeams = [
    {
      id: 30,
      name: 'Acme',
      permission: 'owner',
      suborganizationId: 1,
      members: [
        { id: 300, username: 'acme-user' },
        { id: 301, username: 'missing-user' },
      ],
    },
  ];
  const result = await success(
    await plan(
      rows,
      { version: 1, teams: { Acme: { members: 'csv' } } },
      { members: 'username,email\nacme-user,ACME@EXAMPLE.TEST' },
    ),
  );
  expect(result.manifest.items.find((i) => i.type === 'grant')).toMatchObject({
    subject: { type: 'email', value: 'acme@example.test' },
  });
  expect(result.summary.needsInput).toContainEqual(
    expect.objectContaining({ code: 'unmapped_members', count: 1 }),
  );
  expect(JSON.stringify(result.summary)).not.toContain('acme@example.test');
});
it.each([
  ['built-in', 'Owners', 'owner', undefined, 'built_in_team_skipped'],
  ['billing', 'Accounts', 'billing', undefined, 'billing_team'],
  ['unlisted edit', 'Acme', 'edit', { group: { provider: 'sso', value: 'acme' } }, 'unlisted_team'],
  ['unmapped', 'Acme', 'view', undefined, 'unlisted_team'],
] as const)('reports team row %s', async (_, name, permission, mapping, code) => {
  const rows = minimal();
  rows.teams = [{ id: 30, name, permission, members: [{ id: 300, username: 'acme-user' }] }];
  const result = await success(
    await plan(rows, { version: 1, teams: mapping ? { [name]: mapping } : {} }),
  );
  expect(result.summary.warning).toContainEqual(expect.objectContaining({ code }));
  expect(result.manifest.items.filter((i) => i.type === 'grant')).toHaveLength(0);
});
it('reports abandoned packages, default access, synchronizations and disabled mirrors', async () => {
  const rows = minimal();
  rows.packages = [
    {
      ...vcs(),
      abandoned: true,
      replacementPackage: 'acme/replacement',
      config: { ...(vcs().config as Row), defaultSuborganizationAccess: 'active' },
    },
  ];
  rows.mirroredRepositories = [{ ...mirror(), mirroringBehavior: 'disabled' }];
  rows.synchronizations = [{ name: 'Acme' }];
  const result = await success(await plan(rows, { version: 1 }));
  for (const code of [
    'abandoned',
    'auto_visible_to_new_projects',
    'disabled_mirror_skipped',
    'report_only_synchronizations',
  ])
    expect(result.summary.warning).toContainEqual(expect.objectContaining({ code }));
});
const binding = (match: Row, ref: string | null = 'env:COMPOSER_REF', kind = 'http_basic') => ({
  match,
  kind,
  ref,
});
it.each([
  [{ host: 'git.example.test' }, { host: 'git.example.test' }],
  [{ package: 'acme/*' }, { package: '*/private' }],
  [
    { url_prefix: 'https://git.example.test/acme' },
    { url_prefix: 'https://git.example.test/acme' },
  ],
])('collapses identical credential bindings at the same matching level %#', async (...matches) => {
  const result = await success(
    await plan(
      { ...minimal(), packages: [vcs()] },
      { version: 1, credentials: matches.map((match) => binding(match)) },
    ),
  );
  expect(credentialBindings(result.credentialsOut, result.manifest)).toEqual([
    expect.objectContaining({ credential_ref: 'env:COMPOSER_REF', kind: 'http_basic' }),
  ]);
});
it.each(['http_basic', 'github_app'])(
  'accepts %s credentials for mapped GitHub sources',
  async (kind) => {
    const result = await success(
      await plan(
        { ...minimal(), packages: [vcs(10, 'acme/private', 'https://github.com/acme/repo')] },
        {
          version: 1,
          github: { installations: { acme: 42 } },
          credentials: [binding({ host: 'github.com' }, 'env:GITHUB_REF', kind)],
        },
      ),
    );
    expect(credentialBindings(result.credentialsOut, result.manifest)).toEqual([
      expect.objectContaining({ credential_ref: 'env:GITHUB_REF', kind }),
    ]);
  },
);
it.each(['http_basic', 'bearer', 'github_app', 'ssh_key'])(
  'ignores the credential kind for an explicit null %s binding',
  async (kind) => {
    const result = await success(
      await plan(
        { ...minimal(), packages: [vcs()] },
        { version: 1, credentials: [binding({ host: 'git.example.test' }, null, kind)] },
      ),
    );
    expect(result.summary.needsInput).toEqual([]);
    expect(credentialBindings(result.credentialsOut, result.manifest)).toEqual([]);
  },
);
it('still refuses equal-level bindings with the same ref but different kinds', async () => {
  await refused(
    await plan(
      { ...minimal(), packages: [vcs()] },
      {
        version: 1,
        credentials: [
          binding({ host: 'git.example.test' }),
          binding({ host: 'git.example.test' }, 'env:COMPOSER_REF', 'bearer'),
        ],
      },
    ),
    'ambiguous_credential',
  );
});
it('uses exact package, pattern, longest segment prefix, credential id, then host', async () => {
  const rows = mirrorRows(['acme/one']);
  const rules = [
    binding({ host: 'composer.example.test' }, 'env:HOST_REF'),
    binding({ packagist_credential: 40 }, 'env:ID_REF'),
    binding({ url_prefix: 'https://composer.example.test/' }, 'env:PREFIX_REF'),
    binding({ package: 'acme/*' }, 'env:PATTERN_REF'),
    binding({ package: 'acme/one' }, 'env:EXACT_REF'),
  ];
  const expected = [
    'env:EXACT_REF',
    'env:PATTERN_REF',
    'env:PREFIX_REF',
    'env:ID_REF',
    'env:HOST_REF',
  ];
  for (const ref of expected) {
    const result = await success(await plan(rows, { ...defaults, credentials: rules }));
    expect(result.manifest.items.find((i) => i.type === 'source')?.credential_ref).toBe(ref);
    rules.pop();
    const credentials = credentialBindings(result.credentialsOut, result.manifest);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.credential_ref).toBe(ref);
  }
});
it('chooses the longest URL prefix at path segment boundaries', async () => {
  const rows = minimal();
  rows.packages = [vcs(10, 'acme/one', 'https://git.example.test/acme/repository')];
  const result = await success(
    await plan(rows, {
      version: 1,
      credentials: [
        binding({ url_prefix: 'https://git.example.test/acme' }, 'env:LONG_REF'),
        binding({ url_prefix: 'https://git.example.test/' }, 'env:SHORT_REF'),
        binding({ url_prefix: 'https://git.example.test/acme/repo' }, 'env:FALSE_REF'),
      ],
    }),
  );
  expect(result.manifest.items.find((i) => i.type === 'source')?.credential_ref).toBe(
    'env:LONG_REF',
  );
});
it('counts source coverage per host rule and accepts explicit null without needs-input', async () => {
  const rows = minimal();
  rows.packages = [vcs(10, 'acme/one'), vcs(11, 'acme/two'), vcs(12, 'example/three')];
  const result = await success(
    await plan(rows, {
      version: 1,
      credentials: [
        binding({ host: 'git.example.test' }, null),
        binding({ package: 'acme/one' }, null),
      ],
    }),
  );
  expect(result.summary.warning).toContainEqual({
    code: 'host_credential_coverage',
    pointer: '/credentials/0',
    count: 2,
  });
  expect(result.summary.needsInput).not.toContainEqual(
    expect.objectContaining({ code: 'unbound_credential' }),
  );
  expect(credentialBindings(result.credentialsOut, result.manifest)).toEqual([]);
});
it.each([
  [{ host: 'git.example.test' }, { host: 'git.example.test' }],
  [{ package: 'acme/*' }, { package: '*/private' }],
  [
    { url_prefix: 'https://git.example.test/acme' },
    { url_prefix: 'https://git.example.test/acme' },
  ],
])('refuses equal-level credential ambiguity %#', async (...matches) => {
  await refused(
    await plan(
      { ...minimal(), packages: [vcs()] },
      { version: 1, credentials: matches.map((m, i) => binding(m, `env:REF_${i}`)) },
    ),
    'ambiguous_credential',
  );
});
it('refuses incompatible credential kinds without exposing values', async () => {
  await refused(
    await plan(
      { ...minimal(), packages: [vcs()] },
      {
        version: 1,
        credentials: [binding({ host: 'git.example.test' }, 'env:COMPOSER_REF', 'bearer')],
      },
    ),
    'invalid_credential_kind',
  );
});
it('baseline no-op is empty; a new suborganization emits additive references', async () => {
  const rows = base();
  const baseline = await success(await plan(rows));
  const noop = await success(await plan(rows, defaults, { baseline: baseline.canonical }));
  expect(noop.manifest.items).toEqual([]);
  expect(noop.manifest.widening).toEqual([]);
  expect(JSON.parse(noop.credentialsOut).sources).toEqual([]);
  rows.suborganizations!.push({ id: 3, name: 'New project', urlName: 'new-project' });
  rows.suborganizationPackages!.push({ ...vcs(), suborganizationId: 3 });
  const additive = await success(await plan(rows, defaults, { baseline: baseline.canonical }));
  expect(additive.manifest.items.map((i) => i.type).sort()).toEqual(['attachment', 'project']);
  expect(additive.manifest.items.find((i) => i.type === 'attachment')).toMatchObject({
    source: { existing: { project: null, name: expect.stringMatching(/^pp-/) } },
  });
  await refused(
    await plan(rows, defaults, { baseline: additive.canonical }),
    'incomplete_baseline',
  );
});
it('adds a new source, exact name and attachment to an existing project', async () => {
  const rows = minimal();
  const baseline = await success(await plan(rows, { version: 1 }));
  rows.suborganizationPackages = [{ ...vcs(), suborganizationId: 1 }];
  const result = await success(await plan(rows, { version: 1 }, { baseline: baseline.canonical }));
  expect(result.manifest.items.map((i) => i.type).sort()).toEqual(['attachment', 'name', 'source']);
  expect(result.manifest.items.find((i) => i.type === 'attachment')).toMatchObject({
    project: { existing: 'acme' },
  });
});
it('refuses changed source URL, changed source config and removed packages', async () => {
  const original = { ...minimal(), packages: [vcs()] };
  const baseline = await success(await plan(original, { version: 1 }));
  await refused(
    await plan(
      {
        ...minimal(),
        packages: [vcs(10, 'acme/private', 'https://git.example.test/acme/changed')],
      },
      { version: 1 },
      { baseline: baseline.canonical },
    ),
    'existing_source_change',
  );
  await refused(
    await plan(minimal(), { version: 1 }, { baseline: baseline.canonical }),
    'destructive_delta_unsupported',
  );
  await refused(
    await plan(
      original,
      { version: 1, credentials: [binding({ host: 'git.example.test' })] },
      { baseline: baseline.canonical },
    ),
    'existing_source_change',
  );
});
it.each([
  [5001, 'MAX_MANIFEST_ITEMS'],
  [2500, 'MAX_MANIFEST_BYTES'],
] as const)('names the manifest cap at %i packages', async (count, cap) => {
  const rows = {
    ...minimal(),
    packages: Array.from({ length: count }, (_, i) =>
      vcs(i + 1, `acme/p${i}`, `https://git.example.test/acme/p${i}`),
    ),
  };
  await refused(await plan(rows, { version: 1 }), 'single_run_limit_exceeded', cap);
});

it('refuses different full refs that collide in a truncated source name', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  let counter = 0;
  vi.mocked(createHash).mockImplementation((algorithm, options) => {
    const result = actual.createHash(algorithm, options);
    const update = result.update.bind(result);
    result.update = ((data: Parameters<typeof result.update>[0]) => {
      if (String(data).startsWith('["pp-source-v1"'))
        result.digest = (() =>
          `${'a'.repeat(61)}${String(counter++).padStart(3, '0')}`) as unknown as typeof result.digest;
      return update(data);
    }) as typeof result.update;
    return result;
  });
  try {
    await refused(
      await plan(
        { ...minimal(), packages: [vcs(10, 'acme/one'), vcs(11, 'acme/two')] },
        { version: 1 },
      ),
      'source_name_collision',
    );
  } finally {
    vi.mocked(createHash).mockImplementation(actual.createHash);
  }
});
it('keeps attachment precedences unique and deterministic with VCS, mirrors and a proxy', async () => {
  const rows = mirrorRows(['acme/one'], ['example/one']);
  rows.suborganizationPackages = [
    { ...vcs(), suborganizationId: 1 },
    { ...vcs(11, 'acme/second'), suborganizationId: 1 },
    { ...mirrored(100, 'acme/one'), suborganizationId: 1 },
    { ...mirrored(1000, 'example/one', 21), suborganizationId: 1 },
    { id: 3000, name: 'public/one', origin: 'public-mirror', config: {}, suborganizationId: 1 },
  ];
  const first = await success(await plan(rows));
  const attachments = first.manifest.items.filter((i) => i.type === 'attachment');
  expect(attachments.map((a) => a.precedence).sort((a, b) => a - b)).toEqual([
    1000, 1001, 10000, 10100, 99999,
  ]);
  rows.suborganizationPackages.reverse();
  rows.mirroredRepositories!.reverse();
  const second = await success(await plan(rows));
  expect(second.canonical).toBe(first.canonical);
});
it('parses quoted CSV cells and rejects malformed baseline JSON with a baseline code', async () => {
  const rows = minimal();
  rows.suborganizationTeams = [
    {
      id: 30,
      name: 'Acme',
      permission: 'view',
      suborganizationId: 1,
      members: [{ id: 300, username: 'acme-user' }],
    },
  ];
  const result = await success(
    await plan(
      rows,
      { version: 1, teams: { Acme: { members: 'csv' } } },
      { members: '"username","email"\n"acme-user","ACME@EXAMPLE.TEST"' },
    ),
  );
  expect(result.manifest.items.find((i) => i.type === 'grant')).toMatchObject({
    subject: { type: 'email', value: 'acme@example.test' },
  });
  await refused(await plan(minimal(), { version: 1 }, { baseline: '{' }), 'invalid_baseline');
});
it('refuses a changed mirror URL as a source change', async () => {
  const rows = mirrorRows(['acme/one']);
  const baseline = await success(await plan(rows));
  rows.mirroredRepositories![0] = mirror(20, 'https://changed.example.test/');
  await refused(
    await plan(rows, defaults, { baseline: baseline.canonical }),
    'existing_source_change',
  );
});

it('retains mirror credential ids when scoped mirror rows omit the binding', async () => {
  const rows = mirrorRows(['acme/one']);
  rows.suborganizationMirroredRepositories = [
    { ...mirror(), credentials: '', suborganizationId: 1 },
  ];
  const result = await success(
    await plan(rows, {
      ...defaults,
      credentials: [
        binding({ host: 'composer.example.test' }, 'env:HOST_REF'),
        binding({ packagist_credential: 40 }, 'env:ID_REF'),
      ],
    }),
  );
  expect(result.manifest.items.find((i) => i.type === 'source')?.credential_ref).toBe('env:ID_REF');
});
it('reports replacement packages separately from abandonment and leaves release dates for a later run', async () => {
  const rows = {
    ...minimal(),
    packages: [{ ...vcs(), replacementPackage: 'acme/replacement' }],
    packageDetails: [
      { id: 10, versions: [{ version: '1.0.0', releasedAt: '2020-01-01T00:00:00Z' }] },
    ],
  };
  const result = await success(await plan(rows, { version: 1 }));
  expect(result.summary.warning).toContainEqual(
    expect.objectContaining({ code: 'replacement_package' }),
  );
  expect(result.manifest.items.filter((i) => i.type === 'version_override')).toEqual([]);
});
it('does not inherit operator mappings from object prototypes', async () => {
  const rows = {
    ...minimal(),
    suborganizations: [{ id: 1, name: 'Acme', urlName: 'constructor' }],
    packages: [vcs(10, 'acme/one', 'https://github.com/constructor/repo')],
  };
  const result = await success(await plan(rows, { version: 1 }));
  expect(result.manifest.items.find((i) => i.type === 'source')).toMatchObject({
    config: { provider: 'git', installationId: null },
  });
});
it.each([
  ['owner', 'view'],
  ['view', 'owner'],
])('merges overlapping grants using the stronger role (%s, %s)', async (...permissions) => {
  const rows = minimal();
  rows.suborganizationTeams = permissions.map((permission, i) => ({
    id: 30 + i,
    name: `team${i}`,
    permission,
    suborganizationId: 1,
  }));
  const result = await success(
    await plan(rows, {
      version: 1,
      teams: {
        team0: { group: { provider: 'sso', value: 'acme' } },
        team1: { group: { provider: 'sso', value: 'acme' } },
      },
    }),
  );
  expect(result.manifest.items.filter((item) => item.type === 'grant')).toEqual([
    expect.objectContaining({ role: { existing: 'project_owner' } }),
  ]);
  expect(result.summary.warning).toContainEqual(expect.objectContaining({ code: 'grant_merged' }));
  rows.suborganizationTeams.reverse();
  const shuffled = await success(
    await plan(rows, {
      version: 1,
      teams: {
        team0: { group: { provider: 'sso', value: 'acme' } },
        team1: { group: { provider: 'sso', value: 'acme' } },
      },
    }),
  );
  expect(shuffled.canonical).toBe(result.canonical);
});

it.each([false, true])(
  'keeps retained VCS attachment positions when adding a source (new project=%s)',
  async (newProject) => {
    const candidates = ['one', 'two', 'three'].map((n, i) =>
      vcs(i + 10, `acme/${n}`, `https://git.example.test/acme/${n}`),
    );
    const sourceRef = (pkg: Row) =>
      createHash('sha256')
        .update(JSON.stringify(['pp-source-v1', [(pkg.config as Row).url, pkg.name]]))
        .digest('hex');
    candidates.sort((a, b) => sourceRef(a).localeCompare(sourceRef(b)));
    const first = candidates.at(-1)!;
    const added = candidates[0]!;
    const rows = minimal();
    rows.suborganizationPackages = [{ ...first, suborganizationId: 1 }];
    const baseline = await success(await plan(rows, { version: 1 }));
    if (newProject) rows.suborganizations!.push({ id: 2, name: 'Example', urlName: 'example' });
    rows.suborganizationPackages.push({ ...added, suborganizationId: newProject ? 2 : 1 });
    const delta = await success(await plan(rows, { version: 1 }, { baseline: baseline.canonical }));
    expect(delta.manifest.items.map((i) => i.type).sort()).toEqual(
      newProject ? ['attachment', 'name', 'project', 'source'] : ['attachment', 'name', 'source'],
    );
    expect(delta.manifest.items.find((i) => i.type === 'attachment')?.precedence).toBe(
      newProject ? 1000 : 1001,
    );
  },
);
