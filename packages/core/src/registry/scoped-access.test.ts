import { describe, expect, it, vi } from 'vitest';
import type { ProjectActor } from '../authz/project-actor.js';
import { createPackageAccess } from '../catalogue/package-access.js';
import type { CatalogueReader, PackageVisibility } from '../db/catalogue.js';
import type { OrgContext, OrgId } from '../db/port.js';
import { createScopedAdmittingAccess } from './scoped-access.js';

const actor: ProjectActor = {
  kind: 'project',
  userId: 'u1',
  orgId: 'o1' as OrgId,
  projectId: 'p1',
  permissions: new Set(['project:packages:read']),
};
const absent = { kind: 'absent' } as const;
const reader = () =>
  ({
    resolveVersions: vi.fn().mockResolvedValue(null),
    admitProxy: vi.fn().mockResolvedValue([]),
  }) as unknown as CatalogueReader;

function harness(outcome: PackageVisibility = absent) {
  const resolve = vi.fn().mockResolvedValue(outcome);
  const admitScoped = vi.fn().mockResolvedValue(['s2', 's1']);
  return {
    resolve,
    admitScoped,
    access: createScopedAdmittingAccess({ resolve }, { admitScoped }),
  };
}

describe('scoped admitting access', () => {
  it('admits an unseen scoped name only in the attached project and organization', async () => {
    const admitScoped = vi.fn(async (ctx: OrgContext, query: { projectId: string; key: string }) =>
      ctx.orgId === actor.orgId && query.projectId === actor.projectId ? ['s1'] : [],
    );
    const access = createScopedAdmittingAccess(createPackageAccess(reader()), { admitScoped });
    await expect(access.resolve(actor, 'npm', '@acme/lib')).resolves.toEqual({
      kind: 'proxy_admissible',
      projectId: 'p1',
      ecosystem: 'npm',
      key: '@acme/lib',
      sourceIds: ['s1'],
    });
    for (const other of [
      { ...actor, projectId: 'p2' },
      { ...actor, orgId: 'o2' as OrgId },
    ]) {
      await expect(access.resolve(other, 'npm', '@acme/lib')).resolves.toEqual(absent);
    }
    expect(admitScoped).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      { projectId: 'p1', key: '@acme/lib' },
    );
  });

  it('passes visible packages and existing proxy permits through by identity', async () => {
    const visible = await createPackageAccess({
      ...reader(),
      resolveVersions: vi.fn().mockResolvedValue({ pkg: { key: '@acme/lib' } }),
    }).resolve(actor, 'npm', '@acme/lib');
    const proxy = {
      kind: 'proxy_admissible',
      projectId: 'p1',
      ecosystem: 'npm',
      key: '@acme/lib',
      sourceIds: ['public'],
    } as const;
    for (const outcome of [visible, proxy]) {
      const h = harness(outcome);
      await expect(h.access.resolve(actor, 'npm', '@acme/lib')).resolves.toBe(outcome);
      expect(h.admitScoped).not.toHaveBeenCalled();
    }
  });

  it('calls package access first, uses canonical keys and preserves admission order', async () => {
    const h = harness();
    h.admitScoped.mockImplementation(async () => {
      expect(h.resolve).toHaveBeenCalledWith(actor, 'npm', '@Acme/Lib');
      return ['s2', 's1'];
    });
    await expect(h.access.resolve(actor, 'npm', '@Acme/Lib')).resolves.toMatchObject({
      key: '@!acme/!lib',
      sourceIds: ['s2', 's1'],
    });
    expect(h.admitScoped).toHaveBeenCalledWith(
      { orgId: actor.orgId },
      { projectId: 'p1', key: '@!acme/!lib' },
    );
  });

  it.each([
    ['composer', 'acme/lib'],
    ['npm', 'lib'],
    ['npm', '@acme'],
    ['npm', '@acme/'],
    ['npm', '@acme/lib/extra'],
    ['npm', '@acme//'],
    ['npm', '@acme/a b'],
  ] as const)('never admits %s name %s', async (ecosystem, name) => {
    const h = harness();
    await expect(h.access.resolve(actor, ecosystem, name)).resolves.toBe(absent);
    expect(h.resolve).toHaveBeenCalledWith(actor, ecosystem, name);
    expect(h.admitScoped).not.toHaveBeenCalled();
  });

  it('does not widen denied access or accept a non-project actor', async () => {
    for (const denied of [
      { ...actor, permissions: new Set<string>() },
      { ...actor, kind: 'user' } as unknown as ProjectActor,
    ]) {
      const h = harness();
      await expect(h.access.resolve(denied, 'npm', '@acme/lib')).resolves.toBe(absent);
      expect(h.resolve).toHaveBeenCalled();
      expect(h.admitScoped).not.toHaveBeenCalled();
    }
  });

  it('does not cache either admissions or refusals', async () => {
    const h = harness();
    h.admitScoped.mockResolvedValueOnce([]).mockResolvedValueOnce(['s1']).mockResolvedValueOnce([]);
    await expect(h.access.resolve(actor, 'npm', '@acme/lib')).resolves.toBe(absent);
    await expect(h.access.resolve(actor, 'npm', '@acme/lib')).resolves.toMatchObject({
      kind: 'proxy_admissible',
    });
    await expect(h.access.resolve(actor, 'npm', '@acme/lib')).resolves.toBe(absent);
    expect(h.resolve).toHaveBeenCalledTimes(3);
    expect(h.admitScoped).toHaveBeenCalledTimes(3);
  });

  it('propagates errors without attempting an alternate admission', async () => {
    const h = harness();
    const error = new Error('unavailable');
    h.resolve.mockRejectedValueOnce(error);
    await expect(h.access.resolve(actor, 'npm', '@acme/lib')).rejects.toBe(error);
    expect(h.admitScoped).not.toHaveBeenCalled();
    h.admitScoped.mockRejectedValueOnce(error);
    await expect(h.access.resolve(actor, 'npm', '@acme/lib')).rejects.toBe(error);
  });
});
