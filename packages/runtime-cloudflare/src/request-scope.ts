import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestScope {
  /** Resolves once every promise tracked in this scope has settled, including ones added meanwhile. */
  settle(): Promise<void>;
}

export interface RequestScopes {
  run<T>(work: (scope: RequestScope) => Promise<T>): Promise<T>;
  /** Attaches to the scope of the request whose async context calls it; false when there is none. */
  track(promise: Promise<unknown>): boolean;
}

interface Scope extends RequestScope {
  readonly pending: Set<Promise<void>>;
  closed: boolean;
}

/**
 * The engine's deferred dispatch is fixed when the application is built and receives no request,
 * so the request is recovered from the async context (`nodejs_compat` in wrangler.toml).
 */
export function createRequestScopes(): RequestScopes {
  const storage = new AsyncLocalStorage<Scope>();
  return {
    run(work) {
      const scope: Scope = {
        pending: new Set(),
        closed: false,
        async settle() {
          while (scope.pending.size > 0) await Promise.all([...scope.pending]);
          scope.closed = true;
        },
      };
      return storage.run(scope, () => work(scope));
    },
    track(promise) {
      const settled = promise.then(
        () => undefined,
        () => undefined,
      );
      const scope = storage.getStore();
      if (scope === undefined || scope.closed) return false;
      scope.pending.add(settled);
      void settled.then(() => scope.pending.delete(settled));
      return true;
    },
  };
}
