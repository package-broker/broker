import { describe, expect, it } from 'vitest';
import {
  MAX_RELEASE_SECONDS,
  MIN_RETRY_SPACING_MS,
  NOTIFICATION_ATTEMPT_OFFSETS_MS,
  NOTIFICATION_LIFETIME_MS,
  canStartAttempt,
  deliveryDeadline,
  nextAttemptAt,
  nominalSlot,
  parseRetryAfter,
} from './retry.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CREATED = '2026-11-02T10:00:00.000Z';
const at = (offsetMs: number): string => new Date(Date.parse(CREATED) + offsetMs).toISOString();

interface Run {
  readonly starts: number[];
  readonly wakes: number;
  readonly releases: number[];
}

/** Drives a delivery with a fake clock: each attempt fails instantly, idle wakes are hourly. */
function drive(firstWakeMs: number, attemptDurationMs = 0, retryAfter: number | null = null): Run {
  const starts: number[] = [];
  const releases: number[] = [];
  let attempts = 0;
  let due: string | null = CREATED;
  let now = Date.parse(CREATED) + firstWakeMs;
  let wakes = 0;
  while (due !== null && wakes < 1000) {
    wakes += 1;
    const verdict = canStartAttempt({
      createdAt: CREATED,
      attempts,
      nextAttemptAt: due,
      now: new Date(now),
    });
    if (verdict === 'expired') break;
    if (verdict !== 'start') {
      releases.push(verdict.wait);
      now += verdict.wait * 1000;
      continue;
    }
    starts.push(now - Date.parse(CREATED));
    attempts += 1;
    now += attemptDurationMs;
    due = nextAttemptAt({
      createdAt: CREATED,
      completedAttempts: attempts,
      lastFinishedAt: new Date(now).toISOString(),
      retryAfterSeconds: retryAfter,
    });
  }
  return { starts, wakes, releases };
}

describe('constants', () => {
  it('reserves eight attempts across one day', () => {
    expect(NOTIFICATION_ATTEMPT_OFFSETS_MS).toEqual([
      0,
      5 * MINUTE,
      30 * MINUTE,
      2 * HOUR,
      6 * HOUR,
      12 * HOUR,
      18 * HOUR,
      23 * HOUR + 55 * MINUTE,
    ]);
    expect(NOTIFICATION_LIFETIME_MS).toBe(24 * HOUR);
    expect(MIN_RETRY_SPACING_MS).toBe(5 * MINUTE);
    expect(MAX_RELEASE_SECONDS).toBe(3600);
  });
});

describe('slots and deadline', () => {
  it('computes the deadline and nominal slots from the creation time', () => {
    expect(deliveryDeadline(CREATED)).toBe('2026-11-03T10:00:00.000Z');
    expect(nominalSlot(CREATED, 1)).toBe(CREATED);
    expect(nominalSlot(CREATED, 4)).toBe('2026-11-02T12:00:00.000Z');
    expect(nominalSlot(CREATED, 8)).toBe('2026-11-03T09:55:00.000Z');
  });

  it.each([0, 9, 1.5, Number.NaN])('refuses attempt number %s', (attempt) => {
    expect(() => nominalSlot(CREATED, attempt)).toThrow('Invalid notification schedule input');
  });

  it.each([
    '2026-11-02T10:00:00Z',
    '2026-11-02T10:00:00.000+00:00',
    '2026-02-30T10:00:00.000Z',
    'x',
  ])('refuses the timestamp %s', (value) => {
    expect(() => deliveryDeadline(value)).toThrow('Invalid notification schedule input');
  });
});

