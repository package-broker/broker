import { describe, expect, it, vi } from 'vitest';
import { NotBootstrappedError, createOrgResolver } from './org.js';
import type { OrganizationBootstrap, OrganizationIdentity } from '../db/organization.js';
import type { OrgId } from '../db/port.js';

type Source = Pick<OrganizationBootstrap, 'findSingleton'>;

function identity(id: string): OrganizationIdentity {
  return { id: id as OrgId, slug: 'acme', name: 'Acme' };
}

describe('createOrgResolver', () => {
  it('memoizes the id across sequential calls with one source read', async () => {
    const findSingleton = vi.fn<Source['findSingleton']>().mockResolvedValue(identity('org-1'));
    const resolve = createOrgResolver({ findSingleton });

    const first = await resolve();
    const second = await resolve();
    const third = await resolve();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first.orgId).toBe('org-1');
    expect(findSingleton).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight read across ten concurrent first calls', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const findSingleton = vi.fn<Source['findSingleton']>().mockImplementation(async () => {
      await gate;
      return identity('org-1');
    });
    const resolve = createOrgResolver({ findSingleton });

    const pending = Array.from({ length: 10 }, () => resolve());
    release?.();
    const results = await Promise.all(pending);

    expect(findSingleton).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toBe(results[0]);
    }
  });

  it('does not memoize a missing row and recovers once a row appears', async () => {
    const findSingleton = vi
      .fn<Source['findSingleton']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(identity('org-1'));
    const resolve = createOrgResolver({ findSingleton });

    await expect(resolve()).rejects.toBeInstanceOf(NotBootstrappedError);
    const context = await resolve();

    expect(context.orgId).toBe('org-1');
    expect(findSingleton).toHaveBeenCalledTimes(2);
  });

  it('exposes the bootstrapping message on NotBootstrappedError', async () => {
    const findSingleton = vi.fn<Source['findSingleton']>().mockResolvedValue(null);
    const resolve = createOrgResolver({ findSingleton });

    await expect(resolve()).rejects.toThrow('organization not bootstrapped');
  });

  it('does not memoize a thrown error and reads again on the next call', async () => {
    const failure = new Error('flaky read');
    const findSingleton = vi
      .fn<Source['findSingleton']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(identity('org-1'));
    const resolve = createOrgResolver({ findSingleton });

    await expect(resolve()).rejects.toBe(failure);
    const context = await resolve();

    expect(context.orgId).toBe('org-1');
    expect(findSingleton).toHaveBeenCalledTimes(2);
  });

  it('keeps two resolvers independent', async () => {
    const firstSource = vi.fn<Source['findSingleton']>().mockResolvedValue(identity('org-1'));
    const secondSource = vi.fn<Source['findSingleton']>().mockResolvedValue(identity('org-2'));
    const resolveFirst = createOrgResolver({ findSingleton: firstSource });
    const resolveSecond = createOrgResolver({ findSingleton: secondSource });

    const first = await resolveFirst();
    const second = await resolveSecond();

    expect(first.orgId).toBe('org-1');
    expect(second.orgId).toBe('org-2');
    expect(firstSource).toHaveBeenCalledTimes(1);
    expect(secondSource).toHaveBeenCalledTimes(1);
  });
});
