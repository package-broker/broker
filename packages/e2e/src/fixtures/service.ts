import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { sha256, zip } from './archives.js';
import { buildCorpus, composerCorpus, gitRecording, packet } from './corpus.js';

export const modes = [
  'normal',
  'outage',
  'digest-mismatch',
  'redirect-private',
  'redirect-broker',
] as const;
export type FixtureMode = (typeof modes)[number];
export interface FixtureOptions {
  brokerOrigin?: string;
  webhookSecret?: string;
  recordedHeaders?: readonly string[];
}
export interface Observation {
  route: string;
  headers: Record<string, 'present' | 'absent'>;
}

export function signedWebhook(secret: string): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    ref: 'refs/tags/v1.0.0',
    deleted: false,
    repository: { name: 'lib', full_name: 'fixture/lib', owner: { login: 'fixture' } },
  });
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': '00000000-0000-4000-8000-000000000847',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    },
  };
}

function validOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('InvalidFixtureOrigin');
  }
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error('FixtureBodyLimit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

type ComposerVersion = {
  name: string;
  version: string;
  dist?: { type: string; url: string; shasum: string };
};
type ComposerProvider = { packages: Record<string, Record<string, ComposerVersion>> };

function configuration(options: FixtureOptions) {
  const brokerOrigin = options.brokerOrigin ? validOrigin(options.brokerOrigin) : undefined;
  const headerNames = [
    ...new Set(options.recordedHeaders ?? ['authorization', 'cookie', 'proxy-authorization']),
  ].map((name) => name.toLowerCase());
  if (
    headerNames.length > 32 ||
    headerNames.some((name) => !/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name))
  ) {
    throw new Error('InvalidFixtureHeaders');
  }
  return { brokerOrigin, headerNames };
}

