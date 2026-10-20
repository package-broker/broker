import type { RequestContext } from '../plugin.js';

export interface ExecutionPort {
  waitUntil(promise: Promise<unknown>): void;
}

type WaitUntil = (promise: Promise<unknown>) => void;

const scheduled = new WeakMap<RequestContext, WaitUntil>();

function detach(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

export function setWaitUntil(ctx: RequestContext, waitUntil: WaitUntil): void {
  if (scheduled.has(ctx)) throw new TypeError('waitUntil is already set');
  scheduled.set(ctx, waitUntil);
}

export function waitUntilOf(ctx: RequestContext): WaitUntil {
  return scheduled.get(ctx) ?? detach;
}

export interface ExecutionTracker {
  bind(port: ExecutionPort | undefined, onRejected?: (error: unknown) => void): WaitUntil;
  idle(deadlineMs?: number): Promise<void>;
}

export function createExecutionTracker(): ExecutionTracker {
  const pending = new Set<Promise<unknown>>();
  return {
    bind(port, onRejected) {
      return (promise) => {
        const settled = promise.then(
          () => undefined,
          (error: unknown) => {
            try {
              onRejected?.(error);
            } catch {
              // Reporting must not turn into a second failure.
            }
          },
        );
        pending.add(settled);
        void settled.then(() => pending.delete(settled));
        try {
          port?.waitUntil(settled);
        } catch {
          // The runtime refused the work; the tracker still holds it for idle().
        }
      };
    },
    async idle(deadlineMs) {
      const drained = (async () => {
        while (pending.size > 0) await Promise.all([...pending]);
      })();
      if (deadlineMs === undefined) return drained;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      });
      try {
        await Promise.race([drained, expired]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
