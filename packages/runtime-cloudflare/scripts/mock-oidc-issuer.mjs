import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

const DISCOVERY = '/.well-known/openid-configuration';

export const MOCK_CLIENT_ID = 'package-broker-smoke';

export function discoveryDocument(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
  };
}

export function mockIssuerResponse(origin, method, pathname) {
  if (method !== 'GET') return { status: 405, body: null };
  if (pathname.endsWith(DISCOVERY)) {
    const prefix = pathname.slice(0, -DISCOVERY.length);
    return { status: 200, body: discoveryDocument(`${origin}${prefix}`) };
  }
  if (pathname.endsWith('/jwks')) return { status: 200, body: { keys: [] } };
  return { status: 404, body: null };
}

export function startMockIssuer() {
  const requests = [];
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://mock.invalid');
    requests.push({ method: request.method, pathname });
    const { status, body } = mockIssuerResponse(origin, request.method, pathname);
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    response.end(body === null ? '' : JSON.stringify(body));
  });
  let origin;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        origin,
        requests,
        issuer: (path) => `${origin}${path}`,
        authorizationEndpoint: (path) => `${origin}${path}/authorize`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

export function secretName(id) {
  return `PB_IDP_${id.toUpperCase().replaceAll('-', '_')}_CLIENT_SECRET`;
}

export function runtimeProviderSettings(id, issuer) {
  return {
    PB_IDP_PROVIDERS: JSON.stringify([
      {
        id,
        kind: 'oidc',
        displayName: `Smoke ${id}`,
        issuer,
        clientId: MOCK_CLIENT_ID,
        policy: { verifiedDomains: ['smoke.test'], autoJoin: false },
      },
    ]),
    [secretName(id)]: `smoke-secret-${id}`,
  };
}

export function assertProviderListing(listing, { present, absent = [] }) {
  assert.ok(
    listing !== null && typeof listing === 'object' && Array.isArray(listing.providers),
    'the providers listing must carry a providers array',
  );
  const ids = listing.providers.map((provider) => provider.id);
  for (const id of present) assert.ok(ids.includes(id), `provider ${id} must be listed`);
  for (const id of absent) assert.ok(!ids.includes(id), `provider ${id} must not be listed`);
  return ids;
}

export function assertStartRedirect({ status, location }, { authorizationEndpoint, callbackUrl }) {
  assert.equal(status, 303, 'SSO start must answer a 303 redirect');
  assert.equal(typeof location, 'string', 'SSO start must answer a Location header');
  const url = new URL(location);
  assert.equal(
    `${url.origin}${url.pathname}`,
    authorizationEndpoint,
    'SSO start must redirect to the mock authorization endpoint',
  );
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), MOCK_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), callbackUrl);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('state'), 'SSO start must carry a state');
}

export function assertDiscovered(requests, path) {
  assert.ok(
    requests.some(({ method, pathname }) => method === 'GET' && pathname === `${path}${DISCOVERY}`),
    `the broker must fetch discovery for ${path}`,
  );
}

export async function digestFiles(directory, names) {
  const files = {};
  const all = createHash('sha256');
  for (const name of [...names].sort()) {
    const bytes = await readFile(join(directory, name));
    files[name] = createHash('sha256').update(bytes).digest('hex');
    all.update(`${name}\0${files[name]}\n`);
  }
  return { files, combined: all.digest('hex') };
}
