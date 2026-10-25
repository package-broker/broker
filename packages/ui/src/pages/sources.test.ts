import { SOURCE_ERROR_CODES } from '@package-broker/core/sources/source-error-codes';
import { SYNC_ERROR_LABELS } from './sources.js';
import { PROXY_DEMAND_MESSAGE } from './sources/proxy-message.js';
import { createElement, isValidElement, type ReactNode, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DropdownMenu } from '../components/ui/dropdown-menu.js';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import { createReauthFlow, type ShellServices } from '../auth.js';
import { loadPending } from '../pending.js';
import {
  createSourcesModel,
  filterSources,
  sourceCredentialKind,
  SourceActions,
  CredentialFields,
  SourcesView,
  submitCredential,
  type Source,
} from './sources.js';

const SOURCE = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SECRET = 'credential-sentinel-DO-NOT-RETAIN';
const NOW = '2026-10-22T10:00:00.000Z';
const source: Source = {
  id: SOURCE,
  projectId: null,
  name: 'Private packages',
  ecosystem: 'npm',
  type: 'npm_registry',
  url: 'https://registry.example/packages',
  status: 'active',
  removalPolicy: 'flag',
  pollIntervalSeconds: 300,
  lastSuccessAt: null,
  lastError: null,
  lastPolledAt: null,
  nextPollAt: null,
  hasCredential: false,
  lastRemovalRefusal: null,
  removalAcceptanceArmed: false,
  attachedProjectCount: 3,
  projectName: null,
};
const json = (data: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });

function setup(
  fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  project: string | null = null,
  organizationPermissions = ['org:sources:write'],
) {
  const permissionsFetch = vi.fn(() =>
    Promise.resolve(json({ organization: organizationPermissions })),
  );
  const client = createApiClient<paths>({
    fetch: (input, init) =>
      input === '/_pb/me/permissions' ? permissionsFetch() : fetch(input, init),
    readCookie: () => undefined,
  });
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  const navigate = vi.fn();
  const flow = createReauthFlow({ client, storage, now: Date.now, navigate });
  const requireReauth = vi.fn<ShellServices['requireReauth']>((request, options) =>
    flow.requireReauth(request, options, '#/sources?project=acme'),
  );
  const model = createSourcesModel({ client, requireReauth }, project, () => NOW);
  const html = () => renderToString(createElement(SourcesView, { model }));
  return { model, fetch, permissionsFetch, entries, storage, flow, requireReauth, navigate, html };
}

function credentialForm() {
  const material = { value: SECRET };
  const form = {
    elements: {
      namedItem: (name: string) => (name === 'token' ? material : { value: 'bearer' }),
    },
    reset: vi.fn(() => {
      material.value = '';
    }),
  };
  return { form, material };
}

describe('source credentials', () => {
  it('clears the form and replaces state before starting the request, sends once, then shows only local save time', async () => {
    let finish!: (response: Response) => void;
    const { form, material } = credentialForm();
    const fetch = vi.fn(() => {
      expect(material.value).toBe('');
      expect(model.snapshot().credentialVersion).toBe(1);
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const { model, html } = setup(fetch);
    const before = model.snapshot();
    const pending = submitCredential(model, SOURCE, form);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject([
      `/_pb/sources/${SOURCE}/credential`,
      {
        method: 'PUT',
        body: JSON.stringify({ kind: 'bearer', material: JSON.stringify({ token: SECRET }) }),
        credentials: 'same-origin',
        redirect: 'error',
      },
    ]);
    expect(material.value).toBe('');
    expect(model.snapshot()).not.toBe(before);
    expect(JSON.stringify(model.snapshot())).not.toContain(SECRET);
    expect(html()).not.toContain(SECRET);
    expect(html()).toMatch(/type="password"[^>]*autoComplete="off"[^>]*value=""/);
    finish(new Response(null, { status: 204 }));
    await pending;
    expect(JSON.stringify(model.snapshot())).not.toContain(SECRET);
    expect(html()).not.toContain(SECRET);
    expect(html()).toContain('credential set');
    expect(html()).toContain(NOW);
  });

  it('drops a hostile credential success body instead of retaining or rendering it', async () => {
    const { model, html } = setup(
      vi.fn().mockResolvedValue(json({ material: SECRET, length: SECRET.length })),
    );
    await submitCredential(model, SOURCE, credentialForm().form);
    expect(JSON.stringify(model.snapshot())).not.toContain(SECRET);
    expect(html()).not.toContain(SECRET);
    expect(model.snapshot().savedCredential).toEqual({ source: SOURCE, at: NOW });
  });

  it('stores no credential body after reauth_required and requires re-entry', async () => {
    const { model, entries, storage, flow, requireReauth } = setup(
      vi.fn().mockResolvedValue(json({ error: { code: 'reauth_required', message: SECRET } }, 403)),
    );
    await submitCredential(model, SOURCE, credentialForm().form);
    expect(requireReauth).toHaveBeenCalledWith(
      { method: 'PUT', path: `/_pb/sources/${SOURCE}/credential` },
      { credential: true, secretFields: [] },
    );
    expect(entries.size).toBe(1);
    const raw = [...entries.values()].join('');
    expect(raw).not.toContain(SECRET);
    expect(JSON.parse(raw)).not.toHaveProperty('body');
    expect(JSON.parse(raw)).toHaveProperty('requiresCredential', true);
    flow.restore();
    expect(flow.snapshot().outcome).toBe('credential-required');
    expect(flow.snapshot().action).toBeNull();
    expect(loadPending(storage, Date.now())).toEqual({ ok: true, action: null });
  });

  it.each([400, 403, 404, 409])(
    'never renders a hostile %s credential failure or restores its input',
    async (status) => {
      const { model, html } = setup(
        vi.fn().mockResolvedValue(
          json(
            {
              error: {
                code:
                  status === 400
                    ? 'invalid_request'
                    : status === 403
                      ? 'forbidden'
                      : status === 404
                        ? 'not_found'
                        : 'conflict',
                message: SECRET,
                details: [{ path: SECRET, code: 'invalid' }],
              },
            },
            status,
          ),
        ),
      );
      const { form, material } = credentialForm();
      await submitCredential(model, SOURCE, form);
      expect(material.value).toBe('');
      expect(model.snapshot().error).toBeTruthy();
      expect(JSON.stringify(model.snapshot())).not.toContain(SECRET);
      expect(html()).not.toContain(SECRET);
      expect(model.snapshot().savedCredential).toBeNull();
    },
  );

  it('keeps transport exceptions out of state and markup', async () => {
    const { model, html } = setup(vi.fn().mockRejectedValue(new Error(SECRET)));
    await submitCredential(model, SOURCE, credentialForm().form);
    expect(model.snapshot().error).toBeTruthy();
    expect(JSON.stringify(model.snapshot()) + html()).not.toContain(SECRET);
  });

  it('does not submit a second credential while a write is in flight', async () => {
    let finish!: (response: Response) => void;
    const { model, fetch } = setup(
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const first = submitCredential(model, SOURCE, credentialForm().form);
    const second = credentialForm();
    await submitCredential(model, SOURCE, second.form);
    expect(second.material.value).toBe('');
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(new Response(null, { status: 204 }));
    await first;
  });
});

describe('sources and registered names', () => {
  it('shows each organization source attachment count in the sources table, including zero and later pages', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [source], next: SOURCE }))
      .mockResolvedValueOnce(
        json({ items: [{ ...source, id: 'second', attachedProjectCount: 0 }], next: null }),
      );
    const { model, html } = setup(fetch);
    await model.load();
    expect(model.snapshot().items[0]).toHaveProperty('attachedProjectCount', 3);
    expect(html()).toMatch(/<table\b[\s\S]*Attached to 3 projects[\s\S]*<\/table>/);
    await model.load(true);
    expect(html()).toMatch(/<table\b[\s\S]*Attached to 0 projects[\s\S]*<\/table>/);
    expect(html()).toContain('Attached to 3 projects');
    expect(html()).not.toContain('Attached projects: unavailable');
  });

  it('keeps project attachment state separate from organization attachment counts', async () => {
    const { model, html } = setup(
      vi.fn().mockResolvedValue(
        json({
          items: [{ ...source, attachedProjectCount: undefined, attached: true, precedence: 0 }],
          next: null,
        }),
      ),
      'acme',
    );
    await model.load();
    expect(html()).toContain('Attached to this project');
    expect(html()).not.toContain('Not attached to this project');
    expect(html()).not.toMatch(/Attached to \d+ projects/);
    expect(html()).not.toContain('undefined');
  });

  it('displays source IDs as copyable text and loads later source pages', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [source], next: SOURCE }))
      .mockResolvedValueOnce(json({ items: [{ ...source, id: 'second' }], next: null }));
    const { model, html } = setup(fetch);
    await model.load();
    await model.load(true);
    expect(fetch.mock.calls[1]?.[0]).toContain(`after=${SOURCE}`);
    expect(model.snapshot().items).toHaveLength(2);
    expect(html()).toContain(`title="${SOURCE}"`);
    expect(html()).toContain('aria-label="Copy source ID"');
    expect(html()).toContain('Source ID');
  });

  it('strips userinfo, query and fragment from hostile source URLs without creating links', async () => {
    const { model, html } = setup(
      vi.fn().mockResolvedValue(
        json({
          items: [
            {
              ...source,
              url: 'https://url-user:url-password@registry.example/path?token=url-query#url-fragment',
            },
          ],
          next: null,
        }),
      ),
    );
    await model.load();
    model.openEditor(model.snapshot().items[0]!);
    expect(html()).toContain('https://registry.example/path');
    for (const hidden of ['url-user', 'url-password', 'url-query', 'url-fragment']) {
      expect(html()).not.toContain(hidden);
      expect(JSON.stringify(model.snapshot())).not.toContain(hidden);
    }
    expect(html()).not.toMatch(/<a\b/);
  });

  it('hides an invalid source URL instead of falling back to the raw value', async () => {
    const { model, html } = setup(
      vi
        .fn()
        .mockResolvedValue(
          json({ items: [{ ...source, url: 'invalid:url-password' }], next: null }),
        ),
    );
    await model.load();
    expect(html()).not.toContain('url-password');
  });

  it('edits polling and removal policy through the documented PATCH', async () => {
    const { model, fetch } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValue(json({ items: [source], next: null })),
    );
    await model.edit(SOURCE, 600, 'exclude');
    expect(fetch.mock.calls[0]).toMatchObject([
      `/_pb/sources/${SOURCE}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ pollIntervalSeconds: 600, removalPolicy: 'exclude' }),
      },
    ]);
  });

  it('pauses a project source through the project route', async () => {
    const { model, fetch } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValue(json({ items: [], next: null })),
      'acme',
    );
    await model.togglePause({ ...source, projectId: 'project-id' });
    expect(fetch.mock.calls[0]?.[0]).toBe(`/_pb/projects/acme/sources/${SOURCE}/pause`);
  });

  it('removes names by registered-name ID and refreshes after last-name pause', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ paused: true }))
      .mockResolvedValueOnce(json({ items: [], next: null }))
      .mockResolvedValueOnce(json({ items: [{ ...source, status: 'paused' }], next: null }));
    const { model } = setup(fetch);
    await model.removeName(SOURCE, 'registered-name-id');
    expect(fetch.mock.calls[0]?.[0]).toBe(`/_pb/sources/${SOURCE}/names/registered-name-id`);
    expect(model.snapshot().items[0]?.status).toBe('paused');
  });

  it('adds registered patterns and reloads their list', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: 'registered' }, 201))
      .mockResolvedValueOnce(
        json({
          items: [{ id: 'registered', sourceId: SOURCE, ecosystem: 'npm', pattern: '@acme/*' }],
          next: null,
        }),
      );
    const { model, html } = setup(fetch);
    await model.addName(SOURCE, '@acme/*');
    expect(fetch.mock.calls[0]?.[1].body).toBe(JSON.stringify({ pattern: '@acme/*' }));
    expect(html()).toContain('@acme/*');
  });
});

describe('additional source boundaries', () => {
  it('writes a project credential only through the project client operation', async () => {
    const { model, fetch } = setup(undefined, 'acme');
    await submitCredential(model, SOURCE, credentialForm().form);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/_pb/projects/acme/sources/${SOURCE}/credential`);
  });

  it('does not send a non-positive polling interval', async () => {
    const { model, fetch } = setup();
    await model.edit(SOURCE, 0, 'flag');
    expect(fetch).not.toHaveBeenCalled();
    expect(model.snapshot().error).toBeTruthy();
  });

  it('does not send an oversized registered pattern', async () => {
    const { model, fetch } = setup();
    await model.addName(SOURCE, 'a'.repeat(51));
    expect(fetch).not.toHaveBeenCalled();
    expect(model.snapshot().error).toBeTruthy();
  });

  it('enables a paused registered source instead of using proxy resume', async () => {
    const { model, fetch } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValue(json({ items: [], next: null })),
    );
    await model.togglePause({ ...source, status: 'paused' });
    expect(fetch.mock.calls[0]?.[0]).toBe(`/_pb/sources/${SOURCE}/enable`);
  });

  it('resumes a paused proxy using the documented resume operation', async () => {
    const { model, fetch } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValue(json({ items: [], next: null })),
    );
    await model.togglePause({ ...source, type: 'npmjs_proxy', status: 'paused' });
    expect(fetch.mock.calls[0]?.[0]).toBe(`/_pb/sources/${SOURCE}/resume`);
  });

  it('appends registered-name pages with their cursor', async () => {
    const entry = { id: 'first-name', sourceId: SOURCE, ecosystem: 'npm', pattern: '@acme/*' };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [entry], next: SOURCE }))
      .mockResolvedValueOnce(
        json({ items: [{ ...entry, id: 'second-name', pattern: 'other' }], next: null }),
      );
    const { model } = setup(fetch);
    await model.names(SOURCE);
    await model.names(SOURCE, true);
    expect(fetch.mock.calls[1]?.[0]).toContain(`after=${SOURCE}`);
    expect(model.snapshot().names?.items.map((name) => name.pattern)).toEqual(['@acme/*', 'other']);
  });

  it('does not allow project scope to offer credential or settings writes for an organization source', async () => {
    const { model, html } = setup(
      vi.fn().mockResolvedValue(json({ items: [source], next: null })),
      'acme',
    );
    await model.load();
    expect(html()).toContain('Manage this organization source in organization scope.');
    expect(html()).not.toContain('Save settings');
    expect(html()).not.toContain('Set credential');
  });

  it('ignores an older who-wins response after a newer query completes', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(
        json({ name: 'current', ecosystem: 'npm', candidates: [], winner: null }),
      );
    const { model } = setup(fetch, 'acme');
    const old = model.resolve('old');
    await model.resolve('current');
    finish(json({ name: 'old', ecosystem: 'npm', candidates: [], winner: null }));
    await old;
    expect(model.snapshot().preview?.name).toBe('current');
  });
});

