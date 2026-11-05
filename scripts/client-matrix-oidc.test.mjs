import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { test } from 'node:test';
import { matrixJwks, matrixOidcToken } from './client-matrix-oidc.mjs';

test('runtime OIDC fixture has a real RS256 signature and hostname audience', () => {
  const [header, payload, signature] = matrixOidcToken('http://127.0.0.1:1234').split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.aud, 'npm:127.0.0.1');
  assert.equal(claims.exp - claims.iat, 300);
  const key = createPublicKey({ key: matrixJwks.keys[0], format: 'jwk' });
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      key,
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.altered`),
      key,
      Buffer.from(signature, 'base64url'),
    ),
    false,
  );
});

test('runtime OIDC fixture passes the production verifier', async () => {
  const { verifyOidcToken, clearJwksCache } =
    await import('../packages/core/dist/registry/npm/oidc/verify.js');
  clearJwksCache();
  const publicUrl = 'http://127.0.0.1:1234';
  const result = await verifyOidcToken(matrixOidcToken(publicUrl), {
    publicUrl,
    now: Date.now(),
    policyFetch: async () => ({
      status: 200,
      headers: new Headers(),
      body: new Response(JSON.stringify(matrixJwks)).body,
    }),
  });
  assert.equal(result.repositoryId, '123');
  assert.equal(result.workflow, 'publish.yml');
});
