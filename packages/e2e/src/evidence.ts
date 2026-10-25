import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { LocalUnavailable, reserveLoopbackPort, startLocal, until } from './local.js';
import type { LocalBroker, Runtime } from './local.js';
import type { ScenarioResult } from './runner.js';

export const projects = ['alpha', 'beta'] as const;
export const versions = ['1.0.0', '2.0.0'];
export const truth = projects.flatMap((project) =>
  (['composer', 'npm'] as const).flatMap((ecosystem) =>
    ['one', 'two'].map((suffix) => ({
      project,
      ecosystem,
      name: `${ecosystem === 'npm' ? '@' : ''}${project}/${suffix}`,
    })),
  ),
);
export type Truth = (typeof truth)[number];
export const digest = (bytes: Uint8Array, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');
export const archiveBytes = (name: string, version: string) =>
  new TextEncoder().encode(`isolation archive: ${name} ${version}\n`);
const published = '2026-01-01T00:00:00.000Z';

export function fixtureResponse(url: URL): Response {
  const path = decodeURIComponent(url.pathname);
  const archive = /^\/__upstream\/registry.npmjs.org\/archive\/(.+)\/([^/]+)\.tgz$/.exec(path);
  if (archive) {
    const [, name, version] = archive;
    assert(
      truth.some((item) => item.name === name) && versions.includes(version!),
      'UnknownArchive',
    );
    return new Response(archiveBytes(name!, version!));
  }
  const npmName = path.replace('/__upstream/registry.npmjs.org/', '');
  if (truth.some((item) => item.ecosystem === 'npm' && item.name === npmName)) {
    return Response.json({
      name: npmName,
      description: `truth ${npmName}`,
      'dist-tags': { latest: '2.0.0' },
      versions: Object.fromEntries(
        versions.map((version) => [
          version,
          {
            name: npmName,
            version,
            description: `truth ${npmName}`,
            dist: {
              tarball: `https://registry.npmjs.org/archive/${npmName}/${version}.tgz`,
              integrity: `sha512-${createHash('sha512').update(archiveBytes(npmName, version)).digest('base64')}`,
            },
          },
        ]),
      ),
      time: Object.fromEntries(versions.map((version) => [version, published])),
    });
  }
  return new Response(null, { status: 404 });
}

const webhookSecret = 'isolation-fixture-webhook-secret';
const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const installationId = 123;
const text = new TextEncoder();
const FLUSH = text.encode('0000');
const DELIM = text.encode('0001');
const pkt = (value: string | Uint8Array): Uint8Array => {
  const bytes = typeof value === 'string' ? text.encode(value) : value;
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
};

interface GitObject {
  type: 'commit' | 'tree' | 'blob';
  data: Uint8Array;
  oid: string;
}
const gitObject = (type: GitObject['type'], data: Uint8Array): GitObject => ({
  type,
  data,
  oid: createHash('sha1')
    .update(Buffer.concat([text.encode(`${type} ${data.length}\0`), data]))
    .digest('hex'),
});

function packOf(objects: readonly GitObject[]): Uint8Array {
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const entries = objects.flatMap((object) => {
    const bytes: number[] = [];
    let first = ({ commit: 1, tree: 2, blob: 3 }[object.type] << 4) | (object.data.length & 15);
    for (let rest = Math.floor(object.data.length / 16); rest > 0; rest = Math.floor(rest / 128)) {
      bytes.push(first | 0x80);
      first = rest & 0x7f;
    }
    bytes.push(first);
    return [Buffer.from(bytes), deflateSync(object.data)];
  });
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export const composerRepositories = truth
  .filter((item) => item.ecosystem === 'composer')
  .map((item) => ({ ...item, repository: `isolation/${item.name.replace('/', '-')}` }));

function createRepository(name: string) {
  const objects = new Map<string, GitObject>();
  const add = (object: GitObject) => (objects.set(object.oid, object), object);
  const commits = new Map<string, string>();
  const archives = new Map<string, string>();
  for (const [index, version] of versions.entries()) {
    const when = Date.parse(published) / 1000 + index * 3600;
    const manifest = add(gitObject('blob', text.encode(JSON.stringify({ name }))));
    const tree = add(
      gitObject(
        'tree',
        Buffer.concat([text.encode('100644 composer.json\0'), Buffer.from(manifest.oid, 'hex')]),
      ),
    );
    const commit = add(
      gitObject(
        'commit',
        text.encode(
          `tree ${tree.oid}\nauthor Release <release@isolation.test> ${when} +0000\ncommitter Release <release@isolation.test> ${when} +0000\n\nrelease ${name} ${version}\n`,
        ),
      ),
    );
    commits.set(version, commit.oid);
    archives.set(commit.oid, version);
  }
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
  const headers = { 'content-type': 'application/x-git-upload-pack-result' };
  return {
    versionOf: (sha: string) => archives.get(sha),
    advertisement: () =>
      new Response(
        Buffer.concat([
          pkt('version 2\n'),
          pkt('ls-refs\n'),
          pkt('fetch=filter\n'),
          pkt('object-format=sha1\n'),
          FLUSH,
        ]),
        { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } },
      ),
    uploadPack(body: Uint8Array) {
      const request = lines(body);
      if (request.includes('command=ls-refs'))
        return new Response(
          Buffer.concat([
            ...versions.map((version) => pkt(`${commits.get(version)} refs/tags/${version}\n`)),
            FLUSH,
          ]),
          { headers },
        );
      const filter = request.find((line) => line.startsWith('filter '))?.slice(7);
      const picked = new Map<string, GitObject>();
      for (const want of request.filter((line) => line.startsWith('want ')))
        for (const object of closure(want.slice(5), filter, true)) picked.set(object.oid, object);
      return new Response(
        Buffer.concat([
          pkt('shallow-info\n'),
          DELIM,
          pkt('packfile\n'),
          pkt(Buffer.concat([Uint8Array.of(1), packOf([...picked.values()])])),
          FLUSH,
        ]),
        { headers },
      );
    },
  };
}

const repositories = new Map(
  composerRepositories.map((item) => [
    item.repository,
    { name: item.name, git: createRepository(item.name) },
  ]),
);

export async function githubResponse(request: Request): Promise<Response> {
  const url = new URL(request.url);
  assert(!request.headers.has('cookie'), 'CookieReachedFixture');
  if (url.hostname === 'api.github.com') {
    if (
      request.method === 'POST' &&
      url.pathname === `/app/installations/${installationId}/access_tokens`
    ) {
      assert.match(request.headers.get('authorization') ?? '', /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      const grant = (await request.json()) as { permissions: unknown; repositories: string[] };
      return Response.json(
        {
          token: 'ghs_isolationFixtureInstallationToken',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: grant.permissions,
          repositories: grant.repositories.map((name) => ({ name })),
        },
        { status: 201 },
      );
    }
    const match =
      /^\/repos\/(isolation\/[\w-]+)(?:\/(contents\/composer\.json|zipball\/([0-9a-f]{40})))?$/.exec(
        url.pathname,
      );
    const repository = match && repositories.get(match[1]!);
    if (!match || !repository) return new Response(null, { status: 404 });
    if (match[2] === undefined)
      return Response.json({ archived: false, default_branch: 'main', full_name: match[1] });
    if (match[3] === undefined) return Response.json({ name: repository.name });
    return new Response(null, {
      status: 302,
      headers: { location: `https://codeload.github.com/${match[1]}/legacy.zip/${match[3]}` },
    });
  }
  if (url.hostname === 'github.com') {
    const match = /^\/(isolation\/[\w-]+)\.git\/(info\/refs|git-upload-pack)$/.exec(url.pathname);
    const repository = match && repositories.get(match[1]!);
    if (!match || !repository) return new Response(null, { status: 404 });
    return match[2] === 'info/refs'
      ? repository.git.advertisement()
      : repository.git.uploadPack(new Uint8Array(await request.arrayBuffer()));
  }
  const archive = /^\/(isolation\/[\w-]+)\/legacy\.zip\/([0-9a-f]{40})$/.exec(url.pathname);
  const repository = archive && repositories.get(archive[1]!);
  const version = repository?.git.versionOf(archive![2]!);
  if (url.hostname !== 'codeload.github.com' || !repository || !version)
    return new Response(null, { status: 404 });
  return new Response(archiveBytes(repository.name, version));
}

async function startFixture() {
  let invalid = false;
  let calls = 0;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        assert(!incoming.headers.cookie, 'CookieReachedFixture');
        calls++;
        const target = new URL('https://' + (incoming.url ?? '/').slice('/__upstream/'.length));
        const method = incoming.method ?? 'GET';
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (value !== undefined && name !== 'host') headers.set(name, String(value));
        const response = target.hostname.endsWith('github.com')
          ? await githubResponse(
              new Request(target, {
                method,
                headers,
                ...(method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
              }),
            )
          : (assert.equal(method, 'GET', 'UnexpectedFixtureMethod'),
            fixtureResponse(new URL(incoming.url ?? '/', 'http://127.0.0.1')));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        invalid = true;
        outgoing.writeHead(500);
        outgoing.end('FixtureProtocolFailure');
      }
    })();
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    count: () => calls,
    assertHealthy: () => assert(!invalid, 'FixtureProtocolFailure'),
    close: () =>
      new Promise<void>((accept, reject) => {
        server.close((error) => (error ? reject(error) : accept()));
        server.closeAllConnections();
      }),
  };
}

