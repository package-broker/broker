import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCutoverCheck, type ComposerRunner, type CutoverOptions } from './cutover.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), writeFile: vi.fn(actual.writeFile) };
});

const OLD = 'https://old.example.test/repository/';
const NEW = 'https://broker.example.test/project/';
const SENTINEL = 'secret-auth-sentinel';
const oldAuth = JSON.stringify({ bearer: { 'old.example.test': SENTINEL } });
const newAuth = JSON.stringify({ bearer: { 'broker.example.test': 'new-secret' } });
const manifest = `{
  "description": "Keep λ and escaped \\u002f and \\"quotes\\"",
  "repositories": [ { "type": "composer", "url" : "${OLD}" }, {"packagist.org":false} ],
  "extra": {"url":"${OLD}"}
}\n`;
const pkg = (name = 'acme/library', version = '1.0.0') => ({
  name,
  version,
  source: { reference: 'source-ref' },
  dist: { reference: 'dist-ref', url: 'https://cdn.example.test/library.zip' },
});
const lock = (values = [pkg()], dev: ReturnType<typeof pkg>[] = []) =>
  JSON.stringify({ packages: values, 'packages-dev': dev });
const success = { exitCode: 0, stdout: '', stderr: '' };
let projectDir: string;
let options: CutoverOptions;
let calls: { args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; shell: false }[];
let composer: ComposerRunner;
let signalListeners: Map<'SIGINT' | 'SIGTERM', NodeJS.SignalsListener[]>;

beforeEach(async () => {
  signalListeners = new Map(
    (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, process.listeners(signal)]),
  );
  vi.mocked(mkdtemp).mockClear();
  projectDir = await mkdtemp(join(tmpdir(), 'pb-cutover-project-'));
  await writeFile(join(projectDir, 'composer.json'), manifest);
  await writeFile(join(projectDir, 'composer.lock'), lock());
  await writeFile(join(projectDir, 'auth.json'), 'must never be copied');
  await writeFile(join(projectDir, 'keep.txt'), 'unchanged');
  vi.stubEnv('CUTOVER_OLD_AUTH', oldAuth);
  vi.stubEnv('CUTOVER_NEW_AUTH', newAuth);
  calls = [];
  composer = async (args, context) => {
    calls.push({ args, ...context });
    return args[0] === '--version'
      ? { ...success, stdout: 'Composer version 2.8.1 2025-01-01\n' }
      : success;
  };
  options = {
    projectDir,
    oldRepository: OLD,
    newRepository: NEW,
    oldAuthEnv: 'CUTOVER_OLD_AUTH',
    newAuthEnv: 'CUTOVER_NEW_AUTH',
    composer: (args, context) => composer(args, context),
  };
});

