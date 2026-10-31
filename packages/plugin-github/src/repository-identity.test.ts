import { expect, it, vi } from 'vitest';
import { lookupRepositoryIdentity } from './repository-identity.js';
import type { PolicyFetch, UpstreamCredential } from '@package-broker/core/plugin';
const credential: UpstreamCredential = {
  origins: ['https://api.github.com'],
  queryParams: [],
  apply: (headers, url) => {
    headers.set('authorization', 'Bearer test-secret');
    return { headers, url };
  },
};
const fetcher = (data: unknown, status = 200) =>
  vi.fn<PolicyFetch>().mockResolvedValue({
    status,
    headers: new Headers(),
    body: new Response(JSON.stringify(data)).body,
  });
it('requires configured authentication and never performs trust-on-first-use', async () => {
  const fetch = fetcher({ id: 123, owner: { id: 456 }, full_name: 'owner/repo' });
  expect(await lookupRepositoryIdentity(fetch, null, 'owner/repo')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it('fetches numeric repository and owner IDs with bounded authenticated GitHub requests', async () => {
  const fetch = fetcher({ id: 123, owner: { id: 456 }, full_name: 'Owner/Repo' });
  expect(await lookupRepositoryIdentity(fetch, credential, 'owner/repo')).toEqual({
    repository: 'owner/repo',
    repositoryId: '123',
    repositoryOwnerId: '456',
  });
  expect(fetch).toHaveBeenCalledWith(
    expect.objectContaining({
      credential,
      maxBytes: 65536,
      redirects: 'error',
      url: 'https://api.github.com/repos/owner/repo',
    }),
  );
});
it.each([
  { id: 0, owner: { id: 456 }, full_name: 'owner/repo' },
  { id: Number.MAX_SAFE_INTEGER + 1, owner: { id: 456 }, full_name: 'owner/repo' },
  { id: 123, owner: { id: -1 }, full_name: 'owner/repo' },
  { id: 123, owner: { id: 456 }, full_name: 'other/repo' },
])('refuses invalid or mismatched identities without echoing upstream content', async (data) => {
  await expect(lookupRepositoryIdentity(fetcher(data), credential, 'owner/repo')).rejects.toThrow(
    'invalid_repository_identity',
  );
});
it('refuses upstream failures with a fixed error', async () => {
  await expect(
    lookupRepositoryIdentity(fetcher({ secret: 'test-secret' }, 403), credential, 'owner/repo'),
  ).rejects.toThrow('repository_lookup_failed');
});
