import { createLocalLoginSeed } from './testing/local-login.js';
import { execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newSessionSecrets } from '@package-broker/core/auth/session';
import { type SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import { resolveRegistryConfig } from '@package-broker/core/registry/registry-config';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { openFilesystemByteStore } from './blob/filesystem.js';
import { createLruCache } from './cache/lru.js';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import { type NodeBroker } from './index.js';
import { createNodeServerWithSeams } from './testing/node-server.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const NAME = 'acme/widget';
const NPM_NAME = 'acme-widget';
const VERSION = '1.0.0';

function tar(path: string, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function npmTarball(): Buffer {
  const manifest = JSON.stringify({ name: NPM_NAME, version: VERSION, main: 'index.js' });
  return gzipSync(
    Buffer.concat([
      tar('package/package.json', manifest),
      tar('package/index.js', 'module.exports = 1;\n'),
      Buffer.alloc(1024),
    ]),
  );
}

function zipArchive(): Buffer {
  const files = [
    ['widget-1.0.0/composer.json', JSON.stringify({ name: NAME, version: VERSION })],
    ['widget-1.0.0/src.php', '<?php\n'],
  ] as const;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function flipped(body: Buffer): Buffer {
  const copy = Buffer.from(body);
  const middle = Math.floor(copy.length / 2);
  copy[middle] = (copy[middle] ?? 0) ^ 0xff;
  return copy;
}

const TGZ = npmTarball();
const ZIP = zipArchive();
const sha1 = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex');
const sri = (bytes: Buffer): string =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

interface Fake {
  readonly server: Server;
  readonly port: number;
  readonly requests: string[];
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  host = '127.0.0.1',
): Promise<Fake> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? ''}`);
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

function send(response: ServerResponse, body: string | Buffer, type: string): void {
  response.writeHead(200, { 'content-type': type, etag: `"${sha1(Buffer.from(body))}"` });
  response.end(body);
}

interface Run {
  readonly code: number;
  readonly output: string;
}

const CHILD_TIMEOUT_MS = 40_000;
const TEST_TIMEOUT_MS = 90_000;
const children = new Set<ChildProcess>();

function killChildren(): void {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
}

const flat = (text: string): string => text.replace(/\s+/g, '');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: env['HOME'] ?? cwd,
          TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
          HTTPS_PROXY: 'http://127.0.0.1:9',
          ...env,
        },
        timeout: CHILD_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        children.delete(child);
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
    children.add(child);
  });
}

async function available(command: string, args: readonly string[]): Promise<string | null> {
  const home = await mkdtemp(join(tmpdir(), 'pb-registry-clients-probe-'));
  try {
    const probe = await run(command, args, home, { HOME: home });
    return probe.code === 0 ? null : probe.output.slice(0, 200);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('registry clients against the Node runtime', { timeout: TEST_TIMEOUT_MS }, () => {
  let db: MigratedDatabase;
  let directory: string;
  let broker: NodeBroker | undefined;
  let packagist: Fake;
  let npmjs: Fake;
  let front: Server;
  let proxyUrl: string;
  const origin = 'http://broker.test';
  let cookie: string;
  let blocked: string[];
  let tamper: ((path: string, body: Buffer) => Buffer) | undefined;
  let packagistShasum: string;
  let npmIntegrity: string;

  async function sql(statement: string, params: readonly SqlValue[] = []): Promise<void> {
    await db.executor.all({ sql: statement, params: [...params] });
  }

  beforeAll(async () => {
    for (const client of ['composer', 'npm'] as const) {
      const reason = await available(client, ['--version']);
      if (reason !== null) throw new Error(`${client} is required and cannot run: ${reason}`);
    }
  });

  beforeEach(async () => {
    tamper = undefined;
    blocked = [];
    packagistShasum = sha1(ZIP);
    npmIntegrity = sri(TGZ);
    directory = await realpath(await mkdtemp(join(tmpdir(), 'pb-registry-clients-')));

    packagist = await listen((request, response) => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      if (path === '/p2/acme/widget.json') {
        send(
          response,
          JSON.stringify({
            minified: 'composer/2.0',
            packages: {
              [NAME]: [
                {
                  name: NAME,
                  version: VERSION,
                  version_normalized: '1.0.0.0',
                  type: 'library',
                  time: '2026-01-01T00:00:00+00:00',
                  dist: {
                    type: 'zip',
                    url: 'https://api.github.com/repos/acme/widget/zipball/abc123',
                    reference: 'abc123',
                    shasum: packagistShasum,
                  },
                },
              ],
            },
          }),
          'application/json',
        );
      } else if (path.endsWith('~dev.json')) {
        send(
          response,
          JSON.stringify({ minified: 'composer/2.0', packages: { [NAME]: [] } }),
          'application/json',
        );
      } else if (path.endsWith('/zipball/abc123') || path.includes('/legacy.zip')) {
        send(response, ZIP, 'application/zip');
      } else {
        response.writeHead(404).end('{}');
      }
    });

    npmjs = await listen((request, response) => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      if (path === `/${NPM_NAME}`) {
        send(
          response,
          JSON.stringify({
            name: NPM_NAME,
            'dist-tags': { latest: VERSION },
            versions: {
              [VERSION]: {
                name: NPM_NAME,
                version: VERSION,
                dist: {
                  tarball: `https://registry.npmjs.org/${NPM_NAME}/-/${NPM_NAME}-${VERSION}.tgz`,
                  integrity: npmIntegrity,
                  shasum: sha1(TGZ),
                },
              },
            },
            time: { [VERSION]: '2026-01-01T00:00:00.000Z' },
          }),
          'application/json',
        );
      } else if (path === `/${NPM_NAME}/-/${NPM_NAME}-${VERSION}.tgz`) {
        send(response, TGZ, 'application/octet-stream');
      } else {
        response.writeHead(404).end('{}');
      }
    });

    db = await openMigratedDatabase();
    const org = await createOrganizationBootstrap(db.executor).bootstrap({
      id: ulid(),
      slug: 'acme',
      name: 'Acme',
      now: new Date().toISOString(),
    });
    const projectId = ulid();
    const userId = ulid();
    const roleId = ulid();
    const credentialId = ulid();
    const secrets = await newSessionSecrets();
    cookie = `__Host-pb_session=${secrets.secret}; __Host-pb_csrf=${secrets.csrf}`;
    await sql('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
      userId,
      org.id,
      'reader@example.test',
    ]);
    const { sealed, aad, passwordHash } = await createLocalLoginSeed(
      db.executor,
      createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
      { orgId: org.id, userId, credentialId },
    );
    await sql(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', ?, ?, ?, ?)",
      [credentialId, org.id, sealed.ciphertext, sealed.nonce, sealed.keyVersion, aad],
    );
    await sql(
      'INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        userId,
        org.id,
        passwordHash,
        credentialId,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    await sql(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES (?, ?, 'fixture', 'Fixture', 'organization', 1)",
      [roleId, org.id],
    );
    await sql('INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)', [
      org.id,
      roleId,
      'project:packages:read',
    ]);
    await sql(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', ?)",
      [ulid(), org.id, 'reader@example.test', roleId],
    );
    await sql(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        ulid(),
        org.id,
        userId,
        secrets.secretHash,
        secrets.csrfHash,
        new Date(Date.now() + 3_600_000).toISOString(),
      ],
    );
    await sql("INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'alpha', 'Alpha')", [
      projectId,
      org.id,
    ]);
    const sources: readonly [string, string, string, string][] = [
      ['npmjs', 'npm', 'npmjs_proxy', 'https://registry.npmjs.org'],
      ['packagist', 'composer', 'packagist_proxy', 'https://repo.packagist.org'],
    ];
    for (const [name, ecosystem, type, url] of sources) {
      const sourceId = ulid();
      await sql(
        'INSERT INTO source (id, org_id, name, ecosystem, type, url, default_visible_to_new_projects) VALUES (?, ?, ?, ?, ?, ?, 1)',
        [sourceId, org.id, name, ecosystem, type, url],
      );
      await sql('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
        org.id,
        projectId,
        sourceId,
      ]);
    }

    front = createServer((incoming, outgoing) => {
      const target = new URL(incoming.url ?? '/', origin);
      if (target.origin !== origin) {
        blocked.push(target.origin);
        outgoing.writeHead(502).end();
        return;
      }
      const fail = (): void => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      };
      incoming.on('error', fail);
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: (broker!.server.address() as AddressInfo).port,
          method: incoming.method,
          path: target.pathname + target.search,
          headers: { ...incoming.headers, host: 'broker.test', cookie },
        },
        (reply) => {
          const chunks: Buffer[] = [];
          reply.on('data', (chunk: Buffer) => chunks.push(chunk));
          reply.on('end', () => {
            const path = target.pathname;
            const raw = Buffer.concat(chunks);
            const body = reply.statusCode === 200 && tamper ? tamper(path, raw) : raw;
            const headers = { ...reply.headers };
            delete headers['content-length'];
            delete headers['transfer-encoding'];
            outgoing.writeHead(reply.statusCode ?? 502, {
              ...headers,
              'content-length': body.length,
            });
            outgoing.end(body);
          });
        },
      );
      upstream.on('error', fail);
      incoming.pipe(upstream);
    });
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    proxyUrl = `http://127.0.0.1:${String((front.address() as AddressInfo).port)}`;

    const hosts = new Map<string, Fake>([
      ['repo.packagist.org', packagist],
      ['api.github.com', packagist],
      ['codeload.github.com', packagist],
      ['registry.npmjs.org', npmjs],
    ]);
    const transport: FetchLike = (input, init) => {
      const outbound = new Request(input, init);
      const url = new URL(outbound.url);
      const fake = url.protocol === 'https:' ? hosts.get(url.hostname) : undefined;
      if (fake === undefined) {
        blocked.push(url.origin);
        return Promise.resolve(new Response('{}', { status: 502 }));
      }
      return fetch(`http://127.0.0.1:${String(fake.port)}${url.pathname}${url.search}`, {
        method: outbound.method,
        headers: outbound.headers,
        signal: outbound.signal,
        redirect: 'manual',
      }).then((reply) => {
        if (reply.status < 300 || reply.status > 399) return reply;
        blocked.push(`redirect ${url.origin}`);
        return new Response('{}', { status: 502 });
      });
    };

    const byteStore = await openFilesystemByteStore({ root: join(directory, 'blobs') });
    broker = createNodeServerWithSeams(
      [],
      {
        executor: db.executor,
        auth: {
          keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
          publicOrigin: origin,
          env: {},
        },
        platformServices: {
          blob: createBlobStore(
            byteStore,
            createBlobRepository(db.executor, { purgeLeaseSeconds: 900 }),
            { admission: createBlobUploadAdmission(), maxBytes: 1_048_576 },
          ),
          cache: createLruCache({}),
          jobStore: createJobRepository(db.executor),
        },
        registry: { config: resolveRegistryConfig(undefined, 'node', origin) },
        log: () => undefined,
      },
      { transport },
    );
    await broker.ready();
    await new Promise<void>((resolve) => broker!.server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    killChildren();
    try {
      await broker?.close();
      broker = undefined;
      await close(front);
      await close(packagist.server);
      await close(npmjs.server);
      await db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(blocked).toEqual([]);
  });

  function sandbox(name: string): { project: string; env: Record<string, string> } {
    const root = join(directory, name);
    return {
      project: join(root, 'project'),
      env: {
        HOME: join(root, 'home'),
        COMPOSER_HOME: join(root, 'composer-home'),
        COMPOSER_CACHE_DIR: join(root, 'composer-cache'),
        COMPOSER_NO_INTERACTION: '1',
        npm_config_cache: join(root, 'npm-cache'),
        http_proxy: proxyUrl,
        npm_config_proxy: proxyUrl,
        npm_config_userconfig: join(root, 'npmrc'),
        npm_config_globalconfig: join(root, 'npmrc-global'),
        npm_config_fetch_retries: '0',
        npm_config_update_notifier: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      },
    };
  }

  const upstreamCount = (): number => packagist.requests.length + npmjs.requests.length;

  async function resetCounters(): Promise<void> {
    let previous = -1;
    while (previous !== upstreamCount()) {
      previous = upstreamCount();
      await sleep(250);
    }
    packagist.requests.length = 0;
    npmjs.requests.length = 0;
  }

  describe('composer', () => {
    async function prepare(name: string) {
      const box = sandbox(name);
      await mkdir(box.project, { recursive: true });
      await mkdir(box.env['COMPOSER_HOME']!, { recursive: true });
      await writeFile(
        join(box.project, 'composer.json'),
        JSON.stringify({
          name: 'acme/app',
          repositories: [{ type: 'composer', url: `${origin}/alpha` }, { 'packagist.org': false }],
          config: { 'secure-http': false },
        }),
      );
      return box;
    }

    it('requires a package, then installs it from the lock with an empty client cache and no upstream traffic', async () => {
      const first = await prepare('composer-a');
      const required = await run(
        'composer',
        ['require', `${NAME}:^1.0`, '--no-plugins', '--no-scripts'],
        first.project,
        first.env,
      );
      expect(required.output).toContain('Lock file operations');
      expect(required.code, required.output).toBe(0);
      expect(
        JSON.parse(await readFile(join(first.project, 'composer.lock'), 'utf8')).packages[0].name,
      ).toBe(NAME);
      expect(await readFile(join(first.project, 'vendor', NAME, 'src.php'), 'utf8')).toBe(
        '<?php\n',
      );
      expect(packagist.requests.length).toBeGreaterThan(0);

      const second = await prepare('composer-b');
      await writeFile(
        join(second.project, 'composer.json'),
        await readFile(join(first.project, 'composer.json'), 'utf8'),
      );
      await writeFile(
        join(second.project, 'composer.lock'),
        await readFile(join(first.project, 'composer.lock'), 'utf8'),
      );
      await resetCounters();
      const installed = await run(
        'composer',
        ['install', '--no-plugins', '--no-scripts'],
        second.project,
        second.env,
      );
      expect(installed.code, installed.output).toBe(0);
      expect(await readFile(join(second.project, 'vendor', NAME, 'src.php'), 'utf8')).toBe(
        '<?php\n',
      );
      expect(upstreamCount()).toBe(0);
    });

    it('fails the install when the dist shasum does not match the archive', async () => {
      packagistShasum = sha1(Buffer.from('not the archive'));
      const box = await prepare('composer-bad');
      const required = await run(
        'composer',
        ['require', `${NAME}:^1.0`, '--no-plugins', '--no-scripts'],
        box.project,
        box.env,
      );
      expect(required.code).not.toBe(0);
      expect(flat(required.output)).toContain(flat('could not be downloaded (HTTP/1.1 404'));
      expect(flat(required.output)).not.toContain(flat('checksum verification'));
      await expect(readFile(join(box.project, 'vendor', NAME, 'src.php'))).rejects.toThrow();
    });

    it('fails the install when the served archive is altered after the broker rendered its hash', async () => {
      tamper = (path, body) => (path.includes('/dist/') ? flipped(body) : body);
      const box = await prepare('composer-tamper');
      const required = await run(
        'composer',
        ['require', `${NAME}:^1.0`, '--no-plugins', '--no-scripts'],
        box.project,
        box.env,
      );
      expect(required.code).not.toBe(0);
      expect(flat(required.output)).toContain(flat('checksum verification'));
      await expect(readFile(join(box.project, 'vendor', NAME, 'src.php'))).rejects.toThrow();
    });
  });

  describe('npm', () => {
    async function prepare(name: string) {
      const box = sandbox(name);
      await mkdir(box.project, { recursive: true });
      await writeFile(
        join(box.project, 'package.json'),
        JSON.stringify({ name: 'app', version: '1.0.0', private: true }),
      );
      await writeFile(box.env['npm_config_userconfig']!, `registry=${origin}/alpha/npm/\n`);
      return box;
    }

    it('installs, then runs npm ci from the lock with an empty client cache and no upstream traffic', async () => {
      const first = await prepare('npm-a');
      const installed = await run('npm', ['install', NPM_NAME], first.project, first.env);
      expect(installed.code, installed.output).toBe(0);
      const lock = JSON.parse(await readFile(join(first.project, 'package-lock.json'), 'utf8'));
      expect(lock.packages[`node_modules/${NPM_NAME}`].integrity).toBe(sri(TGZ));
      expect(lock.packages[`node_modules/${NPM_NAME}`].resolved).toContain(`${origin}/alpha/npm/`);
      expect(npmjs.requests.length).toBeGreaterThan(0);

      const second = await prepare('npm-b');
      for (const file of ['package.json', 'package-lock.json']) {
        await writeFile(
          join(second.project, file),
          await readFile(join(first.project, file), 'utf8'),
        );
      }
      await resetCounters();
      const ci = await run('npm', ['ci'], second.project, second.env);
      expect(ci.code, ci.output).toBe(0);
      expect(
        await readFile(join(second.project, 'node_modules', NPM_NAME, 'index.js'), 'utf8'),
      ).toBe('module.exports = 1;\n');
      expect(upstreamCount()).toBe(0);
    });

    it('fails the install when the upstream integrity does not match the tarball', async () => {
      npmIntegrity = sri(Buffer.from('not the tarball'));
      const box = await prepare('npm-bad');
      const installed = await run('npm', ['install', NPM_NAME], box.project, box.env);
      expect(installed.code).not.toBe(0);
      expect(installed.output).toContain('E502');
      expect(installed.output).toContain(
        `${origin}/alpha/npm/${NPM_NAME}/-/${NPM_NAME}-${VERSION}.tgz`,
      );
      expect(installed.output).not.toContain('EINTEGRITY');
      await expect(
        readFile(join(box.project, 'node_modules', NPM_NAME, 'index.js')),
      ).rejects.toThrow();
    });

    it('fails the install when the served tarball is altered after the broker rendered its integrity', async () => {
      tamper = (path, body) => (path.endsWith('.tgz') ? flipped(body) : body);
      const box = await prepare('npm-tamper');
      const installed = await run('npm', ['install', NPM_NAME], box.project, box.env);
      expect(installed.code).not.toBe(0);
      expect(installed.output).toContain('EINTEGRITY');
    });
  });

  describe('pnpm and yarn', () => {
    async function prepare(name: string, files: Record<string, string> = {}) {
      const box = sandbox(name);
      await mkdir(box.project, { recursive: true });
      await writeFile(
        join(box.project, 'package.json'),
        JSON.stringify({ name: 'app', version: '1.0.0', private: true }),
      );
      await writeFile(
        join(box.project, '.npmrc'),
        `registry=${origin}/alpha/npm/\nproxy=${proxyUrl}\n`,
      );
      for (const [file, content] of Object.entries(files)) {
        await writeFile(join(box.project, file), content);
      }
      return box;
    }

    it.skip('NOT RUN: pnpm self-fetches its packument through the registry; covered by T848', () =>
      undefined);

    it('yarn adds, then installs from the lock with an empty cache and no upstream traffic', async (context) => {
      const reason = await available('yarn', ['--version']);
      if (reason !== null) return context.skip(`NOT RUN: yarn unavailable: ${reason}`);
      const first = await prepare('yarn-a');
      const cache = (name: string): string => join(directory, name, 'yarn-cache');
      const flags = ['--cache-folder', cache('yarn-a'), '--no-progress', '--non-interactive'];
      const added = await run('yarn', ['add', NPM_NAME, ...flags], first.project, first.env);
      expect(added.code, added.output).toBe(0);

      const second = await prepare('yarn-b', {
        'package.json': await readFile(join(first.project, 'package.json'), 'utf8'),
        'yarn.lock': await readFile(join(first.project, 'yarn.lock'), 'utf8'),
      });
      await resetCounters();
      const installed = await run(
        'yarn',
        ['install', '--frozen-lockfile', '--cache-folder', cache('yarn-b'), '--no-progress'],
        second.project,
        second.env,
      );
      expect(installed.code, installed.output).toBe(0);
      expect(
        await readFile(join(second.project, 'node_modules', NPM_NAME, 'index.js'), 'utf8'),
      ).toBe('module.exports = 1;\n');
      expect(upstreamCount()).toBe(0);
    });
  });
});
