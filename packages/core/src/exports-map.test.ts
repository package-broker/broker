import { execFileSync } from 'node:child_process';
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import ts from 'typescript';

const packageRoot = new URL('../', import.meta.url);
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'pb-core-exports-')));
const installed = join(fixture, 'node_modules/@package-broker/core');
mkdirSync(installed, { recursive: true });
writeFileSync(join(installed, 'package.json'), readFileSync(new URL('package.json', packageRoot)));
const modules = globSync('**/*.ts', { cwd: fileURLToPath(new URL('src/', packageRoot)) }).filter(
  (file) => !file.endsWith('.test.ts'),
);
// Mirror current source modules, so stale build output cannot hide a reachable internal module.
for (const file of modules) {
  const target = join(installed, 'dist', file.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'export {};');
}
const consumer = createRequire(join(fixture, 'consumer.cjs'));
const esmConsumer = join(fixture, 'consumer.mjs');
writeFileSync(
  esmConsumer,
  `
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  const results = Object.fromEntries(JSON.parse(readFileSync(0, 'utf8')).map(path => {
    try { return [path, { path: fileURLToPath(import.meta.resolve('@package-broker/core/' + path)) }]; }
    catch (error) { return [path, { code: error.code }]; }
  }));
  process.stdout.write(JSON.stringify(results));
`,
);
const esmPaths = new Set(modules.map((file) => file.replace(/\.ts$/, '')));
for (const file of modules.filter((file) => file.startsWith('internal/'))) {
  const path = file.replace(/\.ts$/, '');
  for (const specifier of internalSpecifiers(path)) esmPaths.add(specifier);
}
const ESM_CONDITIONS = ['default', 'workerd', 'worker', 'browser'] as const;
const esmResultsByCondition = Object.fromEntries(
  ESM_CONDITIONS.map((condition) => [
    condition,
    JSON.parse(
      execFileSync(
        process.execPath,
        [...(condition === 'default' ? [] : [`--conditions=${condition}`]), esmConsumer],
        { input: JSON.stringify([...esmPaths]), encoding: 'utf8' },
      ),
    ) as Record<string, { path?: string; code?: string }>,
  ]),
);

function internalSpecifiers(path: string): string[] {
  return [
    path,
    path.replace('/', '//'),
    path.replace('internal', '%69nternal'),
    `dist/${path}.js`,
    `kernel/../${path}`,
    `kernel/%2e%2e/${path}`,
  ];
}
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function resolve(subpath: string): string | null {
  try {
    return consumer.resolve(`@package-broker/core/${subpath}`);
  } catch (error) {
    expect([
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
      'MODULE_NOT_FOUND',
      'ERR_INVALID_MODULE_SPECIFIER',
    ]).toContain((error as NodeJS.ErrnoException).code);
    return null;
  }
}

describe('core exports from an installed consumer', () => {
  it('resolves a real public module', () => {
    for (const subpath of ['kernel/org', 'runtime/core-jobs']) {
      const target = join(installed, `dist/${subpath}.js`);
      expect(resolve(subpath)).toBe(target);
      for (const condition of ESM_CONDITIONS) {
        expect(esmResultsByCondition[condition]![subpath]?.path, condition).toBe(target);
      }
    }
  });

  it('keeps every internal module outside wildcard exports', () => {
    const internal = modules.filter((file) => file.startsWith('internal/'));
    expect(internal).toContain('internal/audit-trail-context.ts');
    for (const file of internal) {
      const path = file.replace(/\.ts$/, '');
      for (const specifier of internalSpecifiers(path)) {
        expect(() => consumer.resolve(`@package-broker/core/${specifier}`)).toThrow();
        try {
          consumer.resolve(`@package-broker/core/${specifier}`);
        } catch (error) {
          expect(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_INVALID_MODULE_SPECIFIER']).toContain(
            (error as NodeJS.ErrnoException).code,
          );
        }
        for (const condition of ESM_CONDITIONS) {
          const result = esmResultsByCondition[condition]![specifier];
          expect(result?.path, `${condition} ${specifier}`).toBeUndefined();
          expect(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_INVALID_MODULE_SPECIFIER']).toContain(
            result?.code,
          );
        }
      }
    }
  });

  it('keeps audit context creation internal and job authority in its runtime module', () => {
    const publicFiles = modules.filter((file) => resolve(file.replace(/\.ts$/, '')) !== null);
    const paths = publicFiles.map((file) => fileURLToPath(new URL(`src/${file}`, packageRoot)));
    const program = ts.createProgram(paths, {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const checker = program.getTypeChecker();
    for (const path of paths) {
      const source = program.getSourceFile(path)!;
      const symbol = checker.getSymbolAtLocation(source);
      if (symbol === undefined) continue;
      const exports = checker.getExportsOfModule(symbol).map((item) => item.name);
      if (!path.endsWith('/runtime/core-jobs.ts')) {
        expect(exports, path).not.toContain('registerCoreJob');
        expect(exports, path).not.toContain('isRegisteredCoreJob');
      }
      expect(exports, path).not.toContain('createAuditTrailContext');
    }
  });
});
