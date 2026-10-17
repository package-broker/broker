import { DbError } from '../db/errors.js';
import { errorEnvelope } from '../envelope.js';
import { SecretsConfigError } from '../secrets/master-key.js';
import { reportableErrorName } from './error-name.js';
import { dbReason, envelopeReason } from './obs-codes.js';
import type { KernelReasonCode } from './obs-codes.js';
import { NotBootstrappedError } from './org.js';
import { KernelConfigError } from './registry.js';

export type KernelLog = (entry: Readonly<Record<string, unknown>>) => void;

export const defaultLog: KernelLog = (entry) => {
  console.error(JSON.stringify(entry));
};

const REASONS = new WeakMap<Response, KernelReasonCode>();

/** The reason code the kernel attached when it built `response`; undefined for any other response. */
export function responseReason(response: Response): KernelReasonCode | undefined {
  return REASONS.get(response);
}

export function envelopeResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  reason?: KernelReasonCode,
): Response {
  const response = Response.json(errorEnvelope(code, message, requestId), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  });
  if (reason !== undefined) REASONS.set(response, reason);
  return response;
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
  if (error instanceof SecretsConfigError || error instanceof KernelConfigError) {
    return { status: 503, code: 'misconfigured', message: 'Server is not configured' };
  }
  if (error instanceof DbError && error.kind === 'busy') {
    return { status: 503, code: 'unavailable', message: 'Try again later' };
  }
  return { status: 500, code: 'internal', message: 'Internal error' };
}

// The thrown message is never logged or echoed: a message may carry SQL or secrets.
export function logError(log: KernelLog, requestId: string, error: unknown): void {
  try {
    log({
      level: 'error',
      event: 'http.error',
      request_id: requestId,
      error_name: reportableErrorName(error),
      ...(error instanceof DbError ? { reason_code: dbReason(error.kind) } : {}),
    });
  } catch {
    // A failing log sink must not replace the response being built.
  }
}

export function errorResponse(error: unknown, requestId: string, log: KernelLog): Response {
  const { status, code, message } = mappingOf(error);
  if (status >= 500) logError(log, requestId, error);
  return envelopeResponse(status, code, message, requestId, envelopeReason(code));
}
