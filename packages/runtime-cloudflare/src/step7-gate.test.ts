import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '@package-broker/core/auth/password';
import { newSessionSecrets } from '@package-broker/core/auth/session';
import { orgContext, type SqlExecutor, type SqlValue } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { DELIM, FLUSH, encodePkt } from '@package-broker/core/sources/git/pkt-line';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createKeyringVerifierStore } from '@package-broker/db-sqlite/repositories/keyring-verifier';
import { verifyKeyring } from '@package-broker/core/secrets/keyring-verifier';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import type { R2BucketLike } from './blob/r2.js';
import { createWorker, type Env } from './index.js';

const githubModule = '@package-broker/plugin-github';
const { default: github } = (await import(githubModule)) as { default: () => PluginDefinition };
const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ORIGIN = 'https://broker.test';
const SECRET = 'step7-fixture-webhook-secret';
const PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const INSTALLATION_TOKEN = 'ghs_step7FixtureInstallationToken';
const PASSWORD = 'step7-fixture-password';
const ZIP = new Uint8Array([0x50, 0x4b, 3, 4, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
const TGZ = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const PUBLISHED = '2026-01-01T00:00:00.000Z';
const keyring = () => createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);
const hash = (bytes: Uint8Array, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.unstubAllGlobals();
  }
});

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

function upstream() {
  const state = { versions: ['1.0.0'], corrupt: false };
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
  const transport: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(url.origin + url.pathname);
    expect([
      'https://api.github.com',
      'https://github.com',
      'https://codeload.github.com',
      'https://repo.packagist.org',
      'https://registry.npmjs.org',
    ]).toContain(url.origin);
    expect(request.headers.get('user-agent')).toBeTruthy();
    if (url.hostname === 'api.github.com') {
      if (url.pathname === '/app/installations/123/access_tokens') {
        expect(request.method).toBe('POST');
        expect(request.headers.get('authorization')).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
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
      expect(request.headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
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
      expect(request.headers.get('authorization')).toBe(
        `Basic ${btoa(`x-access-token:${INSTALLATION_TOKEN}`)}`,
      );
      if (url.pathname === '/acme/mirror.git/info/refs') return git.advertisement();
      expect(url.pathname).toBe('/acme/mirror.git/git-upload-pack');
      for (const version of state.versions)
        if (!commits.has(version)) commits.set(version, git.tag(version));
      return git.uploadPack(
        new Uint8Array(await request.arrayBuffer()),
        new Map(state.versions.map((version) => [`refs/tags/${version}`, commits.get(version)!])),
      );
    }
    if (url.hostname === 'codeload.github.com') {
      return new Response(state.corrupt ? ZIP.map((byte) => byte ^ 0xff) : ZIP);
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
  return { state, calls, transport, plugin: github() };
}

async function seed(executor: SqlExecutor) {
  const org = orgContext(ulid());
  const sql = (statement: string, params: SqlValue[] = []) =>
    executor.batch([{ sql: statement, params }]);
  await createOrganizationBootstrap(executor).bootstrap({
    id: org.orgId,
    slug: 'acme',
    name: 'Acme',
    now: new Date().toISOString(),
  });
  const project = ulid();
  const user = ulid();
  const role = ulid();
  const totp = ulid();
  const secrets = await newSessionSecrets();
  const now = new Date().toISOString();
  await sql('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
    user,
    org.orgId,
    'reader@example.test',
  ]);
  await sql(
    "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', ?, zeroblob(12), 1, 'fixture')",
    [totp, org.orgId, new Uint8Array([1])],
  );
  await sql(
    'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
    [user, org.orgId, await hashPassword(PASSWORD, keyring()), totp, now, now],
  );
  await sql(
    "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'fixture', 'Fixture', 'organization', 1)",
    [role, org.orgId],
  );
  await sql('INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)', [
    org.orgId,
    role,
    'project:packages:read',
  ]);
  await sql(
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', ?)",
    [ulid(), org.orgId, 'reader@example.test', role],
  );
  await sql(
    'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      ulid(),
      org.orgId,
      user,
      secrets.secretHash,
      secrets.csrfHash,
      new Date(Date.now() + 3600000).toISOString(),
    ],
  );
  await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'alpha', 'Alpha')", [
    project,
    org.orgId,
  ]);
  await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'beta', 'Beta')", [
    ulid(),
    org.orgId,
  ]);
  const credential = await createCredentialStore({
    repository: createCredentialRepository(executor),
    cipher: createSecretCipher(keyring(), 'credential-encryption'),
    ids: { ulid },
    clock: systemClock,
  }).put(org, {
    kind: 'github_app',
    projectId: null,
    plaintext: new TextEncoder().encode(
      JSON.stringify({ appId: '42', privateKeyPem: PRIVATE_KEY, webhookSecret: SECRET }),
    ),
  });
  const source = ulid();
  await seedSources(sql, org.orgId, project, source, credential);
  return {
    org,
    source,
    credential,
    session: secrets.secret,
    csrf: secrets.csrf,
    cookie: `__Host-pb_session=${secrets.secret}; __Host-pb_csrf=${secrets.csrf}`,
  };
}

