import { expect, it, vi } from 'vitest';
import { createKernel } from '../../kernel/kernel.js';
import { createAuthorizationEngine, patValidationGate } from '../../authz/engine.js';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import { orgContext } from '../../db/port.js';
import { fixedClock, ulid } from '../../ids.js';
import { createKeyring } from '../../secrets/keyring.js';
import { discoveryRuleRoutes } from './discovery-rules.js';
import type { DiscoveryRuleRepository } from '../../db/discovery-rules.js';
import type { SessionService } from '../../auth/session.js';
import type { IdempotencyRecord } from '../idempotency.js';

const origin = 'https://broker.test';
const csrf = 'B'.repeat(43);
const clock = fixedClock('2026-11-01T00:00:00.000Z');
const credentialId = '01JA0000000000000000000001';
async function harness(
  platform: 'node' | 'cloudflare',
  permissions = ['org:sources:write', 'org:sources:read'],
) {
  let fresh = true;
  let record: IdempotencyRecord | null = null;
  const rule = {
    id: credentialId,
    name: 'Libraries',
    credentialId,
    installationId: 42,
    ecosystem: 'both',
    pattern: '*',
    includeForks: false,
    enabled: true,
    intervalSeconds: 86400,
    revision: 2,
    createdAt: clock.now().toISOString(),
    updatedAt: clock.now().toISOString(),
    lastRunAt: null,
    outcome: null,
    created: 0,
    existing: 0,
    skipped: 1,
    failed: 0,
    skips: [{ repository: 'acme/fork', reason: 'fork' }],
    cursor: null,
    remaining: [],
    nextRunAt: null,
  };
  const rules = {
    create: vi.fn(async (_ctx, _fence, input) => {
      record = input.call.idempotency ?? null;
      return 'ok';
    }),
    update: vi.fn(async () => 'ok'),
    delete: vi.fn(async () => 'ok'),
    runNow: vi.fn(async () => 'ok'),
    get: vi.fn(async () => rule),
    list: vi.fn(async () => [rule]),
  } as unknown as DiscoveryRuleRepository;
  const sessions = {
    authenticate: async () => ({ session: { id: 'session', userId: 'user' } }),
    isReauthFresh: () => fresh,
  } as unknown as SessionService;
  const app = await createKernel({
    platform,
    plugins: [],
    coreRoutes: discoveryRuleRoutes({
      rules,
      sessions,
      idempotency: { find: async () => record },
      ids: { ulid },
      clock,
      clientIp: () => null,
    }),
    ports: { organizations: { get: async () => null }, ids: { ulid }, clock },
    resolveOrg: async () => orgContext('org'),
    health: async () => true,
    log: () => {},
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async () => ({
          session: { id: 'session', csrfHash: await sha256Hex(csrf) },
          user: { id: 'user' },
          identity: null,
          protectedHolder: false,
          project: null,
          organizationPermissions: permissions,
          projectPermissions: [],
        }),
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
        nowMs: () => clock.now().getTime(),
        dispatch: (run) => {
          void run();
        },
        log: () => {},
      },
      patValidation: patValidationGate,
      publicOrigin: origin,
      providerAnchors: async () => [],
    }),
  });
  const request = (
    method: string,
    path = '/_pb/sources/discovery/rules',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.fetch(
      new Request(origin + path, {
        method,
        headers: {
          origin,
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}`,
          'x-csrf-token': csrf,
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    request,
    rules,
    stale: () => {
      fresh = false;
    },
  };
}
const path = '/_pb/sources/discovery/rules';
const input = { name: 'Libraries', credentialId, installationId: 42, pattern: '*' };
for (const platform of ['node', 'cloudflare'] as const) {
  it(`serves CRUD, revision preconditions and bounded results on ${platform}`, async () => {
    const h = await harness(platform);
    expect((await h.request('POST', path, input)).status).toBe(201);
    expect((await h.request('GET', path)).status).toBe(200);
    const read = await h.request('GET', `${path}/${credentialId}/results`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ skips: [], outcome: null });
    expect(read.headers.get('etag')).toBe('"r2"');
    expect((await h.request('PATCH', `${path}/${credentialId}`, { enabled: false })).status).toBe(
      428,
    );
    expect(
      (
        await h.request(
          'PATCH',
          `${path}/${credentialId}`,
          { enabled: false },
          { 'if-match': '"r2"' },
        )
      ).status,
    ).toBe(200);
    expect(
      (await h.request('DELETE', `${path}/${credentialId}`, undefined, { 'if-match': '"r2"' }))
        .status,
    ).toBe(204);
    expect((await h.request('POST', `${path}/${credentialId}/run`, {})).status).toBe(202);
  });
}
it('requires fresh sign-in for creation and credential or installation replacement', async () => {
  const h = await harness('node');
  h.stale();
  expect((await h.request('POST', path, input)).status).toBe(403);
  for (const body of [{ installationId: 43 }, { credentialId: '01JA0000000000000000000002' }]) {
    const response = await h.request('PATCH', `${path}/${credentialId}`, body, {
      'if-match': '"r2"',
    });
    expect(await response.json()).toMatchObject({ error: { code: 'reauth_required' } });
  }
  expect(
    (
      await h.request(
        'PATCH',
        `${path}/${credentialId}`,
        { pattern: 'lib-*' },
        { 'if-match': '"r2"' },
      )
    ).status,
  ).toBe(200);
});
it('replays source writes atomically and rejects a reused key with a different request', async () => {
  const h = await harness('node');
  const headers = { 'idempotency-key': 'same' };
  const first = await h.request('POST', path, input, headers);
  expect(first.status).toBe(201);
  const next = await h.request('POST', path, input, headers);
  expect(next.headers.get('idempotent-replayed')).toBe('true');
  expect(await next.json()).toEqual(await first.json());
  const mismatch = await h.request('POST', path, { ...input, pattern: 'other' }, headers);
  expect(await mismatch.json()).toMatchObject({ error: { code: 'idempotency_mismatch' } });
});
it('denies rule writes without organization source write permission', async () => {
  const h = await harness('node', ['org:sources:read']);
  expect((await h.request('GET', path)).status).toBe(200);
  expect((await h.request('POST', path, input)).status).toBe(403);
  expect(h.rules.create).not.toHaveBeenCalled();
});
it('validates interval, ecosystem and unknown fields', async () => {
  const h = await harness('node');
  for (const body of [{ intervalSeconds: 1 }, { ecosystem: 'python' }, { creator: 'user' }])
    expect((await h.request('POST', path, { ...input, ...body })).status).toBe(400);
});

it('refuses a revision different from the row used to merge a patch', async () => {
  const h = await harness('node');
  expect(
    (
      await h.request(
        'PATCH',
        `${path}/${credentialId}`,
        { pattern: 'lib-*' },
        { 'if-match': '"r1"' },
      )
    ).status,
  ).toBe(412);
  expect(h.rules.update).not.toHaveBeenCalled();
});

it('replays create even after freshness expires', async () => {
  const h = await harness('node');
  const headers = { 'idempotency-key': 'fresh-replay' };
  expect((await h.request('POST', path, input, headers)).status).toBe(201);
  h.stale();
  expect((await h.request('POST', path, input, headers)).status).toBe(201);
});
it('returns completed results without internal fields', async () => {
  const h = await harness('node');
  const response = await h.request('GET', `${path}/${credentialId}/results`);
  const value = await response.json();
  for (const key of ['credentialId', 'cursor', 'remaining']) expect(value).not.toHaveProperty(key);
});
it('permits source readers to list rules', async () => {
  const h = await harness('node', ['org:sources:read']);
  expect((await h.request('GET', path)).status).toBe(200);
});
it('refuses controls and newlines in rule names', async () => {
  const h = await harness('node');
  for (const name of ['bad\nname', 'bad\u0001name'])
    expect((await h.request('POST', path, { ...input, name })).status).toBe(400);
});

it('projects reader list and detail without credential or checkpoint fields', async () => {
  const h = await harness('node', ['org:sources:read']);
  for (const url of [path, `${path}/${credentialId}`]) {
    const value = (await (await h.request('GET', url)).json()) as { items?: unknown[] };
    const rule = value.items?.[0] ?? value;
    expect(rule).toHaveProperty('name', 'Libraries');
    for (const key of [
      'credentialId',
      'installationId',
      'cursor',
      'remaining',
      'consecutiveFailures',
    ])
      expect(rule).not.toHaveProperty(key);
  }
});
it('keeps full details for writers', async () => {
  const h = await harness('node');
  expect(await (await h.request('GET', `${path}/${credentialId}`)).json()).toHaveProperty(
    'credentialId',
  );
});

it('returns 404 for an invalid update credential and a specific 409 for disabled run-now', async () => {
  const h = await harness('node');
  vi.mocked(h.rules.update).mockResolvedValueOnce('not_found');
  const update = await h.request(
    'PATCH',
    `${path}/${credentialId}`,
    { credentialId: '01JA0000000000000000000002' },
    { 'if-match': '"r2"' },
  );
  expect(update.status).toBe(404);
  expect(await update.json()).toMatchObject({ error: { code: 'not_found' } });
  vi.mocked(h.rules.runNow).mockResolvedValueOnce('discovery_rule_disabled');
  const run = await h.request('POST', `${path}/${credentialId}/run`, {});
  expect(run.status).toBe(409);
  expect(await run.json()).toMatchObject({
    error: { code: 'discovery_rule_disabled', message: 'Discovery rule is disabled' },
  });
});
