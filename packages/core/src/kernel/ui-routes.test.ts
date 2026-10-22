import { describe, expect, it, vi } from 'vitest';
import { createSsoRoutes } from '../auth/routes-sso.js';
import { createSessionService } from '../auth/session.js';
import { orgContext } from '../db/port.js';
import type { Clock } from '../ids.js';
import type { IdentityProvider, StartResult } from '../identity/port.js';
import type { StaticAssets, UiManifest } from '../platform/assets.js';
import { createSecretCipher } from '../secrets/cipher.js';
import { createKeyring } from '../secrets/keyring.js';
import type { KernelLog } from './errors.js';
import { createKernel } from './kernel.js';
import {
  SETUP_ASSET_PREFIX,
  SETUP_DOCUMENT_ROUTE,
  SETUP_UI_PATH,
  UI_CSP,
  createSetupUiRoutes,
  createUiRoutes,
  rewriteSetupRequest,
  uiRootRedirect,
} from './ui-routes.js';
import { documented } from '../test-support/documented-routes.js';

const HTTPS = 'https://broker.test';
const HTTP = 'http://broker.test';
const ORG = orgContext('01J0ORGA00000000000000000A');
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; require-trusted-types-for 'script'";

const MANIFEST: UiManifest = {
  version: 1,
  entry: 'index.html',
  files: {
    'index.html': { contentType: 'text/html', bytes: 40 },
    'app.abc123.js': { contentType: 'text/javascript', bytes: 12 },
    'app.abc123.css': { contentType: 'text/css', bytes: 8 },
    'app.012345abcdef.js': { contentType: 'text/javascript', bytes: 12 },
    '../x': { contentType: 'text/javascript', bytes: 1 },
  },
};

const BODIES: Record<string, string> = {
  'index.html': '<!doctype html><script src="/_pb/ui/assets/app.abc123.js"></script>',
  'app.abc123.js': 'console.log(1)',
  'app.abc123.css': 'body{}',
  'app.012345abcdef.js': 'console.log(2)',
};

interface Fake extends StaticAssets {
  readonly reads: string[];
}

function fakeAssets(manifest: UiManifest | null = MANIFEST): Fake {
  const reads: string[] = [];
  return {
    reads,
    manifest: () => Promise.resolve(manifest),
    read: (name) => {
      reads.push(name);
      const text = BODIES[name];
      const listed = manifest !== null && Object.hasOwn(manifest.files, name);
      if (text === undefined || !listed) return Promise.resolve(null);
      return Promise.resolve({
        body: new TextEncoder().encode(text),
        contentType: (manifest.files[name] as { contentType: string }).contentType,
        bytes: text.length,
      });
    },
  };
}

async function app(
  assets: StaticAssets = fakeAssets(),
  publicOrigin = HTTPS,
  log: KernelLog = () => undefined,
) {
  const clock: Clock = { now: () => new Date('2026-10-15T12:00:00.000Z') };
  return createKernel({
    platform: 'node',
    publicOrigin,
    plugins: [],
    ports: {
      organizations: { get: () => Promise.resolve(null) },
      clock,
      ids: { ulid: () => '01J0A0000000000000000000000'.slice(0, 26) },
    },
    resolveOrg: () => Promise.resolve(ORG),
    health: () => Promise.resolve(true),
    coreRoutes: createUiRoutes(assets, { publicOrigin, log }),
    log: () => undefined,
  });
}

function get(path: string, accept?: string): Request {
  return new Request(`${HTTPS}${path}`, {
    headers: accept === undefined ? {} : { accept },
  });
}

async function errorOf(response: Response) {
  const body = (await response.json()) as { error: { code: string; message: string } };
  return { status: response.status, code: body.error.code, message: body.error.message };
}