describe('who wins', () => {
  it('does not send a name of 215 characters', async () => {
    const { model, fetch } = setup(undefined, 'acme');
    await model.resolve('a'.repeat(215));
    expect(fetch).not.toHaveBeenCalled();
    expect(model.snapshot().error).toBeTruthy();
  });

  it('does not send an empty name', async () => {
    const { model, fetch } = setup(undefined, 'acme');
    await model.resolve('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends a name of 214 characters', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json({ name: 'a'.repeat(214), ecosystem: 'npm', candidates: [], winner: null }),
      );
    const { model } = setup(fetch, 'acme');
    await model.resolve('a'.repeat(214));
    expect(fetch.mock.calls[0]?.[0]).toBe(`/_pb/projects/acme/resolve?name=${'a'.repeat(214)}`);
  });

  it('renders returned names and candidate names as escaped text', async () => {
    const { model, html } = setup(
      vi.fn().mockResolvedValue(
        json({
          name: '<b>package</b>',
          ecosystem: 'npm',
          winner: SOURCE,
          candidates: [
            { sourceId: SOURCE, sourceName: '<b>source</b>', eligible: true, projectLevel: false },
          ],
        }),
      ),
      'acme',
    );
    await model.resolve('<b>package</b>');
    expect(html()).toContain('&lt;b&gt;package&lt;/b&gt;');
    expect(html()).toContain('&lt;b&gt;source&lt;/b&gt;');
    expect(html()).not.toContain('<b>');
  });

  it('emits no inline scripts, styles, style attributes or outbound links', () => {
    const { html } = setup(undefined, 'acme');
    expect(html()).not.toMatch(/<(?:script|style|a)\b|\sstyle=/i);
  });
});

describe('project source ordering', () => {
  const attached = (id: string, precedence: number) => ({
    ...source,
    id,
    attached: true,
    precedence,
  });
  const page = (
    items = [attached('second', 20), attached(SOURCE, 10)],
    next: string | null = null,
    etag = '"7"',
  ) => json({ items, next }, 200, { ETag: etag });

  it('orders attached sources by precedence and excludes unattached project-owned sources', async () => {
    const { model, html } = setup(
      vi.fn().mockResolvedValue(
        json(
          {
            items: [
              attached('second', 20),
              { ...source, id: 'unattached', projectId: 'project-id', attached: false },
              attached(SOURCE, 10),
            ],
            next: null,
          },
          200,
          { ETag: '"7"' },
        ),
      ),
      'acme',
    );
    await model.load();
    expect(model.snapshot().order).toEqual([SOURCE, 'second']);
    expect(model.snapshot().etag).toBe('"7"');
    expect(html()).toContain('Move up');
    expect(html()).toContain('Move down');
    expect(html()).toContain('Save source order');
  });

  it('moves in both directions and writes the complete attachment set with the returned ETag', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(page());
    const { model } = setup(fetch, 'acme');
    await model.load();
    model.moveSource('second', -1);
    expect(model.snapshot().order).toEqual(['second', SOURCE]);
    model.moveSource('second', 1);
    expect(model.snapshot().order).toEqual([SOURCE, 'second']);
    model.moveSource(SOURCE, 1);
    await model.saveOrder();
    expect(fetch.mock.calls[1]).toMatchObject([
      '/_pb/projects/acme/sources/order',
      {
        method: 'PUT',
        headers: { 'If-Match': '"7"' },
        body: JSON.stringify({ sourceIds: ['second', SOURCE] }),
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reloads the list on 412 and never retries the write', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(json({ error: { code: 'precondition_failed' } }, 412))
      .mockResolvedValueOnce(page([attached('second', 0), attached(SOURCE, 1)], null, '"8"'));
    const { model } = setup(fetch, 'acme');
    await model.load();
    model.moveSource(SOURCE, 1);
    await model.saveOrder();
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'PUT', 'GET']);
    expect(model.snapshot().order).toEqual(['second', SOURCE]);
    expect(model.snapshot().etag).toBe('"8"');
    expect(model.snapshot().error).toContain('changed');
  });

  it('does not save without an ETag', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ items: [attached(SOURCE, 0)], next: null }));
    const { model } = setup(fetch, 'acme');
    await model.load();
    await model.saveOrder();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not save a partial attachment set before loading every page', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page([attached(SOURCE, 0)], SOURCE))
      .mockResolvedValueOnce(page([attached('second', 1)]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(page());
    const { model } = setup(fetch, 'acme');
    await model.load();
    await model.saveOrder();
    expect(fetch).toHaveBeenCalledTimes(1);
    await model.load(true);
    expect(model.snapshot().order).toEqual([SOURCE, 'second']);
    await model.saveOrder();
    expect(fetch.mock.calls[2]?.[1].body).toBe(JSON.stringify({ sourceIds: [SOURCE, 'second'] }));
  });

  it('reloads rather than combining pages from different ETags', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page([attached(SOURCE, 0)], SOURCE))
      .mockResolvedValueOnce(page([attached('obsolete', 1)], null, '"8"'))
      .mockResolvedValueOnce(page([attached('current', 0)], null, '"8"'));
    const { model } = setup(fetch, 'acme');
    await model.load();
    await model.load(true);
    expect(fetch.mock.calls[2]?.[0]).toBe('/_pb/projects/acme/sources?limit=100');
    expect(model.snapshot().order).toEqual(['current']);
  });

  it('invalidates the ETag after a failed refresh so stale rows cannot be saved', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    const { model } = setup(fetch, 'acme');
    await model.load();
    await model.load();
    await model.saveOrder();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves If-Match in reauth storage for explicit confirmation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(json({ error: { code: 'reauth_required' } }, 403));
    const { model, entries } = setup(fetch, 'acme');
    await model.load();
    model.moveSource(SOURCE, 1);
    await model.saveOrder();
    expect(JSON.parse([...entries.values()][0]!)).toMatchObject({
      path: '/_pb/projects/acme/sources/order',
      headers: { 'If-Match': '"7"' },
      body: { sourceIds: ['second', SOURCE] },
    });
  });

  it('ignores boundary moves and unknown source IDs', async () => {
    const { model } = setup(vi.fn().mockResolvedValue(page()), 'acme');
    await model.load();
    model.moveSource(SOURCE, -1);
    model.moveSource('second', 1);
    model.moveSource('unknown', 1);
    expect(model.snapshot().order).toEqual([SOURCE, 'second']);
  });
});

