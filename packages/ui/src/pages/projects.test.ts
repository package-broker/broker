import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import { createReauthFlow } from '../auth.js';
import { ManagementFilters } from './management.js';
import {
  ProjectsView,
  buildProjectsHash,
  createProjectsController,
  parseProjectsHash,
} from './projects.js';

const project = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  slug: 'web',
  name: 'Website',
  status: 'active',
  revision: 7,
  tokenMaxScope: 'read',
  requirePublishApproval: false,
};
function fixture(
  options: {
    status?: number;
    code?: string;
    etag?: boolean;
    listEtag?: boolean;
    permissions?: boolean;
    archived?: boolean;
  } = {},
) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method !== 'GET')
      return options.status
        ? Response.json(
            {
              error: {
                code: options.code ?? 'invalid_request',
                message: 'private-message',
                details: [{ path: 'private-details', code: 'invalid' }],
              },
            },
            { status: options.status },
          )
        : new Response(null, { status: 204 });
    if (url === '/_pb/me/permissions')
      return Response.json({
        organization:
          options.permissions === false ? [] : ['org:projects:create', 'org:projects:archive'],
      });
    if (url.endsWith('/permissions'))
      return Response.json({
        project: options.permissions === false ? [] : ['project:settings:write'],
      });
    const data = { ...project, status: options.archived ? 'archived' : 'active' };
    if (url === '/_pb/projects/web')
      return Response.json(data, { headers: options.etag === false ? {} : { ETag: '"r7"' } });
    return Response.json({
      items: [{ ...data, ...(options.listEtag ? { etag: '"r7"' } : {}) }],
      next: null,
    });
  });
  const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
  const requireReauth = vi.fn();
  const controller = createProjectsController({ client, requireReauth });
  return { controller, fetch, client, requireReauth };
}
const markup = (controller: ReturnType<typeof createProjectsController>) =>
  renderToString(createElement(ProjectsView, { state: controller.snapshot(), controller }));
const query = { project: 'web' };

