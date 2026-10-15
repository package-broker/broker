declare const SYSTEM_FENCE: unique symbol;

/** For bootstrap and test setup only; not assignable to MutationFence. */
export interface SystemFence {
  readonly [SYSTEM_FENCE]: true;
}

const ISSUER = Symbol('system-fence');

export function systemFence(): SystemFence {
  return Object.freeze({ [ISSUER]: true }) as unknown as SystemFence;
}
