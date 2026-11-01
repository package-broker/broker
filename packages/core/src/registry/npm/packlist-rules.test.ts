import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { packlist as select } from './packlist-rules.js';

let work = 0;
function packlist(...args: Parameters<typeof select>): string[] {
  const diagnostics = { work: 0 };
  try {
    return select(args[0], args[1], args[2], diagnostics);
  } finally {
    work = diagnostics.work;
  }
}
const expectWorkBudget = () => {
  expect(work).toBeGreaterThan(0);
  expect(work).toBeLessThanOrEqual(2_000_000_000);
};

const npmRequire = createRequire(realpathSync(resolve(dirname(process.execPath), 'npm')));
const { minimatch } = npmRequire('minimatch') as {
  minimatch: (value: string, pattern: string, options: object) => boolean;
};
const names = [
  'a',
  'b',
  'ab',
  'abc',
  'abab',
  'abcabc',
  'a.js',
  'b.js',
  'ab.js',
  'abc.js',
  'ab.tmp.js',
  '.js',
  'file1.js',
  'file９.js',
  'filea.js',
  '.a',
  'é',
  '‿',
  '\u0301',
  '123',
  'a{b,c}',
  'foo.bar',
  'foo.tmp.bar',
];
it.each(['*', '?', '*.*', '[a-z]*', '[!b]*', '{a,b}*', 'a\\{b,c\\}', '[a-]', '[[]*'])(
  'matches pinned minimatch grammar %s',
  (pattern) => {
    const files = names.map((name) => 'dir/' + name);
    const actual = packlist(
      new Set(['package.json', ...files]),
      new Map([['package.json', JSON.stringify({ files: ['dir/' + pattern] })]]),
    );
    const expected = [
      'package.json',
      ...files.filter((name) =>
        minimatch(name, 'dir/' + pattern, {
          dot: true,
          nocase: true,
          matchBase: true,
          flipNegate: true,
        }),
      ),
    ].sort();
    expect(actual).toEqual(expected);
  },
);
it.each([['long', 'a'.repeat(4097)]])('caps pattern complexity: %s', (_name, pattern) => {
  expect(() =>
    packlist(
      new Set(['package.json', 'a'.repeat(1000)]),
      new Map([['package.json', JSON.stringify({ files: [pattern] })]]),
    ),
  ).toThrowError(
    expect.objectContaining({
      detail: 'packlist_budget',
    }),
  );
});
it('rejects a malformed files array', () => {
  expect(() =>
    packlist(new Set(['package.json']), new Map([['package.json', '{"files":[42]}']])),
  ).toThrowError(expect.objectContaining({ detail: 'manifest_files' }));
});
it('keeps missing, peer-only, dev-only and cyclic dependencies out of bundles', () => {
  const metadata = new Map([
    [
      'package.json',
      JSON.stringify({
        dependencies: { dep: '1', missing: '1' },
        devDependencies: { dev: '1' },
        peerDependencies: { peer: '1' },
        bundleDependencies: ['dep', 'missing', 'dev', 'peer'],
      }),
    ],
    ['node_modules/dep/package.json', JSON.stringify({ dependencies: { dep: '1' } })],
    ['node_modules/dev/package.json', '{}'],
    ['node_modules/peer/package.json', '{}'],
  ]);
  expect(packlist(new Set(metadata.keys()), metadata)).toEqual([
    'node_modules/dep/package.json',
    'package.json',
  ]);
});

