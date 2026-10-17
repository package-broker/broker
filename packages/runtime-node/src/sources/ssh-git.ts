import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SshKeyMaterial } from '@package-broker/core/sources/credentials';
import type { DnsGuard, ResolvedAddress } from './dns-guard.js';

export type SshGitReason =
  | 'invalid_host'
  | 'invalid_user'
  | 'invalid_port'
  | 'invalid_path'
  | 'invalid_ref'
  | 'unsafe_temp_path'
  | 'no_address'
  | 'connect_failed'
  | 'host_key_mismatch'
  | 'auth_failed'
  | 'not_found'
  | 'timeout'
  | 'output_too_large'
  | 'repository_too_large'
  | 'git_failed'
  | 'closed';

export class SshGitError extends Error {
  override readonly name = 'SshGitError';
  constructor(readonly reason: SshGitReason) {
    super(`ssh git failed: ${reason}`);
  }
}

export interface SshRemote {
  readonly host: string;
  readonly port?: number;
  readonly user?: string;
  readonly path: string;
}

export type SpawnGit = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface SshGitOptions {
  readonly dnsGuard: DnsGuard;
  readonly credential: Pick<SshKeyMaterial, 'privateKeyPem' | 'knownHosts'>;
  readonly tmpRoot?: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxRepoBytes?: number;
  readonly spawn?: SpawnGit;
}

export interface RemoteRef {
  readonly name: string;
  readonly sha: string;
  readonly peeled?: string;
}

export interface FetchOptions {
  readonly filter: 'blob:none' | 'none';
  readonly depth: 1;
}

