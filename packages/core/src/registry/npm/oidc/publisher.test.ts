import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../../db/port.js';
import type { TrustedPublisherBinding } from '../../../db/oidc.js';
import type { VerifiedOidcClaims } from './verify.js';
import { findTrustedPublisher, matchesRef } from './publisher.js';
const claims: VerifiedOidcClaims = {
  issuer: 'https://token.actions.githubusercontent.com',
  jti: 'unique',
  expiresAt: 1800000300,
  repositoryId: '123',
  repositoryOwnerId: '456',
  repository: 'owner/repo',
  workflow: 'publish.yml',
  environment: '',
  ref: 'refs/tags/v1',
  eventName: 'push',
  repositoryVisibility: 'private',
};
const binding: TrustedPublisherBinding = {
  id: 'publisher',
  packageName: 'test',
  repositoryId: '123',
  repositoryOwnerId: '456',
  workflow: 'publish.yml',
  environment: '',
  servicePrincipalId: 'principal',
  revision: 1,
  refPattern: 'refs/tags/v*',
};
describe('trusted publisher selection', () => {
  it('looks up the full claim set in the organization and checks the ref', async () => {
    const find = vi.fn(async () => [binding]);
    const ctx = orgContext('org');
    expect(await findTrustedPublisher({ find }, ctx, 'test', claims)).toEqual(binding);
    expect(find).toHaveBeenCalledWith(ctx, {
      packageName: 'test',
      repositoryId: '123',
      repositoryOwnerId: '456',
      workflow: 'publish.yml',
      environment: '',
    });
  });
  it.each(
    [[], [binding, binding], [{ ...binding, refPattern: 'refs/heads/*' }]].map((rows) => ({
      rows,
    })),
  )('refuses absent, ambiguous or ref-mismatched publishers', async ({ rows }) => {
    await expect(
      findTrustedPublisher({ find: async () => rows }, orgContext('org'), 'test', claims),
    ).rejects.toMatchObject({
      code: rows.length > 1 ? 'ambiguous_trusted_publisher' : 'no_trusted_publisher',
    });
  });
  it.each(['Other', '../name', 'a'.repeat(215)])(
    'refuses invalid package names before lookup',
    async (name) => {
      const find = vi.fn(async () => [binding]);
      await expect(
        findTrustedPublisher({ find }, orgContext('org'), name, claims),
      ).rejects.toMatchObject({ code: 'invalid_oidc_token' });
      expect(find).not.toHaveBeenCalled();
    },
  );
  it('matches bounded literals, stars and single characters, with whole-ref anchoring', () => {
    expect(matchesRef(null, 'refs/tags/v1')).toBe(true);
    expect(matchesRef('refs/tags/v?', 'refs/tags/v1')).toBe(true);
    expect(matchesRef('refs/*/v*', 'refs/tags/v1')).toBe(true);
    expect(matchesRef('refs/tags/v?', 'refs/tags/v12')).toBe(false);
    expect(matchesRef('refs/tags/v1', 'other/refs/tags/v1')).toBe(false);
    expect(matchesRef('refs/heads/*', 'refs/tags/v1')).toBe(false);
  });
  it.each(['', 'refs/{heads,tags}/*', 'refs/[ab]/*', 'x'.repeat(256)])(
    'fails closed on unsupported or oversized patterns %j',
    (pattern) => {
      expect(() => matchesRef(pattern, 'refs/tags/v1')).toThrow('no_trusted_publisher');
    },
  );
  it('caps ref work before matching and handles adversarial stars in bounded space', () => {
    expect(() => matchesRef('*', 'a'.repeat(1025))).toThrow('no_trusted_publisher');
    expect(matchesRef('*a'.repeat(127) + '*', 'a'.repeat(1024))).toBe(true);
  });
});