it.each([
  '{9007199254740993..9007199254740991}',
  '{1..2..9007199254740993}',
  '{0..1000}',
  '{a,b}'.repeat(10),
])('refuses unsafe or excessive brace alternatives: %s', (pattern) => {
  expect(() =>
    packlist(
      new Set(['package.json', 'a']),
      new Map([['package.json', JSON.stringify({ files: [pattern] })]]),
    ),
  ).toThrowError(expect.objectContaining({ detail: 'unsupported_files_pattern' }));
});
it('allows 16 brace alternatives', () => {
  expect(
    packlist(
      new Set(['package.json', 'dir/15']),
      new Map([
        [
          'package.json',
          JSON.stringify({ files: ['dir/{0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15}'] }),
        ],
      ]),
    ),
  ).toEqual(['dir/15', 'package.json']);
});
it.each([
  ['ignore bytes', new Map([['.npmignore', '#' + 'x'.repeat(4 * 1024 * 1024 - 1)]])],
  ['ignore lines', new Map([['.npmignore', '# comment\n'.repeat(2000)]])],
  [
    'total lines',
    new Map(Array.from({ length: 6 }, (_, i) => [`d${i}/.npmignore`, '# comment\n'.repeat(1700)])),
  ],
])('refuses the packlist budget: %s', (_, ignores) => {
  const metadata = new Map([['package.json', '{}'], ...ignores]);
  expect(() =>
    packlist(
      new Set([
        'package.json',
        ...Array.from(ignores.keys()).map((p) => p.replace('.npmignore', 'file')),
      ]),
      metadata,
    ),
  ).toThrowError(expect.objectContaining({ detail: 'packlist_budget' }));
});
it('reuses impossible basename rule groups across the pack', () => {
  const paths = new Set([
    'package.json',
    ...Array.from({ length: 20000 }, (_, i) => `d/e/f/g/h/i/file${i}`),
  ]);
  const ignore = Array.from({ length: 1900 }, (_, i) => `nomatch${i}`).join('\n');
  expect(
    packlist(
      paths,
      new Map([
        ['package.json', '{}'],
        ['.npmignore', ignore],
      ]),
    ),
  ).toHaveLength(20001);
});
it('packs 20000 files with 200 basename rules at depth six within the work budget', () => {
  const paths = new Set([
    'package.json',
    ...Array.from({ length: 20000 }, (_, i) => `d/e/f/g/h/i/file${i}`),
  ]);
  const ignore = Array.from({ length: 200 }, (_, i) => `nomatch${i}`).join('\n');
  expect(
    packlist(
      paths,
      new Map([
        ['package.json', '{}'],
        ['.npmignore', ignore],
      ]),
    ),
  ).toHaveLength(20001);
  expectWorkBudget();
});
it('refuses files given as a string', () => {
  expect(() =>
    packlist(new Set(['package.json']), new Map([['package.json', '{"files":"lib"}']])),
  ).toThrowError(expect.objectContaining({ detail: 'manifest_files' }));
});

it('counts files selectors in the total rule-line budget', () => {
  expect(() =>
    packlist(
      new Set(['package.json']),
      new Map([
        [
          'package.json',
          JSON.stringify({ files: Array.from({ length: 10001 }, (_, i) => `a${i}`) }),
        ],
      ]),
    ),
  ).toThrowError(expect.objectContaining({ detail: 'packlist_budget' }));
});
it('bounds recursive brace expansion', () => {
  expect(() =>
    packlist(
      new Set(['package.json']),
      new Map([['package.json', JSON.stringify({ files: ['{a,}'.repeat(100)] })]]),
    ),
  ).toThrowError(expect.objectContaining({ detail: 'unsupported_files_pattern' }));
});

