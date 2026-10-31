import { expect, it } from 'vitest';
import { proxyClaimConflict } from './proxy-claims-schema.js';

it('retains the shared envelope validation details on conflicts', () => {
  expect(
    proxyClaimConflict.safeParse({
      error: {
        code: 'conflict',
        message: 'Conflict',
        requestId: 'request',
        details: [{ path: 'body', code: 'invalid_type' }],
      },
      conflictingClaims: ['widget'],
    }).success,
  ).toBe(true);
});
