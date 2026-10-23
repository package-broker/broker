import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describePlatformPorts,
  renderBuildInfo,
  renderBuildManifest,
  renderNodePackageJson,
  writeOutputPackageJson,
} from './build-artifacts.js';
import { build, readNodeDriverVersion } from './build.js';

describe('renderBuildInfo', () => {
  it('renders the complete build metadata with indentation and a trailing newline', () => {
    expect(
      renderBuildInfo({
        schemaVersion: 1,
        target: 'node',
        core: '2.0.0-rc.0',
        plugins: { '@example/plugin': '1.2.3' },
        lockfileSha256: 'abc123',
        gitSha: 'def456',
      }),
    ).toBe(
      '{\n  "schemaVersion": 1,\n  "target": "node",\n  "core": "2.0.0-rc.0",\n  "plugins": {\n    "@example/plugin": "1.2.3"\n  },\n  "lockfileSha256": "abc123",\n  "gitSha": "def456"\n}\n',
    );
  });

  it('preserves absent provenance as null for Cloudflare', () => {
    const info = {
      schemaVersion: 1 as const,
      target: 'cloudflare' as const,
      core: '2.0.0-rc.0',
      plugins: {},
      lockfileSha256: null,
      gitSha: null,
    };
    expect(JSON.parse(renderBuildInfo(info))).toEqual(info);
  });
});

describe('renderNodePackageJson', () => {
  it('renders an installable ESM package with the supplied exact driver version', () => {
    expect(renderNodePackageJson('13.0.3')).toBe(
      '{\n  "name": "package-broker-node",\n  "private": true,\n  "type": "module",\n  "pbGenerated": true,\n  "dependencies": {\n    "better-sqlite3": "13.0.3"\n  }\n}\n',
    );
    expect(JSON.parse(renderNodePackageJson('12.4.1')).dependencies).toEqual({
      'better-sqlite3': '12.4.1',
    });
  });

  it('marks the package as generated so a rebuild recognises its own output', () => {
    expect(JSON.parse(renderNodePackageJson('13.0.3')).pbGenerated).toBe(true);
  });
});