it.each(['+(a|aa)b', '!(a)'.repeat(30), '@(a)', '?(a)', '*(a)'])(
  'refuses unsupported extglobs: %s',
  (pattern) => {
    expect(() =>
      packlist(
        new Set(['package.json', 'a']),
        new Map([['package.json', JSON.stringify({ files: [pattern] })]]),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'candidate_skipped', detail: 'unsupported_files_pattern' }),
    );
  },
);
it('charges repeated globstar path tables to the work budget', () => {
  expect(
    packlist(
      new Set(['package.json', 'a/'.repeat(60) + 'c']),
      new Map([['package.json', JSON.stringify({ files: ['**/a/'.repeat(10) + 'b'] })]]),
    ),
  ).toEqual(['package.json']);
  expect(() =>
    packlist(
      new Set(['package.json', ...Array.from({ length: 10000 }, (_, i) => 'a/'.repeat(60) + i)]),
      new Map([['package.json', JSON.stringify({ files: ['**/a/'.repeat(10) + '*'] })]]),
    ),
  ).toThrowError(expect.objectContaining({ detail: 'packlist_budget' }));
});
it('accepts eighteen pattern segments against a sixty-two-deep path', () => {
  const path = 'a/'.repeat(61) + 'x';
  expect(
    packlist(
      new Set(['package.json', path]),
      new Map([['package.json', JSON.stringify({ files: ['**/' + 'a/'.repeat(16) + 'x'] })]]),
    ),
  ).toEqual([path, 'package.json']);
});
it.each([40000, 50000])(
  'packs %i files without rules within the work budget',
  (count) => {
    const paths = new Set([
      'package.json',
      ...Array.from({ length: count }, (_, i) => `file${i}.js`),
    ]);
    expect(packlist(paths, new Map([['package.json', '{}']]))).toHaveLength(count + 1);
    expectWorkBudget();
  },
  15000,
);
it('packs 20000 files with 20 globstar wildcard rules within the work budget', () => {
  const paths = new Set([
    'package.json',
    ...Array.from({ length: 20000 }, (_, i) => `d/e/f/g/h/i/file${i}.js`),
  ]);
  expect(
    packlist(
      paths,
      new Map([
        ['package.json', '{}'],
        ['.npmignore', Array.from({ length: 20 }, (_, i) => `**/*spec${i}*.js`).join('\n')],
      ]),
    ),
  ).toHaveLength(20001);
  expectWorkBudget();
}, 15000);
it('refuses 10000 expensive ignore lines with the budget code', () => {
  expect(() =>
    packlist(
      new Set(['package.json', 'file.js']),
      new Map([
        ['package.json', '{}'],
        ['.npmignore', Array(10000).fill('**/*a*b*c*d*').join('\n')],
      ]),
    ),
  ).toThrowError(expect.objectContaining({ detail: 'packlist_budget' }));
});
it('matches formerly exponential segment wildcards within the work budget', () => {
  expect(
    packlist(
      new Set(['package.json', 'a'.repeat(1000)]),
      new Map([['package.json', JSON.stringify({ files: ['*a'.repeat(12) + 'b'] })]]),
    ),
  ).toEqual(['package.json']);
  expectWorkBudget();
});
it('ignores caps and invalid patterns in metadata that packlist never reads', () => {
  const metadata = new Map([
    ['package.json', JSON.stringify({ files: ['lib/**'] })],
    ['.npmignore', '#'.repeat(4 * 1024 * 1024)],
    ['lib/.gitignore', '# ignored fallback\n'.repeat(10001)],
    ['lib/.npmignore', 'skip'],
    ['node_modules/unused/.npmignore', '**/*a*b*c*d*\n'.repeat(10000)],
    ['node_modules/unused/package.json', 'x'.repeat(300000)],
  ]);
  expect(packlist(new Set([...metadata.keys(), 'lib/a.js']), metadata)).toEqual([
    'lib/a.js',
    'package.json',
  ]);
});
it('keeps a dependency overlapping peerDependencies bundled', () => {
  const metadata = new Map([
    [
      'package.json',
      JSON.stringify({
        dependencies: { dep: '1' },
        peerDependencies: { dep: '1' },
        bundleDependencies: ['dep'],
      }),
    ],
    ['node_modules/dep/package.json', '{}'],
  ]);
  expect(packlist(new Set(metadata.keys()), metadata)).toEqual([
    'node_modules/dep/package.json',
    'package.json',
  ]);
});

it.each([
  '{1..3}',
  '{a,{b,c}}',
  '{' + Array.from({ length: 17 }, (_, i) => i).join(',') + '}',
  '[[:digit:]]',
  '[é]',
  'a'.repeat(3000) + '{0..999}',
])('refuses DEC-NPM-O2 unsupported grammar %s', (pattern) => {
  expect(() =>
    packlist(
      new Set(['package.json', 'a']),
      new Map([['package.json', JSON.stringify({ files: [pattern] })]]),
    ),
  ).toThrowError(
    expect.objectContaining({ code: 'candidate_skipped', detail: 'unsupported_files_pattern' }),
  );
});
it.each(['[abc', '[é', '[]a]', '[\\]a]', '?', '??'])(
  'matches DEC-NPM-O2 UTF16 and bracket grammar %s',
  (pattern) => {
    const files = ['dir/[abc', 'dir/[é', 'dir/a', 'dir/]', 'dir/𝟘.js', 'dir/a.js'];
    const glob = 'dir/' + pattern + (pattern.includes('?') ? '.js' : '');
    expect(
      packlist(
        new Set(['package.json', ...files]),
        new Map([['package.json', JSON.stringify({ files: [glob] })]]),
      ),
    ).toEqual(
      [
        'package.json',
        ...files.filter((name) =>
          minimatch(name, glob, { dot: true, nocase: true, matchBase: true, flipNegate: true }),
        ),
      ].sort(),
    );
  },
);
it('refuses paths deeper than 64 segments before matching', () => {
  expect(() =>
    packlist(new Set(['package.json', 'd/'.repeat(64) + 'a']), new Map([['package.json', '{}']])),
  ).toThrowError(expect.objectContaining({ detail: 'path_too_deep' }));
});
it('bounds compiled rule text before expanded allocation', () => {
  const list = '{' + Array.from({ length: 16 }, (_, i) => i).join(',') + '}';
  const selectors = Array.from({ length: 100 }, (_, i) => 'a'.repeat(3000) + i + list);
  expect(() =>
    packlist(
      new Set(['package.json']),
      new Map([
        ['package.json', '{}'],
        ['.npmignore', selectors.join('\n')],
      ]),
    ),
  ).toThrowError(expect.objectContaining({ detail: 'compiled_rule_cap' }));
});
it('accepts a long literal with a sixteen way brace list', () => {
  const literal = 'a'.repeat(3000);
  expect(
    packlist(
      new Set(['package.json', literal + '15']),
      new Map([
        [
          'package.json',
          JSON.stringify({
            files: [literal + '{' + Array.from({ length: 16 }, (_, i) => i).join(',') + '}'],
          }),
        ],
      ]),
    ),
  ).toEqual([literal + '15', 'package.json']);
});
it.each([300, 2000])(
  'reuses %i identical costly ignore lines within the work budget',
  (count) => {
    const paths = new Set([
      'package.json',
      ...Array.from({ length: 20000 }, (_, i) => `d/e/f/g/h/i/file${i}`),
    ]);
    expect(
      packlist(
        paths,
        new Map([
          ['package.json', '{}'],
          ['.npmignore', Array(count).fill('**/*a*b*c*d*').join('\n')],
        ]),
      ),
    ).toHaveLength(20001);
    expectWorkBudget();
  },
  15000,
);