export function requireStatus(response: Response, ...expected: number[]): Response {
  assert(
    expected.includes(response.status),
    `UnexpectedHttpStatus:${expected.join('|')}:${response.status}`,
  );
  return response;
}

export function failureName(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^[A-Z][A-Za-z]+(?::[\w|-]+)*$/.test(message)) return message;
  return error instanceof Error ? error.name : 'NonError';
}

const FIXTURE_PASSWORD = 'oracle-fixture-password';

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

export async function session(broker: LocalBroker, email = 'admin@example.test') {
  let cookie = '';
  let csrf = '';
  const request = async (
    path: string,
    body?: unknown,
    method = 'POST',
    extraHeaders: Record<string, string> = {},
  ) => {
    const response = await fetch(broker.origin + path, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: broker.origin,
        cookie,
        'x-csrf-token': csrf,
        ...extraHeaders,
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
  const started = requireStatus(
    await request('/_pb/auth/local/setup/start', { token: broker.setupToken }),
    200,
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
  requireStatus(
    await request('/_pb/auth/local/setup/finish', {
      token: broker.setupToken,
      password: FIXTURE_PASSWORD,
      code: await nextCode(),
    }),
    204,
  );
  requireStatus(
    await request('/_pb/auth/local/login', {
      email,
      password: FIXTURE_PASSWORD,
      code: await nextCode(),
    }),
    204,
  );
  requireStatus(
    await request('/_pb/auth/local/reauth', { password: FIXTURE_PASSWORD, code: await nextCode() }),
    204,
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

export interface SecurityContext {
  broker: LocalBroker;
  admin: Awaited<ReturnType<typeof session>>;
  orgId: string;
  secrets: string[];
  captured: string[];
  fixture: Awaited<ReturnType<typeof startFixture>>;
  get(path: string, token: string, headers?: Record<string, string>): Promise<Response>;
  check(label: string, run: () => Promise<void>): Promise<void>;
  notRun(label: string, reason: string): void;
  deadline: number;
}

export const scenarioDeadlineMs = 240_000;

export async function securityScenario(
  runtime: Runtime,
  label: string,
  run: (context: SecurityContext) => Promise<void>,
): Promise<ScenarioResult> {
  let broker: LocalBroker | undefined;
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
  let stage = 'startup';
  const failures: string[] = [];
  const skipped: string[] = [];
  const deadline = Date.now() + scenarioDeadlineMs;
  const notRunSuffix = () => (skipped.length ? ` NOT RUN: ${skipped.join(', ')}.` : '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await reserveLoopbackPort();
    fixture = await startFixture();
    broker = await startLocal(runtime, fixture.origin, { reader: true });
    stage = 'admin-session';
    const admin = await session(broker);
    const org = requireStatus(await admin.request('/_pb/organization', undefined, 'GET'), 200);
    const { id: orgId } = (await org.json()) as { id: string };
    const captured: string[] = [];
    const secrets = [
      broker.setupToken,
      broker.readerSetupToken ?? '',
      'admin@example.test',
      'reader@example.test',
      FIXTURE_PASSWORD,
      'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      ...admin.secrets(),
    ];
    const local = broker;
    stage = label;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('ScenarioDeadline')),
        Math.max(0, deadline - Date.now()),
      );
    });
    const running = run({
      broker,
      admin,
      orgId,
      secrets,
      captured,
      fixture,
      async get(path, token, headers = {}) {
        const response = await fetch(local.origin + path, {
          headers: { authorization: `Bearer ${token}`, ...headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        captured.push(JSON.stringify([...response.headers]), await response.clone().text());
        return response;
      },
      async check(name, check) {
        try {
          await check();
        } catch (error) {
          failures.push(`${name} (${failureName(error)})`);
        }
      },
      notRun(name, reason) {
        skipped.push(`${name} (${reason})`);
      },
      deadline,
    });
    running.catch(() => undefined);
    await Promise.race([running, expired]);
    clearTimeout(timer);
    stage = 'module-and-leak-evidence';
    await broker.moduleEvidence();
    fixture.assertHealthy();
    const output = [broker.logs(), ...captured, ...failures, ...skipped].join('\n');
    for (const secret of secrets)
      assert(!secret || !output.includes(secret), 'SensitiveDataInOutput');
    if (failures.length)
      return {
        status: 'FAIL',
        reason: `${runtime}: ${label}: ${failures.join(', ')}.${notRunSuffix()}`,
      };
    if (skipped.length)
      return {
        status: 'NOT RUN',
        reason: `${runtime}: ${label}: other oracles passed; NOT RUN: ${skipped.join(', ')}.`,
      };
    return { status: 'PASS', reason: `${runtime}: ${label}: all oracles executed.` };
  } catch (error) {
    return error instanceof LocalUnavailable
      ? { status: 'NOT RUN', reason: `${runtime}: ${error.message}` }
      : {
          status: 'FAIL',
          reason: `${runtime}: ${label} failed at ${stage} (${failureName(error)}).${failures.length ? ` ${failures.join(', ')}.` : ''}${notRunSuffix()}`,
        };
  } finally {
    clearTimeout(timer);
    try {
      await broker?.close();
    } finally {
      await fixture?.close();
    }
  }
}

export async function seedTruth(context: SecurityContext) {
  const { admin, broker, get, orgId, secrets } = context;
  const credentials = new Map<
    string,
    { id: string; token: string; projectId: string; sources: Record<string, string> }
  >();
  const projectIds = new Map<string, string>();
  for (const project of projects) {
    const created = requireStatus(
      await admin.request('/_pb/projects', { slug: project, name: project }),
      201,
    );
    projectIds.set(project, ((await created.json()) as { id: string }).id);
  }
  for (const project of projects) {
    const projectId = projectIds.get(project)!;
    const sources: Record<string, string> = {};
    const attach = async (
      key: string,
      precedence: number,
      source: Record<string, unknown>,
      patterns: readonly string[],
      credential?: Record<string, unknown>,
    ) => {
      const response = requireStatus(await admin.request('/_pb/sources', source), 201);
      const { id } = (await response.json()) as { id: string };
      sources[key] = id;
      requireStatus(
        await admin.request(
          `/_pb/projects/${project}/sources/${id}/attachment`,
          { precedence },
          'PUT',
        ),
        204,
      );
      if (credential)
        requireStatus(await admin.request(`/_pb/sources/${id}/credential`, credential, 'PUT'), 204);
      for (const pattern of patterns)
        requireStatus(await admin.request(`/_pb/sources/${id}/names`, { pattern }), 201);
      requireStatus(await admin.request(`/_pb/sources/${id}/enable`), 204);
      return id;
    };
    await attach(
      'npm',
      1,
      {
        name: `${project}-npm`,
        ecosystem: 'npm',
        type: 'npm_registry',
        url: 'https://registry.npmjs.org',
        config: { scopes: [`@${project}`] },
      },
      [`@${project}/*`],
    );
    for (const item of composerRepositories.filter((entry) => entry.project === project)) {
      const id = await attach(
        item.name,
        0,
        {
          name: `${project}-composer-${item.name.split('/')[1]}`,
          ecosystem: 'composer',
          type: 'vcs',
          url: null,
          config: {
            provider: 'github',
            repository: item.repository,
            installationId,
            packageName: item.name,
            refs: { tags: true, branches: [] },
          },
        },
        [item.name],
        {
          kind: 'github_app',
          material: JSON.stringify({ appId: '42', privateKeyPem: privateKey, webhookSecret }),
        },
      );
      const [row] = await broker.read<{ credential_id: string }>(
        // eslint-disable-next-line no-restricted-syntax -- Scoped infrastructure observation; seeding uses session APIs.
        'SELECT credential_id FROM source WHERE org_id = ? AND id = ?',
        [orgId, id],
      );
      assert(row, 'SourceCredentialMissing');
      const body = JSON.stringify({
        ref: 'refs/tags/1.0.0',
        installation: { id: installationId },
        repository: { full_name: item.repository },
      });
      const webhook = await fetch(`${broker.origin}/_pb/hooks/github/${row.credential_id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': randomBytes(16).toString('hex'),
          'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      requireStatus(webhook, 202);
    }
    const issued = requireStatus(
      await admin.request('/_pb/me/tokens', {
        name: `${project}-reader`,
        scope: 'read',
        readOnly: true,
        projectMode: 'selected',
        projectIds: [projectId],
      }),
      201,
    );
    const credential = (await issued.json()) as { id: string; token: string };
    secrets.push(credential.token);
    credentials.set(project, { ...credential, projectId, sources });
    for (const item of truth.filter((item) => item.project === project)) {
      await until(async () => {
        const response = await get(
          item.ecosystem === 'composer'
            ? `/${project}/p2/${item.name}.json`
            : `/${project}/npm/${encodeURIComponent(item.name)}`,
          credential.token,
        );
        if (response.status !== 200) return false;
        const body = (await response.json()) as {
          packages?: Record<string, unknown[]>;
          versions?: Record<string, unknown>;
        };
        return (
          (body.packages?.[item.name] ?? Object.keys(body.versions ?? {})).length ===
          versions.length
        );
      }, 'truth-ingestion');
    }
  }
  return credentials;
}

const comparedHeaders = ['etag', 'cache-control', 'vary', 'content-type', 'content-length'];

export async function errorShape(response: Response) {
  requireStatus(response, 404);
  const headers = Object.fromEntries(
    comparedHeaders.map((name) => [name, response.headers.get(name)]),
  );
  const body = (await response.json()) as Record<string, unknown>;
  const requestId = (value: unknown) => {
    assert.equal(typeof value, 'string');
    assert((value as string).length > 0, 'MissingRequestId');
  };
  if (typeof body['error'] === 'string') {
    assert.deepEqual(Object.keys(body).sort(), ['code', 'error', 'requestId']);
    assert.equal(body['code'], 'not_found');
    assert(body['error'].length > 0, 'MissingErrorMessage');
    requestId(body['requestId']);
    return { code: body['code'], message: body['error'], headers };
  }
  assert.deepEqual(Object.keys(body), ['error']);
  const error = body['error'] as { code: string; message: string; requestId: string };
  assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'requestId']);
  assert.equal(error.code, 'not_found');
  assert.equal(typeof error.message, 'string');
  assert(error.message.length > 0, 'MissingErrorMessage');
  requestId(error.requestId);
  return { code: error.code, message: error.message, headers };
}
