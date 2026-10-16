import type { OrgContext } from '../db/port.js';

export const ACCESS_FLUSH_IDS = 200;
export const ACCESS_FLUSH_INTERVAL_MS = 60_000;
export const ACCESS_MAX_PENDING = 2 * ACCESS_FLUSH_IDS;

export interface AccessRecorderOptions {
  touch(ctx: OrgContext, blobIds: readonly string[]): Promise<unknown>;
  defer(thunk: () => Promise<void>): void;
  now(): number;
  onError(): void;
  maxPending?: number;
}

export interface AccessRecorder {
  record(ctx: OrgContext, blobId: string): void;
  flush(): Promise<void>;
}

export function createAccessRecorder(options: AccessRecorderOptions): AccessRecorder {
  const maxPending = options.maxPending ?? ACCESS_MAX_PENDING;
  let pending = new Map<string, { ctx: OrgContext; ids: Set<string> }>();
  let size = 0;
  let lastFlush = 0;
  let started = false;
  let scheduled = false;
  let overflowed = false;

  function failed(): void {
    try {
      options.onError();
    } catch {
      return;
    }
  }

  function clock(): number {
    try {
      return options.now();
    } catch {
      return lastFlush;
    }
  }

  async function flush(): Promise<void> {
    try {
      const batches = pending;
      pending = new Map();
      size = 0;
      scheduled = false;
      overflowed = false;
      lastFlush = clock();
      for (const { ctx, ids } of batches.values()) {
        const all = [...ids];
        for (let start = 0; start < all.length; start += ACCESS_FLUSH_IDS) {
          try {
            await options.touch(ctx, all.slice(start, start + ACCESS_FLUSH_IDS));
          } catch {
            failed();
          }
        }
      }
    } catch {
      failed();
    }
  }

  return {
    record(ctx, blobId) {
      try {
        if (typeof blobId !== 'string' || blobId === '') return;
        const now = clock();
        if (!started) {
          started = true;
          lastFlush = now;
        }
        let entry = pending.get(ctx.orgId);
        if (entry === undefined || !entry.ids.has(blobId)) {
          if (size >= maxPending) {
            if (!overflowed) {
              overflowed = true;
              failed();
            }
          } else {
            if (entry === undefined) {
              entry = { ctx, ids: new Set() };
              pending.set(ctx.orgId, entry);
            }
            entry.ids.add(blobId);
            size += 1;
          }
        }
        if (
          !scheduled &&
          (size >= ACCESS_FLUSH_IDS || now - lastFlush >= ACCESS_FLUSH_INTERVAL_MS)
        ) {
          scheduled = true;
          try {
            options.defer(flush);
          } catch {
            scheduled = false;
            failed();
          }
        }
      } catch {
        failed();
      }
    },
    flush,
  };
}