it.each([
  'trailing-globstar-ignore',
  'trailing-globstar-files',
  'trailing-globstar-reinclude',
  'globstar-leading',
  'raw-relative',
  'ancestor-refusal',
  'literal-selectors',
])('matches ignore-walk differential regression %s', (id) => {
  const fixtures = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../../../fixtures/npm-repack/repositories.json'),
      'utf8',
    ),
  ) as { id: string; files: Record<string, string>; manifest: object; expected: string[] }[];
  const fixture = fixtures.find((f) => f.id === id)!;
  const metadata = new Map(
    Object.entries({ ...fixture.files, 'package.json': JSON.stringify(fixture.manifest) }),
  );
  expect(packlist(new Set(metadata.keys()), metadata)).toEqual(fixture.expected);
});

it.each([
  '[\\d]',
  '[\\w]',
  '[\\s]x',
  '[\\x41]',
  '[\\b]',
  '[\\^a]',
  '[z-a]x',
  '{a}',
  '{a',
  'a}',
  'a{2}',
  '{1..oops}',
  '{a..}',
  '[{]a',
  '?.js',
  'i?.js',
])('matches Round 5 minimatch differential %s', (pattern) => {
  const files = [
    'd',
    'w',
    'sx',
    ' x',
    '4',
    '1',
    'x',
    'A',
    'b',
    '^',
    'a',
    '[z-a]x',
    '{a}',
    '{a',
    'a}',
    'a{2}',
    '{1..oops}',
    '{a..}',
    '{a',
    'İ.js',
    'iİ.js',
  ].map((n) => 'dir/' + n);
  const glob = 'dir/' + pattern;
  expect(
    packlist(
      new Set(['package.json', ...files]),
      new Map([['package.json', JSON.stringify({ files: [glob] })]]),
    ),
  ).toEqual(
    [
      'package.json',
      ...files.filter((n) =>
        minimatch(n, glob, { dot: true, nocase: true, matchBase: true, flipNegate: true }),
      ),
    ]
      .filter((n, i, all) => all.indexOf(n) === i)
      .sort(),
  );
});
it('keeps empty wildcard segments from matching slash anchors', () => {
  expect(
    packlist(
      new Set(['package.json', 'a/x', 'd/a/x']),
      new Map([
        ['package.json', '{}'],
        ['.npmignore', '*/a'],
      ]),
    ),
  ).toEqual(['a/x', 'package.json']);
});
it.each(['', 'node_modules/@scope/dep/'])(
  'keeps nested ignore rules relative to their directory in package %s',
  (prefix) => {
    const metadata = new Map([
      [
        'package.json',
        prefix
          ? JSON.stringify({
              dependencies: { '@scope/dep': '1' },
              bundleDependencies: ['@scope/dep'],
            })
          : '{}',
      ],
      [prefix + 'src/deep/.npmignore', '/drop.js'],
    ]);
    if (prefix) metadata.set(prefix + 'package.json', '{}');
    expect(
      packlist(
        new Set([
          ...metadata.keys(),
          prefix + 'src/deep/drop.js',
          prefix + 'src/deep/keep.js',
          prefix + 'src/drop.js',
        ]),
        metadata,
      ),
    ).toEqual(
      [
        'package.json',
        ...(prefix ? [prefix + 'package.json'] : []),
        prefix + 'src/deep/keep.js',
        prefix + 'src/drop.js',
      ].sort(),
    );
  },
);
it.each(['*', '?', '[a-z]'])('applies exclusions without required literal text: %s', (pattern) => {
  expect(
    packlist(
      new Set(['package.json', 'z']),
      new Map([
        ['package.json', '{}'],
        ['.npmignore', pattern],
      ]),
    ),
  ).toEqual(['package.json']);
});
it('keeps an ancestor exclusion when local exclusions cannot match', () => {
  expect(
    packlist(
      new Set(['package.json', 'dir/zzz', 'dir/keep']),
      new Map([
        ['package.json', '{}'],
        ['.npmignore', '/dir/zzz'],
      ]),
    ),
  ).toEqual(['dir/keep', 'package.json']);
});
it.each([
  ['literal', 2000],
  ['wildcard', 2000],
  ['literal', 200],
  ['wildcard', 200],
] as const)(
  'bounds directory-heavy %s ignores with %i lines',
  (kind, count) => {
    const paths = new Set([
      'package.json',
      ...Array.from({ length: 49000 }, (_, i) => `d${i}/e/f/g/h/i/file`),
    ]);
    const ignore = Array.from({ length: count }, (_, i) =>
      kind === 'literal' ? `nomatch${i}` : `*nomatch${i}*`,
    ).join('\n');
    let result: string[];
    try {
      result = packlist(
        paths,
        new Map([
          ['package.json', '{}'],
          ['.npmignore', ignore],
        ]),
      );
    } catch (error) {
      if (count === 200) throw error;
      expect(error).toEqual(expect.objectContaining({ detail: 'packlist_budget' }));
      expectWorkBudget();
      return;
    }
    expect(result).toHaveLength(49001);
    expectWorkBudget();
    if (count === 200) expect(work).toBeLessThan(100_000_000);
  },
  20000,
);

