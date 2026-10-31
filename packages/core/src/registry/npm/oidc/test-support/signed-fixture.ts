const now = 1800000000;
const issuer = 'https://token.actions.githubusercontent.com';
const pair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);
export const jwk = {
  ...(await crypto.subtle.exportKey('jwk', pair.publicKey)),
  kid: 'key',
  alg: 'RS256',
  use: 'sig',
};
export const claims = {
  iss: issuer,
  aud: 'npm:registry.example.test',
  iat: now,
  nbf: now,
  exp: now + 300,
  repository_id: '123',
  repository_owner_id: '456',
  workflow_ref: 'owner/repo/.github/workflows/publish.yml@refs/tags/v1',
  ref: 'refs/tags/v1',
  event_name: 'push',
  jti: 'unique',
  repository_visibility: 'private',
};
export const b64 = (value: string | Uint8Array) => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
};
export async function token(
  payload: unknown = claims,
  header: unknown = { alg: 'RS256', typ: 'JWT', kid: 'key' },
) {
  const data = `${b64(typeof header === 'string' ? header : JSON.stringify(header))}.${b64(typeof payload === 'string' ? payload : JSON.stringify(payload))}`;
  return `${data}.${b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data))))}`;
}
