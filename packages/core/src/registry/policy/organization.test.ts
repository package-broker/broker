import { describe, expect, it } from 'vitest';
import { policyRule, sessionSetup, versionOf } from '../../test-support/registry-policy-session.js';
import { RegistryPolicyChangedError, RegistryPolicyUnavailableError } from './errors.js';
import { createOrganizationPolicyView } from './organization.js';

const BLOCK = '01J0P0000000000000000000B1';
const AGE = '01J0P0000000000000000000A1';
const org = { orgId: 'org-a' } as never;

describe('organization policy view', () => {
  it('applies organization rules only, reading the namespace once and one epoch at the seal', async () => {
    const setup = sessionSetup({
      namespace: true,
      rules: [
        policyRule(BLOCK, { members: ['1.0.1'] }),
        policyRule('01J0P0000000000000000000B2', { members: [], projectId: 'P' }),
      ],
    });
    const view = createOrganizationPolicyView(setup.deps, org, 'npm');
    expect(
      await view.permitted([versionOf(1), versionOf(2), versionOf(1, { packageKey: 'other' })]),
    ).toEqual([false, true, true]);
    await view.seal();
    expect(setup.policy.namespaces).toEqual([
      { orgId: 'org-a', query: { ecosystem: 'npm', projectId: null } },
    ]);
    expect(setup.policy.queries.map(({ query }) => query)).toEqual([
      { ecosystem: 'npm', projectId: null, packageKey: null },
    ]);
  });

  it('a rule change or a crossed age boundary before the seal is a change', async () => {
    const changed = sessionSetup();
    const view = createOrganizationPolicyView(changed.deps, org, 'npm');
    await view.permitted([versionOf(1)]);
    changed.policy.commit([]);
    await expect(view.seal()).rejects.toBeInstanceOf(RegistryPolicyChangedError);

    const aged = sessionSetup({
      rules: [policyRule(AGE, { kind: 'min_age', packageKey: null, minAgeSeconds: 86_400 })],
    });
    const young = new Date(aged.deps.clock.now().getTime() - 3_600_000).toISOString();
    const ageing = createOrganizationPolicyView(aged.deps, org, 'npm');
    expect(await ageing.permitted([versionOf(1, { publishedAt: young })])).toEqual([false]);
    aged.time.advance(86_400_000);
    await expect(ageing.seal()).rejects.toBeInstanceOf(RegistryPolicyChangedError);
  });

  it('an unreadable policy is the fixed 503', async () => {
    const setup = sessionSetup({ namespace: true });
    setup.policy.state.fail = true;
    await expect(
      createOrganizationPolicyView(setup.deps, org, 'npm').permitted([versionOf(1)]),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });
});