describe('round 2 regressions', () => {
  const preview = { name: 'package', ecosystem: 'npm', candidates: [], winner: SOURCE };
  const attached = { ...source, projectId: 'project-id', attached: true, precedence: 0 };

  it.each([
    ['pause', { ...attached, status: 'paused' }],
    ['attach', { ...attached, id: 'new', precedence: -1 }],
    ['detach', { ...attached, attached: false }],
  ])(
    'invalidates previews and pending resolves when eligibility changes through %s',
    async (_, changed) => {
      let finish!: (response: Response) => void;
      let refresh!: (response: Response) => void;
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(json({ items: [attached], next: null }, 200, { ETag: '"1"' }))
        .mockResolvedValueOnce(json(preview))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              refresh = resolve;
            }),
        );
      const { model } = setup(fetch, 'acme');
      await model.load();
      await model.resolve('package');
      const old = model.resolve('old');
      const loading = model.load();
      expect(model.snapshot().order).toEqual([]);
      expect(model.snapshot().etag).toBeNull();
      refresh(json({ items: [changed], next: null }, 200, { ETag: '"2"' }));
      await loading;
      finish(json(preview));
      await old;
      expect(model.snapshot().preview).toBeNull();
      expect(model.snapshot().order).toEqual(changed.attached ? [changed.id] : []);
    },
  );

  it('clears a displayed winner after a successful pause', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ items: [{ ...attached, status: 'paused' }], next: null }));
    const { model } = setup(fetch, 'acme');
    await model.resolve('package');
    await model.togglePause(attached);
    expect(model.snapshot().preview).toBeNull();
  });

  it.each([
    ['bearer', { token: SECRET }],
    ['npm_token', { token: SECRET }],
    ['http_basic', { username: 'deploy', password: SECRET }],
    ['header', { name: 'x-api-key', value: SECRET }],
    ['query', { param: 'api_key', value: SECRET }],
    ['github_app', { appId: '123', privateKeyPem: SECRET, webhookSecret: SECRET }],
    ['ssh_key', { privateKeyPem: SECRET, knownHosts: 'host-key' }],
  ] as const)(
    'serializes %s fields as credential JSON and clears every input before sending',
    async (kind, fields) => {
      const inputs = Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [name, { value: String(value) }]),
      );
      const form = {
        elements: {
          namedItem: (name: string) => (name === 'kind' ? { value: kind } : (inputs[name] ?? null)),
        },
        reset: () => {
          for (const input of Object.values(inputs)) input.value = '';
        },
      };
      const { model, fetch, html } = setup(
        vi.fn(() => {
          expect(Object.values(inputs).every(({ value }) => value === '')).toBe(true);
          return Promise.resolve(new Response(null, { status: 204 }));
        }),
      );
      await submitCredential(model, SOURCE, form);
      expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
        kind,
        material: JSON.stringify(fields),
      });
      expect(JSON.stringify(model.snapshot()) + html()).not.toContain(SECRET);
      const markup = renderToString(createElement(CredentialFields, { kind, busy: false }));
      for (const name of Object.keys(fields)) {
        expect(markup).toContain(`name="${name}"`);
      }
      expect(markup.match(/type="password"/g)).toHaveLength(Object.keys(fields).length);
      expect(markup).not.toContain(SECRET);
    },
  );

  it('refreshes source rows, ordering and names after a confirmed reauth replay', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [], next: null }))
      .mockResolvedValueOnce(json({ items: [attached], next: null }, 200, { ETag: '"1"' }))
      .mockResolvedValueOnce(json({ error: { code: 'reauth_required' } }, 403))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        json({ items: [{ ...attached, removalPolicy: 'exclude' }], next: null }, 200, {
          ETag: '"2"',
        }),
      )
      .mockResolvedValueOnce(json({ items: [{ id: 'name-id', pattern: 'new' }], next: null }));
    const { model, flow } = setup(fetch, 'acme');
    await model.names(SOURCE);
    await model.load();
    await model.edit(SOURCE, 600, 'exclude');
    const unsubscribe = flow.subscribeReplay((result) => {
      void model.replayed(result);
    });
    flow.restore();
    await flow.confirm();
    await vi.waitFor(() => expect(model.snapshot().names?.items[0]?.pattern).toBe('new'));
    expect(model.snapshot().items[0]?.removalPolicy).toBe('exclude');
    expect(model.snapshot().etag).toBe('"2"');
    unsubscribe();
  });

  it.each([
    '/_pb/projects/other/sources/order',
    '/_pb/projects/acme/tokens',
    '/_pb/sources-other/id',
  ])('ignores an unrelated replay at %s', async (path) => {
    const { model, fetch } = setup(undefined, 'acme');
    await model.replayed({ path, ok: true, status: 204 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'resets settings after refresh even when the server values change: %s',
    async (changed) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(json({ items: [source], next: null }))
        .mockResolvedValueOnce(
          json({
            items: [
              {
                ...source,
                removalPolicy: changed ? 'exclude' : 'flag',
                pollIntervalSeconds: changed ? 600 : 300,
              },
            ],
            next: null,
          }),
        );
      const { model, html } = setup(fetch);
      await model.load();
      model.openEditor(model.snapshot().items[0]!);
      expect(html()).toContain('value="300"');
      model.closeEditor();
      await model.load();
      model.openEditor(model.snapshot().items[0]!);
      expect(html()).toContain(`value="${changed ? 600 : 300}"`);
      expect(renderToString(createElement(SourcesView, { model }))).toContain(
        `<option value="${changed ? 'exclude' : 'flag'}" selected="">`,
      );
    },
  );

  it('checks organization permissions before offering project Enable', async () => {
    const paused = { ...attached, status: 'paused' as const };
    const fetch = vi.fn().mockResolvedValue(json({ items: [paused], next: null }));
    const { model, html } = setup(fetch, 'acme', ['project:sources:write']);
    await model.load();
    expect(html()).not.toMatch(/>Enable</);
    expect(html()).toContain('<p>An organization admin must enable this source.</p>');
    fetch.mockClear();
    await model.togglePause(paused);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['not_approved', 'unknown_error'] as const)(
    'keeps project Enable and shows the normal error for a 403 with code %s',
    async (code) => {
      const paused = { ...attached, status: 'paused' as const };
      const { model, html } = setup(
        vi
          .fn()
          .mockResolvedValueOnce(json({ items: [paused], next: null }))
          .mockResolvedValueOnce(json({ error: { code, message: SECRET } }, 403))
          .mockImplementation(() => Promise.resolve(json({ items: [paused], next: null }))),
        'acme',
      );
      await model.load();
      await model.togglePause(paused);
      expect(html()).toMatch(/>Enable</);
      expect(model.snapshot().enableDenied).toEqual([]);
      expect(model.snapshot().error).toBe(
        'The request could not be saved or loaded. Refresh and try again.',
      );
      expect(html()).not.toContain(SECRET);
      await model.replayed({ path: `/_pb/sources/${SOURCE}/enable`, ok: false, status: 403, code });
      expect(html()).toMatch(/>Enable</);
      expect(model.snapshot().enableDenied).toEqual([]);
      expect(model.snapshot().error).toBe(
        'The request could not be saved or loaded. Refresh and try again.',
      );
    },
  );

  it('announces project enable conflicts next to the source and permits retry after registering names', async () => {
    const paused = { ...attached, status: 'paused' as const };
    const { model, html } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(json({ items: [paused], next: null }))
        .mockResolvedValueOnce(json({ error: { code: 'conflict', message: SECRET } }, 409))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(json({ items: [attached], next: null })),
      'acme',
    );
    await model.load();
    await model.togglePause(paused);
    expect(html()).toContain('<p>Register package names, then enable the source.</p>');
    expect(html()).toMatch(/>Enable</);
    expect(html()).not.toContain(SECRET);
    expect(model.snapshot().error).toBeNull();
    await model.togglePause(paused);
    expect(model.snapshot().items[0]?.status).toBe('active');
    expect(model.snapshot().enableConflicts).toEqual([]);
    expect(model.snapshot().enableDenied).toEqual([]);
    expect(html()).not.toContain('Register package names, then enable the source.');
  });

  it('announces conflicts after replaying project enable', async () => {
    const paused = { ...attached, status: 'paused' as const };
    const { model, html } = setup(
      vi.fn().mockImplementation(() => Promise.resolve(json({ items: [paused], next: null }))),
      'acme',
    );
    await model.load();
    await model.replayed({
      path: `/_pb/sources/${SOURCE}/enable`,
      ok: false,
      status: 409,
      code: 'conflict',
    });
    expect(html()).toContain('<p>Register package names, then enable the source.</p>');
    expect(html()).toMatch(/>Enable</);
    expect(model.snapshot().error).toBeNull();
  });

  it('keeps project Enable available after a network failure', async () => {
    const paused = { ...attached, status: 'paused' as const };
    const { model, html } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(json({ items: [paused], next: null }))
        .mockRejectedValueOnce(new Error(SECRET)),
      'acme',
    );
    await model.load();
    await model.togglePause(paused);
    expect(html()).toMatch(/>Enable</);
    expect(model.snapshot().busy).toBe(false);
    expect(model.snapshot().error).toBe(
      'The request could not be saved or loaded. Refresh and try again.',
    );
    expect(html()).not.toContain(SECRET);
    expect(model.snapshot().enableDenied).toEqual([]);
  });

  it('submits project enable once on a double click', async () => {
    const paused = { ...attached, status: 'paused' as const };
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [paused], next: null }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(json({ items: [attached], next: null }));
    const { model, html } = setup(fetch, 'acme');
    await model.load();
    const pending = model.togglePause(paused);
    await model.togglePause(paused);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(html()).toMatch(/disabled="">Enable</);
    finish(new Response(null, { status: 204 }));
    await pending;
    expect(model.snapshot().busy).toBe(false);
    expect(model.snapshot().items[0]?.status).toBe('active');
  });

  it('clears cached enable denial on reload and reauthentication without duplicate entries', async () => {
    const paused = { ...attached, status: 'paused' as const };
    const { model, html, fetch, requireReauth } = setup(
      vi.fn().mockImplementation(() => Promise.resolve(json({ items: [paused], next: null }))),
      'acme',
    );
    await model.load();
    const denial = {
      path: `/_pb/sources/${SOURCE}/enable`,
      ok: false,
      status: 403,
      code: 'forbidden',
    } as const;
    await model.replayed(denial);
    await model.replayed(denial);
    expect(model.snapshot().enableDenied).toEqual([SOURCE]);
    fetch.mockResolvedValueOnce(json({ error: { code: 'reauth_required' } }, 403));
    await model.names(SOURCE);
    expect(requireReauth).toHaveBeenCalledOnce();
    expect(model.snapshot().enableDenied).toEqual([]);
    await model.replayed(denial);
    await model.load();
    expect(model.snapshot().enableDenied).toEqual([]);
    expect(html()).toMatch(/>Enable</);
    await model.replayed(denial);
    await model.replayed({ path: `/_pb/sources/${SOURCE}/enable`, ok: true, status: 204 });
    expect(model.snapshot().enableDenied).toEqual([]);
    expect(html()).toMatch(/>Enable</);
  });

  it('replaces project Enable with admin guidance after the enable route denies access', async () => {
    const paused = { ...attached, status: 'paused' as const };
    const { model, fetch, html } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(json({ items: [paused], next: null }))
        .mockResolvedValueOnce(json({ error: { code: 'forbidden', message: SECRET } }, 403)),
      'acme',
    );
    await model.load();
    expect(html()).toMatch(/>Enable</);
    await model.togglePause(paused);
    expect(fetch.mock.calls[1]).toMatchObject([
      `/_pb/sources/${SOURCE}/enable`,
      { method: 'POST' },
    ]);
    expect(html()).not.toMatch(/>Enable<|>Resume</);
    expect(html()).toContain('An organization admin must enable this source.');
    expect(html()).not.toContain(SECRET);
    expect(model.snapshot().error).toBeNull();
    fetch.mockClear();
    await model.togglePause(paused);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enables a project-owned paused source through the organization enable route and reloads project scope', async () => {
    const paused = { ...attached, status: 'paused' as const };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [paused], next: null }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ items: [attached], next: null }));
    const { model, html } = setup(fetch, 'acme');
    await model.load();
    expect(html()).toMatch(/>Enable</);
    await model.togglePause(paused);
    expect(fetch.mock.calls[1]).toMatchObject([
      `/_pb/sources/${SOURCE}/enable`,
      { method: 'POST' },
    ]);
    expect(fetch.mock.calls[2]?.[0]).toBe('/_pb/projects/acme/sources?limit=100');
    expect(model.snapshot().items[0]?.status).toBe('active');
    expect(html()).not.toMatch(/>Enable</);
  });

  it('keeps reauthentication available for project enable and refreshes after replay', async () => {
    const paused = { ...attached, status: 'paused' as const };
    const { model, html, requireReauth } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(json({ items: [paused], next: null }))
        .mockResolvedValueOnce(json({ error: { code: 'reauth_required' } }, 403))
        .mockResolvedValueOnce(json({ items: [attached], next: null })),
      'acme',
    );
    await model.load();
    await model.togglePause(paused);
    expect(requireReauth).toHaveBeenCalledWith(
      { method: 'POST', path: `/_pb/sources/${SOURCE}/enable` },
      { credential: false, secretFields: [] },
    );
    expect(html()).toMatch(/>Enable</);
    expect(html()).not.toContain('An organization admin must enable this source.');
    await model.replayed({ path: `/_pb/sources/${SOURCE}/enable`, ok: true, status: 204 });
    expect(model.snapshot().items[0]?.status).toBe('active');
  });

  it('shows admin guidance if enabling is denied after reauthentication', async () => {
    const paused = { ...attached, status: 'paused' as const };
    const { model, html } = setup(
      vi.fn().mockImplementation(() => Promise.resolve(json({ items: [paused], next: null }))),
      'acme',
    );
    await model.load();
    expect(html()).toMatch(/>Enable</);
    await model.replayed({
      path: `/_pb/sources/${SOURCE}/enable`,
      ok: false,
      status: 403,
      code: 'forbidden',
    });
    expect(html()).not.toMatch(/>Enable</);
    expect(html()).toContain('<p>An organization admin must enable this source.</p>');
  });
});

