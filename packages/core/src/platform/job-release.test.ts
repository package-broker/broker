import { describe, expect, it } from 'vitest';
import { JobError, jobErrorCode } from './jobs.js';
import { JobRelease, releaseDelayOf } from './job-release.js';

describe('JobRelease', () => {
  it('is a JobError with the handler_error code and an own delay', () => {
    const error = new JobRelease(60);
    expect(error).toBeInstanceOf(JobError);
    expect(error.code).toBe('handler_error');
    expect(jobErrorCode(error)).toBe('handler_error');
    expect(Object.getOwnPropertyDescriptor(error, 'delaySeconds')?.value).toBe(60);
  });

  it.each([1, 60, 3600])('accepts %s seconds', (delay) => {
    expect(releaseDelayOf(new JobRelease(delay))).toBe(delay);
  });

  it.each([0, 3601, 1.5, Number.NaN, -1, Infinity])('rejects %s seconds', (delay) => {
    expect(() => new JobRelease(delay)).toThrow(RangeError);
  });
});

describe('releaseDelayOf', () => {
  it('returns null for anything that is not a JobRelease', () => {
    expect(releaseDelayOf(new JobError('handler_error'))).toBeNull();
    expect(releaseDelayOf(new Error('x'))).toBeNull();
    expect(releaseDelayOf({ delaySeconds: 60 })).toBeNull();
    expect(releaseDelayOf(null)).toBeNull();
    expect(releaseDelayOf(undefined)).toBeNull();
    expect(releaseDelayOf('release')).toBeNull();
  });

  it('reads the own data property only', () => {
    const inherited = Object.create(JobRelease.prototype) as unknown;
    expect(releaseDelayOf(inherited)).toBeNull();
    const accessor = new JobRelease(60);
    Object.defineProperty(accessor, 'delaySeconds', { get: () => 60 });
    expect(releaseDelayOf(accessor)).toBeNull();
  });

  it('returns null when the property was tampered into an invalid value', () => {
    const tampered = new JobRelease(60);
    Object.defineProperty(tampered, 'delaySeconds', { value: 99999 });
    expect(releaseDelayOf(tampered)).toBeNull();
  });
});