it.each([
  '[\\^-a]',
  '[!\\^-a]',
  '[\\^]',
  '[a-\\d]',
  '[a-z0-9]',
  '[z-aa]',
  '[a-a]',
  '[-a]',
  '[a-]',
  '[\\-a]',
  '[\\]a]',
  '[]a]',
  '[^]a]',
  '[\\[]',
  '[{]a',
  '[[:other:]]',
  '[\\[:abc]',
])('matches ASCII parseClass edge %s', (pattern) => {
  const files = [
    'dir/o]',
    'dir/h]',
    'dir/[]',
    ...Array.from({ length: 94 }, (_, i) => 'dir/' + String.fromCharCode(33 + i)).filter(
      (n) => !n.endsWith('/') && !n.endsWith('*') && !n.endsWith('/.'),
    ),
  ];
  expect(
    packlist(
      new Set(['package.json', ...files]),
      new Map([['package.json', JSON.stringify({ files: ['dir/' + pattern] })]]),
    ),
  ).toEqual(
    [
      'package.json',
      ...files.filter((n) =>
        minimatch(n, 'dir/' + pattern, {
          dot: true,
          nocase: true,
          matchBase: true,
          flipNegate: true,
        }),
      ),
    ].sort(),
  );
});

function bundledChain(count: number, limitReads = false) {
  const metadata = new Map<string, string | (() => string)>([
    ['package.json', JSON.stringify({ dependencies: { d0: '1' }, bundleDependencies: ['d0'] })],
  ]);
  let reads = 0;
  for (let i = 0; i < count; i++) {
    const body = JSON.stringify(i + 1 < count ? { dependencies: { ['d' + (i + 1)]: '1' } } : {});
    metadata.set(`node_modules/d${i}/package.json`, () => {
      if (limitReads && ++reads > 500) throw new Error('read beyond bundle cap');
      return body;
    });
  }
  return metadata;
}
it('refuses 22000 transitive bundled packages before reading package 501', () => {
  const metadata = bundledChain(22000, true);
  expect(() => packlist(new Set(metadata.keys()), metadata)).toThrowError(
    expect.objectContaining({ detail: 'packlist_budget' }),
  );
  expectWorkBudget();
});
it('gathers 400 bundled packages using only their indexed subtrees', () => {
  const metadata = bundledChain(400);
  const paths = new Set(metadata.keys());
  for (let i = 0; i < 400; i++) paths.add(`node_modules/d${i}/index.js`);
  // Count archive enumeration independently of the selection work counter.
  const iterate = paths[Symbol.iterator].bind(paths);
  let visits = 0;
  paths[Symbol.iterator] = function* (): Generator<string, undefined> {
    for (const path of iterate()) {
      visits++;
      yield path;
    }
    return undefined;
  };
  expect(packlist(paths, metadata)).toHaveLength(801);
  expect(visits).toBeLessThanOrEqual(paths.size * 2);
  expectWorkBudget();
});
it('refuses a 5000-long hoisted bundle chain with packlist_budget rather than RangeError', () => {
  const metadata = bundledChain(5000);
  expect(() => packlist(new Set(metadata.keys()), metadata)).toThrowError(
    expect.objectContaining({ detail: 'packlist_budget' }),
  );
  expectWorkBudget();
});
it('refuses 2000 distinct costly ignore lines', () => {
  expect(() =>
    packlist(
      new Set(['package.json', ...Array.from({ length: 20000 }, (_, i) => `d/e/f/g/h/i/file${i}`)]),
      new Map([
        ['package.json', '{}'],
        ['.npmignore', Array.from({ length: 2000 }, (_, i) => `**/*a*b*c*d*${i}`).join('\n')],
      ]),
    ),
  ).toThrowError(expect.objectContaining({ detail: 'packlist_budget' }));
  expectWorkBudget();
});
it.each(['negations', 'files'])(
  'bounds %s-heavy directory shapes by charged work',
  (kind) => {
    const paths = new Set([
      'package.json',
      ...Array.from({ length: 40000 }, (_, i) => `d${i}/file`),
    ]);
    const metadata =
      kind === 'negations'
        ? new Map([
            ['package.json', '{}'],
            [
              '.npmignore',
              ['*', ...Array.from({ length: 1999 }, (_, i) => `!**/x${i}/**`)].join('\n'),
            ],
          ])
        : new Map([
            [
              'package.json',
              JSON.stringify({ files: Array.from({ length: 9000 }, (_, i) => `**/x${i}/**`) }),
            ],
          ]);
    try {
      expect(packlist(paths, metadata)).toEqual(['package.json']);
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ detail: 'packlist_budget' }));
    }
    expectWorkBudget();
  },
  30000,
);

