import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  LoginView,
  ReauthView,
  SigninFailedView,
  ssoFailureMessage,
  ReauthConfirmContent,
  ReauthConfirm,
  SetupView,
  SetupAvailabilityView,
  createLoginController,
  createReauthFlow,
  createSetupController,
  isNavigableLocation,
  startSso,
  reauthReturnHash,
  type AuthClient,
} from './auth.js';
import type { PendingStorage } from './pending.js';
import { buildListFilterHash } from './page-hash.js';

const SENTINEL = 'sentinel-pass-9f3a';
const CODE = '483920';

type Reply =
  { ok: true; status: number; data: unknown } | { ok: false; status: number; code: string };

function fakeClient(...replies: Reply[]) {
  const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
    const next = replies.shift();
    if (next === undefined) throw new Error('unexpected request');
    return next.ok ? next : { ...next, details: [], request: { method: 'POST', path: '/x' } };
  });
  return { client: { request } as unknown as AuthClient, request };
}

const ok = (status = 204, data: unknown = undefined): Reply => ({ ok: true, status, data });
const fail = (status: number, code = 'unauthorized'): Reply => ({ ok: false, status, code });

function memoryStorage() {
  const entries = new Map<string, string>();
  const storage: PendingStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
  return { storage, entries };
}

function everything(controller: { snapshot(): unknown }) {
  return JSON.stringify(controller.snapshot());
}

