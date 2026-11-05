import {
  GITHUB_API_VERSION,
  type PolicyFetch,
  type UpstreamCredential,
} from '@package-broker/core/plugin';
const API = 'https://api.github.com';
export async function lookupRepositoryIdentity(
  fetch: PolicyFetch,
  credential: UpstreamCredential | null,
  repository: string,
) {
  if (credential === null) return null;
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repository))
    throw new Error('invalid_repository_identity');
  const authorization = credential.apply(new Headers(), new URL(API)).headers.get('authorization');
  if (authorization === null || !authorization.startsWith('Bearer ')) return null;
  const response = await fetch({
    url: `${API}/repos/${repository}`,
    method: 'GET',
    purpose: 'api',
    credential,
    destinations: [API],
    redirects: 'error',
    maxBytes: 65536,
    timeoutMs: 30_000,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': GITHUB_API_VERSION },
  });
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('repository_lookup_failed');
  }
  let value: unknown;
  try {
    value = await new Response(response.body).json();
  } catch {
    throw new Error('invalid_repository_identity');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    !('owner' in value) ||
    typeof value.owner !== 'object' ||
    value.owner === null ||
    !('id' in value.owner) ||
    typeof value.owner.id !== 'number' ||
    !Number.isSafeInteger(value.owner.id) ||
    value.owner.id < 1 ||
    !('full_name' in value) ||
    typeof value.full_name !== 'string' ||
    value.full_name.toLowerCase() !== repository.toLowerCase()
  )
    throw new Error('invalid_repository_identity');
  return {
    repository: repository.toLowerCase(),
    repositoryId: String(value.id),
    repositoryOwnerId: String(value.owner.id),
  };
}