afterEach(async () => {
  for (const [signal, listeners] of signalListeners) {
    const remaining = process.listeners(signal);
    for (const listener of remaining) {
      if (!listeners.includes(listener)) process.off(signal, listener);
    }
    expect(remaining).toEqual(listeners);
  }
  for (const entry of vi.mocked(mkdtemp).mock.results) {
    if (entry.type !== 'return') continue;
    const directory = await entry.value;
    if (typeof directory === 'string' && directory !== projectDir)
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(projectDir, { recursive: true, force: true });
});

async function expectRemoved() {
  expect(calls.length).toBeGreaterThan(0);
  for (const cwd of new Set(calls.map((call) => call.cwd))) {
    await expect(stat(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  }
}
async function projectHash() {
  const hash = createHash('sha256');
  for (const name of (await readdir(projectDir)).sort()) {
    hash.update(name).update(await readFile(join(projectDir, name)));
  }
  return hash.digest('hex');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('uses mode 0700 for both repository copies and every historic copy', async () => {
  const historic = join(projectDir, 'historic.lock');
  await writeFile(historic, lock());
  const base = composer;
  composer = async (args, context) => {
    expect((await stat(context.cwd)).mode & 0o777).toBe(0o700);
    return base(args, context);
  };
  expect((await runCutoverCheck({ ...options, historicLocks: [historic] })).exitCode).toBe(0);
  expect(new Set(calls.map((call) => call.cwd)).size).toBe(3);
});

it('refuses an unsafe temporary-directory mode before writing project files or running Composer', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(mkdtemp).mockImplementationOnce(async (prefix) => {
    const cwd = await actual.mkdtemp(prefix);
    await chmod(cwd, 0o755);
    return cwd;
  });
  vi.mocked(writeFile).mockClear();
  expect(await runCutoverCheck(options)).toMatchObject({ exitCode: 2, code: 'local_failed' });
  expect(writeFile).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});

it.each(
  (['SIGINT', 'SIGTERM'] as const).flatMap((signal) =>
    (['creation', 'version', 'historic'] as const).map((stage) => ({ signal, stage })),
  ),
)('removes every copy before re-raising $signal during $stage', async ({ signal, stage }) => {
  const historic = join(projectDir, 'historic.lock');
  await writeFile(historic, lock([pkg('acme/historic')]));
  const created: string[] = [];
  const reraised: { pid: number; signal: unknown; remaining: boolean[]; listeners: unknown[] }[] =
    [];
  vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
    reraised.push({
      pid,
      signal: value,
      remaining: created.map((cwd) => existsSync(cwd)),
      listeners: [...signalListeners.keys()].map((name) => process.listeners(name)),
    });
    return true;
  });
  let signaled = false;
  const interrupt = () => {
    const added = process
      .listeners(signal)
      .filter((fn) => !signalListeners.get(signal)!.includes(fn));
    if (added.length === 1) {
      signaled = true;
      added[0]!(signal);
      added[0]!(signal);
    }
  };
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(mkdtemp).mockImplementation(async (prefix) => {
    const cwd = await actual.mkdtemp(prefix);
    created.push(cwd);
    if (stage === 'creation' && created.length === 1) interrupt();
    return cwd;
  });
  const base = composer;
  composer = async (args, context) => {
    const result = await base(args, context);
    if (
      (stage === 'version' && args[0] === '--version') ||
      (stage === 'historic' &&
        args[0] === 'install' &&
        (await readFile(join(context.cwd, 'composer.lock'), 'utf8')).includes('acme/historic'))
    )
      interrupt();
    return result;
  };
  try {
    const result = await runCutoverCheck({ ...options, historicLocks: [historic] });
    expect(signaled).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(created).toHaveLength(stage === 'creation' ? 1 : stage === 'version' ? 2 : 3);
    expect(reraised).toEqual([
      {
        pid: process.pid,
        signal,
        remaining: created.map(() => false),
        listeners: [...signalListeners.values()],
      },
    ]);
  } finally {
    vi.mocked(mkdtemp).mockImplementation(actual.mkdtemp);
  }
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'cleans up and re-raises %s without waiting for a pending Composer call',
  async (signal) => {
    const entered = deferred();
    const release = deferred();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const base = composer;
    composer = async (args, context) => {
      const result = await base(args, context);
      if (args[0] === '--version') {
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const check = runCutoverCheck(options);
    try {
      await entered.promise;
      const added = process
        .listeners(signal)
        .filter((fn) => !signalListeners.get(signal)!.includes(fn));
      expect(added).toHaveLength(1);
      added[0]!(signal);
      await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, signal));
      await expectRemoved();
      expect(calls).toHaveLength(1);
    } finally {
      release.resolve();
      await check;
    }
  },
);

it('passes identical resolutions, preserves JSON bytes, isolates auth and leaves the project unchanged', async () => {
  vi.stubEnv('COMPOSER_AUTH', 'ambient-secret');
  vi.stubEnv('COMPOSER', '/untrusted/composer.json');
  vi.stubEnv('COMPOSER_VENDOR_DIR', '/untrusted/vendor');
  vi.stubEnv('UNRELATED_SECRET', SENTINEL);
  const before = await projectHash();
  const base = composer;
  composer = async (args, context) => {
    expect(context.shell).toBe(false);
    expect(context.env.COMPOSER_NO_INTERACTION).toBe('1');
    expect(context.env.COMPOSER_AUTH).toBe(calls.length < 3 ? oldAuth : newAuth);
    expect(context.env.COMPOSER).toBeUndefined();
    expect(context.env.COMPOSER_VENDOR_DIR).toBe(join(context.cwd, 'vendor'));
    expect(context.env.COMPOSER_BIN_DIR).toBe(join(context.cwd, 'vendor', 'bin'));
    expect(context.env.UNRELATED_SECRET).toBeUndefined();
    expect(context.env.PATH).toBe(process.env.PATH);
    expect(await readdir(context.env.COMPOSER_HOME!)).toEqual([]);
    expect((await readdir(context.cwd)).sort()).toEqual([
      '.composer-home',
      'composer.json',
      'composer.lock',
    ]);
    const expected = calls.length < 3 ? manifest : manifest.replace(`"${OLD}"`, `"${NEW}"`);
    expect(await readFile(join(context.cwd, 'composer.json'), 'utf8')).toBe(expected);
    return base(args, context);
  };
  expect(await runCutoverCheck(options)).toMatchObject({
    exitCode: 0,
    code: 'passed',
    counts: { old: 1, new: 1 },
    differences: [],
  });
  expect(calls.map((call) => call.args)).toEqual([
    ['--version'],
    ['update', '--lock', '--no-scripts', '--no-plugins'],
    ['install', '--no-scripts', '--no-plugins', '--no-autoloader'],
    ['update', '--lock', '--no-scripts', '--no-plugins'],
    ['install', '--no-scripts', '--no-plugins', '--no-autoloader'],
  ]);
  expect(await projectHash()).toBe(before);
  await expectRemoved();
});

it.each(['version', 'source', 'added', 'removed', 'dev'])(
  'fails and names the package for a %s resolution difference',
  async (kind) => {
    const base = composer;
    composer = async (args, context) => {
      if (args[0] === 'update' && context.env.COMPOSER_AUTH === newAuth) {
        const changed = pkg();
        if (kind === 'version') changed.version = '2.0.0';
        if (kind === 'source') changed.source.reference = 'other-source';
        await writeFile(
          join(context.cwd, 'composer.lock'),
          kind === 'added'
            ? lock([changed, pkg('acme/added')])
            : kind === 'removed'
              ? lock([])
              : kind === 'dev'
                ? lock([changed], [pkg('acme/dev')])
                : lock([changed]),
        );
      }
      return base(args, context);
    };
    expect(await runCutoverCheck(options)).toMatchObject({
      exitCode: 1,
      code: 'resolution_difference',
      differences: [kind === 'added' ? 'acme/added' : kind === 'dev' ? 'acme/dev' : 'acme/library'],
    });
    await expectRemoved();
  },
);

it.each(['source absent', 'source null', 'source empty', 'source equal', 'source changed'])(
  'uses source references when present and otherwise dist references (%s)',
  async (kind) => {
    const original = pkg();
    const changed = pkg();
    const packages = (value: ReturnType<typeof pkg>) =>
      JSON.stringify({
        packages: [
          {
            ...value,
            source:
              kind === 'source absent'
                ? undefined
                : kind === 'source null'
                  ? { reference: null }
                  : value.source,
          },
        ],
      });
    if (kind === 'source empty') original.source.reference = changed.source.reference = '';
    if (kind === 'source changed') changed.source.reference = 'other-source';
    changed.dist.reference = SENTINEL;
    await writeFile(join(projectDir, 'composer.lock'), packages(original));
    const base = composer;
    composer = async (args, context) => {
      if (args[0] === 'update' && context.env.COMPOSER_AUTH === newAuth)
        await writeFile(join(context.cwd, 'composer.lock'), packages(changed));
      return base(args, context);
    };
    const informational = kind === 'source equal' || kind === 'source empty';
    const result = await runCutoverCheck(options);
    expect(result).toMatchObject({
      exitCode: informational ? 0 : 1,
      code: informational ? 'passed' : 'resolution_difference',
      differences: informational ? [] : ['acme/library'],
      distOnly: informational ? ['acme/library'] : [],
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  },
);

it('reports sorted dist-only names independently from failing version and source differences', async () => {
  const originals = [pkg('acme/z'), pkg('acme/a'), pkg('acme/source'), pkg('acme/version')];
  await writeFile(join(projectDir, 'composer.lock'), lock([], originals));
  const base = composer;
  composer = async (args, context) => {
    if (args[0] === 'update' && context.env.COMPOSER_AUTH === newAuth) {
      const changed = originals.map((value) => ({
        ...value,
        source: { reference: value.name === 'acme/source' ? 'changed' : 'source-ref' },
        version: value.name === 'acme/version' ? '2.0.0' : value.version,
        dist: { ...value.dist, reference: 'repacked' },
      }));
      await writeFile(join(context.cwd, 'composer.lock'), lock([], changed));
    }
    return base(args, context);
  };
  expect(await runCutoverCheck(options)).toMatchObject({
    exitCode: 1,
    differences: ['acme/source', 'acme/version'],
    distOnly: ['acme/a', 'acme/z'],
    counts: { old: 4, new: 4 },
  });
});

it('compares sets independently of lock package order', async () => {
  const packages = [pkg(), pkg('acme/other')];
  await writeFile(join(projectDir, 'composer.lock'), lock(packages));
  const base = composer;
  composer = async (args, context) => {
    if (args[0] === 'update' && context.env.COMPOSER_AUTH === newAuth)
      await writeFile(join(context.cwd, 'composer.lock'), lock([...packages].reverse()));
    return base(args, context);
  };
  expect((await runCutoverCheck(options)).exitCode).toBe(0);
});

it('fails when a broker dev-package dist URL uses the old host, including another port', async () => {
  const base = composer;
  await writeFile(join(projectDir, 'composer.lock'), lock([], [pkg()]));
  composer = async (args, context) => {
    if (args[0] === 'update' && context.env.COMPOSER_AUTH === newAuth) {
      const bad = pkg();
      bad.dist.url = 'https://OLD.example.test:8443/files/archive.zip';
      await writeFile(join(context.cwd, 'composer.lock'), lock([], [bad]));
    }
    return base(args, context);
  };
  expect(await runCutoverCheck(options)).toMatchObject({
    exitCode: 1,
    code: 'old_dist_host',
    differences: [],
    oldHostPackages: ['acme/library'],
  });
});

it.each(['update', 'install', 'throw'])(
  'maps %s failures to fixed text, removes temporary copies and preserves project files',
  async (failure) => {
    const before = await projectHash();
    const base = composer;
    composer = async (args, context) => {
      await base(args, context);
      if (args[0] === (failure === 'update' ? 'update' : 'install')) {
        if (failure === 'throw') throw new Error(`${SENTINEL} ${oldAuth}`);
        return { exitCode: 17, stdout: SENTINEL, stderr: `${SENTINEL} ${oldAuth}` };
      }
      return args[0] === '--version' ? { ...success, stdout: 'Composer version 2.8.1' } : success;
    };
    const result = await runCutoverCheck(options);
    expect(result).toMatchObject({
      exitCode: 1,
      code: failure === 'update' ? 'update_failed' : 'install_failed',
      message: failure === 'update' ? 'Composer lock update failed.' : 'Composer install failed.',
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(await projectHash()).toBe(before);
    await expectRemoved();
  },
);

it('refreshes and installs each historic lock in a fresh copy and reports known missing package names only', async () => {
  const first = join(projectDir, 'historic.lock');
  const second = join(projectDir, 'second.lock');
  await writeFile(first, lock([pkg('acme/missing', '0.1.0')]));
  await writeFile(second, lock([pkg('acme/present', '0.2.0')]));
  const before = await projectHash();
  const base = composer;
  const historicCwds = new Set<string>();
  composer = async (args, context) => {
    const result = await base(args, context);
    const bytes = await readFile(join(context.cwd, 'composer.lock'), 'utf8');
    if (bytes.includes('0.1.0') || bytes.includes('0.2.0')) {
      historicCwds.add(context.cwd);
      expect(context.env.COMPOSER_AUTH).toBe(newAuth);
      expect(await readFile(join(context.cwd, 'composer.json'), 'utf8')).toBe(
        manifest.replace(`"${OLD}"`, `"${NEW}"`),
      );
      if (args[0] === 'install' && bytes.includes('0.1.0'))
        return {
          exitCode: 1,
          stdout: SENTINEL,
          stderr: `Failed to download acme/missing from dist: HTTP 404 ${SENTINEL}\nFailed to download untrusted/injected from dist: ${SENTINEL}`,
        };
    }
    return result;
  };
  const result = await runCutoverCheck({ ...options, historicLocks: [first, second] });
  expect(result).toMatchObject({
    exitCode: 1,
    code: 'historic_failed',
    historic: [
      { index: 1, ok: false, missingPackages: ['acme/missing'] },
      { index: 2, ok: true, missingPackages: [] },
    ],
  });
  expect(historicCwds.size).toBe(2);
  expect(calls.filter((call) => historicCwds.has(call.cwd)).map((call) => call.args[0])).toEqual([
    'update',
    'install',
    'update',
    'install',
  ]);
  expect(JSON.stringify(result)).not.toContain(SENTINEL);
  expect(await projectHash()).toBe(before);
  await expectRemoved();
});

it('supports named repository objects and escaped URL tokens without changing other bytes', async () => {
  const escaped = OLD.replaceAll('/', '\\/');
  const input = `{ "repositories" : {"private": {"url":"${escaped}"}, "packagist.org":false}, "extra":"${OLD}" }\n`;
  await writeFile(join(projectDir, 'composer.json'), input);
  const base = composer;
  composer = async (args, context) => {
    const expected =
      context.env.COMPOSER_AUTH === newAuth ? input.replace(`"${escaped}"`, `"${NEW}"`) : input;
    expect(await readFile(join(context.cwd, 'composer.json'), 'utf8')).toBe(expected);
    return base(args, context);
  };
  expect((await runCutoverCheck(options)).exitCode).toBe(0);
});

it.each([0, 2])(
  'refuses %i matching repository entries before invoking Composer',
  async (count) => {
    await writeFile(
      join(projectDir, 'composer.json'),
      JSON.stringify({ repositories: Array.from({ length: count }, () => ({ url: OLD })) }),
    );
    expect(await runCutoverCheck(options)).toMatchObject({ exitCode: 2, code: 'repository_match' });
    expect(calls).toEqual([]);
  },
);

it.each(['Composer version 1.10.0', 'Composer version 3.0.0', 'missing', 'throw'])(
  'requires Composer v2 (%s) and cleans up temporary directories',
  async (version) => {
    const base = composer;
    composer = async (args, context) => {
      await base(args, context);
      if (version === 'throw') throw new Error(SENTINEL);
      return { exitCode: version === 'missing' ? 127 : 0, stdout: version, stderr: SENTINEL };
    };
    expect(await runCutoverCheck(options)).toMatchObject({
      exitCode: 2,
      code: 'composer_v2_required',
      message: 'Composer v2 is required; install Composer v2 and make it available on PATH.',
    });
    expect(calls).toHaveLength(1);
    await expectRemoved();
  },
);

it.each(['missing auth', 'malformed auth', 'missing lock', 'malformed project', 'duplicate keys'])(
  'refuses invalid local input (%s) without leaking secrets or invoking Composer',
  async (kind) => {
    if (kind === 'missing auth') vi.stubEnv('CUTOVER_OLD_AUTH', undefined);
    if (kind === 'malformed auth') vi.stubEnv('CUTOVER_OLD_AUTH', SENTINEL);
    if (kind === 'missing lock') await rm(join(projectDir, 'composer.lock'));
    if (kind === 'malformed project') await writeFile(join(projectDir, 'composer.json'), SENTINEL);
    if (kind === 'duplicate keys')
      await writeFile(
        join(projectDir, 'composer.json'),
        `{"repositories":[{"url":"${OLD}"}],"repositories":[]}`,
      );
    const result = await runCutoverCheck(options);
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(calls).toEqual([]);
  },
);

it('treats absent and null references alike', async () => {
  await writeFile(
    join(projectDir, 'composer.lock'),
    JSON.stringify({
      packages: [{ name: 'acme/library', version: '1.0.0' }],
    }),
  );
  const base = composer;
  composer = async (args, context) => {
    if (args[0] === 'update' && context.env.COMPOSER_AUTH === newAuth)
      await writeFile(
        join(context.cwd, 'composer.lock'),
        JSON.stringify({
          packages: [
            {
              name: 'acme/library',
              version: '1.0.0',
              source: { reference: null },
              dist: { reference: null },
            },
          ],
        }),
      );
    return base(args, context);
  };
  expect((await runCutoverCheck(options)).exitCode).toBe(0);
});

it.each(['update missing', 'install unavailable', 'auth failure', 'old host'])(
  'fails a historic check for %s and distinguishes unavailable packages from auth failures',
  async (kind) => {
    const path = join(projectDir, 'historic.lock');
    await writeFile(path, lock([pkg('acme/historic', '0.1.0')]));
    const base = composer;
    composer = async (args, context) => {
      const result = await base(args, context);
      if ((await readFile(join(context.cwd, 'composer.lock'), 'utf8')).includes('acme/historic')) {
        if (kind === 'old host' && args[0] === 'update') {
          const historic = pkg('acme/historic', '0.1.0');
          historic.dist.url = `${OLD}archive.zip`;
          await writeFile(join(context.cwd, 'composer.lock'), lock([historic]));
        }
        if (
          (kind === 'update missing' && args[0] === 'update') ||
          (kind !== 'old host' && args[0] === 'install')
        )
          return {
            exitCode: 1,
            stdout: SENTINEL,
            stderr:
              kind === 'auth failure'
                ? `Failed to download acme/historic from dist: HTTP 401 ${SENTINEL}`
                : `acme/historic could not be found in remote repositories ${SENTINEL}`,
          };
      }
      return result;
    };
    expect(await runCutoverCheck({ ...options, historicLocks: [path] })).toMatchObject({
      exitCode: 1,
      code: kind === 'old host' ? 'old_dist_host' : 'historic_failed',
      historic: [
        {
          index: 1,
          ok: false,
          missingPackages: kind === 'old host' || kind === 'auth failure' ? [] : ['acme/historic'],
        },
      ],
    });
    await expectRemoved();
  },
);

it('maps a new-repository install failure to fixed text and cleans up both copies', async () => {
  const base = composer;
  composer = async (args, context) => {
    const result = await base(args, context);
    return args[0] === 'install' && context.env.COMPOSER_AUTH === newAuth
      ? { exitCode: 7, stdout: SENTINEL, stderr: SENTINEL }
      : result;
  };
  expect(await runCutoverCheck(options)).toMatchObject({ exitCode: 1, code: 'install_failed' });
  expect(calls).toHaveLength(5);
  await expectRemoved();
});

it('does not report a package missing when a failed dist download falls back to a successful source install', async () => {
  const path = join(projectDir, 'historic.lock');
  await writeFile(path, lock([pkg('acme/historic', '0.1.0')]));
  const base = composer;
  composer = async (args, context) => {
    const result = await base(args, context);
    if (args[0] === 'install')
      return {
        ...result,
        stderr: `Failed to download acme/historic from dist: HTTP 404 ${SENTINEL}\nNow trying to download from source`,
      };
    return result;
  };
  expect(await runCutoverCheck({ ...options, historicLocks: [path] })).toMatchObject({
    exitCode: 0,
    historic: [{ index: 1, ok: true, missingPackages: [] }],
  });
});

it.each(['../local/library', '/artifacts/library.zip', null])(
  'accepts path/artifact and null dist URLs (%s)',
  async (url) => {
    await writeFile(
      join(projectDir, 'composer.lock'),
      JSON.stringify({
        packages: [
          {
            ...pkg(),
            dist: { type: url?.startsWith('../') ? 'path' : 'zip', reference: 'dist-ref', url },
          },
        ],
      }),
    );
    expect(await runCutoverCheck(options)).toMatchObject({ exitCode: 0, code: 'passed' });
  },
);

it('reports a historic update failure without scanning the unchanged old-host lock', async () => {
  const path = join(projectDir, 'historic.lock');
  const historic = pkg('acme/historic');
  historic.dist.url = `${OLD}archive.zip`;
  await writeFile(path, lock([historic]));
  const base = composer;
  composer = async (args, context) => {
    const result = await base(args, context);
    if ((await readFile(join(context.cwd, 'composer.lock'), 'utf8')).includes('acme/historic')) {
      expect(args[0]).toBe('update');
      return {
        exitCode: 2,
        stdout: SENTINEL,
        stderr: 'acme/historic does not match the constraint',
      };
    }
    return result;
  };
  expect(await runCutoverCheck({ ...options, historicLocks: [path] })).toMatchObject({
    exitCode: 1,
    code: 'historic_failed',
    oldHostPackages: [],
    historic: [{ ok: false, missingPackages: ['acme/historic'] }],
  });
});

it('reports old-host downloads and resolution differences before a broker install can fail', async () => {
  const base = composer;
  composer = async (args, context) => {
    const result = await base(args, context);
    if (context.env.COMPOSER_AUTH === newAuth) {
      if (args[0] === 'update') {
        const changed = pkg('acme/library', '2.0.0');
        changed.dist.url = `${OLD}archive.zip`;
        await writeFile(join(context.cwd, 'composer.lock'), lock([changed]));
      }
      if (args[0] === 'install') return { exitCode: 7, stdout: '', stderr: SENTINEL };
    }
    return result;
  };
  expect(await runCutoverCheck(options)).toMatchObject({
    exitCode: 1,
    code: 'old_dist_host',
    oldHostPackages: ['acme/library'],
    differences: ['acme/library'],
  });
});

it.each(['absent', 'null', 'different source SHA'])(
  'accepts a broker-side dropped source with equal dist SHA (%s)',
  async (kind) => {
    const original = pkg();
    if (kind !== 'different source SHA') original.dist.reference = original.source.reference;
    await writeFile(join(projectDir, 'composer.lock'), lock([original]));
    const base = composer;
    composer = async (args, context) => {
      if (args[0] === 'update' && context.env.COMPOSER_AUTH === newAuth)
        await writeFile(
          join(context.cwd, 'composer.lock'),
          JSON.stringify({
            packages: [{ ...original, source: kind === 'null' ? null : undefined }],
          }),
        );
      return base(args, context);
    };
    expect(await runCutoverCheck(options)).toMatchObject({
      exitCode: 0,
      code: 'passed',
      differences: [],
      distOnly: [],
    });
  },
);

it.each([
  'acme/missing does not match the constraint',
  'Package acme/missing. could not be found',
  'HTTP 404 https://broker.example.test/acme/missing/archive.zip',
])('recognizes missing packages in constraints, punctuation and URLs: %s', async (stderr) => {
  const path = join(projectDir, 'historic.lock');
  await writeFile(path, lock([pkg('acme/missing')]));
  const base = composer;
  composer = async (args, context) => {
    const result = await base(args, context);
    if (
      args[0] === 'update' &&
      (await readFile(join(context.cwd, 'composer.lock'), 'utf8')).includes('acme/missing')
    )
      return { exitCode: 2, stdout: SENTINEL, stderr };
    return result;
  };
  expect(await runCutoverCheck({ ...options, historicLocks: [path] })).toMatchObject({
    code: 'historic_failed',
    historic: [{ missingPackages: ['acme/missing'] }],
  });
});

it('excludes successful source fallbacks when another historic package fails', async () => {
  const path = join(projectDir, 'historic.lock');
  await writeFile(
    path,
    lock([pkg('acme/fallback'), pkg('acme/missing'), pkg('acme/missing-extra')]),
  );
  const base = composer;
  composer = async (args, context) => {
    const result = await base(args, context);
    if (
      args[0] === 'install' &&
      (await readFile(join(context.cwd, 'composer.lock'), 'utf8')).includes('acme/fallback')
    )
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Failed to download acme/fallback from dist: HTTP 404
Now trying to download from source
  - Installing acme/fallback (1.0.0): Cloning source-ref
Failed to download acme/missing from dist: HTTP 404`,
      };
    return result;
  };
  expect(await runCutoverCheck({ ...options, historicLocks: [path] })).toMatchObject({
    code: 'historic_failed',
    historic: [{ missingPackages: ['acme/missing'] }],
  });
});

it.each(['old-org', 'new-org', 'old-org-extra'])(
  'scopes same-host cutover downloads to the old organization (%s)',
  async (organization) => {
    const oldRepository = 'https://repo.packagist.com/old-org/';
    const newRepository = 'https://repo.packagist.com/new-org/';
    await writeFile(join(projectDir, 'composer.json'), manifest.replaceAll(OLD, oldRepository));
    const base = composer;
    composer = async (args, context) => {
      if (args[0] === 'update' && context.env.COMPOSER_AUTH === newAuth) {
        const changed = pkg();
        changed.dist.url = `https://REPO.packagist.com:8443/${organization}/dists/acme/library.zip`;
        await writeFile(join(context.cwd, 'composer.lock'), lock([changed]));
      }
      return base(args, context);
    };
    expect(await runCutoverCheck({ ...options, oldRepository, newRepository })).toMatchObject({
      exitCode: organization === 'old-org' ? 1 : 0,
      oldHostPackages: organization === 'old-org' ? ['acme/library'] : [],
    });
  },
);

it('preserves a UTF-8 BOM and surrounding manifest bytes in both copies', async () => {
  const input = '\uFEFF' + manifest;
  await writeFile(join(projectDir, 'composer.json'), input);
  const before = await projectHash();
  const base = composer;
  composer = async (args, context) => {
    expect(await readFile(join(context.cwd, 'composer.json'), 'utf8')).toBe(
      context.env.COMPOSER_AUTH === newAuth ? input.replace(`"${OLD}"`, `"${NEW}"`) : input,
    );
    return base(args, context);
  };
  expect(await runCutoverCheck(options)).toMatchObject({ code: 'passed', exitCode: 0 });
  expect(await projectHash()).toBe(before);
});

it.each([17, 'ENOENT'])('retains safe diagnostics from thrown runner errors (%s)', async (code) => {
  const base = composer;
  composer = async (args, context) => {
    const result = await base(args, context);
    if (args[0] === 'update') throw Object.assign(new Error(SENTINEL), { code });
    return result;
  };
  const result = await runCutoverCheck(options);
  expect(result).toMatchObject({
    exitCode: 1,
    code: 'update_failed',
    diagnostics: [
      {
        step: 'update',
        exitCode: typeof code === 'number' ? code : null,
        ...(typeof code === 'string' ? { errorCode: code } : {}),
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain(SENTINEL);
});

it.each([
  ['https://same.test/org/old', 'https://same.test/org/new'],
  ['https://same.test/', 'https://same.test/new/'],
  ['https://same.test/old/', 'https://same.test/'],
  ['https://same.test//old', 'https://same.test/new/'],
])('refuses ambiguous same-host organizations (%s → %s)', async (oldRepository, newRepository) => {
  await writeFile(join(projectDir, 'composer.json'), manifest.replaceAll(OLD, oldRepository));
  expect(await runCutoverCheck({ ...options, oldRepository, newRepository })).toMatchObject({
    exitCode: 2,
    code: 'invalid_input',
  });
  expect(calls).toEqual([]);
});

it.each([0, -1, 7201, 1.5, NaN, Infinity])(
  'refuses invalid timeout before running Composer (%s)',
  async (timeoutSeconds) => {
    expect(await runCutoverCheck({ ...options, timeoutSeconds })).toMatchObject({
      exitCode: 2,
      code: 'invalid_input',
    });
    expect(calls).toEqual([]);
  },
);
