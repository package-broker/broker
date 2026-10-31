import { matrixOidcToken } from './client-matrix-oidc.mjs';
import { isDeepStrictEqual } from 'node:util';
import { harnessAssert as assert, redactClientOutput } from './client-matrix.mjs';

export function normalizeEvidence(value) {
  if (Array.isArray(value)) return value.map(normalizeEvidence);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            ![
              'requestId',
              'opId',
              'created',
              'expires',
              'lastUsedAt',
              'createdAt',
              'updatedAt',
              'expiresAt',
              'decidedAt',
              'lastSyncedAt',
              'publishedAt',
              'tombstonedAt',
              'removedUpstreamAt',
              'requestedById',
              'decidedByUserId',
              'createdByUserId',
              'requestedByUserId',
              'tokenId',
              'routeProjectId',
              'sourceId',
              'versionId',
              'packageId',
              'servicePrincipalId',
              'projectId',
              'id',
            ].includes(key),
        )
        .map(([key, entry]) => [key, normalizeEvidence(entry)]),
    );
  return value;
}

export function assertRuntimeParity(node, worker, { debug = false, log = console.log } = {}) {
  if (debug && !isDeepStrictEqual(node, worker)) {
    const index =
      Array.isArray(node) && Array.isArray(worker)
        ? Array.from({ length: Math.max(node.length, worker.length) }, (_, i) => i).find(
            (i) => !isDeepStrictEqual(node[i], worker[i]),
          )
        : undefined;
    const left = index === undefined ? node : node[index];
    const right = index === undefined ? worker : worker[index];
    const route = left?.method ? left : right;
    const safe = (value) =>
      redactClientOutput(
        JSON.stringify(value, (key, entry) =>
          /token|secret|password|authorization|cookie|email|loginUrl|doneUrl/i.test(key)
            ? '[REDACTED]'
            : entry,
        ) ?? '[missing]',
      );
    log(
      `client-matrix: parity ${redactClientOutput(`${route?.method ?? '[missing]'} ${route?.path ?? '[missing]'}`)} node status=${safe(left?.status)} cloudflare status=${safe(right?.status)}`,
    );
    const diff = (a, b, path) => {
      if (isDeepStrictEqual(a, b)) return;
      if (
        path.some((key) =>
          /token|secret|password|authorization|cookie|email|loginUrl|doneUrl/i.test(key),
        )
      ) {
        log(`- node ${safe(path.join('.'))}: [REDACTED]`);
        log(`+ cloudflare ${safe(path.join('.'))}: [REDACTED]`);
      } else if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
          diff(a[key], b[key], [...path, key]);
      } else {
        const key = path.at(-1) ?? 'body';
        log(`- node ${safe(path.join('.'))}: ${safe({ [key]: a })}`);
        log(`+ cloudflare ${safe(path.join('.'))}: ${safe({ [key]: b })}`);
      }
    };
    diff(left?.body, right?.body, ['body']);
  }
  assert.ok(isDeepStrictEqual(node, worker), 'Runtime status/body parity failed');
}

