/** A request-wide refusal: the fixed 403 policy_denied response. */
export class RegistryPolicyDeniedError extends Error {
  readonly code = 'policy_denied';
  readonly status = 403;

  constructor() {
    super('Package access denied by policy');
    this.name = 'RegistryPolicyDeniedError';
  }
}

/** Policy could not be evaluated or proven current: the fixed 503 policy_unavailable response. */
export class RegistryPolicyUnavailableError extends Error {
  readonly code = 'policy_unavailable';
  readonly status = 503;

  constructor() {
    super('Package policy is unavailable');
    this.name = 'RegistryPolicyUnavailableError';
  }
}

/** The policy snapshot, a binding or a time boundary moved; the caller discards its result and retries once. */
export class RegistryPolicyChangedError extends Error {
  constructor() {
    super('Package policy changed');
    this.name = 'RegistryPolicyChangedError';
  }
}

/** The per-request package candidate bound was reached; a listing may omit its enumeration. */
export class RegistryPolicyBoundError extends RegistryPolicyUnavailableError {
  constructor() {
    super();
    this.name = 'RegistryPolicyBoundError';
  }
}
