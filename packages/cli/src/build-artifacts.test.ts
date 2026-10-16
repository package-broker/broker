import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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

describe('renderBuildManifest', () => {
  it('parses and imports Windows config paths with forward slashes and escaped characters', async () => {
    const configPath = String.raw`C:\broker files\owner's "config".ts`;
    const { resolved, output } = await resolveSpecifier(
      renderBuildManifest(configPath, [], 'win32'),
    );
    expect(resolved).toEqual([`C:/broker files/owner's "config".ts`]);
    expect(output).toContain('intended config');
    expect(output).toContain('migrations');
  });

  it('renders a Windows path with forward slashes', () => {
    expect(renderBuildManifest(String.raw`C:\broker files\config.ts`, undefined, 'win32')).toBe(
      String.raw`import config from "C:/broker files/config.ts";
export const plugins = config.plugins;
`,
    );
  });

  it('keeps a backslash of a POSIX path, where it is an ordinary filename character', async () => {
    const configPath = String.raw`/srv/broker\config.ts`;
    const { resolved, output } = await resolveSpecifier(
      renderBuildManifest(configPath, undefined, 'linux'),
    );
    expect(resolved).toEqual([configPath]);
    expect(renderBuildManifest(configPath, undefined, 'linux')).toBe(
      String.raw`import config from "/srv/broker\\config.ts";
export const plugins = config.plugins;
`,
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

describe('built plugin order round trip', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'pb-plugin-order-'));
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
          { id: 'b', package: '@package-broker/core', apiVersion: 2,
            platforms: ['node', 'cloudflare'], dependsOn: ['a'] },
          { id: 'a', package: '@package-broker/core', apiVersion: 2,
            platforms: ['node', 'cloudflare'], dependsOn: ${JSON.stringify(cycle ? ['b'] : [])} }
        ]
      };`,
    );
    return configPath;
  }

  it.each(['node', 'cloudflare'] as const)(
    'exports dependencies before dependants from the %s build manifest',
    async (target) => {
      const result = await build({
        configPath: await config(),
        target,
        outDir: path.join(project, target),
      });
      const outfile = path.join(project, 'manifest.mjs');
      await bundle({
        entryPoints: [result.manifestTs],
        outfile,
        bundle: true,
        format: 'esm',
        platform: 'node',
      });
      const manifest = (await import(pathToFileURL(outfile).href)) as {
        plugins: { id: string }[];
      };
      expect(manifest.plugins.map(({ id }) => id)).toEqual(['a', 'b']);
    },
  );

  it('rejects a cycle with the existing validation message', async () => {
    await expect(
      build({ configPath: await config(true), outDir: path.join(project, 'cycle') }),
    ).rejects.toThrow('dependency cycle at plugin "b"');
  });
});
