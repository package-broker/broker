import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type ExportTarget = string | null | { [condition: string]: ExportTarget };

const packageRoot = new URL('../', import.meta.url);
const { exports: exportsMap } = JSON.parse(
  readFileSync(new URL('package.json', packageRoot), 'utf8'),
) as { exports: Record<string, ExportTarget> };

function targets(target: ExportTarget): string[] {
  if (target === null) return [];
  if (typeof target === 'string') return [target];
  return Object.values(target).flatMap(targets);
}

function capture(pattern: string, value: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === value ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return value.startsWith(prefix) &&
    value.endsWith(suffix) &&
    value.length >= prefix.length + suffix.length
    ? value.slice(prefix.length, value.length - suffix.length)
    : undefined;
}

function resolve(subpath: string): string[] {
  if (Object.hasOwn(exportsMap, subpath)) return targets(exportsMap[subpath]!);
  const patterns = Object.keys(exportsMap)
    .filter((key) => key.includes('*') && capture(key, subpath) !== undefined)
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
  const pattern = patterns[0];
  if (pattern === undefined) return [];
  const replacement = capture(pattern, subpath)!;
  return targets(exportsMap[pattern]!).map((target) => target.replaceAll('*', replacement));
}

const definingModules = globSync('**/*.ts', { cwd: fileURLToPath(new URL('src/', packageRoot)) })
  .filter((path) => !path.endsWith('.test.ts'))
  .filter((path) =>
    /export function registerCoreJob\(/.test(
      readFileSync(new URL(`src/${path}`, packageRoot), 'utf8'),
    ),
  );

describe('core exports', () => {
  it('does not export registerCoreJob from any reachable kernel module', () => {
    const files = globSync('kernel/**/*.ts', {
      cwd: fileURLToPath(new URL('src/', packageRoot)),
    }).filter((file) => !file.endsWith('.test.ts'));
    const program = ts.createProgram(
      files.map((file) => fileURLToPath(new URL(`src/${file}`, packageRoot))),
      { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
    );
    const checker = program.getTypeChecker();
    const reachable: string[] = [];
    for (const file of files) {
      const subpath = `./${file.replace(/\.ts$/, '')}`;
      if (!resolve(subpath).includes(`./dist/${file.replace(/\.ts$/, '.js')}`)) continue;
      const source = program.getSourceFile(fileURLToPath(new URL(`src/${file}`, packageRoot)));
      const symbol = source && checker.getSymbolAtLocation(source);
      expect(symbol).toBeDefined();
      if (
        symbol &&
        checker.getExportsOfModule(symbol).some((item) => item.name === 'registerCoreJob')
      ) {
        reachable.push(subpath);
      }
    }
    expect(reachable).toEqual([]);
  });

  it('finds the module defining registerCoreJob', () => {
    expect(definingModules).toHaveLength(1);
  });

  it.each(['js', 'd.ts'])(
    'exposes registerCoreJob only through runtime %s targets',
    (extension) => {
      const reachable: string[] = [];
      for (const module of definingModules) {
        const modulePath = `./dist/${module.replace(/\.ts$/, `.${extension}`)}`;
        for (const [subpath, target] of Object.entries(exportsMap)) {
          for (const pattern of targets(target)) {
            const replacement = capture(pattern, modulePath);
            if (replacement === undefined) continue;
            const candidate = subpath.replaceAll('*', replacement);
            if (resolve(candidate).includes(modulePath)) reachable.push(candidate);
          }
        }
      }
      expect(reachable).toEqual(['./runtime/core-jobs']);
    },
  );
});
