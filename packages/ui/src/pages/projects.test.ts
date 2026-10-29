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
  projectsViewModel,
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
  it('loads both statuses for an admin with independent pagination', async () => {
    const { controller, fetch } = fixture();
    fetch.mockImplementation(async (url: string) => {
      if (url === '/_pb/me/permissions')
        return Response.json({ organization: ['org:projects:archive', 'project:read'] });
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
  it('shows active projects for a member without requesting archived projects', async () => {
    const f = fixture({ permissions: false });
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) =>
      url.includes('status=archived')
        ? Response.json({ error: { code: 'forbidden' } }, { status: 403 })
        : original(url, init),
    );
    await f.controller.load({ project: null });
    expect(f.controller.snapshot().listError).toBe(false);
    expect(markup(f.controller)).toContain('Website');
    expect(f.fetch.mock.calls.filter(([url]) => url.startsWith('/_pb/projects'))).toEqual([
      ['/_pb/projects?status=active&limit=50', expect.anything()],
    ]);
  });
  it('keeps active projects when an admin archived request is refused', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) =>
      url === '/_pb/me/permissions'
        ? Response.json({ organization: ['org:projects:archive', 'project:read'] })
        : url.includes('status=archived')
          ? Response.json({ error: { code: 'forbidden' } }, { status: 403 })
          : original(url, init),
    );
    await f.controller.load({ project: null });
    expect(f.controller.snapshot().listError).toBe(false);
    expect(f.controller.snapshot().items).toHaveLength(1);
    expect(markup(f.controller)).toContain('Website');
    expect(f.controller.snapshot().next).toBeNull();
    expect(f.fetch.mock.calls.some(([url]) => url.includes('status=archived'))).toBe(true);
  });
  it('uses only the active cursor when a member follows a combined page link', async () => {
    const f = fixture({ permissions: false });
    await f.controller.load({ project: null, after: 'all:["active-next","archived-next"]' });
    expect(f.fetch.mock.calls.filter(([url]) => url.startsWith('/_pb/projects'))).toEqual([
      ['/_pb/projects?status=active&after=active-next&limit=50', expect.anything()],
    ]);
    f.fetch.mockClear();
    await f.controller.load({ project: null, after: 'all:[null,"archived-next"]' });
    expect(f.controller.snapshot().items).toEqual([]);
    expect(f.controller.snapshot().next).toBeNull();
    expect(f.fetch.mock.calls.some(([url]) => url.startsWith('/_pb/projects'))).toBe(false);
  });
  it('keeps unexpected archived failures visible to admins', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) =>
      url === '/_pb/me/permissions'
        ? Response.json({ organization: ['org:projects:archive', 'project:read'] })
        : url.includes('status=archived')
          ? Response.json({ error: { code: 'internal_error' } }, { status: 500 })
          : original(url, init),
    );
    await f.controller.load({ project: null });
    expect(f.controller.snapshot().listError).toBe(true);
    expect(f.controller.snapshot().items).toEqual([]);
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
    expect(html).toContain('Search this page (name prefix)');
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
    });
    expect(
      JSON.parse(String(fetch.mock.calls.find(([, init]) => init.method === 'PATCH')?.[1].body)),
    ).toEqual({ name: 'New name', tokenMaxScope: 'write' });
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
  it('keeps restore unavailable without a list ETag when archived details return 404', async () => {
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
    expect(controller.snapshot().query.project).toBeNull();
    expect(markup(controller)).toContain('Project archived.');
    await controller.transition();
    expect(markup(controller)).not.toContain('>Restore<');
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it.each(['settings', 'row', 'reload', 'replay'] as const)(
    'recovers an archived selection with Restore available after %s',
    async (action) => {
      const f = fixture();
      let archived = action === 'reload';
      f.fetch.mockImplementation(async (url, init) => {
        if (init.method === 'POST') {
          archived = !url.endsWith('/restore');
          return new Response(null, { status: 204 });
        }
        if (url === '/_pb/me/permissions')
          return Response.json({ organization: ['org:projects:archive'] });
        if (url.endsWith('/permissions')) return Response.json({ project: [] });
        if (url === '/_pb/projects/web')
          return archived
            ? Response.json({ error: { code: 'not_found' } }, { status: 404 })
            : Response.json(project, { headers: { ETag: '"r7"' } });
        const params = new URL(url, 'https://broker.test').searchParams;
        const status = params.get('status');
        // The archived target is on a later page, outside the old active filter and cursor.
        if (archived && status === 'archived' && !params.has('after'))
          return Response.json({ items: [], next: 'archived-page-2' });
        return Response.json({
          items:
            archived && status === 'active'
              ? []
              : [
                  {
                    ...project,
                    status: archived ? 'archived' : 'active',
                    etag: archived ? '"r8"' : '"r7"',
                  },
                ],
          next: null,
        });
      });
      await f.controller.load({ project: 'web', status: 'active', q: 'missing', after: 'old' });
      if (action === 'settings') await f.controller.transition();
      if (action === 'row') await f.controller.transitionItem(project.id);
      if (action === 'replay') {
        archived = true;
        await f.controller.replayed({ path: '/_pb/projects/web/archive', ok: true, status: 204 });
      }
      expect(f.controller.snapshot().query).toEqual({
        project: null,
        status: 'archived',
        after: 'archived-page-2',
      });
      expect(f.controller.snapshot().selected).toBeNull();
      expect(markup(f.controller)).toContain('Project archived.');
      expect(markup(f.controller)).not.toContain('Not found');
      expect(markup(f.controller)).toContain('More actions for Website');
      expect(f.controller.snapshot().items[0]?.etag).toBeDefined();
      await f.controller.transitionItem(project.id);
      expect(f.fetch.mock.calls.find(([url]) => url.endsWith('/restore'))).toMatchObject([
        '/_pb/projects/web/restore',
        { headers: { 'If-Match': '"r8"' } },
      ]);
    },
  );
  it.each(['settings', 'row', 'replay'] as const)(
    'preserves confirmed archive success when a non-admin cannot list archived projects: %s',
    async (action) => {
      const f = fixture();
      let archived = false;
      f.fetch.mockImplementation(async (url, init) => {
        if (init.method === 'POST') {
          archived = true;
          return new Response(null, { status: 204 });
        }
        if (url === '/_pb/me/permissions')
          return Response.json({ organization: ['org:projects:archive'] });
        if (url.endsWith('/permissions')) return Response.json({ project: [] });
        if (url === '/_pb/projects/web')
          return archived
            ? Response.json({ error: { code: 'not_found' } }, { status: 404 })
            : Response.json(project, { headers: { ETag: '"r7"' } });
        if (url.includes('status=archived'))
          return Response.json({ error: { code: 'forbidden' } }, { status: 403 });
        return Response.json({
          items: archived ? [] : [{ ...project, etag: '"r7"' }],
          next: null,
        });
      });
      const activeQuery = { project: null, status: 'active', q: 'web' } as const;
      await f.controller.load({
        ...activeQuery,
        project: action === 'settings' ? 'web' : null,
      });
      if (action === 'settings') await f.controller.transition();
      if (action === 'row') await f.controller.transitionItem(project.id);
      if (action === 'replay') {
        archived = true;
        await f.controller.replayed({ path: '/_pb/projects/web/archive', ok: true, status: 204 });
      }
      expect(f.fetch.mock.calls.some(([url]) => url.includes('status=archived'))).toBe(true);
      expect(f.controller.snapshot()).toMatchObject({
        query: activeQuery,
        selected: null,
        etag: null,
        permissions: [],
        items: [],
        listError: false,
        notice: 'Project archived.',
      });
      expect(buildProjectsHash(f.controller.snapshot().query)).toBe(
        '#/projects?status=active&q=web',
      );
      expect(markup(f.controller)).not.toContain('Not found');
      expect(markup(f.controller)).not.toContain('>Restore<');
      await f.controller.load(f.controller.snapshot().query);
      expect(markup(f.controller)).toContain('Project archived.');
    },
  );
  it.each(['settings', 'replay'] as const)(
    'recovers confirmed archive success from a failed All statuses list: %s',
    async (action) => {
      const f = fixture();
      let archived = false;
      const remaining = { ...project, id: 'remaining', slug: 'other', name: 'Other' };
      f.fetch.mockImplementation(async (url, init) => {
        if (init.method === 'POST') {
          archived = true;
          return new Response(null, { status: 204 });
        }
        if (url === '/_pb/me/permissions')
          return Response.json({ organization: ['org:projects:archive'] });
        if (url.endsWith('/permissions')) return Response.json({ project: [] });
        if (url === '/_pb/projects/web')
          return archived
            ? Response.json({ error: { code: 'not_found' } }, { status: 404 })
            : Response.json(project, { headers: { ETag: '"r7"' } });
        if (url.includes('status=archived'))
          return Response.json({ error: { code: 'forbidden' } }, { status: 403 });
        return Response.json({ items: archived ? [remaining] : [project], next: null });
      });
      const original = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (url, init) =>
        url.includes('status=active') && url.includes('after=old')
          ? Response.json({ error: { code: 'invalid_request' } }, { status: 400 })
          : original(url, init),
      );
      await f.controller.load({
        project: 'web',
        q: 'Other',
        after: 'all:["old","archived-old"]',
      });
      expect(f.controller.snapshot().listError).toBe(true);
      expect(f.controller.snapshot().selected).toMatchObject({ slug: 'web' });
      f.fetch.mockClear();
      if (action === 'settings') await f.controller.transition();
      else {
        archived = true;
        await f.controller.replayed({ path: '/_pb/projects/web/archive', ok: true, status: 204 });
      }
      expect(f.controller.snapshot()).toMatchObject({
        query: { project: null, status: 'active', q: 'Other' },
        selected: null,
        etag: null,
        permissions: [],
        items: [remaining],
        next: null,
        listError: false,
        notice: 'Project archived.',
      });
      expect(buildProjectsHash(f.controller.snapshot().query)).toBe(
        '#/projects?status=active&q=Other',
      );
      expect(
        f.fetch.mock.calls.some(([url]) => url === '/_pb/projects?status=active&limit=50'),
      ).toBe(true);
      expect(markup(f.controller)).not.toContain('do not have permission');
      expect(markup(f.controller)).not.toContain('Not found');
      await f.controller.load(f.controller.snapshot().query);
      expect(f.controller.snapshot().notice).toBe('Project archived.');
    },
  );
  it.each([404, 403])('keeps a genuine detail failure visible: %s', async (status) => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) =>
      url === '/_pb/projects/web'
        ? Response.json({ error: { code: status === 404 ? 'not_found' : 'forbidden' } }, { status })
        : url.includes('status=archived')
          ? Response.json({ items: [], next: null })
          : original(url, init),
    );
    await f.controller.load(query);
    expect(f.controller.snapshot().query).toEqual(query);
    expect(markup(f.controller)).toContain(status === 404 ? 'Not found' : 'do not have permission');
    expect(markup(f.controller)).not.toContain('Project archived.');
  });
  it('ignores archived recovery after the user selects another filter', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    let finish!: (response: Response) => void;
    f.fetch.mockImplementation(async (url, init) => {
      if (url === '/_pb/projects/web')
        return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      if (url.includes('status=archived'))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return original(url, init);
    });
    const loading = f.controller.load({ project: 'web', status: 'active' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await f.controller.load({ project: null, status: 'active' });
    finish(
      Response.json({ items: [{ ...project, status: 'archived', etag: '"r8"' }], next: null }),
    );
    await loading;
    expect(f.controller.snapshot().query).toEqual({ project: null, status: 'active' });
    expect(f.controller.snapshot().notice).toBeNull();
  });
  it('keeps an archived lookup failure from becoming a success notice', async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) =>
      url === '/_pb/projects/web' || url.includes('status=archived')
        ? Response.json({ error: { code: 'not_found' } }, { status: 404 })
        : original(url, init),
    );
    await f.controller.load({ project: 'web', status: 'active' });
    expect(f.controller.snapshot().query.project).toBe('web');
    expect(markup(f.controller)).toContain('Not found');
    expect(markup(f.controller)).not.toContain('Project archived.');
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
    expect(html).toContain('readable-desktop');
    expect(html).toContain('readable-mobile');
    expect(html).toContain('>Status</dt>');
    expect(html).toContain('>Active<');
    expect(html).toContain('aria-label="More actions for Website"');
    expect(html).not.toContain(project.id);
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
      expect(markup(controller)).toContain('More actions for Website');
      expect(controller.snapshot().items[0]).toMatchObject({
        status: archived ? 'archived' : 'active',
        etag: '"r7"',
      });
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
      expect(
        !projectsViewModel(controller.snapshot()).transitionItems ||
          controller.snapshot().items.every((item) => !item.etag),
      ).toBe(true);
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
    'refreshes a restore replay and preserves filters and cursor; selected=%s',
    async (selected) => {
      const { controller, fetch } = fixture({ listEtag: true });
      const query = { project: selected, q: 'Web', after: 'cursor', status: 'active' as const };
      await controller.load(query);
      const before = fetch.mock.calls.length;
      await controller.replayed({ path: '/_pb/projects/web/restore', ok: true, status: 204 });
      expect(fetch.mock.calls.length).toBeGreaterThan(before);
      expect(controller.snapshot().query).toEqual(query);
      expect(markup(controller)).toContain('Project updated.');
    },
  );
});

