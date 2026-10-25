import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ComposerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ComposerRunner = (
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly shell: false },
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
  readonly oldHostPackages: readonly string[];
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
    execFile('composer', [...args], options, (error, stdout, stderr) => {
      resolve({ exitCode: error ? 1 : 0, stdout, stderr });
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
  const json: unknown = JSON.parse(text);
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
        return ref;
      };
      if (pkg.dist !== undefined && pkg.dist !== null && !object(pkg.dist)) throw new Error();
      const distUrl = object(pkg.dist) ? pkg.dist.url : undefined;
      if (distUrl !== undefined && typeof distUrl !== 'string') throw new Error();
      result.push({
        name: pkg.name,
        tuple: JSON.stringify([pkg.name, pkg.version, reference(pkg.source), reference(pkg.dist)]),
        distUrl,
      });
    }
  }
  return result;
}

const names = (values: readonly LockedPackage[]) => [...new Set(values.map((p) => p.name))].sort();
function oldHostPackages(values: readonly LockedPackage[], host: string): string[] {
  return names(
    values.filter((pkg) => {
      if (pkg.distUrl === undefined) return false;
      return new URL(pkg.distUrl).hostname === host;
    }),
  );
}

function missingPackages(output: ComposerResult, locked: readonly LockedPackage[]): string[] {
  const lines = `${output.stdout}\n${output.stderr}`.split(/\r?\n/);
  return names(locked).filter((name) =>
    lines.some(
      (line) =>
        line.split(/[^a-z0-9_./-]+/i).includes(name) &&
        /could not be found|cannot be found|not (?:found|available)|\b(?:404|410)\b|no matching package|could not find a matching version/i.test(
          line,
        ),
    ),
  );
}

export async function runCutoverCheck(options: CutoverOptions): Promise<CutoverResult> {
  const directories: string[] = [];
  let result: CutoverResult = {
    exitCode: 2,
    code: 'local_failed',
    message: MESSAGES.local_failed,
    counts: { old: 0, new: 0 },
    differences: [],
    oldHostPackages: [],
    historic: [],
  };
  const outcome = (code: Code, exitCode: 0 | 1 | 2) => {
    result = { ...result, code, message: MESSAGES[code], exitCode };
  };
  try {
    let oldHost: string;
    let oldAuth: string;
    let newAuth: string;
    try {
      if (!options.projectDir || options.oldRepository === options.newRepository) throw new Error();
      oldHost = repositoryHost(options.oldRepository);
      repositoryHost(options.newRepository);
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
    const prepare = async (json: string, bytes: Buffer, credentials: string) => {
      const cwd = await mkdtemp(join(tmpdir(), 'pb-cutover-'));
      directories.push(cwd);
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
      return { cwd, env, shell: false as const };
    };
    const oldCopy = await prepare(original, lock, oldAuth);
    const newCopy = await prepare(rewritten, lock, newAuth);
    try {
      const version = await composer(['--version'], oldCopy);
      if (version.exitCode !== 0 || !/^Composer(?: version)? 2\./m.test(version.stdout))
        throw new Error();
    } catch {
      throw new CutoverError('composer_v2_required');
    }
    const execute = async (copy: typeof oldCopy, args: readonly string[]) => {
      try {
        return await composer(args, copy);
      } catch {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
    };
    const update = ['update', '--lock', '--no-scripts', '--no-plugins'];
    const install = ['install', '--no-scripts', '--no-plugins', '--no-autoloader'];
    for (const copy of [oldCopy, newCopy]) {
      if ((await execute(copy, update)).exitCode !== 0) throw new CutoverError('update_failed');
      if ((await execute(copy, install)).exitCode !== 0) throw new CutoverError('install_failed');
    }
    const oldPackages = packages(await readFile(join(oldCopy.cwd, 'composer.lock'), 'utf8'));
    const newPackages = packages(await readFile(join(newCopy.cwd, 'composer.lock'), 'utf8'));
    const oldSet = new Set(oldPackages.map((pkg) => pkg.tuple));
    const newSet = new Set(newPackages.map((pkg) => pkg.tuple));
    const differences = names([
      ...oldPackages.filter((pkg) => !newSet.has(pkg.tuple)),
      ...newPackages.filter((pkg) => !oldSet.has(pkg.tuple)),
    ]);
    const oldHosts = oldHostPackages(newPackages, oldHost);
    result = {
      ...result,
      counts: { old: oldSet.size, new: newSet.size },
      differences,
      oldHostPackages: oldHosts,
    };
    const checks: CutoverResult['historic'][number][] = [];
    for (const [index, bytes] of historic.entries()) {
      const copy = await prepare(rewritten, bytes, newAuth);
      let execution = await execute(copy, update);
      if (execution.exitCode === 0) execution = await execute(copy, install);
      const oldHosts = oldHostPackages(
        packages(await readFile(join(copy.cwd, 'composer.lock'), 'utf8')),
        oldHost,
      );
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
    outcome(code, code === 'update_failed' || code === 'install_failed' ? 1 : 2);
  } finally {
    for (const directory of directories) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        outcome('local_failed', 2);
      }
    }
  }
  return result;
}