describe('writeOutputPackageJson', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'pb-out-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('refuses to overwrite a package.json that pb did not generate and leaves it untouched', async () => {
    const packageJson = path.join(outDir, 'package.json');
    const foreign = '{\n  "name": "operator-project",\n  "private": true\n}\n';
    await writeFile(packageJson, foreign);

    await expect(
      writeOutputPackageJson(packageJson, renderNodePackageJson('13.0.3')),
    ).rejects.toThrow(/package\.json.*--out/s);
    expect(await readFile(packageJson, 'utf8')).toBe(foreign);
  });

  it('refuses to remove a package.json that pb did not generate', async () => {
    const packageJson = path.join(outDir, 'package.json');
    const foreign = '{ "name": "operator-project" }\n';
    await writeFile(packageJson, foreign);

    await expect(writeOutputPackageJson(packageJson, null)).rejects.toThrow(
      /refusing to remove.*--out/s,
    );
    expect(await readFile(packageJson, 'utf8')).toBe(foreign);
  });

  it('creates and then replaces its own generated package.json for the node target', async () => {
    const packageJson = path.join(outDir, 'package.json');
    await writeOutputPackageJson(packageJson, renderNodePackageJson('12.0.0'));

    const replacement = renderNodePackageJson('13.0.3');
    await writeOutputPackageJson(packageJson, replacement);

    expect(await readFile(packageJson, 'utf8')).toBe(replacement);
  });

  it('removes its own generated package.json for the cloudflare target', async () => {
    const packageJson = path.join(outDir, 'package.json');
    await writeOutputPackageJson(packageJson, renderNodePackageJson('13.0.3'));

    await writeOutputPackageJson(packageJson, null);

    await expect(readFile(packageJson, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function resolveSpecifier(contents: string): Promise<{ resolved: string[]; output: string }> {
  const resolved: string[] = [];
  const result = await bundle({
    stdin: { contents, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'esm',
    plugins: [
      {
        name: 'config-fixture',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            resolved.push(args.path);
            return { path: args.path, namespace: 'config-fixture' };
          });
          build.onLoad({ filter: /.*/, namespace: 'config-fixture' }, () => ({
            contents: 'export default { plugins: ["intended config"] };',
          }));
        },
      },
    ],
  });
  return { resolved, output: result.outputFiles?.[0]?.text ?? '' };
}

function manifestBody(ids: string[]): string[] {
  return [
    `const orderedPluginIds = ${JSON.stringify(ids)};`,
    'const pluginsById = new Map(config.plugins.map((plugin) => [plugin.id, plugin]));',
    'export const plugins = orderedPluginIds.map((id) => {',
    '  const plugin = pluginsById.get(id);',
    '  if (plugin === undefined) throw new Error(`plugin "${id}" is missing from config.plugins`);',
    '  return plugin;',
    '});',
    'if (plugins.length !== config.plugins.length) {',
    '  throw new Error(`config.plugins has ${config.plugins.length} plugins, expected ${plugins.length}`);',
    '}',
  ];
}

describe('renderBuildManifest', () => {
  it('parses and imports Windows config paths with forward slashes and escaped characters', async () => {
    const configPath = String.raw`C:\broker files\owner's "config".ts`;
    const { resolved, output } = await resolveSpecifier(
      renderBuildManifest(configPath, [], [], 'win32'),
    );
    expect(resolved).toEqual([`C:/broker files/owner's "config".ts`]);
    expect(output).toContain('intended config');
    expect(output).toContain('migrations');
  });

  it('renders a Windows path with forward slashes', () => {
    expect(renderBuildManifest(String.raw`C:\broker files\config.ts`, [], undefined, 'win32')).toBe(
      [
        'import config from "C:/broker files/config.ts";',
        ...manifestBody([]),
        'export const platformPorts = null;',
        'export const observability = config.observability;',
        'export const registry = config.registry;',
        'export const tokens = config.tokens;',
        'export const vulnerability = config.vulnerability;',
        'export const mcp = config.mcp;',
        '',
      ].join('\n'),
    );
  });

  it('renders the ordered ids and the load-time guards for a non-empty list', () => {
    expect(renderBuildManifest('/srv/config.ts', ['a', 'b'], undefined, 'linux')).toBe(
      [
        'import config from "/srv/config.ts";',
        'const orderedPluginIds = ["a","b"];',
        'const pluginsById = new Map(config.plugins.map((plugin) => [plugin.id, plugin]));',
        'export const plugins = orderedPluginIds.map((id) => {',
        '  const plugin = pluginsById.get(id);',
        '  if (plugin === undefined) throw new Error(`plugin "${id}" is missing from config.plugins`);',
        '  return plugin;',
        '});',
        'if (plugins.length !== config.plugins.length) {',
        '  throw new Error(`config.plugins has ${config.plugins.length} plugins, expected ${plugins.length}`);',
        '}',
        'export const platformPorts = null;',
        'export const observability = config.observability;',
        'export const registry = config.registry;',
        'export const tokens = config.tokens;',
        'export const vulnerability = config.vulnerability;',
        'export const mcp = config.mcp;',
        '',
      ].join('\n'),
    );
  });

  it('renders an empty ordered list', () => {
    expect(renderBuildManifest('/srv/config.ts', [], undefined, 'linux')).toContain(
      'const orderedPluginIds = [];\n',
    );
  });

  it('keeps a backslash of a POSIX path, where it is an ordinary filename character', async () => {
    const configPath = String.raw`/srv/broker\config.ts`;
    const { resolved, output } = await resolveSpecifier(
      renderBuildManifest(configPath, [], undefined, 'linux'),
    );
    expect(resolved).toEqual([configPath]);
    expect(renderBuildManifest(configPath, [], undefined, 'linux')).toBe(
      [
        String.raw`import config from "/srv/broker\\config.ts";`,
        ...manifestBody([]),
        'export const platformPorts = null;',
        'export const observability = config.observability;',
        'export const registry = config.registry;',
        'export const tokens = config.tokens;',
        'export const vulnerability = config.vulnerability;',
        'export const mcp = config.mcp;',
        '',
      ].join('\n'),
    );
    expect(output).toContain('intended config');
  });
});

describe('readNodeDriverVersion', () => {
  const cliRoot = fileURLToPath(new URL('..', import.meta.url));
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'pb-driver-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('resolves the driver from the CLI package, not from the project directory', async () => {
    await writeFile(path.join(project, 'package.json'), '{ "name": "operator-project" }\n');
    await mkdir(path.join(project, 'node_modules', '@package-broker'), { recursive: true });
    await symlink(cliRoot, path.join(project, 'node_modules', '@package-broker', 'cli'), 'dir');

    expect(await readdir(path.join(project, 'node_modules', '@package-broker'))).toEqual(['cli']);

    await expect(readNodeDriverVersion()).resolves.toMatch(/^\d+\.\d+\.\d+$/);
    const linkedCliRequire = createRequire(
      path.join(project, 'node_modules', '@package-broker', 'cli', 'src', 'build.ts'),
    );
    await expect(readNodeDriverVersion(linkedCliRequire)).resolves.toMatch(/^\d+\.\d+\.\d+$/);
  });
});

