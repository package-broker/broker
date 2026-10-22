import { describe, expect, it } from 'vitest';
import { setAccessContext } from '../authz/access-context.js';
import type { AccessContextSnapshot } from '../authz/access-context.js';
import { fenceKind } from '../authz/fence.js';
import type { Principal, RequestContext } from '../plugin.js';
import { importWriteTokenFence } from './import-token-fence.js';

function context(principal: Principal | null): RequestContext {
  return Object.freeze({
    request: new Request('https://broker.test/_pb/import-runs'),
    requestId: 'req-1',
    org: null,
    principal,
    projectId: null,
    params: Object.freeze({}),
    ports: Object.freeze({}),
  }) as unknown as RequestContext;
}

const tokenSnapshot = (token: Record<string, unknown>, principal: Principal) =>
  ({
    principal,
    projectId: null,
    boundary: 'organization',
    sessionId: null,
    token,
    actor: null,
    rateKey: {
      stage: 'authenticated',
      tokenSelector: 'abcdefghijkl',
      principalId: principal.id,
      routeClass: 'organization',
    },
  }) as unknown as AccessContextSnapshot;

describe('importWriteTokenFence', () => {
  it('mints an import write fence for the authenticated token', async () => {
    const principal: Principal = { kind: 'service', id: 'svc-1' };
    const ctx = context(principal);
    setAccessContext(
      ctx,
      tokenSnapshot({ id: 'tok-1', kind: 'svc', scope: 'write', readOnly: false }, principal),
    );
    const fence = await importWriteTokenFence(ctx);
    expect(fenceKind(fence)).toBe('token');
    expect(fence).toMatchObject({
      tokenId: 'tok-1',
      tokenKind: 'svc',
      principalId: 'svc-1',
      permission: 'org:import:write',
      expected: {},
    });
  });

  it('refuses a request without a token actor', async () => {
    await expect(importWriteTokenFence(context(null))).rejects.toThrow(TypeError);
  });

  it('refuses a token whose kind does not match its principal', async () => {
    const principal: Principal = { kind: 'service', id: 'svc-1' };
    const ctx = context(principal);
    setAccessContext(
      ctx,
      tokenSnapshot({ id: 'tok-1', kind: 'pat', scope: 'write', readOnly: false }, principal),
    );
    await expect(importWriteTokenFence(ctx)).rejects.toThrow(TypeError);
  });
});
