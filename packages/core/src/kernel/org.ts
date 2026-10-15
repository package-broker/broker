import type { OrgContext } from '../db/port.js';
import { orgContext } from '../db/port.js';
import type { OrganizationBootstrap } from '../db/organization.js';

export class NotBootstrappedError extends Error {
  constructor() {
    super('organization not bootstrapped');
    this.name = 'NotBootstrappedError';
  }
}

export function createOrgResolver(
  source: Pick<OrganizationBootstrap, 'findSingleton'>,
): () => Promise<OrgContext> {
  let cached: OrgContext | undefined;
  let inflight: Promise<OrgContext> | undefined;

  async function read(): Promise<OrgContext> {
    const row = await source.findSingleton();
    if (row === null) throw new NotBootstrappedError();
    return orgContext(row.id);
  }

  return () => {
    if (cached !== undefined) return Promise.resolve(cached);
    inflight ??= read()
      .then((context) => {
        cached = context;
        return context;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}