const NODE_PORTS = {
  blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 67108864 },
  cache: { adapter: 'lru', maxBytes: 33554432 },
  jobs: { adapter: 'database', maxRunning: 2 },
  observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID' },
} as const;

const CLOUDFLARE_PORTS = {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 67108864 },
  cache: { adapter: 'cache-api', namespace: 'pb-metadata-v1' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: {
    adapter: 'workers',
    analyticsBinding: 'ANALYTICS',
    deploymentIdEnv: 'DEPLOYMENT_ID',
  },
} as const;

describe('describePlatformPorts', () => {
  it('describes an omitted stanza as null', () => {
    expect(describePlatformPorts(undefined)).toBeNull();
  });

  it('keeps references and budgets for every port', () => {
    expect(describePlatformPorts(NODE_PORTS)).toEqual(NODE_PORTS);
    expect(describePlatformPorts(CLOUDFLARE_PORTS)).toEqual(CLOUDFLARE_PORTS);
  });

  it('drops keys outside the known reference set and non-scalar values', () => {
    const described = describePlatformPorts({
      ...NODE_PORTS,
      blob: {
        ...NODE_PORTS.blob,
        secretValue: 'AKIAABCDEFGHIJKLMNOP',
        nested: { token: 'x' },
      },
    } as never);
    expect(JSON.stringify(described)).not.toContain('AKIA');
    expect(JSON.stringify(described)).not.toContain('nested');
    expect(described?.blob).toEqual(NODE_PORTS.blob);
  });
});

describe('renderBuildManifest platformPorts', () => {
  it('exports the selected description as a literal, without reading process env', () => {
    const rendered = renderBuildManifest('/srv/config.ts', [], undefined, 'linux', NODE_PORTS);
    expect(rendered).toContain(
      `export const platformPorts = ${JSON.stringify(NODE_PORTS, null, 2)};`,
    );
    expect(rendered).not.toContain('process.env');
    expect(rendered).toContain('import config from "/srv/config.ts";');
  });

  it('exports null when no stanza is configured', () => {
    const expected = 'export const platformPorts = null;\n';
    expect(renderBuildManifest('/srv/config.ts', [], undefined, 'linux', undefined)).toContain(
      expected,
    );
    expect(renderBuildManifest('/srv/config.ts', [], undefined, 'linux', null)).toContain(expected);
  });
});

