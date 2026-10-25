import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ComposerResult {
  readonly exitCode: number | null;
  readonly errorCode?: string;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
}

export type ComposerRunner = (
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly shell: false;
    readonly signal?: AbortSignal;
  },
) => Promise<ComposerResult>;

export interface CutoverOptions {
  readonly projectDir: string;
  readonly oldRepository: string;
  readonly newRepository: string;
  readonly oldAuthEnv: string;
  readonly newAuthEnv: string;
  readonly historicLocks?: readonly string[];
  readonly composer?: ComposerRunner;
}

const MESSAGES = {
  passed: 'Composer cutover check passed.',
  resolution_difference: 'Composer lock resolutions differ.',
  old_dist_host: 'New repository lock still uses the old repository host.',
  update_failed: 'Composer lock update failed.',
  install_failed: 'Composer install failed.',
  historic_failed: 'Historic lock check failed.',
  composer_v2_required:
    'Composer v2 is required; install Composer v2 and make it available on PATH.',
  invalid_input:
    'Supply a project, HTTP(S) repository URLs and named authentication environment variables.',
  repository_match: 'Exactly one repository entry must match the old repository URL.',
  input_unreadable: 'Could not read valid Composer project or historic lock files.',
  local_failed: 'Could not prepare, read or remove temporary Composer files.',
} as const;
type Code = keyof typeof MESSAGES;

export interface CutoverResult {
  readonly exitCode: 0 | 1 | 2;
  readonly code: Code;
  readonly message: string;
  readonly counts: { readonly old: number; readonly new: number };
  readonly differences: readonly string[];
  readonly distOnly: readonly string[];
  readonly oldHostPackages: readonly string[];
  readonly diagnostics: readonly {
    readonly step: 'version' | 'update' | 'install';
    readonly exitCode: number | null;
    readonly errorCode?: string;
    readonly signal?: string;
  }[];
  readonly historic: readonly {
    readonly index: number;
    readonly ok: boolean;
    readonly missingPackages: readonly string[];
  }[];
}

class CutoverError extends Error {
  constructor(readonly code: Code) {
    super(MESSAGES[code]);
  }
}

const defaultComposer: ComposerRunner = (args, options) =>
  new Promise((resolve) => {
    const { signal, ...executionOptions } = options;
    let closed = false;
    let abortedResult: ComposerResult | undefined;
    const child = execFile(
      'composer',
      [...args],
      { ...executionOptions, maxBuffer: 64 * 1024 * 1024, timeout: 300_000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const result: ComposerResult = {
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}),
          ...(error?.killed && !signal?.aborted && error.code == null
            ? { errorCode: 'ETIMEDOUT' }
            : {}),
          ...(error?.signal ? { signal: error.signal } : {}),
          stdout,
          stderr,
        };
        // Abort callbacks can precede child exit; cleanup must wait for close.
        if (signal?.aborted && !closed) abortedResult = result;
        else resolve(result);
      },
    );
    const terminate = () => {
      child?.kill('SIGKILL');
    };
    signal?.addEventListener('abort', terminate, { once: true });
    if (signal?.aborted) terminate();
    child?.once('close', () => {
      signal?.removeEventListener('abort', terminate);
      closed = true;
      if (abortedResult) resolve(abortedResult);
    });
  });

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function repositoryHost(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new CutoverError('invalid_input');
  return url.hostname;
}

function auth(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CutoverError('invalid_input');
  const value = process.env[name];
  if (value === undefined || !object(JSON.parse(value))) throw new CutoverError('invalid_input');
  return value;
}

// Walk validated JSON tokens to replace only the matching URL's original byte span.
function rewriteRepository(text: string, oldUrl: string, newUrl: string): string {
  const json: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!object(json)) throw new CutoverError('input_unreadable');
  let cursor = 0;
  const matches: { start: number; end: number }[] = [];
  const whitespace = () => {
    while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
  };
  const string = (): { value: string; start: number; end: number } => {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '\\') cursor++;
      else if (char === '"') break;
    }
    return { value: JSON.parse(text.slice(start, cursor)) as string, start, end: cursor };
  };
  const walk = (path: readonly string[]): void => {
    whitespace();
    const char = text[cursor];
    if (char === '"') {
      const token = string();
      if (path.length === 3 && path[0] === 'repositories' && path[2] === 'url') {
        if (token.value === oldUrl) matches.push(token);
      }
    } else if (char === '{' || char === '[') {
      cursor++;
      whitespace();
      const end = char === '{' ? '}' : ']';
      const keys = new Set<string>();
      let index = 0;
      while (text[cursor] !== end) {
        whitespace();
        const key = char === '{' ? string().value : String(index++);
        if (keys.has(key)) throw new CutoverError('input_unreadable');
        keys.add(key);
        if (char === '{') {
          whitespace();
          cursor++;
        }
        walk([...path, key]);
        whitespace();
        if (text[cursor] !== ',') break;
        cursor++;
      }
      cursor++;
    } else {
      while (cursor < text.length && !/[\s,\]}]/.test(text[cursor]!)) cursor++;
    }
  };
  walk([]);
  if (matches.length !== 1) throw new CutoverError('repository_match');
  const match = matches[0]!;
  return text.slice(0, match.start) + JSON.stringify(newUrl) + text.slice(match.end);
}

