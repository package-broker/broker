import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type FileKind = 'test' | 'kit' | 'script' | 'source';

interface Rule {
  readonly allow: readonly string[];
  readonly testOnly: readonly string[];
  readonly kitAndTests?: readonly string[];
  readonly testsAndScripts?: readonly string[];
}

const ANY_WORKSPACE = 'workspace:*';
const WORKSPACE_PREFIX = '@package-broker/';
const NODE_BUILTINS = new Set(builtinModules);
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function packageNames(): string[] {
  return readdirSync(path.join(REPO_ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const WORKSPACE_PACKAGES = new Set(
  packageNames().map(
    (dir) =>
      (
        JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf8')) as {
          name: string;
        }
      ).name,
  ),
);
const GENERATED_ALIAS = { specifier: '#pb-manifest', files: ['src/entry.ts'] };
const GENERATED_ALIAS_PACKAGES = ['runtime-node', 'runtime-cloudflare'];

const ws = (...names: string[]): string[] => names.map((name) => `${WORKSPACE_PREFIX}${name}`);

const RULES: Readonly<Record<string, Rule>> = {
  core: { allow: ['hono'], testOnly: ['node', 'typescript', 'vitest'] },
  'db-sqlite': {
    allow: [...ws('core'), 'kysely'],
    testOnly: [],
    kitAndTests: ['vitest', 'node'],
  },
  'runtime-cloudflare': {
    allow: [...ws('core', 'db-sqlite'), 'hono'],
    testOnly: [],
    testsAndScripts: ['miniflare', 'node', 'vitest'],
  },
  'runtime-node': {
    allow: [...ws('core', 'db-sqlite'), 'better-sqlite3', '@hono/node-server', 'hono', 'node'],
    testOnly: ['vitest'],
  },
  cli: { allow: [ANY_WORKSPACE, 'esbuild', 'node', 'typescript'], testOnly: ['vitest'] },
  plugin: { allow: ws('core'), testOnly: ['vitest'] },
  ui: { allow: [], testOnly: ['vitest'] },
};

type PackageImports = Readonly<Record<string, unknown>>;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly rule: string;
}

function fileKind(relativePath: string): FileKind {
  const [, pkg, ...rest] = relativePath.split('/');
  const inPackage = rest.join('/');
  if (inPackage.endsWith('.test.ts')) return 'test';
  if (pkg === 'db-sqlite' && /^src\/(contract|testing)\//.test(inPackage)) return 'kit';
  if (inPackage.startsWith('scripts/')) return 'script';
  return 'source';
}

function ruleFor(pkg: string): Rule | undefined {
  return RULES[pkg.startsWith('plugin-') ? 'plugin' : pkg];
}

function classify(specifier: string): string {
  if (specifier.startsWith(WORKSPACE_PREFIX)) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0] ?? '')) {
    return 'node';
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function isAllowed(rule: Rule, dependency: string, kind: FileKind): boolean {
  if (rule.allow.includes(ANY_WORKSPACE) && WORKSPACE_PACKAGES.has(dependency)) return true;
  if (rule.allow.includes(dependency)) return true;
  if (kind === 'test' && rule.testOnly.includes(dependency)) return true;
  if ((kind === 'kit' || kind === 'test') && rule.kitAndTests?.includes(dependency)) return true;
  if ((kind === 'script' || kind === 'test') && rule.testsAndScripts?.includes(dependency)) {
    return true;
  }
  return false;
}

function aliasTargets(imports: PackageImports, specifier: string): string[] | undefined {
  const collect = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(collect)
        : [];
  if (specifier in imports) return collect(imports[specifier]);
  let best: { prefix: string; value: unknown } | undefined;
  for (const [key, value] of Object.entries(imports)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    if (specifier.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, value };
    }
  }
  if (!best) return undefined;
  const rest = specifier.slice(best.prefix.length);
  return collect(best.value).map((target) => target.replaceAll('*', rest));
}

interface Found {
  readonly specifier: string;
  readonly position: number;
}

function collectSpecifiers(sourceFile: ts.SourceFile): Found[] {
  const found: Found[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) {
      found.push({ specifier: node.text, position: node.getStart(sourceFile) });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const reference of sourceFile.referencedFiles) {
    const target = reference.fileName;
    const relative = target.startsWith('.') || target.startsWith('/') ? target : `./${target}`;
    found.push({ specifier: relative, position: reference.pos });
  }
  for (const reference of sourceFile.typeReferenceDirectives) {
    found.push({ specifier: reference.fileName, position: reference.pos });
  }
  return found;
}

