import type { AuditJournalReader, AuditTrailContext } from '../audit/plugin-api.js';
import type { OrgContext } from '../db/port.js';

type JournalQuery = Parameters<AuditJournalReader['list']>[0];

function snapshotQuery(query: JournalQuery): JournalQuery {
  try {
    return copyQuery(query);
  } catch {
    throw new TypeError('Invalid audit journal query');
  }
}

function copyQuery(query: JournalQuery): JournalQuery {
  const invalid = (): never => {
    throw new Error();
  };
  if (typeof query !== 'object' || query === null || Array.isArray(query)) invalid();
  const proto: unknown = Object.getPrototypeOf(query);
  if (proto !== Object.prototype && proto !== null) invalid();
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(query)) {
    if (
      typeof key !== 'string' ||
      !['projectId', 'actor', 'action', 'afterSeq', 'limit'].includes(key)
    )
      invalid();
    const descriptor = Object.getOwnPropertyDescriptor(query, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) invalid();
    const value: unknown = descriptor!.value;
    if (
      key === 'projectId'
        ? value !== null && typeof value !== 'string'
        : key === 'limit' || key === 'afterSeq'
          ? typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < (key === 'limit' ? 1 : 0)
          : typeof value !== 'string'
    )
      invalid();
    copy[key as string] = value;
  }
  if (!Object.hasOwn(copy, 'projectId') || !Object.hasOwn(copy, 'limit')) invalid();
  return Object.freeze(copy) as unknown as JournalQuery;
}

export interface AuditTrailServices {
  readonly journal: {
    list(org: OrgContext, query: JournalQuery): ReturnType<AuditJournalReader['list']>;
    head(org: OrgContext): ReturnType<AuditJournalReader['head']>;
  };
  requestVerification(org: OrgContext): Promise<void>;
}

/** Runtime wiring calls this for the organization resolved for a request or job. */
export function createAuditTrailContext(
  org: OrgContext,
  active: boolean,
  services: AuditTrailServices,
): AuditTrailContext {
  return Object.freeze({
    active,
    journal: Object.freeze({
      list: async (query: JournalQuery) => services.journal.list(org, snapshotQuery(query)),
      head: () => services.journal.head(org),
    }),
    requestVerification: () => services.requestVerification(org),
  });
}
