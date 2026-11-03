const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const NOTIFICATION_ATTEMPT_OFFSETS_MS: readonly number[] = Object.freeze([
  0,
  5 * MINUTE_MS,
  30 * MINUTE_MS,
  2 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  18 * HOUR_MS,
  23 * HOUR_MS + 55 * MINUTE_MS,
]);
export const NOTIFICATION_LIFETIME_MS = 24 * HOUR_MS;
export const MIN_RETRY_SPACING_MS = 5 * MINUTE_MS;
export const MAX_RELEASE_SECONDS = 3600;

const MAX_ATTEMPTS = NOTIFICATION_ATTEMPT_OFFSETS_MS.length;
const DELTA_SECONDS = /^\d+$/;

function invalid(): never {
  throw new RangeError('Invalid notification schedule input');
}

function instant(iso: string): number {
  if (typeof iso !== 'string') invalid();
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== iso) invalid();
  return ms;
}

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function clock(now: Date): number {
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) invalid();
  return ms;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function clampSeconds(seconds: number): number {
  return Math.min(MAX_RELEASE_SECONDS, Math.max(1, Math.ceil(seconds)));
}

export function deliveryDeadline(createdAt: string): string {
  return iso(instant(createdAt) + NOTIFICATION_LIFETIME_MS);
}

/** Attempt numbers are 1-based. */
export function nominalSlot(createdAt: string, attempt: number): string {
  const offset = Number.isInteger(attempt)
    ? NOTIFICATION_ATTEMPT_OFFSETS_MS[attempt - 1]
    : undefined;
  if (offset === undefined) return invalid();
  return iso(instant(createdAt) + offset);
}

export interface NextAttemptInput {
  readonly createdAt: string;
  readonly completedAttempts: number;
  readonly lastFinishedAt: string;
  readonly retryAfterSeconds?: number | null;
}

/** Returns null when the delivery must expire instead of retrying. */
export function nextAttemptAt(input: NextAttemptInput): string | null {
  const created = instant(input.createdAt);
  const completed = count(input.completedAttempts);
  const finished = instant(input.lastFinishedAt);
  if (completed >= MAX_ATTEMPTS) return null;
  let due = Math.max(
    instant(nominalSlot(input.createdAt, completed + 1)),
    finished + MIN_RETRY_SPACING_MS,
  );
  const retryAfter = input.retryAfterSeconds;
  if (typeof retryAfter === 'number' && !Number.isNaN(retryAfter)) {
    due = Math.max(due, finished + clampSeconds(retryAfter) * 1000);
  }
  return due >= created + NOTIFICATION_LIFETIME_MS ? null : iso(due);
}

function httpDate(text: string): number | null {
  const ms = Date.parse(text);
  return Number.isFinite(ms) && new Date(ms).toUTCString() === text ? ms : null;
}

/** Accepts only delta-seconds or an IMF-fixdate; the result is clamped to 1..3600 seconds. */
export function parseRetryAfter(header: string | null, now: Date): number | null {
  if (header === null) return null;
  if (DELTA_SECONDS.test(header)) return clampSeconds(Number(header));
  const date = httpDate(header);
  if (date === null) return null;
  return clampSeconds((date - clock(now)) / 1000);
}

export interface StartCheckInput {
  readonly createdAt: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly now: Date;
}

export type StartVerdict = 'start' | 'expired' | { readonly wait: number };

/** A wait verdict is a job release in seconds; it never counts as an attempt. */
export function canStartAttempt(input: StartCheckInput): StartVerdict {
  const deadline = instant(input.createdAt) + NOTIFICATION_LIFETIME_MS;
  const attempts = count(input.attempts);
  const due = instant(input.nextAttemptAt);
  const now = clock(input.now);
  if (attempts >= MAX_ATTEMPTS || now >= deadline || due >= deadline) return 'expired';
  if (now < due) return { wait: clampSeconds((due - now) / 1000) };
  return 'start';
}
