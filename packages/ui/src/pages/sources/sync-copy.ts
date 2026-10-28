import type { ApiResult } from '../../api.js';

export const SYNC_REQUESTED =
  'Sync requested. Waiting for a worker. Sync continues in the background.';

export function mirrorOutcome(status: number, name: string, source: string) {
  return status === 200
    ? `${name} is already available from ${source}.`
    : `${name}: ${SYNC_REQUESTED}`;
}

export function sourceSyncResponse(result: ApiResult<unknown>): ApiResult<unknown> {
  // Source sync has no response body; acceptance is established by HTTP 202.
  return result.status === 202 ? { ok: true, status: 202, data: undefined } : result;
}
