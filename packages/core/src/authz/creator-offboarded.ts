import type { OrgContext } from '../db/port.js';
import type { AdministrationDeps } from './administration.js';
import type { CreatorOffboardingCause } from './service-principal-service.js';

export async function creatorOffboarded(
  deps: {
    readonly onCreatorOffboarded?: AdministrationDeps['onCreatorOffboarded'];
    readonly log: AdministrationDeps['log'];
  },
  ctx: OrgContext,
  userId: string,
  cause: CreatorOffboardingCause,
): Promise<void> {
  const callback = deps.onCreatorOffboarded;
  if (callback === undefined) return;
  try {
    await callback(ctx, { userId, cause });
  } catch (error) {
    try {
      deps.log({
        level: 'warn',
        event: 'user.offboarding_callback_failed',
        orgId: ctx.orgId,
        userId,
        cause,
        error: error instanceof Error ? error.name : typeof error,
      });
    } catch {
      // The change is stored; neither callback nor sink failures can undo it.
    }
  }
}