describe('source list presentation', () => {
  it('filters loaded sources by name, type and ownership together without reordering the input', () => {
    const items: Source[] = [
      source,
      {
        ...source,
        id: 'project-source',
        name: 'Build registry',
        projectId: 'project',
        type: 'npmjs_proxy',
      },
    ];
    expect(
      filterSources(items, { q: 'BUILD', type: 'npmjs_proxy', scope: 'project' }).map(
        (item) => item.id,
      ),
    ).toEqual(['project-source']);
    expect(filterSources(items, { q: '', type: '', scope: 'organization' })).toEqual([source]);
    expect(filterSources(items, { q: 'Build', type: 'npm_registry', scope: '' })).toEqual([]);
    expect(items.map((item) => item.id)).toEqual([SOURCE, 'project-source']);
  });
  it('renders source status, credential presence, exact sync time and responsive cells', async () => {
    const { model, html } = setup(
      vi
        .fn()
        .mockResolvedValue(
          json({ items: [{ ...source, hasCredential: true, lastSuccessAt: NOW }], next: null }),
        ),
    );
    await model.load();
    expect(html()).toContain('responsive-table');
    expect(html()).toContain('data-label="Credentials"');
    expect(html()).toContain('Set · write-only');
    expect(html()).toContain(`dateTime="${NOW}"`);
    expect(html()).toContain('>Active<');
    expect(html()).not.toContain('<dialog');
  });
  it('does not label a failed refresh as an empty list', async () => {
    const { model, html } = setup(
      vi.fn().mockResolvedValue(json({ error: { code: 'forbidden', message: SECRET } }, 403)),
    );
    await model.load();
    expect(html()).toContain('data-list-state="error"');
    expect(html()).not.toContain('data-list-state="empty"');
    expect(html()).not.toContain(SECRET);
  });
});

