import { describe, expect, it } from 'vitest';
import { discoveryRuleFence, fenceKind } from '../authz/fence.js';

describe('organization discovery authority', () => {
  it('issues a rule fence without a user or session', () => {
    const fence = discoveryRuleFence('rule', 3, 'credential', 41, {
      id: 'job',
      owner: 'worker',
      fence: 2,
    });
    expect(fenceKind(fence)).toBe('discovery');
    expect(fence).not.toHaveProperty('userId');
    expect(fence).not.toHaveProperty('sessionId');
    expect(fence.revision).toBe(3);
  });
  it('refuses invalid revisions and installations', () => {
    for (const value of [0, -1, NaN, 1.5]) {
      expect(() =>
        discoveryRuleFence('rule', value, 'credential', 41, {
          id: 'job',
          owner: 'worker',
          fence: 2,
        }),
      ).toThrow();
      expect(() =>
        discoveryRuleFence('rule', 1, 'credential', value, {
          id: 'job',
          owner: 'worker',
          fence: 2,
        }),
      ).toThrow();
    }
  });
});
