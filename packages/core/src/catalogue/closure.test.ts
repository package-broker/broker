import { describe, expect, it } from 'vitest';
import {
  MAX_MISSING_NAMES,
  MAX_REQUIRERS,
  MAX_VERSIONS,
  computeClosure,
  dependencyNames,
  type ClosureEdge,
  type ClosureStatus,
} from './closure.js';

describe('dependencyNames composer', () => {
  it('drops platform names and ignores require-dev', () => {
    const result = dependencyNames('composer', {
      require: {
        php: '^8.1',
        'ext-json': '*',
        'lib-curl': '*',
        hhvm: '*',
        'composer-plugin-api': '^2',
        'php-http/client': '^1',
        'Vendor/Pkg': '^1',
      },
      'require-dev': { 'phpunit/phpunit': '^10' },
    });
    expect(result.keys.sort()).toEqual(['php-http/client', 'vendor/pkg']);
    expect(result.unresolvable).toBe(0);
  });
});

describe('dependencyNames npm', () => {
  it('collects dependencies, optionalDependencies and non-optional peers', () => {
    const result = dependencyNames('npm', {
      dependencies: { a: '^1' },
      optionalDependencies: { b: '^1' },
      peerDependencies: { c: '^1', d: '^1' },
      peerDependenciesMeta: { d: { optional: true } },
      devDependencies: { e: '^1' },
    });
    expect(result.keys.sort()).toEqual(['a', 'b', 'c']);
  });

  it('resolves aliases to their target', () => {
    const result = dependencyNames('npm', {
      dependencies: { x: 'npm:real-pkg@^2', y: 'npm:@scope/other@1.0.0', z: 'npm:bare' },
    });
    expect(result.keys.sort()).toEqual(['@scope/other', 'bare', 'real-pkg']);
  });

  it('counts git, url, file and link specs as unresolvable', () => {
    const result = dependencyNames('npm', {
      dependencies: {
        a: 'git+https://example.test/a.git',
        b: 'https://example.test/b.tgz',
        c: 'file:../c',
        d: 'link:../d',
        e: 'github:org/e',
        f: 'org/f#main',
        ok: '^1',
      },
    });
    expect(result.keys).toEqual(['ok']);
    expect(result.unresolvable).toBe(6);
  });

  it('matches a mixed-case dependency to its encoded key', () => {
    const result = dependencyNames('npm', { dependencies: { JSONStream: '^1' } });
    expect(result.keys).toEqual(['!j!s!o!n!stream']);
  });

  it('counts invalid names as unresolvable', () => {
    const result = dependencyNames('npm', { dependencies: { '': '^1', '.bad': '^1' } });
    expect(result.keys).toEqual([]);
    expect(result.unresolvable).toBe(2);
  });
});

const edge = (dependency: string, requirer: string, version = '1.0.0'): ClosureEdge => ({
  dependency,
  requirer,
  version,
});
const classifyAll = (status: ClosureStatus) => (): ClosureStatus => status;

