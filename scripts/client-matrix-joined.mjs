import { setTimeout as delay } from 'node:timers/promises';
import { harnessAssert as assert } from './client-matrix.mjs';
import { matrixOidcToken } from './client-matrix-oidc.mjs';

export const JOINED_JOURNEYS = Object.freeze([
  'approval-first',
  'scan-first',
  'failed-scan',
  'scan-only-failure',
  'workload',
  'repository-tag',
]);

export function assertJoinedEvidence(evidence) {
  for (const name of JOINED_JOURNEYS)
    assert.equal(evidence?.[name], true, `Missing joined journey: ${name}`);
}

export async function runJoinedJourneys({
  broker,
  origin,
  scanner,
  publish,
  install,
  repositoryTag,
}) {
  const evidence = {};
  const call = async (method, path, status, body, etag) => {
    const response = await broker.dispatch(
      new Request(origin + path, {
        method,
        headers: { ...broker.browserHeaders(origin), ...(etag ? { 'if-match': etag } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    assert.equal(response.status, status, 'Joined journey API status differs');
    return {
      value: [202, 204].includes(status) ? null : await response.json(),
      etag: response.headers.get('etag'),
    };
  };
  const configure = async (names, approval) => {
    const { value } = await call('POST', '/_pb/sources', 201, {
      name: approval ? 'Joined approval' : 'Joined scan only',
      ecosystem: 'npm',
      type: 'hosted',
      requirePublishApproval: approval,
      defaultVisibleToNewProjects: true,
    });
    for (const name of names)
      await call('POST', `/_pb/sources/${value.id}/names`, 201, { pattern: name });
    await call('POST', `/_pb/sources/${value.id}/enable`, 204);
    await call('PUT', `/_pb/projects/alpha/sources/${value.id}/attachment`, 204, {});
  };
  const names = JOINED_JOURNEYS.slice(0, 3).map((name) => `matrix-joined-${name}`);
  await configure(names, true);
  await configure(
    ['matrix-joined-scan-only-failure', 'matrix-joined-workload', 'matrix-joined-wrong-binding'],
    false,
  );
  const find = async (name) => {
    const { value } = await call('GET', '/_pb/publishes?limit=50', 200);
    const item = value.items.find((item) => item.packageName === name);
    assert.ok(item, 'Joined publication missing');
    return call('GET', `/_pb/publishes/${item.id}`, 200);
  };
  const wait = async (read, ready) => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      await broker.tick();
      const result = await read();
      if (ready(result)) return result;
      assert.ok(Date.now() < deadline, 'Joined journey timed out');
      await delay(250);
    }
  };
  const scanState = (name, state) =>
    wait(
      () => find(name),
      (item) => item.value.scanState === state,
    );
  const approve = async (name, state) => {
    const fresh = await find(name);
    assert.equal(fresh.value.scanState, state, 'Scan state changed before approval');
    assert.equal(fresh.value.scanAttempts, 1, 'Scan attempts changed before approval');
    return call('POST', `/_pb/publishes/${fresh.value.id}/approve`, 200, {}, fresh.etag);
  };

  for (const journey of JOINED_JOURNEYS.slice(0, 4)) {
    const name = `matrix-joined-${journey}`;
    scanner(name, 'hold');
    await publish(name, broker.publishToken);
    let item = await scanState(name, 'running');
    assert.equal(item.value.scanAttempts, 1, 'Scan did not start its first attempt');
    const runningEtag = item.etag;
    assert.equal(
      item.value.approvalState,
      journey === 'scan-only-failure' ? 'not_required' : 'pending',
      'Missing approval hold',
    );
    await install(name, false);
    if (journey !== 'scan-first' && journey !== 'scan-only-failure') {
      await approve(name, 'running');
      await install(name, false);
    }
    if (journey === 'failed-scan' || journey === 'scan-only-failure') {
      scanner(name, 'fail');
      item = await scanState(name, 'failed');
      assert.equal(item.value.scanAttempts, 3, 'Scan did not exhaust its attempts');
      assert.equal(
        item.value.approvalState,
        journey === 'failed-scan' ? 'approved' : 'not_required',
        'Failure lost approval state',
      );
      await install(name, false);
      await call('POST', `/_pb/publishes/${item.value.id}/rescan`, 412, {}, runningEtag);
      scanner(name, 'allow');
      await call('POST', `/_pb/publishes/${item.value.id}/rescan`, 200, {}, item.etag);
    } else scanner(name, 'allow');
    item = await scanState(name, 'allowed');
    if (journey === 'scan-first') {
      assert.equal(item.value.approvalState, 'pending', 'Scan bypassed approval');
      await install(name, false);
      await approve(name, 'allowed');
    }
    await install(name, true);
    evidence[journey] = true;
  }

  const repository = await call('POST', '/_pb/sources', 201, {
    name: 'Joined GitHub tag',
    ecosystem: 'npm',
    type: 'vcs',
    config: {
      provider: 'github',
      repository: 'fixture/repository',
      packageName: 'matrix-joined-repository',
      refs: { tags: true, branches: [] },
    },
    defaultVisibleToNewProjects: true,
  });
  const source = repository.value.id;
  await call('PUT', `/_pb/sources/${source}/credential`, 204, {
    kind: 'bearer',
    material: JSON.stringify({ token: 'matrix-github-fixture-token' }),
  });
  await call('POST', `/_pb/sources/${source}/names`, 201, { pattern: 'matrix-joined-repository' });
  await call('POST', `/_pb/sources/${source}/enable`, 204);
  await call('PUT', `/_pb/projects/alpha/sources/${source}/attachment`, 204, {});

  const binding = await call('POST', '/_pb/trusted-publishers', 201, {
    packageName: 'matrix-joined-workload',
    repository: 'fixture/repository',
    workflow: 'publish.yml',
    environment: '',
  });
  const exchange = async (jti, status) => {
    const response = await broker.dispatch(
      new Request(`${origin}/-/npm/v1/oidc/token/exchange/package/matrix-joined-workload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${matrixOidcToken(origin, jti)}` },
      }),
    );
    assert.equal(response.status, status, 'Joined workload exchange status differs');
    return response.json();
  };
  const workload = await exchange('joined-workload', 201);
  assert.ok(
    /^pb_svc_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/.test(workload.token),
    'Invalid joined workload token',
  );
  await exchange('joined-workload', 403);
  await publish('matrix-joined-wrong-binding', workload.token, false);
  scanner('matrix-joined-workload', 'hold');
  await publish('matrix-joined-workload', workload.token);
  await install('matrix-joined-workload', false);
  scanner('matrix-joined-workload', 'allow');
  await scanState('matrix-joined-workload', 'allowed');
  await install('matrix-joined-workload', true);
  await call('DELETE', `/_pb/trusted-publishers/${binding.value.id}`, 204, undefined, binding.etag);
  await exchange('joined-disabled', 403);
  await publish('matrix-joined-workload', workload.token, false);
  evidence.workload = true;

  repositoryTag();
  await call('POST', `/_pb/sources/${source}/sync`, 202);
  const built = await wait(
    () => broker.inspectRepositoryBuild(source),
    (rows) => rows.length > 0,
  );
  assert.equal(built.length, 1, 'Repository build evidence is ambiguous');
  assert.equal(built[0].status, 'succeeded', 'Registered repository build did not complete');
  assert.equal(built[0].refetchable, 0, 'Repository archive must not be refetchable');
  const packages = await call(
    'GET',
    '/_pb/projects/alpha/packages?ecosystem=npm&q=matrix-joined-repository',
    200,
  );
  const builtPackage = packages.value.items.find(
    (item) => item.name === 'matrix-joined-repository',
  );
  assert.ok(builtPackage, 'Repository package missing');
  const readme = await call(
    'GET',
    `/_pb/projects/alpha/packages/${builtPackage.id}/readme?version=1.0.0`,
    200,
  );
  assert.equal(readme.value.body, '# Joined repository fixture\n', 'Repository README differs');
  await install('matrix-joined-repository', true);
  evidence['repository-tag'] = true;
  assertJoinedEvidence(evidence);
  return evidence;
}
