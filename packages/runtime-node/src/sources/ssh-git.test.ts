import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { createDnsGuard, type ResolvedAddress } from './dns-guard.js';
import {
  openSshGitSession,
  SshGitError,
  withSshGitSession,
  type SpawnGit,
  type SshGitOptions,
  type SshRemote,
} from './ssh-git.js';

const SHA = 'a'.repeat(40);
const VETTED = '93.184.216.34';
const STUB = `#!/bin/sh
dir=$(dirname "$0")
{ echo "--call"; for a in "$@"; do echo "arg:$a"; done; env | sed 's/^/env:/'; } >> "$dir/calls.log"
mode=$(cat "$dir/mode" 2>/dev/null)
objects="$PWD/repo.git/objects"
for a in "$@"; do
  case "$a" in
    ls-remote)
      if [ "$mode" = refuse ] && echo "$GIT_SSH_COMMAND" | grep -q "HostName=${VETTED} "; then
        echo "ssh: connect to host git.example.com port 22: Connection refused" >&2; exit 128
      fi
      printf '%s\\trefs/heads/main\\n%s\\trefs/tags/v1.0.0\\n%s\\trefs/tags/v1.0.0^{}\\n' ${SHA} ${'b'.repeat(40)} ${'c'.repeat(40)}; exit 0 ;;
    fetch)
      case "$mode" in
        fail) exit 128 ;;
        big) head -c 4096 /dev/zero > "$objects/blob.pack" ;;
        grow) head -c 4096 /dev/zero > "$objects/blob.pack"; exec sleep 5 ;;
        hang) exec sleep 5 ;;
        grandchild) sleep 30 & echo $! > "$dir/grandchild.pid"; wait ;;
        hostkey) echo "Host key verification failed." >&2; exit 128 ;;
        auth) echo "git@git.example.com: Permission denied (publickey)." >&2; exit 128 ;;
        leak)
          key=$(echo "$GIT_SSH_COMMAND" | sed -n "s/.*-i '\\([^']*\\)'.*/\\1/p")
          echo "Load key \\"$key\\": invalid format" >&2; exit 128 ;;
      esac
      exit 0 ;;
    cat-file)
      case "$mode" in
        missing) echo "fatal: path 'composer.json' does not exist in '${SHA}'" >&2; exit 128 ;;
        lazybig) head -c 4096 /dev/zero > "$objects/lazy.pack" ;;
      esac
      printf '{"name":"acme/lib"}'; exit 0 ;;
    archive)
      if [ "$mode" = flood ]; then head -c 4096 /dev/zero; else printf 'PK-zip'; fi
      exit 0 ;;
    init) sleep 0.1; mkdir -p "$objects"; exit 0 ;;
  esac
done
exit 0
`;

const remote: SshRemote = { host: 'git.example.com', user: 'git', path: 'acme/lib.git' };
const credential = {
  privateKeyPem: 'FAKE-TEST-KEY',
  knownHosts: 'git.example.com ssh-ed25519 AAAA',
};

const guardFor = (addresses: ResolvedAddress[], resolver = async () => addresses) =>
  createDnsGuard(
    createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] }),
    { resolver },
  );

let stubDir: string;
let tmpRoot: string;

const options = (extra: Partial<SshGitOptions> = {}): SshGitOptions => ({
  dnsGuard: guardFor([{ address: VETTED, family: 4 }]),
  credential,
  tmpRoot,
  ...extra,
});

const spySpawn = () => vi.fn<SpawnGit>((command, args, opts) => spawn(command, args, opts));

interface Call {
  readonly args: string[];
  readonly env: Record<string, string>;
}

async function calls(): Promise<Call[]> {
  const text = await readFile(join(stubDir, 'calls.log'), 'utf8').catch(() => '');
  return text
    .split('--call\n')
    .filter((chunk) => chunk !== '')
    .map((chunk) => {
      const lines = chunk.split('\n');
      const args = lines.filter((l) => l.startsWith('arg:')).map((l) => l.slice(4));
      const env = Object.fromEntries(
        lines
          .filter((l) => l.startsWith('env:'))
          .map((l) => {
            const body = l.slice(4);
            const eq = body.indexOf('=');
            return [body.slice(0, eq), body.slice(eq + 1)];
          }),
      );
      return { args, env };
    });
}

const setMode = (mode: string) => writeFile(join(stubDir, 'mode'), mode);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i += 1) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