describe('build with platformPorts', () => {
  const cliRoot = fileURLToPath(new URL('..', import.meta.url));
  let project: string;
  let runtimeEntry: string;

  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'pb-ports-'));
    runtimeEntry = path.join(project, 'runtime-entry.ts');
    await writeFile(
      runtimeEntry,
      "import { plugins, platformPorts } from '#pb-manifest';\nexport default { plugins, platformPorts };\n",
    );
    await symlink(path.join(cliRoot, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  async function writeConfig(platform: string, ports: unknown, plugins = '[]'): Promise<string> {
    const file = path.join(project, 'broker.config.ts');
    await writeFile(
      file,
      `export default { platform: ${JSON.stringify(platform)}, plugins: ${plugins}, platformPorts: ${JSON.stringify(ports)} } as never;
`,
    );
    return file;
  }

  async function readManifest(outDir: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(outDir, 'generated', 'manifest.json'), 'utf8'));
  }

  it.each([
    ['node', false],
    ['cloudflare', false],
    ['node', true],
    ['cloudflare', true],
  ] as const)(
    'keeps absolute build paths out of the entire %s deployment (custom output: %s)',
    async (target, customOutput) => {
      const root = await realpath(project);
      const config = await realpath(
        await writeConfig(target, { node: NODE_PORTS, cloudflare: CLOUDFLARE_PORTS }),
      );
      const cwd = customOutput ? path.join(root, 'invocation') : root;
      await mkdir(cwd, { recursive: true });
      const result = await build({
        configPath: config,
        target,
        cwd,
        runtimeEntry: await realpath(runtimeEntry),
        ...(customOutput ? { outDir: '../deploy output' } : {}),
      });
      const entries = await readdir(result.outDir, { recursive: true, withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(result.outDir, path.join(entry.parentPath, entry.name)));
      expect(files).toEqual(
        expect.arrayContaining([
          'metafile.json',
          path.join('generated', 'manifest.ts'),
          `${path.basename(result.bundle)}.map`,
        ]),
      );
      const forbidden = [root, fileURLToPath(new URL('../../..', import.meta.url)), homedir()];
      for (const file of files) {
        const contents = await readFile(path.join(result.outDir, file), 'utf8');
        for (const absolutePath of forbidden) {
          expect(contents, file).not.toContain(absolutePath);
          expect(contents, file).not.toContain(JSON.stringify(absolutePath).slice(1, -1));
        }
      }
    },
  );

  it.each(['node', 'cloudflare'] as const)(
    'builds --target %s from a config with both stanzas and records references only',
    async (target) => {
      const config = await writeConfig(target, { node: NODE_PORTS, cloudflare: CLOUDFLARE_PORTS });
      const result = await build({ configPath: config, target, cwd: project, runtimeEntry });

      const manifest = await readManifest(result.outDir);
      expect(manifest.platformPorts).toEqual(target === 'node' ? NODE_PORTS : CLOUDFLARE_PORTS);

      const generated = await bundle({
        entryPoints: [result.manifestTs],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        absWorkingDir: project,
      });
      const outfile = path.join(project, 'imported.mjs');
      await writeFile(outfile, generated.outputFiles[0]?.text ?? '');
      const imported = (await import(pathToFileURL(outfile).href)) as {
        platformPorts: unknown;
        plugins: unknown;
      };
      expect(imported.platformPorts).toEqual(target === 'node' ? NODE_PORTS : CLOUDFLARE_PORTS);
      expect(imported.plugins).toEqual([]);
    },
    60_000,
  );

  it('leaves only cloudflare:*, node:async_hooks, node:buffer and node:zlib external for the cloudflare target', async () => {
    const config = await writeConfig('cloudflare', { cloudflare: CLOUDFLARE_PORTS });
    const entry = path.join(project, 'scoped-entry.ts');
    await writeFile(
      entry,
      "import { AsyncLocalStorage } from 'node:async_hooks';\nimport { Buffer } from 'node:buffer';\nimport { gunzipSync } from 'node:zlib';\nimport { env } from 'cloudflare:workers';\nexport default { AsyncLocalStorage, Buffer, gunzipSync, env };\n",
    );
    const result = await build({
      configPath: config,
      target: 'cloudflare',
      cwd: project,
      runtimeEntry: entry,
    });
    const external = Object.values(result.metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((imported) => imported.external)
      .map((imported) => imported.path)
      .sort();
    expect(external).toEqual([
      'cloudflare:workers',
      'node:async_hooks',
      'node:buffer',
      'node:zlib',
    ]);
  }, 60_000);

  it.each(['node:fs', 'node:crypto'])(
    'fails the cloudflare build when the entry imports %s',
    async (specifier) => {
      const config = await writeConfig('cloudflare', { cloudflare: CLOUDFLARE_PORTS });
      const entry = path.join(project, 'forbidden-entry.ts');
      await writeFile(entry, `import * as mod from '${specifier}';\nexport default mod;\n`);
      await expect(
        build({ configPath: config, target: 'cloudflare', cwd: project, runtimeEntry: entry }),
      ).rejects.toThrow();
    },
    60_000,
  );

  it('does not write a credential-looking value into the bundle or manifest', async () => {
    const config = await writeConfig('node', {
      node: { ...NODE_PORTS, blob: { ...NODE_PORTS.blob, rootEnv: 'AKIAABCDEFGHIJKLMNOP' } },
    });
    await expect(
      build({ configPath: config, target: 'node', cwd: project, runtimeEntry }),
    ).rejects.toThrow(/looks like a credential/);
    await expect(
      readFile(path.join(project, '.pb', 'node', 'generated', 'manifest.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('builds without a stanza and records no description', async () => {
    const file = path.join(project, 'broker.config.ts');
    await writeFile(file, "export default { platform: 'node', plugins: [] };\n");
    const result = await build({ configPath: file, target: 'node', cwd: project, runtimeEntry });
    expect((await readManifest(result.outDir)).platformPorts).toBeNull();
  }, 60_000);

  const rejected: [string, unknown, string, 'node' | 'cloudflare'][] = [
    [
      'a Cloudflare R2 stanza reused for node',
      { node: CLOUDFLARE_PORTS },
      'node.blob.adapter: must be one of filesystem, s3 for node',
      'node',
    ],
    ['a missing port', { node: { blob: NODE_PORTS.blob } }, 'node.cache: required', 'node'],
    ['an unknown key', { node: { ...NODE_PORTS, extra: {} } }, 'node.extra: unknown key', 'node'],
    [
      'a non-positive budget',
      { node: { ...NODE_PORTS, blob: { ...NODE_PORTS.blob, maxBytes: 0 } } },
      'node.blob.maxBytes: must be a positive integer',
      'node',
    ],
    [
      'maxBytes above the product cap',
      { node: { ...NODE_PORTS, blob: { ...NODE_PORTS.blob, maxBytes: 67108865 } } },
      'node.blob.maxBytes: exceeds the product cap',
      'node',
    ],
    [
      'a duplicate binding name',
      {
        cloudflare: {
          ...CLOUDFLARE_PORTS,
          jobs: { ...CLOUDFLARE_PORTS.jobs, binding: 'STORAGE' },
        },
      },
      'cloudflare.jobs.binding: duplicate binding name',
      'cloudflare',
    ],
    [
      'an invalid cache namespace',
      {
        cloudflare: { ...CLOUDFLARE_PORTS, cache: { adapter: 'cache-api', namespace: 'Bad Name' } },
      },
      'cloudflare.cache.namespace: invalid identifier',
      'cloudflare',
    ],
    ['a non-object platformPorts', 'nope', 'platformPorts: must be an object', 'node'],
  ];

  it.each(rejected)(
    'fails the build for %s with a named problem',
    async (_name, ports, problem, target) => {
      const config = await writeConfig(target, ports);
      await expect(
        build({ configPath: config, target, cwd: project, runtimeEntry }),
      ).rejects.toThrow(problem);
    },
  );

  it.each([
    [
      'a binding',
      {
        cloudflare: {
          ...CLOUDFLARE_PORTS,
          blob: { ...CLOUDFLARE_PORTS.blob, binding: 'AKIAABCDEFGHIJKLMNOP' },
        },
      },
      'cloudflare.blob.binding: looks like a credential value',
    ],
    [
      'an analyticsBinding',
      {
        cloudflare: {
          ...CLOUDFLARE_PORTS,
          observability: {
            ...CLOUDFLARE_PORTS.observability,
            analyticsBinding: 'AKIAABCDEFGHIJKLMNOP',
          },
        },
      },
      'cloudflare.observability.analyticsBinding: looks like a credential value',
    ],
    [
      'a cache namespace',
      {
        cloudflare: {
          ...CLOUDFLARE_PORTS,
          cache: { adapter: 'cache-api', namespace: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3' },
        },
      },
      'cloudflare.cache.namespace: looks like a credential value',
    ],
  ])('refuses %s that looks like a credential', async (_name, ports, problem) => {
    const config = await writeConfig('cloudflare', ports);
    await expect(
      build({ configPath: config, target: 'cloudflare', cwd: project, runtimeEntry }),
    ).rejects.toThrow(problem);
    await expect(
      readFile(path.join(project, '.pb', 'cloudflare', 'generated', 'manifest.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails when a plugin registers jobs but the target has no stanza', async () => {
    const config = path.join(project, 'broker.config.ts');
    await writeFile(
      config,
      `const plugin = { id: 'jobby', package: '@test/jobby', apiVersion: 3, platforms: ['node'], register: (r) => r.job({ name: 'tick', version: 1, validate: (x) => x, handler: async () => {} }) };
export default { platform: 'node', plugins: [plugin] };
`,
    );
    await expect(
      build({ configPath: config, target: 'node', cwd: project, runtimeEntry }),
    ).rejects.toThrow('jobs: registered but platformPorts.node is not configured');
  });

  it('still rejects a plugin that binds a platform port', async () => {
    const config = path.join(project, 'broker.config.ts');
    await writeFile(
      config,
      `const plugin = { id: 'bad', package: '@test/bad', apiVersion: 3, platforms: ['node'], binds: ['blob'] };
export default { platform: 'node', plugins: [plugin] };
`,
    );
    await expect(
      build({ configPath: config, target: 'node', cwd: project, runtimeEntry }),
    ).rejects.toThrow(/cannot bind port "blob"/);
  });
});

describe('built plugin order round trip', () => {
  let project: string;
  let runtimeEntry: string;

  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'pb-plugin-order-'));
    runtimeEntry = path.join(project, 'runtime-entry.ts');
    await writeFile(
      runtimeEntry,
      "import { plugins } from '#pb-manifest';\nexport default { plugins };\n",
    );
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  async function config(cycle = false): Promise<string> {
    const configPath = path.join(project, 'broker.config.ts');
    await writeFile(
      configPath,
      `export default {
        platform: 'node',
        plugins: [
          { id: 'b', package: '@package-broker/core', apiVersion: 3,
            platforms: ['node', 'cloudflare'], dependsOn: ['a'] },
          { id: 'a', package: '@package-broker/core', apiVersion: 3,
            platforms: ['node', 'cloudflare'], dependsOn: ${JSON.stringify(cycle ? ['b'] : [])} }
        ]
      };`,
    );
    return configPath;
  }

  async function loadBundle(file: string): Promise<{ plugins: { id: string }[] }> {
    const copy = path.join(project, `${path.basename(path.dirname(file))}-loaded.mjs`);
    await writeFile(
      copy,
      (await readFile(file, 'utf8')).replace(/^\/\/# sourceMappingURL=.*$/m, ''),
    );
    return (await import(pathToFileURL(copy).href)) as { plugins: { id: string }[] };
  }

  async function stubRuntimeEntry(): Promise<string> {
    const entry = path.join(project, 'runtime-entry.ts');
    await writeFile(
      entry,
      "import { plugins } from '#pb-manifest';\nexport { plugins };\nexport default { plugins };\n",
    );
    return entry;
  }

  it.each(['node', 'cloudflare'] as const)(
    'exports dependencies before dependants from the %s bundle',
    async (target) => {
      const result = await build({
        configPath: await config(),
        target,
        outDir: path.join(project, target),
        runtimeEntry: await stubRuntimeEntry(),
      });
      const loaded = await loadBundle(result.bundle);
      expect(loaded.plugins.map(({ id }) => id)).toEqual(['a', 'b']);
    },
  );

  it.each(['node', 'cloudflare'] as const)(
    'carries configured tokens into the %s bundle',
    async (target) => {
      const configPath = path.join(project, 'tokens.config.ts');
      const tokens = { maxLifetimeDays: { personal: 30, service: 60 } };
      await writeFile(
        configPath,
        `export default ${JSON.stringify({ platform: target, plugins: [], tokens })};`,
      );
      await writeFile(runtimeEntry, "export { tokens } from '#pb-manifest';\n");
      const result = await build({
        configPath,
        target,
        outDir: path.join(project, target),
        runtimeEntry,
      });
      const loaded = (await import(pathToFileURL(result.bundle).href)) as { tokens: unknown };
      expect(loaded.tokens).toEqual(tokens);
    },
  );

  it.each(['node', 'cloudflare'] as const)(
    'carries the disabled vulnerability setting into the %s bundle',
    async (target) => {
      const configPath = path.join(project, 'vulnerability.config.ts');
      await writeFile(
        configPath,
        `export default ${JSON.stringify({ platform: target, plugins: [], vulnerability: { enabled: false } })};`,
      );
      await writeFile(runtimeEntry, "export { vulnerability } from '#pb-manifest';\n");
      const result = await build({
        configPath,
        target,
        outDir: path.join(project, target),
        runtimeEntry,
      });
      const loaded = (await import(pathToFileURL(result.bundle).href)) as {
        vulnerability: unknown;
      };
      expect(loaded.vulnerability).toEqual({ enabled: false });
    },
  );

  it.each(['node', 'cloudflare'] as const)(
    'carries the enabled MCP setting into the %s bundle',
    async (target) => {
      const configPath = path.join(project, 'mcp.config.ts');
      await writeFile(
        configPath,
        `export default ${JSON.stringify({ platform: target, plugins: [], mcp: { enabled: true } })};`,
      );
      await writeFile(runtimeEntry, "export { mcp } from '#pb-manifest';\n");
      const result = await build({
        configPath,
        target,
        outDir: path.join(project, target),
        runtimeEntry,
      });
      const loaded = (await import(pathToFileURL(result.bundle).href)) as { mcp: unknown };
      expect(loaded.mcp).toEqual({ enabled: true });
    },
  );

  it.each([
    [
      'an ordered id missing from config.plugins',
      ['a', 'x'],
      'plugin "x" is missing from config.plugins',
    ],
    [
      'a config with more plugins than ordered ids',
      ['a'],
      'config.plugins has 2 plugins, expected 1',
    ],
  ])('throws at module load for %s', async (_name, ids, message) => {
    const configFile = await config();
    const entry = path.join(project, 'guard-entry.ts');
    await writeFile(entry, `import { plugins } from '#guard';\nexport { plugins };\n`);
    const guard = path.join(project, 'guard-manifest.ts');
    await writeFile(guard, renderBuildManifest(configFile, ids));
    const out = path.join(project, 'guard.mjs');
    await bundle({
      entryPoints: [entry],
      outfile: out,
      bundle: true,
      format: 'esm',
      platform: 'node',
      alias: { '#guard': guard },
      logLevel: 'silent',
    });
    await expect(import(pathToFileURL(out).href)).rejects.toThrow(message);
  });

  it('rejects a cycle with the existing validation message', async () => {
    await expect(
      build({ configPath: await config(true), outDir: path.join(project, 'cycle'), runtimeEntry }),
    ).rejects.toThrow('dependency cycle at plugin "b"');
  });
});
