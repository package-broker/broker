import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { session } from './evidence.js';
import { repository, reserveLoopbackPort, startLocal, until } from './local.js';
import type { LocalBroker } from './local.js';

const exec = promisify(execFile);

it('installs an SSH-built dist through the Node bundle, then installs with the SSH upstream stopped', async () => {
  await exec('composer', ['--version']);
  const port = await reserveLoopbackPort();
  await mkdir(join(repository, '.pb'), { recursive: true });
  const root = await realpath(await mkdtemp(join(repository, '.pb/ssh-install-')));
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
    await git('clone', '-q', '--bare', 'repo', 'repo.git');
    for (const name of ['client', 'host'])
      await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)]);
    const publicKey = (await readFile(join(root, 'client.pub'), 'utf8')).trim();
    await writeFile(
      join(root, 'authorized_keys'),
      `restrict,command="/usr/bin/git-upload-pack '${join(root, 'repo.git')}'" ${publicKey}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, 'sshd_config'),
      [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        'ListenAddress ::1',
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
    const sshd = process.env['PB_E2E_SSHD'] ?? '/usr/sbin/sshd';
    upstream = spawn(sshd, ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: 'ignore' });
    exited = once(upstream, 'exit');
    exited.catch(() => undefined);
    const privateKeyPem = await readFile(join(root, 'client'), 'utf8');
    const hostKey = (await readFile(join(root, 'host.pub'), 'utf8'))
      .split(' ')
      .slice(0, 2)
      .join(' ');
    const knownHosts = `ssh.localhost ${hostKey}\n`;
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
      'HostKeyAlias=ssh.localhost',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${join(root, 'known_hosts')}`,
      '-o',
      'BatchMode=yes',
      '-p',
      String(port),
      `${userInfo().username}@ssh.localhost`,
      'git-upload-pack repo.git',
    ];
    const remote = `ssh://${userInfo().username}@ssh.localhost:${port}/repo.git`;
    const sshCommand = sshArgs
      .slice(0, -2)
      .map((arg) => "'" + arg.replaceAll("'", "'\"'\"'") + "'")
      .join(' ');
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
          `return resolveRegistryConfig({ ...input, outbound: { ...input?.outbound, allowPrivateHosts: ["ssh.localhost:${port}"] } }, "node", origin);`,
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
    let distUrl = '';
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
        const version = metadata.packages['acme/ssh']?.find((v) => v.version === 'v1.0.0');
        distUrl = version?.dist.url ?? '';
        return distUrl !== '';
      },
      'ssh-metadata',
      90_000,
    );
    assert.equal(new URL(distUrl).origin, broker.origin, 'SshDistMustUseBroker');
    const install = async (name: string, lock?: string) => {
      const client = join(root, name);
      await mkdir(client);
      await writeFile(
        join(client, 'composer.json'),
        JSON.stringify({
          name: 'fixture/client',
          require: { 'acme/ssh': '1.0.0' },
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
        throw new Error('SshComposerInstallFailed');
      }
      expect(await readFile(join(client, 'vendor/acme/ssh/proof.txt'), 'utf8')).toBe(
        'archive built from SSH\n',
      );
      return readFile(join(client, 'composer.lock'), 'utf8');
    };
    const lock = await install('first');
    await stop();
    await expect(listRemote()).rejects.toBeDefined();
    await install('second', lock);
    const logs = broker.logs();
    for (const secret of [privateKeyPem.trim(), token, publicKey])
      expect(logs).not.toContain(secret);
  } finally {
    try {
      await broker?.close();
    } finally {
      try {
        await stop();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}, 180_000);
