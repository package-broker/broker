import { describe, expect, it } from 'vitest';
import { errorEnvelope } from './envelope.js';
import type { ValidationDetail } from './api/validate.js';

describe('errorEnvelope', () => {
  it('preserves the original serialized output without details', () => {
    expect(JSON.stringify(errorEnvelope('x', 'y', 'r'))).toBe(
      '{"error":{"code":"x","message":"y","requestId":"r"}}',
    );
    expect(errorEnvelope('x', 'y', 'r').error).not.toHaveProperty('details');
    expect(errorEnvelope('x', 'y', 'r', undefined).error).not.toHaveProperty('details');
  });

  it('caps details at twenty without mutating the supplied array', () => {
    const details: readonly ValidationDetail[] = Object.freeze(
      Array.from({ length: 21 }, (_, i) => ({ path: `/field${i}`, code: 'invalid' as const })),
    );
    expect(errorEnvelope('x', 'y', 'r', details).error.details).toEqual(details.slice(0, 20));
    expect(details).toHaveLength(21);
  });

  it('preserves an explicitly empty details array', () => {
    expect(errorEnvelope('x', 'y', 'r', []).error.details).toEqual([]);
  });
});
