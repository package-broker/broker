import { JobError, RETRY_CAP_SECONDS } from './jobs.js';

export class JobRelease extends JobError {
  readonly delaySeconds: number;

  constructor(delaySeconds: number) {
    if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > RETRY_CAP_SECONDS) {
      throw new RangeError('delaySeconds out of range');
    }
    super('handler_error');
    this.name = 'JobRelease';
    this.delaySeconds = delaySeconds;
  }
}

export function releaseDelayOf(error: unknown): number | null {
  try {
    if (!(error instanceof JobRelease)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'delaySeconds');
    if (descriptor === undefined || !('value' in descriptor)) return null;
    const value: unknown = descriptor.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= RETRY_CAP_SECONDS
      ? value
      : null;
  } catch {
    return null;
  }
}
