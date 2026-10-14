export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

export function errorEnvelope(code: string, message: string, requestId: string): ErrorEnvelope {
  return { error: { code, message, requestId } };
}
