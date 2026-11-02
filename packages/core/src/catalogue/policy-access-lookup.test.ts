import { describe, expect, it, vi } from 'vitest';
import type { HookMap } from '../plugin.js';
import {
  RegistryPolicyChangedError,
  RegistryPolicyDeniedError,
  RegistryPolicyUnavailableError,
} from '../registry/policy/errors.js';
import { catalogueEntry, memoryCatalogue } from '../test-support/registry-policy-catalogue.js';
import { policyRule, projectActor, sessionSetup } from '../test-support/registry-policy-session.js';
import { createPackageAccess } from './package-access.js';
import { createPolicyPackageAccess } from './policy-access.js';

const BLOCK = '01J0P0000000000000000000B1';

function setup(
  options: {
    members?: string[] | null;
    tags?: Record<string, string>;
    auditFails?: boolean;
    hooks?: Array<HookMap['registry.read']>;
  } = {},
) {
  const entry = catalogueEntry(5);
  entry.tags = options.tags ?? { latest: 'V0004', stable: 'V0003', legacy: 'V0000' };
  const catalogue = memoryCatalogue([entry]);
  const actor = projectActor();
  const policy = sessionSetup({
    actor,
    rules:
      options.members === null
        ? []
        : [policyRule(BLOCK, { members: options.members ?? ['1.0.4'], revision: 2 })],
    ...(options.auditFails ? { auditFails: true } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  const session = policy.open();
  const access = createPolicyPackageAccess(createPackageAccess(catalogue.reader), session);
  return { entry, catalogue, actor, policy, session, access };
}

const changes = (event: { payloadJson: string }) =>
  (JSON.parse(event.payloadJson) as { changes: Record<string, { new: unknown }> }).changes;

describe('policy-aware direct and tag access', () => {
  it('an allowed exact version is returned unchanged with no audit', async () => {
    const { access, actor, policy } = setup();
    expect(await access.version(actor, 'npm', 'left-pad', '1.0.3')).toMatchObject({
      version: { versionId: 'V0003' },
    });
    expect(policy.audit.events).toEqual([]);
  });

  it('a denied exact version is a 404 after durable evidence is written', async () => {
    const { access, actor, policy } = setup();
    expect(await access.version(actor, 'npm', 'left-pad', '1.0.4')).toBeNull();
    expect(policy.audit.events).toHaveLength(1);
    expect(changes(policy.audit.events[0]!)).toMatchObject({
      read_kind: { new: 'version' },
      package_key: { new: 'left-pad' },
      version_id: { new: 'V0004' },
      version_revision: { new: 1 },
      reasons: { new: [`rule:${BLOCK}:2:blocked`] },
    });
  });

  it('a denied tag target is a 404 without retargeting to another version', async () => {
    const { access, actor, policy, catalogue } = setup();
    expect(await access.tag(actor, 'npm', 'left-pad', 'latest')).toBeNull();
    expect(catalogue.calls).toEqual(['tag:latest']);
    expect(changes(policy.audit.events[0]!)).toMatchObject({
      read_kind: { new: 'tag' },
      version_id: { new: 'V0004' },
    });
    expect(await access.tag(actor, 'npm', 'left-pad', 'stable')).toMatchObject({
      version: { versionId: 'V0003' },
    });
  });

  it('records one event per denied version per request, even across version and tag reads', async () => {
    const { access, actor, policy } = setup();
    await access.version(actor, 'npm', 'left-pad', '1.0.4');
    await access.tag(actor, 'npm', 'left-pad', 'latest');
    await access.version(actor, 'npm', 'left-pad', '1.0.4');
    expect(policy.audit.events).toHaveLength(1);
  });

  it('an audit failure on a direct denial is the fixed 503, never the bytes', async () => {
    const { access, actor } = setup({ auditFails: true });
    await expect(access.version(actor, 'npm', 'left-pad', '1.0.4')).rejects.toBeInstanceOf(
      RegistryPolicyUnavailableError,
    );
    await expect(access.tag(actor, 'npm', 'left-pad', 'latest')).rejects.toBeInstanceOf(
      RegistryPolicyUnavailableError,
    );
    expect(await access.version(actor, 'npm', 'left-pad', '1.0.3')).not.toBeNull();
  });

  it('dist-tags drop a denied target without retargeting and count it only in metrics', async () => {
    const counter = vi.fn();
    const { access, actor, policy, session } = setup({ auditFails: true });
    const result = await access.distTags(actor, 'npm', 'left-pad');
    expect(result?.tags).toEqual({ stable: '1.0.3', legacy: '1.0.0' });
    expect(Object.getPrototypeOf(result?.tags)).toBeNull();
    expect(policy.audit.state.calls).toBe(0);
    session.metrics.flush({ counter });
    expect(counter.mock.calls).toEqual([
      ['pb.registry_policy.collection_filtered', { kind: 'npm', outcome: 'blocked' }, 1],
    ]);
  });

  it('a readable package whose tags all point at denied versions returns {}', async () => {
    const { access, actor } = setup({ members: ['1.0.4', '1.0.3', '1.0.0'] });
    expect((await access.distTags(actor, 'npm', 'left-pad'))?.tags).toEqual({});
    const untagged = setup({ tags: {} });
    expect((await untagged.access.distTags(untagged.actor, 'npm', 'left-pad'))?.tags).toEqual({});
  });

  it('a package with no eligible version has no dist-tags at all', async () => {
    const { access, actor } = setup({ members: [] });
    expect(await access.distTags(actor, 'npm', 'left-pad')).toBeNull();
  });

  it('a winner change between the tag list and a target lookup is not answered from mixed data', async () => {
    const { access, actor, entry, catalogue } = setup();
    const lookup = catalogue.reader.lookupVersion.bind(catalogue.reader);
    catalogue.reader.lookupVersion = async (ctx, query) => {
      entry.pkg = { ...entry.pkg, sourceId: 'S-NEW' };
      return lookup(ctx, query);
    };
    await expect(access.distTags(actor, 'npm', 'left-pad')).rejects.toBeInstanceOf(
      RegistryPolicyChangedError,
    );
  });

  it('a tag target that disappears after the tag list is a change, not a missing package', async () => {
    const { access, actor, catalogue } = setup();
    catalogue.reader.lookupVersion = async () => null;
    await expect(access.distTags(actor, 'npm', 'left-pad')).rejects.toBeInstanceOf(
      RegistryPolicyChangedError,
    );
  });

  it('a winner change while looking for any eligible version is a change, not a missing package', async () => {
    const { access, actor, entry, catalogue } = setup({ members: ['1.0.4', '1.0.3', '1.0.0'] });
    const resolve = catalogue.reader.resolveVersions.bind(catalogue.reader);
    catalogue.reader.resolveVersions = async (ctx, query) => {
      entry.pkg = { ...entry.pkg, sourceId: 'S-NEW' };
      return resolve(ctx, query);
    };
    await expect(access.distTags(actor, 'npm', 'left-pad')).rejects.toBeInstanceOf(
      RegistryPolicyChangedError,
    );
  });

  it('a request-phase denial is the fixed 403, but a missing package never reaches a hook', async () => {
    const hook = vi.fn<HookMap['registry.read']>(() => ({ deny: true, reason: 'restricted' }));
    const { access, actor } = setup({ members: null, hooks: [hook] });
    expect(await access.version(actor, 'npm', 'absent', '1.0.0')).toBeNull();
    expect(await access.tag(actor, 'npm', 'left-pad', 'no-such-tag')).toBeNull();
    expect(hook).not.toHaveBeenCalled();
    await expect(access.version(actor, 'npm', 'left-pad', '1.0.1')).rejects.toBeInstanceOf(
      RegistryPolicyDeniedError,
    );
    expect(hook.mock.calls[0]![0]).toMatchObject({ phase: 'request', packageKey: 'left-pad' });
  });

  it('only answers for the actor and ecosystem the session was opened for', async () => {
    const { access, catalogue } = setup();
    expect(await access.version(projectActor(), 'npm', 'left-pad', '1.0.3')).toBeNull();
    expect(await access.tag(projectActor(), 'npm', 'left-pad', 'stable')).toBeNull();
    expect(await access.distTags(projectActor(), 'npm', 'left-pad')).toBeNull();
    expect(catalogue.calls).toEqual([]);
  });
});
