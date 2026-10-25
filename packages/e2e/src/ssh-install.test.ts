import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { session } from './evidence.js';
import { repository, reserveLoopbackPort, startLocal, until } from './local.js';
import type { LocalBroker } from './local.js';

const exec = promisify(execFile);
const sshd = process.env['PB_E2E_SSHD'] ?? '/usr/sbin/sshd';

async function missingPrerequisites(): Promise<string[]> {
  const missing: string[] = [];
  for (const [label, file, args] of [
    ['composer', 'composer', ['--version']],
    ['git', 'git', ['--version']],
    ['ssh', 'ssh', ['-V']],
    ['ssh-keygen', 'sh', ['-c', 'command -v ssh-keygen']],
    ['git-upload-pack', 'sh', ['-c', 'command -v git-upload-pack']],
  ] as const) {
    try {
      await exec(file, [...args], { timeout: 30_000 });
    } catch {
      missing.push(label);
    }
  }
  try {
    await access(sshd, constants.X_OK);
  } catch {
    missing.push(`sshd (${sshd}; set PB_E2E_SSHD)`);
  }
  return missing;
}

// The registry config refuses loopback literals as the broker's own host, so the fixture uses a
// .localhost name and pins it to 127.0.0.1 inside the broker process; the DNS guard still
// classifies and allowlists the pinned answer, and the leg does not depend on the host resolver.
const sshHost = 'ssh.localhost';
const pinSshHost = `
https.request = () => {
  throw new Error('UnexpectedUpstream');
};
const dns = (await import('node:dns/promises')).default;
const systemLookup = dns.lookup;
dns.lookup = async (host, options) => {
  if (host !== ${JSON.stringify(sshHost)}) return systemLookup(host, options);
  const answer = { address: '127.0.0.1', family: 4 };
  return options?.all ? [answer] : answer;
};
`;

const missing = await missingPrerequisites();
const title =
  'installs an SSH-built dist through the Node bundle, then installs with the SSH upstream stopped';

const leg = missing.length > 0 ? it.skip : it;
const name = missing.length > 0 ? `NOT RUN (Node): ${title}: missing ${missing.join(', ')}` : title;

