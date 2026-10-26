import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { LocalUnavailable } from './local.js';

export const publicAddress = '93.184.216.34';
export const selfHost = 'broker.security.test';
export const securityUpstreamHosts = [
  'repo.packagist.org',
  'registry.npmjs.org',
  'npm.pkg.github.com',
  'pkg-npm.githubusercontent.com',
  'codeload.github.com',
  'github.com',
  'api.github.com',
] as const;
export const dnsCases = {
  'loopback.security.test': [['127.0.0.1']],
  'metadata.security.test': [['169.254.169.254']],
  'ipv6.security.test': [['::1']],
  'mixed.security.test': [[publicAddress, '127.0.0.1']],
  'rebind.security.test': [[publicAddress], ['127.0.0.1']],
} as const;

export function pemBodyLines(secret: string): string[] {
  if (!secret.includes('-----BEGIN')) return [];
  const lines = secret
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('-----'));
  return [...lines.filter((line) => line.length >= 32), lines.join('')];
}

export function assertNoSecrets(output: string, secrets: readonly string[]): void {
  const found = secrets
    .filter(Boolean)
    .some((secret) =>
      [
        secret,
        encodeURIComponent(secret),
        Buffer.from(secret).toString('base64'),
        ...pemBodyLines(secret),
      ].some((form) => output.includes(form)),
    );
  assert(!found, 'SensitiveDataInOutput');
}

const githubOrigins = ['https://api.github.com', 'https://github.com'];

export class HeaderRecorder {
  private entries: { origin: string; authorized: boolean; forbidden: boolean }[] = [];
  private overflow = false;
  constructor(
    private readonly canaries: ReadonlyMap<string, string>,
    private readonly githubSecrets: readonly string[] = [],
  ) {}

  record(origin: string, headers: IncomingHttpHeaders, target = ''): void {
    if (this.entries.length >= 1000) {
      this.overflow = true;
      return;
    }
    const authorization = headers.authorization ?? '';
    const expected = this.canaries.get(origin);
    const basic = /^Basic\s+(\S+)$/i.exec(authorization)?.[1];
    const values = [
      ...Object.values(headers)
        .flat()
        .filter((value) => value !== undefined),
      basic ? Buffer.from(basic, 'base64').toString('utf8') : '',
    ].join('\n');
    let decoded = target;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      decoded = target;
    }
    const inUrl = [...this.canaries.values(), ...this.githubSecrets].some(
      (secret) => target.includes(secret) || decoded.includes(secret),
    );
    const github = githubOrigins.includes(origin);
    const githubLeak =
      !github && this.githubSecrets.some((secret) => secret && values.includes(secret));
    this.entries.push({
      origin,
      authorized: expected !== undefined && authorization === `Bearer ${expected}`,
      forbidden:
        inUrl ||
        githubLeak ||
        Boolean(
          headers.cookie ||
          headers['proxy-authorization'] ||
          (expected !== undefined && authorization && authorization !== `Bearer ${expected}`) ||
          (expected === undefined && !github && authorization),
        ) ||
        [...this.canaries].some(([owner, secret]) => owner !== origin && values.includes(secret)),
    });
  }

  assertContained(origins: readonly string[]): void {
    assert(!this.overflow, 'IncompleteHeaderEvidence');
    assert(
      this.entries.every((entry) => !entry.forbidden),
      'CredentialReachedForbiddenOrigin',
    );
    for (const origin of origins) {
      assert(
        this.entries.some((entry) => entry.origin === origin),
        'RecipientNotExercised',
      );
      if (this.canaries.has(origin))
        assert(
          this.entries.some((entry) => entry.origin === origin && entry.authorized),
          'CredentialPositiveControlMissing',
        );
    }
  }
}

export async function startSentinel(host: '127.0.0.1' | '::1' = '127.0.0.1') {
  let connections = 0;
  const server = createServer((_request, response) => {
    response.setHeader('connection', 'close');
    response.end('sentinel');
  });
  server.on('connection', () => {
    connections++;
  });
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, host, accept);
    });
  } catch {
    throw new LocalUnavailable('Security sentinel listener unavailable.');
  }
  const address = server.address();
  assert(address && typeof address !== 'string', 'SentinelAddressMissing');
  const origin = `http://${host === '::1' ? '[::1]' : host}:${address.port}`;
  return {
    origin,
    connections: () => connections,
    async positiveControl() {
      const before = connections;
      const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer();
      assert(connections > before, 'SentinelPositiveControlMissing');
    },
    close: () =>
      new Promise<void>((accept, reject) => {
        server.close((error) => (error ? reject(error) : accept()));
        server.closeAllConnections();
      }),
  };
}