describe('computeClosure', () => {
  it('treats a visible package without versions as satisfying a dependency', () => {
    const report = computeClosure(
      new Set(['a/b']),
      [edge('a/b', 'c/d')],
      classifyAll('not_available'),
      {
        ecosystem: 'composer',
        canSeeOrganizationSources: false,
      },
    );
    expect(report.missing).toEqual([]);
    expect(report.truncated).toBe(false);
  });

  it('reports missing names sorted by key with display names', () => {
    const report = computeClosure(
      new Set(),
      [edge('z', 'r'), edge('!a', 'r')],
      classifyAll('proxy_admissible'),
      { ecosystem: 'npm', canSeeOrganizationSources: true },
    );
    expect(report.missing.map((m) => m.name)).toEqual(['A', 'z']);
    expect(report.missing[0]?.status).toBe('proxy_admissible');
  });

  it('downgrades attachable without organization source visibility', () => {
    const edges = [edge('a/b', 'r/r')];
    const without = computeClosure(new Set(), edges, classifyAll('attachable'), {
      ecosystem: 'composer',
      canSeeOrganizationSources: false,
    });
    const withIt = computeClosure(new Set(), edges, classifyAll('attachable'), {
      ecosystem: 'composer',
      canSeeOrganizationSources: true,
    });
    expect(without.missing[0]?.status).toBe('not_available');
    expect(withIt.missing[0]?.status).toBe('attachable');
  });

  it('caps requirers and versions deterministically', () => {
    const edges: ClosureEdge[] = [];
    for (let r = 20; r > 0; r--) {
      for (let v = 9; v > 0; v--) {
        edges.push(edge('a/b', `r/r${String(r).padStart(2, '0')}`, `1.0.${v}`));
      }
    }
    const report = computeClosure(new Set(), edges, classifyAll('not_available'), {
      ecosystem: 'composer',
      canSeeOrganizationSources: false,
    });
    const requiredBy = report.missing[0]?.requiredBy ?? [];
    expect(requiredBy).toHaveLength(MAX_REQUIRERS);
    expect(requiredBy[0]?.name).toBe('r/r01');
    expect(requiredBy[0]?.versions).toEqual(['1.0.9', '1.0.8', '1.0.7', '1.0.6', '1.0.5']);
    expect(requiredBy[0]?.versions).toHaveLength(MAX_VERSIONS);
    expect(report.truncated).toBe(true);
  });

  it('caps missing names and sets truncated', () => {
    const edges: ClosureEdge[] = [];
    for (let i = MAX_MISSING_NAMES + 5; i > 0; i--) {
      edges.push(edge(`v/p${String(i).padStart(5, '0')}`, 'r/r'));
    }
    const report = computeClosure(new Set(), edges, classifyAll('not_available'), {
      ecosystem: 'composer',
      canSeeOrganizationSources: false,
    });
    expect(report.missing).toHaveLength(MAX_MISSING_NAMES);
    expect(report.missing[0]?.name).toBe('v/p00001');
    expect(report.truncated).toBe(true);
  });

  it('does not classify names beyond the cap', () => {
    let calls = 0;
    const edges: ClosureEdge[] = [];
    for (let i = 0; i < MAX_MISSING_NAMES + 5; i++)
      edges.push(edge(`v/p${String(i).padStart(5, '0')}`, 'r/r'));
    computeClosure(new Set(), edges, () => (calls++, 'not_available'), {
      ecosystem: 'composer',
      canSeeOrganizationSources: true,
    });
    expect(calls).toBe(MAX_MISSING_NAMES);
  });
});

describe('dependencyNames hardening', () => {
  it('counts non-string specs as unresolvable without throwing', () => {
    const fields = { dependencies: { a: null, b: 1, c: { x: 1 }, ok: '^1' } } as never;
    const result = dependencyNames('npm', fields);
    expect(result.keys).toEqual(['ok']);
    expect(result.unresolvable).toBe(3);
  });

  it.each([
    './local',
    '../up',
    '/abs/path',
    '~/home',
    'workspace:*',
    'portal:../p',
    'patch:a@1#x',
    'file:../f',
    'link:../l',
    'git@example.test:o/r.git',
    'git://example.test/r.git',
    'http://example.test/r.tgz',
    'gitlab:o/r',
    'bitbucket:o/r',
    'gist:abc',
    'pkg.tgz',
    'https-less/x.tar.gz',
    'a.tar',
    'C:\\dir\\p',
    'd:/p',
  ])('counts %s as unresolvable', (spec) => {
    const result = dependencyNames('npm', { dependencies: { a: spec } });
    expect(result).toEqual({ keys: [], unresolvable: 1 });
  });

  it('resolves a scoped alias without a version', () => {
    const result = dependencyNames('npm', { dependencies: { x: 'npm:@scope/pkg' } });
    expect(result.keys).toEqual(['@scope/pkg']);
  });
});

describe('computeClosure leak safety', () => {
  const edges = [edge('a/b', 'r/r')];
  const run = (status: ClosureStatus, canSee: boolean) =>
    JSON.stringify(
      computeClosure(new Set(), edges, classifyAll(status), {
        ecosystem: 'composer',
        canSeeOrganizationSources: canSee,
      }),
    );

  it('gives identical output for hidden-source, other-project and absent names without org access', () => {
    const absent = run('not_available', false);
    expect(run('proxy_admissible', false)).toBe(absent);
    expect(run('attachable', false)).toBe(absent);
  });

  it('does not consult classify without org access', () => {
    let calls = 0;
    computeClosure(new Set(), edges, () => (calls++, 'attachable'), {
      ecosystem: 'composer',
      canSeeOrganizationSources: false,
    });
    expect(calls).toBe(0);
  });

  it('depends only on the classify result for the reported key', () => {
    const run2 = (other: ClosureStatus) =>
      JSON.stringify(
        computeClosure(new Set(), edges, (key) => (key === 'a/b' ? 'attachable' : other), {
          ecosystem: 'composer',
          canSeeOrganizationSources: true,
        }),
      );
    expect(run2('not_available')).toBe(run2('proxy_admissible'));
    const changed = computeClosure(
      new Set(),
      edges,
      (key) => (key === 'a/b' ? 'proxy_admissible' : 'attachable'),
      { ecosystem: 'composer', canSeeOrganizationSources: true },
    );
    expect(changed.missing[0]?.status).toBe('proxy_admissible');
  });

  it('skips an edge with an invalid requirer', () => {
    const report = computeClosure(new Set(), [edge('a/b', 'Bad!')], classifyAll('not_available'), {
      ecosystem: 'composer',
      canSeeOrganizationSources: true,
    });
    expect(report.missing).toEqual([]);
    expect(report.invalidEdges).toBe(1);
  });

  it('skips invalid keys and counts them', () => {
    const report = computeClosure(
      new Set(),
      [edge('Bad!', 'r/r'), edge('a/b', 'r/r')],
      classifyAll('not_available'),
      { ecosystem: 'composer', canSeeOrganizationSources: true },
    );
    expect(report.missing.map((m) => m.name)).toEqual(['a/b']);
    expect(report.invalidEdges).toBe(1);
  });
});