it('charges partial include scans even when most rules are skipped', () => {
  const count = 9000;
  expect(
    packlist(
      new Set(['package.json', 'dir/file']),
      new Map([
        [
          'package.json',
          JSON.stringify({ files: Array.from({ length: count }, (_, i) => `**/x${i}/**`) }),
        ],
      ]),
    ),
  ).toEqual(['package.json']);
  expect(work).toBeGreaterThanOrEqual(count * 256);
  expectWorkBudget();
});

it('deduplicates compiled text across consumed ignores and refuses aggregate expansion', () => {
  const body = Array.from(
    { length: 256 },
    (_, i) => String(i).padStart(4, '0') + 'x'.repeat(4092),
  ).join('\n');
  const paths = new Set(['package.json', 'a/file', 'b/file', 'c/file']);
  const metadata = new Map([
    ['package.json', '{}'],
    ['a/.npmignore', body],
    ['b/.npmignore', body],
  ]);
  expect(packlist(paths, metadata)).toHaveLength(4);
  metadata.set('c/.npmignore', body.replaceAll('x', 'y'));
  expect(() => packlist(paths, metadata)).toThrowError(
    expect.objectContaining({ detail: 'compiled_rule_cap' }),
  );
});

it('accepts exactly 4 MiB of compiled text, deduplicates it and refuses the next unit', () => {
  const patterns = Array.from(
    { length: 512 },
    (_, i) => String(i).padStart(4, '0') + 'x'.repeat(i === 511 ? 3692 : 4092),
  );
  // Defaults and root strict rules reserve the other 400 UTF-16 units.
  const body = [...patterns, patterns[0]].join('\n');
  const paths = new Set(['package.json']);
  expect(
    packlist(
      paths,
      new Map([
        ['package.json', '{}'],
        ['.npmignore', body],
      ]),
    ),
  ).toEqual(['package.json']);
  expect(() =>
    packlist(
      paths,
      new Map([
        ['package.json', '{}'],
        ['.npmignore', body + '\nz'],
      ]),
    ),
  ).toThrowError(expect.objectContaining({ detail: 'compiled_rule_cap' }));
});