async function seedSources(
  sql: (statement: string, params: SqlValue[]) => Promise<unknown>,
  orgId: string,
  project: string,
  mirror: string,
  credential: string,
) {
  await sql(
    "INSERT INTO source (id, org_id, name, ecosystem, type, config_json, credential_id) VALUES (?, ?, 'mirror', 'composer', 'vcs', ?, ?)",
    [
      mirror,
      orgId,
      JSON.stringify({
        provider: 'github',
        repository: 'acme/mirror',
        installationId: 123,
        refs: { tags: true, branches: [] },
      }),
      credential,
    ],
  );
  await sql(
    "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'acme/mirror')",
    [ulid(), orgId, mirror],
  );
  for (const [id, name, ecosystem, type, url] of [
    [mirror, 'mirror', 'composer', 'vcs', null],
    [ulid(), 'packagist', 'composer', 'packagist_proxy', 'https://repo.packagist.org'],
    [ulid(), 'npmjs', 'npm', 'npmjs_proxy', 'https://registry.npmjs.org'],
  ] as const) {
    if (id !== mirror)
      await sql(
        'INSERT INTO source (id, org_id, name, ecosystem, type, url) VALUES (?, ?, ?, ?, ?, ?)',
        [id, orgId, name, ecosystem, type, url],
      );
    await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
      orgId,
      project,
      id,
    ]);
  }
}

class DigestStreamShim extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = createHash(algorithm.replace('-', '').toLowerCase());
    let settle!: (value: ArrayBuffer) => void;
    const digest = new Promise<ArrayBuffer>((resolve) => {
      settle = resolve;
    });
    super({
      write(chunk) {
        hash.update(chunk);
      },
      close() {
        const out = hash.digest();
        settle(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
      },
    });
    this.digest = digest;
  }
}

class FixedLengthStreamShim {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  constructor() {
    const identity = new TransformStream<Uint8Array, Uint8Array>();
    this.readable = identity.readable;
    this.writable = identity.writable;
  }
}

async function boot(remote: ReturnType<typeof upstream>) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['DB'],
      r2Buckets: ['STORAGE'],
    }),
  );
  cleanup.push(() => mf.dispose());
  const binding = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
  const r2 = (await mf.getR2Bucket('STORAGE')) as unknown as R2BucketLike;
  // The Node-side proxy of the R2 binding refuses a stream without a known length, which only
  // workerd's FixedLengthStream provides; buffer streamed puts before they cross the proxy.
  const bucket: R2BucketLike = {
    put: async (key, value, options) =>
      r2.put(
        key,
        value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value,
        options,
      ),
    get: (key, options) => r2.get(key, options),
    head: (key) => r2.head(key),
    delete: (keys) => r2.delete(keys),
  };
  const executor = createD1Executor(binding);
  await migrate(executor, await discoveredMigrations(), { holder: 'step7-gate' });
  await verifyKeyring(keyring(), createKeyringVerifierStore(executor));
  const fixture = await seed(executor);
  Object.defineProperty(crypto, 'DigestStream', { configurable: true, value: DigestStreamShim });
  cleanup.push(async () => {
    Reflect.deleteProperty(crypto, 'DigestStream');
  });
  vi.stubGlobal('FixedLengthStream', FixedLengthStreamShim);
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', ((input, init) => {
    const url = new URL(new Request(input, init).url);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return realFetch(input, init);
    return remote.transport(input, init);
  }) satisfies FetchLike);
  const logged: unknown[] = [];
  const notifications: unknown[] = [];
  const env: Env = {
    DB: binding,
    STORAGE: bucket,
    JOBS: {
      send: async (body) => {
        notifications.push(body);
      },
      sendBatch: async (batch) => {
        notifications.push(...batch.map(({ body }) => body));
      },
    },
    PB_MASTER_KEY: KEY,
    PB_PUBLIC_URL: ORIGIN,
    DEPLOYMENT_ID: 'step7-gate',
  };
  const worker = createWorker([remote.plugin], {
    platformPorts: {
      blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1048576 },
      cache: { adapter: 'cache-api', namespace: 'step7-gate' },
      jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 1 },
      observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
    },
    cacheStorage: {
      open: async () => ({
        match: async () => undefined,
        put: async () => undefined,
        delete: async () => false,
      }),
    },
    log: (record) => void logged.push(record),
    console: {
      log: (record) => void logged.push(record),
      error: (record) => void logged.push(record),
    },
  });
  const waited: Promise<unknown>[] = [];
  const context = { waitUntil: (work: Promise<unknown>) => void waited.push(work) };
  const flush = async () => {
    while (waited.length > 0) await Promise.all(waited.splice(0));
  };
  cleanup.push(flush);
  return {
    ...fixture,
    executor,
    logged,
    lose: (key: string) => bucket.delete(key),
    async fetch(request: Request) {
      const response = await worker.fetch(request, env, context);
      await flush();
      return response;
    },
    async drain() {
      await flush();
      while (notifications.length > 0) {
        const ack = vi.fn();
        const retry = vi.fn();
        await worker.queue(
          { messages: [{ body: notifications.shift(), ack, retry }] },
          env,
          context,
        );
        await flush();
        expect(ack).toHaveBeenCalledOnce();
        expect(retry).not.toHaveBeenCalled();
      }
    },
  };
}