export interface SshGitSession {
  lsRemote(): Promise<RemoteRef[]>;
  fetchRefs(refs: readonly string[], options: FetchOptions): Promise<void>;
  catFile(ref: string, path: string): Promise<Buffer>;
  archiveZip(ref: string): Promise<Buffer>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024;
const DEFAULT_MAX_REPO = 256 * 1024 * 1024;
const SIZE_POLL_MS = 200;
const GROUP_EXIT_WAIT_MS = 5_000;
const MAX_STDERR = 16 * 1024;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const REPO_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_TEMP = /^[A-Za-z0-9/._-]+$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF_NAME = /^refs\/(?:heads|tags)\/[A-Za-z0-9._/+-]+$/;

const STDERR_REASONS: readonly [RegExp, SshGitReason][] = [
  [
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* not known/i,
    'host_key_mismatch',
  ],
  [/Permission denied \(|Authentication failed|Too many authentication failures/i, 'auth_failed'],
  [
    /Connection refused|Connection timed out|No route to host|Network is unreachable|Connection reset|Connection closed by remote host/i,
    'connect_failed',
  ],
  [
    /does not exist|not a valid object name|invalid object name|not our ref|repository not found|does not appear to be a git repository|couldn't find remote ref/i,
    'not_found',
  ],
];

const RECOVERABLE = new Set<SshGitReason>(['not_found']);

interface SshTarget {
  readonly host: string;
  readonly urlHost: string;
  readonly port: number;
}

function hasControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function parseHost(raw: string): { host: string; urlHost: string } {
  const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (isIP(bare) === 6 && !bare.includes('%')) {
    const canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
    return { host: canonical, urlHost: `[${canonical}]` };
  }
  if (bare !== raw || !HOSTNAME.test(raw)) throw new SshGitError('invalid_host');
  const host = raw.toLowerCase();
  return { host, urlHost: host };
}

function assertRemote(remote: SshRemote): SshTarget {
  const { host, urlHost } = parseHost(remote.host);
  if (remote.user !== undefined && !USER.test(remote.user)) throw new SshGitError('invalid_user');
  const port = remote.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SshGitError('invalid_port');
  if (!REPO_PATH.test(remote.path) || remote.path.startsWith('-') || remote.path.startsWith('~')) {
    throw new SshGitError('invalid_path');
  }
  return { host, urlHost, port };
}

function assertPath(path: string): void {
  if (path === '' || path.startsWith('-') || hasControl(path)) {
    throw new SshGitError('invalid_path');
  }
}

function assertRef(ref: string): void {
  if (OBJECT_ID.test(ref)) return;
  if (!REF_NAME.test(ref) || ref.includes('..') || ref.endsWith('.lock') || ref.endsWith('/')) {
    throw new SshGitError('invalid_ref');
  }
}

function refspec(ref: string): string {
  return OBJECT_ID.test(ref) ? ref : `${ref}:${ref}`;
}

function classify(stderr: string): SshGitReason {
  return STDERR_REASONS.find(([pattern]) => pattern.test(stderr))?.[1] ?? 'git_failed';
}

function orderAddresses(addresses: readonly ResolvedAddress[]): string[] {
  return [
    ...addresses.filter((entry) => entry.family === 4),
    ...addresses.filter((entry) => entry.family === 6),
  ].map((entry) => entry.address);
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile())
      total += await lstat(full).then(
        (info) => info.size,
        () => 0,
      );
  }
  return total;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killGroup(child: ChildProcess, exited: Promise<void>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await exited;
  const deadline = Date.now() + GROUP_EXIT_WAIT_MS;
  while (groupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function withSshGitSession<T>(
  remote: SshRemote,
  options: SshGitOptions,
  work: (session: SshGitSession) => Promise<T>,
): Promise<T> {
  const session = await openSshGitSession(remote, options);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

export async function openSshGitSession(
  remote: SshRemote,
  options: SshGitOptions,
): Promise<SshGitSession> {
  const target = assertRemote(remote);
  const spawn: SpawnGit = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdout = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const maxRepo = options.maxRepoBytes ?? DEFAULT_MAX_REPO;

  const resolution = await options.dnsGuard.forTarget(target.host, target.port).resolve();
  const addresses = orderAddresses(resolution.addresses);
  if (addresses.length === 0) throw new SshGitError('no_address');

  const root = await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'ssh-git-'));
  const home = join(root, 'home');
  const keyFile = join(root, 'id_key');
  const knownHostsFile = join(root, 'known_hosts');
  const gitConfig = join(home, '.gitconfig');
  const repo = join(root, 'repo.git');
  const gitDir = `--git-dir=${repo}`;
  const live = new Set<(reason: SshGitReason) => Promise<void>>();
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closing ??= (async () => {
      await Promise.all([...live].map((abort) => abort('closed')));
      await rm(root, { recursive: true, force: true });
    })();
    return closing;
  };

  try {
    if (!SAFE_TEMP.test(root)) throw new SshGitError('unsafe_temp_path');
    await chmod(root, 0o700);
    await mkdir(home, { mode: 0o700 });
    const key = options.credential.privateKeyPem;
    await writeFile(keyFile, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(knownHostsFile, options.credential.knownHosts, { mode: 0o600, flag: 'wx' });
    await writeFile(gitConfig, '', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await close();
    throw error;
  }

  const envFor = (address: string): Record<string, string> => ({
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: root,
    GIT_ALLOW_PROTOCOL: 'ssh',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: [
      'ssh -F /dev/null',
      `-i '${keyFile}'`,
      '-o IdentitiesOnly=yes',
      '-o IdentityAgent=none',
      `-o UserKnownHostsFile='${knownHostsFile}'`,
      '-o StrictHostKeyChecking=yes',
      `-o HostKeyAlias=${target.host}`,
      `-o HostName=${address}`,
      '-o BatchMode=yes',
      '-o ProxyCommand=none',
      '-o PermitLocalCommand=no',
      '-o ForwardAgent=no',
      '-o ClearAllForwardings=yes',
      '-o ControlPath=none',
      '-o ConnectTimeout=15',
    ].join(' '),
  });

  const userPart = remote.user === undefined ? '' : `${remote.user}@`;
  const url = `ssh://${userPart}${target.urlHost}:${target.port}/${remote.path.replace(/^\/+/, '')}`;
  let addressIndex = 0;
  let partial = false;
  let repoReady: Promise<void> | undefined;

  function run(args: readonly string[], watchSize = false): Promise<Buffer> {
    if (closing) return Promise.reject(new SshGitError('closed'));
    const address = addresses[addressIndex] ?? addresses[0] ?? '';
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn('git', args, {
        shell: false,
        detached: true,
        env: envFor(address),
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = new Promise<void>((done) => {
        child.once('exit', () => done());
        child.once('error', () => done());
      });
      const chunks: Buffer[] = [];
      let stderr = '';
      let size = 0;
      let settled = false;
      const stop = (): void => {
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        live.delete(abort);
      };
      const abort = async (reason: SshGitReason): Promise<void> => {
        if (settled) return;
        stop();
        await killGroup(child, exited);
        reject(new SshGitError(reason));
      };
      live.add(abort);
      const timer = setTimeout(() => void abort('timeout'), timeoutMs);
      const poll = setInterval(() => {
        if (!watchSize || settled) return;
        void directorySize(repo).then((bytes) => {
          if (bytes > maxRepo) void abort('repository_too_large');
        });
      }, SIZE_POLL_MS);
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxStdout) void abort('output_too_large');
        else chunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
      });
      child.on('error', () => void abort('git_failed'));
      child.on('close', (code) => {
        if (settled) return;
        stop();
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new SshGitError(classify(stderr)));
      });
    });
  }

  async function overAddresses<T>(work: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await work();
      } catch (error) {
        const retry =
          error instanceof SshGitError &&
          error.reason === 'connect_failed' &&
          addressIndex < addresses.length - 1;
        if (!retry) throw error;
        addressIndex += 1;
      }
    }
  }

  function ensureRepo(): Promise<void> {
    repoReady ??= (async () => {
      await run(['init', '--bare', '--quiet', repo]);
      await run([gitDir, 'remote', 'add', 'origin', url]);
    })();
    return repoReady;
  }

  async function assertRepoSize(): Promise<void> {
    if ((await directorySize(repo)) > maxRepo) throw new SshGitError('repository_too_large');
  }

  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof SshGitError && RECOVERABLE.has(error.reason))) await close();
      throw error;
    }
  }

  return {
    lsRemote() {
      return guarded(async () => {
        const out = await overAddresses(() =>
          run(['-c', 'protocol.version=2', 'ls-remote', '--heads', '--tags', url]),
        );
        const refs = new Map<string, { sha: string; peeled?: string }>();
        for (const line of out.toString('utf8').split('\n')) {
          const [sha, name] = line.split('\t');
          if (!sha || !name || !OBJECT_ID.test(sha)) continue;
          if (name.endsWith('^{}')) {
            const base = refs.get(name.slice(0, -3));
            if (base) base.peeled = sha;
          } else {
            refs.set(name, { sha });
          }
        }
        return [...refs].map(([name, ref]) => ({ name, ...ref }));
      });
    },

    async fetchRefs(refs, fetchOptions) {
      refs.forEach(assertRef);
      return guarded(async () => {
        if (refs.length === 0) return;
        await ensureRepo();
        if (fetchOptions.filter !== 'none') partial = true;
        await overAddresses(() =>
          run(
            [
              gitDir,
              '-c',
              'protocol.version=2',
              '-c',
              'gc.auto=0',
              '-c',
              'fetch.fsckObjects=true',
              '-c',
              'transfer.fsckObjects=true',
              'fetch',
              '--quiet',
              '--no-tags',
              '--no-write-fetch-head',
              `--depth=${fetchOptions.depth}`,
              ...(fetchOptions.filter === 'none' ? [] : [`--filter=${fetchOptions.filter}`]),
              'origin',
              ...refs.map(refspec),
            ],
            true,
          ),
        );
        await assertRepoSize();
      });
    },

    async catFile(ref, path) {
      assertRef(ref);
      assertPath(path);
      return guarded(async () => {
        await ensureRepo();
        const out = await run([gitDir, 'cat-file', 'blob', `${ref}:${path}`], partial);
        if (partial) await assertRepoSize();
        return out;
      });
    },

    async archiveZip(ref) {
      assertRef(ref);
      return guarded(async () => {
        await ensureRepo();
        const out = await run([gitDir, 'archive', '--format=zip', ref], partial);
        if (partial) await assertRepoSize();
        return out;
      });
    },

    close,
  };
}
