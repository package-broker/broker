import type { OrgContext } from '../db/port.js';
import type { SourceRecord } from '../db/source.js';

export type SourceUnavailableReason =
  'credential_unavailable' | 'config_invalid' | 'policy_denied' | 'provider_unavailable';

/** `last_error` values a credential failure may replace; specific failure codes are kept. */
export const CREDENTIAL_UNAVAILABLE_REPLACES = [
  'network',
  'timeout',
  'http_error',
  'rate_limited',
] as const;

export const SOURCE_UNAVAILABLE_RETRY_SECONDS = 60;

export class SourceUnavailableError extends Error {
  override readonly name = 'SourceUnavailableError';
  constructor(readonly reason: SourceUnavailableReason) {
    super('source unavailable');
  }
}

/**
 * Sets `last_error = 'credential_unavailable'` on one organization-scoped source only while it holds
 * null or one of CREDENTIAL_UNAVAILABLE_REPLACES, so concurrent callers change the row at most once.
 */
export type CredentialUnavailableWrite = (ctx: OrgContext, sourceId: string) => Promise<void>;

export interface CredentialUnavailableMark {
  mark(ctx: OrgContext, record: Pick<SourceRecord, 'id' | 'lastError'>): Promise<void>;
}

function replaceable(code: string | null): boolean {
  return code === null || (CREDENTIAL_UNAVAILABLE_REPLACES as readonly string[]).includes(code);
}

export function createCredentialUnavailableMark(
  write: CredentialUnavailableWrite | undefined,
): CredentialUnavailableMark {
  const inFlight = new Set<string>();
  return {
    async mark(ctx, record) {
      if (write === undefined || !replaceable(record.lastError)) return;
      const key = `${ctx.orgId}\u0000${record.id}`;
      if (inFlight.has(key)) return;
      inFlight.add(key);
      try {
        await write(ctx, record.id);
      } catch {
        return;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