interface LockedPackage {
  readonly name: string;
  readonly tuple: string;
  readonly sourceReference: string | null;
  readonly distReference: string | null;
  readonly distUrl: string | undefined;
}
function packages(text: string): LockedPackage[] {
  const lock: unknown = JSON.parse(text);
  if (!object(lock) || !Array.isArray(lock.packages)) throw new Error();
  const result: LockedPackage[] = [];
  for (const group of [lock.packages, lock['packages-dev'] ?? []]) {
    if (!Array.isArray(group)) throw new Error();
    for (const pkg of group as unknown[]) {
      if (
        !object(pkg) ||
        typeof pkg.name !== 'string' ||
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(pkg.name) ||
        typeof pkg.version !== 'string'
      )
        throw new Error();
      const reference = (value: unknown) => {
        if (value === undefined || value === null) return null;
        if (!object(value)) throw new Error();
        const ref = value.reference ?? null;
        if (ref !== null && typeof ref !== 'string') throw new Error();
        return ref || null;
      };
      if (pkg.dist !== undefined && pkg.dist !== null && !object(pkg.dist)) throw new Error();
      const distUrl = object(pkg.dist) ? (pkg.dist.url ?? undefined) : undefined;
      if (distUrl !== undefined && typeof distUrl !== 'string') throw new Error();
      const sourceReference = reference(pkg.source);
      const distReference = reference(pkg.dist);
      result.push({
        name: pkg.name,
        tuple: JSON.stringify([
          pkg.name,
          pkg.version,
          sourceReference,
          sourceReference ?? distReference,
        ]),
        sourceReference,
        distReference,
        distUrl,
      });
    }
  }
  return result;
}

const names = (values: readonly LockedPackage[]) => [...new Set(values.map((p) => p.name))].sort();
function oldHostPackages(
  values: readonly LockedPackage[],
  repository: URL,
  sameHost: boolean,
): string[] {
  return names(
    values.filter((pkg) => {
      if (pkg.distUrl === undefined) return false;
      try {
        const url = new URL(pkg.distUrl);
        return (
          url.hostname === repository.hostname &&
          (!sameHost || url.pathname.split('/')[1] === repository.pathname.split('/')[1])
        );
      } catch {
        return false;
      }
    }),
  );
}

function missingPackages(output: ComposerResult, locked: readonly LockedPackage[]): string[] {
  const lines = `${output.stdout}\n${output.stderr}`.split(/\r?\n/);
  return names(locked).filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentions = new RegExp(
      `(?:^|[^a-z0-9_.-])${escaped}(?=$|[^a-z0-9_.-]|[.](?:$|[^a-z0-9_.-]))`,
      'i',
    );
    let missing = false;
    for (const line of lines) {
      if (!mentions.test(line)) continue;
      if (
        /could not be found|cannot be found|not (?:found|available)|\b(?:404|410)\b|no matching package|could not find a matching version|does not match the constraint/i.test(
          line,
        )
      )
        missing = true;
      else if (
        /\b(?:Installing|Updating)\b.*(?:Cloning|Checking out|Extracting archive)|\bInstalled\b/i.test(
          line,
        )
      )
        missing = false;
    }
    return missing;
  });
}

