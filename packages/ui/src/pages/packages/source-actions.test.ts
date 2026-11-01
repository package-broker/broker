import { SourceForm } from '../sources/source-form.js';
import { SYNC_REQUESTED } from '../sources/sync-copy.js';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api.js';
import type { paths } from '../../api-types.js';
import type { Source } from '../sources.js';
import {
  AddChoices,
  canSync,
  createSourceActions,
  mirrorSource,
  sourceHealth,
  syncScope,
} from './source-actions.js';

const source: Source = {
  revision: 1,
  id: 'source',
  name: 'Packagist',
  type: 'packagist_proxy',
  ecosystem: 'composer',
  projectId: null,
  attached: true,
  precedence: 0,
  status: 'active',
  lastSuccessAt: null,
  lastPolledAt: null,
  nextPollAt: null,
  lastError: null,
  url: null,
  removalPolicy: 'flag',
  pollIntervalSeconds: 300,
  hasCredential: false,
  lastRemovalRefusal: null,
  removalAcceptanceArmed: false,
};
function setup({
  organization = [] as string[],
  permissions = ['project:sources:write'],
  status = 202,
  items = [source],
  active = true,
} = {}) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST')
      return status >= 400
        ? Response.json(
            {
              error: {
                code: status === 403 ? 'forbidden' : 'unavailable',
                message: 'secret-sentinel',
              },
            },
            { status },
          )
        : url.endsWith('/sync')
          ? new Response(null, { status: 202 })
          : Response.json(
              { name: 'vendor/name', state: status === 200 ? 'present' : 'queued' },
              { status },
            );
    if (url === '/_pb/me/permissions') return Response.json({ organization });
    if (url.endsWith('/permissions')) return Response.json({ project: permissions });
    if (url === '/_pb/projects/demo')
      return Response.json({
        id: 'project',
        slug: 'demo',
        name: 'Checkout',
        status: active ? 'active' : 'archived',
      });
    if (url.startsWith('/_pb/projects?'))
      return Response.json({
        items: [{ id: 'project', slug: 'demo', name: 'Checkout', status: 'active' }],
        next: null,
      });
    return Response.json({ items, next: null });
  });
  const services = {
    client: createApiClient<paths>({ fetch, readCookie: () => undefined }),
    requireReauth: vi.fn(),
  };
  return { fetch, services, model: createSourceActions(services, 'demo') };
}
const posts = (f: ReturnType<typeof setup>) =>
  f.fetch.mock.calls.filter(([, init]) => init.method === 'POST');

describe('Add package choices', () => {
  it('opens repository setup with Composer VCS and the requested supported provider selected', () => {
    const html = renderToString(
      createElement(SourceForm, {
        source: null,
        busy: false,
        errors: {},
        alert: null,
        onSubmit: vi.fn(),
        onClose: vi.fn(),
        vcsProviders: ['git', 'github'],
        initialType: 'vcs',
        initialProvider: 'github',
      }),
    );
    expect(html).toMatch(/<input[^>]*name="type"[^>]*checked=""[^>]*value="vcs"/);
    expect(html).toMatch(/<option value="github" selected="">/);
    expect(html).toContain('owner/repository');
  });
  it.each([false, true])('renders only authorized links and actions (write: %s)', (allowed) => {
    const html = renderToString(
      createElement(AddChoices, {
        ecosystem: 'composer',
        mirror: allowed,
        setup: allowed,
        imported: allowed,
        onMirror: vi.fn(),
        sourceLink: '#/sources?create=vcs',
      }),
    );
    const labels = [
      'From a mirror',
      'From a connected GitHub organization',
      'By repository URL',
      'Import configuration',
      'Upload a private package',
    ];
    expect(labels.map((label) => html.indexOf(label))).toEqual(
      [...labels.map((label) => html.indexOf(label))].sort((a, b) => a - b),
    );
    expect(html.includes('<button')).toBe(allowed);
    expect(html.includes('href=')).toBe(allowed);
    expect(html).toContain('Coming soon');
    expect(html).toContain('#947');
  });
  it('omits Composer Git choices for npm', () => {
    const html = renderToString(
      createElement(AddChoices, {
        ecosystem: 'npm',
        mirror: true,
        setup: true,
        imported: false,
        onMirror: vi.fn(),
        sourceLink: '#/sources?create=vcs',
      }),
    );
    expect(html).not.toContain('By repository URL');
    expect(html).not.toContain('GitHub organization');
    expect(html).toContain('connected npm registry');
  });
});

describe('exact-name mirror request', () => {
  it.each([200, 202])('sends the project route and truthful HTTP %s outcome', async (status) => {
    const f = setup({ status });
    await f.model.load();
    await f.model.submit('mirror', source.id, ' vendor/name ');
    expect(posts(f)).toEqual([
      [
        `/_pb/projects/demo/sources/source/packages`,
        expect.objectContaining({ body: '{"name":"vendor/name"}', method: 'POST' }),
      ],
    ]);
    expect(f.model.snapshot().notice).toBe(
      status === 200
        ? 'vendor/name is already available from Packagist.'
        : 'vendor/name: Sync requested. Waiting for a worker. Sync continues in the background.',
    );
    expect(f.model.snapshot().notice).not.toMatch(/finished|refreshed|will appear/i);
  });
  it.each([
    { permissions: [] },
    { active: false },
    { items: [{ ...source, attached: false }] as Source[] },
    { items: [{ ...source, type: 'composer_repository' }] as Source[] },
    { items: [{ ...source, status: 'paused' }] as Source[] },
  ])('refuses unauthorized, inactive, unattached and unsupported requests: %j', async (options) => {
    const f = setup(options);
    await f.model.load();
    await f.model.submit('mirror', source.id, 'vendor/name');
    expect(posts(f)).toHaveLength(0);
  });
  it('requires an explicit authorized destination in organization scope', async () => {
    const f = setup();
    const model = createSourceActions(f.services, null);
    await model.load();
    expect(model.snapshot().projects.map((p) => p.slug)).toEqual(['demo']);
    expect(model.snapshot().project).toBeNull();
    await model.submit('mirror', source.id, 'vendor/name');
    expect(posts(f)).toHaveLength(0);
    await model.selectProject('demo');
    await model.submit('mirror', source.id, 'vendor/name');
    expect(posts(f)).toHaveLength(1);
  });
  it('does not list unauthorized destination projects', async () => {
    const f = setup({ permissions: [] });
    const model = createSourceActions(f.services, null);
    await model.load();
    expect(model.snapshot().projects).toEqual([]);
  });
});

