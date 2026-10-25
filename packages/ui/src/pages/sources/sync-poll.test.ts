import { afterEach, expect, it, vi } from 'vitest';
import { pollSync, SYNC_POLL_ATTEMPTS, SYNC_POLL_INTERVAL_MS } from './sync-poll.js';

afterEach(() => vi.useRealTimers());

it('stops polling when the refreshed status changes', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  pollSync(refresh);
  await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 30);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('caps attempts while status remains unchanged', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(false);
  pollSync(refresh);
  await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 30);
  expect(refresh).toHaveBeenCalledTimes(SYNC_POLL_ATTEMPTS);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])('does not poll hidden tabs, initially hidden: %s', async (hidden) => {
  vi.useFakeTimers();
  const target = new EventTarget();
  const visibility = Object.assign(target, { hidden });
  const refresh = vi.fn().mockResolvedValue(false);
  pollSync(refresh, visibility);
  visibility.hidden = true;
  visibility.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 30);
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels on disposal and does not reschedule an in-flight request', async () => {
  vi.useFakeTimers();
  let finish!: (complete: boolean) => void;
  const refresh = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = pollSync(refresh);
  await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS);
  stop();
  finish(false);
  await vi.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 30);
  expect(refresh).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
