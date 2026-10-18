import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPolicyFetch, UpstreamError } from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { createDnsGuard, type ResolvedAddress } from './dns-guard.js';
import { createGuardedFetch } from './guarded-fetch.js';
import { openSshGitSession } from './ssh-git.js';

const PUBLIC: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };
const HOST = 'registry.test';

const policy = (allowPrivateHosts: string[] = []) =>
  createOutboundPolicy({ allowPrivateHosts, runtime: 'node', selfOrigins: [] });

function switching(...answers: ResolvedAddress[][]) {
  let call = 0;
  return vi.fn(async () => answers[Math.min(call++, answers.length - 1)] ?? []);
}

let server: Server;
let port: number;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits += 1;
    res.end('local');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  hits = 0;
});

const policyFetchFor = (allow: string[], resolver = switching([LOOPBACK])) =>
  createPolicyFetch({
    policy: policy(allow),
    userAgent: 'pb-contract',
    fetchImpl: createGuardedFetch(policy(allow), { resolver }),
  });

const get = (url: string) =>
  ({ url, method: 'GET', purpose: 'metadata', maxBytes: 1024, timeoutMs: 2000 }) as const;

describe('scheme and port scoping of the allowlist', () => {
  it('guarded fetch refuses HTTP on an explicit custom port before connecting', async () => {
    const resolver = switching([LOOPBACK]);
    const fetch = createGuardedFetch(policy([`${HOST}:${port}`]), { resolver });
    await expect(fetch(`http://${HOST}:${port}/`)).rejects.toMatchObject({
      cause: { reason: 'scheme' },
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(hits).toBe(0);
  });

  it('guarded fetch refuses http on port 443 under host:443 before connecting', async () => {
    const resolver = switching([LOOPBACK]);
    const fetch = createGuardedFetch(policy([`${HOST}:443`]), { resolver });
    await expect(fetch(`http://${HOST}:443/`)).rejects.toMatchObject({
      cause: { reason: 'scheme' },
    });
    expect(hits).toBe(0);
  });

  it('policy fetch refuses http on port 443 under host:443 with reason scheme', async () => {
    const resolver = switching([LOOPBACK]);
    const error = await policyFetchFor(
      [`${HOST}:443`],
      resolver,
    )(get(`http://${HOST}:443/`)).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ code: 'refused', reason: 'scheme' });
    expect(resolver).not.toHaveBeenCalled();
    expect(hits).toBe(0);
  });
});

describe('DNS answer switching between check and connect', () => {
  it('re-vets at connect and refuses the switched answer', async () => {
    const resolver = switching([PUBLIC], [LOOPBACK]);
    const target = createDnsGuard(policy(), { resolver }).forTarget(HOST, port, 'http');
    expect((await target.resolve()).addresses).toEqual([PUBLIC]);
    const error = await new Promise<Error>((resolve, reject) => {
      const req = request({ host: HOST, port, path: '/', lookup: target.lookup, agent: false });
      req.once('response', () => reject(new Error('connected')));
      req.once('error', resolve);
      req.end();
    });
    expect(error).toMatchObject({ name: 'DnsGuardError', reason: 'blocked_address' });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(hits).toBe(0);
  });
});

describe('SSH transport', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dns-guard-contract-'));
    await writeFile(
      join(dir, 'git'),
      `#!/bin/sh\necho "$GIT_SSH_COMMAND" >> "${dir}/ssh.log"\nprintf '%s\\trefs/heads/main\\n' ${'a'.repeat(40)}\n`,
    );
    await chmod(join(dir, 'git'), 0o755);
    vi.stubEnv('PATH', `${dir}:/usr/bin:/bin`);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('pins HostName to the single vetted lookup even when DNS switches later', async () => {
    const resolver = switching([PUBLIC], [LOOPBACK]);
    const session = await openSshGitSession(
      { host: 'git.example.com', user: 'git', path: 'acme/lib.git' },
      {
        dnsGuard: createDnsGuard(policy(), { resolver }),
        credential: {
          privateKeyPem: 'FAKE-TEST-KEY',
          knownHosts: 'git.example.com ssh-ed25519 AAAA',
        },
        tmpRoot: dir,
      },
    );
    try {
      await session.lsRemote();
      await session.lsRemote();
    } finally {
      await session.close();
    }
    const commands = (await readFile(join(dir, 'ssh.log'), 'utf8')).trim().split('\n');
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain(`-o HostName=${PUBLIC.address} `);
      expect(command).not.toContain(LOOPBACK.address);
    }
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('refuses before spawning git when the only lookup is private', async () => {
    await rm(join(dir, 'ssh.log'), { force: true });
    await expect(
      openSshGitSession(
        { host: 'git.example.com', path: 'acme/lib.git' },
        {
          dnsGuard: createDnsGuard(policy(), { resolver: switching([LOOPBACK]) }),
          credential: { privateKeyPem: 'FAKE-TEST-KEY', knownHosts: 'x ssh-ed25519 AAAA' },
          tmpRoot: dir,
        },
      ),
    ).rejects.toMatchObject({ reason: 'blocked_address' });
    await expect(readFile(join(dir, 'ssh.log'), 'utf8')).rejects.toThrow();
  });
});
