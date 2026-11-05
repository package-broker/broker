import { describe, expect, it, vi } from 'vitest';
import type { PackageResolution, PageChanged } from '../db/catalogue.js';
import type { HookMap } from '../plugin.js';
import { RegistryPolicyUnavailableError } from '../registry/policy/errors.js';
import { catalogueEntry, memoryCatalogue } from '../test-support/registry-policy-catalogue.js';
import { policyRule, projectActor, sessionSetup } from '../test-support/registry-policy-session.js';
import { createPackageAccess, type PackageAccess } from './package-access.js';
import { createPolicyPackageAccess } from './policy-access.js';

const BLOCK = '01J0P0000000000000000000B1';

function page(result: PackageResolution | PageChanged | null): PackageResolution {
  if (result === null || 'changed' in result)
    throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  return result;
}

function setup(
  options: {
    count?: number;
    members?: string[];
    hooks?: Array<HookMap['registry.read']>;
    auditFails?: boolean;
    noBlock?: boolean;
  } = {},
) {
  const entry = catalogueEntry(options.count ?? 5);
  const catalogue = memoryCatalogue([entry]);
  const actor = projectActor();
  const policy = sessionSetup({
    actor,
    rules: options.noBlock
      ? []
      : [policyRule(BLOCK, { members: options.members ?? ['1.0.0', '1.0.1'] })],
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.auditFails ? { auditFails: true } : {}),
  });
  const session = policy.open();
  const access = createPolicyPackageAccess(createPackageAccess(catalogue.reader), session);
  return { entry, catalogue, actor, policy, session, access };
}

const ids = (result: PackageResolution) => result.versions.map((v) => v.versionId);

