import { describe, expect, it } from 'vitest';
import { fenceKind } from '../authz/fence.js';
import { jobFences } from './job-fences.js';

const guard = { id: '01J0000000000000000000JOB1', owner: '01J0000000000000000000OWN1', fence: 3 };

describe('jobFences', () => {
  it('issues a delegated fence bound to the captured job lease', () => {
    const fence = jobFences(guard).delegated('user-1', 'run-1', { a: 1 });
    expect(fenceKind(fence)).toBe('delegated');
    expect(fence.job).toEqual(guard);
    expect(fence.approverUserId).toBe('user-1');
    expect(fence.runId).toBe('run-1');
    expect(fence.expected).toEqual({ a: 1 });
  });

  it('keeps the lease captured at construction when the guard object is mutated later', () => {
    const mutable = { ...guard };
    const fences = jobFences(mutable);
    mutable.fence = 99;
    mutable.owner = 'other';
    expect(fences.delegated('user-1', 'run-1', {}).job).toEqual(guard);
  });

  it('takes no lease from the caller', () => {
    const fences = jobFences(guard);
    expect(fences.delegated.length).toBe(3);
    expect(Object.isFrozen(fences)).toBe(true);
  });

  it('fails closed on an invalid lease or empty identifiers', () => {
    expect(() => jobFences({ ...guard, fence: 0 }).delegated('u', 'r', {})).toThrow(TypeError);
    expect(() => jobFences(guard).delegated('', 'r', {})).toThrow(TypeError);
    expect(() => jobFences(guard).delegated('u', '', {})).toThrow(TypeError);
  });
});
