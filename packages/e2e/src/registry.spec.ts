import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import { startLocal, until, LocalUnavailable, fixtureDestination } from './local.js';
import type { LocalBroker, Runtime } from './local.js';
import type { ScenarioResult } from './runner.js';
import { composerAvailable as checkComposer, redactComposerOutput } from './composer-output.js';

const SECRET = 'step7-fixture-webhook-secret';
const PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const INSTALLATION_TOKEN = 'ghs_step7FixtureInstallationToken';
const PERSONAL_TOKEN = 'github_pat_fixturePersonalAccessToken';
const PASSWORD = 'step7-fixture-password';
const GENERIC_GIT_TOKEN = 'generic-git-fixture-token';
const GENERIC_GIT_ORIGIN = 'https://git.example.test';
const GENERIC_GIT_PATH = '/acme/generic.git';
const REDIRECTING_GIT_PATH = '/acme/redirecting.git';
const REDIRECT_TARGET = 'https://github.com/acme/redirect-target.git';
const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
function tokenArchive(): Uint8Array {
  const name = Buffer.from('acme-token/composer.json');
  const content = Buffer.from('{"name":"acme/token","type":"library"}');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  local.copy(central, 8, 6, 30);
  const directory = Buffer.concat([central, name]);
  const file = Buffer.concat([local, name, content]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(file.length, 16);
  return new Uint8Array(Buffer.concat([file, directory, end]));
}
const TOKEN_ZIP = tokenArchive();
const TGZ = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const PUBLISHED = '2026-01-01T00:00:00.000Z';
const hash = (bytes: Uint8Array, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');
const FLUSH = new TextEncoder().encode('0000');
const DELIM = new TextEncoder().encode('0001');
const encodePkt = (value: string | Uint8Array): Uint8Array => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return new Uint8Array(
    Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]),
  );
};

type GitObject = { type: 'commit' | 'tree' | 'blob'; data: Uint8Array; oid: string };
const GIT_TYPE = { commit: 1, tree: 2, blob: 3 } as const;
const text = new TextEncoder();
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const gitObject = (type: GitObject['type'], data: Uint8Array): GitObject => ({
  type,
  data,
  oid: createHash('sha1')
    .update(concat([text.encode(`${type} ${data.length}\0`), data]))
    .digest('hex'),
});

function packOf(objects: readonly GitObject[]): Uint8Array {
  const header = new Uint8Array(12);
  header.set(text.encode('PACK'));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  const entries = objects.flatMap((object) => {
    const bytes: number[] = [];
    let first = (GIT_TYPE[object.type] << 4) | (object.data.length & 15);
    for (let rest = Math.floor(object.data.length / 16); rest > 0; rest = Math.floor(rest / 128)) {
      bytes.push(first | 0x80);
      first = rest & 0x7f;
    }
    bytes.push(first);
    return [Uint8Array.from(bytes), new Uint8Array(deflateSync(object.data))];
  });
  const body = concat([header, ...entries]);
  return concat([body, new Uint8Array(createHash('sha1').update(body).digest())]);
}

function gitRemote() {
  const objects = new Map<string, GitObject>();
  const add = (object: GitObject) => (objects.set(object.oid, object), object);
  const tag = (version: string) => {
    const manifest = add(gitObject('blob', text.encode(JSON.stringify({ name: 'acme/mirror' }))));
    const tree = add(
      gitObject(
        'tree',
        concat([text.encode('100644 composer.json\0'), Buffer.from(manifest.oid, 'hex')]),
      ),
    );
    const when = Date.parse(PUBLISHED) / 1000;
    return add(
      gitObject(
        'commit',
        text.encode(
          `tree ${tree.oid}\nauthor Release <release@acme.test> ${when} +0000\ncommitter Release <release@acme.test> ${when} +0000\n\nrelease ${version}\n`,
        ),
      ),
    ).oid;
  };
  const closure = (oid: string, filter: string | undefined, root: boolean): GitObject[] => {
    const object = objects.get(oid);
    if (object === undefined) return [];
    if (!root && filter === 'blob:none' && object.type === 'blob') return [];
    const out = [object];
    if (object.type === 'commit' && filter !== 'tree:0') {
      const tree = /^tree ([0-9a-f]{40})/.exec(new TextDecoder().decode(object.data))![1]!;
      out.push(...closure(tree, filter, false));
    } else if (object.type === 'tree' && (filter === undefined || filter === 'blob:none')) {
      for (let at = 0; at < object.data.length;) {
        const nul = object.data.indexOf(0, at);
        out.push(
          ...closure(
            Buffer.from(object.data.subarray(nul + 1, nul + 21)).toString('hex'),
            filter,
            false,
          ),
        );
        at = nul + 21;
      }
    }
    return out;
  };
  const lines = (body: Uint8Array) => {
    const out: string[] = [];
    for (let at = 0; at < body.length;) {
      const length = Number.parseInt(new TextDecoder().decode(body.subarray(at, at + 4)), 16);
      if (length < 4) {
        at += 4;
        continue;
      }
      out.push(new TextDecoder().decode(body.subarray(at + 4, at + length)).trimEnd());
      at += length;
    }
    return out;
  };
  return {
    tag,
    advertisement: () =>
      new Response(
        concat([
          encodePkt('version 2\n'),
          encodePkt('ls-refs\n'),
          encodePkt('fetch=filter\n'),
          encodePkt('object-format=sha1\n'),
          FLUSH,
        ]),
        { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } },
      ),
    uploadPack(body: Uint8Array, refs: ReadonlyMap<string, string>) {
      const request = lines(body);
      const headers = { 'content-type': 'application/x-git-upload-pack-result' };
      if (request.includes('command=ls-refs'))
        return new Response(
          concat([...[...refs].map(([name, oid]) => encodePkt(`${oid} ${name}\n`)), FLUSH]),
          { headers },
        );
      const filter = request.find((line) => line.startsWith('filter '))?.slice(7);
      const picked = new Map<string, GitObject>();
      for (const want of request.filter((line) => line.startsWith('want ')))
        for (const object of closure(want.slice(5), filter, true)) picked.set(object.oid, object);
      return new Response(
        concat([
          encodePkt('shallow-info\n'),
          DELIM,
          encodePkt('packfile\n'),
          encodePkt(concat([Uint8Array.of(1), packOf([...picked.values()])])),
          FLUSH,
        ]),
        { headers },
      );
    },
  };
}

