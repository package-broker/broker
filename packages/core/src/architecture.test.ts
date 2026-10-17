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
  readonly onlyIn?: Readonly<Record<string, readonly string[]>>;
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
  core: { allow: ['hono', 'zod'], testOnly: ['eslint', 'node', 'typescript', 'vitest'] },
  'db-sqlite': {
    allow: [...ws('core'), 'kysely'],
    testOnly: [],
    kitAndTests: ['vitest', 'node'],
  },
  'runtime-cloudflare': {
    allow: [...ws('core', 'db-sqlite'), 'hono'],
    testOnly: [],
    testsAndScripts: ['miniflare', 'node', 'vitest'],
    onlyIn: { node: ['packages/runtime-cloudflare/src/codec/workers-codec.ts'] },
  },
  'runtime-node': {
    allow: [
      ...ws('core', 'db-sqlite'),
      'aws4fetch',
      'better-sqlite3',
      '@hono/node-server',
      'hono',
      'node',
    ],
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

function isAllowed(rule: Rule, dependency: string, kind: FileKind, file: string): boolean {
  if (rule.onlyIn?.[dependency]?.includes(file)) return true;
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
    if (!rule || !isAllowed(rule, dependency, kind, relativePath)) {
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

  it('allows the node import in exactly one runtime-cloudflare production file', () => {
    const text = "import { inflateSync } from 'node:zlib';";
    const codec = 'packages/runtime-cloudflare/src/codec/workers-codec.ts';
    expect(findViolations(codec, text)).toEqual([]);
    expect(findViolations(codec, "import { x } from 'kysely';")).toHaveLength(1);
    expect(findViolations('packages/runtime-cloudflare/src/codec/other.ts', text)).toHaveLength(1);
    expect(
      findViolations('packages/runtime-cloudflare/src/blob/workers-codec.ts', text),
    ).toHaveLength(1);
    expect(findViolations('packages/runtime-node/src/codec/workers-codec.ts', text)).toEqual([]);
    expect(findViolations('packages/db-sqlite/src/codec/workers-codec.ts', text)).toHaveLength(1);
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

const MINTERS: Readonly<Record<string, readonly string[]>> = {
  'packages/core/src/db/catalogue': ['catalogueWriteGuard'],
  'packages/core/src/catalogue/version-rules': ['completeSourceListing', 'completeVersionListing'],
  'packages/core/src/authz/fence': [
    'fenceGuard',
    'systemMutationFence',
    'tokenMutationFence',
    'delegatedMutationFence',
  ],
};
interface ImportRule {
  readonly modules: Readonly<Record<string, readonly string[]>>;
  readonly allowedRoots: readonly string[];
  readonly allowedRootsByName?: Readonly<Record<string, readonly string[]>>;
}

const FENCE_ISSUER_ROOTS = [
  'packages/db-sqlite/src/',
  'packages/core/src/kernel/',
  'packages/core/src/platform/',
];
const MINT_RULE: ImportRule = {
  modules: MINTERS,
  allowedRoots: ['packages/db-sqlite/src/'],
  allowedRootsByName: {
    systemMutationFence: FENCE_ISSUER_ROOTS,
    tokenMutationFence: FENCE_ISSUER_ROOTS,
    delegatedMutationFence: FENCE_ISSUER_ROOTS,
  },
};
const ACCESS_CONTEXT_RULE: ImportRule = {
  modules: {
    'packages/core/src/authz/access-context': [
      'setAccessContext',
      'accessContextOf',
      'organizationActorOf',
    ],
  },
  allowedRoots: [
    'packages/core/src/',
    'packages/runtime-node/src/',
    'packages/runtime-cloudflare/src/',
  ],
};
const LITERAL_LOADS_ONLY = ['core', 'runtime-node', 'runtime-cloudflare'];
const MODULE_EXTENSION = /\.(?:d\.ts|[cm]?ts|[cm]?js)$/;

const WORKSPACE_DIRS = new Map(
  packageNames().map((dir) => [
    (
      JSON.parse(readFileSync(path.join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf8')) as {
        name: string;
      }
    ).name,
    dir,
  ]),
);

function moduleIds(fromFile: string, specifier: string, imports: PackageImports): string[] {
  const packageDir = path.posix.join('packages', fromFile.split('/')[1] ?? '');
  const strip = (target: string): string =>
    target.replace(MODULE_EXTENSION, '').replace(/^(packages\/[^/]+)\/dist\//, '$1/src/');
  if (specifier.startsWith('#')) {
    return (aliasTargets(imports, specifier) ?? []).flatMap((target) =>
      target.startsWith('.')
        ? [strip(path.posix.normalize(path.posix.join(packageDir, target)))]
        : moduleIds(fromFile, target, {}),
    );
  }
  if (specifier.startsWith('.')) {
    return [strip(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)))];
  }
  const parts = specifier.split('/');
  const dir = WORKSPACE_DIRS.get(parts.slice(0, 2).join('/'));
  if (!dir || parts.length < 3) return [];
  return [strip(`packages/${dir}/src/${parts.slice(2).join('/')}`)];
}

function isCreateRequire(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === 'createRequire') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire')
  );
}

function findMintViolations(
  relativePath: string,
  text: string,
  imports: PackageImports = {},
  rule: ImportRule = MINT_RULE,
): string[] {
  if (relativePath.endsWith('.test.ts')) return [];
  const allowedFor = (name: string): boolean =>
    (rule.allowedRootsByName?.[name] ?? rule.allowedRoots).some((root) =>
      relativePath.startsWith(root),
    );
  const allowedAll = (names: readonly string[]): boolean => names.every(allowedFor);
  const unrestricted = allowedAll(Object.values(rule.modules).flat());
  const literalLoadsOnly =
    rule === MINT_RULE && LITERAL_LOADS_ONLY.includes(relativePath.split('/')[1] ?? '');
  const requireAliases = new Set<string>();
  const sourceFile = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const mintedLocals = new Set<string>();
  const report = (node: ts.Node, what: string): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    found.push(`${relativePath}:${line}: ${what}`);
  };
  const mintNames = (specifier: ts.Node | undefined): readonly string[] | undefined => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return undefined;
    const target = moduleIds(relativePath, specifier.text, imports).find(
      (id) => id in rule.modules,
    );
    return target === undefined ? undefined : rule.modules[target];
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const names = mintNames(node.moduleSpecifier);
      const bindings = node.importClause?.namedBindings;
      if (names && bindings && ts.isNamespaceImport(bindings) && !allowedAll(names)) {
        report(node, 'namespace import of a minting module');
      } else if (names && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (!names.includes(imported)) continue;
          if (allowedFor(imported)) mintedLocals.add(element.name.text);
          else report(element, imported);
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const names = mintNames(node.moduleSpecifier);
      const clause = node.exportClause;
      if (names && !clause) report(node, 'export * of a minting module');
      else if (names && clause && ts.isNamespaceExport(clause)) {
        report(node, 'export * as of a minting module');
      } else if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const exported = (element.propertyName ?? element.name).text;
          if (names ? names.includes(exported) : mintedLocals.has(exported)) {
            report(element, `re-export ${exported}`);
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      const names = ts.isExternalModuleReference(reference)
        ? mintNames(reference.expression)
        : undefined;
      if (names && !allowedAll(names)) report(node, 'import-equals of a minting module');
    } else if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression) && mintedLocals.has(node.expression.text)) {
        report(node, `re-export ${node.expression.text}`);
      }
    } else if (ts.isVariableStatement(node)) {
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const declaration of node.declarationList.declarations) {
        const init = declaration.initializer;
        if (init && isCreateRequire(init) && ts.isIdentifier(declaration.name)) {
          requireAliases.add(declaration.name.text);
        }
        if (exported && init && ts.isIdentifier(init) && mintedLocals.has(init.text)) {
          report(declaration, `re-export ${init.text}`);
        }
      }
    } else if (ts.isCallExpression(node) && !unrestricted) {
      const callee = node.expression;
      const isLoader =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) &&
          (callee.text === 'require' || requireAliases.has(callee.text))) ||
        isCreateRequire(callee);
      const argument = node.arguments[0];
      if (isLoader && literalLoadsOnly && !(argument && ts.isStringLiteral(argument))) {
        report(node, 'dynamic load with a computed specifier');
      } else if (isLoader) {
        const names = mintNames(argument);
        if (names && !allowedAll(names)) report(node, 'dynamic load of a minting module');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('minting modules', () => {
  const leak = 'packages/core/src/catalogue/leak.ts';

  it('flags named imports of a mint, also renamed and by package specifier', () => {
    expect(
      findMintViolations(
        leak,
        [
          "import { catalogueWriteGuard } from '../db/catalogue.js';",
          "import { completeSourceListing as c, completeVersionListing } from './version-rules.js';",
          "import { fenceGuard } from '../authz/fence';",
          "import { catalogueWriteGuard as w } from '@package-broker/core/db/catalogue';",
        ].join('\n'),
      ),
    ).toEqual([
      `${leak}:1: catalogueWriteGuard`,
      `${leak}:2: completeSourceListing`,
      `${leak}:2: completeVersionListing`,
      `${leak}:3: fenceGuard`,
      `${leak}:4: catalogueWriteGuard`,
    ]);
  });

  it('allows named imports of the other exports', () => {
    const text = [
      "import { versionTransition, type VersionStatus } from './version-rules.js';",
      "import { validateLimit, type CatalogueReader } from '../db/catalogue.js';",
      "import { mutationFence } from '@package-broker/core/authz/fence';",
      "import * as names from './names.js';",
    ].join('\n');
    expect(findMintViolations(leak, text)).toEqual([]);
  });

  it('flags namespace imports by relative and package specifiers', () => {
    expect(
      findMintViolations(
        leak,
        "import * as rules from './version-rules.ts';\nimport type * as c from '../db/catalogue';",
      ),
    ).toEqual([
      `${leak}:1: namespace import of a minting module`,
      `${leak}:2: namespace import of a minting module`,
    ]);
    expect(
      findMintViolations(
        'packages/runtime-node/src/a.ts',
        "import * as fence from '@package-broker/core/authz/fence';",
      ),
    ).toEqual(['packages/runtime-node/src/a.ts:1: namespace import of a minting module']);
  });

  it('flags export *, export * as and named re-exports', () => {
    const file = 'packages/plugin-x/src/index.ts';
    expect(
      findMintViolations(
        file,
        [
          "export * from '@package-broker/core/catalogue/version-rules.js';",
          "export * as c from '@package-broker/core/db/catalogue';",
          "export { fenceGuard as g } from '@package-broker/core/authz/fence';",
          "export { mutationFence } from '@package-broker/core/authz/fence';",
        ].join('\n'),
      ),
    ).toEqual([
      `${file}:1: export * of a minting module`,
      `${file}:2: export * as of a minting module`,
      `${file}:3: re-export fenceGuard`,
    ]);
  });

  it('flags dynamic import, require and import-equals', () => {
    const text = [
      "const a = await import('../db/catalogue.js');",
      "const c = require('../authz/fence.js');",
      "import d = require('./version-rules');",
      "const e = createRequire(import.meta.url)('./version-rules.js');",
    ].join('\n');
    expect(findMintViolations(leak, text)).toEqual([
      `${leak}:1: dynamic load of a minting module`,
      `${leak}:2: dynamic load of a minting module`,
      `${leak}:3: import-equals of a minting module`,
      `${leak}:4: dynamic load of a minting module`,
    ]);
  });

  it('flags loads with a computed specifier in core and runtime sources', () => {
    const text = [
      "const name = '../db/catalogue.js';",
      'const a = await import(name);',
      'const b = await import(`./version-rules.js`);',
      'const c = await import(`../${name}`);',
      'const d = require(name);',
      'const req = createRequire(import.meta.url);',
      'const e = req(name);',
      'const f = module.createRequire(import.meta.url)(name);',
      "const g = await import('./names.js');",
    ].join('\n');
    const computed = [2, 3, 4, 5, 7, 8].map(
      (line) => `${leak}:${line}: dynamic load with a computed specifier`,
    );
    expect(findMintViolations(leak, text)).toEqual(computed);
    expect(findMintViolations('packages/runtime-node/src/a.ts', 'await import(name);')).toEqual([
      'packages/runtime-node/src/a.ts:1: dynamic load with a computed specifier',
    ]);
    expect(findMintViolations('packages/runtime-cloudflare/src/a.ts', 'require(`x`);')).toEqual([
      'packages/runtime-cloudflare/src/a.ts:1: dynamic load with a computed specifier',
    ]);
  });

  it('checks literal loads elsewhere and leaves computed ones to the boundary rule', () => {
    const file = 'packages/cli/src/a.ts';
    expect(
      findMintViolations(
        file,
        'await import(outfile);\nawait import(`@package-broker/core/authz/fence`);',
      ),
    ).toEqual([`${file}:2: dynamic load of a minting module`]);
  });

  it('resolves package import aliases', () => {
    const imports = {
      '#rules': './src/catalogue/version-rules.js',
      '#core/*': '@package-broker/core/*',
    };
    expect(
      findMintViolations(
        'packages/core/src/x.ts',
        "import * as r from '#rules';\nimport { fenceGuard } from '#core/authz/fence';",
        imports,
      ),
    ).toEqual([
      'packages/core/src/x.ts:1: namespace import of a minting module',
      'packages/core/src/x.ts:2: fenceGuard',
    ]);
  });

  it('allows db-sqlite sources to import but not to re-export a mint', () => {
    const file = 'packages/db-sqlite/src/repositories/w.ts';
    expect(
      findMintViolations(
        file,
        [
          "import { catalogueWriteGuard } from '@package-broker/core/db/catalogue';",
          "import * as rules from '@package-broker/core/catalogue/version-rules';",
          "const m = await import('@package-broker/core/authz/fence');",
        ].join('\n'),
      ),
    ).toEqual([]);
    expect(
      findMintViolations(
        file,
        [
          "import { completeSourceListing as c } from '@package-broker/core/catalogue/version-rules';",
          'export { c };',
          "export * from '@package-broker/core/db/catalogue';",
        ].join('\n'),
      ),
    ).toEqual([`${file}:2: re-export c`, `${file}:3: export * of a minting module`]);
    expect(
      findMintViolations(
        file,
        [
          "import { catalogueWriteGuard as g, validateLimit } from '@package-broker/core/db/catalogue';",
          'export default g;',
          'export const h = g;',
          'export const v = validateLimit;',
          'const local = g;',
        ].join('\n'),
      ),
    ).toEqual([`${file}:2: re-export g`, `${file}:3: re-export g`]);
  });

  it('restricts the job, token and delegated fence issuers to kernel, platform and db-sqlite', () => {
    const issuers = [
      "import { systemMutationFence } from '@package-broker/core/authz/fence';",
      "import { tokenMutationFence as t } from '@package-broker/core/authz/fence';",
      "import { delegatedMutationFence } from '@package-broker/core/authz/fence';",
    ].join('\n');
    for (const file of [
      'packages/plugin-github/src/a.ts',
      'packages/core/src/sources/routes.ts',
      'packages/core/src/authz/administration.ts',
      'packages/runtime-node/src/a.ts',
    ]) {
      expect(findMintViolations(file, issuers)).toEqual([
        `${file}:1: systemMutationFence`,
        `${file}:2: tokenMutationFence`,
        `${file}:3: delegatedMutationFence`,
      ]);
    }
    for (const file of [
      'packages/core/src/kernel/k.ts',
      'packages/core/src/platform/runner.ts',
      'packages/db-sqlite/src/repositories/w.ts',
    ]) {
      expect(findMintViolations(file, issuers)).toEqual([]);
    }
  });

  it('keeps fenceGuard and namespace or dynamic loads of fence out of kernel and platform', () => {
    const file = 'packages/core/src/kernel/k.ts';
    expect(
      findMintViolations(
        file,
        [
          "import { fenceGuard, systemMutationFence } from '../authz/fence.js';",
          "import * as fence from '../authz/fence.js';",
          "const f = await import('../authz/fence.js');",
          'export { systemMutationFence };',
        ].join('\n'),
      ),
    ).toEqual([
      `${file}:1: fenceGuard`,
      `${file}:2: namespace import of a minting module`,
      `${file}:3: dynamic load of a minting module`,
      `${file}:4: re-export systemMutationFence`,
    ]);
  });

  it("exempts tests; defining modules may not re-export another module's mints", () => {
    const text = "import * as c from '../db/catalogue.js';\nexport * from './version-rules.js';";
    expect(findMintViolations('packages/core/src/catalogue/x.test.ts', text)).toEqual([]);
    const fence = 'packages/core/src/authz/fence.ts';
    expect(
      findMintViolations(
        fence,
        [
          'export function fenceGuard() {}',
          "export { catalogueWriteGuard } from '../db/catalogue.js';",
          "export * from '../catalogue/version-rules.js';",
        ].join('\n'),
      ),
    ).toEqual([
      `${fence}:2: re-export catalogueWriteGuard`,
      `${fence}:3: export * of a minting module`,
    ]);
  });

  for (const pkg of packageNames()) {
    it(`${pkg} does not reach write guards or proofs outside db-sqlite`, () => {
      const manifest = JSON.parse(
        readFileSync(path.join(REPO_ROOT, 'packages', pkg, 'package.json'), 'utf8'),
      ) as { imports?: PackageImports };
      const violations = sourceFiles(pkg).flatMap((file) =>
        findMintViolations(
          file,
          readFileSync(path.join(REPO_ROOT, file), 'utf8'),
          manifest.imports,
        ),
      );
      expect(violations).toEqual([]);
    });
  }
});

describe('core-only access context', () => {
  const check = (file: string, text: string, imports: PackageImports = {}): string[] =>
    findMintViolations(file, text, imports, ACCESS_CONTEXT_RULE);

  it('flags plugin imports of the setter and readers by any route', () => {
    const file = 'packages/plugin-x/src/a.ts';
    expect(
      check(
        file,
        [
          "import { setAccessContext } from '@package-broker/core/authz/access-context';",
          "import { accessContextOf as read } from '@package-broker/core/authz/access-context.js';",
          "import * as access from '@package-broker/core/authz/access-context';",
          "const m = await import('@package-broker/core/authz/access-context');",
          "export { organizationActorOf } from '@package-broker/core/authz/access-context';",
          "import type { AccessContextSnapshot } from '@package-broker/core/authz/access-context';",
        ].join('\n'),
      ),
    ).toEqual([
      `${file}:1: setAccessContext`,
      `${file}:2: accessContextOf`,
      `${file}:3: namespace import of a minting module`,
      `${file}:4: dynamic load of a minting module`,
      `${file}:5: re-export organizationActorOf`,
    ]);
  });

  it('allows core and the runtimes to import but not to re-export them', () => {
    const text =
      "import { setAccessContext, accessContextOf } from '@package-broker/core/authz/access-context';";
    for (const file of [
      'packages/core/src/kernel/kernel.ts',
      'packages/runtime-node/src/a.ts',
      'packages/runtime-cloudflare/src/a.ts',
    ]) {
      expect(check(file, text)).toEqual([]);
    }
    expect(
      check(
        'packages/core/src/index.ts',
        "export { setAccessContext } from './authz/access-context.js';",
      ),
    ).toEqual(['packages/core/src/index.ts:1: re-export setAccessContext']);
    expect(check('packages/db-sqlite/src/a.ts', text)).toEqual([
      'packages/db-sqlite/src/a.ts:1: setAccessContext',
      'packages/db-sqlite/src/a.ts:1: accessContextOf',
    ]);
  });

  for (const pkg of packageNames()) {
    it(`${pkg} reaches the access context only from core and the runtimes`, () => {
      const manifest = JSON.parse(
        readFileSync(path.join(REPO_ROOT, 'packages', pkg, 'package.json'), 'utf8'),
      ) as { imports?: PackageImports };
      const violations = sourceFiles(pkg).flatMap((file) =>
        check(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'), manifest.imports),
      );
      expect(violations).toEqual([]);
    });
  }
});
