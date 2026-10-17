import type { ValidationDetail } from './api/validate.js';

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: readonly ValidationDetail[];
  };
}

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details?: readonly ValidationDetail[],
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      ...(details === undefined ? {} : { details: details.slice(0, 20) }),
    },
  };
}
