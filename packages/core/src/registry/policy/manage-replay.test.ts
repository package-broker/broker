import { describe, expect, it } from 'vitest';
import {
  POLICY_RULE_ID,
  policyCallerOf,
  policyRepositories,
  policyRuleRecord,
} from '../../test-support/policy-manage.js';
import { createPolicyManageService } from './manage.js';
import { createPolicyMemberService } from './manage-members.js';

function setup() {
  const repos = policyRepositories([policyRuleRecord()]);
  const manage = createPolicyManageService(repos.deps);
  return { repos, manage, members: createPolicyMemberService({ ...repos.deps, manage }) };
}

/** The write committed but its response was lost: the stored rule moved on to the next revision. */
function commit(repos: ReturnType<typeof policyRepositories>, overrides = {}) {
  repos.rules[0] = { ...repos.rules[0]!, revision: 2, ...overrides };
}

describe('idempotent replay of policy changes after a lost response', () => {
  it('replays an update with its original precondition', async () => {
    const { repos, manage } = setup();
    const key = repos.idempotency('u', 'update-hash');
    const first = await manage.update(policyCallerOf(), POLICY_RULE_ID, 1, { minAgeDays: 1 }, key);
    expect(first).toMatchObject({ ok: true, replayed: false, value: { revision: 2 } });
    commit(repos);
    const again = await manage.update(policyCallerOf(), POLICY_RULE_ID, 1, { minAgeDays: 1 }, key);
    expect(again).toEqual({ ...first, replayed: true });
    expect(
      await manage.update(
        policyCallerOf(),
        POLICY_RULE_ID,
        1,
        { minAgeDays: 2 },
        repos.idempotency('u', 'other-hash'),
      ),
    ).toEqual({ ok: false, error: 'idempotency_mismatch' });
    expect(repos.calls.map(([method]) => method)).toEqual(['update']);
  });

  it('replays a disable although the rule is disabled now', async () => {
    const { repos, manage } = setup();
    const key = repos.idempotency('d', 'disable-hash');
    const first = await manage.disable(policyCallerOf(), POLICY_RULE_ID, 1, 'other', key);
    expect(first).toMatchObject({ ok: true, replayed: false, value: { state: 'disabled' } });
    commit(repos, { disabledAt: '2026-11-02T10:00:00.000Z', disabledReason: 'other' });
    expect(await manage.disable(policyCallerOf(), POLICY_RULE_ID, 1, 'other', key)).toEqual({
      ...first,
      replayed: true,
    });
    expect(repos.calls.map(([method]) => method)).toEqual(['disable']);
  });

  it('replays a member replacement', async () => {
    const { repos, members } = setup();
    const key = repos.idempotency('m', 'members-hash');
    const first = await members.replace(
      policyCallerOf(),
      POLICY_RULE_ID,
      1,
      ['2.0.0'],
      undefined,
      key,
    );
    expect(first).toMatchObject({ ok: true, replayed: false, value: { revision: 2 } });
    commit(repos, { members: ['2.0.0'] });
    expect(
      await members.replace(policyCallerOf(), POLICY_RULE_ID, 1, ['2.0.0'], undefined, key),
    ).toEqual({ ...first, replayed: true });
    expect(repos.calls.map(([method]) => method)).toEqual(['members']);
  });

  it('still checks authority before it replays', async () => {
    const { repos, manage } = setup();
    const key = repos.idempotency('u', 'update-hash');
    await manage.update(policyCallerOf(), POLICY_RULE_ID, 1, { minAgeDays: 1 }, key);
    commit(repos);
    const reader = policyCallerOf({ organizationPermissions: new Set(['org:settings:write']) });
    expect(await manage.update(reader, POLICY_RULE_ID, 1, { minAgeDays: 1 }, key)).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});