export async function runCutoverCheck(options: CutoverOptions): Promise<CutoverResult> {
  const directories: string[] = [];
  let result: CutoverResult = {
    exitCode: 2,
    code: 'local_failed',
    message: MESSAGES.local_failed,
    counts: { old: 0, new: 0 },
    differences: [],
    distOnly: [],
    oldHostPackages: [],
    historic: [],
    diagnostics: [],
  };
  const outcome = (code: Code, exitCode: 0 | 1 | 2) => {
    result = { ...result, code, message: MESSAGES[code], exitCode };
  };
  const controller = new AbortController();
  let activeChild: Promise<ComposerResult> | undefined;
  let interrupted = false;
  let preparation: Promise<Parameters<ComposerRunner>[1]> | undefined;
  let cleanup: Promise<void> | undefined;
  let signalCleanup: Promise<void> | undefined;
  const ensureRunning = () => {
    if (interrupted) throw new CutoverError('local_failed');
  };
  const removeDirectories = () =>
    (cleanup ??= (async () => {
      for (const directory of directories) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          outcome('local_failed', 2);
        }
      }
    })());
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const removeHandlers = () => {
    for (const signal of signals) process.off(signal, onSignal);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    controller.abort();
    signalCleanup = (async () => {
      // A pending mkdtemp must finish registering its directory before cleanup.
      await preparation?.catch(() => undefined);
      await activeChild?.catch(() => undefined);
      await removeDirectories();
      removeHandlers();
      process.kill(process.pid, signal);
    })();
  };
  for (const signal of signals) process.on(signal, onSignal);
  try {
    let oldRepository: URL;
    let sameHost: boolean;
    let oldAuth: string;
    let newAuth: string;
    try {
      if (!options.projectDir || options.oldRepository === options.newRepository) throw new Error();
      const oldHost = repositoryHost(options.oldRepository);
      sameHost = oldHost === repositoryHost(options.newRepository);
      oldRepository = new URL(options.oldRepository);
      oldAuth = auth(options.oldAuthEnv);
      newAuth = auth(options.newAuthEnv);
    } catch {
      throw new CutoverError('invalid_input');
    }
    let original: string;
    let rewritten: string;
    let lock: Buffer;
    let historic: Buffer[];
    try {
      const project = await readFile(join(options.projectDir, 'composer.json'));
      original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(project);
      rewritten = rewriteRepository(original, options.oldRepository, options.newRepository);
      lock = await readFile(join(options.projectDir, 'composer.lock'));
      packages(lock.toString('utf8'));
      historic = [];
      for (const path of options.historicLocks ?? []) {
        const bytes = await readFile(path);
        packages(bytes.toString('utf8'));
        historic.push(bytes);
      }
    } catch (error) {
      throw error instanceof CutoverError ? error : new CutoverError('input_unreadable');
    }
    const composer = options.composer ?? defaultComposer;
    const prepare = (json: string, bytes: Buffer, credentials: string) =>
      (preparation = (async () => {
        ensureRunning();
        const cwd = await mkdtemp(join(tmpdir(), 'pb-cutover-'));
        directories.push(cwd);
        if (((await stat(cwd)).mode & 0o777) !== 0o700) throw new CutoverError('local_failed');
        const home = join(cwd, '.composer-home');
        await mkdir(home);
        await writeFile(join(cwd, 'composer.json'), json);
        await writeFile(join(cwd, 'composer.lock'), bytes);
        const env: NodeJS.ProcessEnv = {};
        for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
          if (process.env[key] !== undefined) env[key] = process.env[key];
        }
        Object.assign(env, {
          HOME: cwd,
          USERPROFILE: cwd,
          COMPOSER_HOME: home,
          COMPOSER_CACHE_DIR: join(cwd, '.composer-cache'),
          COMPOSER_VENDOR_DIR: join(cwd, 'vendor'),
          COMPOSER_BIN_DIR: join(cwd, 'vendor', 'bin'),
          COMPOSER_AUTH: credentials,
          COMPOSER_NO_INTERACTION: '1',
        });
        ensureRunning();
        return { cwd, env, shell: false as const, signal: controller.signal };
      })());
    const oldCopy = await prepare(original, lock, oldAuth);
    const newCopy = await prepare(rewritten, lock, newAuth);
    const execute = async (
      copy: typeof oldCopy,
      args: readonly string[],
    ): Promise<ComposerResult> => {
      ensureRunning();
      let execution: ComposerResult;
      try {
        const pending = composer(args, copy);
        if (!options.composer) activeChild = pending;
        execution = await pending;
      } catch (error) {
        execution = {
          exitCode: object(error) && typeof error.code === 'number' ? error.code : null,
          stdout: '',
          stderr: '',
          ...(object(error) && typeof error.code === 'string' ? { errorCode: error.code } : {}),
        };
      } finally {
        activeChild = undefined;
      }
      if (execution.exitCode !== 0) {
        const errorCode = [
          'ENOENT',
          'EACCES',
          'ETIMEDOUT',
          'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          'ABORT_ERR',
        ].includes(execution.errorCode ?? '')
          ? execution.errorCode
          : undefined;
        const signal = [
          'SIGINT',
          'SIGTERM',
          'SIGKILL',
          'SIGABRT',
          'SIGSEGV',
          'SIGHUP',
          'SIGQUIT',
        ].includes(execution.signal ?? '')
          ? execution.signal
          : undefined;
        result = {
          ...result,
          diagnostics: [
            ...result.diagnostics,
            {
              step: args[0] === '--version' ? 'version' : (args[0] as 'update' | 'install'),
              exitCode: Number.isInteger(execution.exitCode) ? execution.exitCode : null,
              ...(errorCode ? { errorCode } : {}),
              ...(signal ? { signal } : {}),
            },
          ],
        };
      }
      ensureRunning();
      return execution;
    };
    const version = await execute(oldCopy, ['--version']);
    if (version.exitCode !== 0 || !/^Composer(?: version)? 2\./m.test(version.stdout))
      throw new CutoverError('composer_v2_required');
    const update = ['update', '--lock', '--no-scripts', '--no-plugins'];
    const install = ['install', '--no-scripts', '--no-plugins', '--no-autoloader'];
    if ((await execute(oldCopy, update)).exitCode !== 0) throw new CutoverError('update_failed');
    if ((await execute(oldCopy, install)).exitCode !== 0) throw new CutoverError('install_failed');
    if ((await execute(newCopy, update)).exitCode !== 0) throw new CutoverError('update_failed');
    const oldPackages = packages(await readFile(join(oldCopy.cwd, 'composer.lock'), 'utf8'));
    const newPackages = packages(await readFile(join(newCopy.cwd, 'composer.lock'), 'utf8'));
    const oldSet = new Set(oldPackages.map((pkg) => pkg.tuple));
    const newSet = new Set(newPackages.map((pkg) => pkg.tuple));
    const differences = names([
      ...oldPackages.filter((pkg) => !newSet.has(pkg.tuple)),
      ...newPackages.filter((pkg) => !oldSet.has(pkg.tuple)),
    ]);
    const newSources = new Map(
      newPackages
        .filter((pkg) => pkg.sourceReference !== null)
        .map((pkg) => [pkg.tuple, pkg.distReference]),
    );
    const distOnly = names(
      oldPackages.filter(
        (pkg) =>
          pkg.sourceReference !== null &&
          newSources.has(pkg.tuple) &&
          newSources.get(pkg.tuple) !== pkg.distReference,
      ),
    );
    const oldHosts = oldHostPackages(newPackages, oldRepository, sameHost);
    result = {
      ...result,
      counts: { old: oldSet.size, new: newSet.size },
      differences,
      distOnly,
      oldHostPackages: oldHosts,
    };
    const installed = await execute(newCopy, install);
    if (installed.exitCode !== 0) {
      if (oldHosts.length > 0) throw new CutoverError('old_dist_host');
      if (differences.length > 0) throw new CutoverError('resolution_difference');
      throw new CutoverError('install_failed');
    }
    const checks: CutoverResult['historic'][number][] = [];
    for (const [index, bytes] of historic.entries()) {
      const copy = await prepare(rewritten, bytes, newAuth);
      let execution = await execute(copy, update);
      const oldHosts =
        execution.exitCode === 0
          ? oldHostPackages(
              packages(await readFile(join(copy.cwd, 'composer.lock'), 'utf8')),
              oldRepository,
              sameHost,
            )
          : [];
      if (execution.exitCode === 0) execution = await execute(copy, install);
      checks.push({
        index: index + 1,
        ok: execution.exitCode === 0 && oldHosts.length === 0,
        missingPackages:
          execution.exitCode === 0
            ? []
            : missingPackages(execution, packages(bytes.toString('utf8'))),
      });
      result = {
        ...result,
        oldHostPackages: [...new Set([...result.oldHostPackages, ...oldHosts])].sort(),
        historic: [...checks],
      };
    }
    if (result.oldHostPackages.length > 0) outcome('old_dist_host', 1);
    else if (differences.length > 0) outcome('resolution_difference', 1);
    else if (checks.some((check) => !check.ok)) outcome('historic_failed', 1);
    else outcome('passed', 0);
  } catch (error) {
    const code = error instanceof CutoverError ? error.code : 'local_failed';
    outcome(
      code,
      ['update_failed', 'install_failed', 'old_dist_host', 'resolution_difference'].includes(code)
        ? 1
        : 2,
    );
  } finally {
    await signalCleanup;
    await removeDirectories();
    removeHandlers();
    if (interrupted) outcome('local_failed', 2);
  }
  return result;
}
