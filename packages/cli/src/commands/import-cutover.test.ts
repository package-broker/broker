import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { run } from '../cli.js';
import * as cutover from '../import/cutover.js';
import { runImportCutover } from './import-cutover.js';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const OLD = 'https://old.example.test/repository/';
const NEW = 'https://broker.example.test/project/';
const SENTINEL = 'cutover-auth-sentinel';
const ok = { exitCode: 0, stdout: '', stderr: '' };
let projectDir: string;
let options: cutover.CutoverOptions;
let composer: cutover.ComposerRunner;
let output: MockInstance<typeof console.log>;
let errors: MockInstance<typeof console.error>;
let directories: Set<string>;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'pb-cutover-command-'));
  await writeFile(
    join(projectDir, 'composer.json'),
    JSON.stringify({ repositories: [{ type: 'composer', url: OLD }] }),
  );
  await writeFile(
    join(projectDir, 'composer.lock'),
    JSON.stringify({ packages: [{ name: 'acme/library', version: '1.0.0' }] }),
  );
  vi.stubEnv('OLD_CUTOVER_AUTH', JSON.stringify({ bearer: { 'old.example.test': SENTINEL } }));
  vi.stubEnv('NEW_CUTOVER_AUTH', JSON.stringify({ bearer: { 'broker.example.test': SENTINEL } }));
  directories = new Set();
  composer = async (args, context) => {
    directories.add(context.cwd);
    return args[0] === '--version' ? { ...ok, stdout: 'Composer version 2.8.1' } : ok;
  };
  options = {
    projectDir,
    oldRepository: OLD,
    newRepository: NEW,
    oldAuthEnv: 'OLD_CUTOVER_AUTH',
    newAuthEnv: 'NEW_CUTOVER_AUTH',
    composer: (args, context) => composer(args, context),
  };
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  expect(JSON.stringify(output.mock.calls)).not.toContain(SENTINEL);
  expect(JSON.stringify(errors.mock.calls)).not.toContain(SENTINEL);
  for (const cwd of directories) await expect(stat(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(projectDir, { recursive: true, force: true });
});

it('prints a human summary and exits zero on success', async () => {
  expect(await runImportCutover(options)).toBe(0);
  expect(output.mock.calls.map((call) => call[0])).toEqual([
    'Composer cutover check passed.',
    'Packages: old=1 new=1',
  ]);
});

it.each([false, true])(
  'keeps Composer failure details and auth out of output (json=%s)',
  async (json) => {
    const base = composer;
    composer = async (args, context) => {
      await base(args, context);
      return args[0] === 'install'
        ? { exitCode: 1, stdout: SENTINEL, stderr: `download failed ${SENTINEL} user@example.test` }
        : { ...ok, stdout: 'Composer version 2.8.1' };
    };
    expect(await runImportCutover({ ...options, json })).toBe(1);
    if (json) {
      expect(output).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
        exitCode: 1,
        code: 'install_failed',
        message: 'Composer install failed.',
      });
    } else expect(output).toHaveBeenCalledWith('Composer install failed.');
    expect(JSON.stringify(output.mock.calls)).not.toContain('user@example.test');
  },
);

it('prints differing package names without versions or references', async () => {
  const base = composer;
  composer = async (args, context) => {
    if (args[0] === 'update') {
      const manifest = await readFile(join(context.cwd, 'composer.json'), 'utf8');
      if (manifest.includes(NEW))
        await writeFile(
          join(context.cwd, 'composer.lock'),
          JSON.stringify({ packages: [{ name: 'acme/library', version: SENTINEL }] }),
        );
    }
    return base(args, context);
  };
  expect(await runImportCutover(options)).toBe(1);
  expect(output).toHaveBeenCalledWith('Resolution differs: acme/library');
});