describe('source creation and configuration editing', () => {
  const body = {
    name: 'Composer upstream',
    ecosystem: 'composer' as const,
    type: 'composer_repository' as const,
    url: 'https://composer.example.test',
    config: { selection: { packages: ['vendor/package'] } },
  };

  it.each([null, 'acme'])(
    'creates in scope %s, reloads and opens the new credential editor',
    async (project) => {
      const created = { ...source, name: body.name, ecosystem: body.ecosystem, type: body.type };
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(json({ id: SOURCE }, 201))
        .mockResolvedValueOnce(json({ items: [created], next: null }));
      const { model, html } = setup(fetch, project);
      model.openEditor();
      expect(html()).toContain('<dialog');
      expect(html()).toContain('Add source');
      await model.saveSource(body);
      expect(fetch.mock.calls[0]).toMatchObject([
        project === null ? '/_pb/sources' : '/_pb/projects/acme/sources',
        { method: 'POST', body: JSON.stringify(body), credentials: 'same-origin' },
      ]);
      expect(model.snapshot().editor).toBeNull();
      expect(model.snapshot().items).toHaveLength(1);
      expect(model.snapshot().credentialSource).toBe(SOURCE);
      expect(html()).toContain('Composer upstream');
      expect(html()).toContain('Credential kind');
    },
  );

  it('opens a bearer token editor after GitHub token source creation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: SOURCE }, 201))
      .mockResolvedValueOnce(
        json({ items: [{ ...source, type: 'vcs', ecosystem: 'composer' }], next: null }),
      );
    const { model, html } = setup(fetch);
    model.openEditor();
    await model.saveSource({
      name: 'GitHub token',
      ecosystem: 'composer',
      type: 'vcs',
      config: { provider: 'github', repository: 'owner/repo', refs: { tags: true, branches: [] } },
    });
    expect(model.snapshot().credentialSource).toBe(SOURCE);
    expect(html()).toContain('<option value="bearer" selected="">');
    expect(html()).toContain('id="credential-token"');
    expect(html()).not.toContain('Installation ID');
  });

  it('finds a newly created source beyond the first page', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: SOURCE }, 201))
      .mockResolvedValueOnce(json({ items: [{ ...source, id: 'older' }], next: 'older' }))
      .mockResolvedValueOnce(json({ items: [source], next: null }));
    const { model } = setup(fetch);
    model.openEditor();
    await model.saveSource(body);
    expect(fetch.mock.calls[2]?.[0]).toContain('after=older');
    expect(model.snapshot().items.map((item) => item.id)).toEqual(['older', SOURCE]);
    expect(model.snapshot().credentialSource).toBe(SOURCE);
  });

  it.each(['npmjs_proxy', 'packagist_proxy'] as const)(
    'does not open credentials for %s creation',
    async (type) => {
      const { model } = setup(
        vi
          .fn()
          .mockResolvedValueOnce(json({ id: SOURCE }, 201))
          .mockResolvedValueOnce(json({ items: [{ ...source, type }], next: null })),
      );
      model.openEditor();
      await model.saveSource({
        ...body,
        ecosystem: type === 'npmjs_proxy' ? 'npm' : 'composer',
        type,
        config: {},
      });
      expect(model.snapshot().credentialSource).toBeNull();
    },
  );

  it.each([null, 'acme'])('updates full editable configuration in scope %s', async (project) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ items: [source], next: null }));
    const { model } = setup(fetch, project);
    model.openEditor({ ...source, projectId: project });
    const changes = {
      pollIntervalSeconds: 600,
      removalPolicy: 'exclude' as const,
      config: { scopes: ['@changed'], distHosts: ['dist.example.test'] },
      defaultVisibleToNewProjects: true,
      retentionDaysOverride: 0,
    };
    await model.saveSource(changes);
    expect(fetch.mock.calls[0]).toMatchObject([
      project === null ? `/_pb/sources/${SOURCE}` : `/_pb/projects/acme/sources/${SOURCE}`,
      { method: 'PATCH', body: JSON.stringify(changes) },
    ]);
    expect(model.snapshot().editor).toBeNull();
  });

  it('keeps an organization source out of the project edit form', () => {
    const { model, fetch } = setup(undefined, 'acme');
    model.openEditor(source);
    expect(model.snapshot().editor).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows field validation and a form alert without retaining hostile messages or pointers', async () => {
    const { model, html } = setup(
      vi.fn().mockResolvedValue(
        json(
          {
            error: {
              code: 'invalid_request',
              message: SECRET,
              details: [
                { path: '/body/url', code: 'invalid' },
                { path: '/body/pollIntervalSeconds', code: 'invalid' },
                { path: '/body/config/selection/packages/0', code: 'invalid' },
                { path: SECRET, code: 'invalid' },
              ],
            },
          },
          400,
        ),
      ),
    );
    model.openEditor();
    await model.saveSource(body);
    expect(model.snapshot().editor).toBe('create');
    expect(model.snapshot().fieldErrors).toEqual({
      url: 'Enter a valid HTTP or HTTPS URL without credentials, a query, or a fragment.',
      pollIntervalSeconds: 'Enter a whole number of seconds greater than 0.',
      'config/selection/packages':
        'Enter valid Composer package names, one per line, without duplicates.',
    });
    expect(html()).toContain('aria-invalid="true"');
    expect(html()).toContain('role="alert"');
    expect(JSON.stringify(model.snapshot()) + html()).not.toContain(SECRET);
  });

  it('handles network failure and lets the admin cancel the retained form', async () => {
    const { model } = setup(vi.fn().mockRejectedValue(new Error(SECRET)));
    model.openEditor();
    await model.saveSource(body);
    expect(model.snapshot().busy).toBe(false);
    expect(model.snapshot().formError).toBeTruthy();
    expect(JSON.stringify(model.snapshot())).not.toContain(SECRET);
    model.closeEditor();
    expect(model.snapshot().editor).toBeNull();
    expect(model.snapshot().fieldErrors).toEqual({});
  });

  it('blocks duplicate submits and dismissal while a creation is pending', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(json({ items: [source], next: null }));
    const { model } = setup(fetch);
    model.openEditor();
    const pending = model.saveSource(body);
    model.closeEditor();
    await model.saveSource(body);
    expect(model.snapshot().editor).toBe('create');
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(json({ id: SOURCE }, 201));
    await pending;
  });

  it('holds creation for explicit reauth replay, then opens credentials for the returned ID', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'reauth_required' } }, 403))
      .mockResolvedValueOnce(json({ id: SOURCE, material: SECRET }, 201))
      .mockResolvedValueOnce(json({ items: [source], next: null }));
    const { model, flow, entries } = setup(fetch);
    model.openEditor();
    await model.saveSource(body);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse([...entries.values()][0]!)).toMatchObject({
      method: 'POST',
      path: '/_pb/sources',
      body,
    });
    const replay = vi.fn();
    flow.subscribeReplay((result) => {
      replay(result);
      void model.replayed(result);
    });
    flow.restore();
    await flow.confirm();
    await vi.waitFor(() => expect(model.snapshot().credentialSource).toBe(SOURCE));
    expect(replay).toHaveBeenCalledWith({
      path: '/_pb/sources',
      status: 201,
      ok: true,
      createdSourceId: SOURCE,
    });
    expect(model.snapshot().editor).toBeNull();
    expect(JSON.stringify(model.snapshot())).not.toContain(SECRET);
  });
});

describe('project source attachments', () => {
  it.each([true, false])(
    'writes attached=%s and refreshes project ordering and ETag',
    async (attached) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(
          json(
            {
              items: [{ ...source, attached, ...(attached ? { precedence: 0 } : {}) }],
              next: null,
            },
            200,
            { ETag: '"9"' },
          ),
        );
      const { model, html } = setup(fetch, 'acme');
      await model.attachment(SOURCE, attached);
      expect(fetch.mock.calls[0]).toMatchObject([
        `/_pb/projects/acme/sources/${SOURCE}/attachment`,
        { method: attached ? 'PUT' : 'DELETE' },
      ]);
      expect(fetch.mock.calls[0]?.[1].body).toBe(attached ? '{}' : undefined);
      expect(model.snapshot().order).toEqual(attached ? [SOURCE] : []);
      expect(model.snapshot().etag).toBe('"9"');
      expect(html()).toContain(attached ? '>Detach<' : '>Attach<');
    },
  );

  it('does not send attachment requests in organization scope', async () => {
    const { model, fetch } = setup();
    await model.attachment(SOURCE, true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains attachment state when the API refuses detachment', async () => {
    const { model, html } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(
          json({ items: [{ ...source, attached: true, precedence: 0 }], next: null }, 200, {
            ETag: '"1"',
          }),
        )
        .mockResolvedValueOnce(json({ error: { code: 'forbidden', message: SECRET } }, 403)),
      'acme',
    );
    await model.load();
    await model.attachment(SOURCE, false);
    expect(model.snapshot().order).toEqual([SOURCE]);
    expect(model.snapshot().error).toBeTruthy();
    expect(html()).toContain('>Detach<');
    expect(html()).not.toContain(SECRET);
  });
});

describe('unattached organization source candidates', () => {
  it('loads authorized organization sources so Attach remains available before attachment and after detach', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [], next: null }, 200, { ETag: '"1"' }))
      .mockResolvedValueOnce(json({ items: [source], next: null }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        json({ items: [{ ...source, attached: true, precedence: 0 }], next: null }, 200, {
          ETag: '"2"',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ items: [], next: null }, 200, { ETag: '"3"' }));
    const { model, html } = setup(fetch, 'acme');
    await model.load();
    expect(html()).not.toContain(source.name);
    await model.loadAvailable();
    expect(fetch.mock.calls[1]?.[0]).toBe('/_pb/sources?limit=100');
    expect(html()).toContain(source.name);
    expect(html()).toContain('>Attach<');
    await model.attachment(SOURCE, true);
    expect(html()).toContain('>Detach<');
    expect(html().match(/<strong>Private packages<\/strong>/g)).toHaveLength(1);
    await model.attachment(SOURCE, false);
    expect(html()).toContain('>Attach<');
    expect(model.snapshot().order).toEqual([]);
  });

  it('defers candidates until later project pages resolve their attachment membership', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...source,
      id: `project-${index}`,
      name: `Project source ${index}`,
      attached: true,
      precedence: index,
    }));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: firstPage, next: 'project-99' }, 200, { ETag: '"1"' }))
      .mockResolvedValueOnce(json({ items: [source], next: null }))
      .mockResolvedValueOnce(
        json({ items: [{ ...source, attached: true, precedence: 100 }], next: null }, 200, {
          ETag: '"1"',
        }),
      );
    const { model, html } = setup(fetch, 'acme');
    await model.load();
    await model.loadAvailable();
    expect(html()).not.toContain(source.name);
    expect(html()).not.toContain('>Attach<');
    expect(html()).toContain('Load all project sources before attaching organization sources.');
    await model.load(true);
    expect(fetch.mock.calls[2]?.[0]).toContain('after=project-99');
    expect(html()).toContain(source.name);
    expect(html()).not.toContain('>Attach<');
    expect(html().match(/<strong>Private packages<\/strong>/g)).toHaveLength(1);
    expect(model.snapshot().order).toContain(SOURCE);
  });

  it('defers a newly attached candidate again until refreshed project pagination completes', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [], next: null }))
      .mockResolvedValueOnce(json({ items: [source], next: null }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        json(
          {
            items: [{ ...source, id: 'first', name: 'First', attached: true, precedence: 0 }],
            next: 'first',
          },
          200,
          { ETag: '"2"' },
        ),
      )
      .mockResolvedValueOnce(
        json({ items: [{ ...source, attached: true, precedence: 1 }], next: null }, 200, {
          ETag: '"2"',
        }),
      );
    const { model, html } = setup(fetch, 'acme');
    await model.load();
    await model.loadAvailable();
    expect(html()).toContain('>Attach<');
    await model.attachment(SOURCE, true);
    expect(html()).not.toContain(source.name);
    expect(html()).not.toContain('>Attach<');
    await model.load(true);
    expect(html()).toContain(source.name);
    expect(html()).not.toContain('>Attach<');
    expect(model.snapshot().order).toEqual(['first', SOURCE]);
  });

  it('paginates candidate sources independently of the project ordering list', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [source], next: SOURCE }))
      .mockResolvedValueOnce(
        json({ items: [{ ...source, id: 'second', name: 'Later source' }], next: null }),
      );
    const { model, html } = setup(fetch, 'acme');
    await model.loadAvailable();
    expect(model.snapshot().availableNext).toBe(SOURCE);
    await model.loadAvailable(true);
    expect(fetch.mock.calls[1]?.[0]).toContain(`after=${SOURCE}`);
    expect(model.snapshot().available).toHaveLength(2);
    expect(model.snapshot().availableNext).toBeNull();
    expect(model.snapshot().next).toBeNull();
    expect(model.snapshot().order).toEqual([]);
    // The main list must load successfully before any rows are shown.
    expect(html()).toContain('Loading sources');
  });

  it('keeps project sources usable when organization source reading is refused', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({ items: [{ ...source, projectId: 'project-id', attached: false }], next: null }),
      )
      .mockResolvedValueOnce(json({ error: { code: 'forbidden', message: SECRET } }, 403));
    const { model, html } = setup(fetch, 'acme');
    await model.load();
    await model.loadAvailable();
    expect(model.snapshot().available).toEqual([]);
    expect(model.snapshot().listError).toBe(false);
    expect(html()).toContain(source.name);
    expect(html()).toContain('>Attach<');
    expect(html()).toContain('Organization sources could not be loaded.');
    expect(html()).not.toContain(SECRET);
  });

  it('makes no candidate request in organization scope', async () => {
    const { model, fetch } = setup();
    await model.loadAvailable();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('source replay metadata', () => {
  it('keeps an invalid created ID and other response data out of replay notifications', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ id: SECRET, token: SECRET }, 201));
    const { flow } = setup(fetch);
    const listener = vi.fn();
    flow.subscribeReplay(listener);
    flow.requireReauth(
      {
        method: 'POST',
        path: '/_pb/sources',
        body: { name: 'Public name', ecosystem: 'composer', type: 'composer_repository' },
      },
      { credential: false, secretFields: [] },
      '#/sources',
    );
    flow.restore();
    await flow.confirm();
    expect(listener).toHaveBeenCalledWith({ path: '/_pb/sources', ok: true, status: 201 });
    expect(JSON.stringify(listener.mock.calls)).not.toContain(SECRET);
  });
});