describe('policy-aware version pages', () => {
  it('an all-denied first raw page advances the cursor to later allowed versions', async () => {
    const { access, actor, catalogue } = setup();
    const result = page(await access.versions(actor, 'npm', 'left-pad', { limit: 2 }));
    expect(ids(result)).toEqual(['V0002', 'V0003']);
    expect(result.next).toEqual({ publishedAt: '2025-01-04T00:00:00.000Z', id: 'V0003' });
    expect(catalogue.calls).toEqual(['versions:start', 'versions:V0001']);
    const rest = page(
      await access.versions(actor, 'npm', 'left-pad', {
        limit: 2,
        binding: result.binding,
        after: result.next!,
      }),
    );
    expect(ids(rest)).toEqual(['V0004']);
    expect(rest.next).toBeNull();
  });

  it('keeps the result cap and the raw cursor on a partly denied page', async () => {
    const { access, actor } = setup({ members: ['1.0.1'] });
    const result = page(await access.versions(actor, 'npm', 'left-pad', { limit: 3 }));
    expect(ids(result)).toEqual(['V0000', 'V0002']);
    expect(result.versions.length).toBeLessThanOrEqual(3);
    expect(result.next).toEqual({ publishedAt: '2025-01-03T00:00:00.000Z', id: 'V0002' });
  });

  it('an all-denied package returns an empty final page, never a raw version', async () => {
    const { access, actor } = setup({ members: [] });
    const result = page(await access.versions(actor, 'npm', 'left-pad', { limit: 2 }));
    expect(result.versions).toEqual([]);
    expect(result.next).toBeNull();
  });

  it('binds continuation pages to the original winner and revision', async () => {
    const { access, actor, entry } = setup();
    const first = page(await access.versions(actor, 'npm', 'left-pad', { limit: 1 }));
    entry.pkg = { ...entry.pkg, sourceId: 'S2' };
    expect(
      await access.versions(actor, 'npm', 'left-pad', {
        limit: 1,
        binding: first.binding,
        after: first.next!,
      }),
    ).toEqual({ changed: true });
    const fresh = setup();
    const scan = page(await fresh.access.versions(fresh.actor, 'npm', 'left-pad', { limit: 1 }));
    expect(ids(scan)).toEqual(['V0002']);
    fresh.entry.pkg = { ...fresh.entry.pkg, rev: 2 };
    expect(
      await fresh.access.versions(fresh.actor, 'npm', 'left-pad', {
        limit: 1,
        binding: scan.binding,
        after: scan.next!,
      }),
    ).toEqual({ changed: true });
  });

  it('a winner change while skipping denied pages is a change, not a fallback', async () => {
    const { access, actor, entry, catalogue } = setup({
      count: 6,
      members: ['1.0.0', '1.0.1', '1.0.2', '1.0.3'],
    });
    const original = catalogue.reader.resolveVersions.bind(catalogue.reader);
    catalogue.reader.resolveVersions = async (ctx, query) => {
      const result = await original(ctx, query);
      entry.pkg = { ...entry.pkg, packageId: 'K-OTHER' };
      return result;
    };
    expect(await access.versions(actor, 'npm', 'left-pad', { limit: 2 })).toEqual({
      changed: true,
    });
  });

  it('has no raw escape: other actors and other ecosystems never return raw data', async () => {
    const { access, actor, catalogue } = setup();
    const other = projectActor();
    expect(await access.versions(other, 'npm', 'left-pad', { limit: 5 })).toBeNull();
    expect(await access.versions(actor, 'composer', 'left-pad', { limit: 5 })).toBeNull();
    expect((await access.list(other, 'npm', { limit: 10 })).items).toEqual([]);
    expect(await access.list(actor, 'composer', { limit: 10 })).toEqual({
      items: [],
      next: null,
      openNamespace: true,
    });
    expect(await access.search(other, 'npm', { text: 'pad', limit: 10 })).toEqual([]);
    expect(
      await access.dist(other, 'npm', 'left-pad', { by: 'version', versionNormalized: '1.0.0' }),
    ).toBeNull();
    expect(catalogue.calls).toEqual([]);
  });

  it('an actor without packages:read never reaches the session or a hook', async () => {
    const hook = vi.fn<HookMap['registry.read']>();
    const entry = catalogueEntry(3);
    const actor = projectActor({ permissions: new Set() });
    const policy = sessionSetup({ actor, hooks: [hook] });
    const reads = vi.spyOn(policy.policy.reader, 'snapshot');
    const access = createPolicyPackageAccess(
      createPackageAccess(memoryCatalogue([entry]).reader),
      policy.open(),
    );
    expect(await access.versions(actor, 'npm', 'left-pad', { limit: 5 })).toBeNull();
    expect(await access.distTags(actor, 'npm', 'left-pad')).toBeNull();
    expect(hook).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });

  it('collection filtering keeps working while the audit sink is down; all-denied still ends empty', async () => {
    const partly = setup({ auditFails: true, members: ['1.0.1'] });
    expect(
      ids(page(await partly.access.versions(partly.actor, 'npm', 'left-pad', { limit: 5 }))),
    ).toEqual(['V0000', 'V0002', 'V0003', 'V0004']);
    const all = setup({ auditFails: true, members: [] });
    expect(
      page(await all.access.versions(all.actor, 'npm', 'left-pad', { limit: 5 })).versions,
    ).toEqual([]);
    expect(partly.policy.audit.state.calls + all.policy.audit.state.calls).toBe(0);
  });

  it('a real policy read failure is still the fixed 503', async () => {
    const { access, actor, policy } = setup();
    policy.policy.state.fail = true;
    await expect(access.versions(actor, 'npm', 'left-pad', { limit: 5 })).rejects.toBeInstanceOf(
      RegistryPolicyUnavailableError,
    );
  });

  it('counts hidden versions once although the body re-reads the same pages', async () => {
    const counter = vi.fn();
    const { access, actor, session } = setup();
    await access.versions(actor, 'npm', 'left-pad', { limit: 5 });
    await access.versions(actor, 'npm', 'left-pad', { limit: 5 });
    session.metrics.flush({ counter });
    expect(counter.mock.calls).toEqual([
      ['pb.registry_policy.collection_filtered', { kind: 'npm', outcome: 'blocked' }, 2],
    ]);
  });

  it('a hook denial filters like a rule, and a missing date fact fails closed', async () => {
    const { access, actor } = setup({
      noBlock: true,
      hooks: [
        (input) =>
          input.phase === 'versions'
            ? {
                deniedVersions: input.versions
                  .filter((v) => v.version === '1.0.3')
                  .map((v) => ({
                    versionId: v.versionId,
                    revision: v.revision,
                    reason: 'restricted' as const,
                  })),
              }
            : undefined,
      ],
    });
    expect(ids(page(await access.versions(actor, 'npm', 'left-pad', { limit: 5 })))).toEqual([
      'V0000',
      'V0001',
      'V0002',
      'V0004',
    ]);
    const broken = setup({ noBlock: true });
    const legacy = { ...broken.entry.versions[0]!, publishedAtBasis: 'upstream' };
    delete legacy.createdAt;
    broken.entry.versions[0] = legacy;
    await expect(
      broken.access.versions(broken.actor, 'npm', 'left-pad', { limit: 5 }),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });

  it('refuses pages whose binding drifts even when the wrapped access does not report a change', async () => {
    const { entry, actor, policy } = setup();
    const real = createPackageAccess(memoryCatalogue([entry]).reader);
    const drifting = (rev: number): PackageAccess => ({
      ...real,
      async versions(...args) {
        const result = await real.versions(...args);
        if (result === null || 'changed' in result) return result;
        return { ...result, binding: { ...result.binding, rev } };
      },
    });
    const first = page(await real.versions(actor, 'npm', 'left-pad', { limit: 2 }));
    const continued = createPolicyPackageAccess(drifting(9), policy.open());
    expect(
      await continued.versions(actor, 'npm', 'left-pad', {
        limit: 1,
        binding: first.binding,
        after: first.next!,
      }),
    ).toEqual({ changed: true });
    let calls = 0;
    const skipping: PackageAccess = {
      ...real,
      async versions(...args) {
        calls += 1;
        return drifting(calls === 1 ? 1 : 9).versions(...args);
      },
    };
    expect(
      await createPolicyPackageAccess(skipping, policy.open()).versions(actor, 'npm', 'left-pad', {
        limit: 1,
      }),
    ).toEqual({ changed: true });
  });
});
