import { describe, expect, it } from 'vitest';
import { AUDIT_EVENTS } from '@package-broker/core/kernel/obs-codes';
import { NODE_RUNTIME_EVENTS } from './startup.js';

describe('Node runtime event registry', () => {
  it('registers every audit event', () => {
    expect(AUDIT_EVENTS.size).toBeGreaterThan(0);
    for (const event of AUDIT_EVENTS) expect(NODE_RUNTIME_EVENTS.has(event)).toBe(true);
  });
});
