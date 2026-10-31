import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeEvidence, assertRuntimeParity } from './client-matrix-api.mjs';

test('runtime parity retains status and public behaviour while removing generated identity and time', () => {
  const node = normalizeEvidence({
    status: 200,
    body: { id: 'node', createdAt: 'today', state: 'approved' },
  });
  const worker = normalizeEvidence({
    status: 200,
    body: { id: 'worker', createdAt: 'tomorrow', state: 'approved' },
  });
  assertRuntimeParity(node, worker);
  assert.throws(() => assertRuntimeParity(node, { status: 202, body: worker.body }));
  assert.throws(() => assertRuntimeParity(node, { status: 200, body: { state: 'rejected' } }));
  assert.equal(node.body.state, 'approved');
});

test('client integration gate requires login and route evidence from both runtimes', async () => {
  const { assertIntegrationEvidence } = await import('./client-matrix-api.mjs');
  const node = { target: 'node', login: 'captured', routesVerified: true };
  const worker = { target: 'cloudflare', login: 'refused', routesVerified: true };
  assertIntegrationEvidence([node, worker]);
  for (const evidence of [
    [],
    [node],
    [node, node],
    [node, worker, node],
    [node, { ...worker, login: 'skipped' }],
    [node, { ...worker, routesVerified: false }],
  ])
    assert.throws(() => assertIntegrationEvidence(evidence));
});

test('API gate requires the real rescan precondition status and error envelope', async () => {
  const { runApiGate } = await import('./client-matrix-api.mjs');
  const reachedDecision = new Error('decision reached after rescan refusal');
  for (const [status, error, accepted] of [
    [
      412,
      { code: 'precondition_failed', message: 'Precondition failed', requestId: 'request' },
      true,
    ],
    [409, { code: 'conflict', message: 'Conflict', requestId: 'request' }, false],
    [412, { code: 'conflict', message: 'Conflict', requestId: 'request' }, false],
    [412, { code: 'precondition_failed', message: 'Precondition failed' }, false],
    [412, { code: 'precondition_failed', requestId: 'request' }, false],
  ]) {
    const broker = {
      browserHeaders: () => ({}),
      dispatch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/_pb/publishes')
          return Response.json({
            items: [
              { id: 'a', packageName: 'a' },
              { id: 'b', packageName: 'b' },
            ],
          });
        if (path.endsWith('/rescan')) return Response.json({ error }, { status });
        if (request.method === 'GET') return Response.json({}, { headers: { etag: '"r1"' } });
        throw reachedDecision;
      },
    };
    await assert.rejects(
      () => runApiGate(broker, 'https://broker.test'),
      (failure) => (accepted ? failure === reachedDecision : failure !== reachedDecision),
    );
  }
});

test('debug parity reports only the first differing route and redacts normalized body differences', () => {
  const lines = [];
  const node = [
    { method: 'GET', path: '/same', status: 200, body: {} },
    {
      method: 'POST',
      path: '/different',
      status: 201,
      body: { state: 'approved', token: 'raw-secret', email: 'person@example.test' },
    },
    { method: 'GET', path: '/later', status: 200, body: {} },
  ];
  const worker = [
    node[0],
    {
      ...node[1],
      status: 409,
      body: { state: 'rejected', token: 'other-secret', email: 'other@example.test' },
    },
    { ...node[2], status: 404 },
  ];
  assert.throws(() =>
    assertRuntimeParity(node, worker, { debug: true, log: (line) => lines.push(line) }),
  );
  const output = lines.join('\n');
  assert.match(output, /POST \/different/);
  assert.match(output, /node status=201/);
  assert.match(output, /cloudflare status=409/);
  assert.match(output, /approved/);
  assert.match(output, /rejected/);
  for (const secret of [
    'raw-secret',
    'other-secret',
    'person@example.test',
    'other@example.test',
    '/later',
  ])
    assert.ok(!output.includes(secret));
  lines.length = 0;
  assert.throws(() => assertRuntimeParity(node, worker, { log: (line) => lines.push(line) }));
  assert.deepEqual(lines, []);
  assertRuntimeParity(node, structuredClone(node), {
    debug: true,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(lines, []);
});