export function createRegistryFixture() {
  const state = {
    versions: ['1.0.0'],
    corrupt: false,
    satisPackages: ['satis/first', 'satis/second'],
  };
  const calls: string[] = [];
  const git = gitRemote();
  const commits = new Map<string, string>();
  const member = (name: string, version: string) => ({
    name,
    version,
    version_normalized: `${version}.0`,
    time: PUBLISHED,
    dist: {
      type: 'zip',
      url: `https://codeload.github.com/${name}/legacy.zip/ref`,
      shasum: hash(ZIP, 'sha1'),
    },
  });
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(url.origin + url.pathname);
    assert(
      [
        'https://api.github.com',
        'https://github.com',
        'https://codeload.github.com',
        'https://repo.packagist.org',
        'https://registry.npmjs.org',
      ].includes(url.origin),
      'UnexpectedUpstream',
    );
    assert(request.headers.get('user-agent'), 'MissingUserAgent');
    assert(!request.headers.has('cookie'), 'CookieReachedUpstream');
    if (url.hostname === 'api.github.com') {
      if (url.pathname === '/app/installations/123/access_tokens') {
        assert.equal(request.method, 'POST');
        assert.match(request.headers.get('authorization') ?? '', /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
        const grant = (await request.json()) as { permissions: unknown };
        return Response.json(
          {
            token: INSTALLATION_TOKEN,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: grant.permissions,
            repositories: [{ name: 'mirror' }],
          },
          { status: 201 },
        );
      }
      if (url.pathname === '/graphql') {
        assert.equal(request.headers.get('authorization'), `Bearer ${PERSONAL_TOKEN}`);
        const { query, variables } = (await request.json()) as {
          query: string;
          variables: unknown;
        };
        assert.deepEqual(variables, { owner: 'acme', name: 'token' });
        const expressions = [...query.matchAll(/object\(expression: "([^"]+)"\)/g)];
        assert(expressions.length > 0, 'MissingGraphqlExpressions');
        for (const expression of expressions)
          assert.equal(expression[1], `${'b'.repeat(40)}:composer.json`);
        return Response.json({
          data: {
            repository: Object.fromEntries(
              [...query.matchAll(/(a[0-9]+): object/g)].map((match) => [
                match[1],
                {
                  byteSize: 64,
                  ...(query.includes('byteSize text')
                    ? { text: JSON.stringify({ name: 'acme/token', type: 'library' }) }
                    : {}),
                },
              ]),
            ),
          },
        });
      }
      if (url.pathname.startsWith('/repos/acme/token')) {
        assert.equal(request.headers.get('authorization'), `Bearer ${PERSONAL_TOKEN}`);
        if (url.pathname.endsWith('/tags'))
          return Response.json([{ name: '1.0.0', commit: { sha: 'b'.repeat(40) } }]);
        if (url.pathname.endsWith('/contents/composer.json'))
          return Response.json({ name: 'acme/token', type: 'library' });
        if (url.pathname.includes('/zipball/'))
          return new Response(null, {
            status: 302,
            headers: { location: 'https://codeload.github.com/acme/token/legacy.zip/ref?token=x' },
          });
        return Response.json({ archived: false, default_branch: 'main', full_name: 'acme/token' });
      }
      assert.equal(request.headers.get('authorization'), `Bearer ${INSTALLATION_TOKEN}`);
      if (url.pathname === '/repos/acme/mirror/contents/composer.json')
        return Response.json({ name: 'acme/mirror' });
      if (url.pathname === '/repos/acme/mirror')
        return Response.json({ archived: false, default_branch: 'main', full_name: 'acme/mirror' });
      const zipball = /^\/repos\/acme\/mirror\/zipball\/([0-9a-f]{40})$/.exec(url.pathname);
      if (zipball !== null)
        return new Response(null, {
          status: 302,
          headers: { location: `https://codeload.github.com/acme/mirror/legacy.zip/${zipball[1]}` },
        });
      return new Response(null, { status: 404 });
    }
    if (url.hostname === 'github.com') {
      assert.equal(
        request.headers.get('authorization'),
        `Basic ${btoa(`x-access-token:${INSTALLATION_TOKEN}`)}`,
      );
      if (url.pathname === '/acme/mirror.git/info/refs') return git.advertisement();
      assert.equal(url.pathname, '/acme/mirror.git/git-upload-pack');
      for (const version of state.versions)
        if (!commits.has(version)) commits.set(version, git.tag(version));
      return git.uploadPack(
        new Uint8Array(await request.arrayBuffer()),
        new Map(state.versions.map((version) => [`refs/tags/${version}`, commits.get(version)!])),
      );
    }
    if (url.hostname === 'codeload.github.com') {
      if (url.pathname.startsWith('/acme/token/')) {
        assert(!request.headers.has('authorization'), 'TokenReachedArchiveRedirect');
        assert.equal(url.search, '?token=x', 'ArchiveRedirectQueryMissing');
        return new Response(TOKEN_ZIP);
      }
      return new Response(state.corrupt ? ZIP.map((byte) => byte ^ 0xff) : ZIP);
    }
    if (url.hostname === 'repo.packagist.org' && url.pathname === '/satis/packages.json') {
      return Response.json({
        packages: Object.fromEntries(
          state.satisPackages.map((name) => [name, { '1.0.0': member(name, '1.0.0') }]),
        ),
      });
    }
    if (url.hostname === 'repo.packagist.org') {
      return Response.json(
        {
          minified: 'composer/2.0',
          packages: {
            'acme/proxy': url.pathname.endsWith('~dev.json') ? [] : [member('acme/proxy', '1.0.0')],
          },
        },
        { headers: { etag: '"proxy-v1"' } },
      );
    }
    if (url.pathname.endsWith('.tgz')) return new Response(TGZ);
    return Response.json(
      {
        name: 'widget',
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: 'widget',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/widget/-/widget-1.0.0.tgz',
              integrity: `sha512-${createHash('sha512').update(TGZ).digest('base64')}`,
            },
          },
        },
        time: { '1.0.0': PUBLISHED },
      },
      { headers: { etag: '"npm-v1"' } },
    );
  };
  return {
    state,
    calls,
    transport,
    count: (path: string) => calls.filter((url) => url.includes(path)).length,
  };
}

