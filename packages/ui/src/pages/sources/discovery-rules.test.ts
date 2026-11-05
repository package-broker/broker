import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiscoveryRulesView } from './discovery-rules-view.js';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api.js';
import { createDiscoveryRules, ruleState, ruleFailure } from './discovery-rules.js';

const reader = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  name: 'Libraries',
  ecosystem: 'npm',
  pattern: 'lib*',
  includeForks: false,
  enabled: true,
  intervalSeconds: 86400,
  revision: 3,
  completed: null,
};
const writer = {
  ...reader,
  credentialId: 'credential-DISC3-distinctive',
  installationId: 42,
  outcome: 'running',
  created: 2,
  existing: 1,
  skipped: 0,
  failed: 0,
  remaining: ['one', 'two', 'three'],
  cursor: null,
  nextRunAt: null,
};
function fixture(manager = true) {
  let failure: { status: number; code: string } | null = null;
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/_pb/me/permissions')
      return Response.json({ organization: [manager ? 'org:sources:write' : 'org:sources:read'] });
    if (init.method !== 'GET' && failure)
      return Response.json(
        { error: { code: failure.code, message: 'secret-sentinel' } },
        { status: failure.status },
      );
    if (path.endsWith('/connections'))
      return Response.json({
        items: [
          {
            credentialId: 'credential-DISC3-distinctive',
            installationId: 42,
            sourceNames: ['Libraries connection'],
            sourceCount: 1,
          },
        ],
      });
    if (init.method !== 'GET') return Response.json({ id: 'rule' });
    if (path.endsWith('/01ARZ3NDEKTSV4RRFFQ69G5FAV'))
      return Response.json({ ...(manager ? writer : reader), revision: 4 });
    return Response.json({ items: [manager ? writer : reader], next: null });
  });
  const requireReauth = vi.fn();
  const services = {
    client: createApiClient({ fetch, readCookie: () => undefined }),
    requireReauth,
  };
  const model = createDiscoveryRules(services);
  return {
    model,
    fetch,
    services,
    requireReauth,
    fail: (status: number, code: string) => {
      failure = { status, code };
    },
  };
}

