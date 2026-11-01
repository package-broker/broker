import { generateKeyPairSync, sign } from 'node:crypto';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const matrixJwks = {
  keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'matrix', alg: 'RS256', use: 'sig' }],
};

export function matrixOidcToken(origin, jti = 'matrix-exchange') {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'matrix' })}.${encode({
    iss: 'https://token.actions.githubusercontent.com',
    aud: `npm:${new URL(origin).hostname}`,
    iat: now,
    nbf: now,
    exp: now + 300,
    jti,
    repository_id: '123',
    repository_owner_id: '456',
    workflow_ref: 'fixture/repository/.github/workflows/publish.yml@refs/tags/v1',
    ref: 'refs/tags/v1',
    event_name: 'push',
    repository_visibility: 'private',
  })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