beforeEach(async () => {
  stubDir = await mkdtemp(join(tmpdir(), 'ssh-git-stub-'));
  tmpRoot = await mkdtemp(join(tmpdir(), 'ssh-git-root-'));
  await writeFile(join(stubDir, 'git'), STUB);
  await chmod(join(stubDir, 'git'), 0o755);
  vi.stubEnv('PATH', `${stubDir}:/usr/bin:/bin`);
  vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock');
  vi.stubEnv('GIT_DIR', '/etc');
  vi.stubEnv('GIT_SSH_COMMAND', 'ssh -o ProxyCommand=evil');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(stubDir, { recursive: true, force: true });
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('argument refusal', () => {
  it.each([
    ['-oProxyCommand=x'],
    ['--upload-pack=x'],
    ['git.example.com\nx'],
    ['git.example.com\0'],
    ["git.example.com'"],
    ['[::1'],
    ['fe80::1%en0'],
    ['[fe80::1%en0]'],
    [''],
  ])('refuses host %j without spawning or resolving', async (host) => {
    const spawnSpy = spySpawn();
    const resolver = vi.fn(async () => [{ address: VETTED, family: 4 as const }]);
    await expect(
      openSshGitSession(
        { ...remote, host },
        options({ spawn: spawnSpy, dnsGuard: guardFor([], resolver) }),
      ),
    ).rejects.toMatchObject({ reason: 'invalid_host' });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it.each([
    [{ user: '-oProxyCommand=x' }, 'invalid_user'],
    [{ path: '-x' }, 'invalid_path'],
    [{ path: 'a\nb' }, 'invalid_path'],
    [{ path: '~/repo.git' }, 'invalid_path'],
    [{ path: 'acme/lib.git;rm' }, 'invalid_path'],
    [{ path: 'acme/$(id).git' }, 'invalid_path'],
    [{ path: 'acme lib.git' }, 'invalid_path'],
    [{ port: 0 }, 'invalid_port'],
  ] as const)('refuses remote %j', async (patch, reason) => {
    const spawnSpy = spySpawn();
    await expect(
      openSshGitSession({ ...remote, ...patch }, options({ spawn: spawnSpy })),
    ).rejects.toMatchObject({ reason });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['--upload-pack=x'],
    ['-n'],
    ['main\nx'],
    ['ma\0in'],
    ['refs/heads/a..b'],
    ['refs/heads/topic.lock'],
    ['refs/heads/'],
    [''],
  ])('refuses ref %j in every operation without spawning', async (ref) => {
    const spawnSpy = spySpawn();
    await withSshGitSession(remote, options({ spawn: spawnSpy }), async (session) => {
      await expect(
        session.fetchRefs([ref], { filter: 'blob:none', depth: 1 }),
      ).rejects.toMatchObject({ reason: 'invalid_ref' });
      await expect(session.catFile(ref, 'composer.json')).rejects.toMatchObject({
        reason: 'invalid_ref',
      });
      await expect(session.archiveZip(ref)).rejects.toMatchObject({ reason: 'invalid_ref' });
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it.each([['-x'], ['a\nb'], ['a\0b'], ['']])('refuses path %j', async (path) => {
    const spawnSpy = spySpawn();
    await withSshGitSession(remote, options({ spawn: spawnSpy }), async (session) => {
      await expect(session.catFile(SHA, path)).rejects.toMatchObject({ reason: 'invalid_path' });
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('propagates a DNS guard refusal for a host resolving to a private address', async () => {
    await expect(
      openSshGitSession(
        remote,
        options({ dnsGuard: guardFor([{ address: '10.0.0.1', family: 4 }]) }),
      ),
    ).rejects.toMatchObject({ name: 'DnsGuardError' });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('refuses an unsafe tmpRoot and removes what it created', async () => {
    const unsafe = join(tmpRoot, 'with space');
    await mkdir(unsafe);
    const spawnSpy = spySpawn();
    await expect(
      openSshGitSession(remote, options({ tmpRoot: unsafe, spawn: spawnSpy })),
    ).rejects.toMatchObject({ reason: 'unsafe_temp_path' });
    expect(await readdir(unsafe)).toEqual([]);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('process environment', () => {
  it('spawns git with a scratch environment and the vetted HostName', async () => {
    const spawnSpy = spySpawn();
    let root: string | undefined;
    const refs = await withSshGitSession(
      { ...remote, host: 'Git.Example.COM', port: 2222 },
      options({ spawn: spawnSpy }),
      async (session) => {
        root = (await readdir(tmpRoot))[0];
        return session.lsRemote();
      },
    );
    expect(refs).toEqual([
      { name: 'refs/heads/main', sha: SHA },
      { name: 'refs/tags/v1.0.0', sha: 'b'.repeat(40), peeled: 'c'.repeat(40) },
    ]);
    expect(root).toBeDefined();
    const scratch = join(tmpRoot, root ?? '');

    for (const call of spawnSpy.mock.calls) {
      expect(call[0]).toBe('git');
      expect(call[2]).toMatchObject({ shell: false, detached: true, cwd: scratch });
    }
    const [call] = await calls();
    expect(call?.args).toContain('ssh://git@git.example.com:2222/acme/lib.git');
    const env = call?.env ?? {};
    const ignoredByShell = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);
    expect(
      Object.keys(env)
        .filter((k) => !ignoredByShell.has(k))
        .sort(),
    ).toEqual([
      'GIT_ALLOW_PROTOCOL',
      'GIT_CEILING_DIRECTORIES',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_SSH_COMMAND',
      'GIT_TERMINAL_PROMPT',
      'HOME',
      'PATH',
    ]);
    expect(env['PATH']).toBe(`${stubDir}:/usr/bin:/bin`);
    expect(env['GIT_CEILING_DIRECTORIES']).toBe(scratch);
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(env['GIT_ALLOW_PROTOCOL']).toBe('ssh');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['HOME']).toBe(join(scratch, 'home'));
    expect(env['GIT_CONFIG_GLOBAL']).toBe(join(scratch, 'home', '.gitconfig'));
    const ssh = env['GIT_SSH_COMMAND'] ?? '';
    expect(ssh).toMatch(/^ssh -F \/dev\/null -i '/);
    for (const option of [
      `HostName=${VETTED}`,
      'HostKeyAlias=git.example.com',
      'StrictHostKeyChecking=yes',
      'IdentitiesOnly=yes',
      'IdentityAgent=none',
      'BatchMode=yes',
      'ProxyCommand=none',
      'PermitLocalCommand=no',
      'ForwardAgent=no',
      'ClearAllForwardings=yes',
      'ControlPath=none',
      'ConnectTimeout=15',
    ]) {
      expect(ssh).toContain(`-o ${option}`);
    }
    expect(ssh).toContain(`-i '${join(scratch, 'id_key')}'`);
    expect(ssh).toContain(`-o UserKnownHostsFile='${join(scratch, 'known_hosts')}'`);
    expect(ssh).not.toContain('FAKE-TEST-KEY');
  });

  it('passes --git-dir to every repository operation', async () => {
    await withSshGitSession(remote, options(), async (session) => {
      await session.fetchRefs([SHA], { filter: 'none', depth: 1 });
      await session.catFile(SHA, 'composer.json');
      await session.archiveZip(SHA);
    });
    const repoCalls = (await calls()).filter(
      (c) => !c.args.includes('ls-remote') && !c.args.includes('init'),
    );
    expect(repoCalls.length).toBe(4);
    for (const c of repoCalls) expect(c.args[0]).toMatch(/^--git-dir=.*\/repo\.git$/);
  });

  it('writes the scratch files with explicit modes', async () => {
    await withSshGitSession(remote, options(), async () => {
      const root = join(tmpRoot, (await readdir(tmpRoot))[0] ?? '');
      const mode = async (path: string) => (await stat(path)).mode & 0o777;
      expect(await mode(root)).toBe(0o700);
      expect(await mode(join(root, 'home'))).toBe(0o700);
      expect(await mode(join(root, 'id_key'))).toBe(0o600);
      expect(await mode(join(root, 'known_hosts'))).toBe(0o600);
      expect(await mode(join(root, 'home', '.gitconfig'))).toBe(0o600);
    });
  });

  it.each([['2606:2800:220:1::1'], ['[2606:2800:220:1::1]']])(
    'accepts the IPv6 literal host %s',
    async (host) => {
      const literal = '2606:2800:220:1::1';
      await withSshGitSession(
        { ...remote, host },
        options({ dnsGuard: guardFor([{ address: literal, family: 6 }]) }),
        (session) => session.lsRemote(),
      );
      const [call] = await calls();
      expect(call?.args).toContain(`ssh://git@[${literal}]:22/acme/lib.git`);
      const ssh = call?.env['GIT_SSH_COMMAND'] ?? '';
      expect(ssh).toContain(`-o HostName=${literal}`);
      expect(ssh).toContain(`-o HostKeyAlias=${literal}`);
    },
  );

  it('tries vetted addresses in order with IPv4 first', async () => {
    await setMode('refuse');
    const dnsGuard = guardFor([
      { address: '2606:2800:220:1::1', family: 6 },
      { address: VETTED, family: 4 },
      { address: '93.184.216.35', family: 4 },
    ]);
    const refs = await withSshGitSession(remote, options({ dnsGuard }), (session) =>
      session.lsRemote(),
    );
    expect(refs).toHaveLength(2);
    const tried = (await calls()).map(
      (c) => /HostName=(\S+)/.exec(c.env['GIT_SSH_COMMAND'] ?? '')?.[1],
    );
    expect(tried).toEqual([VETTED, '93.184.216.35']);
  });
});

describe('operations and cleanup', () => {
  it('fetches, reads a file and builds an archive, then removes the temp dir', async () => {
    await withSshGitSession(remote, options(), async (session) => {
      await session.fetchRefs([SHA], { filter: 'blob:none', depth: 1 });
      expect((await session.catFile(SHA, 'composer.json')).toString()).toBe('{"name":"acme/lib"}');
      expect((await session.archiveZip(SHA)).toString()).toBe('PK-zip');
    });
    const fetch = (await calls()).find((c) => c.args.includes('fetch'));
    expect(fetch?.args).toEqual(
      expect.arrayContaining([
        'fetch.fsckObjects=true',
        'transfer.fsckObjects=true',
        '--depth=1',
        '--filter=blob:none',
        SHA,
      ]),
    );
    const archive = (await calls()).find((c) => c.args.includes('archive'));
    expect(archive?.args).toEqual(expect.arrayContaining(['--format=zip', SHA]));
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('fetches ref names with explicit refspecs so later reads resolve them', async () => {
    await withSshGitSession(remote, options(), async (session) => {
      await session.fetchRefs(['refs/heads/main', 'refs/tags/v1.0.0', SHA], {
        filter: 'blob:none',
        depth: 1,
      });
      expect((await session.catFile('refs/heads/main', 'composer.json')).toString()).toContain(
        'acme',
      );
    });
    const log = await calls();
    const fetch = log.find((c) => c.args.includes('fetch'));
    expect(fetch?.args.slice(-3)).toEqual([
      'refs/heads/main:refs/heads/main',
      'refs/tags/v1.0.0:refs/tags/v1.0.0',
      SHA,
    ]);
    const cat = log.find((c) => c.args.includes('cat-file'));
    expect(cat?.args).toContain('refs/heads/main:composer.json');
  });

  it('omits the filter when none is requested', async () => {
    await withSshGitSession(remote, options(), (session) =>
      session.fetchRefs([SHA], { filter: 'none', depth: 1 }),
    );
    const fetch = (await calls()).find((c) => c.args.includes('fetch'));
    expect(fetch?.args.some((a) => a.startsWith('--filter'))).toBe(false);
  });

  it('shares one repository init between concurrent operations', async () => {
    await withSshGitSession(remote, options(), async (session) => {
      await Promise.all([
        session.catFile(SHA, 'composer.json'),
        session.catFile(SHA, 'package.json'),
        session.archiveZip(SHA),
      ]);
    });
    const log = await calls();
    expect(log.filter((c) => c.args.includes('init'))).toHaveLength(1);
    expect(log.filter((c) => c.args.includes('remote'))).toHaveLength(1);
  });

  it('keeps the session usable after a missing file', async () => {
    await setMode('missing');
    await withSshGitSession(remote, options(), async (session) => {
      await expect(session.catFile(SHA, 'composer.json')).rejects.toMatchObject({
        reason: 'not_found',
      });
      expect(await readdir(tmpRoot)).toHaveLength(1);
      await setMode('');
      expect((await session.catFile(SHA, 'composer.json')).toString()).toContain('acme');
    });
  });

  it.each([
    ['fail', 'git_failed'],
    ['hostkey', 'host_key_mismatch'],
    ['auth', 'auth_failed'],
  ])('removes the temp dir without close() after a %s fetch', async (mode, reason) => {
    await setMode(mode);
    const session = await openSshGitSession(remote, options());
    await expect(session.fetchRefs([SHA], { filter: 'blob:none', depth: 1 })).rejects.toMatchObject(
      { reason },
    );
    expect(await readdir(tmpRoot)).toEqual([]);
    await expect(session.lsRemote()).rejects.toMatchObject({ reason: 'closed' });
  });

  it('aborts and cleans up when the repository exceeds the size cap after a fetch', async () => {
    await setMode('big');
    const session = await openSshGitSession(remote, options({ maxRepoBytes: 1024 }));
    await expect(session.fetchRefs([SHA], { filter: 'blob:none', depth: 1 })).rejects.toMatchObject(
      { reason: 'repository_too_large' },
    );
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('aborts a fetch while it grows past the size cap', async () => {
    await setMode('grow');
    const session = await openSshGitSession(
      remote,
      options({ maxRepoBytes: 1024, timeoutMs: 4000 }),
    );
    const started = Date.now();
    await expect(session.fetchRefs([SHA], { filter: 'none', depth: 1 })).rejects.toMatchObject({
      reason: 'repository_too_large',
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('checks the size after a lazy blob fetch in catFile', async () => {
    const session = await openSshGitSession(remote, options({ maxRepoBytes: 1024 }));
    await session.fetchRefs([SHA], { filter: 'blob:none', depth: 1 });
    await setMode('lazybig');
    await expect(session.catFile(SHA, 'composer.json')).rejects.toMatchObject({
      reason: 'repository_too_large',
    });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('kills a process that exceeds the stdout cap', async () => {
    await setMode('flood');
    const session = await openSshGitSession(remote, options({ maxStdoutBytes: 1024 }));
    await expect(session.archiveZip(SHA)).rejects.toMatchObject({
      reason: 'output_too_large',
    });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('kills the whole process group on timeout', async () => {
    await setMode('grandchild');
    const session = await openSshGitSession(remote, options({ timeoutMs: 1500 }));
    await expect(session.fetchRefs([SHA], { filter: 'none', depth: 1 })).rejects.toMatchObject({
      reason: 'timeout',
    });
    const pid = Number((await readFile(join(stubDir, 'grandchild.pid'), 'utf8')).trim());
    expect(pid).toBeGreaterThan(0);
    expect(await waitGone(pid)).toBe(true);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('close() during an in-flight process kills it and removes the dir', async () => {
    await setMode('grandchild');
    const session = await openSshGitSession(remote, options());
    const pending = session.fetchRefs([SHA], { filter: 'none', depth: 1 });
    pending.catch(() => undefined);
    const pidFile = join(stubDir, 'grandchild.pid');
    for (let i = 0; i < 40 && !(await readFile(pidFile, 'utf8').catch(() => '')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await session.close();
    await expect(pending).rejects.toMatchObject({ reason: 'closed' });
    expect(await waitGone(pid)).toBe(true);
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('withSshGitSession removes the dir when the callback throws', async () => {
    await expect(
      withSshGitSession(remote, options(), async () => {
        expect(await readdir(tmpRoot)).toHaveLength(1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('errors are neutral and never echo stderr or the key path', async () => {
    await setMode('leak');
    const session = await openSshGitSession(remote, options());
    const error = await session
      .fetchRefs([SHA], { filter: 'none', depth: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SshGitError);
    expect((error as SshGitError).message).toBe('ssh git failed: git_failed');
    const text = `${JSON.stringify(error)} ${String(error)} ${(error as Error).stack ?? ''}`;
    expect(text).not.toContain('id_key');
    expect(text).not.toContain('Load key');
    expect(text).not.toContain(tmpRoot);
  });
});

describe('quiet scratch repositories', () => {
  it('disables maintenance and GC in every invocation and persists scratch config', async () => {
    const spawnSpy = spySpawn();
    await withSshGitSession(remote, options({ spawn: spawnSpy }), async (session) => {
      await session.lsRemote();
      await session.fetchRefs([SHA], { filter: 'blob:none', depth: 1 });
      await session.catFile(SHA, 'composer.json');
      await session.archiveZip(SHA);
      const scratch = join(tmpRoot, (await readdir(tmpRoot))[0] ?? '');
      const config = await readFile(join(scratch, 'repo.git', 'config'), 'utf8');
      expect(config).toContain('[maintenance]');
      expect(config).toContain('auto = false');
      expect(config).toContain('auto = 0');
      expect(config).toContain('autoDetach = false');
    });
    for (const [, args] of spawnSpy.mock.calls) {
      for (const setting of ['maintenance.auto=false', 'gc.auto=0', 'gc.autoDetach=false']) {
        const index = args.indexOf(setting);
        expect(index).toBeGreaterThan(0);
        expect(args[index - 1]).toBe('-c');
      }
    }
  });
});
