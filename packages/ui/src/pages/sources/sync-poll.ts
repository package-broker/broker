export const SYNC_POLL_INTERVAL_MS = 2_000;
export const SYNC_POLL_ATTEMPTS = 15;
const PENDING_POLL_MAX_MS = 600_000;
const PENDING_POLL_MAX_INTERVAL_MS = 30_000;

type SyncStatus = {
  sync?: {
    generation: string;
    listing: boolean;
    queued: number;
    running: number;
    retrying?: number;
  };
  status: string;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export function syncStatusChanged(before: SyncStatus, after: SyncStatus) {
  return (
    before.sync?.generation !== after.sync?.generation ||
    before.status !== after.status ||
    before.lastPolledAt !== after.lastPolledAt ||
    before.lastSuccessAt !== after.lastSuccessAt ||
    before.lastError !== after.lastError
  );
}

export function syncPollResult(before: SyncStatus, after: SyncStatus): boolean | 'pending' {
  if (
    after.sync &&
    (after.sync.listing || after.sync.queued + after.sync.running + (after.sync.retrying ?? 0) > 0)
  )
    return 'pending';
  return syncStatusChanged(before, after);
}

export function pollSync(
  refresh: () => Promise<boolean | 'pending'>,
  visibility:
    | Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>
    | undefined = typeof document === 'undefined' ? undefined : document,
) {
  const expiresAt = Date.now() + PENDING_POLL_MAX_MS;
  let stopped = false;
  let attempts = 0;
  let pending = false;
  let interval = SYNC_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout>;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    visibility?.removeEventListener('visibilitychange', changed);
  };
  const changed = () => {
    if (visibility?.hidden) stop();
  };
  const schedule = () => {
    if (
      stopped ||
      visibility?.hidden ||
      Date.now() >= expiresAt ||
      (!pending && attempts >= SYNC_POLL_ATTEMPTS)
    ) {
      stop();
      return;
    }
    timer = setTimeout(() => {
      if (stopped || visibility?.hidden || Date.now() >= expiresAt) {
        stop();
        return;
      }
      attempts++;
      void refresh().then((complete) => {
        if (complete === 'pending') {
          pending = true;
          interval = Math.min(interval * 2, PENDING_POLL_MAX_INTERVAL_MS);
        }
        if (complete === true) stop();
        else schedule();
      }, stop);
    }, interval);
  };
  const deadline = setTimeout(stop, PENDING_POLL_MAX_MS);
  visibility?.addEventListener('visibilitychange', changed);
  schedule();
  return stop;
}
