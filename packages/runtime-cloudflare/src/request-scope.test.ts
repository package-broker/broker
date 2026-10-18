import { describe, expect, it } from 'vitest';
import { createRequestScopes } from './request-scope.js';

describe('createRequestScopes', () => {
  it('refuses to track outside any request', () => {
    const scopes = createRequestScopes();
    expect(scopes.track(Promise.resolve())).toBe(false);
  });

  it('tracks into the scope of the calling async context, not the latest one', async () => {
    const scopes = createRequestScopes();
    let releaseA = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let settledA = false;
    let tracked = false;
    const a = scopes.run(async (scope) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      tracked = scopes.track(held);
      void scope.settle().then(() => {
        settledA = true;
      });
    });
    const b = scopes.run(async (scope) => {
      await scope.settle();
    });
    await Promise.all([a, b]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tracked).toBe(true);
    expect(settledA).toBe(false);
    releaseA();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settledA).toBe(true);
  });

  it('settles over a rejected tracked promise and then refuses further work', async () => {
    const scopes = createRequestScopes();
    await scopes.run(async (scope) => {
      expect(scopes.track(Promise.reject(new Error('boom')))).toBe(true);
      await expect(scope.settle()).resolves.toBeUndefined();
      expect(scopes.track(Promise.resolve())).toBe(false);
    });
  });
});
