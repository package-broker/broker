import { describe, expect, it, vi } from 'vitest';
import type { HookMap } from '../plugin.js';
import {
  RegistryPolicyBoundError,
  RegistryPolicyChangedError,
  RegistryPolicyDeniedError,
  RegistryPolicyUnavailableError,
} from '../registry/policy/errors.js';
import { withPolicyRetry } from '../registry/policy/session.js';
import {
  catalogueEntry,
  memoryCatalogue,
  type CatalogueEntry,
} from '../test-support/registry-policy-catalogue.js';
import { policyRule, projectActor, sessionSetup } from '../test-support/registry-policy-session.js';
import type { PolicyRule } from '../db/registry-policy.js';
import { createPackageAccess } from './package-access.js';
import { createPolicyPackageAccess, MAX_PACKAGE_CANDIDATES } from './policy-access.js';

const BLOCK = '01J0P0000000000000000000B1';

function blockAll(packageKey: string, id = BLOCK): PolicyRule {
  return policyRule(id, { packageKey, members: [] });
}

function setup(
  options: {
    entries?: CatalogueEntry[];
    rules?: PolicyRule[];
    hooks?: Array<HookMap['registry.read']>;
    openNamespace?: boolean;
    auditFails?: boolean;
  } = {},
) {
  const entries = options.entries ?? [
    catalogueEntry(3, 'alpha'),
    catalogueEntry(3, 'bravo'),
    catalogueEntry(3, 'charlie'),
  ];
  const catalogue = memoryCatalogue(entries, { openNamespace: options.openNamespace ?? false });
  const actor = projectActor();
  const policy = sessionSetup({
    actor,
    rules: options.rules ?? [],
    input: { kind: 'search' },
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.auditFails ? { auditFails: true } : {}),
  });
  const session = policy.open();
  const access = createPolicyPackageAccess(createPackageAccess(catalogue.reader), session);
  return { entries, catalogue, actor, policy, session, access };
}

const keys = (items: readonly { key: string }[]) => items.map((item) => item.key);