describe('projects', () => {
  it('round trips hash filters and replaces the cursor when filters change', () => {
    const parsed = parseProjectsHash('#/projects?status=archived&q=ab&after=p_9');
    expect(parsed).toEqual({ project: null, status: 'archived', q: 'ab', after: 'p_9' });
    expect(buildProjectsHash({ ...parsed, status: 'active', after: undefined })).toBe(
      '#/projects?status=active&q=ab',
    );
    expect(parseProjectsHash(buildProjectsHash(parsed))).toEqual(parsed);
  });
  it('loads both statuses when All statuses is selected, with independent pagination', async () => {
    const { controller, fetch } = fixture();
    fetch.mockImplementation(async (url: string) => {
      if (url === '/_pb/me/permissions') return Response.json({ organization: [] });
      const params = new URL(url, 'https://broker.test').searchParams;
      const archived = params.get('status') === 'archived';
      const later = params.has('after');
      return Response.json({
        items: [
          {
            ...project,
            id: archived ? 'archived' : later ? 'active-2' : 'active',
            status: archived ? 'archived' : 'active',
          },
        ],
        next: !archived && !later ? 'active/+=' : null,
      });
    });
    await controller.load({ project: null });
    expect(controller.snapshot().items.map((item) => item.id)).toEqual(['active', 'archived']);
    const after = controller.snapshot().next;
    expect(after).toBeTruthy();
    fetch.mockClear();
    await controller.load({ project: null, after: after! });
    expect(controller.snapshot().items.map((item) => item.id)).toEqual(['active-2']);
    expect(controller.snapshot().next).toBeNull();
    expect(
      fetch.mock.calls.filter(([url]) => url.startsWith('/_pb/projects')).map(([url]) => url),
    ).toEqual(['/_pb/projects?status=active&after=active%2F%2B%3D&limit=50']);
  });
  it('reports an error instead of a partial All statuses list when archived loading fails', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) =>
      url.includes('status=archived')
        ? Response.json({ error: { code: 'forbidden' } }, { status: 403 })
        : original(url, init),
    );
    await f.controller.load({ project: null });
    expect(f.controller.snapshot().listError).toBe(true);
    expect(f.controller.snapshot().items).toEqual([]);
    expect(f.controller.snapshot().next).toBeNull();
  });
  it.each(['active', 'archived'] as const)(
    'keeps the %s filter on a single API cursor',
    async (status) => {
      const f = fixture();
      await f.controller.load({ project: null, status, after: 'opaque/+=' });
      expect(
        f.fetch.mock.calls.filter(([url]) => url.startsWith('/_pb/projects')).map(([url]) => url),
      ).toEqual([`/_pb/projects?status=${status}&after=opaque%2F%2B%3D&limit=50`]);
    },
  );
  it('rejects a malformed combined project cursor without sending it upstream', async () => {
    const f = fixture();
    await f.controller.load({ project: null, after: 'all:[{},null]' });
    expect(f.controller.snapshot().listError).toBe(true);
    expect(f.fetch.mock.calls.some(([url]) => url.startsWith('/_pb/projects'))).toBe(false);
  });
  it.each(['create', 'update', 'archive', 'restore'] as const)(
    'invalidates shared scope options after %s succeeds',
    async (action) => {
      const f = fixture({ listEtag: true, archived: action === 'restore' });
      const onProjectsChanged = vi.fn();
      const controller = createProjectsController({
        client: f.client,
        requireReauth: f.requireReauth,
        onProjectsChanged,
      });
      await controller.load(query);
      expect(onProjectsChanged).not.toHaveBeenCalled();
      if (action === 'create')
        await controller.create({
          name: 'New',
          slug: 'new',
          tokenMaxScope: 'read',
          requirePublishApproval: false,
        });
      else if (action === 'update') await controller.update({ name: 'Renamed' });
      else await controller.transitionItem(project.id);
      expect(onProjectsChanged).toHaveBeenCalledOnce();
    },
  );
  it('invalidates scope options when an in-flight project mutation succeeds after leaving the page', async () => {
    const f = fixture();
    const onProjectsChanged = vi.fn();
    const controller = createProjectsController({
      client: f.client,
      requireReauth: f.requireReauth,
      onProjectsChanged,
    });
    await controller.load(query);
    let finish!: (response: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const saving = controller.update({ name: 'Renamed' });
    controller.dispose();
    finish(new Response(null, { status: 204 }));
    await saving;
    expect(onProjectsChanged).toHaveBeenCalledOnce();
  });
  it('does not invalidate scope options after a refused project mutation', async () => {
    const f = fixture({ status: 403 });
    const onProjectsChanged = vi.fn();
    const controller = createProjectsController({
      client: f.client,
      requireReauth: f.requireReauth,
      onProjectsChanged,
    });
    await controller.load(query);
    await controller.update({ name: 'Refused' });
    expect(onProjectsChanged).not.toHaveBeenCalled();
  });
  it('drops unknown keys', () => {
    expect(buildProjectsHash(parseProjectsHash('#/projects?unknown=private'))).toBe('#/projects');
  });
  it('drops malformed statuses without rendering raw markup', async () => {
    const { controller } = fixture();
    await controller.load(parseProjectsHash('#/projects?status=<script>'));
    expect(markup(controller)).not.toContain('<script>');
    expect(controller.snapshot().query.status).toBeUndefined();
  });
  it('filters project names by prefix from the hash', async () => {
    const { controller } = fixture();
    await controller.load(parseProjectsHash('#/projects?q=else'));
    expect(markup(controller)).not.toContain('Website');
  });
  it('labels the prefix filter as filtering loaded projects', () => {
    const html = renderToString(
      createElement(ManagementFilters, {
        route: 'projects',
        query: { project: null },
        statuses: ['active', 'archived'],
      }),
    );
    expect(html).toContain('filtering loaded projects');
  });
  it('keeps pagination available when no loaded projects match the prefix', async () => {
    const { controller } = fixture();
    await controller.load({ project: null, q: 'else', after: 'p_9' });
    const state = { ...controller.snapshot(), next: 'p_10' };
    const html = renderToString(createElement(ProjectsView, { state, controller }));
    expect(html).not.toContain('Website');
    expect(html).toContain('Filtering loaded projects on this page.');
    expect(html).toContain('Next projects');
    expect(html).toContain('q=else&amp;after=p_10');
  });
  it('sends the last response ETag on settings updates', async () => {
    const { controller, fetch } = fixture();
    await controller.load(query);
    await controller.update({
      name: 'New name',
      tokenMaxScope: 'write',
      requirePublishApproval: true,
    });
    expect(fetch.mock.calls.find(([, init]) => init.method === 'PATCH')?.[1].headers).toMatchObject(
      { 'If-Match': '"r7"' },
    );
  });
  it('shows reload after 412 and never retries the write', async () => {
    const { controller, fetch } = fixture({ status: 412, code: 'precondition_failed' });
    await controller.load(query);
    await controller.transition();
    await controller.transition();
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(markup(controller)).toContain('Changed elsewhere. Reload');
  });
  it('does not show archive without an ETag', async () => {
    const { controller, fetch } = fixture({ etag: false });
    await controller.load(query);
    expect(markup(controller)).not.toContain('>Archive<');
    await controller.transition();
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });
  it('does not show restore without an ETag', async () => {
    const { controller, fetch } = fixture({ etag: false, archived: true });
    await controller.load(query);
    expect(markup(controller)).not.toContain('>Restore<');
    await controller.transition();
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it('restores a project only with a known ETag', async () => {
    const { controller, fetch } = fixture({ archived: true });
    await controller.load(query);
    await controller.transition();
    expect(fetch.mock.calls.find(([, init]) => init.method === 'POST')).toMatchObject([
      '/_pb/projects/web/restore',
      { headers: { 'If-Match': '"r7"' } },
    ]);
  });
  it('hides writes from readers and refuses controller writes', async () => {
    const { controller, fetch } = fixture({ permissions: false });
    await controller.load(query);
    expect(markup(controller)).not.toContain('>Archive<');
    expect(markup(controller)).not.toContain('>Create project<');
    await controller.update({ name: 'Denied' });
    await controller.transition();
    await controller.create({ name: 'Denied', slug: 'denied' });
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it('saves a body-free archive action for reauth without retrying', async () => {
    const { client, fetch } = fixture({ status: 403, code: 'reauth_required' });
    const stored = new Map<string, string>();
    const flow = createReauthFlow({
      client,
      now: () => 1,
      navigate: vi.fn(),
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => {
          stored.set(key, value);
        },
        removeItem: (key) => {
          stored.delete(key);
        },
      },
    });
    const controller = createProjectsController({
      client,
      requireReauth: (request, options) =>
        flow.requireReauth(request, options, '#/projects?project=web&q=ab'),
    });
    await controller.load(query);
    await controller.transition();
    const pending = JSON.parse([...stored.values()][0]!);
    expect(pending).toMatchObject({
      method: 'POST',
      path: '/_pb/projects/web/archive',
      headers: { 'If-Match': '"r7"' },
    });
    expect(pending.body).toBeUndefined();
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
  it('never renders a 400 details path', async () => {
    const { controller } = fixture({ status: 400 });
    await controller.load(query);
    await controller.update({ name: 'Name' });
    expect(markup(controller)).not.toContain('private-details');
  });
  it('never renders a 409 response message', async () => {
    const { controller } = fixture({ status: 409, code: 'conflict' });
    await controller.load(query);
    await controller.transition();
    expect(markup(controller)).not.toContain('private-message');
  });
  it('adds an idempotency key to project creation', async () => {
    const { controller, fetch } = fixture();
    await controller.load({ project: null });
    await controller.create({ name: 'Another', slug: 'another' });
    expect(fetch.mock.calls.find(([, init]) => init.method === 'POST')?.[1].headers).toHaveProperty(
      'Idempotency-Key',
    );
  });
  it('keeps restore unavailable when the API refuses archived details', async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url) => {
      if (url === '/_pb/me/permissions')
        return Response.json({ organization: ['org:projects:archive'] });
      if (url.endsWith('/permissions')) return Response.json({ project: [] });
      if (url === '/_pb/projects/web')
        return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      return Response.json({ items: [{ ...project, status: 'archived' }], next: null });
    });
    const controller = createProjectsController({
      client: createApiClient<paths>({ fetch, readCookie: () => undefined }),
      requireReauth: vi.fn(),
    });
    await controller.load({ project: 'web', status: 'archived' });
    await controller.transition();
    expect(markup(controller)).not.toContain('>Restore<');
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it('ignores a late list from an earlier filter selection', async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(async (url: string) => {
      if (url === '/_pb/me/permissions') return Response.json({ organization: [] });
      if (url.includes('status=active'))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return Response.json({ items: [], next: null });
    });
    const controller = createProjectsController({
      client: createApiClient<paths>({ fetch, readCookie: () => undefined }),
      requireReauth: vi.fn(),
    });
    const first = controller.load({ project: null, status: 'active' });
    await controller.load({ project: null, status: 'archived' });
    release(Response.json({ items: [project], next: null }));
    await first;
    expect(controller.snapshot().items).toEqual([]);
    expect(controller.snapshot().query.status).toBe('archived');
  });
  it('keeps a failed replay in the reload state without another request', async () => {
    const { controller, fetch } = fixture();
    await controller.load(query);
    const count = fetch.mock.calls.length;
    await controller.replayed({ path: '/_pb/projects/web/archive', ok: false, status: 412 });
    expect(fetch.mock.calls).toHaveLength(count);
    expect(markup(controller)).toContain('Changed elsewhere. Reload');
  });
});

describe('project list presentation', () => {
  it('renders responsive columns, the status badge and copyable ID', async () => {
    const { controller } = fixture();
    await controller.load({ project: null });
    const html = markup(controller);
    expect(html).toContain('responsive-table');
    expect(html).toContain('data-label="Status"');
    expect(html).toContain('>Active<');
    expect(html).toContain('aria-label="Copy project ID"');
    expect(html).toContain(`title="${project.id}"`);
    expect(html).toContain('New project');
    expect(html).not.toContain('<dialog');
  });
  it('distinguishes loading, empty, filtered-empty and failed loading', async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json(
        url === '/_pb/me/permissions' ? { organization: [] } : { items: [], next: null },
      ),
    );
    const controller = createProjectsController({
      client: createApiClient<paths>({ fetch, readCookie: () => undefined }),
      requireReauth: vi.fn(),
    });
    const loading = controller.load({ project: null });
    expect(markup(controller)).toContain('data-list-state="loading"');
    await loading;
    expect(markup(controller)).toContain('data-list-state="empty"');
    await controller.load({ project: null, q: 'none' });
    expect(markup(controller)).toContain('data-list-state="filtered-empty"');
    fetch.mockImplementation(async () =>
      Response.json({ error: { code: 'forbidden', message: 'private-response' } }, { status: 403 }),
    );
    await controller.load({ project: null });
    expect(markup(controller)).toContain('data-list-state="error"');
    expect(markup(controller)).not.toContain('data-list-state="empty"');
    expect(markup(controller)).not.toContain('private-response');
  });
});