describe('discovery rules UI', () => {
  it('uses only reader data and never loads connections or sends writes for readers', async () => {
    const f = fixture(false);
    await f.model.load();
    expect(f.model.snapshot().visible).toBe(true);
    expect(f.model.snapshot().manager).toBe(false);
    f.model.edit(f.model.snapshot().items[0]!);
    await f.model.run(f.model.snapshot().items[0]!);
    await f.model.toggle(f.model.snapshot().items[0]!);
    await f.model.remove(f.model.snapshot().items[0]!);
    await f.model.save();
    expect(
      f.fetch.mock.calls.every(
        ([path, init]) => path !== '/_pb/sources/discovery/connections' && init.method === 'GET',
      ),
    ).toBe(true);
    expect(f.model.snapshot().draft).toBeNull();
  });
  it('saves writer settings with a revision and omits unchanged credential bindings', async () => {
    const f = fixture();
    await f.model.load();
    f.model.edit(f.model.snapshot().items[0]!);
    f.model.configure({ name: 'New libraries', pattern: '' });
    await f.model.save();
    const call = f.fetch.mock.calls.find(([, init]) => init.method === 'PATCH')!;
    expect(new Headers(call[1].headers).get('If-Match')).toBe('"r3"');
    expect(JSON.parse(String(call[1].body))).toEqual({
      name: 'New libraries',
      ecosystem: 'npm',
      pattern: '*',
      includeForks: false,
      enabled: true,
      intervalSeconds: 86400,
    });
  });
  it('validates before sending and retains a failed draft', async () => {
    const f = fixture();
    await f.model.load();
    f.model.edit();
    f.model.configure({ name: 'Libraries', pattern: 'bad/pattern' });
    await f.model.save();
    expect(f.model.snapshot().patternError).toBeTruthy();
    expect(f.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
    f.model.configure({ pattern: 'lib*' });
    f.fail(409, 'duplicate');
    await f.model.save();
    expect(f.model.snapshot().error).toBe(
      'A discovery rule with this name already exists. Choose another name.',
    );
    expect(f.model.snapshot().draft?.name).toBe('Libraries');
  });
  it('reloads a stale rule while retaining the draft and requires renewed review', async () => {
    const f = fixture();
    await f.model.load();
    f.model.edit(f.model.snapshot().items[0]!);
    f.model.configure({ name: 'My draft' });
    f.fail(412, 'conflict');
    await f.model.save();
    expect(f.model.snapshot().items[0]?.revision).toBe(4);
    expect(f.model.snapshot().draft?.name).toBe('My draft');
    const writes = f.fetch.mock.calls.filter(([, init]) => init.method === 'PATCH').length;
    await f.model.save();
    expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(writes);
    f.model.reviewLatest();
    expect(f.model.snapshot().draft?.name).toBe('Libraries');
  });
  it('uses explicit reauthentication confirmation and retains the settings draft', async () => {
    const f = fixture();
    await f.model.load();
    f.model.edit();
    f.model.configure({ name: 'Libraries' });
    f.fail(403, 'reauth_required');
    await f.model.save();
    expect(f.requireReauth).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/_pb/sources/discovery/rules' }),
      {
        credential: false,
        secretFields: [],
        display: {
          label: 'Change discovery rule Libraries',
          effect: 'The scan restarts. Imported sources stay.',
          scope: 'Organization sources',
        },
      },
    );
    expect(createDiscoveryRules(f.services).snapshot().draft?.name).toBe('Libraries');
    expect(f.model.snapshot().error).not.toContain('secret-sentinel');
  });
  it('distinguishes missing, disabled conflict, and rate limits with fixed copy', () => {
    expect(ruleFailure({ status: 404 })).toContain('no longer available');
    expect(ruleFailure({ status: 409, code: 'discovery_rule_disabled' })).toContain('Enable');
    expect(ruleFailure({ status: 429 })).toContain('rate limiting');
    expect(ruleState({ ...writer, enabled: false } as never)).toBe('Disabled');
    expect(
      ruleState({ ...writer, outcome: 'failed', failureReason: 'secret-sentinel' } as never),
    ).not.toContain('secret-sentinel');
    expect(ruleState(reader as never)).toBe(
      'Current run information is available to source managers.',
    );
  });
  it('accepts run-now as queued, and uses If-Match for disable and deletion', async () => {
    const f = fixture();
    await f.model.load();
    const rule = f.model.snapshot().items[0]!;
    await f.model.run(rule);
    expect(f.model.snapshot().notice).toContain('requested');
    await f.model.toggle(rule);
    await f.model.remove(rule);
    const writes = f.fetch.mock.calls.filter(([, init]) => init.method !== 'GET');
    expect(writes.map(([, init]) => init.method)).toEqual(['POST', 'PATCH', 'DELETE']);
    expect(new Headers(writes[1]![1].headers).get('If-Match')).toBe('"r3"');
    expect(new Headers(writes[2]![1].headers).get('If-Match')).toBe('"r3"');
  });
});

it('prefills the exact picker settings without exposing identifiers in a URL', async () => {
  const f = fixture();
  const { prefillDiscoveryRule } = await import('./discovery-rule-prefill.js');
  prefillDiscoveryRule(f.services, {
    credentialId: 'credential-DISC3-distinctive',
    installationId: 42,
    ecosystem: 'composer',
    pattern: 'private*',
    includeForks: true,
  });
  const model = createDiscoveryRules(f.services);
  await model.load();
  expect(model.snapshot().draft).toEqual({
    name: '',
    credentialId: 'credential-DISC3-distinctive',
    installationId: 42,
    ecosystem: 'composer',
    pattern: 'private*',
    includeForks: true,
    enabled: true,
    intervalSeconds: 86400,
  });
});

