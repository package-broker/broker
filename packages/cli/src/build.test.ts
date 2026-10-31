import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegistrations, KernelConfigError } from '@package-broker/core/kernel/registry';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build, BuildDiagnosticsError, declarationOnlyPackageResolver } from './build.js';

const metadataOverrides = vi.hoisted(() => new Map<string, unknown>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const metadata = metadataOverrides.get(String(args[0]));
      if (metadata !== undefined) return Promise.resolve(JSON.stringify(metadata));
      return actual.readFile(...args);
    },
  };
});

const cliRequire = createRequire(import.meta.url);
const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  metadataOverrides.clear();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const NODE_PORTS = {
  blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 50_000_000 },
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

describe('build source provenance', () => {
  it('records HEAD and clean, tracked and untracked worktree changes, with a CI override', async () => {
    vi.stubEnv('GITHUB_SHA', undefined);
    const options = await fixture(routeSource(''));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8' }).trim();
    await writeFile(path.join(options.cwd, '.gitignore'), 'node_modules\n.pb\n');
    git('init', '--quiet');
    git('add', 'broker.config.ts', 'runtime.ts', '.gitignore');
    git(
      '-c',
      'user.name=Build Test',
      '-c',
      'user.email=build@example.test',
      'commit',
      '--no-gpg-sign',
      '-s',
      '--quiet',
      '-m',
      'fixture',
    );
    const head = git('rev-parse', 'HEAD');
    const info = async () => JSON.parse(await readFile((await build(options)).buildInfo, 'utf8'));
    expect(await info()).toMatchObject({ gitSha: head, dirty: false });
    await writeFile(options.runtimeEntry, "export { platformPorts } from '#pb-manifest';\n");
    expect(await info()).toMatchObject({ gitSha: head, dirty: true });
    git('checkout', '--', 'runtime.ts');
    await writeFile(path.join(options.cwd, 'untracked.txt'), 'untracked');
    expect(await info()).toMatchObject({ gitSha: head, dirty: true });
    const ciSha = 'f'.repeat(40);
    vi.stubEnv('GITHUB_SHA', ciSha);
    expect(await info()).toMatchObject({ gitSha: ciSha, dirty: true });
  });

  it('records null provenance outside a checkout and still honors a CI revision', async () => {
    vi.stubEnv('GITHUB_SHA', undefined);
    const options = await fixture(routeSource(''));
    const info = async () => JSON.parse(await readFile((await build(options)).buildInfo, 'utf8'));
    expect(await info()).toMatchObject({ gitSha: null, dirty: null });
    vi.stubEnv('GITHUB_SHA', 'e'.repeat(40));
    expect(await info()).toMatchObject({ gitSha: 'e'.repeat(40), dirty: null });
  });
});

describe('local-auth runtime capability', () => {
  function metadata(runtimeMarker: boolean) {
    for (const name of ['cli', 'core', 'runtime-node']) {
      const supported = name === 'runtime-node' ? runtimeMarker : !runtimeMarker;
      metadataOverrides.set(cliRequire.resolve(`@package-broker/${name}/package.json`), {
        version: '2.0.0-rc.4',
        ...(supported ? { packageBroker: { localAuth: 1 } } : {}),
      });
    }
  }

  it.each([true, false])(
    'takes default-build capability from the runtime marker: %s',
    async (supported) => {
      metadata(supported);
      const fixtureOptions = await fixture(routeSource(''));
      const options = { cwd: fixtureOptions.cwd, configPath: fixtureOptions.configPath };
      const result = await build(options);
      const manifest = JSON.parse(await readFile(result.manifestJson, 'utf8'));
      if (supported) expect(manifest.localAuth).toEqual({ version: 1 });
      else expect(manifest).not.toHaveProperty('localAuth');
    },
  );

  it('omits capability for a custom entry even when the runtime has the marker', async () => {
    metadata(true);
    const options = await fixture(routeSource(''));
    const result = await build(options);
    expect(JSON.parse(await readFile(result.manifestJson, 'utf8'))).not.toHaveProperty('localAuth');
  });
});