describe('source sync', () => {
  it.each([null, 'acme'])('requests a sync and refreshes status in scope %s', async (project) => {
    const updated = { ...source, projectId: project, lastSuccessAt: NOW, nextPollAt: NOW };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [{ ...source, projectId: project }], next: null }))
      .mockResolvedValueOnce(json({ requested: true }, 202))
      .mockResolvedValueOnce(json({ items: [updated], next: null }));
    const { model, html } = setup(fetch, project);
    await model.load();
    await model.syncNow(model.snapshot().items[0]!);
    expect(fetch.mock.calls[1]).toMatchObject([
      project === null
        ? `/_pb/sources/${SOURCE}/sync`
        : `/_pb/projects/acme/sources/${SOURCE}/sync`,
      { method: 'POST' },
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(model.snapshot().items[0]).toEqual(updated);
    expect(html()).toContain('Sync requested.');
    expect(html()).toContain(`dateTime="${NOW}"`);
  });

  it('disables paused sources with an accessible reason and blocks inherited source mutations', async () => {
    const paused = { ...source, status: 'paused' as const };
    const { model, fetch } = setup();
    const markup = renderToString(
      createElement(SourceActions, { model, source: paused, busy: false }),
    );
    expect(markup).toMatch(/disabled="" aria-describedby="sync-paused-/);
    expect(markup).toContain('Enable before syncing.');
    await model.syncNow(paused);
    expect(fetch).not.toHaveBeenCalled();
    const inherited = setup(vi.fn(), 'acme');
    await inherited.model.syncNow(source);
    expect(inherited.fetch).not.toHaveBeenCalled();
    expect(
      renderToString(createElement(SourceActions, { model: inherited.model, source, busy: false })),
    ).not.toContain('Sync now');
  });

  it('prevents duplicate requests while a sync is pending', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(json({ items: [source], next: null }));
    const { model } = setup(fetch);
    const pending = model.syncNow(source);
    await model.syncNow(source);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(json({}, 202));
    await pending;
    expect(model.snapshot().busy).toBe(false);
  });

  it.each(['source_paused', 'forbidden', 'reauth_required'])(
    'handles %s without displaying response text',
    async (code) => {
      const { model, fetch, html, requireReauth } = setup(
        vi.fn().mockResolvedValueOnce(json({ error: { code, message: SECRET } }, 403)),
      );
      await model.syncNow(source);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(model.snapshot().notice).toBeNull();
      expect(model.snapshot().error).not.toBeNull();
      expect(html()).not.toContain(SECRET);
      expect(requireReauth).toHaveBeenCalledTimes(code === 'reauth_required' ? 1 : 0);
    },
  );

  it('refreshes a source beyond the first page', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({}, 202))
      .mockResolvedValueOnce(json({ items: [{ ...source, id: 'earlier' }], next: 'earlier' }))
      .mockResolvedValueOnce(json({ items: [{ ...source, lastSuccessAt: NOW }], next: null }));
    const { model } = setup(fetch);
    await model.syncNow(source);
    expect(fetch.mock.calls[2]?.[0]).toContain('after=earlier');
    expect(model.snapshot().items[1]?.lastSuccessAt).toBe(NOW);
  });

  it.each([
    ['unauthorized', 'Authorization failed'],
    ['future_error', 'future_error'],
    ['<script>unknown</script>', '&lt;script&gt;unknown&lt;/script&gt;'],
    ['toString', 'toString'],
  ])('renders error code %s in responsive rows', async (code, label) => {
    const { model, html } = setup(
      vi.fn().mockResolvedValueOnce(
        json({
          items: [{ ...source, lastError: code, lastSuccessAt: NOW, nextPollAt: NOW }],
          next: null,
        }),
      ),
    );
    await model.load();
    expect(html().split(label)).toHaveLength(2);
    expect(html()).toContain(`<code>${code.startsWith('<') ? label : code}</code>`);
    expect(html()).toContain('Next poll:');
    expect(html()).toContain('Last listing:');
  });

  it('shows empty sync history explicitly', async () => {
    const { model, html } = setup(vi.fn().mockResolvedValue(json({ items: [source], next: null })));
    await model.load();
    const markup = html();
    expect(markup).toContain('Never');
    expect(markup).toContain('None');
    expect(markup).toContain('Next poll:');
  });

  it('updates creation guidance after registering names and enabling', async () => {
    const paused = { ...source, status: 'paused' };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ id: SOURCE }, 201))
      .mockResolvedValueOnce(json({ items: [paused], next: null }))
      .mockResolvedValueOnce(
        json({ items: [{ id: 'name', sourceId: SOURCE, pattern: 'vendor/*' }], next: null }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ items: [source], next: null }));
    const { model, html } = setup(fetch);
    model.openEditor();
    await model.saveSource({
      name: source.name,
      type: source.type,
      ecosystem: source.ecosystem,
      config: {},
    });
    expect(html()).toContain('Register names, then Enable the source.');
    await model.names(SOURCE);
    expect(html()).toContain('Enable the source.');
    expect(html()).not.toContain('Register names, then');
    await model.togglePause(model.snapshot().items[0]!);
    expect(html()).not.toContain('Next steps for');
  });
});

it.each([
  ['composer_repository', {}, 'http_basic'],
  ['npm_registry', {}, 'npm_token'],
  ['vcs', { provider: 'github', repository: 'acme/payments', installationId: 42 }, 'github_app'],
  ['vcs', { provider: 'github', repository: 'acme/payments' }, 'bearer'],
  ['vcs', { provider: 'ssh', repository: 'git@example.com:acme/payments.git' }, 'ssh_key'],
] as const)('preselects %s credentials for %j', (type, config, kind) => {
  expect(
    sourceCredentialKind({
      name: 'Upstream',
      ecosystem: type === 'npm_registry' ? 'npm' : 'composer',
      type,
      config,
    }),
  ).toBe(kind);
});