describe('project form write results', () => {
  it('returns field refusals to the form without reloading its draft', async () => {
    const { controller, fetch } = fixture({ status: 409, code: 'duplicate' });
    await controller.load({ project: null });
    const before = fetch.mock.calls.filter(([, init]) => init.method === 'GET').length;
    const result = await controller.create({
      name: 'Typed name',
      slug: 'typed',
      tokenMaxScope: 'read',
    });
    expect(result).toMatchObject({ ok: false, code: 'duplicate' });
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(before);
    expect(markup(controller)).toContain('aria-label="New project"');
    expect(markup(controller)).not.toContain('private-message');
  });
  it('keeps settings mounted and refuses repeat writes after a revision conflict', async () => {
    const { controller, fetch } = fixture({ status: 412, code: 'precondition_failed' });
    await controller.load(query);
    const result = await controller.update({ name: 'Typed name', tokenMaxScope: 'read' });
    expect(result).toMatchObject({ ok: false, status: 412 });
    expect(markup(controller)).toContain('aria-label="Project settings"');
    expect(markup(controller)).toContain(
      'This project changed while you were editing. Reload the latest settings before saving.',
    );
    await controller.update({ name: 'Typed name', tokenMaxScope: 'read' });
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(1);
  });
  it.each([
    ['/_pb/projects', 'Project created.'],
    ['/_pb/projects/web', 'Access policy saved. Existing tokens now use this limit.'],
  ])('announces success after replaying %s', async (path, notice) => {
    const { controller } = fixture();
    await controller.load(query);
    await controller.replayed({ path, ok: true, status: 204 });
    expect(controller.snapshot().notice).toBe(notice);
  });
  it('explains a settings replay conflict without hiding the form', async () => {
    const { controller } = fixture();
    await controller.load(query);
    await controller.replayed({ path: '/_pb/projects/web', ok: false, status: 412 });
    expect(controller.snapshot().notice).toBe(
      'This project changed while you were editing. Reload the latest settings before saving.',
    );
    expect(markup(controller)).toContain('aria-label="Project settings"');
  });
});
