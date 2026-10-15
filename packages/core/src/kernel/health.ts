import type { OrgContext } from '../db/port.js';
import type { KernelLog } from './errors.js';
import { envelopeResponse, logError } from './errors.js';

export interface ReadyOptions {
  readonly log?: KernelLog;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

class ProbeFailedError extends Error {
  constructor() {
    super('readiness probe returned false');
    this.name = 'ProbeFailedError';
  }
}

class ReadinessTimeoutError extends Error {
  constructor() {
    super('readiness check timed out');
    this.name = 'ReadinessTimeoutError';
  }
}

function statusResponse(status: 'live' | 'ready', requestId: string): Response {
  return Response.json(
    { status },
    { status: 200, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } },
  );
}

async function checkReady(
  probe: () => Promise<boolean>,
  resolveOrg: () => Promise<OrgContext>,
): Promise<void> {
  if (!(await probe())) throw new ProbeFailedError();
  await resolveOrg();
}

async function withTimeout(check: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReadinessTimeoutError()), timeoutMs);
  });
  try {
    await Promise.race([check, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function liveResponse(requestId: string): Response {
  return statusResponse('live', requestId);
}

export async function readyResponse(
  probe: () => Promise<boolean>,
  resolveOrg: () => Promise<OrgContext>,
  requestId: string,
  options: ReadyOptions = {},
): Promise<Response> {
  try {
    await withTimeout(checkReady(probe, resolveOrg), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return statusResponse('ready', requestId);
  } catch (error) {
    if (options.log !== undefined) logError(options.log, requestId, error);
    return envelopeResponse(503, 'not_ready', 'Not ready', requestId);
  }
}
