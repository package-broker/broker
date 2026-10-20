import { describe, expect, it } from 'vitest';
import { fenceKind } from '../authz/fence.js';
import { jobFences, jobLeaseOf } from './job-fences.js';

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

describe('jobLeaseOf', () => {
  it('returns the frozen lease given to jobFences', () => {
    const lease = jobLeaseOf({ fences: jobFences(guard) });
    expect(lease).toEqual(guard);
    expect(Object.isFrozen(lease)).toBe(true);
  });

  it('keeps the lease captured at construction when the guard is mutated later', () => {
    const mutable = { ...guard };
    const fences = jobFences(mutable);
    mutable.fence = 99;
    expect(jobLeaseOf({ fences })).toEqual(guard);
  });

  it('returns null without fences', () => {
    expect(jobLeaseOf({})).toBeNull();
  });

  it('returns null for a hand-built object that has the delegated method', () => {
    const forged = Object.freeze({
      delegated: () => {
        throw new Error('unused');
      },
    });
    expect(jobLeaseOf({ fences: forged })).toBeNull();
  });

  it('survives spreading the context into a new object', () => {
    const context = { fences: jobFences(guard), observability: 'a' };
    const wrapped = { ...context, observability: 'b' };
    expect(jobLeaseOf(wrapped)).toEqual(guard);
  });
});