describe('computeClosure caps', () => {
  const run = (edges: ClosureEdge[]) =>
    computeClosure(new Set(), edges, classifyAll('not_available'), {
      ecosystem: 'composer',
      canSeeOrganizationSources: true,
    });
  const names = (n: number) =>
    Array.from({ length: n }, (_, i) => edge(`v/p${String(i).padStart(5, '0')}`, 'r/r'));
  const requirers = (n: number) =>
    Array.from({ length: n }, (_, i) => edge('a/b', `r/r${String(i).padStart(3, '0')}`));
  const versions = (n: number) =>
    Array.from({ length: n }, (_, i) => edge('a/b', 'r/r', `${i + 1}.0.0`));

  it.each([
    ['names', names, MAX_MISSING_NAMES],
    ['requirers', requirers, MAX_REQUIRERS],
    ['versions', versions, MAX_VERSIONS],
  ] as const)('truncates only when %s exceed the cap', (_label, build, cap) => {
    expect(run(build(cap)).truncated).toBe(false);
    expect(run(build(cap + 1)).truncated).toBe(true);
  });

  it('keeps the five newest versions by real order', () => {
    const report = run(
      ['1.0.0', '2.0.0', '10.0.0', '11.0.0', '3.0.0', '9.0.0'].map((v) => edge('a/b', 'r/r', v)),
    );
    expect(report.missing[0]?.requiredBy[0]?.versions).toEqual([
      '11.0.0',
      '10.0.0',
      '9.0.0',
      '3.0.0',
      '2.0.0',
    ]);
  });
});

describe('npm version order', () => {
  const order = (versions: string[]) =>
    computeClosure(
      new Set(),
      versions.map((v) => edge('a', 'r', v)),
      classifyAll('not_available'),
      { ecosystem: 'npm', canSeeOrganizationSources: true },
    ).missing[0]?.requiredBy[0]?.versions;

  it('sorts a prerelease below its release', () => {
    expect(order(['1.0.0-next.1', '1.0.0', '0.9.0'])).toEqual(['1.0.0', '1.0.0-next.1', '0.9.0']);
  });

  it('orders prerelease identifiers per semver', () => {
    expect(order(['1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-canary', '1.0.0-1'])).toEqual([
      '1.0.0-canary',
      '1.0.0-beta.10',
      '1.0.0-beta.2',
      '1.0.0-1',
    ]);
  });

  it('breaks build-metadata ties the same way for either input order', () => {
    expect(order(['1.0.0+a', '1.0.0+b'])).toEqual(['1.0.0+b', '1.0.0+a']);
    expect(order(['1.0.0+b', '1.0.0+a'])).toEqual(['1.0.0+b', '1.0.0+a']);
  });
});

describe('round 4', () => {
  it('trims specs before classifying them', () => {
    const result = dependencyNames('npm', {
      dependencies: {
        a: ' file:../local ',
        b: ' https://example.test/pkg.tgz ',
        c: ' npm:real@^1 ',
      },
    });
    expect(result).toEqual({ keys: ['real'], unresolvable: 2 });
  });

  it.each(['', 'bad key'])('counts %j as an invalid dependency or requirer key', (bad) => {
    const options = { ecosystem: 'composer', canSeeOrganizationSources: true } as const;
    const onDependency = computeClosure(
      new Set(),
      [edge(bad, 'r/r')],
      classifyAll('not_available'),
      options,
    );
    const onRequirer = computeClosure(
      new Set(),
      [edge('a/b', bad)],
      classifyAll('not_available'),
      options,
    );
    for (const report of [onDependency, onRequirer]) {
      expect(report.missing).toEqual([]);
      expect(report.invalidEdges).toBe(1);
    }
  });
});
