import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import { ImportView, createImportController } from './import.js';

const run = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  state: 'planned',
  planHash: '0123456789abcdef'.repeat(4),
  approvedAt: null,
  approvedByUserId: null,
  acceptedAt: null,
  beforeImageExpiresAt: null,
};
function setup(
  actionStatus = 204,
  code = 'conflict',
  selectedRun: Omit<typeof run, 'approvedAt'> & { approvedAt: string | null } = run,
) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) =>
    init.method === 'GET'
      ? Response.json(
          _url.split('?')[0] === '/_pb/import-runs'
            ? { items: [selectedRun], next: null }
            : selectedRun,
        )
      : actionStatus === 204
        ? new Response(null, { status: 204 })
        : Response.json(
            { error: { code, message: 'hostile-request-data' } },
            { status: actionStatus },
          ),
  );
  const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
  const requireReauth = vi.fn();
  const controller = createImportController({ client, requireReauth });
  return { controller, fetch, requireReauth };
}
function markup(controller: ReturnType<typeof createImportController>) {
  return renderToString(createElement(ImportView, { state: controller.snapshot(), controller }));
}

describe('import runs', () => {
  it('loads the list and detail and shows a shortened plan hash', async () => {
    const { controller } = setup();
    await controller.load();
    await controller.select(run.id);
    const html = markup(controller);
    expect(html).toContain(run.id);
    expect(html).toContain('0123456789ab');
    expect(html).toContain('Copy full plan hash');
    expect(html).toContain('Upload credentials with the CLI');
  });
  it('cannot approve before opening and confirming the dialog', async () => {
    const { controller, fetch } = setup();
    await controller.select(run.id);
    await controller.action('approve');
    controller.openApproval();
    expect(markup(controller)).toMatch(/disabled=""[^>]*>Approve run/);
    await controller.action('approve');
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });
  it('sends the full confirmed hash through the client', async () => {
    const { controller, fetch } = setup();
    await controller.select(run.id);
    controller.openApproval();
    expect(markup(controller)).toContain(run.planHash);
    controller.confirmApproval(true);
    await controller.action('approve');
    const post = fetch.mock.calls.find(([, init]) => init.method === 'POST');
    expect(post?.[0]).toBe(`/_pb/import-runs/${run.id}/approve`);
    expect(JSON.parse(String(post?.[1].body))).toEqual({ planHash: run.planHash });
    expect(post?.[1]).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
  });
  it('shows a fixed conflict message without server request data', async () => {
    const { controller } = setup(409);
    await controller.select(run.id);
    controller.openApproval();
    controller.confirmApproval(true);
    await controller.action('approve');
    expect(markup(controller)).toContain('The run changed. Reload it and try again.');
    expect(markup(controller)).not.toContain('hostile-request-data');
  });
  it('drops before-images from hostile list and detail responses', async () => {
    const hostile = {
      ...run,
      before_image_json: 'private-before-image',
      manifest: 'private-manifest',
      credentialRef: 'private-credential-ref',
    };
    const client = createApiClient<paths>({
      fetch: async (url) =>
        Response.json(url === '/_pb/import-runs' ? { items: [hostile], next: null } : hostile),
      readCookie: () => undefined,
    });
    const controller = createImportController({ client, requireReauth: vi.fn() });
    await controller.load();
    await controller.select(run.id);
    const text = markup(controller) + JSON.stringify(controller.snapshot());
    expect(text).toContain(run.id);
    for (const forbidden of [
      'before_image_json',
      'private-before-image',
      'private-manifest',
      'private-credential-ref',
    ])
      expect(text).not.toContain(forbidden);
  });
  it.each(['approve', 'apply', 'rollback', 'cancel'] as const)(
    'passes %s to the shell on reauth_required',
    async (action) => {
      const selectedRun =
        action === 'apply'
          ? { ...run, approvedAt: '2026-10-01T00:00:00Z' }
          : action === 'rollback'
            ? { ...run, state: 'applied' }
            : run;
      const { controller, requireReauth } = setup(403, 'reauth_required', selectedRun);
      await controller.select(run.id);
      if (action === 'approve') {
        controller.openApproval();
        controller.confirmApproval(true);
      }
      await controller.action(action);
      expect(requireReauth).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: `/_pb/import-runs/${run.id}/${action}` }),
        { credential: false, secretFields: [] },
      );
    },
  );
  it('invalidates confirmation when selecting another run', async () => {
    const { controller, fetch } = setup();
    await controller.select(run.id);
    controller.openApproval();
    controller.confirmApproval(true);
    await controller.select(run.id);
    await controller.action('approve');
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
  });
  it('does not send a mutation without a selected run', async () => {
    const { controller, fetch } = setup();
    await controller.action('apply');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cannot approve a run without a plan hash', async () => {
    const fetch = vi.fn(async () => Response.json({ ...run, planHash: null }));
    const controller = createImportController({
      client: createApiClient<paths>({ fetch, readCookie: () => undefined }),
      requireReauth: vi.fn(),
    });
    await controller.select(run.id);
    controller.openApproval();
    controller.confirmApproval(true);
    await controller.action('approve');
    expect(controller.snapshot().dialog).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('ignores a late response from an earlier selection', async () => {
    let resolveFirst!: (response: Response) => void;
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/earlier')
        ? new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          })
        : Response.json(run),
    );
    const controller = createImportController({
      client: createApiClient<paths>({ fetch, readCookie: () => undefined }),
      requireReauth: vi.fn(),
    });
    const first = controller.select('earlier');
    await controller.select(run.id);
    resolveFirst(Response.json({ ...run, id: 'earlier' }));
    await first;
    expect(controller.snapshot().run?.id).toBe(run.id);
  });
  it('blocks duplicate mutations while a request is pending', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === 'POST'
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Response.json(
            _url.split('?')[0] === '/_pb/import-runs' ? { items: [run], next: null } : run,
          ),
    );
    const controller = createImportController({
      client: createApiClient<paths>({ fetch, readCookie: () => undefined }),
      requireReauth: vi.fn(),
    });
    await controller.select(run.id);
    controller.openApproval();
    controller.confirmApproval(true);
    const first = controller.action('approve');
    await controller.action('approve');
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    finish(new Response(null, { status: 204 }));
    await first;
  });
});

describe('import return state', () => {
  it('keeps the current cursor and list when closing detail', async () => {
    const { controller } = setup();
    await controller.load('current-cursor');
    await controller.select(run.id);
    const runs = controller.snapshot().runs;
    controller.back();
    expect(controller.snapshot().cursor).toBe('current-cursor');
    expect(controller.snapshot().runs).toBe(runs);
    expect(controller.snapshot().run).toBeNull();
    expect(controller.snapshot().selectedId).toBeNull();
  });
  it('retains the failed detail selection so it can be retried or closed', async () => {
    const controller = createImportController({
      client: createApiClient<paths>({
        fetch: async () => new Response(null, { status: 503 }),
        readCookie: () => undefined,
      }),
      requireReauth: vi.fn(),
    });
    await controller.select(run.id);
    expect(controller.snapshot()).toMatchObject({
      selectedId: run.id,
      detailLoading: false,
      run: null,
    });
    expect(markup(controller)).toContain('Back to import runs');
    expect(markup(controller)).toContain('Unable to load the import run.');
    expect(markup(controller)).not.toContain('No import runs.');
    controller.back();
    expect(controller.snapshot().selectedId).toBeNull();
  });
});
