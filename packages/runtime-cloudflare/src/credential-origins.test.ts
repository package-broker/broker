import { expect, it } from 'vitest';

it('binds GitHub VCS bearer credentials to exactly the API origin', async () => {
  const { credentialOrigins } = await import('./index.js');
  const { bindCredential, parseCredentialMaterial } =
    await import('@package-broker/core/sources/credentials');
  const origins = credentialOrigins(
    {
      type: 'vcs',
      ecosystem: 'composer',
      url: null,
      credentialId: 'token',
      configJson: JSON.stringify({ provider: 'github', repository: 'owner/repo' }),
    } as import('@package-broker/core/db/source').SourceRecord,
    {
      runtime: 'cloudflare',
      selfOrigins: [],
      allowPrivateHosts: [],
    },
  );
  expect(origins).toEqual(['https://api.github.com']);
  const credential = bindCredential(
    parseCredentialMaterial('bearer', JSON.stringify({ token: 'ghp_private-sentinel' })),
    origins!,
  );
  expect(credential.origins).toEqual(['https://api.github.com']);
  const headers = credential.apply(
    new Headers(),
    new URL('https://codeload.github.com/owner/repo'),
  ).headers;
  expect(headers.has('authorization')).toBe(false);
});
