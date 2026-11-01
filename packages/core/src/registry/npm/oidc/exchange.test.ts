import { describe, expect, it, vi } from 'vitest';
import { ulid, fixedClock } from '../../../ids.js';
import { orgContext } from '../../../db/port.js';
import type { RequestContext } from '../../../plugin.js';
import { createOidcExchangeRoute } from './exchange.js';
import type { TrustedPublisherBinding } from '../../../db/oidc.js';
import { OidcError, type VerifiedOidcClaims } from './verify.js';
const now = '2026-10-31T12:00:00.000Z';
const claims: VerifiedOidcClaims = {
  issuer: 'https://token.actions.githubusercontent.com',
  jti: 'unique',
  expiresAt: 1793448300,
  repositoryId: '123',
  repositoryOwnerId: '456',
  repository: 'owner/repo',
  workflow: 'publish.yml',
  environment: '',
  ref: 'refs/tags/v1',
  eventName: 'push',
  repositoryVisibility: 'private',
};
const publisher: TrustedPublisherBinding = {
  id: 'publisher',
  packageName: '@scope/test',
  servicePrincipalId: 'principal',
  refPattern: null,
  revision: 1,
  repositoryId: '123',
  repositoryOwnerId: '456',
  workflow: 'publish.yml',
  environment: '',
};
function setup() {
  const verify = vi.fn(async () => claims);
  const appendTo = vi.fn((batch) => batch);
  const reserveStatements = vi.fn(() => ({ appendTo }));
  const find = vi.fn(async () => [publisher]);
  const issueWorkload = vi.fn(async () => ({
    status: 'issued' as const,
    token: 'opaque-token',
    created: now,
    expires: '2026-10-31T12:15:00.000Z',
  }));
  const organization = vi.fn(async () => orgContext('org'));
  const route = createOidcExchangeRoute({
    verify,
    repository: { find, reserveStatements },
    tokens: { issueWorkload },
    organization,
    clock: fixedClock(now),
  });
  const ctx = (authorization: string | null = 'Bearer signed.jwt.value', name = '@scope/test') =>
    ({
      request: new Request(
        'https://registry.test/-/npm/v1/oidc/token/exchange/package/%40scope%2Ftest',
        { method: 'POST', headers: authorization === null ? {} : { authorization } },
      ),
      requestId: ulid(),
      params: { name },
      org: null,
      principal: null,
      projectId: null,
      ports: {},
    }) as unknown as RequestContext;
  return { route, verify, find, reserveStatements, issueWorkload, organization, ctx };
}
describe('host-level OIDC exchange', () => {
  it('exchanges without a session, binds the verified publisher and returns the npm response', async () => {
    const h = setup();
    const ctx = h.ctx();
    const response = await h.route.handler(ctx);
    expect(h.route).toMatchObject({
      method: 'POST',
      path: '/-/npm/v1/oidc/token/exchange/package/:name',
      boundary: 'none',
      permission: null,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      token_type: 'oidc',
      token: 'opaque-token',
      created: now,
      expires: '2026-10-31T12:15:00.000Z',
    });
    expect(h.verify).toHaveBeenCalledWith('signed.jwt.value', Date.parse(now));
    expect(h.reserveStatements).toHaveBeenCalledWith(orgContext('org'), {
      issuer: claims.issuer,
      jti: claims.jti,
      trustedPublisherId: 'publisher',
      expectedRevision: 1,
      expiresAt: claims.expiresAt,
      now,
    });
    expect(h.issueWorkload).toHaveBeenCalledWith(
      orgContext('org'),
      { publisher, replay: expect.any(Object) },
      expect.objectContaining({
        requestId: ctx.requestId,
        changes: expect.objectContaining({
          repository_visibility: { new: 'private' },
          package: { new: '@scope/test' },
        }),
      }),
    );
  });
  it.each([null, 'Basic secret', 'Bearer ', 'Bearer ' + 'a'.repeat(8193), 'Bearer a b'])(
    'refuses malformed authorization %s before verification',
    async (authorization) => {
      const h = setup();
      const response = await h.route.handler(h.ctx(authorization));
      expect(response.status).toBe(401);
      expect(h.verify).not.toHaveBeenCalled();
      expect(h.issueWorkload).not.toHaveBeenCalled();
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );
  it.each([
    'invalid_oidc_token',
    'jwks_unavailable',
    'no_trusted_publisher',
    'ambiguous_trusted_publisher',
  ] as const)('maps %s without leaking claims', async (code) => {
    const h = setup();
    h.verify.mockRejectedValue(new OidcError(code));
    const response = await h.route.handler(h.ctx());
    expect(response.status).toBe(
      code === 'ambiguous_trusted_publisher'
        ? 409
        : code === 'jwks_unavailable'
          ? 503
          : code === 'invalid_oidc_token'
            ? 401
            : 403,
    );
    expect(await response.text()).not.toContain('signed.jwt');
    expect(h.issueWorkload).not.toHaveBeenCalled();
  });
  it('refuses invalid names before verification', async () => {
    const h = setup();
    const response = await h.route.handler(h.ctx(undefined, 'UPPER'));
    expect(response.status).toBe(400);
    expect(h.verify).not.toHaveBeenCalled();
  });
  it('refuses absent organization', async () => {
    const h = setup();
    h.organization.mockResolvedValue(null!);
    expect((await h.route.handler(h.ctx())).status).toBe(404);
    expect(h.issueWorkload).not.toHaveBeenCalled();
  });
  it('refuses ambiguous bindings', async () => {
    const h = setup();
    h.find.mockResolvedValue([publisher, { ...publisher, id: 'other' }]);
    expect((await h.route.handler(h.ctx())).status).toBe(409);
    expect(h.issueWorkload).not.toHaveBeenCalled();
  });
  it('refuses a ref mismatch', async () => {
    const h = setup();
    h.find.mockResolvedValue([{ ...publisher, refPattern: 'refs/heads/main' }]);
    expect((await h.route.handler(h.ctx())).status).toBe(403);
    expect(h.issueWorkload).not.toHaveBeenCalled();
  });
  it('refuses failed issuance without returning a token', async () => {
    const h = setup();
    h.issueWorkload.mockResolvedValue({ status: 'refused' } as never);
    const response = await h.route.handler(h.ctx());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('opaque-token');
  });
  it('maps selector exhaustion to unavailable', async () => {
    const h = setup();
    h.issueWorkload.mockResolvedValue({ status: 'refused', reason: 'selector_collision' } as never);
    const response = await h.route.handler(h.ctx());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'unavailable' });
  });
  it('maps unexpected errors to a fixed unavailable response', async () => {
    const h = setup();
    h.verify.mockRejectedValue(new Error('secret@example.test'));
    const response = await h.route.handler(h.ctx());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret');
  });
});