function findViolations(
  relativePath: string,
  text: string,
  imports: PackageImports = {},
): Violation[] {
  const pkg = relativePath.split('/')[1] ?? '';
  const packageDir = path.posix.join('packages', pkg);
  const kind = fileKind(relativePath);
  const rule = ruleFor(pkg);
  const violations: Violation[] = [];

  const check = (specifier: string, line: number, original: string, fromAlias: boolean): void => {
    const report = (reason: string): void => {
      violations.push({ file: relativePath, line, specifier: original, rule: reason });
    };
    if (specifier.startsWith('#')) {
      if (fromAlias) return report('import alias resolves to another alias');
      const targets = aliasTargets(imports, specifier);
      if (targets) {
        for (const target of targets) check(target, line, original, true);
        return;
      }
      const generated =
        specifier === GENERATED_ALIAS.specifier &&
        GENERATED_ALIAS_PACKAGES.includes(pkg) &&
        GENERATED_ALIAS.files.some((file) => relativePath === `${packageDir}/${file}`);
      if (!generated) report('unresolved import alias');
      return;
    }
    if (specifier.startsWith('.')) {
      const base = fromAlias ? packageDir : path.posix.dirname(relativePath);
      const target = path.posix.normalize(path.posix.join(base, specifier));
      if (target !== packageDir && !target.startsWith(`${packageDir}/`)) {
        report('relative cross-package');
      }
      return;
    }
    const dependency = classify(specifier);
    if (dependency === `${WORKSPACE_PREFIX}${pkg}`) return;
    if (!rule || !isAllowed(rule, dependency, kind)) {
      report(`${pkg} must not import ${dependency || specifier} from a ${kind} file`);
    }
  };

  const sourceFile = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true);
  for (const { specifier, position } of collectSpecifiers(sourceFile)) {
    const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;
    check(specifier, line, specifier, false);
  }
  return violations;
}

function walk(directory: string, extension: string, found: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, extension, found);
    else if (entry.name.endsWith(extension)) found.push(full);
  }
}

function sourceFiles(pkg: string): string[] {
  const root = path.join(REPO_ROOT, 'packages', pkg);
  const files: string[] = [];
  walk(path.join(root, 'src'), '.ts', files);
  walk(path.join(root, 'scripts'), '.mjs', files);
  return files.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/')).sort();
}

function format(violations: Violation[]): string[] {
  return violations.map((v) => `${v.file}:${v.line}: ${v.specifier} (${v.rule})`);
}

