import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegistrations, KernelConfigError } from '@package-broker/core/kernel/registry';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { afterEach, describe, expect, it } from 'vitest';
import { build, BuildDiagnosticsError, declarationOnlyPackageResolver } from './build.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const NODE_PORTS = {
  blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 1024 },
  cache: { adapter: 'lru', maxBytes: 1024 },
  jobs: { adapter: 'database', maxRunning: 2 },
  observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
};

function routeSource(overrides: string): string {
  return `{ method: 'GET', path: '/widgets/:project/pkg/:name', permission: 'project:packages:read', boundary: 'package', package: { ecosystem: 'npm', name: (params) => params.name ?? null }, handler: () => new Response(null), ${overrides} }`;
}

async function fixture(route: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pb-package-route-'));
  dirs.push(cwd);
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(cwd, 'node_modules'),
    'dir',
  );
  const configPath = path.join(cwd, 'broker.config.ts');
  const runtimeEntry = path.join(cwd, 'runtime.ts');
  await writeFile(
    configPath,
    `export default { platform: 'node', plugins: [{ id: 'widgets', package: '@package-broker/core', apiVersion: 3, platforms: ['node'], register: (r) => r.route(${route}) }], platformPorts: { node: ${JSON.stringify(NODE_PORTS)} } };`,
  );
  await writeFile(runtimeEntry, "export { platformPorts } from '#pb-manifest';");
  return { cwd, configPath, runtimeEntry };
}

describe('build-time package resolver', () => {
  it('accepts a package-boundary route and records it in the manifest', async () => {
    const options = await fixture(routeSource(''));
    const result = await build(options);
    const manifest = JSON.parse(await readFile(result.manifestJson, 'utf8')) as {
      routes: { path: string; boundary?: string }[];
    };
    expect(manifest.routes.map((route) => [route.path, route.boundary])).toEqual([
      ['/widgets/:project/pkg/:name', 'package'],
    ]);
  });

  it.each([
    ['a path without :project', "path: '/widgets/pkg/:name'", ':project in the path'],
    ['a permission outside the package boundary set', "permission: 'org:read'", 'reserved for'],
    ['an unknown ecosystem', "package: { ecosystem: 'pypi', name: () => null }", 'ecosystem'],
    ['a missing binding', 'package: undefined', 'package binding'],
  ])('rejects %s', async (_label, overrides, problem) => {
    const options = await fixture(routeSource(overrides));
    const failure = await build(options).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BuildDiagnosticsError);
    expect((failure as BuildDiagnosticsError).problems.join('\n')).toContain(problem);
  });

  it('never resolves a package', async () => {
    const plugin: PluginDefinition = {
      id: 'widgets',
      package: '@test/widgets',
      apiVersion: 3,
      platforms: ['node'],
      register: (registry) =>
        registry.route({
          method: 'GET',
          path: '/widgets/:project/pkg/:name',
          permission: 'project:packages:read',
          boundary: 'package',
          package: { ecosystem: 'npm', name: (params) => params['name'] ?? null },
          handler: () => new Response(null),
        }),
    };
    expect(() =>
      collectRegistrations([plugin], { packageResolver: declarationOnlyPackageResolver }),
    ).not.toThrow();
    expect(() => collectRegistrations([plugin])).toThrow(KernelConfigError);
    await expect(
      declarationOnlyPackageResolver.resolve({} as never, 'npm', 'left-pad'),
    ).rejects.toThrow('declarations only');
  });
});

describe('build vulnerability configuration', () => {
  it.each([undefined, {}, { enabled: true }, { enabled: false }])(
    'accepts %j and exports it from the configured manifest',
    async (vulnerability) => {
      const options = await fixture(routeSource(''));
      await writeFile(
        options.configPath,
        `export default { platform: 'node', plugins: [], platformPorts: { node: ${JSON.stringify(NODE_PORTS)} }, vulnerability: ${JSON.stringify(vulnerability)} };`,
      );
      await writeFile(options.runtimeEntry, "export { vulnerability } from '#pb-manifest';");
      const result = await build(options);
      expect(await readFile(result.manifestTs, 'utf8')).toContain(
        'export const vulnerability = config.vulnerability;',
      );
    },
  );
  it.each([false, null, { enabled: 'false' }, { extra: true }])(
    'rejects invalid %j before emitting a build',
    async (vulnerability) => {
      const options = await fixture(routeSource(''));
      await writeFile(
        options.configPath,
        `export default { platform: 'node', plugins: [], vulnerability: ${JSON.stringify(vulnerability)} };`,
      );
      await expect(build(options)).rejects.toBeInstanceOf(BuildDiagnosticsError);
    },
  );
});