export async function runApiGate(broker, origin) {
  const evidence = [];
  async function call(method, path, status, body, etag, authenticated = true, extraHeaders = {}) {
    const response = await broker.dispatch(
      new Request(origin + path, {
        method,
        headers: {
          ...(authenticated ? broker.browserHeaders(origin) : {}),
          ...(etag ? { 'if-match': etag } : {}),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    assert.equal(
      response.status,
      status,
      `API gate status: ${method} ${path.replace(/[0-7][0-9A-HJKMNP-TV-Z]{25}/g, ':id')}`,
    );
    const value = status === 204 ? null : await response.json();
    const publicValue = value?.token === undefined ? value : { ...value, token: '[token]' };
    evidence.push({
      method,
      path: path.replace(/[0-7][0-9A-HJKMNP-TV-Z]{25}/g, ':id'),
      status,
      body: normalizeEvidence(publicValue),
    });
    return { value, etag: response.headers.get('etag') };
  }
  const list = await call('GET', '/_pb/publishes', 200);
  list.value.items.sort((a, b) => a.packageName.localeCompare(b.packageName));
  evidence[0].body = normalizeEvidence(list.value);
  assert.equal(list.value.items.length, 2, 'Missing held publications');
  for (const [index, item] of list.value.items
    .sort((a, b) => a.packageName.localeCompare(b.packageName))
    .entries()) {
    const detail = await call('GET', `/_pb/publishes/${item.id}`, 200);
    const rescan = await call('POST', `/_pb/publishes/${item.id}/rescan`, 412, {}, detail.etag);
    assert.equal(rescan.value.error?.code, 'precondition_failed', 'Incorrect rescan error code');
    assert.equal(typeof rescan.value.error?.message, 'string', 'Missing rescan error message');
    assert.ok(rescan.value.error?.requestId, 'Missing rescan request ID');
    const action = index === 0 ? 'approve' : 'reject';
    const decided = await call(
      'POST',
      `/_pb/publishes/${item.id}/${action}`,
      200,
      action === 'approve' ? {} : { reason: 'Policy' },
      detail.etag,
    );
    assert.equal(
      decided.value.approvalState,
      index === 0 ? 'approved' : 'rejected',
      'Incorrect publish decision',
    );
    await call(
      'POST',
      `/_pb/publishes/${item.id}/${action}`,
      409,
      action === 'approve' ? {} : { reason: 'Policy' },
      detail.etag,
    );
  }
  const packages = await call('GET', '/_pb/projects/alpha/packages', 200);
  const published = packages.value.items.find((item) => item.name === 'matrix-publish-active');
  assert.ok(published, 'Published package missing from API');
  await call('GET', `/_pb/projects/alpha/packages/${published.id}/versions`, 200);
  const readme = await call('GET', `/_pb/projects/alpha/packages/${published.id}/readme`, 200);
  assert.ok(JSON.stringify(readme.value).includes('Publish fixture'), 'Published readme missing');
  const organizationPackages = await call('GET', '/_pb/packages', 200);
  const requestPackages = ['matrix-publish-active', '@matrix-publish/active'].map((name) =>
    organizationPackages.value.items.find((item) => item.name === name),
  );
  for (const item of requestPackages) {
    assert.ok(item, 'Request fixture package missing');
    await call('PATCH', `/_pb/packages/${item.id}/access`, 200, {
      visibleToNewProjects: false,
      newProjectAccessMode: 'request',
      revision: item.revision,
    });
  }
  await broker.prepareRequestProject();
  const requestable = await call('GET', '/_pb/projects/beta/requestable-packages', 200);
  assert.equal(requestable.value.items.length, 2, 'Requestable packages missing');
  for (const [index, item] of requestPackages.entries()) {
    const requested = await call('POST', '/_pb/projects/beta/package-access-requests', 201, {
      packageId: item.id,
    });
    const action = index === 0 ? 'approve' : 'reject';
    const result = await call(
      'POST',
      `/_pb/package-access-requests/${requested.value.id}/${action}`,
      200,
      action === 'approve' ? {} : { reason: 'Policy' },
      requested.etag,
    );
    assert.equal(
      result.value.state,
      index === 0 ? 'approved' : 'rejected',
      'Incorrect access decision',
    );
  }
  await call('GET', '/_pb/package-access-requests', 200);
  await call('GET', '/_pb/projects/alpha/requestable-packages', 200);
  await call('GET', '/_pb/trusted-publishers', 200);
  const trusted = {
    packageName: 'matrix-publish-active',
    repository: 'fixture/repository',
    workflow: 'publish.yml',
    environment: '',
  };
  await call('POST', '/_pb/trusted-publishers', 409, trusted);
  // The runtime fixture has no GitHub credentials: creation must fail closed on both targets.
  const missing = '00000000000000000000000000';
  await call('PUT', `/_pb/trusted-publishers/${missing}`, 409, trusted, '"r1"');
  await call('DELETE', `/_pb/trusted-publishers/${missing}`, 404, undefined, '"r1"');
  await call(
    'POST',
    '/-/npm/v1/oidc/token/exchange/package/matrix-publish-active',
    401,
    undefined,
    undefined,
    false,
  );
  const exchange = '/-/npm/v1/oidc/token/exchange/package/matrix-publish-active';
  const jwt = matrixOidcToken(origin);
  const exchanged = await call('POST', exchange, 201, undefined, undefined, false, {
    authorization: `Bearer ${jwt}`,
  });
  assert.ok(
    /^pb_svc_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/.test(exchanged.value.token),
    'Invalid workload token',
  );
  assert.equal(
    Date.parse(exchanged.value.expires) - Date.parse(exchanged.value.created),
    900000,
    'Incorrect workload lifetime',
  );
  await call('POST', exchange, 403, undefined, undefined, false, {
    authorization: `Bearer ${jwt}`,
  });
  await call('DELETE', `/_pb/trusted-publishers/${broker.oidcPublisherId}`, 204, undefined, '"r1"');
  await call('POST', exchange, 403, undefined, undefined, false, {
    authorization: `Bearer ${matrixOidcToken(origin, 'after-disable')}`,
  });
  return evidence;
}

export function assertIntegrationEvidence(evidence) {
  assert.equal(evidence.length, 2, 'Missing runtime integration evidence');
  for (const target of ['node', 'cloudflare']) {
    const result = evidence.find((item) => item.target === target);
    assert.ok(
      result && ['captured', 'refused'].includes(result.login),
      'Missing runtime login evidence',
    );
    assert.equal(result.routesVerified, true, 'Missing runtime route evidence');
  }
}
