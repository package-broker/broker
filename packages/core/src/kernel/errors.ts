import { DbError } from '../db/errors.js';
import type { DbErrorKind } from '../db/errors.js';
import { errorEnvelope } from '../envelope.js';
import { NotBootstrappedError } from './org.js';

export type KernelLog = (entry: Readonly<Record<string, unknown>>) => void;

export const defaultLog: KernelLog = (entry) => {
  console.error(JSON.stringify(entry));
};

export function envelopeResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): Response {
  return Response.json(errorEnvelope(code, message, requestId), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  });
}

interface Mapping {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

function mappingOf(error: unknown): Mapping {
  if (error instanceof NotBootstrappedError) {
    return { status: 503, code: 'not_bootstrapped', message: 'Organization is not bootstrapped' };
  }
  if (error instanceof DbError && error.kind === 'busy') {
    return { status: 503, code: 'unavailable', message: 'Try again later' };
  }
  return { status: 500, code: 'internal', message: 'Internal error' };
}

const SAFE_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

function nameOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return SAFE_NAME.test(error.name) ? error.name : 'Error';
}

function kindOf(error: unknown): DbErrorKind | undefined {
  return error instanceof DbError ? error.kind : undefined;
}

// The thrown message is never logged or echoed: a message may carry SQL or secrets.
export function logError(log: KernelLog, requestId: string, error: unknown): void {
  try {
    log({ level: 'error', requestId, error: nameOf(error), kind: kindOf(error) });
  } catch {
    // A failing log sink must not replace the response being built.
  }
}

export function errorResponse(error: unknown, requestId: string, log: KernelLog): Response {
  const { status, code, message } = mappingOf(error);
  if (status >= 500) logError(log, requestId, error);
  return envelopeResponse(status, code, message, requestId);
}