describe('source row action controls', () => {
  function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!isValidElement<Record<string, unknown>>(node)) return [];
    return [node, ...elements(node.props.children as ReactNode)];
  }

  it.each([
    ['Sync now', 'syncNow'],
    ['Set credential', 'chooseCredential'],
    ['Registered names', 'names'],
  ] as const)('connects %s to the selected source', (label, method) => {
    const { model } = setup();
    const action = vi.spyOn(model, method).mockImplementation(vi.fn());
    const controls = elements(SourceActions({ source, model, busy: false }));
    const button = controls.find((node) => node.props.children === label);
    expect(button).toBeDefined();
    (button!.props.onClick as () => void)();
    expect(action).toHaveBeenCalledWith(method === 'syncNow' ? source : SOURCE);
  });

  it.each(['active', 'paused'] as const)(
    'connects the %s state control with pause or enable',
    (status) => {
      const { model } = setup();
      const selected = { ...source, status };
      const action = vi.spyOn(model, 'togglePause').mockResolvedValue();
      const controls = elements(SourceActions({ source: selected, model, busy: false }));
      const button = controls.find((node) =>
        status === 'paused' ? node.props.children === 'Enable' : node.props.action === 'Pause',
      );
      expect(button).toBeDefined();
      ((status === 'paused' ? button!.props.onClick : button!.props.onConfirm) as () => void)();
      expect(action).toHaveBeenCalledWith(selected);
    },
  );

  it('closes More with Escape and restores focus to its trigger', () => {
    const { model } = setup();
    const menu = elements(SourceActions({ source, model, busy: false })).find(
      (node) => node.type === DropdownMenu,
    )!;
    const focus = vi.fn();
    const details = {
      open: true,
      contains: vi.fn(() => true),
      closest: vi.fn(() => null),
      querySelector: vi.fn(() => ({ focus })),
    };
    const preventDefault = vi.fn();
    const handler = DropdownMenu(menu.props).props.onKeyDown as (event: unknown) => void;
    handler({
      key: 'Escape',
      currentTarget: details,
      preventDefault,
      stopPropagation: vi.fn(),
    });
    expect(details.open).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    details.open = false;
    preventDefault.mockClear();
    handler({
      key: 'Escape',
      currentTarget: details,
      preventDefault,
      stopPropagation: vi.fn(),
    });
    expect(details.open).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('Escape from outside the menu does not close it', () => {
    const { model } = setup();
    const menu = elements(SourceActions({ source, model, busy: false })).find(
      (node) => node.type === DropdownMenu,
    )!;
    const details = { open: true, contains: vi.fn(() => false) };
    const preventDefault = vi.fn();
    DropdownMenu(menu.props).props.onKeyDown!({
      key: 'Escape',
      currentTarget: details,
      target: {},
      preventDefault,
    } as never);
    expect(details.open).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('keeps row settings exclusively in Edit and includes the read-only identity summary', async () => {
    const { model, html } = setup(vi.fn().mockResolvedValue(json({ items: [source], next: null })));
    await model.load();
    expect(html()).not.toContain('Edit source</summary>');
    expect(html()).not.toContain('Save settings');
    expect(html()).not.toContain('source-pollIntervalSeconds');
    model.openEditor(model.snapshot().items[0]!);
    expect(html()).toContain('aria-label="Source identity"');
    expect(html()).toContain('https://registry.example/packages');
    expect(html()).toContain('No credential set');
    expect(html()).toContain('source-pollIntervalSeconds');
    expect(html()).toContain('source-removalPolicy');
    expect(html().match(/id="source-pollIntervalSeconds"/g)).toHaveLength(1);
  });

  it('uses dismissible source dialogs for credentials and names without retaining closed credentials', async () => {
    const { model, html } = setup(vi.fn().mockResolvedValue(json({ items: [], next: null })));
    model.chooseCredential(SOURCE);
    expect(html()).toContain('Set credential</h2>');
    expect(html()).toContain('<dialog');
    expect(html()).toContain('h-dvh');
    model.closeCredential();
    expect(html()).not.toContain('credential-kind');
    await model.names(SOURCE);
    expect(html()).toContain('Registered names</h2>');
    expect(html()).toContain('<dialog');
    model.closeNames();
    expect(html()).not.toContain('registered-pattern');
  });
});

describe('source action dialog identity and switching', () => {
  it.each([true, false])('shows attachment %s in the Edit identity summary', async (attached) => {
    const { model, html } = setup(
      vi.fn().mockResolvedValue(
        json({
          items: [{ ...source, projectId: 'project-id', attached, hasCredential: true }],
          next: null,
        }),
      ),
      'acme',
    );
    await model.load();
    model.openEditor(model.snapshot().items[0]!);
    expect(html()).toContain(
      `<dt>Attached to this project</dt><dd>${attached ? 'Yes' : 'No'}</dd>`,
    );
    expect(html()).toContain('<dt>Credential</dt><dd>credential set · write-only</dd>');
  });

  it('does not reopen names over credential setup when a previous names request finishes', async () => {
    let finish!: (response: Response) => void;
    const { model } = setup(
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = model.names(SOURCE);
    model.chooseCredential(SOURCE);
    finish(json({ items: [], next: null }));
    await pending;
    expect(model.snapshot().names).toBeNull();
    expect(model.snapshot().credentialSource).toBe(SOURCE);
  });
});

describe('organization ownership filter', () => {
  it.each(['project', 'all'] as const)(
    'loads permissions in parallel once per %s page and keeps Enable after an empty page',
    async (ownership) => {
      let finish!: (response: Response) => void;
      const selected = { ...source, projectId: 'project-id', status: 'paused' as const };
      const fetch = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValueOnce(json({ items: [], next: null }));
      const { model, html, permissionsFetch } = setup(fetch);
      const pending = model.setOwnership(ownership);
      expect(fetch).toHaveBeenCalledOnce();
      expect(permissionsFetch).toHaveBeenCalledOnce();
      finish(json({ items: [selected], next: SOURCE }));
      await pending;
      expect(permissionsFetch).toHaveBeenCalledTimes(1);
      expect(html()).toContain('>Enable<');
      expect(html()).not.toContain('Source scope');
      await model.load(true);
      expect(permissionsFetch).toHaveBeenCalledTimes(1);
      expect(model.snapshot().items).toHaveLength(1);
      expect(html()).toContain('>Enable<');
      expect(model.enableNeedsAdmin(selected)).toBe(false);
    },
  );

  it('reveals the new organization source and next steps when created with Project-owned selected', async () => {
    const created = { ...source, type: 'hosted' as const, status: 'paused' as const };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [], next: null }))
      .mockResolvedValueOnce(json({ id: SOURCE }, 201))
      .mockResolvedValueOnce(json({ items: [created], next: null }));
    const { model, html } = setup(fetch);
    await model.setOwnership('project');
    model.openEditor();
    await model.saveSource({ name: source.name, type: 'hosted', ecosystem: 'npm' });
    expect(model.snapshot().ownership).toBe('organization');
    expect(fetch.mock.calls[2]?.[0]).toBe('/_pb/sources?limit=100');
    expect(model.snapshot().createdSource).toBe(SOURCE);
    expect(html().replace(/<!--.*?-->/g, '')).toContain(`Next steps for ${source.name}`);
  });

  it('reveals a successful create replay from the Project-owned filter', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [], next: null }))
      .mockResolvedValueOnce(
        json({ items: [{ ...source, type: 'hosted', status: 'paused' }], next: null }),
      );
    const { model, html } = setup(fetch);
    await model.setOwnership('project');
    await model.replayed({ path: '/_pb/sources', ok: true, status: 201, createdSourceId: SOURCE });
    expect(model.snapshot().ownership).toBe('organization');
    expect(model.snapshot().createdSource).toBe(SOURCE);
    expect(html().replace(/<!--.*?-->/g, '')).toContain(`Next steps for ${source.name}`);
  });

  it('does not cache an Enable denial for an organization-owned row on replay', async () => {
    const { model } = setup(
      vi.fn().mockResolvedValue(json({ items: [{ ...source, status: 'paused' }], next: null })),
    );
    await model.replayed({
      path: `/_pb/sources/${SOURCE}/enable`,
      ok: false,
      status: 403,
      code: 'forbidden',
    });
    expect(model.snapshot().enableDenied).toEqual([]);
  });

  it('loads project-owned rows and resets pagination on ownership changes', async () => {
    const projectSource = {
      ...source,
      projectId: 'project-id',
      projectName: 'Payments',
      status: 'paused',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [source], next: SOURCE }))
      .mockResolvedValueOnce(json({ items: [projectSource], next: SOURCE }))
      .mockResolvedValueOnce(json({ items: [], next: null }))
      .mockResolvedValueOnce(json({ items: [source, projectSource], next: null }));
    const { model, html } = setup(fetch);
    await model.load();
    expect(html()).toContain('Ownership');
    await model.setOwnership('project');
    expect(fetch.mock.calls[1]?.[0]).toBe('/_pb/sources?limit=100&ownership=project');
    expect(model.snapshot().items).toHaveLength(1);
    expect(html()).toContain('Project: Payments');
    expect(html()).toContain('>Enable<');
    expect(html()).not.toContain('>Edit<');
    expect(html()).not.toContain('Set credential');
    await model.load(true);
    expect(fetch.mock.calls[2]?.[0]).toContain(`after=${SOURCE}`);
    expect(fetch.mock.calls[2]?.[0]).toContain('ownership=project');
    await model.setOwnership('all');
    expect(fetch.mock.calls[3]?.[0]).toBe('/_pb/sources?limit=100&ownership=all');
    expect(model.snapshot().items).toHaveLength(2);
  });
  it('enables a project source from the organization list and refreshes the selected mode', async () => {
    const selected = {
      ...source,
      projectId: 'project-id',
      projectName: 'Payments',
      status: 'paused',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [selected], next: null }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ items: [{ ...selected, status: 'active' }], next: null }));
    const { model } = setup(fetch);
    await model.setOwnership('project');
    await model.togglePause(model.snapshot().items[0]!);
    expect(fetch.mock.calls[1]).toMatchObject([
      `/_pb/sources/${SOURCE}/enable`,
      { method: 'POST' },
    ]);
    expect(fetch.mock.calls[2]?.[0]).toBe('/_pb/sources?limit=100&ownership=project');
    expect(model.snapshot().items[0]?.status).toBe('active');
  });
  it('ignores an earlier page when the ownership filter changes during loading', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(
        json({
          items: [{ ...source, projectId: 'project-id', projectName: 'Payments' }],
          next: null,
        }),
      );
    const { model } = setup(fetch);
    const previous = model.load();
    await model.setOwnership('project');
    finish(json({ items: [source], next: SOURCE }));
    await previous;
    expect(model.snapshot().items[0]?.projectId).toBe('project-id');
    expect(model.snapshot().next).toBeNull();
  });
  it('requires organization source write permission to enable a project-owned row', async () => {
    const { model, html, fetch } = setup(
      vi.fn().mockResolvedValue(
        json({
          items: [
            { ...source, projectId: 'project-id', projectName: 'Payments', status: 'paused' },
          ],
          next: null,
        }),
      ),
      null,
      [],
    );
    await model.setOwnership('project');
    expect(html()).toContain('An organization admin must enable this source.');
    expect(html()).not.toContain('>Enable<');
    await model.togglePause(model.snapshot().items[0]!);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('sync status contract', () => {
  it('labels every exported error code', () => {
    for (const code of SOURCE_ERROR_CODES) {
      expect(SYNC_ERROR_LABELS[code], code).toEqual(expect.any(String));
      expect(SYNC_ERROR_LABELS[code].length).toBeGreaterThan(0);
    }
  });

  it.each(['npmjs_proxy', 'packagist_proxy'] as const)(
    'explains demand fill for %s',
    async (type) => {
      const { model, html } = setup(
        vi.fn().mockResolvedValue(json({ items: [{ ...source, type }], next: null })),
      );
      await model.load();
      expect(html()).toContain(PROXY_DEMAND_MESSAGE);
      expect(html()).toContain('Last listing:');
      expect(html()).toContain('Last listing error:');
    },
  );

  it('keeps one initially empty live region across source loads', async () => {
    const { model, html } = setup(
      vi
        .fn()
        .mockResolvedValue(
          json({ items: [{ ...source, projectId: 'project', status: 'paused' }], next: null }),
        ),
      'acme',
      [],
    );
    expect(html()).toContain('<p role="status" aria-live="polite"></p>');
    await model.load();
    expect(html().match(/<p role="status"/g)).toHaveLength(1);
    expect(html()).toContain('<p role="status" aria-live="polite"></p>');
  });

  it.each([403, 500])(
    'shows the admin message when permissions return %s and retries on full load',
    async (status) => {
      const fetch = vi.fn((input: string) =>
        Promise.resolve(
          input === '/_pb/me/permissions'
            ? json({ error: { code: 'forbidden', message: SECRET } }, status)
            : json({ items: [{ ...source, projectId: 'project', status: 'paused' }], next: null }),
        ),
      );
      const model = createSourcesModel(
        {
          client: createApiClient<paths>({ fetch, readCookie: () => undefined }),
          requireReauth: vi.fn(),
        },
        'acme',
      );
      await model.load();
      await model.load();
      const html = renderToString(createElement(SourcesView, { model }));
      expect(html).toContain('An organization admin must enable this source.');
      expect(html).not.toContain(SECRET);
      expect(fetch.mock.calls.filter(([input]) => input === '/_pb/me/permissions')).toHaveLength(2);
    },
  );

  it('routes permissions reauthentication through the failure handler', async () => {
    const requireReauth = vi.fn();
    const fetch = vi.fn((input: string) =>
      Promise.resolve(
        input === '/_pb/me/permissions'
          ? json({ error: { code: 'reauth_required', message: SECRET } }, 403)
          : json({ items: [], next: null }),
      ),
    );
    const model = createSourcesModel(
      { client: createApiClient<paths>({ fetch, readCookie: () => undefined }), requireReauth },
      'acme',
    );
    await model.load();
    expect(requireReauth).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/_pb/me/permissions' }),
      { credential: false, secretFields: [] },
    );
    expect(model.snapshot().error).toBe('Reauthentication is required.');
  });

  it('does not tell users to register names for an idempotency collision', async () => {
    const paused = { ...source, status: 'paused' as const };
    const { model, html } = setup(
      vi
        .fn()
        .mockResolvedValue(json({ error: { code: 'idempotency_mismatch', message: SECRET } }, 409)),
    );
    await model.togglePause(paused);
    expect(model.snapshot().error).toBeTruthy();
    expect(html()).not.toContain('Register package names, then enable the source.');
    expect(html()).not.toContain(SECRET);
  });

  it('polls after Sync now until listing state changes', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(json({ requested: true }, 202))
        .mockResolvedValueOnce(json({ items: [source], next: null }))
        .mockResolvedValue(json({ items: [{ ...source, lastPolledAt: NOW }], next: null }));
      const { model } = setup(fetch);
      await model.syncNow(source);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(model.snapshot().items[0]?.lastPolledAt).toBe(NOW);
      expect(fetch).toHaveBeenCalledTimes(3);
      model.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Round 2 source model regressions', () => {
  it('keeps the table, errors, and page two during an in-flight quiet poll', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (response: Response) => void;
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(json({ items: [source], next: SOURCE }))
        .mockResolvedValueOnce(json({ items: [{ ...source, id: 'second' }], next: null }))
        .mockResolvedValueOnce(json({ requested: true }, 202))
        .mockResolvedValueOnce(json({ items: [source], next: SOURCE }))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        );
      const { model, html } = setup(fetch);
      await model.load();
      await model.load(true);
      await model.syncNow(source);
      await model.edit(SOURCE, 0, 'flag');
      const error = model.snapshot().error;
      const second = model.snapshot().items[1];
      await vi.advanceTimersByTimeAsync(2_000);
      expect(model.snapshot().loading).toBe(false);
      expect(html()).toContain('<table');
      expect(html()).not.toContain('Loading sources');
      expect(model.snapshot().error).toBe(error);
      expect(model.snapshot().items[1]).toBe(second);
      finish(json({ items: [{ ...source, lastPolledAt: NOW }], next: SOURCE }));
      await vi.advanceTimersByTimeAsync(0);
      expect(model.snapshot().items[0]?.lastPolledAt).toBe(NOW);
      expect(model.snapshot().items[1]).toBe(second);
      expect(model.snapshot().error).toBe(error);
      model.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries failed permissions on full load, caches success, and never retries from polling', async () => {
    vi.useFakeTimers();
    try {
      const owned = { ...source, projectId: 'project' };
      const fetch = vi
        .fn()
        .mockImplementation(() => Promise.resolve(json({ items: [owned], next: null })));
      const { model, permissionsFetch, requireReauth } = setup(fetch, 'acme');
      permissionsFetch.mockResolvedValueOnce(json({ error: { code: 'reauth_required' } }, 403));
      await model.load();
      expect(model.snapshot().canEnableProjectSource).toBe(false);
      fetch.mockResolvedValueOnce(json({ requested: true }, 202));
      await model.syncNow(owned);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(permissionsFetch).toHaveBeenCalledTimes(1);
      expect(requireReauth).toHaveBeenCalledTimes(1);
      await model.load();
      expect(permissionsFetch).toHaveBeenCalledTimes(2);
      expect(model.snapshot().canEnableProjectSource).toBe(true);
      await model.load();
      expect(permissionsFetch).toHaveBeenCalledTimes(2);
      model.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes simultaneous list and permissions reauthentication once', async () => {
    const { model, permissionsFetch, requireReauth } = setup(
      vi.fn().mockResolvedValue(json({ error: { code: 'reauth_required' } }, 403)),
      'acme',
    );
    permissionsFetch.mockResolvedValueOnce(json({ error: { code: 'reauth_required' } }, 403));
    await model.load();
    expect(requireReauth).toHaveBeenCalledTimes(1);
    expect(model.snapshot().listError).toBe(true);
  });

  it('does not fetch permissions for the organization Sources page', async () => {
    const { model, permissionsFetch } = setup(
      vi.fn().mockResolvedValue(json({ items: [], next: null })),
    );
    await model.load();
    await model.load();
    expect(permissionsFetch).not.toHaveBeenCalled();
  });

  it.each([403, 500])('makes the permissions %s banner policy explicit', async (status) => {
    const { model, permissionsFetch, html } = setup(
      vi
        .fn()
        .mockResolvedValue(
          json({ items: [{ ...source, projectId: 'project', status: 'paused' }], next: null }),
        ),
      'acme',
    );
    permissionsFetch.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, status));
    await model.load();
    expect(html()).toContain('An organization admin must enable this source.');
    if (status === 403) {
      expect(model.snapshot().error).toBeNull();
      expect(html()).not.toContain('The request could not be saved or loaded.');
    } else {
      expect(model.snapshot().error).toBe(
        'The request could not be saved or loaded. Refresh and try again.',
      );
    }
  });

  it('announces next steps after creating a source', async () => {
    const { model, html } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(json({ id: SOURCE }, 201))
        .mockResolvedValueOnce(
          json({ items: [{ ...source, type: 'hosted', status: 'paused' }], next: null }),
        ),
    );
    model.openEditor();
    await model.saveSource({ name: source.name, type: 'hosted', ecosystem: 'npm' });
    expect(model.snapshot().notice).toBe(`Next steps for ${source.name}`);
    expect(html()).toContain(
      `<p role="status" aria-live="polite">Next steps for ${source.name}</p>`,
    );
  });

  it('clears only this source conflict before an Enable retry finishes', async () => {
    let finish!: (response: Response) => void;
    const { model } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(json({ error: { code: 'conflict' } }, 409))
        .mockResolvedValueOnce(json({ error: { code: 'conflict' } }, 409))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        ),
    );
    const paused = { ...source, status: 'paused' as const };
    await model.togglePause(paused);
    await model.togglePause({ ...paused, id: 'second' });
    const pending = model.togglePause(paused);
    expect(model.snapshot().enableConflicts).toEqual(['second']);
    finish(json({ error: { code: 'internal' } }, 500));
    await pending;
    expect(model.snapshot().enableConflicts).toEqual(['second']);
  });

  it.each(['conflict', 'forbidden'])('clears the %s announcement on full load', async (code) => {
    const { model } = setup(
      vi
        .fn()
        .mockResolvedValueOnce(json({ items: [], next: null }))
        .mockResolvedValueOnce(json({ error: { code } }, code === 'conflict' ? 409 : 403))
        .mockResolvedValueOnce(json({ items: [], next: null })),
      'acme',
    );
    await model.load();
    await model.togglePause({ ...source, projectId: 'project', status: 'paused' });
    expect(model.snapshot().notice).toBeTruthy();
    await model.load();
    expect(model.snapshot().notice).toBeNull();
    expect(model.snapshot().enableDenied).toEqual([]);
    expect(model.snapshot().enableConflicts).toEqual([]);
  });

  it('caps polling through the model after fifteen timer refreshes', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(json({ requested: true }, 202))
        .mockImplementation(() => Promise.resolve(json({ items: [source], next: null })));
      const { model } = setup(fetch);
      await model.syncNow(source);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetch).toHaveBeenCalledTimes(17);
      expect(vi.getTimerCount()).toBe(0);
      model.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'disposes model polling with an in-flight refresh: %s',
    async (inFlight) => {
      vi.useFakeTimers();
      try {
        let finish!: (response: Response) => void;
        const fetch = vi
          .fn()
          .mockResolvedValueOnce(json({ requested: true }, 202))
          .mockResolvedValueOnce(json({ items: [source], next: null }))
          .mockImplementationOnce(
            () =>
              new Promise<Response>((resolve) => {
                finish = resolve;
              }),
          );
        const { model } = setup(fetch);
        await model.syncNow(source);
        if (inFlight) await vi.advanceTimersByTimeAsync(2_000);
        const before = model.snapshot();
        model.dispose();
        if (inFlight) finish(json({ items: [{ ...source, lastPolledAt: NOW }], next: null }));
        await vi.advanceTimersByTimeAsync(120_000);
        expect(fetch).toHaveBeenCalledTimes(inFlight ? 3 : 2);
        expect(model.snapshot()).toBe(before);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

it('does not start polling when the sync response arrives after model disposal', async () => {
  vi.useFakeTimers();
  try {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockImplementation(() => Promise.resolve(json({ items: [source], next: null })));
    const { model } = setup(fetch);
    const pending = model.syncNow(source);
    model.dispose();
    finish(json({ requested: true }, 202));
    await pending;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
