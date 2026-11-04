import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api.js';
import { createDiscoveryPicker, discoveryReason } from './discovery-picker.js';

function setup() {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let fail = false;
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body });
    if (fail)
      return Response.json(
        { error: { code: 'unavailable', message: 'secret-sentinel' } },
        { status: 503 },
      );
    if (path.endsWith('/connections'))
      return Response.json({
        items: [
          { credentialId: 'opaque', installationId: 42, sourceNames: ['Acme'], sourceCount: 1 },
        ],
      });
    if (path.endsWith('/plan'))
      return Response.json({
        entries: Array.from({ length: 21 }, (_, i) => ({
          repository: `acme/repo${i}`,
          ecosystem: 'npm',
          packageName: `@acme/pkg${i}`,
          action: 'new',
          reason: null,
        })),
        nextCursor: body.cursor ? null : '2',
      });
    return Response.json({
      results: [
        {
          repository: body.repositories instanceof Array ? body.repositories[0] : '',
          outcome: 'created',
        },
      ],
      remainingRepositories: body.repositories instanceof Array ? body.repositories.slice(1) : [],
      nextCursor: null,
    });
  });
  const model = createDiscoveryPicker(
    { client: createApiClient({ fetch, readCookie: () => undefined }), requireReauth: vi.fn() },
    'npm',
  );
  return {
    model,
    calls,
    fetch,
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
  };
}