export function createFixtureApp(
  fixtureOrigin: string,
  options: FixtureOptions = {},
): {
  app: Hono;
  origin: string;
  controlSecret: string;
  webhookSecret: string;
} {
  const origin = validOrigin(fixtureOrigin);
  const { brokerOrigin, headerNames } = configuration(options);
  const controlSecret = randomBytes(32).toString('hex');
  const secretHash = createHash('sha256')
    .update('Bearer ' + controlSecret)
    .digest();
  const webhookSecret = options.webhookSecret ?? randomBytes(32).toString('hex');
  const corpus = buildCorpus();
  const legacy = composerCorpus();
  const staticRoutes = new Map<string, Buffer>();
  const counts: Record<string, number> = {};
  const observations: Observation[] = [];
  let dropped = 0;
  let mode: FixtureMode = 'normal';
  const app = new Hono();
  app.onError(() => new Response('FixtureError', { status: 500 }));
  app.notFound((c) => c.text('NotFound', 404));

  app.use('/_control/*', async (c, next) => {
    const hash = createHash('sha256')
      .update(c.req.header('authorization') ?? '')
      .digest();
    if (!timingSafeEqual(hash, secretHash)) return c.text('Unauthorized', 401);
    await next();
  });
  app.post('/_control/mode', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const candidate = body && typeof body === 'object' && 'mode' in body ? body.mode : undefined;
    if (!modes.some((value) => value === candidate)) return c.text('InvalidMode', 400);
    if (candidate === 'redirect-broker' && !brokerOrigin) return c.text('MissingBrokerOrigin', 400);
    mode = candidate as FixtureMode;
    return c.json({ mode });
  });
  app.get('/_control/requests', (c) => c.json({ counts, observations, dropped }));
  app.post('/_control/reset', (c) => {
    for (const route of Object.keys(counts)) delete counts[route];
    observations.length = 0;
    dropped = 0;
    return c.json({ reset: true });
  });
  app.post('/_control/webhook', (c) => c.json(signedWebhook(webhookSecret)));

  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/_control/')) return next();
    // Fixed route identities prevent request paths or query strings entering the recorder.
    const path = c.req.path;
    const route = legacy.has(path)
      ? 'composer-v1-corpus'
      : staticRoutes.has(path)
        ? path.startsWith('/dists/')
          ? 'composer-dist'
          : 'composer-v1'
        : path.startsWith('/p2/')
          ? 'packagist-v2'
          : path === '/fixture-lib'
            ? 'npm-packument'
            : path === '/fixture-lib/-/fixture-lib-1.0.0.tgz'
              ? 'npm-tarball'
              : path === '/git/lib.git/info/refs'
                ? 'git-info-refs'
                : path === '/git/lib.git/git-upload-pack'
                  ? 'git-upload-pack'
                  : path.startsWith('/hostile/')
                    ? 'hostile'
                    : 'not-found';
    const key = c.req.method + ' ' + route;
    counts[key] = (counts[key] ?? 0) + 1;
    if (observations.length < 1000) {
      observations.push({
        route: key,
        headers: Object.fromEntries(
          headerNames.map((name) => [name, c.req.raw.headers.has(name) ? 'present' : 'absent']),
        ),
      });
    } else dropped++;
    if (mode === 'outage') return c.text('FixtureOutage', 503);
    if (mode === 'redirect-private') return c.redirect('http://10.0.0.1/fixture', 302);
    if (mode === 'redirect-broker') return c.redirect(brokerOrigin!, 302);
    await next();
  });

  const bytes = (body: Buffer, contentType: string) =>
    new Response(new Uint8Array(body), { headers: { 'content-type': contentType } });
  app.get('/composer-v1/*', (c) => {
    const body = legacy.get(c.req.path);
    return body ? bytes(body, 'application/json') : c.text('NotFound', 404);
  });
  app.get('/packages.json', (c) => bytes(staticRoutes.get(c.req.path)!, 'application/json'));
  app.get('/p/*', (c) => {
    const body = staticRoutes.get(c.req.path);
    return body ? bytes(body, 'application/json') : c.text('NotFound', 404);
  });
  app.get('/dists/*', (c) => {
    const body = staticRoutes.get(c.req.path);
    if (!body) return c.text('NotFound', 404);
    return bytes(
      mode === 'digest-mismatch' ? corpus.get('digest-mismatch.zip')! : body,
      'application/zip',
    );
  });
  app.get('/p2/:vendor/:pkg', (c) => {
    if (c.req.param('vendor') !== 'fx') return c.text('NotFound', 404);
    const name = c.req.param('pkg');
    if (name === 'oversized.json')
      return bytes(corpus.get('oversized-manifest.json')!, 'application/json');
    const variants: Record<string, string> = {
      'lib.json': 'lib.zip',
      'zip-bomb.json': 'zip-bomb.zip',
      'oversized-archive.json': 'oversized-manifest.zip',
      'digest-mismatch.json': 'digest-mismatch.zip',
    };
    const archive = variants[name];
    if (!archive) return c.text('NotFound', 404);
    const packageName = 'fx/' + name.slice(0, -5);
    const body = corpus.get(archive)!;
    return c.json({
      packages: {
        [packageName]: [
          {
            name: packageName,
            version: '1.0.0',
            version_normalized: '1.0.0.0',
            dist: {
              type: 'zip',
              url: origin + '/hostile/' + archive,
              shasum: createHash('sha1')
                .update(archive === 'digest-mismatch.zip' ? corpus.get('lib.zip')! : body)
                .digest('hex'),
            },
          },
        ],
      },
    });
  });
  app.get('/fixture-lib', (c) => {
    const body = corpus.get('lib.tgz')!;
    return c.json({
      name: 'fixture-lib',
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          name: 'fixture-lib',
          version: '1.0.0',
          dist: {
            tarball: origin + '/fixture-lib/-/fixture-lib-1.0.0.tgz',
            shasum: createHash('sha1').update(body).digest('hex'),
            integrity: 'sha512-' + createHash('sha512').update(body).digest('base64'),
          },
        },
      },
    });
  });
  app.get('/fixture-lib/-/fixture-lib-1.0.0.tgz', () =>
    bytes(
      mode === 'digest-mismatch' ? corpus.get('digest-mismatch.zip')! : corpus.get('lib.tgz')!,
      'application/gzip',
    ),
  );
  app.get('/hostile/:name', (c) => {
    const name = c.req.param('name');
    const body = corpus.get(name);
    if (!body) return c.text('NotFound', 404);
    const contentType = name.endsWith('.json')
      ? 'application/json'
      : name.endsWith('.zip')
        ? 'application/zip'
        : name.endsWith('.tgz')
          ? 'application/gzip'
          : 'application/octet-stream';
    return bytes(
      mode === 'digest-mismatch' && name === 'lib.zip' ? corpus.get('digest-mismatch.zip')! : body,
      contentType,
    );
  });

  const recording = gitRecording();
  app.get('/git/lib.git/info/refs', (c) => {
    if (
      c.req.query('service') !== 'git-upload-pack' ||
      c.req.header('git-protocol') !== 'version=2'
    )
      return c.text('UnsupportedGitProtocol', 400);
    return bytes(
      Buffer.concat([
        packet('version 2\n'),
        packet('ls-refs\n'),
        packet('fetch=shallow\n'),
        Buffer.from('0000'),
      ]),
      'application/x-git-upload-pack-advertisement',
    );
  });
  app.post('/git/lib.git/git-upload-pack', async (c) => {
    if (c.req.header('git-protocol') !== 'version=2') return c.text('UnsupportedGitProtocol', 400);
    const body = Buffer.from(await c.req.arrayBuffer());
    const lsRefs = packet('command=ls-refs\n');
    if (body.subarray(0, lsRefs.length).equals(lsRefs)) {
      return bytes(
        Buffer.concat([
          ...recording.call.refs.map((ref) => packet(`${ref.oid} ${ref.name}\n`)),
          Buffer.from('0000'),
        ]),
        'application/x-git-upload-pack-result',
      );
    }
    for (const fixture of [recording, gitRecording(true)]) {
      const exchange = fixture.exchanges.find((item) =>
        body.equals(Buffer.from(item.request.bodyBase64, 'base64')),
      );
      if (exchange)
        return new Response(new Uint8Array(Buffer.from(exchange.response.bodyBase64, 'base64')), {
          status: exchange.response.status,
          headers: exchange.response.headers,
        });
    }
    return c.text('UnsupportedGitRequest', 400);
  });

  const providers: Record<string, { sha256: string }> = {};
  const prefix = '/composer-v1/f07-providers-includes-one/';
  for (const [path, raw] of legacy) {
    if (!path.startsWith(prefix + 'p/fx/')) continue;
    const provider = JSON.parse(raw.toString()) as ComposerProvider;
    for (const [name, versions] of Object.entries(provider.packages)) {
      for (const [version, metadata] of Object.entries(versions)) {
        if (!metadata.dist) continue;
        const archive = zip([
          {
            name: 'lib/composer.json',
            body: Buffer.from(JSON.stringify({ name, version }) + '\n'),
          },
        ]);
        const distPath = `/dists/${name}/${encodeURIComponent(version)}.zip`;
        staticRoutes.set(distPath, archive);
        metadata.dist = {
          type: 'zip',
          url: origin + distPath,
          shasum: createHash('sha1').update(archive).digest('hex'),
        };
      }
      const body = Buffer.from(JSON.stringify(provider));
      const hash = sha256(body);
      staticRoutes.set(`/p/${name}$${hash}.json`, body);
      providers[name] = { sha256: hash };
    }
  }
  const include = Buffer.from(JSON.stringify({ providers }));
  const includeHash = sha256(include);
  staticRoutes.set(`/p/provider-${includeHash}.json`, include);
  staticRoutes.set(
    '/packages.json',
    Buffer.from(
      JSON.stringify({
        packages: [],
        'providers-url': origin + '/p/%package%$%hash%.json',
        'provider-includes': { 'p/provider-%hash%.json': { sha256: includeHash } },
      }),
    ),
  );

  return { app, origin, controlSecret, webhookSecret };
}

export async function startFixtureService(options: FixtureOptions = {}) {
  configuration(options);
  let fixture: ReturnType<typeof createFixtureApp>;
  let origin = '';
  const server = createServer(async (request, response) => {
    try {
      const body = await requestBody(request);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const method = request.method ?? 'GET';
      const result = await fixture.app.fetch(
        new Request(origin + (request.url?.startsWith('/') ? request.url : '/'), {
          method,
          headers,
          ...(['GET', 'HEAD'].includes(method) ? {} : { body: new Uint8Array(body) }),
        }),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('InvalidFixtureRequest');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FixtureBindError');
  origin = `http://127.0.0.1:${address.port}`;

  try {
    fixture = createFixtureApp(origin, options);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    origin,
    controlSecret: fixture.controlSecret,
    webhookSecret: fixture.webhookSecret,
    address: { address: address.address, family: address.family, port: address.port },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
