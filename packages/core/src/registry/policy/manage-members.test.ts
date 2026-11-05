import { describe, expect, it } from 'vitest';
import {
  POLICY_RULE_ID,
  policyCallerOf,
  policyRepositories,
  policyRuleRecord,
} from '../../test-support/policy-manage.js';
import { createPolicyManageService } from './manage.js';
import { createPolicyMemberService } from './manage-members.js';

function setup(rules = [policyRuleRecord()]) {
  const repos = policyRepositories(rules);
  const manage = createPolicyManageService(repos.deps);
  return { repos, members: createPolicyMemberService({ ...repos.deps, manage }) };
}

describe('policy member management and release', () => {
  it('replaces members with the exact sorted set and lets an emptied block tighten', async () => {
    const { repos, members } = setup([policyRuleRecord({ members: ['1.0.0'] })]);
    expect(
      await members.replace(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        [],
        undefined,
        repos.idempotency('a'),
      ),
    ).toMatchObject({ ok: true, value: { memberCount: 0, revision: 2 } });
    expect(repos.calls[0]).toEqual([
      'members',
      expect.objectContaining({ members: [], expectedRevision: 1 }),
    ]);
    expect(repos.calls[0]![1]).not.toHaveProperty('overrideReason');
  });

  it('forwards the override reason and maps the reauthentication refusal of a first member', async () => {
    const { repos, members } = setup([policyRuleRecord({ members: [], memberCount: 0 })]);
    repos.refuse({ ok: false, reason: 'reauth_required' });
    expect(
      await members.replace(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        ['2.0.0', '1.0.0'],
        'false_positive',
        repos.idempotency('a'),
      ),
    ).toEqual({ ok: false, error: 'reauth_required' });
    expect(repos.calls[0]![1]).toMatchObject({
      members: ['1.0.0', '2.0.0'],
      overrideReason: 'false_positive',
    });
  });

  it.each([
    ['a range', ['^1.0.0']],
    ['a tag', ['latest']],
    ['a glob', ['1.*']],
    ['a duplicate', ['1.0.0', '1.0.0']],
    ['a non-string', [1]],
    ['too many', Array.from({ length: 1001 }, (_, i) => `1.0.${i}`)],
  ])('rejects %s before any write', async (_name, list) => {
    const { repos, members } = setup();
    expect(
      await members.replace(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        list,
        undefined,
        repos.idempotency('a'),
      ),
    ).toEqual({ ok: false, error: 'invalid_request', field: 'members' });
    expect(repos.calls).toEqual([]);
  });

  it('accepts canonical Composer members only', async () => {
    const composer = policyRuleRecord({ ecosystem: 'composer', packageKey: 'acme/widget' });
    const { repos, members } = setup([composer]);
    expect(
      await members.replace(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        ['1.0'],
        undefined,
        repos.idempotency('a'),
      ),
    ).toEqual({ ok: false, error: 'invalid_request', field: 'members' });
    expect(
      await members.replace(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        ['1.0.0.0', 'dev-main'],
        undefined,
        repos.idempotency('b'),
      ),
    ).toMatchObject({ ok: true });
  });

  it('refuses an empty quarantine and member sets on rules without members', async () => {
    const { repos, members } = setup([
      policyRuleRecord({ kind: 'quarantine', reasonCode: 'malware' }),
      policyRuleRecord({ id: '01J0P0000000000000000000R2', kind: 'min_age', packageKey: null }),
    ]);
    expect(
      await members.replace(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        [],
        'other',
        repos.idempotency('a'),
      ),
    ).toEqual({ ok: false, error: 'invalid_request', field: 'members' });
    expect(
      await members.replace(
        policyCallerOf(),
        '01J0P0000000000000000000R2',
        1,
        ['1.0.0'],
        undefined,
        repos.idempotency('b'),
      ),
    ).toEqual({ ok: false, error: 'invalid_request', field: 'members' });
    expect(repos.calls).toEqual([]);
  });

  it('releases exactly one quarantine by disabling it and touches no member set or version', async () => {
    const { repos, members } = setup([
      policyRuleRecord({ kind: 'quarantine', reasonCode: 'malware' }),
      policyRuleRecord({ id: '01J0P0000000000000000000R2' }),
    ]);
    expect(
      await members.release(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        'false_positive',
        repos.idempotency('a'),
      ),
    ).toMatchObject({ ok: true, value: { state: 'disabled', disabledReason: 'false_positive' } });
    expect(repos.calls).toEqual([
      ['disable', expect.objectContaining({ id: POLICY_RULE_ID, reason: 'false_positive' })],
    ]);
    expect(
      await members.release(
        policyCallerOf(),
        '01J0P0000000000000000000R2',
        1,
        'false_positive',
        repos.idempotency('b'),
      ),
    ).toEqual({ ok: false, error: 'invalid_request', field: 'kind' });
    expect(repos.calls).toHaveLength(1);
  });

  it('lets no machine actor or project manager release an organization quarantine', async () => {
    const { repos, members } = setup([
      policyRuleRecord({ kind: 'quarantine', reasonCode: 'malware' }),
    ]);
    expect(
      await members.release(
        policyCallerOf({ fence: null }),
        POLICY_RULE_ID,
        1,
        'other',
        repos.idempotency('a'),
      ),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(
      await members.release(
        policyCallerOf({
          routeProjectId: 'P1',
          organizationPermissions: new Set(),
          projectPermissions: new Set(['project:packages:manage']),
        }),
        POLICY_RULE_ID,
        1,
        'other',
        repos.idempotency('b'),
      ),
    ).toEqual({ ok: false, error: 'not_found' });
    expect(repos.calls).toEqual([]);
  });
});
