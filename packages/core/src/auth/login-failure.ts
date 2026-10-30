import { isIpLiteral } from '../audit/actions.js';
import type { FailureAttempt } from '../audit/failure-events.js';
import type { OrgContext } from '../db/port.js';
import type { AuthCallMeta } from './session.js';

type LoginFailure = Extract<FailureAttempt, { action: 'session.login_failed' }>;
export type LoginFailureReason = LoginFailure['reason'];
export type LoginFailureRecorder = (ctx: OrgContext, attempt: LoginFailure) => void;

export function recordLoginFailure(
  recorder: LoginFailureRecorder | undefined,
  ctx: OrgContext,
  meta: AuthCallMeta,
  method: LoginFailure['method'],
  reason: LoginFailureReason,
  userId: string | null,
): void {
  try {
    recorder?.(ctx, {
      action: 'session.login_failed',
      method,
      reason,
      userId,
      context: {
        sourceIp: isIpLiteral(meta.ip) ? meta.ip : null,
      },
    });
  } catch {
    // Failure capture cannot change authentication results.
  }
}