it('rejects missing names and unavailable connections without sending a mutation', async () => {
  const f = fixture();
  await f.model.load();
  f.model.edit();
  await f.model.save();
  expect(f.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
  f.model.configure({ name: 'Libraries', credentialId: 'missing' });
  await f.model.save();
  expect(f.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
  expect(f.model.snapshot().draft?.name).toBe('Libraries');
});

it('does not queue a disabled rule or duplicate a pending write', async () => {
  const f = fixture();
  await f.model.load();
  const rule = f.model.snapshot().items[0]!;
  await f.model.run({ ...rule, enabled: false });
  expect(f.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
  let finish!: (response: Response) => void;
  f.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.model.run(rule);
  await f.model.run(rule);
  expect(f.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  finish(Response.json({ id: 'rule' }));
  await first;
});

it('retains a failed reauthentication replay draft and reloads stale data for review', async () => {
  const f = fixture();
  await f.model.load();
  f.model.edit(f.model.snapshot().items[0]!);
  f.model.configure({ name: 'My draft' });
  await f.model.replayed({
    ok: false,
    status: 412,
    path: '/_pb/sources/discovery/rules/rule',
    code: 'conflict',
  });
  expect(f.model.snapshot().draft?.name).toBe('My draft');
  expect(f.model.snapshot().items[0]?.revision).toBe(4);
  expect(f.model.snapshot().stale).toBe(true);
  expect(f.model.snapshot().error).toContain('newer rule');
});

it('renders reader settings with human labels and no writer controls or internal identifiers', async () => {
  const f = fixture(false);
  await f.model.load();
  const html = renderToStaticMarkup(createElement(DiscoveryRulesView, { model: f.model }));
  expect(html).toContain('Libraries');
  expect(html).toContain('Every day');
  expect(html).toContain('Excluded');
  expect(html).toContain('Enabled');
  expect(html).not.toContain(reader.id);
  expect(html).not.toContain(writer.credentialId);
  expect(html).not.toContain('More actions');
  expect(html).not.toContain('Run now');
});

it('reloads and shows a stale edited rule even when it is no longer on the refreshed page', async () => {
  const f = fixture();
  await f.model.load();
  f.model.edit(f.model.snapshot().items[0]!);
  f.fetch.mockImplementationOnce(async () =>
    Response.json({ organization: ['org:sources:write'] }),
  );
  f.fetch.mockImplementationOnce(async () => Response.json({ items: [], next: null }));
  await f.model.load();
  f.fail(412, 'conflict');
  await f.model.save();
  expect(f.model.snapshot().items[0]?.revision).toBe(4);
  expect(f.model.snapshot().stale).toBe(true);
});

it('renders manager identifiers only as internal values and shows current counts', async () => {
  const f = fixture();
  await f.model.load();
  const html = renderToStaticMarkup(createElement(DiscoveryRulesView, { model: f.model }));
  expect(html).toContain('Libraries');
  expect(html).not.toContain(reader.id);
  expect(html).not.toContain(writer.credentialId);
  expect(html).toContain('Current run:');
  expect(html).toContain('3 repositories remaining');
  expect(html).not.toContain('Current failed repositories');
  expect(html.match(/role="status"/g)).toHaveLength(1);
});
it('allows an unchanged connection absent from the picker and omits the binding', async () => {
  const f = fixture();
  await f.model.load();
  f.fetch.mockImplementationOnce(async () =>
    Response.json({ organization: ['org:sources:write'] }),
  );
  f.fetch.mockImplementationOnce(async () => Response.json({ items: [writer], next: null }));
  f.fetch.mockImplementationOnce(async () => Response.json({ items: [] }));
  await f.model.load();
  f.model.edit(f.model.snapshot().items[0]!);
  const html = renderToStaticMarkup(createElement(DiscoveryRulesView, { model: f.model }));
  expect(html).toContain('Current connection (no longer used by any source)');
  await f.model.save();
  const call = f.fetch.mock.calls.find(([, init]) => init.method === 'PATCH')!;
  expect(JSON.parse(String(call[1].body))).not.toHaveProperty('credentialId');
  expect(f.model.snapshot().draft).toBeNull();
});
it('keeps the current draft and freezes inputs and writes during reauthentication', async () => {
  const f = fixture();
  await f.model.load();
  f.model.edit();
  f.model.configure({ name: 'Draft' });
  f.model.edit(f.model.snapshot().items[0]!);
  expect(f.model.snapshot().draft?.name).toBe('Draft');
  f.fail(403, 'reauth_required');
  await f.model.save();
  f.model.configure({ name: 'Changed' });
  f.model.close();
  await f.model.save();
  expect(f.model.snapshot().draft?.name).toBe('Draft');
  expect(f.model.snapshot().reauthPending).toBe(true);
  expect(f.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  await f.model.replayed({ ok: true, status: 201, path: '/_pb/sources/discovery/rules' });
  expect(f.model.snapshot().notice).toBe('Discovery rule saved.');
  expect(f.model.snapshot().draft).toBeNull();
});
it('sends a fresh idempotency key per create and run submission and retains it for reauth', async () => {
  const f = fixture();
  await f.model.load();
  f.model.edit();
  f.model.configure({ name: 'New' });
  f.fail(403, 'reauth_required');
  await f.model.save();
  const first = f.fetch.mock.calls.find(([, init]) => init.method === 'POST')!;
  const key = new Headers(first[1].headers).get('Idempotency-Key');
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
  expect(f.requireReauth.mock.calls[0]![0].idempotencyKey).toBe(key);
  await f.model.replayed({ ok: true, status: 201, path: '/_pb/sources/discovery/rules' });
  await f.model.run(f.model.snapshot().items[0]!);
  const last = f.fetch.mock.calls.filter(([, init]) => init.method === 'POST').at(-1)!;
  expect(new Headers(last[1].headers).get('Idempotency-Key')).not.toBe(key);
});
it('deletes using the current revision and reloads on a missing rule', async () => {
  const f = fixture();
  await f.model.load();
  const old = f.model.snapshot().items[0]!;
  await f.model.replayed({
    ok: false,
    status: 412,
    code: 'conflict',
    path: '/_pb/sources/discovery/rules/' + old.id,
  });
  f.fetch.mockImplementationOnce(async () =>
    Response.json({ organization: ['org:sources:write'] }),
  );
  f.fetch.mockImplementationOnce(async () =>
    Response.json({ items: [{ ...writer, revision: 9 }], next: null }),
  );
  await f.model.load();
  f.fail(404, 'not_found');
  await f.model.remove(old);
  const call = f.fetch.mock.calls.find(([, init]) => init.method === 'DELETE')!;
  expect(new Headers(call[1].headers).get('If-Match')).toBe('"r9"');
  expect(f.fetch.mock.calls.at(-1)![1].method).toBe('GET');
  expect(f.model.snapshot().error).toContain('no longer available');
});
it('uses specific conflict copy and distinguishes completed repository failures from aborted scans', () => {
  expect(ruleFailure({ status: 409, code: 'conflict' })).not.toContain('Enable');
  expect(ruleState({ ...writer, outcome: 'failed', failed: 2, failureReason: null } as never)).toBe(
    'Finished with 2 failed repositories',
  );
  expect(
    ruleState({ ...writer, outcome: 'failed', failureReason: 'discovery_failed' } as never),
  ).toContain('could not finish');
});

it('does not apply a stale 412 reread after the model is disposed', async () => {
  const f = fixture();
  await f.model.load();
  f.model.edit(f.model.snapshot().items[0]!);
  f.fail(412, 'conflict');
  let finish!: (response: Response) => void;
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((path, init) =>
    path.endsWith('/' + reader.id) && init.method === 'GET'
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : original(path, init),
  );
  const saving = f.model.save();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.model.dispose();
  finish(Response.json({ ...writer, revision: 99 }));
  await saving;
  expect(f.model.snapshot().items[0]?.revision).toBe(3);
});
it('de-duplicates rules across cursor pages and retains the newest version', async () => {
  const f = fixture();
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((path, init) =>
    path === '/_pb/sources/discovery/rules'
      ? Promise.resolve(Response.json({ items: [writer], next: 'cursor' }))
      : original(path, init),
  );
  await f.model.load();
  f.fetch.mockImplementation((path, init) =>
    path.includes('/rules?')
      ? Promise.resolve(Response.json({ items: [{ ...writer, revision: 7 }], next: null }))
      : original(path, init),
  );
  await f.model.load(true);
  expect(f.model.snapshot().items).toHaveLength(1);
  expect(f.model.snapshot().items[0]?.revision).toBe(7);
});
it('rejects fractional hours before submitting and renders mixed intervals as words', async () => {
  const { scheduleWords } = await import('./discovery-rules.js');
  expect(scheduleWords(5400)).toBe('Every 1 hour and 30 minutes');
  const f = fixture();
  await f.model.load();
  f.model.edit();
  f.model.configure({ name: 'Libraries', intervalSeconds: 5400 });
  await f.model.save();
  expect(f.model.snapshot().error).toContain('whole number of hours');
  expect(f.fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(0);
});
it('isolates prefilled drafts between organization service instances', async () => {
  const { prefillDiscoveryRule } = await import('./discovery-rule-prefill.js');
  const first = fixture();
  prefillDiscoveryRule(first.services, {
    credentialId: writer.credentialId,
    installationId: 42,
    ecosystem: 'npm',
    pattern: 'private*',
    includeForks: true,
  });
  expect(createDiscoveryRules(first.services).snapshot().draft?.pattern).toBe('private*');
  expect(createDiscoveryRules(fixture().services).snapshot().draft).toBeNull();
});
it('has one status region and a single Disabled label without manager guidance for readers', async () => {
  const f = fixture(false);
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((path, init) =>
    path.endsWith('/rules')
      ? Promise.resolve(Response.json({ items: [{ ...reader, enabled: false }], next: null }))
      : original(path, init),
  );
  await f.model.load();
  const html = renderToStaticMarkup(createElement(DiscoveryRulesView, { model: f.model }));
  expect(html.match(/Disabled/g)).toHaveLength(1);
  expect(html).not.toContain('Enable this rule');
  expect(html.match(/role="status"/g)).toHaveLength(1);
});

it('silences mutation reload announcements and uses a plain restart warning', async () => {
  const f = fixture();
  await f.model.load();
  const notices: (string | null)[] = [];
  f.model.subscribe(() => notices.push(f.model.snapshot().notice));
  f.model.edit(f.model.snapshot().items[0]!);
  f.model.configure({ pattern: 'changed*' });
  const html = renderToStaticMarkup(createElement(DiscoveryRulesView, { model: f.model }));
  expect(html.match(/role="status"/g)).toHaveLength(1);
  expect(html).toContain('Changing the connection');
  await f.model.save();
  expect(notices).not.toContain('Loading discovery rules…');
  expect(notices.at(-1)).toBe('Discovery rule saved.');
});
it('unlocks a retained draft when reauth confirmation is declined', async () => {
  const f = fixture();
  await f.model.load();
  f.model.edit();
  f.model.configure({ name: 'Draft' });
  f.fail(403, 'reauth_required');
  await f.model.save();
  expect(createDiscoveryRules(f.services).snapshot().reauthPending).toBe(true);
  await f.model.replayed({
    ok: false,
    status: 0,
    cancelled: true,
    path: '/_pb/sources/discovery/rules',
  });
  f.model.configure({ name: 'Reviewed' });
  expect(f.model.snapshot().draft?.name).toBe('Reviewed');
  expect(f.model.snapshot().reauthPending).toBe(false);
});
it('discards an out-of-order replay reread after a newer list load', async () => {
  const f = fixture();
  await f.model.load();
  f.model.edit(f.model.snapshot().items[0]!);
  let finish!: (response: Response) => void;
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((path, init) =>
    path.endsWith('/' + reader.id)
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : original(path, init),
  );
  const replay = f.model.replayed({
    ok: false,
    status: 412,
    code: 'conflict',
    path: '/_pb/sources/discovery/rules/' + reader.id,
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await f.model.load();
  finish(Response.json({ ...writer, revision: 99 }));
  await replay;
  expect(f.model.snapshot().items[0]?.revision).toBe(3);
});

it('renders completed repository failures as finished and combines load failures into one alert', async () => {
  const f = fixture();
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((path, init) =>
    path.endsWith('/rules')
      ? Promise.resolve(
          Response.json({
            items: [
              {
                ...writer,
                completed: {
                  lastRunAt: '2026-11-01T00:00:00Z',
                  outcome: 'failed',
                  failureReason: null,
                  created: 1,
                  existing: 0,
                  skipped: 0,
                  failed: 2,
                  skips: [],
                },
              },
            ],
            next: null,
          }),
        )
      : original(path, init),
  );
  await f.model.load();
  let html = renderToStaticMarkup(createElement(DiscoveryRulesView, { model: f.model }));
  expect(html).toContain('Finished with 2 failed repositories');
  expect(html).not.toContain('could not finish');
  f.fetch.mockImplementation((path, init) =>
    path.endsWith('/rules') || path.endsWith('/connections')
      ? Promise.resolve(Response.json({ error: { code: 'unavailable' } }, { status: 503 }))
      : original(path, init),
  );
  await f.model.load();
  html = renderToStaticMarkup(createElement(DiscoveryRulesView, { model: f.model }));
  expect(html.match(/role="alert"/g)).toHaveLength(1);
  expect(html.match(/role="status"/g)).toHaveLength(1);
});