describe('local login', () => {
  it('moves to signed-in on success and reports it once', async () => {
    const { client, request } = fakeClient(ok());
    const onSignedIn = vi.fn();
    const login = createLoginController({ client, onSignedIn });
    await login.submit({ email: 'a@example.test', password: SENTINEL, code: CODE });
    expect(login.snapshot().status).toBe('signed-in');
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('post', '/_pb/auth/local/login', {
      body: { email: 'a@example.test', password: SENTINEL, code: CODE },
    });
  });

  it('shows one generic error on 401 and keeps no password anywhere', async () => {
    const { client } = fakeClient(fail(401));
    const login = createLoginController({ client, onSignedIn: vi.fn() });
    const states: string[] = [];
    login.subscribe(() => states.push(everything(login)));
    await login.submit({ email: 'a@example.test', password: SENTINEL, code: CODE });
    expect(login.snapshot()).toMatchObject({ status: 'error', error: 'invalid' });
    expect(states.length).toBeGreaterThan(0);
    for (const state of [...states, everything(login)]) {
      expect(state).not.toContain(SENTINEL);
      expect(state).not.toContain(CODE);
    }
    const html = renderToString(
      createElement(LoginView, {
        state: login.snapshot(),
        providers: [],
        local: true,
        onSubmit: () => undefined,
        onSso: () => undefined,
      }),
    );
    expect(html).not.toContain(SENTINEL);
    expect(html).toContain('Sign-in failed');
  });

  it('gives the same error for a 403 as for a 401', async () => {
    const a = createLoginController({ client: fakeClient(fail(401)).client, onSignedIn: vi.fn() });
    const b = createLoginController({
      client: fakeClient(fail(403, 'forbidden')).client,
      onSignedIn: vi.fn(),
    });
    const input = { email: 'a@example.test', password: SENTINEL, code: CODE };
    await a.submit(input);
    await b.submit(input);
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it('reports an unreachable broker separately', async () => {
    const { client } = fakeClient({ ok: false, status: 0, code: 'network_error' });
    const login = createLoginController({ client, onSignedIn: vi.fn() });
    await login.submit({ email: 'a@example.test', password: SENTINEL, code: CODE });
    expect(login.snapshot()).toMatchObject({ status: 'error', error: 'unavailable' });
  });

  it('ignores a second submit while one is running', async () => {
    const { client, request } = fakeClient(ok());
    const login = createLoginController({ client, onSignedIn: vi.fn() });
    const input = { email: 'a@example.test', password: SENTINEL, code: CODE };
    await Promise.all([login.submit(input), login.submit(input)]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('renders the signed-in and busy states without the password', () => {
    for (const status of ['idle', 'busy', 'signed-in'] as const) {
      const html = renderToString(
        createElement(LoginView, {
          state: { status, error: null },
          providers: [{ id: 'corp', displayName: 'Corp SSO', kind: 'oidc', supportsReauth: true }],
          local: true,
          onSubmit: () => undefined,
          onSso: () => undefined,
        }),
      );
      expect(html).not.toContain(SENTINEL);
    }
  });

  it('shows an SSO button per provider and hides the local form when local login is off', () => {
    const html = renderToString(
      createElement(LoginView, {
        state: { status: 'idle', error: null },
        providers: [{ id: 'corp', displayName: 'Corp SSO', kind: 'oidc', supportsReauth: true }],
        local: false,
        onSubmit: () => undefined,
        onSso: () => undefined,
      }),
    );
    expect(html).toContain('Corp SSO');
    expect(html).not.toContain('type="password"');
  });
});

describe('SSO navigation', () => {
  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,x'],
    ['//evil.test/x'],
    ['/\\evil.test'],
    ['/\n/evil.test'],
    ['relative'],
    [''],
  ])('refuses %s and does not navigate', async (location) => {
    const { client } = fakeClient(ok(200, { location }));
    const navigate = vi.fn();
    expect(await startSso(client, 'corp', 'login', navigate)).toBe('refused');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('refuses a response without a location', async () => {
    const { client } = fakeClient(ok(200, {}));
    const navigate = vi.fn();
    expect(await startSso(client, 'corp', 'login', navigate)).toBe('refused');
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['https://idp.example.test/auth?x=1'],
    ['http://localhost:9000/auth'],
    ['/'],
    ['/relative?x=1#ok'],
  ])('navigates to %s', async (location) => {
    const { client, request } = fakeClient(ok(200, { location }));
    const navigate = vi.fn();
    expect(await startSso(client, 'corp', 'login', navigate)).toBe('navigated');
    expect(navigate).toHaveBeenCalledWith(location);
    expect(request).toHaveBeenCalledWith(
      'post',
      '/_pb/auth/sso/{provider}/start',
      expect.objectContaining({
        params: { provider: 'corp' },
        body: { purpose: 'login' },
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('reports a failed start without navigating', async () => {
    const { client } = fakeClient(fail(502, 'unavailable'));
    const navigate = vi.fn();
    expect(await startSso(client, 'corp', 'reauth', navigate)).toBe('failed');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('classifies safe absolute and broker-local locations', () => {
    expect(isNavigableLocation('https://a.test')).toBe(true);
    expect(isNavigableLocation('HTTPS://a.test')).toBe(true);
    expect(isNavigableLocation('javascript:alert(1)')).toBe(false);
    expect(isNavigableLocation(' javascript:alert(1)')).toBe(false);
    expect(isNavigableLocation('ftp://a.test')).toBe(false);
  });
});

describe('reauth flow', () => {
  const request = {
    method: 'POST',
    path: '/_pb/projects/p/tokens',
    idempotencyKey: 'k1',
    body: { name: 'ci', secret: SENTINEL },
  };

  it('saves the action before leaving and asks for confirmation after return', () => {
    const { storage, entries } = memoryStorage();
    const navigate = vi.fn();
    const flow = createReauthFlow({
      client: fakeClient().client,
      storage,
      now: () => Date.now(),
      navigate,
    });
    flow.requireReauth(request, { credential: false, secretFields: ['secret'] }, '#/tokens');
    expect(entries.size).toBe(1);
    expect([...entries.values()][0]).not.toContain(SENTINEL);
    expect(navigate).toHaveBeenCalledWith('#/reauth?return=%2Ftokens');
    flow.restore();
    expect(flow.snapshot()).toMatchObject({
      dialog: 'confirm',
      action: { method: 'POST', path: '/_pb/projects/p/tokens' },
    });
    expect(entries.size).toBe(0);
  });

  it('stores no body for a credential request', () => {
    const { storage, entries } = memoryStorage();
    const flow = createReauthFlow({
      client: fakeClient().client,
      storage,
      now: Date.now,
      navigate: vi.fn(),
    });
    flow.requireReauth(request, { credential: true, secretFields: [] }, '#/tokens');
    expect([...entries.values()][0]).not.toContain(SENTINEL);
    expect(JSON.parse([...entries.values()][0]!)).not.toHaveProperty('body');
  });

  it.each(['If-Match', 'If-None-Match'])(
    'persists and replays %s after a reload',
    async (header) => {
      const { storage, entries } = memoryStorage();
      const { client, request: send } = fakeClient(ok());
      const deps = { client, storage, now: Date.now, navigate: vi.fn() };
      createReauthFlow(deps).requireReauth(
        {
          ...request,
          headers: {
            [header]: '"revision-7"',
            Authorization: SENTINEL,
            Cookie: SENTINEL,
            'X-PB-CSRF': SENTINEL,
          },
        },
        { credential: false, secretFields: ['secret'] },
        '#/tokens',
      );
      expect([...entries.values()].join('')).not.toContain(SENTINEL);
      const returned = createReauthFlow(deps);
      returned.restore();
      await returned.confirm();
      expect(send).toHaveBeenCalledWith('post', request.path, {
        idempotencyKey: 'k1',
        body: { name: 'ci' },
        headers: { [header]: '"revision-7"' },
      });
    },
  );

  it('requires credential re-entry after a reload and never replays a stripped body', async () => {
    const { storage, entries } = memoryStorage();
    const { client, request: send } = fakeClient();
    const deps = { client, storage, now: Date.now, navigate: vi.fn() };
    createReauthFlow(deps).requireReauth(
      request,
      { credential: true, secretFields: [] },
      '#/tokens',
    );
    const returned = createReauthFlow(deps);
    returned.restore();
    expect(returned.snapshot().dialog).toBe('closed');
    const html = renderToString(createElement(ReauthConfirm, { flow: returned }));
    expect(html).toContain('Enter the credential again');
    expect(html).toContain('Dismiss');
    expect(html).not.toContain('Send the held action now?');
    expect(html).not.toContain(SENTINEL);
    await returned.confirm();
    expect(send).not.toHaveBeenCalled();
    expect(entries.size).toBe(0);
    returned.decline();
    expect(renderToString(createElement(ReauthConfirm, { flow: returned }))).not.toContain(
      'Enter the credential again',
    );
  });

  it('sends nothing and clears the entry when the user declines', () => {
    const { storage, entries } = memoryStorage();
    const { client, request: send } = fakeClient();
    const flow = createReauthFlow({ client, storage, now: Date.now, navigate: vi.fn() });
    flow.requireReauth(request, { credential: false, secretFields: ['secret'] }, '#/tokens');
    flow.restore();
    flow.decline();
    expect(flow.snapshot()).toMatchObject({ dialog: 'closed', action: null });
    expect(entries.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('replays exactly once on confirm', async () => {
    const { storage } = memoryStorage();
    const { client, request: send } = fakeClient(ok(201, {}));
    const flow = createReauthFlow({ client, storage, now: Date.now, navigate: vi.fn() });
    flow.requireReauth(request, { credential: false, secretFields: ['secret'] }, '#/tokens');
    flow.restore();
    await flow.confirm();
    await flow.confirm();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('post', '/_pb/projects/p/tokens', {
      idempotencyKey: 'k1',
      body: { name: 'ci' },
    });
    expect(flow.snapshot()).toMatchObject({ dialog: 'closed', outcome: 'replayed' });
  });

  it('reports a failed replay and does not loop on another reauth_required', async () => {
    const { storage } = memoryStorage();
    const { client, request: send } = fakeClient(fail(403, 'reauth_required'));
    const flow = createReauthFlow({ client, storage, now: Date.now, navigate: vi.fn() });
    flow.requireReauth(request, { credential: false, secretFields: ['secret'] }, '#/tokens');
    flow.restore();
    await flow.confirm();
    expect(send).toHaveBeenCalledTimes(1);
    expect(flow.snapshot()).toMatchObject({ dialog: 'closed', outcome: 'failed' });
  });

  it('opens no dialog when nothing is pending', () => {
    const { storage } = memoryStorage();
    const flow = createReauthFlow({
      client: fakeClient().client,
      storage,
      now: Date.now,
      navigate: vi.fn(),
    });
    flow.restore();
    expect(flow.snapshot().dialog).toBe('closed');
  });

  it('renders the confirm dialog with method and path but not the body', () => {
    const html = renderToString(
      createElement(ReauthConfirmContent, {
        action: {
          method: 'POST',
          path: '/_pb/projects/p/tokens',
          body: { name: SENTINEL },
          savedAt: 1,
        },
        onConfirm: () => undefined,
        onDecline: () => undefined,
      }),
    );
    expect(html).toContain('Send the held action now?');
    expect(html).toContain('POST');
    expect(html).toContain('/_pb/projects/p/tokens');
    expect(html).not.toContain(SENTINEL);
  });

  it.each(['browser-archive', 'another-project'])(
    'names the restored project %s in the visible confirmation summary',
    (slug) => {
      const html = renderToString(
        createElement(ReauthConfirmContent, {
          action: {
            method: 'POST',
            path: `/_pb/projects/${slug}/restore`,
            savedAt: 1,
          },
          onConfirm: vi.fn(),
          onDecline: vi.fn(),
        }),
      );
      const summary = html.match(/<dl\b[^>]*>([\s\S]*?)<\/dl>/)?.[1];
      expect(summary).toContain('<dt>Action</dt><dd class="font-medium">Restore project</dd>');
      expect(summary).toContain(`<dt>Project</dt><dd>${slug}</dd>`);
      expect(summary).toContain('<dt>Scope</dt><dd>Project</dd>');
      expect(summary).toContain('<dt>Effect</dt><dd>Restore this archived project.</dd>');
      expect(summary).not.toContain('<dt>Version</dt>');
      expect(html).toMatch(/<button[^>]*>Restore project<\/button>/);
    },
  );

  it('stays on the current page with a recoverable error when persistence fails', () => {
    const { storage } = memoryStorage();
    storage.setItem = () => {
      throw new Error('blocked');
    };
    const navigate = vi.fn();
    const flow = createReauthFlow({
      client: fakeClient().client,
      storage,
      now: Date.now,
      navigate,
    });
    flow.requireReauth(request, { credential: false, secretFields: ['secret'] }, '#/tokens');
    expect(navigate).not.toHaveBeenCalled();
    const html = renderToString(createElement(ReauthConfirm, { flow }));
    expect(html).toContain('could not be saved');
    expect(html).toContain('Try the action again');
  });

  it.each([0, 409, 412])('renders replay failure %s with a recovery action', async (status) => {
    const { storage } = memoryStorage();
    const { client } = fakeClient(fail(status));
    const flow = createReauthFlow({ client, storage, now: Date.now, navigate: vi.fn() });
    flow.requireReauth(request, { credential: false, secretFields: ['secret'] }, '#/tokens');
    flow.restore();
    await flow.confirm();
    const html = renderToString(createElement(ReauthConfirm, { flow }));
    expect(html).toContain('could not be completed');
    expect(html).toContain('Review the current data');
    expect(html).toContain('Dismiss');
    flow.decline();
    expect(renderToString(createElement(ReauthConfirm, { flow }))).not.toContain(
      'could not be completed',
    );
  });

  it('submits local reauth and then reports done without keeping the password', async () => {
    const { storage } = memoryStorage();
    const { client, request: send } = fakeClient(ok());
    const flow = createReauthFlow({ client, storage, now: Date.now, navigate: vi.fn() });
    expect(await flow.submitLocal({ password: SENTINEL, code: CODE })).toBe('done');
    expect(send).toHaveBeenCalledWith('post', '/_pb/auth/local/reauth', {
      body: { password: SENTINEL, code: CODE },
    });
    expect(JSON.stringify(flow.snapshot())).not.toContain(SENTINEL);
  });

  it('reports a refused local reauth', async () => {
    const { storage } = memoryStorage();
    const { client } = fakeClient(fail(401));
    const flow = createReauthFlow({ client, storage, now: Date.now, navigate: vi.fn() });
    expect(await flow.submitLocal({ password: SENTINEL, code: CODE })).toBe('refused');
  });
});

describe('first-run setup', () => {
  const TOKEN = 'T'.repeat(43);

  it('rejects a token of the wrong shape without a request', async () => {
    const { client, request } = fakeClient();
    const setup = createSetupController({ client });
    await setup.submitToken('short');
    expect(setup.snapshot()).toMatchObject({ stage: 'token', notice: 'bad_token_shape' });
    expect(request).not.toHaveBeenCalled();
  });

  it('moves to enrollment when the broker accepts the token', async () => {
    const { client } = fakeClient(
      ok(200, { provisioningUri: 'otpauth://totp/x?secret=ABC', secret: 'ABC' }),
    );
    const setup = createSetupController({ client });
    await setup.submitToken(TOKEN);
    expect(setup.snapshot()).toMatchObject({ stage: 'enroll', notice: null });
    expect(setup.snapshot().enrollment?.secret).toBe('ABC');
  });

  it('shows one refusal when the token is not accepted', async () => {
    const { client } = fakeClient(fail(401));
    const setup = createSetupController({ client });
    await setup.submitToken(TOKEN);
    expect(setup.snapshot()).toMatchObject({ stage: 'token', notice: 'token_refused' });
  });

  it('finishes and then holds neither token, password nor secret', async () => {
    const { client, request } = fakeClient(
      ok(200, { provisioningUri: 'otpauth://totp/x?secret=ABC', secret: 'ABC' }),
      ok(),
    );
    const onSignedIn = vi.fn();
    const setup = createSetupController({ client, onSignedIn });
    await setup.submitToken(TOKEN);
    await setup.finish({ password: SENTINEL, confirmation: SENTINEL, code: CODE });
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(setup.snapshot()).toMatchObject({ stage: 'done', enrollment: null });
    expect(request).toHaveBeenLastCalledWith('post', '/_pb/auth/local/setup/finish', {
      body: { token: TOKEN, password: SENTINEL, code: CODE },
    });
    const state = everything(setup);
    for (const secret of [SENTINEL, TOKEN, CODE, 'ABC']) expect(state).not.toContain(secret);
    const html = renderToString(
      createElement(SetupView, {
        state: setup.snapshot(),
        onToken: () => undefined,
        onFinish: () => undefined,
      }),
    );
    for (const secret of [SENTINEL, TOKEN, 'ABC']) expect(html).not.toContain(secret);
  });

  it('refuses mismatching confirmation without a request', async () => {
    const { client, request } = fakeClient(
      ok(200, { provisioningUri: 'otpauth://totp/x?secret=ABC', secret: 'ABC' }),
    );
    const setup = createSetupController({ client });
    await setup.submitToken(TOKEN);
    await setup.finish({ password: SENTINEL, confirmation: 'other', code: CODE });
    expect(setup.snapshot().notice).toBe('password_mismatch');
    expect(request).toHaveBeenCalledTimes(1);
    expect(everything(setup)).not.toContain(SENTINEL);
  });
});

describe('CSP bundle', () => {
  it.each(['./components/ui/dialog.tsx', './main.tsx'])(
    'excludes runtime style injectors from %s',
    async (entry) => {
      const { build } = await import('esbuild');
      const { fileURLToPath } = await import('node:url');
      const result = await build({
        entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
        bundle: true,
        write: false,
        metafile: true,
        platform: 'browser',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      expect(Object.keys(result.metafile!.inputs).join('\n')).not.toMatch(
        /react-remove-scroll|react-style-singleton/,
      );
    },
  );
});

describe('SSO return route', () => {
  it('carries the validated route and project through a login round trip', async () => {
    const { client, request } = fakeClient(ok(200, { location: 'https://idp.test/auth' }));
    await startSso(client, 'corp', 'login', vi.fn(), '#/tokens?project=acme');
    expect(request).toHaveBeenCalledWith(
      'post',
      '/_pb/auth/sso/{provider}/start',
      expect.objectContaining({
        body: { purpose: 'login', returnTo: '/_pb/ui#/tokens?project=acme' },
      }),
    );
  });
  it('carries reauth completion and the scoped return route through SSO', async () => {
    const { client, request } = fakeClient(ok(200, { location: 'https://idp.test/auth' }));
    await startSso(client, 'corp', 'reauth', vi.fn(), '#/reauth?return=%2Ftokens%3Fproject%3Dacme');
    expect(request).toHaveBeenCalledWith(
      'post',
      '/_pb/auth/sso/{provider}/start',
      expect.objectContaining({
        body: {
          purpose: 'reauth',
          returnTo: '/_pb/ui#/reauth?return=%2Ftokens%3Fproject%3Dacme&sso=complete',
        },
      }),
    );
  });
  it.each(['https://evil.test/#/tokens', '//evil.test', '#//evil.test', '#/unknown'])(
    'replaces unsafe or unrecognized hash input %s with a broker-local route',
    async (hash) => {
      const { client, request } = fakeClient(ok(200, { location: 'https://idp.test/auth' }));
      await startSso(client, 'corp', 'login', vi.fn(), hash);
      expect(request).toHaveBeenCalledWith(
        'post',
        '/_pb/auth/sso/{provider}/start',
        expect.objectContaining({
          body: { purpose: 'login', returnTo: '/_pb/ui#/projects' },
        }),
      );
    },
  );
});

it('rejects a hash with a trailing control character before SSO', async () => {
  const { client, request } = fakeClient(ok(200, { location: 'https://idp.test/auth' }));
  await startSso(client, 'corp', 'login', vi.fn(), '#/tokens\n');
  expect(request).toHaveBeenCalledWith(
    'post',
    '/_pb/auth/sso/{provider}/start',
    expect.objectContaining({
      body: { purpose: 'login', returnTo: '/_pb/ui#/projects' },
    }),
  );
});

it('retains project scope when starting SSO on the login route', async () => {
  const { client, request } = fakeClient(ok(200, { location: 'https://idp.test/auth' }));
  await startSso(client, 'corp', 'login', vi.fn(), '#/login?project=acme');
  expect(request).toHaveBeenCalledWith(
    'post',
    '/_pb/auth/sso/{provider}/start',
    expect.objectContaining({
      body: { purpose: 'login', returnTo: '/_pb/ui#/projects?project=acme' },
    }),
  );
});

describe('package reauth integration', () => {
  it.each([
    { project: 'web', source: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    { projectId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', source: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
  ])('keeps package-specific filters through reauth and SSO: %j', async (scope) => {
    const hash = buildListFilterHash('packages', {
      ...scope,
      status: 'active',
      q: '@scope/pkg & tool',
      after: 'opaque/+=',
    });
    const navigate = vi.fn();
    const { client, request } = fakeClient(
      ok(200, { location: '/idp' }),
      ok(200, { location: '/idp' }),
    );
    const reauthHash = `#/reauth?return=${encodeURIComponent(hash.slice(1))}`;
    expect(reauthReturnHash(reauthHash)).toBe(hash);
    expect(Object.fromEntries(new URLSearchParams(hash.split('?')[1]))).toMatchObject(scope);
    await startSso(client, 'corp', 'login', navigate, hash);
    expect(request.mock.calls[0]![2]).toMatchObject({ body: { returnTo: `/_pb/ui${hash}` } });
    await startSso(client, 'corp', 'reauth', navigate, reauthHash);
    const returnTo = (request.mock.calls[1]![2] as { body: { returnTo: string } }).body.returnTo;
    expect(reauthReturnHash(returnTo.slice(returnTo.indexOf('#')))).toBe(hash);
  });
  it.each(['source=unknown', 'projectId=unknown'])(
    'drops an invalid package return filter: %s',
    (query) => {
      expect(reauthReturnHash(`#/reauth?return=${encodeURIComponent(`/packages?${query}`)}`)).toBe(
        '#/packages',
      );
    },
  );
  it('preserves package filters and opaque cursor through the reauth return URL', () => {
    const hash =
      '#/packages?project=web&status=active&source=01ARZ3NDEKTSV4RRFFQ69G5FAV&q=%40example&after=npm%3A%2B%2F%25%3F%3D';
    expect(reauthReturnHash(`#/reauth?return=${encodeURIComponent(hash.slice(1))}`)).toBe(hash);
  });
  it.each([200, 404, 409])(
    'publishes only path, outcome and a closed error code after a replay returns %s',
    async (status) => {
      const { storage } = memoryStorage();
      const { client } = fakeClient(status === 200 ? ok(200) : fail(status), ok(200));
      const flow = createReauthFlow({ client, storage, now: Date.now, navigate: vi.fn() });
      const listener = vi.fn();
      const unsubscribe = flow.subscribeReplay(listener);
      flow.requireReauth(
        { method: 'POST', path: '/_pb/packages/p/versions/v/tombstone', body: {} },
        { credential: false, secretFields: [] },
        '#/packages',
      );
      flow.restore();
      expect(listener).not.toHaveBeenCalled();
      await flow.confirm();
      expect(listener).toHaveBeenCalledExactlyOnceWith({
        path: '/_pb/packages/p/versions/v/tombstone',
        ok: status === 200,
        status,
        ...(status === 200 ? {} : { code: 'unauthorized' }),
      });
      unsubscribe();
      listener.mockClear();
      flow.requireReauth(
        { method: 'POST', path: '/_pb/packages/p/versions/v/tombstone', body: {} },
        { credential: false, secretFields: [] },
        '#/packages',
      );
      flow.restore();
      await flow.confirm();
      expect(listener).not.toHaveBeenCalled();
    },
  );
});

it('drops unknown package return filters and invalid project scopes', () => {
  const target = '/packages?project=%2F%2Foutside.invalid&redirect=https%3A%2F%2Foutside.invalid';
  expect(reauthReturnHash(`#/reauth?return=${encodeURIComponent(target)}`)).toBe('#/packages');
});

describe('sign-in availability copy', () => {
  it.each(['loading', 'error'] as const)(
    'hides unconfirmed login and reauth forms during %s',
    (availability) => {
      for (const view of [
        createElement(LoginView, {
          state: { status: 'idle', error: null },
          providers: [],
          local: true,
          availability,
          onSubmit: vi.fn(),
          onSso: vi.fn(),
        }),
        createElement(ReauthView, {
          error: false,
          busy: false,
          providers: [],
          local: true,
          availability,
          onSubmit: vi.fn(),
          onSso: vi.fn(),
        }),
      ]) {
        const html = renderToString(view);
        expect(html).not.toContain('<form');
        expect(html).not.toContain('name="password"');
        expect(html).toContain(
          availability === 'loading' ? 'Loading sign-in options' : 'Reload the page',
        );
      }
    },
  );

  it('offers help when none of the providers support reauthentication', () => {
    const html = renderToString(
      createElement(ReauthView, {
        error: false,
        busy: false,
        providers: [{ id: 'corp', displayName: 'Corp SSO', kind: 'oidc', supportsReauth: false }],
        local: false,
        onSubmit: vi.fn(),
        onSso: vi.fn(),
      }),
    );
    expect(html).toContain('Contact your administrator for help signing in.');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Confirm with');
    expect(html).not.toContain('Signed in with a password?');
  });

  it.each([false, true])(
    'shows password-session guidance only with local disabled (%s)',
    (local) => {
      const html = renderToString(
        createElement(ReauthView, {
          error: false,
          busy: false,
          providers: [
            { id: 'corp', displayName: 'Corp SSO', kind: 'oidc', supportsReauth: true },
            { id: 'other', displayName: 'Other SSO', kind: 'oidc', supportsReauth: false },
          ],
          local,
          onSubmit: vi.fn(),
          onSso: vi.fn(),
        }),
      ).replace(/<!-- -->/g, '');
      const copy = 'Signed in with a password? Sign out and sign in with Corp SSO to continue.';
      if (local) expect(html).not.toContain(copy);
      else {
        expect(html).toContain(copy);
        expect(html.indexOf(copy)).toBeGreaterThan(html.indexOf('Confirm with'));
      }
      expect(html).not.toContain('sign in with Other SSO');
    },
  );

  it('offers plain help when no sign-in method is listed', () => {
    const html = renderToString(
      createElement(LoginView, {
        state: { status: 'idle', error: null },
        providers: [],
        local: false,
        onSubmit: vi.fn(),
        onSso: vi.fn(),
      }),
    );
    expect(html).toContain('Contact your administrator for help signing in.');
    expect(html).not.toContain('<form');
  });
});

describe('local policy changes after availability loads', () => {
  it('switches login to disabled without an invalid-credentials error', async () => {
    const { client, request } = fakeClient(fail(403, 'local_auth_disabled'));
    const onSignedIn = vi.fn();
    const login = createLoginController({ client, onSignedIn });
    await login.submit({ email: 'a@example.test', password: SENTINEL, code: CODE });
    expect(login.snapshot()).toMatchObject({ error: 'disabled' });
    const html = renderToString(
      createElement(LoginView, {
        state: login.snapshot(),
        local: true,
        providers: [],
        onSubmit: vi.fn(),
        onSso: vi.fn(),
      }),
    );
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Sign-in failed');
    expect(html).toContain('Contact your administrator');
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('distinguishes disabled reauth from invalid credentials', async () => {
    const { client } = fakeClient(fail(403, 'local_auth_disabled'));
    const flow = createReauthFlow({
      client,
      storage: memoryStorage().storage,
      now: Date.now,
      navigate: vi.fn(),
    });
    expect(await flow.submitLocal({ password: SENTINEL, code: CODE })).toBe('disabled');
    expect(everything(flow)).not.toContain(SENTINEL);
  });

  it.each(['start', 'finish'] as const)('closes React setup when %s is disabled', async (step) => {
    const { client, request } = fakeClient(
      ...(step === 'finish'
        ? [ok(200, { provisioningUri: 'otpauth://totp/test?secret=ABC', secret: 'ABC' })]
        : []),
      fail(403, 'local_auth_disabled'),
    );
    const onSignedIn = vi.fn();
    const setup = createSetupController({ client, onSignedIn });
    await setup.submitToken('T'.repeat(43));
    if (step === 'finish')
      await setup.finish({ password: SENTINEL, confirmation: SENTINEL, code: CODE });
    expect(setup.snapshot()).toMatchObject({
      stage: 'disabled',
      busy: false,
      notice: null,
      enrollment: null,
    });
    const calls = request.mock.calls.length;
    await setup.submitToken('T'.repeat(43));
    await setup.finish({ password: SENTINEL, confirmation: SENTINEL, code: CODE });
    expect(request).toHaveBeenCalledTimes(calls);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it.each([
    ['ready', "Sign in with your organization's account"],
    ['error', 'Setup is unavailable'],
  ] as const)('keeps the setup title and availability heading for %s', (availability, title) => {
    const html = renderToString(
      createElement(SetupAvailabilityView, { availability, local: false, providers: [] }),
    );
    expect(html.replace(/&#x27;/g, "'")).toContain(title);
    expect(html).toMatch(/<h1[^>]*>First-run setup<\/h1>/);
    expect(html).toContain('/_pb/ui/#/login');
    expect(html).not.toContain('<form');
  });

  it('renders one password-session hint naming both eligible providers', () => {
    const html = renderToString(
      createElement(ReauthView, {
        error: false,
        busy: false,
        local: false,
        providers: ['Dex', 'Okta'].map((displayName) => ({
          id: displayName,
          displayName,
          kind: 'oidc',
          supportsReauth: true,
        })),
        onSubmit: vi.fn(),
        onSso: vi.fn(),
      }),
    ).replace(/<!-- -->/g, '');
    expect(html.match(/Signed in with a password\?/g)).toHaveLength(1);
    expect(html).toContain(
      'Signed in with a password? Sign out and sign in with Dex or Okta to continue.',
    );
  });
});

describe('SSO confirmation recovery', () => {
  it.each([true, false])('hides unsupported providers and shows recovery (local=%s)', (local) => {
    const html = renderToString(
      createElement(ReauthView, {
        providers: [
          { id: 'old', displayName: 'Old Dex', kind: 'oidc', supportsReauth: false },
          { id: 'new', displayName: 'New Dex', kind: 'oidc', supportsReauth: true },
        ],
        local,
        busy: false,
        error: false,
        onSubmit: vi.fn(),
        onSso: vi.fn(),
      }),
    );
    expect(html).not.toContain('Old Dex');
    expect(html.replaceAll('<!-- -->', '')).toContain('Confirm with New Dex');
    expect(html).toContain('Sign out and sign in again');
    expect(html).toContain('within 10 minutes');
    expect(html.includes('local sign-in form')).toBe(local);
  });
  it('renders a readable callback failure and never echoes arbitrary reason data', () => {
    const html = renderToString(
      createElement(SigninFailedView, { reason: 'no_auth_time', signedIn: true }),
    );
    expect(html).toContain('did not confirm a fresh sign-in');
    expect(html).toContain('Return to confirmation');
    expect(ssoFailureMessage('secret@example.test')).not.toContain('secret@example.test');
    expect(ssoFailureMessage('state_invalid')).toContain('expired');
    expect(ssoFailureMessage('stale_auth_time')).toContain('older sign-in');
  });
});

it.each([
  ['/tokens?project=acme', '#/tokens?project=acme'],
  ['/packages?project=web&status=active', '#/packages?project=web&status=active'],
  ['//outside.invalid', '#/projects'],
  ['/tokens?redirect=https://outside.invalid', '#/tokens'],
])('keeps a safe retry target from callback failure: %s', async (target, expected) => {
  const hash = `#/signin-failed?reason=no_auth_time&return=${encodeURIComponent(target)}`;
  const html = renderToString(
    createElement(SigninFailedView, { reason: 'no_auth_time', signedIn: true, hash }),
  );
  const retryHash = `#/reauth?return=${encodeURIComponent(expected.slice(1))}`;
  expect(html).toContain(`href="${retryHash}"`);
  const { client, request } = fakeClient(ok(200, { location: '/idp' }));
  await startSso(client, 'corp', 'reauth', vi.fn(), retryHash);
  const returnTo = (request.mock.calls[0]![2] as { body: { returnTo: string } }).body.returnTo;
  expect(reauthReturnHash(returnTo.slice(returnTo.indexOf('#')))).toBe(expected);
});
