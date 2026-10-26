import type { SourceErrorCode } from '../db/source.js';

const codes = new WeakMap<object, SourceErrorCode>();

export function withJobSourceError<T extends object>(error: T, code: SourceErrorCode): T {
  codes.set(error, code);
  return error;
}

export function jobSourceError(error: unknown): SourceErrorCode | undefined {
  return typeof error === 'object' && error !== null ? codes.get(error) : undefined;
}