describe('public UI boundary', () => {
  it('serves identical documents and assets without resolving an organization or authenticating', async () => {
    const resolveOrg = vi.fn(() => {
      throw new Error('public UI must not resolve an organization');
    });
    const authorize = vi.fn(() => {
      throw new Error('public UI must not authenticate or refresh a session');
    });
    const kernel = await createKernel({
      platform: 'node',
      publicOrigin: HTTPS,
      plugins: [],
      ports: {
        organizations: { get: () => Promise.resolve(null) },
        clock: { now: () => new Date('2026-10-22T12:00:00Z') },
        ids: { ulid: () => '01J0A0000000000000000000000' },
      },
      resolveOrg,
      authorization: { authorize },
      health: () => Promise.resolve(true),
      coreRoutes: createUiRoutes(fakeAssets(), { publicOrigin: HTTPS }),
      log: () => undefined,
    });
    for (const path of ['/_pb/ui', '/_pb/ui/assets/app.012345abcdef.js']) {
      for (const method of ['GET', 'HEAD']) {
        const anonymous = await kernel.fetch(new Request(`${HTTPS}${path}`, { method }));
        const signedIn = await kernel.fetch(
          new Request(`${HTTPS}${path}`, {
            method,
            headers: { cookie: '__Host-pb_session=valid' },
          }),
        );
        expect(anonymous.status).toBe(200);
        expect(signedIn.status).toBe(200);
        expect(anonymous.headers.get('set-cookie')).toBeNull();
        expect(signedIn.headers.get('set-cookie')).toBeNull();
        expect(await anonymous.arrayBuffer()).toEqual(await signedIn.arrayBuffer());
        const headers = (response: Response) =>
          [...response.headers].filter(([name]) => name !== 'x-request-id');
        expect(headers(anonymous)).toEqual(headers(signedIn));
        const etag = anonymous.headers.get('etag');
        expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
        const revalidated = await kernel.fetch(
          new Request(`${HTTPS}${path}`, {
            method,
            headers: { cookie: '__Host-pb_session=valid', 'if-none-match': etag! },
          }),
        );
        expect(revalidated.status).toBe(304);
        expect(revalidated.headers.get('set-cookie')).toBeNull();
        expect(revalidated.headers.get('cache-control')).toBe(
          anonymous.headers.get('cache-control'),
        );
      }
    }
    expect(resolveOrg).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
});

describe('UI response headers', () => {
  it('sends the exact content security policy', async () => {
    const response = await (await app()).fetch(get('/_pb/ui'));
    expect(UI_CSP).toBe(CSP);
    expect(response.headers.get('content-security-policy')).toBe(CSP);
  });

  it.each([
    ['cross-origin-opener-policy', 'same-origin'],
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'no-referrer'],
  ])('sends %s', async (name, value) => {
    const response = await (await app()).fetch(get('/_pb/ui'));
    expect(response.headers.get(name)).toBe(value);
  });

  it.each(['/_pb/ui', '/_pb/ui/assets/app.abc123.js', '/_pb/ui/assets/missing.js'])(
    'sends the policy headers on %s',
    async (path) => {
      const response = await (await app()).fetch(get(path));
      expect(response.headers.get('content-security-policy')).toBe(CSP);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    },
  );

  it('sends HSTS for an https public origin', async () => {
    const response = await (await app(fakeAssets(), HTTPS)).fetch(get('/_pb/ui'));
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('omits HSTS for an http public origin', async () => {
    const response = await (await app(fakeAssets(), HTTP)).fetch(get('/_pb/ui'));
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });
});

describe('GET /_pb/ui', () => {
  it('serves the entry file with no-cache', async () => {
    const response = await (await app()).fetch(get('/_pb/ui'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe(BODIES['index.html']);
  });

  it('does not mark the entry file immutable', async () => {
    const response = await (await app()).fetch(get('/_pb/ui'));
    expect(response.headers.get('cache-control')).not.toContain('immutable');
  });

  it('answers the 404 envelope when no manifest is available', async () => {
    const response = await (await app(fakeAssets(null))).fetch(get('/_pb/ui'));
    expect(await errorOf(response)).toEqual({
      status: 404,
      code: 'not_found',
      message: 'Route not found',
    });
  });

  it('reads the manifest on every request', async () => {
    const manifest = vi.fn(() => Promise.resolve<UiManifest | null>(MANIFEST));
    const assets: StaticAssets = { ...fakeAssets(), manifest };
    const kernel = await app(assets);
    await kernel.fetch(get('/_pb/ui'));
    await kernel.fetch(get('/_pb/ui'));
    await kernel.fetch(get('/_pb/ui/assets/app.abc123.js'));
    expect(manifest).toHaveBeenCalledTimes(3);
  });

  it('is a public route that needs no organization', () => {
    const routes = createUiRoutes(fakeAssets(), { publicOrigin: HTTPS });
    expect(routes.map((r) => [r.method, r.path, r.permission, r.needsOrg])).toEqual([
      ['GET', '/_pb/ui', null, false],
      ['GET', '/_pb/ui/assets/:file', null, false],
    ]);
  });
});

describe('GET /_pb/ui/assets/:file', () => {
  it('serves a hashed listed file as immutable with its content type', async () => {
    const response = await (await app()).fetch(get('/_pb/ui/assets/app.012345abcdef.js'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('content-type')).toBe('text/javascript');
    expect(await response.text()).toBe(BODIES['app.012345abcdef.js']);
  });

  it('does not serve the entry file as an immutable asset', async () => {
    const response = await (await app()).fetch(get('/_pb/ui/assets/index.html'));
    expect(response.status).toBe(404);
  });

  const missing = async () =>
    errorOf(await (await app()).fetch(get('/_pb/ui/assets/does-not-exist.js')));

  it.each([
    ['an encoded slash traversal', '/_pb/ui/assets/..%2f..%2fpackage.json'],
    ['an encoded dot traversal', '/_pb/ui/assets/%2e%2e/x'],
    ['a plain dot traversal', '/_pb/ui/assets/../x'],
    ['an encoded slash', '/_pb/ui/assets/app%2fabc.js'],
    ['an empty name', '/_pb/ui/assets/'],
    ['a dot-prefixed name', '/_pb/ui/assets/.env'],
    ['an unlisted name', '/_pb/ui/assets/app.zzz999.js'],
  ])('answers the uniform 404 for %s', async (_name, path) => {
    const response = await (await app()).fetch(get(path));
    expect(await errorOf(response)).toEqual(await missing());
  });

  it('never passes an unlisted name to the port', async () => {
    const assets = fakeAssets();
    const kernel = await app(assets);
    await kernel.fetch(get('/_pb/ui/assets/..%2f..%2fpackage.json'));
    await kernel.fetch(get('/_pb/ui/assets/.env'));
    await kernel.fetch(get('/_pb/ui/assets/app.zzz999.js'));
    expect(assets.reads).toEqual([]);
  });

  it('refuses a manifest entry that is not a safe file name', async () => {
    const assets = fakeAssets();
    const response = await (await app(assets)).fetch(get('/_pb/ui/assets/..%2fx'));
    expect(response.status).toBe(404);
    expect(assets.reads).toEqual([]);
  });

  it('answers 404 when the port returns null for a listed name', async () => {
    const assets: StaticAssets = { ...fakeAssets(), read: () => Promise.resolve(null) };
    const response = await (await app(assets)).fetch(get('/_pb/ui/assets/app.abc123.js'));
    expect(response.status).toBe(404);
  });

  it('selects the file from the path only, never from the request host', async () => {
    const assets = fakeAssets();
    const kernel = await app(assets);
    const request = new Request('https://app.abc123.js.evil.test/_pb/ui/assets/app.abc123.css', {
      headers: { host: 'app.abc123.js' },
    });
    const response = await kernel.fetch(request);
    expect(assets.reads).toEqual(['app.abc123.css']);
    expect(response.headers.get('content-type')).toBe('text/css');
  });
});

describe('UI asset metadata', () => {
  it('rejects a port content type mismatch with the uniform 404 and logs only the file name', async () => {
    const log = vi.fn<KernelLog>();
    const assets: StaticAssets = {
      ...fakeAssets(),
      read: () =>
        Promise.resolve({
          body: new Uint8Array([1]),
          contentType: 'text/html',
          bytes: 1,
        }),
    };
    const kernel = await app(assets, HTTPS, log);
    const response = await kernel.fetch(get('/_pb/ui/assets/app.abc123.js'));
    const missing = await kernel.fetch(get('/_pb/ui/assets/missing.js'));
    expect(await errorOf(response)).toEqual(await errorOf(missing));
    expect(log.mock.calls).toEqual([
      [
        {
          level: 'warn',
          event: 'ui.asset_type_mismatch',
          file: 'app.abc123.js',
        },
      ],
    ]);
  });

  it('revalidates a listed file without a twelve-digit content hash', async () => {
    const response = await (await app()).fetch(get('/_pb/ui/assets/app.abc123.js'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('sets content-length from the byte body rather than either metadata byte count', async () => {
    const body = new TextEncoder().encode('π');
    const assets: StaticAssets = {
      ...fakeAssets(),
      read: () => Promise.resolve({ body, contentType: 'text/javascript', bytes: 999 }),
    };
    const response = await (await app(assets)).fetch(get('/_pb/ui/assets/app.abc123.js'));
    expect(response.headers.get('content-length')).toBe(String(body.byteLength));
    expect(await response.text()).toBe('π');
  });

  it.each(['/_pb/ui', '/_pb/ui/assets/app.012345abcdef.js'])(
    'serves HEAD %s with GET status and headers and no body',
    async (path) => {
      const kernel = await app();
      const response = await kernel.fetch(new Request(`${HTTPS}${path}`, { method: 'HEAD' }));
      const full = await kernel.fetch(get(path));
      expect(response.status).toBe(200);
      for (const header of [
        'content-type',
        'cache-control',
        'content-length',
        'content-security-policy',
        'cross-origin-opener-policy',
        'x-content-type-options',
        'referrer-policy',
        'strict-transport-security',
      ]) {
        expect(response.headers.get(header)).toBe(full.headers.get(header));
      }
      expect(response.headers.get('content-length')).toBe(
        String((await full.arrayBuffer()).byteLength),
      );
      expect(await response.text()).toBe('');
    },
  );
});

describe('GET /', () => {
  it.each(['GET', 'HEAD'])('mounts %s / through the kernel', async (method) => {
    const response = await (
      await app()
    ).fetch(
      new Request(`${HTTPS}/`, {
        method,
        headers: { accept: 'text/html', origin: 'https://other.test' },
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/_pb/ui');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Accept');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
  });

  it('redirects to the route that serves the manifest entry', async () => {
    const assets: StaticAssets = {
      manifest: () =>
        Promise.resolve({
          version: 1,
          entry: 'custom.html',
          files: { 'custom.html': { contentType: 'text/html', bytes: 6 } },
        }),
      read: (name) =>
        Promise.resolve(
          name === 'custom.html'
            ? { body: new TextEncoder().encode('custom'), contentType: 'text/html', bytes: 6 }
            : null,
        ),
    };
    const kernel = await app(assets);
    const redirect = await kernel.fetch(get('/', 'text/html'));
    expect(redirect.status).toBe(303);
    const entry = await kernel.fetch(get(redirect.headers.get('location')!));
    expect(await entry.text()).toBe('custom');
  });

  it.each([
    undefined,
    'application/json',
    '*/*',
    'text/html;q=0',
    'text/html;q=0.5,application/json',
  ])('preserves the kernel 404 for Accept %s', async (accept) => {
    const response = await (await app()).fetch(get('/', accept));
    expect(response.status).toBe(404);
    expect(response.headers.get('vary')).toBe('Accept');
    expect(response.headers.has('location')).toBe(false);
  });

  it.each([
    ['POST', '/'],
    ['GET', '/x'],
    ['GET', '/nested/path'],
  ])('does not redirect %s %s', async (method, path) => {
    const response = await (
      await app()
    ).fetch(
      new Request(`${HTTPS}${path}`, {
        method,
        headers: { accept: 'text/html' },
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.has('location')).toBe(false);
  });

  it('redirects a browser to the UI with 303', () => {
    const response = uiRootRedirect(get('/', 'text/html,application/xhtml+xml'));
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('/_pb/ui');
  });

  it('does not redirect when Accept is application/json', () => {
    expect(uiRootRedirect(get('/', 'application/json'))).toBeNull();
  });

  it('does not redirect when Accept is absent', () => {
    expect(uiRootRedirect(get('/'))).toBeNull();
  });

  it('does not redirect when Accept is */*', () => {
    expect(uiRootRedirect(get('/', '*/*'))).toBeNull();
  });

  it('does not redirect when html has quality zero', () => {
    expect(uiRootRedirect(get('/', 'text/html;q=0'))).toBeNull();
  });
});

describe('single sign-on under the UI policy', () => {
  it('lets the page fetch the JSON start response and only navigate to the provider', async () => {
    const clock: Clock = { now: () => new Date('2026-10-15T12:00:00.000Z') };
    const provider: IdentityProvider = {
      id: 'dex',
      kind: 'oidc',
      displayName: 'Dex',
      trustAnchor: 'oidc:https://dex.example.test',
      policy: { verifiedDomains: ['example.test'], autoJoin: false },
      supportsReauth: true,
      start: () =>
        Promise.resolve<StartResult>({
          kind: 'redirect',
          location: 'https://dex.example.test/authorize?client_id=pb',
          state: { nonce: 'n', verifier: 'v' },
        }),
      finish: () => Promise.resolve({ ok: false, reason: 'invalid_token' }),
    };
    const sso = createSsoRoutes({
      providers: new Map([['dex', provider]]),
      sessions: createSessionService({
        sessions: {} as never,
        clock,
        publicOrigin: HTTPS,
      }),
      login: () => Promise.reject(new Error('unused')),
      reauth: () => Promise.reject(new Error('unused')),
      stateCipher: createSecretCipher(
        createKeyring([{ version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) }]),
        'login-state',
      ),
      clock,
      publicOrigin: HTTPS,
      localLoginAvailable: false,
      log: () => undefined,
    });
    const kernel = await createKernel({
      platform: 'node',
      plugins: [],
      ports: {
        organizations: { get: () => Promise.resolve(null) },
        clock,
        ids: { ulid: () => '01J0A0000000000000000000000'.slice(0, 26) },
      },
      resolveOrg: () => Promise.resolve(ORG),
      health: () => Promise.resolve(true),
      coreRoutes: documented([...createUiRoutes(fakeAssets(), { publicOrigin: HTTPS }), ...sso]),
      log: () => undefined,
    });

    const page = await kernel.fetch(get('/_pb/ui'));
    const csp = page.headers.get('content-security-policy') ?? '';
    const directives = new Map(
      csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]),
    );
    expect(directives.get('default-src')).toBe("'self'");
    expect(directives.has('connect-src')).toBe(false);
    expect(directives.get('form-action')).toBe("'self'");

    const start = await kernel.fetch(
      new Request(`${HTTPS}/_pb/auth/sso/dex/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: HTTPS, accept: 'application/json' },
        body: JSON.stringify({ purpose: 'login', returnTo: '/projects/a' }),
      }),
    );
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({
      location: 'https://dex.example.test/authorize?client_id=pb',
    });
  });
});

describe('setup UI routes', () => {
  const SETUP_HTML =
    '<!doctype html><link rel="stylesheet" href="/_pb/ui/setup/assets/app.0123456789ab.css"><script type="module" src="/_pb/ui/setup/assets/setup.0123456789ab.js"></script>';
  const SETUP_MANIFEST: UiManifest = {
    version: 1,
    entry: 'index.html',
    files: {
      'index.html': { contentType: 'text/html', bytes: 40 },
      'setup.html': { contentType: 'text/html', bytes: SETUP_HTML.length },
      'app.abc123.js': { contentType: 'text/javascript', bytes: 12 },
      'app.0123456789ab.css': { contentType: 'text/css', bytes: 8 },
      'setup.0123456789ab.js': { contentType: 'text/javascript', bytes: 12 },
      'unlisted-by-document.js': { contentType: 'text/javascript', bytes: 12 },
      'extra.json': { contentType: 'application/json', bytes: 2 },
    },
  };
  const SETUP_BODIES: Record<string, string> = {
    ...BODIES,
    'app.0123456789ab.css': 'body{}',
    'setup.html': SETUP_HTML,
    'setup.0123456789ab.js': 'console.log("setup")',
    'unlisted-by-document.js': 'console.log("x")',
    'extra.json': '{}',
  };

  function setupAssets(
    options: {
      readonly manifest?: UiManifest | null;
      readonly bodies?: Record<string, string>;
      readonly typeOverride?: Record<string, string>;
    } = {},
  ): Fake {
    const manifest = options.manifest === undefined ? SETUP_MANIFEST : options.manifest;
    const bodies = options.bodies ?? SETUP_BODIES;
    const reads: string[] = [];
    return {
      reads,
      manifest: () => Promise.resolve(manifest),
      read: (name) => {
        reads.push(name);
        const text = bodies[name];
        if (text === undefined || manifest === null || !Object.hasOwn(manifest.files, name)) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          body: new TextEncoder().encode(text),
          contentType:
            options.typeOverride?.[name] ??
            (manifest.files[name] as { contentType: string }).contentType,
          bytes: text.length,
        });
      },
    };
  }

  async function setupApp(assets: StaticAssets = setupAssets()) {
    const clock: Clock = { now: () => new Date('2026-10-15T12:00:00.000Z') };
    return createKernel({
      platform: 'node',
      publicOrigin: HTTPS,
      plugins: [],
      ports: {
        organizations: { get: () => Promise.resolve(null) },
        clock,
        ids: { ulid: () => '01J0A0000000000000000000000'.slice(0, 26) },
      },
      resolveOrg: () => Promise.resolve(ORG),
      health: () => Promise.resolve(true),
      coreRoutes: createSetupUiRoutes(assets, { publicOrigin: HTTPS }),
      log: () => undefined,
    });
  }

  async function document(
    kernel: Awaited<ReturnType<typeof setupApp>>,
    method = 'GET',
  ): Promise<Response> {
    const rewritten = rewriteSetupRequest(new Request(`${HTTPS}/_pb/ui/setup`, { method }));
    if (rewritten === null) throw new Error('the setup path was not rewritten');
    return kernel.fetch(rewritten);
  }

  it('adds exactly the public document route and the scoped asset route', () => {
    const routes = createSetupUiRoutes(setupAssets(), { publicOrigin: HTTPS });
    expect(routes.map((route) => [route.method, route.path])).toEqual([
      ['GET', '/_pb/ui/setup/document'],
      ['GET', '/_pb/ui/setup/assets/:file'],
    ]);
    for (const route of routes) {
      expect(route.permission).toBeNull();
      expect(route.needsOrg).toBe(false);
      expect(route.boundary).toBeUndefined();
      expect(Object.isFrozen(route)).toBe(true);
    }
    expect(SETUP_UI_PATH).toBe('/_pb/ui/setup');
    expect(SETUP_DOCUMENT_ROUTE).toBe('/_pb/ui/setup/document');
    expect(SETUP_ASSET_PREFIX).toBe('/_pb/ui/setup/assets/');
    expect(
      createUiRoutes(setupAssets(), { publicOrigin: HTTPS }).map((route) => route.path),
    ).toEqual(['/_pb/ui', '/_pb/ui/assets/:file']);
  });

  it('serves the setup document without credentials, no-store, no-referrer and under the CSP', async () => {
    const response = await document(await setupApp());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SETUP_HTML);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toBe(CSP);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each(['app.0123456789ab.css', 'setup.0123456789ab.js'])(
    'serves the referenced asset %s with immutable caching and a validator',
    async (name) => {
      const kernel = await setupApp();
      const response = await kernel.fetch(get(`/_pb/ui/setup/assets/${name}`));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(SETUP_BODIES[name]);
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('content-security-policy')).toBe(CSP);
      const etag = response.headers.get('etag')!;
      const revalidated = await kernel.fetch(
        new Request(`${HTTPS}/_pb/ui/setup/assets/${name}`, { headers: { 'if-none-match': etag } }),
      );
      expect(revalidated.status).toBe(304);
    },
  );

  it.each([
    'index.html',
    'setup.html',
    'manifest.json',
    'app.abc123.js',
    'unlisted-by-document.js',
    'extra.json',
    'missing.js',
    '..%2Findex.html',
    '.%2e%2fapp.0123456789ab.css',
    'app.0123456789ab.css%00',
    'app.0123456789ab.css%2Fx',
    'APP.ABC123.CSS',
  ])('answers the uniform 404 for %s through the setup asset route', async (name) => {
    const assets = setupAssets();
    const response = await (await setupApp(assets)).fetch(get(`/_pb/ui/setup/assets/${name}`));
    expect(await errorOf(response)).toEqual({
      status: 404,
      code: 'not_found',
      message: 'Route not found',
    });
    expect(response.headers.get('content-security-policy')).toBe(CSP);
    expect(assets.reads.filter((read) => !['setup.html'].includes(read))).toEqual([]);
  });

  it('never lists a directory or falls back when the asset prefix has no file', async () => {
    const kernel = await setupApp();
    for (const path of [
      '/_pb/ui/setup/assets/',
      '/_pb/ui/setup/assets',
      '/_pb/ui/setup/',
      '/_pb/ui/setup/x',
    ]) {
      const response = await kernel.fetch(get(path));
      expect(response.status).toBe(404);
    }
  });

  it('refuses everything when the manifest or the setup document is absent', async () => {
    for (const assets of [
      setupAssets({ manifest: null }),
      setupAssets({ manifest: MANIFEST, bodies: SETUP_BODIES }),
      setupAssets({ bodies: { ...SETUP_BODIES, 'setup.html': undefined as unknown as string } }),
    ]) {
      const kernel = await setupApp(assets);
      expect((await document(kernel)).status).toBe(404);
      expect((await kernel.fetch(get('/_pb/ui/setup/assets/app.0123456789ab.css'))).status).toBe(
        404,
      );
    }
  });

  it.each([
    ['an external script', '<script src="https://cdn.example/x.js"></script>'],
    ['a protocol-relative script', '<script src="//cdn.example/x.js"></script>'],
    ['a relative reference', '<script src="setup.0123456789ab.js"></script>'],
    ['the app prefix', '<script src="/_pb/ui/assets/app.abc123.js"></script>'],
    ['the manifest', '<script src="/_pb/ui/setup/assets/manifest.json"></script>'],
    ['the entry document', '<link href="/_pb/ui/setup/assets/index.html">'],
    ['itself', '<link href="/_pb/ui/setup/assets/setup.html">'],
    ['a JSON file', '<link href="/_pb/ui/setup/assets/extra.json">'],
    ['a traversal', '<script src="/_pb/ui/setup/assets/../index.html"></script>'],
    ['an unlisted file', '<script src="/_pb/ui/setup/assets/nope.js"></script>'],
  ])('fails closed when the setup document references %s', async (_, reference) => {
    const kernel = await setupApp(
      setupAssets({ bodies: { ...SETUP_BODIES, 'setup.html': `<!doctype html>${reference}` } }),
    );
    expect((await document(kernel)).status).toBe(404);
    expect((await kernel.fetch(get('/_pb/ui/setup/assets/app.0123456789ab.css'))).status).toBe(404);
  });

  it('refuses a document whose stored type differs from the manifest and an asset with a wrong type', async () => {
    const wrongDocument = await setupApp(
      setupAssets({ typeOverride: { 'setup.html': 'text/plain' } }),
    );
    expect((await document(wrongDocument)).status).toBe(404);
    const wrongAsset = await setupApp(
      setupAssets({ typeOverride: { 'setup.0123456789ab.js': 'text/html' } }),
    );
    expect((await wrongAsset.fetch(get('/_pb/ui/setup/assets/setup.0123456789ab.js'))).status).toBe(
      404,
    );
  });

  it('does not treat a manifest whose entry is the setup document as a setup page', async () => {
    const kernel = await setupApp(
      setupAssets({ manifest: { ...SETUP_MANIFEST, entry: 'setup.html' } }),
    );
    expect((await document(kernel)).status).toBe(404);
  });

  it('answers HEAD for the document and refuses other methods', async () => {
    const kernel = await setupApp();
    const head = await document(kernel, 'HEAD');
    expect(head.status).toBe(200);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await kernel.fetch(
        new Request(`${HTTPS}/_pb/ui/setup`, { method, headers: { origin: HTTPS } }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });

  it('rewrites only a GET or HEAD of the exact public setup path', () => {
    expect(rewriteSetupRequest(new Request(`${HTTPS}/_pb/ui/setup`))?.url).toBe(
      `${HTTPS}${SETUP_DOCUMENT_ROUTE}`,
    );
    expect(rewriteSetupRequest(new Request(`${HTTPS}/_pb/ui/setup?x=1`))?.url).toBe(
      `${HTTPS}${SETUP_DOCUMENT_ROUTE}?x=1`,
    );
    for (const request of [
      new Request(`${HTTPS}/_pb/ui/setup`, { method: 'POST', body: '{}' }),
      new Request(`${HTTPS}/_pb/ui/setup/`),
      new Request(`${HTTPS}/_pb/ui/setupx`),
      new Request(`${HTTPS}/_pb/ui/`),
      new Request(`${HTTPS}${SETUP_DOCUMENT_ROUTE}`),
    ]) {
      expect(rewriteSetupRequest(request)).toBeNull();
    }
  });

  it('does not serve the internal document route to a direct request or a forged marker', async () => {
    const kernel = await setupApp();
    const direct = await kernel.fetch(get(SETUP_DOCUMENT_ROUTE));
    expect(await errorOf(direct)).toMatchObject({ status: 404, code: 'not_found' });
    const forged = await kernel.fetch(
      new Request(`${HTTPS}${SETUP_DOCUMENT_ROUTE}`, { headers: { 'x-pb-setup-ui': 'guess' } }),
    );
    expect(forged.status).toBe(404);
    const spoofed = rewriteSetupRequest(
      new Request(`${HTTPS}/_pb/ui/setup`, { headers: { 'x-pb-setup-ui': 'guess' } }),
    );
    expect((await kernel.fetch(spoofed!)).status).toBe(200);
  });
});