describe('policy-aware lists and search', () => {
  it('a listing for another actor or ecosystem never claims a complete empty namespace', async () => {
    const { access, actor, catalogue } = setup();
    for (const listing of [
      await access.list(projectActor(), 'npm', { limit: 10 }),
      await access.list(actor, 'composer', { limit: 10 }),
    ]) {
      expect(listing).toEqual({ items: [], next: null, openNamespace: true });
    }
    expect(catalogue.calls).toEqual([]);
  });

  it('a package with no permitted version disappears from a listing; permitted controls stay', async () => {
    const { access, actor } = setup({ rules: [blockAll('bravo')] });
    const listing = await access.list(actor, 'npm', { limit: 10 });
    expect(keys(listing.items)).toEqual(['alpha', 'charlie']);
    expect(listing).toMatchObject({ next: null, openNamespace: false });
  });

  it('a package whose permitted versions are on a later raw version page is still listed', async () => {
    const bravo = catalogueEntry(3, 'bravo');
    const { access, actor } = setup({
      entries: [bravo],
      rules: [policyRule(BLOCK, { packageKey: 'bravo', members: ['1.0.0', '1.0.1'] })],
    });
    expect(keys((await access.list(actor, 'npm', { limit: 10 })).items)).toEqual(['bravo']);
  });

  it('an all-denied raw listing page is skipped by its raw cursor, not taken as the end', async () => {
    const { access, actor, catalogue } = setup({
      rules: [blockAll('alpha'), blockAll('bravo', '01J0P0000000000000000000B2')],
    });
    const listing = await access.list(actor, 'npm', { limit: 1 });
    expect(keys(listing.items)).toEqual(['charlie']);
    expect(listing.next).toBeNull();
    expect(catalogue.calls.filter((call) => call.startsWith('list:'))).toEqual([
      'list:start',
      'list:alpha',
      'list:bravo',
    ]);
  });

  it('a filtered page keeps the raw cursor of its last raw candidate', async () => {
    const { access, actor } = setup({ rules: [blockAll('bravo')] });
    const listing = await access.list(actor, 'npm', { limit: 2 });
    expect(keys(listing.items)).toEqual(['alpha']);
    expect(listing.next).toBe('bravo');
  });

  it('an open namespace stays open after filtering', async () => {
    const { access, actor } = setup({ openNamespace: true, rules: [blockAll('bravo')] });
    expect(await access.list(actor, 'npm', { limit: 10 })).toMatchObject({ openNamespace: true });
  });

  it('a listed package whose selected winner is another package is hidden, never proved by another source', async () => {
    const entries = [catalogueEntry(3, 'alpha'), catalogueEntry(3, 'bravo')];
    entries[1]!.listedAs = { packageId: 'K-bravo-old', sourceId: 'S-old' };
    const { access, actor, catalogue } = setup({ entries });
    expect(keys((await access.list(actor, 'npm', { limit: 10 })).items)).toEqual(['alpha']);
    expect(await access.search(actor, 'npm', { text: 'bravo', limit: 10 })).toEqual([]);
    expect(catalogue.calls.filter((call) => call.startsWith('versions:'))).toEqual([
      'versions:start',
      'versions:start',
      'versions:start',
    ]);
  });

  it('search returns only proved packages and its count is the returned count', async () => {
    const entries = [
      catalogueEntry(3, 'pad-a'),
      catalogueEntry(3, 'pad-b'),
      catalogueEntry(2, 'pad-c'),
    ];
    entries[0]!.description = 'first';
    const { access, actor, session } = setup({ entries, rules: [blockAll('pad-b')] });
    const found = await access.search(actor, 'npm', { text: 'pad', limit: 20 });
    expect(found).toEqual([
      { key: 'pad-a', packageId: 'K-pad-a', sourceId: 'S', description: 'first' },
      { key: 'pad-c', packageId: 'K-pad-c', sourceId: 'S', description: null },
    ]);
    const counter = vi.fn();
    session.metrics.flush({ counter });
    expect(counter.mock.calls).toEqual([
      ['pb.registry_policy.collection_filtered', { kind: 'npm', outcome: 'blocked' }, 3],
    ]);
  });

  it('collection filtering writes no durable audit and survives an audit outage', async () => {
    const { access, actor, policy } = setup({ rules: [blockAll('bravo')], auditFails: true });
    expect(keys((await access.list(actor, 'npm', { limit: 10 })).items)).toEqual([
      'alpha',
      'charlie',
    ]);
    expect(policy.audit.state.calls).toBe(0);
  });

  it('a package-specific request denial hides that package; an operation denial is the fixed 403', async () => {
    const hook = vi.fn<HookMap['registry.read']>((input) =>
      input.phase === 'request' && input.packageKey === 'bravo'
        ? { deny: true, reason: 'restricted' }
        : undefined,
    );
    const { access, actor } = setup({ hooks: [hook] });
    expect(keys((await access.list(actor, 'npm', { limit: 10 })).items)).toEqual([
      'alpha',
      'charlie',
    ]);
    expect(hook.mock.calls[0]![0]).toMatchObject({
      phase: 'request',
      kind: 'search',
      packageKey: null,
    });

    const operation = setup({
      hooks: [
        (input) => (input.phase === 'request' ? { deny: true, reason: 'restricted' } : undefined),
      ],
    });
    await expect(
      operation.access.list(operation.actor, 'npm', { limit: 10 }),
    ).rejects.toBeInstanceOf(RegistryPolicyDeniedError);
    await expect(
      operation.access.search(operation.actor, 'npm', { text: 'a', limit: 10 }),
    ).rejects.toBeInstanceOf(RegistryPolicyDeniedError);
    expect(operation.catalogue.calls).toEqual([]);
  });

  it('a policy read failure is the fixed 503, not an empty listing', async () => {
    const { access, actor, policy } = setup();
    policy.policy.state.fail = true;
    await expect(access.list(actor, 'npm', { limit: 10 })).rejects.toBeInstanceOf(
      RegistryPolicyUnavailableError,
    );
  });

  it('more package candidates than the per-request bound fail with the bound error', async () => {
    const entries = Array.from({ length: MAX_PACKAGE_CANDIDATES + 1 }, (_, n) =>
      catalogueEntry(1, `p${String(n).padStart(5, '0')}`),
    );
    const { access, actor } = setup({ entries });
    await expect(access.list(actor, 'npm', { limit: 2000 })).rejects.toBeInstanceOf(
      RegistryPolicyBoundError,
    );
    const within = setup({ entries: entries.slice(0, MAX_PACKAGE_CANDIDATES) });
    expect((await within.access.list(within.actor, 'npm', { limit: 2000 })).items).toHaveLength(
      MAX_PACKAGE_CANDIDATES,
    );
  });

  it('the package-candidate bound starts again when the session starts a new attempt', async () => {
    const entries = Array.from({ length: MAX_PACKAGE_CANDIDATES }, (_, n) =>
      catalogueEntry(1, `p${String(n).padStart(5, '0')}`),
    );
    const { access, actor, session } = setup({ entries });
    expect((await access.list(actor, 'npm', { limit: 2000 })).items).toHaveLength(
      MAX_PACKAGE_CANDIDATES,
    );
    expect(() => session.invalidate()).toThrow(RegistryPolicyChangedError);
    expect((await access.list(actor, 'npm', { limit: 2000 })).items).toHaveLength(
      MAX_PACKAGE_CANDIDATES,
    );
  });

  it('a policy commit between two listed packages is one change that a retry recovers from', async () => {
    const { access, actor, policy } = setup();
    const snapshot = policy.policy.reader.snapshot.bind(policy.policy.reader);
    let reads = 0;
    policy.policy.reader.snapshot = async (ctx, query) => {
      reads += 1;
      if (reads === 3) policy.policy.commit([blockAll('charlie')]);
      return snapshot(ctx, query);
    };
    await expect(access.list(actor, 'npm', { limit: 10 })).rejects.toBeInstanceOf(
      RegistryPolicyChangedError,
    );
    const retried = await withPolicyRetry(() => access.list(actor, 'npm', { limit: 10 }));
    expect(keys(retried.items)).toEqual(['alpha', 'bravo']);
  });

  it('only answers for the session actor and ecosystem', async () => {
    const { access, catalogue } = setup();
    expect(await access.list(projectActor(), 'npm', { limit: 10 })).toEqual({
      items: [],
      next: null,
      openNamespace: true,
    });
    expect(await access.search(projectActor(), 'npm', { text: 'a', limit: 10 })).toEqual([]);
    expect(
      await access.dist(projectActor(), 'npm', 'alpha', {
        by: 'id',
        versionId: 'V0000',
        revision: 1,
      }),
    ).toBeNull();
    expect(catalogue.calls).toEqual([]);
  });
});

