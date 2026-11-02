import { envelopeResponse, type ErrorFormat } from '../../kernel/errors.js';
import {
  RegistryPolicyChangedError,
  RegistryPolicyDeniedError,
  RegistryPolicyUnavailableError,
} from './errors.js';

/** Policy-governed metadata may be stored but must be revalidated before every reuse. */
export const POLICY_METADATA_CACHE_CONTROL = 'private, no-cache';
/** Policy-governed files lose `immutable`: a later block must reach the next request. */
export const POLICY_DIST_CACHE_CONTROL = 'private, no-cache';
export const POLICY_ERROR_CACHE_CONTROL = 'private, no-store';
export const POLICY_RETRY_AFTER_SECONDS = 5;

/**
 * The fixed public response for a policy refusal, or null for any other error. A change that
 * escaped its retry is reported as unavailable. Nothing from the error reaches the body.
 */
export function policyErrorResponse(
  error: unknown,
  requestId: string,
  format: ErrorFormat = 'nested',
): Response | null {
  let response: Response;
  if (error instanceof RegistryPolicyDeniedError) {
    response = envelopeResponse(
      403,
      'policy_denied',
      'Package access denied by policy',
      requestId,
      undefined,
      format,
    );
  } else if (
    error instanceof RegistryPolicyUnavailableError ||
    error instanceof RegistryPolicyChangedError
  ) {
    response = envelopeResponse(
      503,
      'policy_unavailable',
      'Package policy is unavailable',
      requestId,
      undefined,
      format,
    );
    response.headers.set('Retry-After', String(POLICY_RETRY_AFTER_SECONDS));
  } else {
    return null;
  }
  response.headers.set('Cache-Control', POLICY_ERROR_CACHE_CONTROL);
  return response;
}

/**
 * A governed direct read answers a denial exactly like a missing version, so every 404 of such a
 * read carries the policy error cache policy whichever of the two it was.
 */
export function governNotFound(response: Response): Response {
  if (response.status === 404) response.headers.set('Cache-Control', POLICY_ERROR_CACHE_CONTROL);
  return response;
}

/** Replaces the long-lived dist cache policy with a revalidating one. */
export function governDistHeaders(headers: Headers): Headers {
  headers.set('Cache-Control', POLICY_DIST_CACHE_CONTROL);
  return headers;
}
