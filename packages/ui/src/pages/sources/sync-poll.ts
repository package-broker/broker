export const SYNC_POLL_INTERVAL_MS = 2_000;
export const SYNC_POLL_ATTEMPTS = 15;

type SyncStatus = {
  status: string;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export function syncStatusChanged(before: SyncStatus, after: SyncStatus) {
  return (
    before.status !== after.status ||
    before.lastPolledAt !== after.lastPolledAt ||
    before.lastSuccessAt !== after.lastSuccessAt ||
    before.lastError !== after.lastError
  );
}

export function pollSync(
  refresh: () => Promise<boolean>,
  visibility:
    | Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>
    | undefined = typeof document === 'undefined' ? undefined : document,
) {
  let stopped = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout>;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    visibility?.removeEventListener('visibilitychange', changed);
  };
  const changed = () => {
    if (visibility?.hidden) stop();
  };
  const schedule = () => {
    if (stopped || visibility?.hidden || attempts >= SYNC_POLL_ATTEMPTS) {
      stop();
      return;
    }
    timer = setTimeout(() => {
      if (stopped || visibility?.hidden) {
        stop();
        return;
      }
      attempts++;
      void refresh().then((complete) => {
        if (complete) stop();
        else schedule();
      }, stop);
    }, SYNC_POLL_INTERVAL_MS);
  };
  visibility?.addEventListener('visibilitychange', changed);
  schedule();
  return stop;
}