async function genericGitRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pb-generic-git-'));
  const work = join(root, 'work');
  const env = {
    PATH: process.env['PATH'],
    HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
  };
  const git = (args: string[], cwd = root) =>
    promisify(execFile)('git', args, { cwd, env, timeout: 30_000 });
  await mkdir(work);
  await git(['init', '-q', '-b', 'main', work]);
  await mkdir(join(work, 'src'));
  await writeFile(
    join(work, 'composer.json'),
    JSON.stringify({
      name: 'acme/generic',
      type: 'library',
      autoload: { 'psr-4': { 'Acme\\Generic\\': 'src/' } },
    }),
  );
  await writeFile(
    join(work, 'src/Generic.php'),
    '<?php\nnamespace Acme\\Generic;\nfinal class Generic {}\n',
  );
  await git(['add', '.'], work);
  await git(['commit', '-q', '-m', 'Generic fixture'], work);
  await git(['tag', '1.0.0'], work);
  await git(['clone', '-q', '--bare', work, join(root, 'generic.git')]);
  for (const [key, value] of [
    ['uploadpack.allowFilter', 'true'],
    ['uploadpack.allowAnySHA1InWant', 'true'],
    ['http.receivepack', 'false'],
  ] as const)
    await git(['config', key, value], join(root, 'generic.git'));
  await rm(work, { recursive: true, force: true });
  return root;
}

async function gitHttpBackend(
  root: string,
  request: { path: string; query: string; method: string; headers: Headers; body: Buffer },
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env['PATH'],
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: request.path,
      QUERY_STRING: request.query,
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get('content-type') ?? '',
      CONTENT_LENGTH: String(request.body.length),
      HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
      HTTP_GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
      GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = once(child, 'close');
  child.stdin.end(request.body);
  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout) chunks.push(Buffer.from(chunk));
  const [code] = (await exited) as [number | null];
  assert.equal(code, 0, 'GitHttpBackendFailed');
  const output = Buffer.concat(chunks);
  const crlf = output.indexOf('\r\n\r\n');
  const end = crlf >= 0 ? crlf : output.indexOf('\n\n');
  assert(end >= 0, 'GitHttpBackendHeaders');
  const headers = new Headers();
  let status = 200;
  for (const line of output.subarray(0, end).toString('latin1').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
    else headers.append(name, value);
  }
  return { status, headers, body: output.subarray(end + (crlf >= 0 ? 4 : 2)) };
}

async function startRegistryFixture() {
  const fixture = createRegistryFixture();
  let invalid = false;
  const generic = {
    root: null as string | null,
    requests: [] as { origin: string; path: string; authorization: string | null }[],
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
      assert(url.pathname.startsWith('/__upstream/'), 'UnexpectedFixtureRequest');
      const target = 'https://' + url.pathname.slice('/__upstream/'.length) + url.search;
      fixtureDestination(target, 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += Buffer.byteLength(chunk);
        assert(size <= 1_048_576, 'FixtureBodyLimit');
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined && name !== 'host') headers.set(name, String(value));
      }
      const method = incoming.method ?? 'GET';
      const upstream = new URL(target);
      const record = () =>
        generic.requests.push({
          origin: upstream.origin,
          path: upstream.pathname,
          authorization: headers.get('authorization'),
        });
      if (
        upstream.origin === GENERIC_GIT_ORIGIN &&
        upstream.pathname.startsWith(`${REDIRECTING_GIT_PATH}/`)
      ) {
        record();
        outgoing.writeHead(302, {
          location: `${REDIRECT_TARGET}${upstream.pathname.slice(REDIRECTING_GIT_PATH.length)}${upstream.search}`,
        });
        outgoing.end();
        return;
      }
      if (upstream.href.startsWith(`${REDIRECT_TARGET}/`)) {
        record();
        outgoing.writeHead(404);
        outgoing.end();
        return;
      }
      if (
        generic.root !== null &&
        upstream.origin === GENERIC_GIT_ORIGIN &&
        upstream.pathname.startsWith(`${GENERIC_GIT_PATH}/`)
      ) {
        record();
        const response = await gitHttpBackend(generic.root, {
          path: upstream.pathname.slice('/acme'.length),
          query: upstream.search.slice(1),
          method,
          headers,
          body: Buffer.concat(chunks),
        });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(response.body);
        return;
      }
      const response = await fixture.transport(target, {
        method,
        headers,
        ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }),
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      invalid = true;
      outgoing.writeHead(500);
      outgoing.end('FixtureProtocolFailure');
    }
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    ...fixture,
    generic,
    origin: `http://127.0.0.1:${address.port}`,
    assertHealthy() {
      assert(!invalid, 'FixtureProtocolFailure');
    },
    close: () =>
      new Promise<void>((accept, reject) => {
        server.close((error) => (error ? reject(error) : accept()));
        server.closeAllConnections();
      }),
  };
}

