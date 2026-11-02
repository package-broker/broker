import { describe, expect, it } from 'vitest';
import type { PackageListItem, PolicyVersionFactsReader } from '../db/package-admin.js';
import type { RequestContext } from '../plugin.js';
import { RegistryPolicyBoundError, RegistryPolicyChangedError } from '../registry/policy/errors.js';
import { createPolicyServing } from '../registry/policy/serving.js';
import { projectActor, sessionSetup } from '../test-support/registry-policy-session.js';
import { MAX_PACKAGE_CANDIDATES } from './policy-access.js';
import { createPolicyViews } from './policy-views.js';

function item(n: number): PackageListItem {
  return {
    id: `01J0K00000000000000000${String(n).padStart(4, '0')}`,
    ecosystem: 'npm',
    name: `p${String(n).padStart(5, '0')}`,
    latestVersion: null,
    status: 'active',
    source: { id: 'S', name: 'npmjs', type: 'npmjs_proxy', projectId: null },
    versionCount: 0,
    lastSyncedAt: null,
  };
}

function views() {
  const actor = projectActor();
  const setup = sessionSetup({ actor });
  const facts: PolicyVersionFactsReader = { versionFacts: async () => [] };
  const ctx = {
    request: new Request('https://broker.test/_pb/projects/demo/packages'),
    requestId: '01J0R0000000000000000000R1',
    org: { orgId: actor.orgId },
    principal: { kind: 'user', id: actor.userId },
  } as unknown as RequestContext;
  return createPolicyViews(
    { serving: createPolicyServing(setup.deps), facts },
    ctx,
    actor,
    'listing',
  );
}

describe('policy views package-candidate bound', () => {
  it('counts candidates per request and fails past the bound', async () => {
    const view = views();
    for (let n = 0; n < MAX_PACKAGE_CANDIDATES; n += 1) await view.summarize(item(n));
    await expect(view.summarize(item(MAX_PACKAGE_CANDIDATES))).rejects.toBeInstanceOf(
      RegistryPolicyBoundError,
    );
  });

  it('starts again when a session starts a new attempt', async () => {
    const view = views();
    for (let n = 0; n < MAX_PACKAGE_CANDIDATES; n += 1) await view.summarize(item(n));
    const session = await view.sessionFor('npm');
    expect(() => session.invalidate()).toThrow(RegistryPolicyChangedError);
    for (let n = 0; n < MAX_PACKAGE_CANDIDATES; n += 1) {
      await expect(view.summarize(item(n))).resolves.toBeNull();
    }
  });
});