describe('step 7 registry release gate', () => {
  it('mirrored Composer, proxied Composer, proxied npm, webhook sync and re-mirror after blob loss', async () => {
    const remote = upstream();
    const fixture = await boot(remote);
    const { executor, drain, lose, logged, org, source, credential, cookie } = fixture;
    const responses: string[] = [];
    const send = async (request: Request) => {
      const response = await fixture.fetch(request);
      responses.push(JSON.stringify([...response.headers]), await response.clone().text());
      return response;
    };
    const rows = <T extends object>(sql: string, params: SqlValue[] = []) =>
      executor.all<T>({ sql, params: [org.orgId, ...params] });
    const jobs = () =>
      rows<{ id: string; state: string; payload_json: string }>(
        "SELECT id, state, payload_json FROM job WHERE org_id = ? AND type = 'core:source-sync:v1' ORDER BY id",
      );
    const get = (path: string, authenticated = true) =>
      send(new Request(`${ORIGIN}${path}`, { headers: authenticated ? { cookie } : {} }));
    const hook = (ref: string, valid = true) => {
      const body = JSON.stringify({
        ref,
        installation: { id: 123 },
        repository: { full_name: 'acme/mirror' },
      });
      return send(
        new Request(`${ORIGIN}/_pb/hooks/github/${credential}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'push',
            'x-hub-signature-256': `sha256=${createHmac('sha256', valid ? SECRET : 'invalid')
              .update(body)
              .digest('hex')}`,
          },
          body,
        }),
      );
    };
    expect((await get('/alpha/packages.json', false)).status).toBe(401);
    expect((await hook('refs/tags/1.0.0', false)).status).toBe(404);
    expect(await jobs()).toEqual([]);
    expect((await hook('refs/tags/1.0.0')).status).toBe(202);
    expect((await hook('refs/tags/1.0.0')).status).toBe(202);
    expect(await jobs()).toHaveLength(1);
    await drain();
    const synced = await jobs();
    expect(
      synced.map(({ state, payload_json }) => ({
        state,
        payload: JSON.parse(payload_json) as unknown,
      })),
    ).toEqual([{ state: 'succeeded', payload: { sourceId: source, reason: 'webhook' } }]);

    const composer = async (name: string, wanted = '1.0.0') => {
      const metadata = await get(`/alpha/p2/${name}.json`);
      expect(metadata.status).toBe(200);
      const body = (await metadata.json()) as {
        packages: Record<string, { version: string; dist: { url: string } }[]>;
      };
      const versions = body.packages[name]!;
      const version = versions.find((each) => each.version === wanted)!;
      expect(version).toBeDefined();
      const url = new URL(version.dist.url);
      expect(url.origin).toBe(ORIGIN);
      const archive = await get(url.pathname);
      expect(archive.status).toBe(200);
      expect(new Uint8Array(await archive.arrayBuffer())).toEqual(ZIP);
      return { path: url.pathname, versions: versions.map((each) => each.version).sort() };
    };
    expect((await composer('acme/mirror')).versions).toEqual(['1.0.0']);
    expect(remote.calls).toEqual(
      expect.arrayContaining([
        'https://api.github.com/app/installations/123/access_tokens',
        'https://api.github.com/repos/acme/mirror/contents/composer.json',
        'https://api.github.com/repos/acme/mirror',
        'https://github.com/acme/mirror.git/info/refs',
        'https://github.com/acme/mirror.git/git-upload-pack',
        expect.stringMatching(
          /^https:\/\/api\.github\.com\/repos\/acme\/mirror\/zipball\/[0-9a-f]{40}$/,
        ),
        expect.stringMatching(
          /^https:\/\/codeload\.github\.com\/acme\/mirror\/legacy\.zip\/[0-9a-f]{40}$/,
        ),
      ]),
    );
    const proxy = await composer('acme/proxy');
    const packument = await get('/alpha/npm/widget');
    expect(packument.status).toBe(200);
    const npm = (await packument.json()) as {
      versions: Record<string, { dist: { tarball: string; integrity: string } }>;
    };
    const dist = npm.versions['1.0.0']!.dist;
    expect(new URL(dist.tarball).origin).toBe(ORIGIN);
    expect(dist.integrity).toBe(`sha512-${createHash('sha512').update(TGZ).digest('base64')}`);
    const tarball = await get(new URL(dist.tarball).pathname);
    expect(tarball.status).toBe(200);
    expect(new Uint8Array(await tarball.arrayBuffer())).toEqual(TGZ);
    const beforeDenied = remote.calls.length;
    for (const path of [
      proxy.path.replace('/alpha/', '/beta/'),
      proxy.path.replace(/\.1\.zip$/, '.99.zip'),
      proxy.path.replace('acme/proxy', 'acme/other'),
    ]) {
      expect((await get(path)).status).toBe(404);
    }
    expect(remote.calls).toHaveLength(beforeDenied);

    const blob = (
      await rows<{ storage_key: string }>(
        'SELECT storage_key FROM blob WHERE org_id = ? AND sha256 = ?',
        [hash(ZIP)],
      )
    )[0]!;
    expect(blob.storage_key).toBeTruthy();
    await lose(blob.storage_key);
    const beforeRemirror = remote.calls.filter((url) =>
      url.includes('/acme/proxy/legacy.zip/'),
    ).length;
    const restored = await get(proxy.path);
    expect(restored.status).toBe(200);
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(ZIP);
    expect(remote.calls.filter((url) => url.includes('/acme/proxy/legacy.zip/'))).toHaveLength(
      beforeRemirror + 2,
    );

    remote.state.versions = ['2.0.0', '1.0.0'];
    expect((await hook('refs/tags/2.0.0')).status).toBe(202);
    await drain();
    expect(await jobs()).toHaveLength(2);
    expect((await jobs()).every((job) => job.state === 'succeeded')).toBe(true);
    expect((await composer('acme/mirror', '2.0.0')).versions).toEqual(['1.0.0', '2.0.0']);
    await lose(blob.storage_key);
    remote.state.corrupt = true;
    expect((await get(proxy.path)).status).toBe(502);
    expect(
      await rows(
        'SELECT v.status FROM version v JOIN package p ON p.org_id = v.org_id AND p.id = v.package_id WHERE v.org_id = ? AND p.name = ?',
        ['acme/proxy'],
      ),
    ).toEqual([{ status: 'quarantined' }]);
    expect((await get(proxy.path)).status).toBe(404);
    expect(logged.length).toBeGreaterThan(0);
    const output = [JSON.stringify(logged), ...responses].join('\n');
    for (const [label, value] of Object.entries({
      'private key': PRIVATE_KEY,
      'private key, JSON-escaped': JSON.stringify(PRIVATE_KEY).slice(1, -1),
      'private key, first base64 line': PRIVATE_KEY.split('\n')[1]!,
      'webhook secret': SECRET,
      'session token': fixture.session,
      'CSRF token': fixture.csrf,
      'master key': KEY,
      'installation token': INSTALLATION_TOKEN,
      'local password': PASSWORD,
      'account e-mail': 'reader@example.test',
    }))
      expect(output.includes(value), label).toBe(false);
  });
});
