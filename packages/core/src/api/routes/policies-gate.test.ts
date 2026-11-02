import { describe, expect, it } from 'vitest';
import { POLICY_RULE_ID, policyRuleRecord } from '../../test-support/policy-manage.js';
import { POLICY_PROJECT, policyRouteFixture } from '../../test-support/policy-routes.js';

const ageRule = policyRuleRecord({
  id: '01J0P0000000000000000000A1',
  kind: 'min_age',
  packageKey: null,
  minAgeSeconds: 86_400,
  members: [],
  memberCount: 0,
});
const projectAge = policyRuleRecord({ ...ageRule, id: '01J0P0000000000000000000A2' });
const projectBlock = policyRuleRecord({ id: '01J0P0000000000000000000B2' });
const minAge = { ecosystem: 'npm', kind: 'min_age', minAgeDays: 3, reasonCode: 'compatibility' };
const clientFloor = {
  ecosystem: 'npm',
  kind: 'client_floor',
  clientFamily: 'npm',
  clientMinVersion: '10.0.0',
  reasonCode: 'compatibility',
};
const memberRules = ['block', 'allowlist', 'quarantine'].map((kind) => ({
  ecosystem: 'npm',
  package: 'left-pad',
  kind,
  members: ['1.0.0'],
  reasonCode: 'malware',
}));

describe('policy route gate (DEC-NPM-51)', () => {
  it('lets a settings-only organization role read and write age and client floor rules only', async () => {
    const f = await policyRouteFixture({
      permissions: ['org:settings:write'],
      rules: [policyRuleRecord(), ageRule],
    });
    const list = await f.request('/_pb/policies');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: { id: string }[] }).items.map((r) => r.id)).toEqual([
      ageRule.id,
    ]);
    expect((await f.request(`/_pb/policies/${ageRule.id}`)).status).toBe(200);
    expect((await f.request(`/_pb/policies/${POLICY_RULE_ID}`)).status).toBe(403);
    let key = 0;
    const post = async (body: unknown) =>
      (await f.request('/_pb/policies', { method: 'POST', body, key: `g-${key++}` })).status;
    expect(await post(minAge)).toBe(201);
    expect(await post(clientFloor)).toBe(201);
    for (const body of memberRules) expect(await post(body)).toBe(403);
    const patch = await f.request(`/_pb/policies/${ageRule.id}`, {
      method: 'PATCH',
      body: { minAgeDays: 5 },
      key: 'g-patch',
      etag: '"r1"',
    });
    expect(patch.status).toBe(200);
    const refused = await f.request(`/_pb/policies/${POLICY_RULE_ID}`, {
      method: 'PATCH',
      body: { state: 'disabled', reason: 'other' },
      key: 'g-refused',
      etag: '"r1"',
    });
    expect(refused.status).toBe(403);
    expect(f.repos.calls.map(([method]) => method).filter((method) => method !== 'list')).toEqual([
      'create',
      'create',
      'update',
    ]);
  });

  it('lets a settings-only project role manage age rules of its project only', async () => {
    const f = await policyRouteFixture({
      permissions: ['project:settings:write'],
      rules: [
        { ...projectAge, projectId: POLICY_PROJECT },
        { ...projectBlock, projectId: POLICY_PROJECT },
      ],
    });
    const list = await f.request('/_pb/projects/demo/policies');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: { id: string }[] }).items.map((r) => r.id)).toEqual([
      projectAge.id,
    ]);
    expect((await f.request(`/_pb/projects/demo/policies/${projectBlock.id}`)).status).toBe(403);
    const created = await f.request('/_pb/projects/demo/policies', {
      method: 'POST',
      body: minAge,
      key: 'p-age',
    });
    expect(created.status).toBe(201);
    const blocked = await f.request('/_pb/projects/demo/policies', {
      method: 'POST',
      body: memberRules[0],
      key: 'p-block',
    });
    expect(blocked.status).toBe(403);
    expect((await f.request('/_pb/policies')).status).toBe(403);
  });

  it('refuses callers without any session before the policy service runs', async () => {
    const f = await policyRouteFixture({ permissions: ['org:settings:write'] });
    const anonymous = await f.request('/_pb/policies', { session: false });
    expect(anonymous.status).toBe(401);
  });
});

describe('policy write replay over HTTP after a lost response', () => {
  it.each([
    ['an edit', { reasonCode: 'compatibility' }, {}],
    [
      'a disable',
      { state: 'disabled', reason: 'other' },
      { disabledAt: '2026-11-02T10:00:00.000Z', disabledReason: 'other' as const },
    ],
    ['a member replacement', { members: ['2.0.0'] }, { members: ['2.0.0'] }],
  ])('replays %s with the stored response', async (_name, body, committed) => {
    const f = await policyRouteFixture();
    const path = `/_pb/policies/${POLICY_RULE_ID}`;
    const send = () => f.request(path, { method: 'PATCH', body, key: 'lost', etag: '"r1"' });
    const first = await send();
    expect(first.status).toBe(200);
    const stored = await first.json();
    f.repos.rules[0] = { ...f.repos.rules[0]!, revision: 2, ...committed };
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(await again.json()).toEqual(stored);
    expect(f.repos.calls).toHaveLength(1);
  });
});

describe('policy idempotency keys belong to one caller', () => {
  it('never replays another caller response for the same key', async () => {
    const f = await policyRouteFixture();
    const send = () => f.request('/_pb/policies', { method: 'POST', body: minAge, key: 'shared' });
    const mine = await send();
    expect(mine.status).toBe(201);
    f.actAs('01J0P0SER00000000000000002');
    const theirs = await send();
    expect(theirs.status).toBe(201);
    expect(theirs.headers.get('idempotent-replayed')).toBeNull();
    expect(f.repos.calls.map(([method]) => method)).toEqual(['create', 'create']);
  });
});