describe('classifier', () => {
  it('flags a dynamic import that crosses a package boundary by relative path', () => {
    const text = "const m = await import('../../runtime-node/src/x.js');";
    expect(format(findViolations('packages/db-sqlite/src/a.ts', text))).toEqual([
      'packages/db-sqlite/src/a.ts:1: ../../runtime-node/src/x.js (relative cross-package)',
    ]);
  });

  it('flags require of a forbidden driver', () => {
    const text = "const db = require('better-sqlite3');";
    expect(findViolations('packages/db-sqlite/src/a.ts', text)).toHaveLength(1);
    expect(findViolations('packages/runtime-node/src/a.ts', text)).toHaveLength(0);
  });

  it('flags a re-export from a forbidden package', () => {
    const text = "export * from 'kysely';";
    expect(findViolations('packages/core/src/a.ts', text)).toHaveLength(1);
    expect(findViolations('packages/db-sqlite/src/a.ts', text)).toHaveLength(0);
  });

  it('flags a static import of a sibling workspace package by name', () => {
    const text = "import { x } from '@package-broker/runtime-node/entry';";
    expect(findViolations('packages/plugin-github/src/a.ts', text)).toHaveLength(1);
    expect(findViolations('packages/cli/src/a.ts', text)).toHaveLength(0);
  });

  it('allows relative imports inside the package and imports of the package itself', () => {
    const text = "import './b.js'; import '../src/c.js'; import '@package-broker/core/plugin';";
    expect(findViolations('packages/core/src/a.ts', text)).toEqual([]);
  });

  it('restricts node builtins and vitest by file kind', () => {
    const text = "import { readFileSync } from 'node:fs'; import { it } from 'vitest';";
    expect(findViolations('packages/core/src/a.ts', text)).toHaveLength(2);
    expect(findViolations('packages/core/src/a.test.ts', text)).toEqual([]);
    expect(findViolations('packages/db-sqlite/src/contract/a.ts', text)).toEqual([]);
    expect(findViolations('packages/db-sqlite/src/a.ts', text)).toHaveLength(2);
    expect(findViolations('packages/runtime-cloudflare/scripts/a.mjs', text)).toEqual([]);
    expect(findViolations('packages/runtime-cloudflare/src/a.ts', text)).toHaveLength(2);
  });

  it('exempts the generated manifest alias only at the runtime entry points', () => {
    const text = "import '#pb-manifest';";
    expect(findViolations('packages/runtime-node/src/entry.ts', text)).toEqual([]);
    expect(findViolations('packages/runtime-cloudflare/src/entry.ts', text)).toEqual([]);
    expect(findViolations('packages/runtime-node/src/other.ts', text)).toHaveLength(1);
    expect(findViolations('packages/core/src/entry.ts', text)).toHaveLength(1);
    expect(findViolations('packages/runtime-node/src/entry.ts', "import '#other';")).toHaveLength(
      1,
    );
  });

  it('resolves package imports aliases and checks their targets', () => {
    const imports = {
      '#db': 'better-sqlite3',
      '#local': { default: './src/x.js' },
      '#up': '../core/src/x.js',
    };
    const file = 'packages/db-sqlite/src/a.ts';
    expect(format(findViolations(file, "import '#db';", imports))).toEqual([
      `${file}:1: #db (db-sqlite must not import better-sqlite3 from a source file)`,
    ]);
    expect(findViolations(file, "import '#local';", imports)).toEqual([]);
    expect(findViolations(file, "import '#up';", imports)).toHaveLength(1);
    expect(findViolations('packages/runtime-node/src/a.ts', "import '#db';", imports)).toEqual([]);
  });

  it('applies the cli workspace wildcard to workspace packages only', () => {
    const file = 'packages/cli/src/a.ts';
    expect(findViolations(file, "import '@package-broker/runtime-node/entry';")).toEqual([]);
    for (const specifier of ['miniflare', 'vitest', 'lodash']) {
      expect(findViolations(file, `import '${specifier}';`)).toHaveLength(1);
    }
    expect(findViolations('packages/cli/src/a.test.ts', "import 'vitest';")).toEqual([]);
  });

  it('keeps bare names distinct from workspace packages', () => {
    expect(findViolations('packages/plugin-github/src/a.ts', "import 'core';")).toHaveLength(1);
    expect(findViolations('packages/runtime-node/src/a.ts', "import 'db-sqlite';")).toHaveLength(1);
    expect(findViolations('packages/cli/src/a.ts', "import 'core';")).toHaveLength(1);
  });

  it('reports one-based line numbers', () => {
    const text = "import 'hono';\n\nconst a = 1;\nimport 'kysely';";
    expect(format(findViolations('packages/core/src/a.ts', text))).toEqual([
      'packages/core/src/a.ts:4: kysely (core must not import kysely from a source file)',
    ]);
  });

  it('flags namespace re-exports and imports after a regex literal containing a quote', () => {
    expect(findViolations('packages/core/src/a.ts', "export * as k from 'kysely';")).toHaveLength(
      1,
    );
    const text = "const re = /'/;\nimport 'kysely';";
    expect(format(findViolations('packages/core/src/a.ts', text))).toEqual([
      'packages/core/src/a.ts:2: kysely (core must not import kysely from a source file)',
    ]);
  });

  it('collects import-equals, import types and reference directives', () => {
    const file = 'packages/core/src/a.ts';
    expect(findViolations(file, "import k = require('kysely');")).toHaveLength(1);
    expect(findViolations(file, "type T = import('kysely').Kysely<unknown>;")).toHaveLength(1);
    expect(findViolations(file, '/// <reference types="kysely" />')).toHaveLength(1);
    expect(findViolations(file, '/// <reference path="../../cli/src/x.d.ts" />')).toHaveLength(1);
    expect(findViolations(file, '/// <reference path="x.d.ts" />')).toEqual([]);
  });

  it('flags workspace names that are not packages', () => {
    const file = 'packages/cli/src/a.ts';
    expect(findViolations(file, "import '@package-broker/nonexistent';")).toHaveLength(1);
  });

  it('uses the longest matching alias pattern and substitutes every star', () => {
    const imports = { '#a/*': './src/*.js', '#a/db/*': 'better-sqlite3/*/*' };
    const file = 'packages/db-sqlite/src/a.ts';
    expect(findViolations(file, "import '#a/x';", imports)).toEqual([]);
    expect(findViolations(file, "import '#a/db/x';", imports)).toHaveLength(1);
  });

  it('reports the raw specifier when the dependency name is empty', () => {
    expect(format(findViolations('packages/core/src/a.ts', "import '/abs/x';"))).toEqual([
      'packages/core/src/a.ts:1: /abs/x (core must not import /abs/x from a source file)',
    ]);
  });

  it('classifies scoped npm packages with their scope', () => {
    const text = "import { serve } from '@hono/node-server/vercel';";
    expect(findViolations('packages/runtime-node/src/a.ts', text)).toEqual([]);
    expect(findViolations('packages/runtime-cloudflare/src/a.ts', text)).toHaveLength(1);
  });
});

describe('dependency edges', () => {
  for (const pkg of packageNames()) {
    it(`${pkg} respects the package boundaries`, () => {
      const manifest = JSON.parse(
        readFileSync(path.join(REPO_ROOT, 'packages', pkg, 'package.json'), 'utf8'),
      ) as { imports?: PackageImports };
      const violations = sourceFiles(pkg).flatMap((file) =>
        findViolations(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'), manifest.imports),
      );
      expect(format(violations)).toEqual([]);
    });
  }
});
