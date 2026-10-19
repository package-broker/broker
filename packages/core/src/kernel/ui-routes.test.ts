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
import { UI_CSP, createUiRoutes, uiRootRedirect } from './ui-routes.js';

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

describe('UI response headers', () => {
  it('sends the exact content security policy', async () => {
    const response = await (await app()).fetch(get('/_pb/ui'));
    expect(UI_CSP).toBe(CSP);
    expect(response.headers.get('content-security-policy')).toBe(CSP);
  });

  it.each([
    ['cross-origin-opener-policy', 'same-origin'],
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'same-origin'],
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
      expect(response.headers.get('referrer-policy')).toBe('same-origin');
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
      coreRoutes: [...createUiRoutes(fakeAssets(), { publicOrigin: HTTPS }), ...sso],
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