describe('GitHub discovery picker', () => {
  it('previews the chosen connection and ecosystem, pages by cursor and caps selection at 20', async () => {
    const f = setup();
    await f.model.load();
    f.model.configure({ connection: '0', pattern: 'pkg*', includeForks: true });
    await f.model.preview();
    expect(f.calls.at(-1)?.body).toEqual({
      credentialId: 'opaque',
      installationId: 42,
      ecosystem: 'npm',
      includeForks: true,
      pattern: 'pkg*',
      cursor: null,
    });
    f.model.selectPage(true);
    expect(f.model.snapshot().selected).toHaveLength(20);
    f.model.toggle('acme/repo20', true);
    expect(f.model.snapshot().selected).toHaveLength(20);
    await f.model.preview(true);
    expect(f.calls.at(-1)?.body.cursor).toBe('2');
    expect(f.model.snapshot().selected).toEqual([]);
    expect(f.model.snapshot().nextCursor).toBeNull();
  });
  it('follows remaining repositories, preserves results, and coalesces duplicate imports', async () => {
    const f = setup();
    await f.model.load();
    await f.model.preview();
    f.model.toggle('acme/repo0', true);
    f.model.toggle('acme/repo1', true);
    const pending = f.model.importSelected();
    await f.model.importSelected();
    await pending;
    expect(
      f.calls.filter((c) => c.path.endsWith('/apply')).map((c) => c.body.repositories),
    ).toEqual([['acme/repo0', 'acme/repo1'], ['acme/repo1']]);
    expect(f.model.snapshot().results.map((r) => r.outcome)).toEqual(['created', 'created']);
    expect(f.model.snapshot().busy).toBe(false);
  });
  it('keeps failed repositories for retry and hides server error text', async () => {
    const f = setup();
    await f.model.load();
    await f.model.preview();
    f.model.toggle('acme/repo0', true);
    f.fail();
    await f.model.importSelected();
    expect(f.model.snapshot().results[0]?.outcome).toBe('failed');
    expect(JSON.stringify(f.model.snapshot())).not.toContain('secret-sentinel');
    f.recover();
    await f.model.retryFailed();
    expect(f.model.snapshot().results[0]?.outcome).toBe('created');
  });
  it('invalidates the preview when settings change and refuses unreviewed repositories', async () => {
    const f = setup();
    await f.model.load();
    await f.model.preview();
    f.model.toggle('acme/not-previewed', true);
    expect(f.model.snapshot().selected).toEqual([]);
    f.model.toggle('acme/repo0', true);
    f.model.configure({ includeForks: true });
    await f.model.importSelected();
    expect(f.calls.some((c) => c.path.endsWith('/apply'))).toBe(false);
  });
  it('ignores settings and selection changes while a preview or import is pending', async () => {
    const f = setup();
    await f.model.load();
    let finish!: (value: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.model.preview();
    f.model.configure({ includeForks: true });
    f.model.selectPage(true);
    await f.model.preview();
    expect(f.model.snapshot().includeForks).toBe(false);
    finish(
      Response.json({
        entries: [
          {
            repository: 'acme/repo',
            action: 'new',
            ecosystem: 'npm',
            packageName: '@acme/pkg',
            reason: null,
          },
        ],
        nextCursor: null,
      }),
    );
    await pending;
    f.model.toggle('acme/repo', true);
    f.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const importing = f.model.importSelected();
    f.model.configure({ connection: '1' });
    f.model.toggle('acme/repo', false);
    expect(f.model.snapshot().selected).toEqual(['acme/repo']);
    expect(f.model.snapshot().connection).toBe('0');
    finish(
      Response.json({
        results: [{ repository: 'acme/repo', outcome: 'created' }],
        remainingRepositories: [],
        nextCursor: null,
      }),
    );
    await importing;
    expect(f.model.snapshot().results[0]?.outcome).toBe('created');
  });
  it('pauses a rate-limited continuation until the user continues import', async () => {
    const f = setup();
    await f.model.load();
    await f.model.preview();
    f.model.toggle('acme/repo0', true);
    f.fetch.mockImplementationOnce(async () =>
      Response.json({
        results: [{ repository: 'acme/repo0', outcome: 'failed', error: 'rate_limited' }],
        remainingRepositories: ['acme/repo0'],
        nextCursor: null,
      }),
    );
    await f.model.importSelected();
    expect(f.model.snapshot().busy).toBe(false);
    expect(f.model.snapshot().results).toEqual([{ repository: 'acme/repo0', outcome: 'failed' }]);
    expect(f.model.snapshot().error).toContain('Continue import');
    expect(f.model.snapshot().pending).toEqual(['acme/repo0']);
    expect(f.fetch.mock.calls.filter(([path]) => path.endsWith('/apply'))).toHaveLength(1);
    await f.model.continueImport();
    expect(f.model.snapshot().pending).toEqual([]);
    expect(f.model.snapshot().results[0]?.outcome).toBe('created');
  });
  it('pauses after partial rate-limited progress and retains every remaining repository', async () => {
    const f = setup();
    await f.model.load();
    await f.model.preview();
    for (const repository of ['acme/repo0', 'acme/repo1', 'acme/repo2'])
      f.model.toggle(repository, true);
    f.fetch.mockImplementationOnce(async () =>
      Response.json({
        results: [
          { repository: 'acme/repo0', outcome: 'created' },
          { repository: 'acme/repo1', outcome: 'failed', error: 'rate_limited' },
        ],
        remainingRepositories: ['acme/repo1', 'acme/repo2'],
        nextCursor: '2',
      }),
    );
    await f.model.importSelected();
    expect(f.fetch.mock.calls.filter(([path]) => path.endsWith('/apply'))).toHaveLength(1);
    expect(f.model.snapshot()).toMatchObject({
      progress: 1,
      total: 3,
      pending: ['acme/repo1', 'acme/repo2'],
      busy: false,
      importing: false,
    });
    f.model.configure({ includeForks: true });
    expect(f.model.snapshot().pending).toEqual(['acme/repo1', 'acme/repo2']);
    await f.model.continueImport();
    expect(
      f.calls.filter((c) => c.path.endsWith('/apply')).map((c) => c.body.repositories),
    ).toEqual([['acme/repo1', 'acme/repo2'], ['acme/repo2']]);
    expect(f.calls.at(-1)?.body.includeForks).toBe(false);
    expect(f.model.snapshot().results.map((r) => r.outcome)).toEqual([
      'created',
      'created',
      'created',
    ]);
    expect(f.model.snapshot()).toMatchObject({ progress: 3, total: 3 });
  });
  it('retains existing and refused outcomes with structured reasons', async () => {
    const f = setup();
    await f.model.load();
    await f.model.preview();
    f.model.toggle('acme/repo0', true);
    f.model.toggle('acme/repo1', true);
    f.fetch.mockImplementationOnce(async () =>
      Response.json({
        results: [
          { repository: 'acme/repo0', outcome: 'existing' },
          { repository: 'acme/repo1', outcome: 'skipped', reason: 'name_public' },
        ],
        remainingRepositories: [],
        nextCursor: null,
      }),
    );
    await f.model.importSelected();
    expect(f.model.snapshot().results).toEqual([
      { repository: 'acme/repo0', outcome: 'existing' },
      { repository: 'acme/repo1', outcome: 'skipped', reason: 'name_public' },
    ]);
  });
  it('does not treat an unavailable connection list as an empty organization', async () => {
    const f = setup();
    f.fail();
    await f.model.load();
    expect(f.model.snapshot().loading).toBe(false);
    expect(f.model.snapshot().error).toBe('GitHub connections could not be loaded. Try again.');
    f.recover();
    await f.model.load();
    expect(f.model.snapshot().connections).toHaveLength(1);
    expect(f.model.snapshot().error).toBeNull();
  });
  it('keeps raw pattern drafts, substitutes only an empty request pattern, and validates it', async () => {
    const f = setup();
    await f.model.load();
    f.model.configure({ pattern: '' });
    await f.model.preview();
    expect(f.model.snapshot().pattern).toBe('');
    expect(f.calls.at(-1)?.body.pattern).toBe('*');
    f.model.configure({ pattern: 'invalid/name' });
    const count = f.calls.length;
    await f.model.preview();
    expect(f.calls).toHaveLength(count);
    expect(f.model.snapshot().patternError).toContain('Enter a repository name pattern');
    expect(f.model.snapshot().busy).toBe(false);
  });
  it('retains failed retries and progress across settings changes until Start over', async () => {
    const f = setup();
    await f.model.load();
    await f.model.preview();
    f.model.toggle('acme/repo0', true);
    f.fail();
    await f.model.importSelected();
    const previous = f.model.snapshot();
    f.model.configure({ pattern: 'other*', includeForks: true });
    expect(f.model.snapshot()).toMatchObject({
      entries: [],
      selected: [],
      nextCursor: null,
      reviewed: false,
      results: previous.results,
      progress: 1,
      total: 1,
    });
    f.recover();
    await f.model.retryFailed();
    expect(f.calls.at(-1)?.body.includeForks).toBe(false);
    expect(f.model.snapshot().results[0]?.outcome).toBe('created');
    f.model.startOver();
    expect(f.model.snapshot()).toMatchObject({
      results: [],
      pending: [],
      progress: 0,
      total: 0,
      reviewed: false,
    });
  });
  it('works through more than 20 eligible repositories without reselecting imported sources', async () => {
    const f = setup();
    await f.model.load();
    await f.model.preview();
    f.model.selectPage(true);
    await f.model.importSelected();
    f.model.selectPage(true);
    expect(f.model.snapshot().selected).toEqual(['acme/repo20']);
    await f.model.importSelected();
    expect(f.model.snapshot().results).toHaveLength(21);
    expect(
      f.calls.filter((c) => c.path.endsWith('/apply')).every((c) => !('nextCursor' in c.body)),
    ).toBe(true);
  });
  it('marks a missing requested outcome as failed with a fixed reason', async () => {
    const f = setup();
    await f.model.load();
    await f.model.preview();
    f.model.toggle('acme/repo0', true);
    f.model.toggle('acme/repo1', true);
    f.fetch.mockImplementationOnce(async () =>
      Response.json({
        results: [{ repository: 'acme/repo0', outcome: 'existing' }],
        remainingRepositories: [],
        nextCursor: null,
      }),
    );
    await f.model.importSelected();
    expect(f.model.snapshot().results).toEqual([
      { repository: 'acme/repo0', outcome: 'existing' },
      { repository: 'acme/repo1', outcome: 'failed', error: 'import_unconfirmed' },
    ]);
    f.model.selectPage(true);
    expect(f.model.snapshot().selected).not.toContain('acme/repo0');
  });
  it.each(['preview', 'import'] as const)(
    'cancels an unmounted %s and resets busy flags without continuing requests',
    async (operation) => {
      const f = setup();
      await f.model.load();
      await f.model.preview();
      f.model.toggle('acme/repo0', true);
      f.model.toggle('acme/repo1', true);
      let finish!: (response: Response) => void;
      f.fetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = operation === 'import' ? f.model.importSelected() : f.model.preview();
      const count = f.calls.length;
      f.model.cancel();
      finish(
        Response.json({
          entries: [],
          results: [{ repository: 'acme/repo0', outcome: 'created' }],
          remainingRepositories: ['acme/repo1'],
          nextCursor: null,
        }),
      );
      await pending;
      expect(f.calls).toHaveLength(count);
      expect(f.model.snapshot()).toMatchObject({ busy: false, importing: false });
    },
  );
  it('stops a non-rate-limited stalled continuation with retryable failures', async () => {
    const f = setup();
    await f.model.load();
    await f.model.preview();
    f.model.toggle('acme/repo0', true);
    f.fetch.mockImplementationOnce(async () =>
      Response.json({ results: [], remainingRepositories: ['acme/repo0'], nextCursor: null }),
    );
    await f.model.importSelected();
    expect(f.model.snapshot().results[0]).toMatchObject({
      outcome: 'failed',
      error: 'import_unconfirmed',
    });
    expect(f.model.snapshot().error).toContain('Retry failed');
    expect(f.model.snapshot().busy).toBe(false);
  });
  it('explains every refusal with a consequence', () => {
    expect(discoveryReason('unsupported_ecosystem')).toContain(
      'This repository has no Composer or npm package to import.',
    );
    for (const reason of [
      'fork',
      'archived',
      'no_manifest',
      'invalid_name',
      'name_public',
      'name_public_unverified',
      'claim_overlap',
      'filtered_out',
      'error_451',
      'error_404',
      'unsupported_ecosystem',
    ]) {
      expect(discoveryReason(reason)).toMatch(/.+ — .+/);
      expect(discoveryReason(reason)).not.toContain('Import refused');
      if (reason.includes('_')) expect(discoveryReason(reason)).not.toContain(reason);
    }
  });
});
