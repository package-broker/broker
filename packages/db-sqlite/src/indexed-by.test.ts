import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url));
const D1_TEST = fileURLToPath(
  new URL('../../runtime-cloudflare/src/db/d1-indexed-by.test.ts', import.meta.url),
);

interface Coverage {
  readonly file: string;
  readonly index: string;
  readonly d1Cases: readonly string[];
}

const COVERAGE: readonly Coverage[] = [
  {
    file: 'repositories/keyring-verifier.ts',
    index: 'credential_version_in_use',
    d1Cases: ['keyring credential versions (credential_version_in_use)'],
  },
  {
    file: 'repositories/keyring-verifier.ts',
    index: 'token_pepper_version',
    d1Cases: ['keyring token versions (token_pepper_version)'],
  },
  {
    file: 'repositories/blob-references.ts',
    index: 'import_ref_run_external',
    d1Cases: [
      'blob-references retention candidates (import_ref_run_external)',
      'blob-references scheduled ineligible (import_ref_run_external)',
      'blob-references still eligible (import_ref_run_external)',
    ],
  },
  {
    file: 'repositories/closure-edges.ts',
    index: 'package_by_name',
    d1Cases: ['closure edges page (package_by_name)'],
  },
  {
    file: 'repositories/closure-edges.ts',
    index: 'package_by_name',
    d1Cases: ['closure edges classify (package_by_name)'],
  },
  {
    file: 'repositories/catalogue-list.ts',
    index: 'package_by_name',
    d1Cases: ['catalogue visible listing (package_by_name)', 'catalogue search (package_by_name)'],
  },
  {
    file: 'repositories/catalogue-lookup.ts',
    index: 'version_identity',
    d1Cases: ['catalogue version lookup (version_identity)'],
  },
  {
    file: 'repositories/catalogue-predicates.ts',
    index: 'package_by_name',
    d1Cases: ['catalogue proxy eligibility (package_by_name)'],
  },
  {
    file: 'repositories/catalogue-read.ts',
    index: 'version_by_published',
    d1Cases: ['catalogue version pagination (version_by_published)'],
  },
];

const INDEXED_BY = /\bindexed\s+by\b/gi;
const INDEX_IDENTIFIER =
  /^(?:"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]|'((?:[^']|'')*)'|([A-Za-z_][A-Za-z0-9_]*))/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function findIndexedBy(root: string): string[] {
  return sourceFiles(root)
    .flatMap((path) => {
      const text = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      const relative = path.slice(root.length).replace(/\\/g, '/');
      return [...text.matchAll(INDEXED_BY)].map((match) => {
        const identifier = text
          .slice(match.index + match[0].length)
          .trimStart()
          .match(INDEX_IDENTIFIER);
        if (!identifier) throw new Error(`Unrecognized INDEXED BY identifier in ${relative}`);
        const index =
          identifier[1]?.replaceAll('""', '"') ??
          identifier[2]?.replaceAll('``', '`') ??
          identifier[3] ??
          identifier[4]?.replaceAll("''", "'") ??
          identifier[5];
        return `${relative}#${index}`;
      });
    })
    .sort();
}

function expectCoverage(root: string, coverage: readonly Coverage[]): void {
  const expected = coverage.map((entry) => `${entry.file}#${entry.index}`).sort();
  expect(findIndexedBy(root)).toEqual(expected);
}

describe('INDEXED BY coverage', () => {
  it('lists every INDEXED BY under db-sqlite/src in the coverage table', () => {
    expectCoverage(SOURCE_ROOT, COVERAGE);
  });

  it('runs every covered statement as a named case in the D1 test', () => {
    const d1 = readFileSync(D1_TEST, 'utf8');
    for (const entry of COVERAGE) {
      expect(entry.d1Cases.length).toBeGreaterThan(0);
      for (const name of entry.d1Cases) {
        expect(d1, `${entry.file}: ${name}`).toContain(`it('${name}'`);
      }
    }
  });

  it('rejects a repeated index in the same file without another coverage entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'indexed-by-'));
    const coverage = [{ file: 'fresh.ts', index: 'fresh_idx', d1Cases: ['fixture'] }];
    try {
      const statement = 'const q = `select 1 from t INDEXED BY fresh_idx`;\n';
      writeFileSync(join(root, 'fresh.ts'), statement);
      expectCoverage(`${root}/`, coverage);
      writeFileSync(join(root, 'fresh.ts'), statement.repeat(2));
      expect(() => expectCoverage(`${root}/`, coverage)).toThrow();
      expectCoverage(`${root}/`, [...coverage, ...coverage]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['"package_by_name"', 'package_by_name'],
    ['`package_by_name`', 'package_by_name'],
    ['[package_by_name]', 'package_by_name'],
    ["'package_by_name'", 'package_by_name'],
    ['"index ""name"', 'index "name'],
    ['`index ``name`', 'index `name'],
    ["'index ''name'", "index 'name"],
  ])('reports quoted index %s and rejects it without coverage', (identifier, index) => {
    const root = mkdtempSync(join(tmpdir(), 'indexed-by-'));
    try {
      writeFileSync(
        join(root, 'fresh.ts'),
        `const q = sql\`select 1 from t INDEXED BY ${identifier}\`;\n`,
      );
      expect(findIndexedBy(`${root}/`)).toEqual([`fresh.ts#${index}`]);
      expect(() => expectCoverage(`${root}/`, [])).toThrow();
      expectCoverage(`${root}/`, [{ file: 'fresh.ts', index, d1Cases: ['fixture'] }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an INDEXED BY whose identifier cannot be classified', () => {
    const root = mkdtempSync(join(tmpdir(), 'indexed-by-'));
    try {
      writeFileSync(
        join(root, 'fresh.ts'),
        'const q = sql`select 1 from t INDEXED BY ${index}`;\n',
      );
      expect(() => findIndexedBy(`${root}/`)).toThrow(/Unrecognized INDEXED BY identifier/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an INDEXED BY in a new source file and ignores comments', () => {
    const root = mkdtempSync(join(tmpdir(), 'indexed-by-'));
    try {
      writeFileSync(join(root, 'fresh.ts'), 'const q = `select 1 from t INDEXED BY fresh_idx`;\n');
      writeFileSync(join(root, 'noted.ts'), '// INDEXED BY ignored_idx\n');
      writeFileSync(join(root, 'fresh.test.ts'), 'const q = "indexed by test_idx";\n');
      expect(findIndexedBy(`${root}/`)).toEqual(['fresh.ts#fresh_idx']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
