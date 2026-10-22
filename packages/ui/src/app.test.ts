import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  App,
  ScopeSwitcher,
  checkSession,
  PAGES,
  ROUTES,
  Shell,
  buildHash,
  parseHash,
  resolveRoute,
  scopeOptions,
  loadProjects,
  signOut,
} from './app.js';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.js';
import { createReauthFlow, type AuthClient } from './auth.js';

const PAGE_ROUTES = ['projects', 'access', 'sources', 'packages', 'tokens', 'audit', 'import'];

describe('hash routes', () => {
  it('lists every route of the shell', () => {
    for (const route of [...PAGE_ROUTES, 'login', 'setup']) expect(ROUTES).toContain(route);
  });

  it('maps every page route to a component', () => {
    for (const route of PAGE_ROUTES) {
      expect(typeof PAGES[route as keyof typeof PAGES]).toBe('function');
      expect(resolveRoute(`#/${route}`, true).route).toBe(route);
    }
  });

  it('falls back to projects when signed in and to login otherwise', () => {
    expect(resolveRoute('#/nope', true)).toMatchObject({ route: 'projects', unknown: '/nope' });
    expect(resolveRoute('#/nope', false)).toMatchObject({ route: 'login', unknown: '/nope' });
    expect(resolveRoute('', true)).toMatchObject({ route: 'projects', unknown: null });
    expect(resolveRoute('', false)).toMatchObject({ route: 'login', unknown: null });
  });

  it('sends a signed-out visitor from a page route to login but leaves setup reachable', () => {
    expect(resolveRoute('#/tokens', false).route).toBe('login');
    expect(resolveRoute('#/setup', false).route).toBe('setup');
  });

  it('sends a signed-in visitor from login to projects', () => {
    expect(resolveRoute('#/login', true).route).toBe('projects');
  });

  it('reads the project scope from the hash query', () => {
    expect(parseHash('#/tokens?project=acme-web').project).toBe('acme-web');
    expect(parseHash('#/tokens').project).toBeNull();
  });

  it('ignores a project scope that is not a plain slug', () => {
    expect(parseHash('#/tokens?project=%3Cimg%20onerror%3D1%3E').project).toBeNull();
    expect(parseHash(`#/tokens?project=${'a'.repeat(200)}`).project).toBeNull();
  });

  it('builds hashes that parse back', () => {
    expect(buildHash('tokens', 'acme')).toBe('#/tokens?project=acme');
    expect(buildHash('tokens', null)).toBe('#/tokens');
    expect(parseHash(buildHash('audit', 'a.b_c')).project).toBe('a.b_c');
  });
});

describe('scope switcher options', () => {
  it('offers the organization first and then only active projects', () => {
    const options = scopeOptions([
      { id: '1', name: 'Alpha', slug: 'alpha', status: 'active' },
      { id: '2', name: 'Old', slug: 'old', status: 'archived' },
    ]);
    expect(options).toEqual([
      { value: '__organization__', label: 'Organization' },
      { value: 'alpha', label: 'Alpha' },
    ]);
  });
});

describe('shell markup', () => {
  const base = {
    route: 'projects' as const,
    project: null,
    projects: [],
    unknown: null,
    onScope: () => undefined,
    onSignOut: () => undefined,
  };

  it('renders hash text as escaped text, never as markup', () => {
    const html = renderToString(
      createElement(Shell, { ...base, unknown: '/<img onerror=alert(1)>' }, 'content'),
    );
    expect(html).toContain('&lt;img onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('shows the scope switcher and the page content', () => {
    const html = renderToString(createElement(Shell, base, 'page-body'));
    expect(html).toContain('Scope');
    expect(html).toContain('page-body');
  });

  it('emits no script or style elements', () => {
    const html = renderToString(createElement(Shell, base, 'x'));
    expect(html).not.toMatch(/<(script|style)\b/i);
  });
});

describe('shell requests', () => {
  it('loads every project page using the opaque after cursor', async () => {
    const first = { id: '1', slug: 'one', name: 'One', status: 'active' };
    const second = { id: '2', slug: 'two', name: 'Two', status: 'active' };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { items: [first], next: 'opaque/+=' } })
      .mockResolvedValueOnce({ ok: true, data: { items: [second], next: null } });
    expect(await loadProjects({ request } as unknown as AuthClient)).toEqual([first, second]);
    expect(request.mock.calls).toEqual([
      ['get', '/_pb/projects'],
      ['get', '/_pb/projects', { query: { after: 'opaque/+=' } }],
    ]);
  });

  it.each([0, 403, 500])('keeps the signed-in state when logout fails with %s', async (status) => {
    const client = {
      request: vi.fn().mockResolvedValue({ ok: false, status }),
    } as unknown as AuthClient;
    const clear = vi.fn();
    const onSignedOut = vi.fn();
    expect(await signOut({ client, clearPending: clear, onSignedOut })).toBe(false);
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    const html = renderToString(
      createElement(Shell, {
        route: 'projects',
        project: null,
        projects: [],
        unknown: null,
        onScope: vi.fn(),
        onSignOut: vi.fn(),
        signOutError: true,
      }),
    );
    expect(html).toContain('Sign-out failed');
  });

  it.each(['persisted', 'restored'])(
    'clears the %s pending action after successful logout',
    async (phase) => {
      const entries = new Map<string, string>();
      const storage = {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => void entries.set(key, value),
        removeItem: (key: string) => void entries.delete(key),
      };
      const send = vi.fn().mockResolvedValue({ ok: true });
      const client = { request: send } as unknown as AuthClient;
      const flow = createReauthFlow({ client, storage, now: Date.now, navigate: vi.fn() });
      flow.requireReauth(
        { method: 'DELETE', path: '/_pb/projects/p' },
        { credential: false, secretFields: [] },
        '#/projects',
      );
      if (phase === 'restored') flow.restore();
      const onSignedOut = vi.fn();
      expect(await signOut({ client, clearPending: () => flow.clear(), onSignedOut })).toBe(true);
      expect(entries.size).toBe(0);
      expect(flow.snapshot()).toMatchObject({ action: null, dialog: 'closed' });
      flow.restore();
      await flow.confirm();
      expect(send).toHaveBeenCalledTimes(1);
      expect(onSignedOut).toHaveBeenCalledOnce();
    },
  );
});

