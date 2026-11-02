import { describe, expect, it } from 'vitest';
import { catalogueEntry } from '../../test-support/registry-policy-catalogue.js';
import { composerEntry, policyHttp } from '../../test-support/policy-registry-http.js';
import { policyRule } from '../../test-support/registry-policy-session.js';
import {
  RegistryPolicyBoundError,
  RegistryPolicyChangedError,
  RegistryPolicyDeniedError,
  RegistryPolicyUnavailableError,
} from './errors.js';
import {
  governDistHeaders,
  POLICY_DIST_CACHE_CONTROL,
  POLICY_ERROR_CACHE_CONTROL,
  POLICY_METADATA_CACHE_CONTROL,
  policyErrorResponse,
} from './http.js';

const REQUEST_ID = '01J0R0000000000000000000R1';

describe('policy cache headers and fixed responses', () => {
  it('a request-wide denial is the fixed 403 in both envelopes, never stored', async () => {
    const nested = policyErrorResponse(new RegistryPolicyDeniedError(), REQUEST_ID)!;
    expect(nested.status).toBe(403);
    expect(await nested.json()).toEqual({
      error: {
        code: 'policy_denied',
        message: 'Package access denied by policy',
        requestId: REQUEST_ID,
      },
    });
    const npm = policyErrorResponse(new RegistryPolicyDeniedError(), REQUEST_ID, 'npm')!;
    expect(await npm.json()).toEqual({
      error: 'Package access denied by policy',
      code: 'policy_denied',
      requestId: REQUEST_ID,
    });
    for (const response of [nested, npm]) {
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
      expect(response.headers.has('retry-after')).toBe(false);
    }
  });

  it('unavailable, bound and an escaped change are the fixed 503 with Retry-After 5', async () => {
    for (const error of [
      new RegistryPolicyUnavailableError(),
      new RegistryPolicyBoundError(),
      new RegistryPolicyChangedError(),
    ]) {
      const response = policyErrorResponse(error, REQUEST_ID, 'npm')!;
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(response.headers.get('cache-control')).toBe(POLICY_ERROR_CACHE_CONTROL);
      expect(await response.json()).toEqual({
        error: 'Package policy is unavailable',
        code: 'policy_unavailable',
        requestId: REQUEST_ID,
      });
    }
  });

  it('any other error is not a policy response', () => {
    expect(policyErrorResponse(new Error('Package policy is unavailable'), REQUEST_ID)).toBeNull();
    expect(policyErrorResponse('policy_denied', REQUEST_ID)).toBeNull();
  });

  it('governed dist and metadata must be revalidated; nothing is public or immutable', () => {
    const headers = governDistHeaders(
      new Headers({ 'Cache-Control': 'private, max-age=31536000, immutable' }),
    );
    expect(headers.get('cache-control')).toBe(POLICY_DIST_CACHE_CONTROL);
    for (const value of [
      POLICY_DIST_CACHE_CONTROL,
      POLICY_METADATA_CACHE_CONTROL,
      POLICY_ERROR_CACHE_CONTROL,
    ]) {
      expect(value).toMatch(/^private, no-(cache|store)$/);
    }
  });

  it('no governed metadata response or policy error can be stored by a shared cache', async () => {
    const npm = catalogueEntry(3);
    npm.tags = { latest: 'V0002' };
    const block = policyRule('01J0P0000000000000000000B1', { members: ['1.0.2'] });
    const http = policyHttp({ entries: [npm, composerEntry(2)], rules: [block] });
    const responses = [
      await http.npmGet('/left-pad'),
      await http.npmGet('/left-pad/1.0.1'),
      await http.npmGet('/left-pad/1.0.2'),
      await http.npmGet('/-/package/left-pad/dist-tags'),
      await http.npmGet('/-/v1/search?text=pad'),
      await http.composerGet('/packages.json'),
      await http.composerGet('/p2/acme/lib.json'),
    ];
    http.policy.policy.state.fail = true;
    responses.push(await http.npmGet('/left-pad'), await http.composerGet('/p2/acme/lib.json'));
    for (const response of responses) {
      const value = response.headers.get('cache-control') ?? '';
      expect(value, String(response.status)).not.toMatch(/public|immutable|s-maxage|max-age/);
    }
  });
});
