import { describe, expect, it } from 'vitest';
import { setAccessContext } from '../../authz/access-context.js';
import { orgContext } from '../../db/port.js';
import type { RequestContext } from '../../plugin.js';
import { POLICY_RULE_ID, policyRuleRecord } from '../../test-support/policy-manage.js';
import {
  POLICY_ORIGIN,
  POLICY_PROJECT,
  POLICY_USER,
  policyRouteFixture,
} from '../../test-support/policy-routes.js';

const create = { ecosystem: 'npm', package: 'left-pad', kind: 'block', reasonCode: 'malware' };
const quarantine = policyRuleRecord({
  id: '01J0P0000000000000000000Q1',
  kind: 'quarantine',
  reasonCode: 'malware',
});

describe('policy write routes', () => {
  it('creates once per idempotency key and replays the stored response', async () => {
    const f = await policyRouteFixture();
    expect((await f.request('/_pb/policies', { method: 'POST', body: create })).status).toBe(400);
    const first = await f.request('/_pb/policies', { method: 'POST', body: create, key: 'k-1' });
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const created = await first.json();
    expect(created).toMatchObject({ package: 'left-pad', kind: 'block', revision: 1 });
    const replay = await f.request('/_pb/policies', { method: 'POST', body: create, key: 'k-1' });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual(created);
    const mismatch = await f.request('/_pb/policies', {
      method: 'POST',
      body: { ...create, reasonCode: 'compatibility' },
      key: 'k-1',
    });
    expect(mismatch.status).toBe(409);
    expect(f.repos.calls.filter(([method]) => method === 'create')).toHaveLength(1);
    expect(f.fences).toEqual([
      expect.objectContaining({ userId: POLICY_USER, sessionId: 'session-1' }),
    ]);
  });

  it('creates project rules in the project of the route', async () => {
    const f = await policyRouteFixture();
    const response = await f.request('/_pb/projects/demo/policies', {
      method: 'POST',
      body: { ecosystem: 'npm', kind: 'min_age', minAgeDays: 3, reasonCode: 'organization_policy' },
      key: 'k-p',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ scope: 'project', projectId: POLICY_PROJECT });
    expect(f.repos.calls[0]![1]).toMatchObject({
      scope: { kind: 'project', projectId: POLICY_PROJECT },
      minAgeSeconds: 259_200,
    });
  });

  it('requires a revision precondition and maps a stale one to 412', async () => {
    const f = await policyRouteFixture({ rules: [policyRuleRecord({ revision: 4 })] });
    const path = `/_pb/policies/${POLICY_RULE_ID}`;
    const body = { reasonCode: 'compatibility' };
    expect((await f.request(path, { method: 'PATCH', body, key: 'a' })).status).toBe(428);
    expect((await f.request(path, { method: 'PATCH', body, key: 'b', etag: '"r3"' })).status).toBe(
      412,
    );
    const ok = await f.request(path, { method: 'PATCH', body, key: 'c', etag: '"r4"' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('etag')).toBe('"r5"');
    expect(f.repos.calls.map(([method]) => method)).toEqual(['update']);
  });

  it('routes member replacement, disable and quarantine release to their writes', async () => {
    const f = await policyRouteFixture({ rules: [policyRuleRecord(), quarantine] });
    const block = `/_pb/policies/${POLICY_RULE_ID}`;
    expect(
      (
        await f.request(block, {
          method: 'PATCH',
          body: { members: ['2.0.0', '1.0.0'], overrideReason: 'false_positive' },
          key: 'm',
          etag: '"r1"',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(block, {
          method: 'PATCH',
          body: { state: 'disabled', reason: 'superseded' },
          key: 'd',
          etag: '"r1"',
        })
      ).status,
    ).toBe(200);
    const release = await f.request(`/_pb/policies/${quarantine.id}`, {
      method: 'PATCH',
      body: { state: 'disabled', reason: 'false_positive' },
      key: 'r',
      etag: '"r1"',
    });
    expect(release.status).toBe(200);
    expect(await release.json()).toMatchObject({ kind: 'quarantine', state: 'disabled' });
    expect(f.repos.calls.map(([method, input]) => [method, input['id']])).toEqual([
      ['members', POLICY_RULE_ID],
      ['disable', POLICY_RULE_ID],
      ['disable', quarantine.id],
    ]);
    expect(f.repos.calls[0]![1]).toMatchObject({
      members: ['1.0.0', '2.0.0'],
      overrideReason: 'false_positive',
    });
  });

  it.each([
    ['an empty patch', {}],
    ['only an override reason', { overrideReason: 'other' }],
    ['a free-text disable reason', { state: 'disabled', reason: 'asked nicely' }],
    ['a range member', { members: ['^1.0.0'] }],
  ])('rejects %s without writing', async (_name, body) => {
    const f = await policyRouteFixture();
    const response = await f.request(`/_pb/policies/${POLICY_RULE_ID}`, {
      method: 'PATCH',
      body,
      key: 'x',
      etag: '"r1"',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(f.repos.calls).toEqual([]);
  });

  it('answers a weakening write by a stale session with reauthentication required', async () => {
    const f = await policyRouteFixture();
    f.repos.refuse({ ok: false, reason: 'reauth_required' });
    const response = await f.request(`/_pb/policies/${POLICY_RULE_ID}`, {
      method: 'PATCH',
      body: { state: 'disabled', reason: 'other' },
      key: 'x',
      etag: '"r1"',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'reauth_required' } });
  });

  it('refuses a service token override before any write', async () => {
    const f = await policyRouteFixture({ rules: [quarantine] });
    const route = f.routes.find(
      (candidate) =>
        candidate.method === 'PATCH' &&
        candidate.path === '/_pb/projects/:project/policies/:policy',
    )!;
    const ctx = {
      request: new Request(`${POLICY_ORIGIN}/_pb/projects/demo/policies/${quarantine.id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'if-match': '"r1"',
          'idempotency-key': 'svc',
        },
        body: JSON.stringify({ state: 'disabled', reason: 'other' }),
      }),
      requestId: 'req-1',
      org: orgContext('org-a'),
      principal: { kind: 'service', id: 'svc-1' },
      projectId: POLICY_PROJECT,
      params: { project: 'demo', policy: quarantine.id },
    } as unknown as RequestContext;
    setAccessContext(ctx, {
      principal: { kind: 'service', id: 'svc-1' },
      projectId: POLICY_PROJECT,
      boundary: 'project',
      sessionId: null,
      token: { kind: 'svc', scope: 'full', readOnly: false },
      actor: null,
      rateKey: {
        stage: 'authenticated',
        tokenSelector: 'sel',
        principalId: 'svc-1',
        routeClass: 'project',
      },
    });
    const response = await route.handler(ctx);
    expect(response.status).toBe(403);
    expect(f.repos.calls).toEqual([]);
  });
});
