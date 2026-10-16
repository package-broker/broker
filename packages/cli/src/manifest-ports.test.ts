import { type PluginDefinition, type RouteDefinition } from '@package-broker/core/plugin';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderManifestFromConfig, renderManifestJson, validatePlugins } from './manifest.js';

const handler = () => new Response('ok');

function plugin(id: string, overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id,
    package: `@test/${id}`,
    apiVersion: 3,
    platforms: ['node'],
    ...overrides,
  };
}

function routed(id: string, route: Pick<RouteDefinition, 'method' | 'path' | 'permission'>) {
  return plugin(id, { register: (r) => r.route({ ...route, handler }) });
}

describe('validatePlugins with the kernel registry', () => {
  it('reports two plugins binding the same port', () => {
    const errors = validatePlugins(
      [plugin('a', { binds: ['source'] }), plugin('b', { binds: ['source'] })],
      'node',
    );
    expect(errors.join('\n')).toMatch(/port "source" is bound by plugins "a" and "b"/);
  });

  it('reports a bind outside source and identity', () => {
    const errors = validatePlugins([plugin('a', { binds: ['database'] as never })], 'node');
    expect(errors.join('\n')).toMatch(/cannot bind port "database"/);
  });

  it('reports an unknown definition key', () => {
    const errors = validatePlugins([{ ...plugin('a'), extra: 1 } as never], 'node');
    expect(errors.join('\n')).toMatch(/unknown key "extra"/);
  });

  it('reports conflicting routes', () => {
    const errors = validatePlugins(
      [
        routed('a', { method: 'GET', path: '/x/:a', permission: null }),
        routed('b', { method: 'GET', path: '/x/:b', permission: null }),
      ],
      'node',
    );
    expect(errors.join('\n')).toMatch(/conflicts with/);
  });

  it('returns nothing for a valid set', () => {
    expect(
      validatePlugins([routed('a', { method: 'GET', path: '/a', permission: null })], 'node'),
    ).toEqual([]);
  });
});

describe('renderManifestJson', () => {
  it('lists binds, bindings, routes with permissions and migrations without sql', () => {
    const plugins = [
      plugin('a', {
        binds: ['source'],
        sourceProviders: () => [],
        register: (r) =>
          r.route({
            method: 'GET',
            path: '/a',
            permission: 'org:read',
            boundary: 'organization',
            handler,
          }),
      }),
    ];
    const registration = collectRegistrations(plugins);
    const manifest = renderManifestJson(plugins, new Map(), 'node', {
      registration,
      migrations: [
        {
          id: 'core/0001_init',
          owner: 'core',
          name: '0001_init.sql',
          sequence: 1,
          sql: 'CREATE TABLE t (id TEXT);',
          checksum: 'abc',
          phase: 'expand',
        },
      ],
    });
    expect(manifest.plugins[0]?.binds).toEqual(['source']);
    expect(manifest.bindings).toEqual([{ port: 'source', plugin: 'a' }]);
    expect(manifest.routes).toEqual([
      { method: 'GET', path: '/a', plugin: 'a', permission: 'org:read' },
    ]);
    expect(manifest.migrations).toEqual([
      { id: 'core/0001_init', name: '0001_init.sql', checksum: 'abc', phase: 'expand' },
    ]);
    expect(JSON.stringify(manifest)).not.toContain('CREATE TABLE');
  });

  it('defaults to empty lists', () => {
    const manifest = renderManifestJson([plugin('a')], new Map(), 'node');
    expect(manifest.plugins[0]?.binds).toEqual([]);
    expect([manifest.bindings, manifest.routes, manifest.migrations]).toEqual([[], [], []]);
  });
});

describe('renderManifestFromConfig', () => {
  it('re-exports the configured plugins and migrations', () => {
    expect(renderManifestFromConfig('/abs/broker.config.ts', [])).toBe(
      "import config from '/abs/broker.config.ts';\nexport const plugins = config.plugins;\nexport const migrations = [];\n",
    );
  });

  it('omits migrations when undefined', () => {
    expect(renderManifestFromConfig('/abs/broker.config.ts')).toBe(
      "import config from '/abs/broker.config.ts';\nexport const plugins = config.plugins;\n",
    );
  });

  it('rejects a path with a quote or newline', () => {
    expect(() => renderManifestFromConfig("/a'b/broker.config.ts")).toThrow();
    expect(() => renderManifestFromConfig('/a\nb/broker.config.ts')).toThrow();
  });

  it('runs the configured instances, factory options included', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pb-manifest-'));
    try {
      const configPath = path.join(dir, 'broker.config.ts');
      await writeFile(
        configPath,
        [
          'const factory = (opts: { path: string }) => ({',
          "  id: 'opt',",
          "  package: '@test/opt',",
          '  apiVersion: 3,',
          "  platforms: ['node'],",
          "  register: (r: any) => r.route({ method: 'GET', path: opts.path, permission: null, handler: () => new Response('ok') }),",
          '});',
          "export default { plugins: [factory({ path: '/a' })] };",
          '',
        ].join('\n'),
      );
      const manifestPath = path.join(dir, 'manifest.ts');
      await writeFile(manifestPath, renderManifestFromConfig(configPath.split(path.sep).join('/')));
      const manifest = (await import(/* @vite-ignore */ manifestPath)) as {
        plugins: PluginDefinition[];
      };
      expect(collectRegistrations(manifest.plugins).routes.map((route) => route.path)).toEqual([
        '/a',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
