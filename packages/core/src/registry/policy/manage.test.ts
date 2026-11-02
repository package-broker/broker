import { describe, expect, it } from 'vitest';
import {
  POLICY_NOW,
  POLICY_RULE_ID,
  policyCallerOf,
  policyRepositories,
  policyRuleRecord,
} from '../../test-support/policy-manage.js';
import { createPolicyManageService, policyAuthority, readableKinds } from './manage.js';

const block = {
  scope: { kind: 'organization' } as const,
  ecosystem: 'npm' as const,
  package: 'Left-Pad',
  kind: 'block' as const,
  minAgeDays: null,
  clientFamily: null,
  clientMinVersion: null,
  denyUnknown: false,
  reasonCode: 'security_review' as const,
  incidentId: null,
  expiresAt: null,
  members: ['1.0.0', '1.0.0', '2.0.0'],
};

function setup(rules = [policyRuleRecord()]) {
  const repos = policyRepositories(rules);
  return { repos, service: createPolicyManageService(repos.deps) };
}

describe('policy rule management service', () => {
  it('creates a rule with the canonical package key, seconds and a stored replayable response', async () => {
    const { repos, service } = setup();
    const created = await service.create(policyCallerOf(), block, repos.idempotency('k1'));
    expect(created).toMatchObject({
      ok: true,
      replayed: false,
      value: {
        package: 'Left-Pad',
        kind: 'block',
        memberCount: 2,
        revision: 1,
        createdAt: POLICY_NOW,
        state: 'active',
      },
    });
    expect(repos.calls).toHaveLength(1);
    expect(repos.calls[0]![1]).toMatchObject({ packageKey: '!left-!pad', kind: 'block' });
    const age = await service.create(
      policyCallerOf(),
      { ...block, kind: 'min_age', package: null, minAgeDays: 7, members: [] },
      repos.idempotency('k2'),
    );
    expect(age).toMatchObject({ ok: true, value: { minAgeDays: 7 } });
    expect(repos.calls[1]![1]).toMatchObject({ minAgeSeconds: 604_800 });
  });

  it('returns the stored response for a replay and writes once', async () => {
    const { repos, service } = setup();
    const first = await service.create(policyCallerOf(), block, repos.idempotency('k1'));
    const second = await service.create(policyCallerOf(), block, repos.idempotency('k1'));
    expect(second).toEqual({ ...first, replayed: true });
    expect(repos.calls).toHaveLength(1);
    expect(
      await service.create(policyCallerOf(), block, repos.idempotency('k1', 'other-hash')),
    ).toEqual({ ok: false, error: 'idempotency_mismatch' });
    expect(repos.calls).toHaveLength(1);
  });

  it('answers a write that lost to a concurrent replay with the winner', async () => {
    const { repos, service } = setup();
    const winner = await service.create(policyCallerOf(), block, repos.idempotency('k1'));
    const stored = repos.records.get('k1')!;
    repos.records.delete('k1');
    repos.refuse({ ok: false, reason: 'replayed' });
    const key = repos.idempotency('k1');
    let finds = 0;
    const racing = {
      ...key,
      find: async () => (finds++ === 0 ? null : stored),
    };
    expect(await service.create(policyCallerOf(), block, racing)).toEqual({
      ...winner,
      replayed: true,
    });
  });

  it('lets no machine actor create, edit or disable a rule', async () => {
    const { repos, service } = setup();
    const machine = policyCallerOf({ fence: null, principal: { kind: 'service', id: 'svc' } });
    expect(await service.create(machine, block, repos.idempotency('a'))).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await service.update(
        machine,
        POLICY_RULE_ID,
        1,
        { reasonCode: 'compatibility' },
        repos.idempotency('b'),
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(
      await service.disable(machine, POLICY_RULE_ID, 1, 'false_positive', repos.idempotency('c')),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(await service.list(machine, { projectId: null, limit: 10 })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(repos.calls).toEqual([]);
  });

  it('passes a stale human session refusal through as reauthentication required', async () => {
    const { repos, service } = setup();
    repos.refuse({ ok: false, reason: 'reauth_required' });
    expect(
      await service.disable(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        'false_positive',
        repos.idempotency('k'),
      ),
    ).toEqual({ ok: false, error: 'reauth_required' });
    expect(repos.records.size).toBe(0);
  });

  it('keeps a project manager to the rules of its own project', async () => {
    const projectRule = policyRuleRecord({ id: '01J0P0000000000000000000R2', projectId: 'P2' });
    const { repos, service } = setup([policyRuleRecord(), projectRule]);
    const manager = policyCallerOf({
      routeProjectId: 'P1',
      organizationPermissions: new Set(),
      projectPermissions: new Set(['project:packages:manage']),
    });
    expect(
      await service.update(
        manager,
        POLICY_RULE_ID,
        1,
        { reasonCode: 'compatibility' },
        repos.idempotency('a'),
      ),
    ).toEqual({ ok: false, error: 'not_found' });
    expect(
      await service.disable(manager, projectRule.id, 1, 'other', repos.idempotency('b')),
    ).toEqual({ ok: false, error: 'not_found' });
    expect(await service.create(manager, block, repos.idempotency('c'))).toEqual({
      ok: false,
      error: 'not_found',
    });
    const own = await service.create(
      manager,
      { ...block, scope: { kind: 'project', projectId: 'P1' } },
      repos.idempotency('d'),
    );
    expect(own).toMatchObject({ ok: true, value: { scope: 'project', projectId: 'P1' } });
    expect(repos.calls.map(([method]) => method)).toEqual(['create']);
  });

  it('refuses an organization rule to a caller without the organization permission of its kind', async () => {
    const { repos, service } = setup();
    const settingsOnly = policyCallerOf({
      organizationPermissions: new Set(['org:settings:write']),
    });
    expect(await service.create(settingsOnly, block, repos.idempotency('a'))).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await service.get(settingsOnly, POLICY_RULE_ID)).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(readableKinds(settingsOnly, { kind: 'organization' })).toEqual([
      'min_age',
      'client_floor',
    ]);
    expect(policyAuthority(settingsOnly, { kind: 'project', projectId: 'P1' }, 'min_age')).toBe(
      'manage',
    );
    expect(repos.calls).toEqual([]);
  });

  it('refuses a stale revision before writing and maps a lost race to a conflict', async () => {
    const { repos, service } = setup([policyRuleRecord({ revision: 3 })]);
    expect(
      await service.update(
        policyCallerOf(),
        POLICY_RULE_ID,
        2,
        { reasonCode: 'malware' },
        repos.idempotency('a'),
      ),
    ).toEqual({ ok: false, error: 'conflict' });
    expect(repos.calls).toEqual([]);
    repos.refuse({ ok: false, reason: 'conflict' });
    expect(
      await service.update(
        policyCallerOf(),
        POLICY_RULE_ID,
        3,
        { reasonCode: 'malware' },
        repos.idempotency('b'),
      ),
    ).toEqual({ ok: false, error: 'conflict' });
  });

  it('disables exactly the named rule and records the override reason', async () => {
    const other = policyRuleRecord({ id: '01J0P0000000000000000000R3', kind: 'quarantine' });
    const { repos, service } = setup([policyRuleRecord(), other]);
    const disabled = await service.disable(
      policyCallerOf(),
      POLICY_RULE_ID,
      1,
      'false_positive',
      repos.idempotency('k'),
    );
    expect(disabled).toMatchObject({
      ok: true,
      value: {
        id: POLICY_RULE_ID,
        state: 'disabled',
        disabledReason: 'false_positive',
        revision: 2,
      },
    });
    expect(repos.calls).toEqual([
      [
        'disable',
        expect.objectContaining({
          id: POLICY_RULE_ID,
          reason: 'false_positive',
          expectedRevision: 1,
        }),
      ],
    ]);
  });

  it('converts days, rejects out-of-range ages and reports the unchanged rule for a no-op', async () => {
    const age = policyRuleRecord({
      kind: 'min_age',
      packageKey: null,
      minAgeSeconds: 86_400,
      members: [],
      memberCount: 0,
    });
    const { repos, service } = setup([age]);
    expect(
      await service.update(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        { minAgeDays: 3651 },
        repos.idempotency('a'),
      ),
    ).toEqual({ ok: false, error: 'invalid_request', field: 'minAgeSeconds' });
    expect(
      await service.update(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        { minAgeDays: 1.5 },
        repos.idempotency('b'),
      ),
    ).toEqual({ ok: false, error: 'invalid_request', field: 'minAgeSeconds' });
    expect(repos.calls).toEqual([]);
    await service.update(
      policyCallerOf(),
      POLICY_RULE_ID,
      1,
      { minAgeDays: 14 },
      repos.idempotency('c'),
    );
    expect(repos.calls[0]![1]).toMatchObject({ patch: { minAgeSeconds: 1_209_600 } });
    repos.refuse({ ok: true, revision: 1, unchanged: true });
    expect(
      await service.update(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        { minAgeDays: 1 },
        repos.idempotency('d'),
      ),
    ).toMatchObject({ ok: true, value: { revision: 1, minAgeDays: 1 } });
  });

  it('lists only the kinds the caller manages', async () => {
    const age = policyRuleRecord({
      id: '01J0P0000000000000000000R4',
      kind: 'min_age',
      packageKey: null,
    });
    const { repos, service } = setup([policyRuleRecord(), age]);
    const settingsOnly = policyCallerOf({
      organizationPermissions: new Set(['org:settings:write']),
    });
    expect(await service.list(settingsOnly, { projectId: null, limit: 10 })).toMatchObject({
      ok: true,
      value: { items: [{ id: age.id, kind: 'min_age' }] },
    });
    expect(repos.calls[0]![1]).toMatchObject({ kinds: ['min_age', 'client_floor'] });
    expect(
      await service.list(policyCallerOf({ organizationPermissions: new Set() }), {
        projectId: null,
        limit: 10,
      }),
    ).toEqual({ ok: false, error: 'forbidden' });
  });
});