describe('anonymous entry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['', '#/login', '#/tokens?project=acme', '#/setup'])(
    'renders an auth screen immediately at %s without waiting for a session request',
    (hash) => {
      const request = vi.fn();
      vi.stubGlobal('window', { location: { hash }, sessionStorage: {} });
      const html = renderToString(
        createElement(App, { client: { request } as unknown as AuthClient }),
      );
      expect(html).toContain(hash === '#/setup' ? 'First-run setup' : 'Sign in');
      expect(html).not.toContain('Loading…');
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('renders when obtaining sessionStorage throws', () => {
    vi.stubGlobal('window', {
      location: { hash: '' },
      get sessionStorage() {
        throw new Error('blocked');
      },
    });
    expect(() =>
      renderToString(
        createElement(App, {
          client: { request: vi.fn() } as unknown as AuthClient,
        }),
      ),
    ).not.toThrow();
  });
});

describe('native scope control', () => {
  it('renders a labelled select with the current project selected and no inline styles', () => {
    const html = renderToString(
      createElement(ScopeSwitcher, {
        project: 'acme',
        projects: [{ id: 'p', name: 'Acme', slug: 'acme', status: 'active' }],
        onScope: vi.fn(),
      }),
    );
    expect(html).toContain('<select');
    expect(html).toMatch(/<option value="acme" selected="">Acme<\/option>/);
    expect(html).not.toMatch(/\sstyle=|<style\b/);
  });
});

describe('session restoration', () => {
  const returned = '#/reauth?return=%2Ftokens%3Fproject%3Dacme&sso=complete';
  it.each(['', '#/login', '#/tokens?project=acme', '#/reauth?return=%2Ftokens'])(
    'does not restore a pending action on an ordinary session check at %s',
    async (hash) => {
      const flow = { restore: vi.fn() };
      const client = {
        request: vi.fn().mockResolvedValue({ ok: true, data: { reauthFresh: true } }),
      } as unknown as AuthClient;
      expect(await checkSession(client, flow, hash)).toBe('in');
      expect(flow.restore).not.toHaveBeenCalled();
    },
  );
  it('restores after a successful SSO reauth return with a fresh session', async () => {
    const flow = { restore: vi.fn() };
    const client = {
      request: vi.fn().mockResolvedValue({ ok: true, data: { reauthFresh: true } }),
    } as unknown as AuthClient;
    expect(await checkSession(client, flow, returned)).toBe('in');
    expect(flow.restore).toHaveBeenCalledOnce();
  });
  it.each([
    { ok: false, status: 401 },
    { ok: true, data: { reauthFresh: false } },
  ])('does not restore after unsuccessful reauthentication: %j', async (reply) => {
    const flow = { restore: vi.fn() };
    const client = { request: vi.fn().mockResolvedValue(reply) } as unknown as AuthClient;
    await checkSession(client, flow, returned);
    expect(flow.restore).not.toHaveBeenCalled();
  });
});

it('uses a native disclosure for account actions without inline styles', () => {
  const html = renderToString(
    createElement(
      DropdownMenu,
      null,
      createElement(DropdownMenuTrigger, null, 'Account'),
      createElement(
        DropdownMenuContent,
        null,
        createElement(DropdownMenuItem, { onClick: vi.fn() }, 'Sign out'),
      ),
    ),
  );
  expect(html).toContain('<details');
  expect(html).toContain('<summary');
  expect(html).not.toMatch(/\sstyle=|<style\b/);
});

it.each([true, false])(
  'returns to the scoped route only when SSO reauth freshness is %s',
  async (reauthFresh) => {
    const client = {
      request: vi.fn().mockResolvedValue({ ok: true, data: { reauthFresh } }),
    } as unknown as AuthClient;
    const onReauthenticated = vi.fn();
    await checkSession(
      client,
      { restore: vi.fn() },
      '#/reauth?return=%2Ftokens%3Fproject%3Dacme&sso=complete',
      onReauthenticated,
    );
    if (reauthFresh) expect(onReauthenticated).toHaveBeenCalledWith('#/tokens?project=acme');
    else expect(onReauthenticated).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'ignores a superseded startup session check (authenticated: %s)',
  async (ok) => {
    let finish!: (value: unknown) => void;
    const client = {
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    } as unknown as AuthClient;
    let current = true;
    const flow = { restore: vi.fn() };
    const navigate = vi.fn();
    const pending = checkSession(
      client,
      flow,
      '#/reauth?return=%2Ftokens&sso=complete',
      navigate,
      () => current,
    );
    current = false;
    finish({ ok, data: { reauthFresh: true } });
    expect(await pending).toBeNull();
    expect(flow.restore).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  },
);
