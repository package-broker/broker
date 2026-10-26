import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { materializePrebuilt, removePrebuilt, type PrebuiltExpected } from './prebuilt.js';
import { deploy, validateDeploymentArtifact } from './commands/cloudflare/deploy.js';
import { provision } from './commands/cloudflare/provision.js';
import { setup } from './commands/cloudflare/setup.js';
import { migrateCloudflare } from './commands/cloudflare.js';
import {
  emptyInventory,
  installIdentity,
  InventoryStore,
} from './commands/cloudflare/inventory.js';
import { run } from './cli.js';
import { commandEnvelope } from './commands/cloudflare/api.js';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    rename: vi.fn(original.rename),
    readdir: vi.fn(original.readdir),
    rm: vi.fn(original.rm),
  };
});
const actualRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
  .rename;
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  .version as string;
const packageName = '@package-broker/dist-cloudflare';
const gitSha = 'a'.repeat(40),
  lockfileSha256 = 'b'.repeat(64);
const sql = '-- fixture\n';
const secondSql = '-- second fixture\n';
let project: string, pkg: string, payload: string, out: string;
let expected: PrebuiltExpected;
let record: Record<string, unknown> & { files: Record<string, string> };
const json = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
async function anchor() {
  await json(join(pkg, 'prebuilt.json'), record);
  expected.prebuiltJsonSha256 = sha(await readFile(join(pkg, 'prebuilt.json')));
}
const options = () => ({
  project,
  cliVersion: version,
  expected,
  resolve: () => join(pkg, 'package.json'),
});
const materialize = () => materializePrebuilt(options());
async function reject(code: string, exitCode = 2) {
  const error = await materialize().catch((error: unknown) => error);
  expect(error).toMatchObject({ code, exitCode });
  expect(String(error)).not.toContain('SECRET');
  expect(String(error)).not.toContain('build the selected configuration first');
}
beforeEach(async () => {
  vi.mocked(rename).mockImplementation(actualRename);
  project = await mkdtemp(join(await realpath(tmpdir()), 'prebuilt-test-'));
  pkg = join(project, 'fixture-package');
  payload = join(pkg, 'cloudflare');
  out = join(project, '.pb/prebuilt/cloudflare');
  for (const name of ['generated', 'assets', 'migrations/core'])
    await mkdir(join(payload, name), { recursive: true });
  await json(join(pkg, 'package.json'), { name: packageName, version });
  await writeFile(join(payload, 'worker.js'), 'export default {};');
  await writeFile(join(payload, 'wrangler.toml'), 'main = "worker.js"');
  await json(join(payload, 'build-info.json'), {
    schemaVersion: 1,
    target: 'cloudflare',
    core: '9.8.7',
    plugins: {},
    gitSha,
    lockfileSha256,
    dirty: false,
  });
  await writeFile(join(payload, 'migrations/core/0001_init.sql'), sql);
  await writeFile(join(payload, 'migrations/core/0002_second.sql'), secondSql);
  await writeFile(join(payload, 'migrations/core/0003_unused.sql'), '-- unreferenced fixture\n');
  await json(join(payload, 'generated/manifest.json'), {
    schemaVersion: 1,
    platform: 'cloudflare',
    platformPorts: null,
    plugins: [],
    bindings: [],
    routes: [],
    migrations: [
      { id: 'core:0001_init', name: '0001_init.sql', checksum: sha(sql), phase: 'expand' },
      {
        id: 'core:0002_second',
        name: '0002_second.sql',
        checksum: sha(secondSql),
        phase: 'expand',
      },
    ],
  });
  const asset = JSON.stringify({
    version: 1,
    entry: 'index.html',
    files: { 'index.html': { bytes: 2, contentType: 'text/html' } },
  });
  await writeFile(join(payload, 'assets/manifest.json'), asset);
  await writeFile(join(payload, 'assets/index.html'), 'ok');
  await json(join(payload, 'assets.json'), {
    schemaVersion: 1,
    provider: { specifier: '@package-broker/ui-assets', version },
    digest: `sha256:${sha(
      JSON.stringify([
        ['manifest.json', sha(asset)],
        ['index.html', sha('ok')],
      ]),
    )}`,
    descriptor: {
      directory: './assets',
      binding: 'ASSETS',
      run_worker_first: true,
      html_handling: 'none',
      not_found_handling: 'none',
    },
  });
  const files: Record<string, string> = {};
  async function walk(dir: string, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${name}/`);
      else files[name] = `sha256:${sha(await readFile(join(payload, name)))}`;
    }
  }
  await walk(payload);
  const artifactSha256 = (await validateDeploymentArtifact(payload)).artifactHash;
  record = {
    schemaVersion: 1,
    package: packageName,
    version,
    target: 'cloudflare',
    payload: 'cloudflare',
    gitSha,
    lockfileSha256,
    toolchain: { node: '24', esbuild: '0', os: 'test', arch: 'test' },
    plugins: {},
    files,
    artifactSha256,
  };
  expected = {
    schemaVersion: 1,
    package: packageName,
    version,
    artifactSha256,
    prebuiltJsonSha256: '',
  };
  await anchor();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});
it('materializes verified files in an isolated run and accepts a different core version', async () => {
  const first = await materialize();
  expect(first).toEqual({
    outDir: expect.stringMatching(new RegExp(`^${out}\\.[a-f0-9-]{36}$`)),
    package: packageName,
    version,
    gitSha,
    artifactSha256: expected.artifactSha256,
  });
  expect((await validateDeploymentArtifact(first.outDir)).info.core).toBe('9.8.7');
  expect(await readdir(first.outDir)).not.toContain('wrangler.toml');
  expect(await readdir(first.outDir)).not.toContain('package.json');
  await writeFile(join(first.outDir, 'keep'), 'active');
  const second = await materialize();
  expect(second.outDir).not.toBe(first.outDir);
  expect(await readFile(join(first.outDir, 'keep'), 'utf8')).toBe('active');
  expect(await readdir(second.outDir)).not.toContain('keep');
  expect(await readFile(join(second.outDir, 'prebuilt.json'))).toEqual(
    await readFile(join(pkg, 'prebuilt.json')),
  );
});
it('refuses an unresolvable package', async () => {
  await expect(
    materializePrebuilt({
      ...options(),
      resolve: () => {
        throw new Error('SECRET');
      },
    }),
  ).rejects.toMatchObject({
    code: 'prebuilt_unavailable',
    exitCode: 2,
    message: expect.not.stringContaining('SECRET'),
  });
});
it('refuses a package without prebuilt.json', async () => {
  await rm(join(pkg, 'prebuilt.json'));
  await reject('prebuilt_unavailable');
});
it('refuses a missing expected record', async () => {
  const o = { project, cliVersion: version, resolve: options().resolve };
  await expect(materializePrebuilt(o)).rejects.toMatchObject({
    code: 'prebuilt_unverifiable',
    exitCode: 2,
  });
});
it('checks the expected prebuilt JSON digest', async () => {
  expected.prebuiltJsonSha256 = '0'.repeat(64);
  await reject('checksum_mismatch', 3);
});
it.each(['cli', 'record', 'package', 'expected'])(
  'refuses a version mismatch in %s',
  async (part) => {
    if (part === 'record') {
      record.version = '0.0.0';
      await anchor();
    }
    if (part === 'package')
      await json(join(pkg, 'package.json'), { name: packageName, version: '0.0.0' });
    if (part === 'expected') expected.version = '0.0.0';
    await expect(
      materializePrebuilt({ ...options(), ...(part === 'cli' ? { cliVersion: '0.0.0' } : {}) }),
    ).rejects.toMatchObject({ code: 'prebuilt_version_mismatch', exitCode: 2 });
  },
);
it.each([true, null])('refuses dirty %s', async (dirty) => {
  const path = join(payload, 'build-info.json');
  await json(path, { ...JSON.parse(await readFile(path, 'utf8')), dirty });
  record.files['build-info.json'] = `sha256:${sha(await readFile(path))}`;
  await anchor();
  await reject('prebuilt_dirty');
});
it.each(['gitSha', 'lockfileSha256'])('refuses a build-info %s mismatch', async (field) => {
  const path = join(payload, 'build-info.json');
  await json(path, {
    ...JSON.parse(await readFile(path, 'utf8')),
    [field]: 'c'.repeat(field === 'gitSha' ? 40 : 64),
  });
  record.files['build-info.json'] = `sha256:${sha(await readFile(path))}`;
  await anchor();
  await reject(field === 'gitSha' ? 'prebuilt_git_sha_mismatch' : 'prebuilt_lockfile_mismatch');
});
it('checks per-file digests for tampering', async () => {
  await writeFile(join(payload, 'migrations/core/0003_unused.sql'), 'tampered');
  await reject('checksum_mismatch', 3);
});
it('refuses a missing listed file', async () => {
  await rm(join(payload, 'worker.js'));
  await reject('checksum_mismatch', 3);
});
it('refuses an unlisted extra file', async () => {
  await writeFile(join(payload, 'extra'), 'extra');
  await reject('checksum_mismatch', 3);
});
it.each([
  '../escape',
  '/absolute',
  'assets/../escape',
  'C:\\escape',
  'assets/C:/escape',
  'assets/file:stream',
])('refuses unsafe file path %s', async (name) => {
  record.files[name] = `sha256:${'a'.repeat(64)}`;
  await anchor();
  await reject('unsafe_path');
});
it('refuses symlinked sources', async () => {
  await rm(join(payload, 'worker.js'));
  await symlink(join(pkg, 'package.json'), join(payload, 'worker.js'));
  await reject('unsafe_path');
});
it('refuses symlinked source directories', async () => {
  await rm(join(payload, 'assets'), { recursive: true });
  await symlink(join(payload, 'generated'), join(payload, 'assets'));
  await reject('unsafe_path');
});
it('leaves a selected build output intact and materializes beside it', async () => {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'worker.js'), 'custom');
  const result = await materialize();
  expect(result.outDir).not.toBe(out);
  expect(await readFile(join(out, 'worker.js'), 'utf8')).toBe('custom');
});
it('resolves an in-project output ancestor symlink', async () => {
  const target = join(project, 'runs');
  await mkdir(target);
  await mkdir(join(project, '.pb'));
  await symlink(target, join(project, '.pb/prebuilt'));
  const result = await materialize();
  expect(result.outDir.startsWith(join(target, 'cloudflare.'))).toBe(true);
});
it('refuses a direct output symlink', async () => {
  await mkdir(out, { recursive: true });
  const link = join(project, 'output-link');
  await symlink(out, link);
  await expect(materializePrebuilt({ ...options(), outDir: link })).rejects.toMatchObject({
    code: 'unsafe_path',
  });
});
it.each(['record', 'expected'])('checks artifactSha256 against %s', async (part) => {
  if (part === 'record') {
    record.artifactSha256 = '0'.repeat(64);
    await anchor();
  } else expected.artifactSha256 = '0'.repeat(64);
  await reject('checksum_mismatch', 3);
});
it.each([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'install',
  'preinstall',
  'postinstall',
  'prepare',
])('refuses package %s', async (field) => {
  await json(join(pkg, 'package.json'), {
    name: packageName,
    version,
    ...(field.endsWith('Dependencies') || field === 'dependencies'
      ? { [field]: { evil: '1' } }
      : { scripts: { [field]: 'echo SECRET' } }),
  });
  await reject('prebuilt_dependencies_refused');
});
it.each(['target', 'payload', 'schemaVersion', 'unknown'])('strictly parses %s', async (field) => {
  record[field] = 'bad';
  await anchor();
  await reject('prebuilt_invalid');
});

const env = { CLOUDFLARE_API_TOKEN: 'DUMMY', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
const stable = 'custom configuration needs a build: run pb build or omit --prebuilt';
it.each(['setup', 'provision', 'migrate', 'deploy'])(
  'CLI %s refuses custom config flags and project config files',
  async (command) => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(project);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const flag of [true, false]) {
      if (!flag) await writeFile(join(project, 'broker.config.ts'), 'SECRET');
      expect(
        await run([
          'cloudflare',
          command,
          '--prebuilt',
          '--json',
          ...(flag ? ['--config', 'custom.ts'] : []),
        ]),
      ).toBe(2);
      expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
      expect(JSON.parse(String(log.mock.calls.at(-1)![0])).error).toMatchObject({
        code: 'invalid_input',
        message: stable,
      });
    }
    cwd.mockRestore();
  },
);
it.each(['setup', 'provision', 'migrate', 'deploy'])(
  'direct %s refuses project config',
  async (command) => {
    const invoke = () =>
      command === 'setup'
        ? setup({ workerName: 'broker', project, env, prebuilt: true })
        : command === 'provision'
          ? provision({ workerName: 'broker', project, env, prebuilt: true })
          : command === 'deploy'
            ? deploy({ workerName: 'broker', project, env, prebuilt: true })
            : migrateCloudflare({ env, prebuilt: true, dryRun: true });
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    await writeFile(join(project, 'broker.config.ts'), 'SECRET');
    const result = await invoke();
    expect(JSON.stringify(result.output)).not.toContain('SECRET');
    expect(result.output.error).toMatchObject({ code: 'invalid_input', message: stable });
  },
);
it.each(['missing', 'wrong checksum', 'wrong id', 'complete'])(
  'deploy prebuilt checks the migration ledger: %s',
  async (state) => {
    await promisify(execFile)('git', ['init', '--quiet', project]);
    await writeFile(join(project, '.gitignore'), '.pb/\n');
    const identity = installIdentity({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      workerName: 'broker',
    });
    const store = await InventoryStore.create({ project, outDir: out, identity });
    const journal = emptyInventory(identity, Date.now());
    journal.migrations.ledger = [{ id: 'core:0001_init', checksum: sha(sql), phase: 'expand' }];
    if (state !== 'missing')
      journal.migrations.ledger.push({
        id: state === 'wrong id' ? 'core:0003_unknown' : 'core:0002_second',
        checksum: state === 'wrong checksum' ? '0'.repeat(64) : sha(secondSql),
        phase: 'expand',
      });
    await store.write(journal);
    const result = await deploy(
      {
        workerName: 'broker',
        project,
        env,
        dryRun: true,
        prebuilt: true,
      },
      { materializePrebuilt: (o) => materializePrebuilt({ ...o, ...options() }) },
    );
    expect(await readdir(join(project, '.pb/prebuilt'))).toEqual([]);
    expect(result.output.prebuilt?.artifact_sha256, JSON.stringify(result.output)).toBe(
      expected.artifactSha256,
    );
    expect(JSON.stringify(result.output)).not.toContain('SECRET');
    expect(result.output.error?.stage).toBe('deploy');
    if (state === 'complete') {
      expect(result.output.error?.code).toBe('invalid_input');
      expect(result.output.error?.code).not.toBe('migrations_pending');
    } else {
      expect(result.exitCode).toBe(2);
      expect(result.output.error).toMatchObject({
        code: 'migrations_pending',
        message: expect.stringContaining('pb cloudflare migrate --prebuilt --worker-name'),
      });
    }
  },
);

it('refuses a non-regular listed source', async () => {
  await rm(join(payload, 'worker.js'));
  await mkdir(join(payload, 'worker.js'));
  await reject('unsafe_path');
});
it.each(['.', 'fixture-package', '.pb/state/output'])(
  'refuses unsafe output %s',
  async (outDir) => {
    await expect(materializePrebuilt({ ...options(), outDir })).rejects.toMatchObject({
      code: 'unsafe_path',
      exitCode: 2,
    });
  },
);
it('uses the CLI package version by default', async () => {
  expect(
    (await materializePrebuilt({ project, expected, resolve: options().resolve })).version,
  ).toBe(version);
});

it('resolves a package installed through a workspace symlink', async () => {
  const link = join(project, 'package-link');
  await symlink(pkg, link);
  expect(
    (await materializePrebuilt({ ...options(), resolve: () => join(link, 'package.json') }))
      .artifactSha256,
  ).toBe(expected.artifactSha256);
});
it('refuses even an empty declared dependency map', async () => {
  await json(join(pkg, 'package.json'), { name: packageName, version, dependencies: {} });
  await reject('prebuilt_dependencies_refused');
});
it('does not require a marker on the untouched selected output', async () => {
  await mkdir(out, { recursive: true });
  await json(join(out, 'prebuilt.json'), {});
  await writeFile(join(out, 'keep'), 'keep');
  await materialize();
  expect(await readFile(join(out, 'keep'), 'utf8')).toBe('keep');
});

it('diagnoses an installed version mismatch before a different anchor', async () => {
  await json(join(pkg, 'package.json'), { name: packageName, version: '0.0.0' });
  await writeFile(join(pkg, 'prebuilt.json'), 'SECRET invalid JSON');
  await reject('prebuilt_version_mismatch');
});
it.each(['wrangler.toml', 'build-info.json'])(
  'checks tampered %s before parsing or discarding it',
  async (name) => {
    await writeFile(join(payload, name), 'SECRET invalid JSON');
    await reject('checksum_mismatch', 3);
  },
);
it.each(['binding.gyp', 'gypfile', 'bundleDependencies', 'bundledDependencies'])(
  'refuses implicit install hook %s',
  async (field) => {
    if (field === 'binding.gyp') await writeFile(join(pkg, field), 'SECRET');
    else await json(join(pkg, 'package.json'), { name: packageName, version, [field]: true });
    await reject('prebuilt_dependencies_refused');
  },
);
it.each([false, true])(
  'preserves active output on validation failure (previous: %s)',
  async (previous) => {
    const first = previous ? await materialize() : null;
    const before = await readdir(join(project, '.pb/prebuilt')).catch(() => []);
    expected.artifactSha256 = '0'.repeat(64);
    await reject('checksum_mismatch', 3);
    if (first) await validateDeploymentArtifact(first.outDir);
    expect(await readdir(join(project, '.pb/prebuilt'))).toEqual(before);
  },
);
it('cleans the candidate on an errno publish failure and preserves active runs', async () => {
  const first = await materialize();
  await writeFile(join(first.outDir, 'keep'), 'previous');
  const before = await readdir(join(project, '.pb/prebuilt'));
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('SECRET'), { code: 'EACCES' }));
  await reject('prebuilt_io_failure', 1);
  expect(await readFile(join(first.outDir, 'keep'), 'utf8')).toBe('previous');
  expect(await readdir(join(project, '.pb/prebuilt'))).toEqual(before);
});
it.each([new TypeError('bug'), Object.assign(new Error('bug'), { code: 'BUG' })])(
  'propagates non-errno failures unchanged: %s',
  async (failure) => {
    vi.mocked(rename).mockRejectedValueOnce(failure);
    await expect(materialize()).rejects.toBe(failure);
    expect(await readdir(join(project, '.pb/prebuilt'))).toEqual([]);
  },
);
it('uses real paths for project and absolute output ancestors', async () => {
  const link = join(project, 'project-link');
  await symlink(project, link);
  expect(
    (
      await materializePrebuilt({
        ...options(),
        project: link,
        outDir: join(link, '.pb/prebuilt/cloudflare'),
      })
    ).outDir,
  ).toEqual(expect.stringMatching(new RegExp(`^${out}\\.[a-f0-9-]{36}$`)));
});
it('isolates concurrent command materializations', async () => {
  const [first, second] = await Promise.all([
    materializePrebuilt(options()),
    materializePrebuilt(options()),
  ]);
  expect(first.outDir).not.toBe(second.outDir);
  await removePrebuilt(first.outDir);
  await expect(readFile(`${first.outDir}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await validateDeploymentArtifact(second.outDir)).artifactHash).toBe(
    expected.artifactSha256,
  );
});
it('sweeps a stale future marker for the same package', async () => {
  const first = await materialize();
  await json(join(first.outDir, 'prebuilt.json'), {
    package: packageName,
    schemaVersion: 2,
    future: true,
  });
  await rm(`${first.outDir}.lock`);
  await materialize();
  await expect(readdir(first.outDir)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('CLI setup checks cwd configuration while --project remains a smoke slug', async () => {
  await writeFile(join(project, 'broker.config.ts'), 'SECRET');
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(
    await run(['cloudflare', 'setup', '--project', 'acme', '--prebuilt', '--dry-run', '--json']),
  ).toBe(2);
  const output = JSON.parse(String(log.mock.calls.at(-1)![0]));
  expect(output.error.message).toBe(stable);
  expect(JSON.stringify(output)).not.toContain('SECRET');
});

it.each([false, true])(
  'keeps output intact when the unchanged artifact validator refuses the candidate (previous: %s)',
  async (previous) => {
    const first = previous ? await materialize() : null;
    const before = await readdir(join(project, '.pb/prebuilt')).catch(() => []);
    const manifest = join(payload, 'generated/manifest.json');
    await writeFile(manifest, '{}');
    record.files['generated/manifest.json'] = `sha256:${sha(await readFile(manifest))}`;
    await anchor();
    await reject('prebuilt_invalid');
    if (first) await validateDeploymentArtifact(first.outDir);
    expect(await readdir(join(project, '.pb/prebuilt'))).toEqual(before);
  },
);
it('keeps the deploy stage and usual message for errors outside prebuilt materialization', async () => {
  const { CloudflareError } = await import('./commands/cloudflare/api.js');
  const failure = new CloudflareError('configuration_conflict', 11, false, 'inventory');
  failure.message = 'SECRET';
  const result = await deploy(
    { project, workerName: 'broker', env, prebuilt: true, dryRun: true },
    {
      materializePrebuilt: async () => {
        throw failure;
      },
    },
  );
  expect(result.output.error).toMatchObject({
    code: 'configuration_conflict',
    stage: 'deploy',
    message: new CloudflareError('configuration_conflict').message,
  });
  expect(JSON.stringify(result.output)).not.toContain('SECRET');
});

it('sweeps interrupted marked runs and CLI temporary trees while preserving unrelated siblings', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  expect(dead).toBeGreaterThan(0);
  const stale = `${out}.${randomUUID()}`;
  const temporary = `${out}.${randomUUID()}.tmp-Abc123`;
  const legacyTemporary = `${out}.tmp-Def456`;
  const foreign = `${out}.${randomUUID()}`;
  const unmarked = `${out}.${randomUUID()}`;
  const unrelated = `${out}.tmp-unrelated`;
  const linked = `${out}.${randomUUID()}`;
  for (const path of [stale, temporary, legacyTemporary, foreign, unmarked, unrelated]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'keep'), 'fixture');
  }
  await json(join(stale, 'prebuilt.json'), { package: packageName });
  await json(`${stale}.lock`, dead);
  await json(`${temporary.slice(0, temporary.lastIndexOf('.tmp-'))}.lock`, dead);
  await json(join(foreign, 'prebuilt.json'), { package: 'another-package' });
  await symlink(stale, linked);
  const active = await materialize();
  for (const path of [stale, temporary])
    await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const path of [legacyTemporary, foreign, unmarked, unrelated])
    expect(await readFile(join(path, 'keep'), 'utf8')).toBe('fixture');
  expect(await readdir(join(project, '.pb/prebuilt'))).toContain(linked.split('/').at(-1));
  await validateDeploymentArtifact(active.outDir);
});
it('preserves live locked temporary trees and marked runs', async () => {
  const active = await materialize();
  const temporary = await mkdtemp(`${active.outDir}.tmp-`);
  await writeFile(join(temporary, 'keep'), 'active');
  const next = await materialize();
  expect(await readFile(join(temporary, 'keep'), 'utf8')).toBe('active');
  await validateDeploymentArtifact(active.outDir);
  await removePrebuilt(next.outDir);
  await removePrebuilt(active.outDir);
  await rm(temporary, { recursive: true });
  expect(await readdir(join(project, '.pb/prebuilt'))).toEqual([]);
});
it('holds a lock throughout materialization, including before the marker is published', async () => {
  let continuePublish!: () => void;
  const resumed = new Promise<void>((resolve) => {
    continuePublish = resolve;
  });
  let reachedPublish!: (temporary: string) => void;
  const reached = new Promise<string>((resolve) => {
    reachedPublish = resolve;
  });
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    reachedPublish(String(from));
    await resumed;
    await actualRename(from, to);
  });
  const pending = materialize();
  const tree = await reached;
  try {
    await materialize();
    expect(await readFile(join(tree, 'worker.js'), 'utf8')).toBe('export default {};');
  } finally {
    continuePublish();
    await pending;
  }
});
it.each(['migrate', 'provision'])(
  '%s uses and cleans its isolated materialization and lock',
  async (command) => {
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    await promisify(execFile)('git', ['init', '--quiet', project]);
    await writeFile(join(project, '.gitignore'), '.pb/\n');
    const createStore = vi.spyOn(InventoryStore, 'create');
    let runOut = '';
    const operations = {
      materializePrebuilt: vi.fn(async (o: Parameters<typeof materializePrebuilt>[0]) => {
        const result = await materializePrebuilt({ ...o, ...options() });
        runOut = result.outDir;
        expect(runOut).not.toBe(out);
        expect(JSON.parse(await readFile(`${runOut}.lock`, 'utf8'))).toBe(process.pid);
        return result;
      }),
    };
    const result =
      command === 'migrate'
        ? await migrateCloudflare(
            { env, workerName: 'broker', prebuilt: true, dryRun: true },
            operations,
          )
        : await provision(
            {
              project,
              workerName: 'broker',
              env,
              prebuilt: true,
              dryRun: true,
              fetch: async () => new Response(JSON.stringify({ success: true, result: [] })),
            },
            operations,
          );
    expect(operations.materializePrebuilt).toHaveBeenCalledWith({ project, outDir: out });
    expect(createStore).toHaveBeenCalledWith(expect.objectContaining({ outDir: runOut }));
    if (command === 'migrate') {
      expect(result.exitCode).toBe(0);
      expect(result.output.pending_migrations).toEqual(['core:0001_init', 'core:0002_second']);
    }
    expect(result.output.prebuilt?.artifact_sha256).toBe(expected.artifactSha256);
    expect(await readdir(join(project, '.pb/prebuilt'))).toEqual([]);
  },
);
it('keeps the migrate stage and usual message for errors outside prebuilt materialization', async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  const { CloudflareError } = await import('./commands/cloudflare/api.js');
  const failure = new CloudflareError('configuration_conflict', 11, false, 'inventory');
  failure.message = 'SECRET';
  const result = await migrateCloudflare(
    { env, prebuilt: true, dryRun: true },
    {
      materializePrebuilt: async () => {
        throw failure;
      },
    },
  );
  expect(result.output.error).toMatchObject({
    code: 'configuration_conflict',
    stage: 'migrate',
    message: new CloudflareError('configuration_conflict').message,
  });
  expect(JSON.stringify(result.output)).not.toContain('SECRET');
});
it('does not sweep the resolved package even when its directory matches a run name', async () => {
  const relocated = `${out}.${randomUUID()}`;
  await mkdir(join(project, '.pb/prebuilt'), { recursive: true });
  await rename(pkg, relocated);
  pkg = relocated;
  payload = join(pkg, 'cloudflare');
  await materialize();
  expect(await readFile(join(payload, 'worker.js'), 'utf8')).toBe('export default {};');
});
it.each(['invalid JSON', JSON.stringify(process.pid), '{}'])(
  'preserves a marked run with a live or unverifiable lock: %s',
  async (lock) => {
    const stale = `${out}.${randomUUID()}`;
    await mkdir(stale, { recursive: true });
    await json(join(stale, 'prebuilt.json'), { package: packageName });
    await writeFile(`${stale}.lock`, lock);
    await materialize();
    expect(JSON.parse(await readFile(join(stale, 'prebuilt.json'), 'utf8')).package).toBe(
      packageName,
    );
  },
);