describe('day-long schedule', () => {
  it('starts eight immediately failing attempts exactly on the nominal slots', () => {
    const run = drive(0);
    expect(run.starts).toEqual([...NOTIFICATION_ATTEMPT_OFFSETS_MS]);
  });

  it('wakes hourly before a due time without starting or counting an attempt', () => {
    const run = drive(0);
    expect(run.releases.every((wait) => wait >= 1 && wait <= MAX_RELEASE_SECONDS)).toBe(true);
    expect(run.releases.length).toBeGreaterThan(8);
    expect(run.starts).toHaveLength(8);
    const verdict = canStartAttempt({
      createdAt: CREATED,
      attempts: 4,
      nextAttemptAt: at(6 * HOUR),
      now: new Date(Date.parse(at(2 * HOUR)) + 1),
    });
    expect(verdict).toEqual({ wait: MAX_RELEASE_SECONDS });
    expect(
      canStartAttempt({
        createdAt: CREATED,
        attempts: 4,
        nextAttemptAt: at(6 * HOUR),
        now: new Date(Date.parse(at(6 * HOUR)) - 1500),
      }),
    ).toEqual({ wait: 2 });
    expect(
      canStartAttempt({
        createdAt: CREATED,
        attempts: 4,
        nextAttemptAt: at(6 * HOUR),
        now: new Date(Date.parse(at(6 * HOUR)) - 1),
      }),
    ).toEqual({ wait: 1 });
    expect(
      canStartAttempt({
        createdAt: CREATED,
        attempts: 4,
        nextAttemptAt: at(6 * HOUR),
        now: new Date(at(6 * HOUR)),
      }),
    ).toBe('start');
  });

  it('spaces catch-up attempts by five minutes after a worker outage', () => {
    const run = drive(7 * HOUR);
    expect(run.starts).toEqual([
      7 * HOUR,
      7 * HOUR + 5 * MINUTE,
      7 * HOUR + 10 * MINUTE,
      7 * HOUR + 15 * MINUTE,
      7 * HOUR + 20 * MINUTE,
      12 * HOUR,
      18 * HOUR,
      23 * HOUR + 55 * MINUTE,
    ]);
    for (let index = 1; index < run.starts.length; index += 1) {
      expect((run.starts[index] ?? 0) - (run.starts[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        MIN_RETRY_SPACING_MS,
      );
    }
  });

  it('spaces the next start from the finish of a slow attempt', () => {
    expect(
      nextAttemptAt({
        createdAt: CREATED,
        completedAttempts: 1,
        lastFinishedAt: at(2 * MINUTE),
      }),
    ).toBe(at(7 * MINUTE));
  });

  it('starts nothing for a worker first waking after the deadline', () => {
    expect(drive(24 * HOUR).starts).toEqual([]);
  });
});

describe('Retry-After', () => {
  const NOW = new Date('2026-11-02T10:00:00.000Z');

  it.each<[string | null, number | null]>([
    ['0', 1],
    ['1', 1],
    ['120', 120],
    ['3600', 3600],
    ['3601', 3600],
    ['99999', 3600],
    ['99999999999999999999999', 3600],
    ['Mon, 02 Nov 2026 10:02:00 GMT', 120],
    ['Mon, 02 Nov 2026 10:00:00 GMT', 1],
    ['Mon, 02 Nov 2026 09:00:00 GMT', 1],
    ['Tue, 03 Nov 2026 10:00:00 GMT', 3600],
    ['Tue, 02 Nov 2026 10:02:00 GMT', null],
    ['Mon, 31 Feb 2026 10:02:00 GMT', null],
    ['Sun, 29 Feb 2026 10:00:00 GMT', null],
    ['Mon, 02 Nov 2026 24:00:00 GMT', null],
    ['Mon, 02 nov 2026 10:02:00 GMT', null],
    ['Mon, 02 Nov 2026 10:02:60 GMT', null],
    ['Monday, 02-Nov-26 10:02:00 GMT', null],
    ['Mon Nov  2 10:02:00 2026', null],
    ['Mon, 02 Nov 2026 10:02:00 UTC', null],
    ['2026-11-02T10:02:00Z', null],
    ['-5', null],
    ['+5', null],
    ['1.5', null],
    ['1e3', null],
    [' 5', null],
    ['5 ', null],
    ['', null],
    ['soon', null],
    [null, null],
  ])('parses %j as %s', (header, expected) => {
    expect(parseRetryAfter(header, NOW)).toBe(expected);
  });

  it('extends the next start but never beyond the hour cap', () => {
    const base = { createdAt: CREATED, completedAttempts: 1, lastFinishedAt: at(0) };
    expect(nextAttemptAt({ ...base, retryAfterSeconds: 1200 })).toBe(at(20 * MINUTE));
    expect(nextAttemptAt({ ...base, retryAfterSeconds: 99_999 })).toBe(at(HOUR));
    expect(nextAttemptAt({ ...base, retryAfterSeconds: 0 })).toBe(at(5 * MINUTE));
    expect(nextAttemptAt({ ...base, retryAfterSeconds: null })).toBe(at(5 * MINUTE));
    expect(nextAttemptAt({ ...base, retryAfterSeconds: Number.NaN })).toBe(at(5 * MINUTE));
    expect(nextAttemptAt(base)).toBe(at(5 * MINUTE));
    expect(
      nextAttemptAt({
        ...base,
        completedAttempts: 2,
        lastFinishedAt: at(5 * MINUTE),
        retryAfterSeconds: 360,
      }),
    ).toBe(at(30 * MINUTE));
  });

  it('expires when Retry-After pushes the next start to or past the deadline', () => {
    expect(
      nextAttemptAt({
        createdAt: CREATED,
        completedAttempts: 7,
        lastFinishedAt: at(23 * HOUR + 30 * MINUTE),
        retryAfterSeconds: 3600,
      }),
    ).toBeNull();
    expect(
      nextAttemptAt({
        createdAt: CREATED,
        completedAttempts: 7,
        lastFinishedAt: at(23 * HOUR),
        retryAfterSeconds: 3600,
      }),
    ).toBeNull();
    expect(
      nextAttemptAt({
        createdAt: CREATED,
        completedAttempts: 7,
        lastFinishedAt: at(23 * HOUR),
        retryAfterSeconds: 3599,
      }),
    ).toBe(at(23 * HOUR + 59 * MINUTE + 59_000));
  });

  it('expires when minimum spacing reaches the deadline', () => {
    expect(
      nextAttemptAt({
        createdAt: CREATED,
        completedAttempts: 7,
        lastFinishedAt: at(23 * HOUR + 55 * MINUTE),
      }),
    ).toBeNull();
  });
});

describe('expiry', () => {
  it('refuses a ninth start', () => {
    expect(
      nextAttemptAt({
        createdAt: CREATED,
        completedAttempts: 8,
        lastFinishedAt: at(23 * HOUR + 55 * MINUTE),
      }),
    ).toBeNull();
    expect(
      canStartAttempt({
        createdAt: CREATED,
        attempts: 8,
        nextAttemptAt: at(23 * HOUR + 56 * MINUTE),
        now: new Date(at(23 * HOUR + 58 * MINUTE)),
      }),
    ).toBe('expired');
    expect(
      canStartAttempt({
        createdAt: CREATED,
        attempts: 7,
        nextAttemptAt: at(23 * HOUR + 56 * MINUTE),
        now: new Date(at(23 * HOUR + 58 * MINUTE)),
      }),
    ).toBe('start');
  });

  it('refuses a start at or after the deadline', () => {
    const due = at(23 * HOUR + 55 * MINUTE);
    for (const now of [24 * HOUR, 24 * HOUR + 1, 30 * HOUR]) {
      expect(
        canStartAttempt({
          createdAt: CREATED,
          attempts: 7,
          nextAttemptAt: due,
          now: new Date(at(now)),
        }),
      ).toBe('expired');
    }
    expect(
      canStartAttempt({
        createdAt: CREATED,
        attempts: 7,
        nextAttemptAt: due,
        now: new Date(at(24 * HOUR - 1)),
      }),
    ).toBe('start');
  });

  it('expires instead of waiting for a due time at or past the deadline', () => {
    expect(
      canStartAttempt({
        createdAt: CREATED,
        attempts: 3,
        nextAttemptAt: at(24 * HOUR),
        now: new Date(at(20 * HOUR)),
      }),
    ).toBe('expired');
  });

  it('refuses malformed counters', () => {
    expect(() =>
      canStartAttempt({
        createdAt: CREATED,
        attempts: -1,
        nextAttemptAt: CREATED,
        now: new Date(CREATED),
      }),
    ).toThrow('Invalid notification schedule input');
    expect(() =>
      nextAttemptAt({ createdAt: CREATED, completedAttempts: 1.5, lastFinishedAt: CREATED }),
    ).toThrow('Invalid notification schedule input');
    expect(() =>
      canStartAttempt({
        createdAt: CREATED,
        attempts: 0,
        nextAttemptAt: CREATED,
        now: new Date(Number.NaN),
      }),
    ).toThrow('Invalid notification schedule input');
  });
});
