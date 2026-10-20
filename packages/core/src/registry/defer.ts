import { waitUntilOf } from '../kernel/execution.js';
import type { RequestContext } from '../plugin.js';

export function deferOf(ctx: RequestContext): (thunk: () => Promise<void>) => void {
  const waitUntil = waitUntilOf(ctx);
  return (thunk) => {
    waitUntil(Promise.resolve().then(thunk));
  };
}