leg(
  name,
  async () => {
    await mkdir(join(repository, '.pb'), { recursive: true });
    const root = await realpath(await mkdtemp(join(repository, '.pb/ssh-install-')));
    // The archive store refuses a root below a group- or world-writable directory without the
    // sticky bit, which a CI checkout can have; the system temp directory is a trusted parent.
    const archives = await realpath(await mkdtemp(join(tmpdir(), 'pb-ssh-archives-')));
    let broker: LocalBroker | undefined;
    let upstream: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown> | undefined;
    const stop = async () => {
      if (upstream && upstream.exitCode === null && upstream.signalCode === null) {
        upstream.kill('SIGTERM');
        await exited;
      }
    };
    try {
      const git = async (...args: string[]) =>
        exec('git', args, {
          cwd: root,
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        });
      await git('init', '-q', '-b', 'main', 'repo');
      await writeFile(
        join(root, 'repo/composer.json'),
        JSON.stringify({ name: 'acme/ssh', type: 'library' }),
      );
      await writeFile(join(root, 'repo/proof.txt'), 'archive built from SSH\n');
      await git('-C', 'repo', 'add', '.');
      await git(
        '-C',
        'repo',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      );
      await git('-C', 'repo', 'tag', 'v1.0.0');
      await writeFile(join(root, 'repo/proof.txt'), 'second archive built from SSH\n');
      await git(
        '-C',
        'repo',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qam',
        'second',
      );
      await git('-C', 'repo', 'tag', 'v1.1.0');
      await git('clone', '-q', '--bare', 'repo', 'repo.git');
      for (const name of ['client', 'host'])
        await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)]);
      const publicKey = (await readFile(join(root, 'client.pub'), 'utf8')).trim();
      await writeFile(join(root, 'authorized_keys'), `restrict ${publicKey}\n`, { mode: 0o600 });
      const port = await reserveLoopbackPort();
      await writeFile(
        join(root, 'sshd_config'),
        [
          `Port ${port}`,
          'ListenAddress 127.0.0.1',
          `HostKey ${join(root, 'host')}`,
          `PidFile ${join(root, 'sshd.pid')}`,
          `AuthorizedKeysFile ${join(root, 'authorized_keys')}`,
          'StrictModes no',
          'PasswordAuthentication no',
          'KbdInteractiveAuthentication no',
          'UsePAM no',
          'AllowAgentForwarding no',
          'AllowTcpForwarding no',
          'PermitTTY no',
          `AllowUsers ${userInfo().username}`,
        ].join('\n') + '\n',
      );
      upstream = spawn(sshd, ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: 'ignore' });
      exited = once(upstream, 'exit');
      exited.catch(() => undefined);
      const privateKeyPem = await readFile(join(root, 'client'), 'utf8');
      const hostKey = (await readFile(join(root, 'host.pub'), 'utf8'))
        .split(' ')
        .slice(0, 2)
        .join(' ');
      const knownHosts = `${sshHost} ${hostKey}\n`;
      await writeFile(join(root, 'known_hosts'), knownHosts);
      const sshArgs = [
        '-F',
        '/dev/null',
        '-i',
        join(root, 'client'),
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'IdentityAgent=none',
        '-o',
        `HostKeyAlias=${sshHost}`,
        '-o',
        'HostName=127.0.0.1',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${join(root, 'known_hosts')}`,
        '-o',
        'BatchMode=yes',
        '-p',
        String(port),
      ];
      const remote = `ssh://${userInfo().username}@${sshHost}:${port}${join(root, 'repo.git')}`;
      const sshCommand = sshArgs.map((arg) => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(' ');
      const listRemote = () =>
        exec('git', ['-c', `core.sshCommand=ssh ${sshCommand}`, 'ls-remote', remote], {
          timeout: 2000,
        });
      await until(
        async () => {
          assert(upstream!.exitCode === null && upstream!.signalCode === null, 'SshdExited');
          try {
            await listRemote();
            return true;
          } catch {
            return false;
          }
        },
        'ssh-upstream',
        10_000,
      );
      broker = await startLocal('node', `http://127.0.0.1:${port}`, {
        nodeTransport: pinSshHost,
        nodeEnv: { PB_SSH_ARCHIVE_ROOT: join(archives, 'store') },
        patchBundle(bundle) {
          // Enable SSH only in the fixture copy of the bundle.
          const hidden = /node: Object\.freeze\(\["github", "git"\]\)/g;
          if (hidden.test(bundle))
            bundle = bundle.replace(hidden, 'node: Object.freeze(["github", "git", "ssh"])');
          else
            assert(
              /node: Object\.freeze\(\["github", "git", "ssh"\]\)/.test(bundle),
              'SshProviderListMissing',
            );
          if (process.env['PB_E2E_REJECT_SSH_DIST'] === '1') {
            const reader = /async openDist\((\w+), (\w+), (\w+)\) \{\s+sshConfig\(\2\);/g;
            assert.equal([...bundle.matchAll(reader)].length, 1, 'SshReaderMutationTargetMissing');
            bundle = bundle.replace(
              reader,
              `$& throw new TypeError('ssh archives are built at sync time, not fetched');`,
            );
          }
          const config = 'return resolveRegistryConfig(input, "node", origin);';
          assert.equal(bundle.split(config).length, 2, 'FixtureRegistryConfigMissing');
          return bundle.replace(
            config,
            `return resolveRegistryConfig({ ...input, outbound: { ...input?.outbound, allowPrivateHosts: ["${sshHost}:${port}"] } }, "node", origin);`,
          );
        },
      });
      const admin = await session(broker);
      const api = async (path: string, body: unknown, expected: number, method = 'POST') => {
        const response = await admin.request(path, body, method);
        assert.equal(response.status, expected, `ssh-fixture-api:${path}`);
        return response;
      };
      const { id: orgId } = (await (
        await api('/_pb/organization', undefined, 200, 'GET')
      ).json()) as { id: string };
      const { id: projectId } = (await (
        await api('/_pb/projects', { slug: 'ssh', name: 'SSH' }, 201)
      ).json()) as { id: string };
      const { id: sourceId } = (await (
        await api(
          '/_pb/sources',
          {
            name: 'ssh',
            ecosystem: 'composer',
            type: 'vcs',
            url: null,
            config: {
              provider: 'ssh',
              repository: remote,
              packageName: 'acme/ssh',
              refs: { tags: true, branches: ['main'] },
            },
          },
          201,
        )
      ).json()) as { id: string };
      await api(
        `/_pb/sources/${sourceId}/credential`,
        { kind: 'ssh_key', material: JSON.stringify({ privateKeyPem, knownHosts }) },
        204,
        'PUT',
      );
      await api(`/_pb/sources/${sourceId}/names`, { pattern: 'acme/ssh' }, 201);
      await api(`/_pb/sources/${sourceId}/enable`, undefined, 204);
      await api(`/_pb/projects/ssh/sources/${sourceId}/attachment`, { precedence: 0 }, 204, 'PUT');
      const { token } = (await (
        await api(
          '/_pb/me/tokens',
          {
            name: 'ssh-reader',
            scope: 'read',
            readOnly: true,
            projectMode: 'selected',
            projectIds: [projectId],
          },
          201,
        )
      ).json()) as { token: string };
      await api(`/_pb/sources/${sourceId}/sync`, undefined, 202);
      await broker.pollTick(orgId);
      let distUrls: string[] = [];
      const failureEvents = () =>
        [
          ...new Set(
            broker!
              .logs()
              .split('\n')
              .flatMap((line) => {
                try {
                  const record = JSON.parse(line) as Record<string, unknown>;
                  if (record['level'] !== 'warn' && record['level'] !== 'error') return [];
                  return [
                    [record['event'], record['error_name'], record['reason_code']]
                      .filter((part) => typeof part === 'string' && /^[\w.-]{1,64}$/.test(part))
                      .join('/'),
                  ];
                } catch {
                  return [];
                }
              }),
          ),
        ].join(',');
      await until(
        async () => {
          await broker!.tick();
          const response = await fetch(`${broker!.origin}/ssh/p2/acme/ssh.json`, {
            headers: { authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` },
          });
          if (response.status !== 200) return false;
          const metadata = (await response.json()) as {
            packages: Record<string, { version: string; dist: { url: string } }[]>;
          };
          distUrls = ['v1.0.0', 'v1.1.0'].map(
            (wanted) =>
              metadata.packages['acme/ssh']?.find((v) => v.version === wanted)?.dist.url ?? '',
          );
          return distUrls.every((url) => url !== '');
        },
        'ssh-metadata',
        90_000,
      ).catch((error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : 'LocalTimeout'}:events=${failureEvents()}`,
        );
      });
      for (const url of distUrls)
        assert.equal(new URL(url).origin, broker.origin, 'SshDistMustUseBroker');
      const install = async (name: string, version: string, proof: string, lock?: string) => {
        const client = join(root, name);
        await mkdir(client);
        await writeFile(
          join(client, 'composer.json'),
          JSON.stringify({
            name: 'fixture/client',
            require: { 'acme/ssh': version },
            repositories: [
              { type: 'composer', url: `${broker!.origin}/ssh` },
              { 'packagist.org': false },
            ],
            config: { 'secure-http': false },
          }),
        );
        if (lock) await writeFile(join(client, 'composer.lock'), lock);
        try {
          await exec(
            'composer',
            ['install', '--no-interaction', '--no-plugins', '--no-scripts', '--prefer-dist'],
            {
              cwd: client,
              timeout: 60_000,
              env: {
                ...process.env,
                COMPOSER_HOME: join(client, '.composer'),
                COMPOSER_CACHE_DIR: join(client, '.cache'),
                COMPOSER_AUTH: JSON.stringify({
                  'http-basic': {
                    [new URL(broker!.origin).host]: { username: token, password: '' },
                  },
                }),
              },
            },
          );
        } catch {
          throw new Error(`SshComposerInstallFailed:${name}`);
        }
        expect(await readFile(join(client, 'vendor/acme/ssh/proof.txt'), 'utf8')).toBe(proof);
        return readFile(join(client, 'composer.lock'), 'utf8');
      };
      const lock = await install('first', '1.0.0', 'archive built from SSH\n');
      const afterFirst = await broker.storageKeys();
      await stop();
      await expect(listRemote()).rejects.toBeDefined();
      await install('second', '1.0.0', 'archive built from SSH\n', lock);
      expect(await broker.storageKeys(), 'SshSecondInstallMustUseStoredBlob').toEqual(afterFirst);
      await install('fresh', '1.1.0', 'second archive built from SSH\n');
      expect(
        (await broker.storageKeys()).filter((key) => !afterFirst.includes(key)).length,
        'SshFreshDistMustComeFromBuiltArchive',
      ).toBeGreaterThan(0);
      const logs = broker.logs();
      const pemLines = privateKeyPem
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('-----'));
      for (const secret of [
        privateKeyPem.trim(),
        JSON.stringify(privateKeyPem).slice(1, -1),
        JSON.stringify(privateKeyPem.trim()).slice(1, -1),
        ...pemLines,
        token,
        publicKey,
      ])
        expect(logs).not.toContain(secret);
    } finally {
      try {
        await broker?.close();
      } finally {
        try {
          await stop();
        } finally {
          await rm(root, { recursive: true, force: true });
          await rm(archives, { recursive: true, force: true });
        }
      }
    }
  },
  180_000,
);
