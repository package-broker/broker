import type { AuthorizationRequest } from '../kernel/authorize.js';
import type { Principal } from '../plugin.js';

export type DenialRecorder = (
  request: AuthorizationRequest,
  principal: Principal,
  projectId: string | null,
) => void;

const attempts = new WeakMap<AuthorizationRequest, () => void>();

export function clearAuthorizationFailure(request: AuthorizationRequest): void {
  attempts.delete(request);
}

export function setAuthorizationFailure(
  request: AuthorizationRequest,
  principal: Principal,
  projectId: string | null,
  record: DenialRecorder | undefined,
): void {
  if (record === undefined) return;
  const actor = Object.freeze({ ...principal });
  attempts.set(request, () => record(request, actor, projectId));
}

export function recordAuthorizationFailure(request: AuthorizationRequest): void {
  const record = attempts.get(request);
  attempts.delete(request);
  try {
    record?.();
  } catch {
    // Failure capture cannot change authorization results.
  }
}