it.each([false, true])('reports dist-only changes as information (json=%s)', async (json) => {
  const original = {
    name: 'acme/library',
    version: '1.0.0',
    source: { reference: 'same-source' },
    dist: { reference: 'old-dist' },
  };
  await writeFile(join(projectDir, 'composer.lock'), JSON.stringify({ packages: [original] }));
  const base = composer;
  composer = async (args, context) => {
    if (
      args[0] === 'update' &&
      (await readFile(join(context.cwd, 'composer.json'), 'utf8')).includes(NEW)
    )
      await writeFile(
        join(context.cwd, 'composer.lock'),
        JSON.stringify({ packages: [{ ...original, dist: { reference: SENTINEL } }] }),
      );
    return base(args, context);
  };
  expect(await runImportCutover({ ...options, json })).toBe(0);
  if (json)
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      code: 'passed',
      differences: [],
      distOnly: ['acme/library'],
    });
  else expect(output).toHaveBeenCalledWith('Dist reference differs (information): acme/library');
});

it('maps thrown runner errors to fixed messages without exposing them', async () => {
  composer = async () => {
    throw new Error(SENTINEL);
  };
  expect(await runImportCutover(options)).toBe(2);
  expect(output).toHaveBeenCalledWith(
    'Composer v2 is required; install Composer v2 and make it available on PATH.',
  );
});

const flags = () => [
  '--project-dir',
  projectDir,
  '--old-repository',
  OLD,
  '--new-repository',
  NEW,
  '--old-auth-env',
  'OLD_CUTOVER_AUTH',
  '--new-auth-env',
  'NEW_CUTOVER_AUTH',
];

it('requires the old repository URL even when all other flags are supplied', async () => {
  const checker = vi.spyOn(cutover, 'runCutoverCheck');
  const args = flags();
  args.splice(args.indexOf('--old-repository'), 2);
  expect(await run(['import', 'cutover-check', ...args])).toBe(2);
  expect(checker).not.toHaveBeenCalled();
});

it('routes the CLI flags, repeated historic locks and JSON output to the checker', async () => {
  const real = cutover.runCutoverCheck;
  const checker = vi
    .spyOn(cutover, 'runCutoverCheck')
    .mockImplementation((input) => real({ ...input, composer: options.composer! }));
  const first = join(projectDir, 'first.lock');
  const second = join(projectDir, 'second.lock');
  const lock = await readFile(join(projectDir, 'composer.lock'));
  await writeFile(first, lock);
  await writeFile(second, lock);
  expect(
    await run(['import', 'cutover-check', ...flags(), '--lock', first, '--lock', second, '--json']),
  ).toBe(0);
  expect(checker).toHaveBeenCalledWith({
    projectDir,
    oldRepository: OLD,
    newRepository: NEW,
    oldAuthEnv: 'OLD_CUTOVER_AUTH',
    newAuthEnv: 'NEW_CUTOVER_AUTH',
    historicLocks: [first, second],
    json: true,
  });
  expect(output).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
    exitCode: 0,
    historic: [
      { index: 1, ok: true, missingPackages: [] },
      { index: 2, ok: true, missingPackages: [] },
    ],
  });
});

it.each([
  ['import', 'cutover-check'],
  ['import', 'cutover-check', '--project-dir'],
  ['import', 'cutover-check', '--lock'],
  ['import', 'cutover-check', '--broker', OLD],
  ['import', 'cutover-check', 'extra'],
  ['version', '--old-repository', OLD],
])('rejects missing, extra and unrelated arguments: %j', async (...argv) => {
  const checker = vi.spyOn(cutover, 'runCutoverCheck');
  expect(await run(argv)).toBe(2);
  expect(checker).not.toHaveBeenCalled();
});

it('returns local validation exit 2 in JSON for unreadable project files', async () => {
  expect(
    await run([
      'import',
      'cutover-check',
      ...flags(),
      '--project-dir',
      join(projectDir, 'absent'),
      '--json',
    ]),
  ).toBe(2);
  expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
    exitCode: 2,
    code: 'input_unreadable',
  });
});

