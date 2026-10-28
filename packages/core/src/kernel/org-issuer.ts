import { orgContext, type OrgContext } from '../db/port.js';

const issuedContexts = new WeakSet<OrgContext>();

export function issueKernelOrgContext(id: string): OrgContext {
  const context = orgContext(id);
  issuedContexts.add(context);
  return context;
}

export function assertKernelOrgContext(context: OrgContext): void {
  if (!issuedContexts.has(context)) throw new TypeError('kernel organization context required');
}