it('keeps prebuilt absent from the base command envelope', () => {
  expect(commandEnvelope('deploy')).not.toHaveProperty('prebuilt');
});
it('continues materialization when sweep cannot read the parent', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const read = vi.fn(actual.readdir);
  vi.mocked(readdir).mockImplementation(read);
  read.mockImplementation(async (...args) => {
    if (args[0] === join(project, '.pb/prebuilt'))
      throw Object.assign(new Error('SECRET'), { code: 'EACCES' });
    return actual.readdir(...args);
  });
  try {
    await validateDeploymentArtifact((await materialize()).outDir);
    expect(read).toHaveBeenCalledWith(join(project, '.pb/prebuilt'), { withFileTypes: true });
  } finally {
    vi.mocked(readdir).mockImplementation(actual.readdir);
  }
});
it('skips an undeletable stale entry and still sweeps other stale entries', async () => {
  const blocked = `${out}.${randomUUID()}.tmp-Abc123`;
  const stale = `${out}.${randomUUID()}.tmp-Def456`;
  for (const path of [blocked, stale]) await mkdir(path, { recursive: true });
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (path === blocked) throw Object.assign(new Error('SECRET'), { code: 'EACCES' });
    return actual.rm(path, options);
  });
  try {
    await validateDeploymentArtifact((await materialize()).outDir);
    expect(await readdir(blocked)).toEqual([]);
    await expect(readdir(stale)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    vi.mocked(rm).mockImplementation(actual.rm);
  }
});
it('sweeps only dead orphan regular lock files', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  expect(dead).toBeGreaterThan(0);
  await mkdir(join(project, '.pb/prebuilt'), { recursive: true });
  const orphan = `${out}.${randomUUID()}.lock`;
  const live = `${out}.${randomUUID()}.lock`;
  const invalid = `${out}.${randomUUID()}.lock`;
  const unmarked = `${out}.${randomUUID()}`;
  const linked = `${out}.${randomUUID()}.lock`;
  const directory = `${out}.${randomUUID()}.lock`;
  const unrelated = `${out}.other.lock`;
  await json(orphan, dead);
  await json(live, process.pid);
  await json(invalid, {});
  await mkdir(unmarked);
  await json(`${unmarked}.lock`, dead);
  await symlink(orphan, linked);
  await mkdir(directory);
  await json(unrelated, dead);
  await materialize();
  const siblings = await readdir(join(project, '.pb/prebuilt'));
  expect(siblings).not.toContain(orphan.split('/').at(-1));
  for (const path of [live, invalid, `${unmarked}.lock`, linked, directory, unrelated])
    expect(siblings).toContain(path.split('/').at(-1));
});
it('a failed lock removal is recovered by a subsequent sweep', async () => {
  const first = await materialize();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(rm)
    .mockImplementationOnce(async (path, options) => {
      expect(path).toBe(first.outDir);
      await actual.rm(path, options);
    })
    .mockRejectedValueOnce(Object.assign(new Error('SECRET'), { code: 'EACCES' }));
  await expect(removePrebuilt(first.outDir)).rejects.toMatchObject({ code: 'EACCES' });
  await expect(readdir(first.outDir)).rejects.toMatchObject({ code: 'ENOENT' });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  expect(dead).toBeGreaterThan(0);
  await json(`${first.outDir}.lock`, dead);
  await materialize();
  await expect(readFile(`${first.outDir}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
});