it.each([false, true])(
  'defaults to execFile without a shell and handles a missing binary (missing=%s)',
  async (missing) => {
    execFileMock.mockImplementation(
      (
        binary: string,
        args: string[],
        context: { cwd: string; shell: boolean; env: NodeJS.ProcessEnv },
        callback: (error: unknown, stdout: string, stderr: string) => void,
      ) => {
        expect(binary).toBe('composer');
        expect(context.shell).toBe(false);
        expect(context.cwd).not.toBe(projectDir);
        directories.add(context.cwd);
        callback(
          missing ? new Error(SENTINEL) : null,
          args[0] === '--version' ? 'Composer version 2.8.1' : SENTINEL,
          SENTINEL,
        );
      },
    );
    const { composer: _composer, ...defaultOptions } = options;
    expect(_composer).toBeDefined();
    expect(await runImportCutover(defaultOptions)).toBe(missing ? 2 : 0);
    expect(execFileMock).toHaveBeenCalledTimes(missing ? 1 : 5);
    if (missing)
      expect(output).toHaveBeenCalledWith(
        'Composer v2 is required; install Composer v2 and make it available on PATH.',
      );
    execFileMock.mockReset();
  },
);

it.each(['update', 'install'])(
  'bounds Composer output/time and maps a %s timeout without leaking child text',
  async (step) => {
    execFileMock.mockImplementation((_: string, args: string[], context, callback) => {
      directories.add(context.cwd);
      expect(context.maxBuffer).toBe(64 * 1024 * 1024);
      expect(context.timeout).toBe(300_000);
      callback(
        args[0] === step
          ? Object.assign(new Error(SENTINEL), { killed: true, signal: 'SIGTERM', code: null })
          : null,
        args[0] === '--version' ? 'Composer version 2.8.1' : SENTINEL,
        SENTINEL,
      );
    });
    const { composer: _, ...input } = options;
    expect(_).toBeDefined();
    expect(await runImportCutover({ ...input, json: true })).toBe(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      code: `${step}_failed`,
      diagnostics: [{ step, exitCode: null, errorCode: 'ETIMEDOUT', signal: 'SIGTERM' }],
    });
    execFileMock.mockReset();
  },
);

it.each([17, 'ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'unsafe-secret-code'])(
  'retains only safe process diagnostics (%s)',
  async (code) => {
    execFileMock.mockImplementation((_: string, args: string[], context, callback) => {
      directories.add(context.cwd);
      callback(
        args[0] === 'install' ? Object.assign(new Error(SENTINEL), { code }) : null,
        args[0] === '--version' ? 'Composer version 2.8.1' : SENTINEL,
        SENTINEL,
      );
    });
    const { composer: _, ...input } = options;
    expect(_).toBeDefined();
    expect(await runImportCutover({ ...input, json: true })).toBe(1);
    const result = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(result).toMatchObject({
      code: 'install_failed',
      diagnostics: [{ step: 'install', exitCode: typeof code === 'number' ? code : null }],
    });
    if (code === 'ENOENT' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      expect(result.diagnostics[0].errorCode).toBe(code);
    expect(JSON.stringify(result)).not.toContain('unsafe-secret-code');
    execFileMock.mockReset();
  },
);

it.each(['SIGINT', 'SIGTERM'] as const)(
  'terminates the active Composer child before deleting copies on %s',
  async (signal) => {
    let callback!: (error: unknown, stdout: string, stderr: string) => void;
    let context!: { cwd: string };
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    const listeners = process.listeners(signal);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    execFileMock.mockImplementation((_: string, __: string[], input, done) => {
      context = input;
      callback = done;
      directories.add(context.cwd);
      enter();
      return child;
    });
    const { composer: _, ...input } = options;
    expect(_).toBeDefined();
    const check = runImportCutover(input);
    try {
      await entered;
      const handler = process.listeners(signal).find((fn) => !listeners.includes(fn))!;
      handler(signal);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      await stat(context.cwd);
      expect(kill).not.toHaveBeenCalled();
      callback(Object.assign(new Error(SENTINEL), { code: 'ABORT_ERR' }), '', '');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await stat(context.cwd);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      callback(Object.assign(new Error(SENTINEL), { code: 'ABORT_ERR' }), '', '');
      child.emit('close', null, 'SIGKILL');
      await check;
      execFileMock.mockReset();
    }
    expect(kill).toHaveBeenCalledWith(process.pid, signal);
  },
);

it('prints a fixed missing-binary diagnostic alongside the Composer v2 requirement', async () => {
  composer = async () => {
    throw Object.assign(new Error(SENTINEL), { code: 'ENOENT' });
  };
  expect(await runImportCutover(options)).toBe(2);
  expect(output).toHaveBeenCalledWith('Composer version: exit=none error=ENOENT');
});