function totp(secret: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function status(response: Response, expected: number, label: string): Promise<Response> {
  assert.equal(response.status, expected, `${label}:HTTP:${response.status}`);
  return response;
}

function cause(error: unknown): string {
  const message = (error instanceof Error ? error.message : '').split('\n')[0]!.slice(0, 200);
  return /^[\w:./,@ -]+$/.test(message) ? ` (${message})` : ` (${error?.constructor?.name})`;
}

async function session(broker: LocalBroker) {
  let cookie = '';
  let csrf = '';
  const request = async (path: string, body?: unknown, method = 'POST') => {
    const response = await fetch(broker.origin + path, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: broker.origin,
        cookie,
        'x-csrf-token': csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      cookie = cookies.map((line) => line.split(';')[0]).join('; ');
      csrf = /(?:^|; )__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
    }
    return response;
  };
  const started = await status(
    await request('/_pb/auth/local/setup/start', { token: broker.setupToken }),
    200,
    'setup-start',
  );
  const { secret } = (await started.json()) as { secret: string };
  let lastStep = -1;
  const nextCode = async (): Promise<string> => {
    for (;;) {
      const clock = Math.floor(Date.now() / 30_000);
      const step = Math.max(lastStep + 1, clock);
      if (step <= clock + 1) {
        lastStep = step;
        return totp(secret, step);
      }
      await delay(Math.max(lastStep * 30_000 - Date.now(), 0) + 100);
    }
  };
  await status(
    await request('/_pb/auth/local/setup/finish', {
      token: broker.setupToken,
      password: PASSWORD,
      code: await nextCode(),
    }),
    204,
    'setup-finish',
  );
  await status(
    await request('/_pb/auth/local/login', {
      email: 'admin@example.test',
      password: PASSWORD,
      code: await nextCode(),
    }),
    204,
    'login',
  );
  await status(
    await request('/_pb/auth/local/reauth', { password: PASSWORD, code: await nextCode() }),
    204,
    'reauth',
  );
  return {
    request,
    secrets: () => [
      cookie,
      csrf,
      secret,
      /(?:^|; )__Host-pb_session=([^;]+)/.exec(cookie)?.[1] ?? '',
    ],
  };
}

export async function registryScenario(
  runtime: Runtime,
  options: { removeWebhook?: boolean } = {},
): Promise<ScenarioResult> {
  let stage = 'startup';
  let composerFailure = '';
  let broker: LocalBroker | undefined;
  let fixture: Awaited<ReturnType<typeof startRegistryFixture>> | undefined;
  try {
    // Probe before opening the fixture so an unavailable listener is distinguished from scenario failure.
    const { reserveLoopbackPort } = await import('./local.js');
    await reserveLoopbackPort();
    fixture = await startRegistryFixture();
    broker = await startLocal(runtime, fixture.origin, options);
    const local = broker;
    const remote = fixture;
    stage = 'admin-session';
    const admin = await session(local);
    stage = 'session-seeding';
    const api = async (path: string, body: unknown, expected = 204, method = 'POST') =>
      status(await admin.request(path, body, method), expected, path);
    const project = await api('/_pb/projects', { slug: 'alpha', name: 'Alpha' }, 201);
    const { id: projectId } = (await project.json()) as { id: string };
    const betaProject = await api('/_pb/projects', { slug: 'beta', name: 'Beta' }, 201);
    const { id: betaId } = (await betaProject.json()) as { id: string };
    const sources = [
      {
        name: 'mirror',
        ecosystem: 'composer',
        source_type: 'vcs',
        url: null,
        config: {
          provider: 'github',
          repository: 'acme/mirror',
          installationId: 123,
          refs: { tags: true, branches: [] },
        },
      },
      {
        name: 'token',
        ecosystem: 'composer',
        source_type: 'vcs',
        url: null,
        config: {
          provider: 'github',
          repository: 'acme/token',
          refs: { tags: true, branches: [] },
        },
      },
      {
        name: 'packagist',
        ecosystem: 'composer',
        source_type: 'packagist_proxy',
        url: 'https://repo.packagist.org',
        config: { githubToken: false },
      },
      {
        name: 'npmjs',
        ecosystem: 'npm',
        source_type: 'npmjs_proxy',
        url: 'https://registry.npmjs.org',
        config: {},
      },
    ];
    for (const { source_type, ...source } of sources)
      await api('/_pb/sources', { ...source, type: source_type }, 201);
    const listed = await status(
      await admin.request('/_pb/sources', undefined, 'GET'),
      200,
      'source-list',
    );
    const { items, vcsProviders } = (await listed.json()) as {
      items: { id: string; name: string }[];
      vcsProviders: string[];
    };
    assert.deepEqual(
      vcsProviders,
      runtime === 'node' ? ['github', 'git'] : ['github'],
      `vcs-providers:${vcsProviders.join(',')}`,
    );
    if (runtime === 'cloudflare')
      await status(
        await admin.request('/_pb/sources', {
          name: 'generic-refused',
          ecosystem: 'composer',
          type: 'vcs',
          url: null,
          config: { provider: 'git', repository: 'https://github.com/acme/generic.git' },
        }),
        400,
        'generic-git-refused',
      );
    const source = items.find((item) => item.name === 'mirror')!.id;
    const attach = (slug: string, name: string, precedence: number) =>
      api(
        `/_pb/projects/${slug}/sources/${items.find((item) => item.name === name)!.id}/attachment`,
        { precedence },
        204,
        'PUT',
      );
    await attach('alpha', 'mirror', 0);
    await attach('alpha', 'token', 10);
    await attach('alpha', 'packagist', 100);
    await attach('alpha', 'npmjs', 200);
    await attach('beta', 'packagist', 0);
    await api(
      `/_pb/sources/${source}/credential`,
      {
        kind: 'github_app',
        material: JSON.stringify({
          appId: '42',
          privateKeyPem: PRIVATE_KEY,
          webhookSecret: SECRET,
        }),
      },
      204,
      'PUT',
    );
    await api(`/_pb/sources/${source}/names`, { pattern: 'acme/mirror' }, 201);
    await api(`/_pb/sources/${source}/enable`, undefined);
    const tokenSource = items.find((item) => item.name === 'token')!.id;
    await api(
      `/_pb/sources/${tokenSource}/credential`,
      { kind: 'bearer', material: JSON.stringify({ token: PERSONAL_TOKEN }) },
      204,
      'PUT',
    );
    await api(`/_pb/sources/${tokenSource}/names`, { pattern: 'acme/token' }, 201);
    await api(`/_pb/sources/${tokenSource}/enable`, undefined);
    for (const item of items.filter((item) => item.name !== 'mirror' && item.name !== 'token'))
      await api(`/_pb/sources/${item.id}/resume`, undefined);
    const issued = await api(
      '/_pb/me/tokens',
      {
        name: 'alpha-reader',
        scope: 'read',
        readOnly: true,
        projectMode: 'selected',
        projectIds: [projectId],
      },
      201,
    );
    const { token } = (await issued.json()) as { token: string };
    const betaIssued = await api(
      '/_pb/me/tokens',
      {
        name: 'beta-reader',
        scope: 'read',
        readOnly: true,
        projectMode: 'selected',
        projectIds: [betaId],
      },
      201,
    );
    const { token: betaToken } = (await betaIssued.json()) as { token: string };
    const organization = await status(
      await admin.request('/_pb/organization', undefined, 'GET'),
      200,
      'organization',
    );
    const { id: orgId } = (await organization.json()) as { id: string };
    const rows = <T extends Record<string, unknown>>(
      sql: string,
      params: (string | number)[] = [],
    ) => local.read<T>(sql, [orgId, ...params]);
    const credentials = await rows<{ credential_id: string }>(
      // eslint-disable-next-line no-restricted-syntax -- Scoped infrastructure observation; seeding uses session APIs.
      'SELECT credential_id FROM source WHERE org_id = ? AND id = ?',
      [source],
    );
    assert.equal(credentials.length, 1);
    const credential = credentials[0]!.credential_id;
    const captured: string[] = [];
    const get = async (path: string, authenticated = true, bearer = token) => {
      const response = await fetch(local.origin + path, {
        headers: authenticated ? { authorization: `Bearer ${bearer}` } : {},
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      captured.push(JSON.stringify([...response.headers]), await response.clone().text());
      return response;
    };
    const envelope = async (
      path: string,
      code: number,
      expected: string,
      authenticated = true,
      bearer = token,
    ) => {
      const response = await status(await get(path, authenticated, bearer), code, 'authorization');
      const value = (await response.json()) as {
        error: { code: string; message: string; requestId: string };
      };
      assert.equal(value.error.code, expected);
      assert(value.error.message && value.error.requestId, 'MissingErrorEnvelope');
      return { code: value.error.code, message: value.error.message };
    };
    stage = 'composer-source-repoll';
    const satis = await api(
      '/_pb/sources',
      {
        name: 'satis',
        ecosystem: 'composer',
        type: 'composer_repository',
        url: 'https://repo.packagist.org/satis/packages.json',
        config: { selection: { packages: ['satis/first'] } },
      },
      201,
    );
    const { id: satisId } = (await satis.json()) as { id: string };
    await api(`/_pb/sources/${satisId}/names`, { pattern: 'satis/*' }, 201);
    await api(`/_pb/projects/alpha/sources/${satisId}/attachment`, {}, 204, 'PUT');
    const waitForPackage = async (name: string) => {
      await local.pollTick(orgId);
      await until(async () => {
        const response = await admin.request(`/_pb/projects/alpha/packages`, undefined, 'GET');
        assert.equal(response.status, 200);
        const page = (await response.json()) as { items: { name: string }[] };
        return page.items.some((item) => item.name === name);
      }, `composer-source-repoll:${name}`);
    };
    await api(`/_pb/sources/${satisId}/enable`, undefined);
    await waitForPackage('satis/first');
    await api(
      `/_pb/sources/${satisId}`,
      {
        config: { selection: { packages: ['satis/first', 'satis/second', 'satis/third'] } },
      },
      204,
      'PATCH',
    );
    await api(`/_pb/sources/${satisId}/sync`, undefined, 409);
    await api(`/_pb/sources/${satisId}/enable`, undefined);
    await waitForPackage('satis/second');
    // The upstream adds a selected package while the source remains active.
    remote.state.satisPackages.push('satis/third');
    await api(`/_pb/sources/${satisId}/sync`, undefined, 202);
    await waitForPackage('satis/third');
    const sourceList = await admin.request('/_pb/sources', undefined, 'GET');
    const sourcePage = (await sourceList.json()) as {
      items: { id: string; pollIntervalSeconds: number }[];
    };
    assert.equal(sourcePage.items.find((item) => item.id === satisId)?.pollIntervalSeconds, 86400);

    await until(async () => {
      const pending = await rows<{ state: string }>(
        // eslint-disable-next-line no-restricted-syntax -- Scoped infrastructure observation; seeding uses session APIs.
        "SELECT state FROM job WHERE org_id = ? AND type IN ('core:source-poll:v1', 'core:source-sync:v1') AND state NOT IN ('succeeded', 'failed', 'dead')",
      );
      return pending.length === 0;
    }, 'source-jobs-settled');

    stage = 'authorization';
    await envelope('/alpha/packages.json', 401, 'unauthorized', false);
    const hook = async (ref: string, valid = true) => {
      const body = JSON.stringify({
        ref,
        installation: { id: 123 },
        repository: { full_name: 'acme/mirror' },
      });
      return fetch(`${local.origin}/_pb/hooks/github/${credential}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': randomBytes(16).toString('hex'),
          'x-hub-signature-256': `sha256=${createHmac('sha256', valid ? SECRET : 'invalid')
            .update(body)
            .digest('hex')}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    };
    await status(await hook('refs/tags/1.0.0', false), 404, 'forged-webhook');
    const jobs = () =>
      rows<{ state: string; payload_json: string }>(
        // eslint-disable-next-line no-restricted-syntax -- Scoped infrastructure observation; seeding uses session APIs.
        "SELECT state, payload_json FROM job WHERE org_id = ? AND type = 'core:source-sync:v1'",
      );
    const beforeHook = (await jobs()).length;
    stage = 'signed-webhook';
    await status(await hook('refs/tags/1.0.0'), 202, 'signed-webhook');
    stage = 'webhook-sync';
    await until(async () => {
      const found = await jobs();
      assert(
        found.every((job) => job.state !== 'failed' && job.state !== 'dead'),
        'SourceSyncFailed',
      );
      return found.length > beforeHook && found.every((job) => job.state === 'succeeded');
    }, 'webhook-sync');
    assert(
      (await jobs()).some((job) => {
        const payload = JSON.parse(job.payload_json) as { sourceId: string; reason: string };
        return payload.sourceId === source && payload.reason === 'webhook';
      }),
      'WebhookJobMissing',
    );
    const composer = async (
      name: string,
      wanted = '1.0.0',
      timeoutMs = 30_000,
      expected: Uint8Array = ZIP,
    ) => {
      type Metadata = { packages: Record<string, { version: string; dist: { url: string } }[]> };
      let body: Metadata | undefined;
      let observed = 'none';
      try {
        await until(
          async () => {
            const response = await get(`/alpha/p2/${name}.json`);
            if (response.status !== 200) {
              observed = `HTTP:${response.status}`;
              return false;
            }
            body = (await response.json()) as Metadata;
            const versions = body.packages[name]?.map((version) => version.version);
            observed = `versions:${versions?.join(',') ?? 'missing'}`;
            return versions?.includes(wanted) === true;
          },
          'composer-metadata',
          timeoutMs,
        );
      } catch (error) {
        throw new Error(`${(error as Error).message}:${name}:${wanted}:${observed}`, {
          cause: error,
        });
      }
      const versions = body!.packages[name]!;
      const version = versions.find((version) => version.version === wanted)!;
      const dist = new URL(version.dist.url);
      assert.equal(dist.origin, local.origin, `composer-dist-origin:${dist.origin}`);
      const archive = await status(await get(dist.pathname), 200, 'composer-archive');
      assert.deepEqual(new Uint8Array(await archive.arrayBuffer()), expected);
      return { path: dist.pathname, versions: versions.map((version) => version.version).sort() };
    };
    stage = 'registry-reads';
    assert.deepEqual((await composer('acme/mirror')).versions, ['1.0.0'], 'mirror-versions');
    for (const path of [
      '/app/installations/123/access_tokens',
      '/contents/composer.json',
      '/acme/mirror.git/info/refs',
      '/acme/mirror.git/git-upload-pack',
      '/repos/acme/mirror/zipball/',
    ])
      assert(remote.count(path) > 0, 'GitHubProviderLegMissing');
    stage = 'github-token-composer';
    await api(`/_pb/sources/${tokenSource}/sync`, undefined, 202);
    await local.pollTick(orgId);
    await composer('acme/token', '1.0.0', 90_000, TOKEN_ZIP);
    const composerAvailable = await checkComposer(() =>
      promisify(execFile)('composer', ['--version'], { timeout: 10_000 }),
    );
    if (composerAvailable) {
      const clientDirectory = await mkdtemp(join(tmpdir(), 'pb-github-token-'));
      try {
        await writeFile(
          join(clientDirectory, 'composer.json'),
          JSON.stringify({
            repositories: [
              { type: 'composer', url: `${local.origin}/alpha` },
              { 'packagist.org': false },
            ],
            config: { 'secure-http': false },
          }),
        );
        try {
          await promisify(execFile)(
            'composer',
            [
              'require',
              'acme/token:1.0.0',
              '--no-interaction',
              '--no-plugins',
              '--no-scripts',
              '--prefer-dist',
            ],
            {
              cwd: clientDirectory,
              timeout: 60_000,
              env: {
                ...process.env,
                COMPOSER_HOME: join(clientDirectory, '.composer'),
                COMPOSER_CACHE_DIR: join(clientDirectory, '.cache'),
                COMPOSER_AUTH: JSON.stringify({
                  'http-basic': { [new URL(local.origin).host]: { username: token, password: '' } },
                }),
              },
            },
          );
        } catch (error) {
          const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
          composerFailure = redactComposerOutput(`${stderr}${stdout}`, [
            token,
            PERSONAL_TOKEN,
            INSTALLATION_TOKEN,
            PASSWORD,
          ]).slice(-1500);
          throw new Error('ComposerRequireFailed', { cause: error });
        }
        assert.equal(
          JSON.parse(
            await readFile(join(clientDirectory, 'vendor/acme/token/composer.json'), 'utf8'),
          ).name,
          'acme/token',
        );
      } finally {
        await rm(clientDirectory, { recursive: true, force: true });
      }
    }
    assert(remote.count('/repos/acme/token/tags') > 0, 'TokenTagsMissing');
    assert(remote.count('/repos/acme/token/zipball/') > 0, 'TokenDistMissing');
    if (runtime === 'node') {
      stage = 'generic-git';
      const gitRoot = await genericGitRepository();
      try {
        remote.generic.root = gitRoot;
        const created = await api(
          '/_pb/sources',
          {
            name: 'generic',
            ecosystem: 'composer',
            type: 'vcs',
            url: null,
            config: {
              provider: 'git',
              repository: `${GENERIC_GIT_ORIGIN}${GENERIC_GIT_PATH}`,
              refs: { tags: true, branches: [] },
            },
          },
          201,
        );
        const { id: genericSource } = (await created.json()) as { id: string };
        await api(
          `/_pb/sources/${genericSource}/credential`,
          { kind: 'bearer', material: JSON.stringify({ token: GENERIC_GIT_TOKEN }) },
          204,
          'PUT',
        );
        await api(`/_pb/sources/${genericSource}/names`, { pattern: 'acme/generic' }, 201);
        await api(`/_pb/sources/${genericSource}/enable`, undefined);
        await api(
          `/_pb/projects/alpha/sources/${genericSource}/attachment`,
          { precedence: 20 },
          204,
          'PUT',
        );
        await api(`/_pb/sources/${genericSource}/sync`, undefined, 202);
        await local.pollTick(orgId);
        type Metadata = {
          packages: Record<
            string,
            { version: string; dist: { url: string; type: string; reference: string } }[]
          >;
        };
        let generic: Metadata['packages'][string] | undefined;
        await until(
          async () => {
            await local.tick();
            const response = await get('/alpha/p2/acme/generic.json');
            if (response.status !== 200) return false;
            generic = ((await response.json()) as Metadata).packages['acme/generic'];
            return generic?.some((version) => version.version === '1.0.0') === true;
          },
          'generic-git-metadata',
          90_000,
        );
        const release = generic!.find((version) => version.version === '1.0.0')!;
        assert.equal(release.dist.type, 'zip', 'GenericDistType');
        assert.match(release.dist.reference, /^[0-9a-f]{40}$/, 'GenericDistReference');
        const distUrl = new URL(release.dist.url);
        assert.equal(distUrl.origin, local.origin, `generic-dist-origin:${distUrl.origin}`);
        const archive = new Uint8Array(
          await (await status(await get(distUrl.pathname), 200, 'generic-archive')).arrayBuffer(),
        );
        assert.deepEqual([...archive.subarray(0, 4)], [0x50, 0x4b, 3, 4], 'GenericArchiveZip');
        const builtRequests = remote.generic.requests.length;
        const again = new Uint8Array(
          await (
            await status(await get(distUrl.pathname), 200, 'generic-archive-stored')
          ).arrayBuffer(),
        );
        assert.deepEqual(again, archive, 'GenericArchiveStable');
        assert.equal(remote.generic.requests.length, builtRequests, 'GenericArchiveRebuilt');
        assert(
          remote.generic.requests.some((request) => request.path.endsWith('/git-upload-pack')),
          'GenericUploadPackMissing',
        );
        assert(
          remote.generic.requests.every(
            (request) =>
              request.origin === GENERIC_GIT_ORIGIN &&
              request.authorization === `Bearer ${GENERIC_GIT_TOKEN}`,
          ),
          'GenericCredentialNotBound',
        );
        if (!composerAvailable && process.env['CI'] === 'true')
          throw new Error('ComposerUnavailableInCi');
        if (composerAvailable) {
          const clientDirectory = await mkdtemp(join(tmpdir(), 'pb-generic-git-'));
          try {
            await writeFile(
              join(clientDirectory, 'composer.json'),
              JSON.stringify({
                repositories: [
                  { type: 'composer', url: `${local.origin}/alpha` },
                  { 'packagist.org': false },
                ],
                config: { 'secure-http': false },
              }),
            );
            try {
              await promisify(execFile)(
                'composer',
                [
                  'require',
                  'acme/generic:1.0.0',
                  '--no-interaction',
                  '--no-plugins',
                  '--no-scripts',
                  '--prefer-dist',
                ],
                {
                  cwd: clientDirectory,
                  timeout: 60_000,
                  env: {
                    ...process.env,
                    COMPOSER_HOME: join(clientDirectory, '.composer'),
                    COMPOSER_CACHE_DIR: join(clientDirectory, '.cache'),
                    COMPOSER_AUTH: JSON.stringify({
                      'http-basic': {
                        [new URL(local.origin).host]: { username: token, password: '' },
                      },
                    }),
                  },
                },
              );
            } catch (error) {
              const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
              composerFailure = redactComposerOutput(`${stderr}${stdout}`, [
                token,
                GENERIC_GIT_TOKEN,
                PASSWORD,
              ]).slice(-1500);
              throw new Error('ComposerRequireFailed', { cause: error });
            }
            assert.equal(
              JSON.parse(
                await readFile(join(clientDirectory, 'vendor/acme/generic/composer.json'), 'utf8'),
              ).name,
              'acme/generic',
            );
            await readFile(join(clientDirectory, 'vendor/acme/generic/src/Generic.php'), 'utf8');
          } finally {
            await rm(clientDirectory, { recursive: true, force: true });
          }
        }
      } finally {
        remote.generic.root = null;
        await rm(gitRoot, { recursive: true, force: true });
      }
    }
    const proxy = await composer('acme/proxy');
    const packument = await status(await get('/alpha/npm/widget'), 200, 'npm-packument');
    const npm = (await packument.json()) as {
      versions: Record<string, { dist: { tarball: string; integrity: string } }>;
    };
    const dist = npm.versions['1.0.0']!.dist;
    assert.equal(
      new URL(dist.tarball).origin,
      local.origin,
      `npm-tarball-origin:${new URL(dist.tarball).origin}`,
    );
    assert.equal(dist.integrity, `sha512-${createHash('sha512').update(TGZ).digest('base64')}`);
    const tarball = await status(await get(new URL(dist.tarball).pathname), 200, 'npm-tarball');
    assert.deepEqual(new Uint8Array(await tarball.arrayBuffer()), TGZ);
    const betaPath = proxy.path.replace('/alpha/', '/beta/');
    const betaMetadata = await status(
      await get('/beta/p2/acme/proxy.json', true, betaToken),
      200,
      'beta-metadata',
    );
    assert(JSON.stringify(await betaMetadata.json()).includes('acme/proxy'), 'BetaPackageMissing');
    const betaArchive = await status(await get(betaPath, true, betaToken), 200, 'beta-archive');
    assert.deepEqual(new Uint8Array(await betaArchive.arrayBuffer()), ZIP);
    await until(
      async () => {
        await local.tick();
        const pending = await rows(
          // eslint-disable-next-line no-restricted-syntax -- Scoped infrastructure observation of unsettled jobs.
          "SELECT id FROM job WHERE org_id = ? AND (state = 'running' OR (state = 'queued' AND run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
        );
        return pending.length === 0;
      },
      'jobs-settled',
      60_000,
    );
    const deniedCalls = remote.calls.length;
    const beta = await envelope(betaPath, 404, 'not_found');
    await envelope('/beta/p2/acme/proxy.json', 404, 'not_found');
    await envelope('/gamma/p2/acme/proxy.json', 404, 'not_found');
    const missing = await envelope(
      proxy.path.replace('acme/proxy', 'acme/other'),
      404,
      'not_found',
    );
    const absentProject = await envelope(
      proxy.path.replace('/alpha/', '/missing/'),
      404,
      'not_found',
    );
    assert.equal(beta.code, missing.code);
    assert.deepEqual(beta, absentProject);
    assert.equal(
      remote.calls.length,
      deniedCalls,
      `denied-upstream-calls:${remote.calls.length - deniedCalls}`,
    );
    stage = 're-mirror';
    await local.loseBlob(orgId, hash(ZIP));
    const beforeRemirror = remote.count('/acme/proxy/legacy.zip/');
    const restored = await status(await get(proxy.path), 200, 're-mirror');
    assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), ZIP);
    assert.equal(
      remote.count('/acme/proxy/legacy.zip/'),
      beforeRemirror + 2,
      'RemirrorTwoPassBound',
    );
    stage = 'updated-webhook';
    remote.state.versions = ['2.0.0', '1.0.0'];
    const beforeUpdate = (await jobs()).length;
    await status(await hook('refs/tags/2.0.0'), 202, 'updated-webhook');
    await until(
      async () =>
        (await jobs()).length > beforeUpdate &&
        (await jobs()).every((job) => job.state === 'succeeded'),
      'updated-sync',
    );
    assert.deepEqual((await composer('acme/mirror', '2.0.0')).versions, ['1.0.0', '2.0.0']);
    if (runtime === 'node') {
      stage = 'generic-git-redirect';
      const redirecting = await api(
        '/_pb/sources',
        {
          name: 'generic-redirecting',
          ecosystem: 'composer',
          type: 'vcs',
          url: null,
          config: {
            provider: 'git',
            repository: `${GENERIC_GIT_ORIGIN}${REDIRECTING_GIT_PATH}`,
            packageName: 'acme/redirecting',
            refs: { tags: true, branches: [] },
          },
        },
        201,
      );
      const { id: redirectingSource } = (await redirecting.json()) as { id: string };
      await api(
        `/_pb/sources/${redirectingSource}/credential`,
        { kind: 'bearer', material: JSON.stringify({ token: GENERIC_GIT_TOKEN }) },
        204,
        'PUT',
      );
      await api(`/_pb/sources/${redirectingSource}/names`, { pattern: 'acme/redirecting' }, 201);
      await api(`/_pb/sources/${redirectingSource}/enable`, undefined);
      await api(`/_pb/sources/${redirectingSource}/sync`, undefined, 202);
      await local.pollTick(orgId);
      const redirected = () =>
        remote.generic.requests.filter((request) => request.path.startsWith(REDIRECTING_GIT_PATH));
      await until(
        async () => {
          await local.tick();
          return redirected().length > 0;
        },
        'generic-git-redirect-attempted',
        60_000,
      );
      await until(
        async () => {
          await local.tick();
          const settled = await rows<{ state: string }>(
            // eslint-disable-next-line no-restricted-syntax -- Scoped infrastructure observation of the redirecting source sync.
            "SELECT state FROM job WHERE org_id = ? AND type = 'core:source-sync:v1' AND json_extract(payload_json, '$.sourceId') = ?",
            [redirectingSource],
          );
          return settled.length > 0 && settled.every((job) => job.state !== 'running');
        },
        'generic-git-redirect-settled',
        60_000,
      );
      assert(
        redirected().every((request) => request.authorization === `Bearer ${GENERIC_GIT_TOKEN}`),
        'RedirectingSourceCredentialNotBound',
      );
      const crossOrigin = remote.generic.requests.filter(
        (request) => request.origin !== GENERIC_GIT_ORIGIN,
      );
      assert(
        crossOrigin.some((request) => request.path.startsWith('/acme/redirect-target.git/')),
        'RedirectTargetNotReached',
      );
      assert(
        crossOrigin.every((request) => request.authorization === null),
        'BearerForwardedAcrossOrigins',
      );
    }
    await local.loseBlob(orgId, hash(ZIP));
    remote.state.corrupt = true;
    await status(await get(proxy.path), 502, 'digest-mismatch');
    await status(await get(proxy.path), 404, 'quarantined');
    stage = 'module-and-leak-evidence';
    await local.moduleEvidence();
    remote.assertHealthy();
    const auditRows = await rows<{ payload_json: string }>(
      // eslint-disable-next-line no-restricted-syntax -- Organization-scoped redaction evidence.
      'SELECT payload_json FROM audit_event WHERE org_id = ?',
    );
    const pendingRows = await rows<{ payload_json: string }>(
      // eslint-disable-next-line no-restricted-syntax -- Organization-scoped redaction evidence.
      'SELECT payload_json FROM audit_pending WHERE org_id = ?',
    );
    const sourceResponse = await status(
      await admin.request('/_pb/sources', undefined, 'GET'),
      200,
      'token-source-redaction',
    );
    const output = [
      local.logs(),
      ...captured,
      await sourceResponse.text(),
      JSON.stringify(auditRows),
      JSON.stringify(pendingRows),
    ].join('\n');
    for (const secret of [
      PRIVATE_KEY,
      JSON.stringify(PRIVATE_KEY).slice(1, -1),
      PRIVATE_KEY.split('\n')[1]!,
      SECRET,
      INSTALLATION_TOKEN,
      PERSONAL_TOKEN,
      GENERIC_GIT_TOKEN,
      PASSWORD,
      'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      token,
      betaToken,
      local.setupToken,
      'admin@example.test',
      ...admin.secrets(),
    ])
      assert(!secret || !output.includes(secret), 'SensitiveDataInOutput');
    return {
      status: 'PASS',
      reason: `${runtime}: production bundle completed registry legs and the two-pass re-mirror. Composer require: ${composerAvailable ? 'PASS' : 'NOT RUN (composer unavailable)'}.`,
    };
  } catch (error) {
    return error instanceof LocalUnavailable
      ? { status: 'NOT RUN', reason: `${runtime}: ${error.message}` }
      : {
          status: 'FAIL',
          reason:
            stage === 'signed-webhook' &&
            error instanceof assert.AssertionError &&
            error.actual === 404 &&
            error.expected === 202
              ? `${runtime}: signed webhook returned HTTP 404.`
              : `${runtime}: registry assembly scenario failed at ${stage}${cause(error)}.${composerFailure && ` Composer output: ${composerFailure}`}`,
        };
  } finally {
    try {
      await broker?.close();
    } finally {
      await fixture?.close();
    }
  }
}

export async function runRegistryAssembly(
  run: typeof registryScenario = registryScenario,
): Promise<ScenarioResult> {
  const node = await run('node');
  const worker = await run('cloudflare');
  if (node.status === 'FAIL' || worker.status === 'FAIL')
    return { status: 'FAIL', reason: `${node.reason} ${worker.reason}` };
  if (node.status === 'NOT RUN' || worker.status === 'NOT RUN')
    return { status: 'NOT RUN', reason: `${node.reason} ${worker.reason}` };
  const mutation = await run('node', { removeWebhook: true });
  if (mutation.status !== 'FAIL' || mutation.reason !== 'node: signed webhook returned HTTP 404.')
    return {
      status: mutation.status === 'NOT RUN' ? 'NOT RUN' : 'FAIL',
      reason: 'Webhook registration mutation did not fail the Node scenario.',
    };
  return {
    status: 'PASS',
    reason: `${node.reason} ${worker.reason} Removing the Node webhook registration failed the scenario.`,
  };
}