describe('policy-aware dist resolution', () => {
  it('a denied dist target is a 404 after durable dist evidence; an allowed control resolves', async () => {
    const { access, actor, policy } = setup({
      rules: [policyRule(BLOCK, { packageKey: 'alpha', members: ['1.0.1'] })],
    });
    expect(
      await access.dist(actor, 'npm', 'alpha', { by: 'id', versionId: 'V0001', revision: 1 }),
    ).toBeNull();
    expect(policy.audit.events).toHaveLength(1);
    expect(JSON.parse(policy.audit.events[0]!.payloadJson)).toMatchObject({
      changes: { read_kind: { new: 'dist' }, version_id: { new: 'V0001' } },
    });
    expect(
      await access.dist(actor, 'npm', 'alpha', { by: 'id', versionId: 'V0002', revision: 1 }),
    ).toMatchObject({ versionId: 'V0002' });
  });

  it('a dist target without current policy facts fails closed', async () => {
    const { access, actor, catalogue } = setup();
    const resolve = catalogue.reader.resolveDist.bind(catalogue.reader);
    catalogue.reader.resolveDist = async (ctx, query) => {
      const target = await resolve(ctx, query);
      if (target === null) return null;
      return Object.fromEntries(
        Object.entries(target).filter(([key]) => key !== 'facts'),
      ) as unknown as typeof target;
    };
    await expect(
      access.dist(actor, 'npm', 'alpha', { by: 'id', versionId: 'V0001', revision: 1 }),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });

  it('a dist audit failure is the fixed 503', async () => {
    const { access, actor } = setup({ rules: [blockAll('alpha')], auditFails: true });
    await expect(
      access.dist(actor, 'npm', 'alpha', { by: 'id', versionId: 'V0001', revision: 1 }),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });
});
