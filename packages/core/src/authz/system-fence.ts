declare const SYSTEM_FENCE: unique symbol;

/**
 * For bootstrap and test setup only; runFenced refuses it and it is not assignable to any
 * mutation fence. A server job writing through runFenced uses systemMutationFence() in fence.ts.
 */
export interface SystemFence {
  readonly [SYSTEM_FENCE]: true;
}

const ISSUER = Symbol('system-fence');

export function systemFence(): SystemFence {
  return Object.freeze({ [ISSUER]: true }) as unknown as SystemFence;
}