describe('project row actions', () => {
  it.each([false, true])(
    'transitions an unselected project with its list ETag; archived=%s',
    async (archived) => {
      const { controller, fetch } = fixture({ archived, listEtag: true });
      await controller.load({ project: null });
      expect(controller.snapshot().selected).toBeNull();
      expect(markup(controller)).toContain(archived ? '>Restore<' : '>Archive<');
      expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
      await controller.transitionItem(project.id);
      expect(fetch.mock.calls.find(([, init]) => init.method === 'POST')).toMatchObject([
        `/_pb/projects/web/${archived ? 'restore' : 'archive'}`,
        { headers: { 'If-Match': '"r7"' } },
      ]);
    },
  );
  it.each([{ permissions: false, listEtag: true }, { listEtag: false }])(
    'refuses row writes without permission or an ETag: %j',
    async (options) => {
      const { controller, fetch } = fixture(options);
      await controller.load({ project: null });
      await controller.transitionItem(project.id);
      await controller.transitionItem('unknown');
      expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
      expect(markup(controller)).not.toContain('>Archive<');
    },
  );
  it('does not retry a conflicted row transition until reload', async () => {
    const { controller, fetch } = fixture({ listEtag: true, status: 412 });
    await controller.load({ project: null });
    await controller.transitionItem(project.id);
    await controller.transitionItem(project.id);
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(markup(controller)).toContain('Changed elsewhere. Reload');
  });
  it.each([null, 'web'])(
    'refreshes a list action replay and preserves filters and cursor; selected=%s',
    async (selected) => {
      const { controller, fetch } = fixture({ listEtag: true });
      const query = { project: selected, q: 'Web', after: 'cursor', status: 'active' as const };
      await controller.load(query);
      const before = fetch.mock.calls.length;
      await controller.replayed({ path: '/_pb/projects/web/archive', ok: true, status: 204 });
      expect(fetch.mock.calls.length).toBeGreaterThan(before);
      expect(controller.snapshot().query).toEqual(query);
      expect(markup(controller)).toContain('Project updated.');
    },
  );
});