describe('source-wide sync', () => {
  it('coalesces repeated clicks while the request is pending', async () => {
    const f = setup({ organization: ['org:sources:write'] });
    await f.model.load();
    let finish!: (response: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.model.submit('sync', source.id, '');
    await f.model.submit('sync', source.id, '');
    expect(posts(f)).toHaveLength(1);
    finish(new Response(null, { status: 202 }));
    await pending;
    expect(f.model.snapshot().notice).toBe(SYNC_REQUESTED);
  });
  it('fails closed when project permissions cannot be loaded', async () => {
    const f = setup();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((url, init) =>
      url.endsWith('/permissions') && url !== '/_pb/me/permissions'
        ? Promise.resolve(new Response('{}', { status: 503 }))
        : original(url, init),
    );
    await f.model.load();
    await f.model.submit('mirror', source.id, 'vendor/name');
    expect(posts(f)).toHaveLength(0);
    expect(f.model.snapshot().permissions).toEqual([]);
    expect(f.model.snapshot().error).toContain('Project access could not be loaded');
  });
  it('discards source lists arriving after the destination changes', async () => {
    const f = setup();
    await f.model.load();
    const original = f.fetch.getMockImplementation()!;
    let finish!: (response: Response) => void;
    f.fetch.mockImplementation((url, init) =>
      url.startsWith('/_pb/projects/demo/sources')
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(url, init),
    );
    const pending = f.model.selectProject('demo');
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.model.selectProject(null);
    finish(Response.json({ items: [{ ...source, name: 'Stale destination' }], next: null }));
    await pending;
    expect(f.model.snapshot().project).toBeNull();
    expect(f.model.snapshot().sources[0]?.name).toBe('Packagist');
  });
  it.each([null, 'project'])('uses ownership authority and route for %s', async (projectId) => {
    const f = setup({ items: [{ ...source, projectId }], organization: ['org:sources:write'] });
    await f.model.load();
    await f.model.submit('sync', source.id, 'ignored-package-name');
    expect(posts(f)[0]?.[0]).toBe(
      projectId ? '/_pb/projects/demo/sources/source/sync' : '/_pb/sources/source/sync',
    );
    expect(posts(f)[0]?.[1].body).toBeUndefined();
    expect(f.model.snapshot().notice).toBe(SYNC_REQUESTED);
    await f.model.submit('sync', source.id, '');
    expect(posts(f)).toHaveLength(1);
  });
  it('does not let project writers sync inherited organization sources', async () => {
    const f = setup();
    await f.model.load();
    await f.model.submit('sync', source.id, '');
    expect(posts(f)).toHaveLength(0);
  });
  it('does not infer source authority from package management or org source authority over project ownership', () => {
    expect(canSync(source, [], ['project:packages:manage'], 'project')).toBe(false);
    expect(
      canSync(
        { ...source, projectId: 'foreign' },
        ['org:sources:write'],
        ['project:sources:write'],
        'project',
      ),
    ).toBe(false);
  });
  it('keeps selection on a safe permission error', async () => {
    const f = setup({ status: 403, organization: ['org:sources:write'] });
    await f.model.load();
    await f.model.submit('sync', source.id, '');
    expect(f.model.snapshot().sources[0]?.id).toBe(source.id);
    expect(f.model.snapshot().error).toBe(
      'You no longer have permission to sync this source. Your selection has been kept.',
    );
    expect(JSON.stringify(f.model.snapshot())).not.toContain('secret-sentinel');
  });
  it('does not present stale generation counts as results for the request', async () => {
    const f = setup({
      organization: ['org:sources:write'],
      items: [
        {
          ...source,
          sync: {
            generation: 'old',
            listing: false,
            completed: 9,
            queued: 0,
            running: 0,
            failed: 0,
            retrying: 0,
            errors: [],
          },
        },
      ],
    });
    await f.model.load();
    await f.model.submit('sync', source.id, '');
    expect(f.model.snapshot().notice).toBe(SYNC_REQUESTED);
  });
  it('describes held and configured scope without promising a full registry', () => {
    expect(syncScope(source)).toContain('when their metadata is due for refresh');
    expect(syncScope({ ...source, type: 'composer_repository' })).toBe(
      "Syncs packages selected in this source's settings.",
    );
    expect(sourceHealth(source)).toBe('Not checked yet');
    expect(sourceHealth({ ...source, lastSuccessAt: 'yesterday', hasCredential: true })).toBe(
      'Last check succeeded',
    );
    expect(mirrorSource({ ...source, type: 'composer_repository' })).toBe(false);
  });
});