export function canary(): string {
  return randomBytes(32).toString('hex');
}

export function disablePolicyFetch(bundle: string): string {
  const target = /function createPolicyFetch\(options\) \{/g;
  assert([...bundle.matchAll(target)].length === 1, 'PolicyMutationTargetMissing');
  return bundle.replace(
    target,
    `function createPolicyFetch(options) {
    return async (request) => {
      let url = request.url;
      for (let hop = 0; hop < 6; hop++) {
        const response = await options.fetchImpl(url, {
          method: request.method, headers: request.headers, redirect: 'manual',
          signal: AbortSignal.timeout(5000)
        });
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel();
          url = new URL(location, url).href;
          continue;
        }
        return response;
      }
      throw new Error('MutationRedirectLimit');
    };
  `,
  );
}

export function disableDnsGuard(bundle: string): string {
  const targets = [
    /if \(isNeverAllowed\(normalized\)\)\s*throw new DnsGuardError\("blocked_address"\);/g,
    /if \(!verdict\.ok\)\s*throw new DnsGuardError\(verdict\.reason\);/g,
  ];
  for (const target of targets)
    assert([...bundle.matchAll(target)].length === 1, 'DnsGuardMutationTargetMissing');
  return targets.reduce((patched, target) => patched.replace(target, ';'), bundle);
}

export function connectToUnguardedResolution(bundle: string): string {
  const target = /(const (\w+) = \w+\(hostname\) !== 0;\s*let connectHost = hostname;)/g;
  assert([...bundle.matchAll(target)].length === 1, 'SecondResolutionMutationTargetMissing');
  return bundle.replace(
    target,
    `$1
    if (!$2) {
      const answers = await (await import("node:dns/promises")).lookup(hostname);
      connectHost = (Array.isArray(answers) ? answers[0] : answers).address;
    }`,
  );
}

export function securityDestination(
  url: string,
  fixtureOrigin: string,
  sentinelOrigin: string,
  ipv6Origin: string,
  brokerOrigin: string,
): string {
  const target = new URL(url);
  assert(!target.username && !target.password, 'UnexpectedSecurityURL');
  if (target.origin === brokerOrigin || target.hostname === selfHost) return sentinelOrigin;
  if (target.hostname === '[::1]') return ipv6Origin;
  if (isIP(target.hostname) || target.hostname.endsWith('.security.test')) return sentinelOrigin;
  assert(
    securityUpstreamHosts.some((host) => target.origin === `https://${host}`),
    'UnexpectedSecurityUpstream',
  );
  return `${fixtureOrigin}/__upstream/${target.hostname}${target.pathname}${target.search}`;
}

export function nodeSecurityTransport(
  fixtureOrigin: string,
  sentinelOrigin: string,
  ipv6Origin: string,
): string {
  const fixture = new URL(fixtureOrigin);
  const sentinel = new URL(sentinelOrigin);
  const ipv6 = new URL(ipv6Origin);
  return `
const forward = http.request;
const known = ${JSON.stringify(securityUpstreamHosts)};
const bare = (value) => (value && value.startsWith('[') ? value.slice(1, -1) : value);
const routable = (name) =>
  net.isIP(name) !== 0 || known.includes(name) || name.endsWith('.security.test');
const dns = (await import('node:dns/promises')).default;
dns.lookup = async (host) => {
  if (!routable(host)) throw new Error('UnexpectedSecurityUpstream');
  const response = await fetch(${JSON.stringify(fixtureOrigin)} + '/_dns/' + host);
  if (!response.ok) throw new Error('UnexpectedSecurityDNS');
  return response.json();
};
const intercept = (input, extra) => {
  const options =
    typeof input === 'string' || input instanceof URL
      ? (() => {
          const url = new URL(input);
          return { hostname: url.hostname, path: url.pathname + url.search, ...(extra ?? {}) };
        })()
      : input;
  const target = bare(options.host ?? options.hostname);
  const name = bare(options.servername || target);
  const literal = net.isIP(target) !== 0 ? target : undefined;
  if (!literal && !routable(name)) throw new Error('UnexpectedSecurityUpstream');
  const route = (addresses) => {
    if (!literal && name === ${JSON.stringify(selfHost)}) return ['127.0.0.1', ${sentinel.port}];
    const unsafe = addresses.find((address) => address !== ${JSON.stringify(publicAddress)});
    if (unsafe === undefined) return ['127.0.0.1', ${fixture.port}];
    return net.isIP(unsafe) === 6 ? ['::1', ${ipv6.port}] : ['127.0.0.1', ${sentinel.port}];
  };
  const resolve = options.lookup ?? ((host, _settings, callback) =>
    dns.lookup(host).then((answers) => callback(null, answers), callback));
  const createConnection = (_settings, created) => {
    const connect = (addresses) => {
      const [address, port] = route(addresses);
      return net.connect(port, address);
    };
    if (literal) return connect([literal]);
    resolve(target, { all: true }, (error, answers) => {
      if (error) return created(error);
      created(null, connect((Array.isArray(answers) ? answers : [{ address: answers }]).map((entry) => entry.address)));
    });
  };
  return forward({ host: '127.0.0.1', port: ${fixture.port},
    path: '/__upstream/' + name + (options.path ?? '/'),
    method: options.method, headers: options.headers, createConnection });
};
https.request = intercept;
http.request = intercept;
`;
}

export async function startSecurityFixture(
  recorder: HeaderRecorder,
  respond: (request: Request) => Promise<Response> | Response,
) {
  const dnsCounts = new Map<string, number>();
  const requests = new Map<string, number>();
  let invalid = false;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const path = incoming.url ?? '/';
      if (path.startsWith('/_dns/')) {
        const host = path.slice('/_dns/'.length);
        const count = dnsCounts.get(host) ?? 0;
        dnsCounts.set(host, count + 1);
        const sequence = dnsCases[host as keyof typeof dnsCases];
        assert(
          sequence ||
            isIP(host) !== 0 ||
            host === selfHost ||
            (securityUpstreamHosts as readonly string[]).includes(host),
          'UnexpectedSecurityDNS',
        );
        const addresses =
          sequence?.[Math.min(count, sequence.length - 1)] ??
          (isIP(host) !== 0 ? [host] : [publicAddress]);
        outgoing.setHeader('content-type', 'application/json');
        outgoing.end(
          JSON.stringify(addresses.map((address) => ({ address, family: isIP(address) }))),
        );
        return;
      }
      assert(path.startsWith('/__upstream/'), 'UnexpectedSecurityRequest');
      const url = new URL('https://' + path.slice('/__upstream/'.length));
      recorder.record(url.origin, incoming.headers, url.pathname + url.search);
      const key = url.origin + url.pathname;
      requests.set(key, (requests.get(key) ?? 0) + 1);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += Buffer.byteLength(chunk);
        assert(size <= 1024 * 1024, 'SecurityFixtureBodyLimit');
        chunks.push(Buffer.from(chunk));
      }
      const method = incoming.method ?? 'GET';
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined && name !== 'host') headers.set(name, String(value));
      const response = await respond(
        new Request(url, {
          method,
          headers,
          ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      invalid = true;
      outgoing.writeHead(500);
      outgoing.end('SecurityFixtureFailure');
    }
  });
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    });
  } catch {
    throw new LocalUnavailable('Security fixture listener unavailable.');
  }
  const address = server.address();
  assert(address && typeof address !== 'string', 'SecurityFixtureAddressMissing');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    count: (url: string) => requests.get(url) ?? 0,
    dnsCount: (host: string) => dnsCounts.get(host) ?? 0,
    resetDns: () => dnsCounts.clear(),
    assertHealthy: () => assert(!invalid, 'SecurityFixtureFailure'),
    close: () =>
      new Promise<void>((accept, reject) => {
        server.close((error) => (error ? reject(error) : accept()));
        server.closeAllConnections();
      }),
  };
}
