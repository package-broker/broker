import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginCommand, loginOutcome, captureLoginRequest } from './client-matrix-login.mjs';

test('each client is asked to perform its real web login flow', () => {
  assert.deepEqual(loginCommand('npm').args, ['login', '--auth-type=web']);
  assert.deepEqual(loginCommand('pnpm').args, ['login', '--auth-type=web']);
  assert.deepEqual(loginCommand('yarn').args, ['npm', 'login', '--web-login']);
});

test('only an explicit unsupported web option is a recorded refusal', () => {
  assert.equal(
    loginOutcome('yarn', { code: 1, output: 'Unsupported option name ("--web-login").' }, [])
      .status,
    'refused',
  );
  for (const output of [
    'network failure',
    'EPERM',
    'Command not found',
    'Usage Error: login failed',
  ])
    assert.throws(() => loginOutcome('yarn', { code: 1, output }, []));
  assert.throws(() => loginOutcome('npm', { code: 0, output: '' }, []));
  assert.throws(() =>
    loginOutcome('pnpm', { code: 1, output: 'Unsupported option name ("--web-login").' }, []),
  );
});

test('capture omits authorization and done capabilities but preserves actual request bodies', async () => {
  const captured = await captureLoginRequest(
    new Request('http://127.0.0.1:123/alpha/npm/-/v1/done/' + 's'.repeat(43), {
      headers: { authorization: 'Bearer synthetic-secret' },
    }),
  );
  assert.deepEqual(captured, {
    method: 'GET',
    url: 'https://registry.example.test/demo/npm/-/v1/done/' + 'b'.repeat(43),
    body: null,
  });
  const start = await captureLoginRequest(
    new Request('http://127.0.0.1:123/alpha/npm/-/v1/login', { method: 'POST', body: '{}' }),
  );
  assert.equal(start.body, '{}');
  assert.equal(await captureLoginRequest(new Request('http://127.0.0.1/alpha/npm/widget')), null);
});

test('login refuses failed processes even with complete traffic and refuses unsupported options after traffic', () => {
  const requests = [
    { method: 'POST', url: 'https://registry.example.test/demo/npm/-/v1/login' },
    { method: 'GET', url: 'https://registry.example.test/demo/npm/-/v1/done/' + 'b'.repeat(43) },
  ];
  assert.throws(() => loginOutcome('npm', { code: 1, output: '' }, requests));
  assert.throws(() =>
    loginOutcome('yarn', { code: 1, output: 'Unsupported option name ("--web-login").' }, requests),
  );
  assert.deepEqual(loginOutcome('npm', { code: 0, output: '' }, requests), { status: 'captured' });
});

test('pnpm records an explicit refusal of the web authentication option without accepting transport failures', () => {
  assert.equal(
    loginOutcome('pnpm', { code: 1, output: 'Unknown option: auth-type' }, []).status,
    'refused',
  );
  assert.throws(() =>
    loginOutcome('pnpm', { code: 1, output: 'Unknown option: auth-type' }, [
      { method: 'POST', url: '/-/v1/login' },
    ]),
  );
  assert.throws(() => loginOutcome('npm', { code: 1, output: 'Unknown option: auth-type' }, []));
});

test('pnpm 12.5.1 native parser refusal is captured verbatim without accepting unrelated arguments or traffic', () => {
  const output =
    "error: unexpected argument '--auth-type' found\n\nUsage: pnpm login [OPTIONS]\n\nFor more information, try '--help'.\n";
  assert.deepEqual(loginOutcome('pnpm', { code: 1, output }, []), {
    status: 'refused',
    reason: 'client_does_not_support_web_login_option',
    output,
  });
  for (const result of [
    { code: 0, output },
    { code: 1, output: output.replace('--auth-type', '--registry') },
  ])
    assert.throws(() => loginOutcome('pnpm', result, []));
  assert.throws(() =>
    loginOutcome('pnpm', { code: 1, output }, [{ method: 'POST', url: '/-/v1/login' }]),
  );
});

test('login forwards debug to the command runner and retains redacted refusal output', async () => {
  const { runLogin } = await import('./client-matrix-login.mjs');
  const calls = [];
  const front = { login() {}, assertHealthy() {} };
  const outcome = await runLogin({
    client: 'pnpm',
    project: '/unused',
    env: {},
    front,
    broker: {},
    debug: true,
    run: async (command, args, project, env, options) => {
      calls.push({ command, args, options });
      assert.equal(env.npm_config_browser, 'false');
      return {
        code: 1,
        output: "error: unexpected argument '--auth-type' found\nperson@example.test\n",
      };
    },
  });
  assert.deepEqual(calls, [
    { command: 'pnpm', args: ['login', '--auth-type=web'], options: { debug: true, input: '\n' } },
  ]);
  assert.match(outcome.output, /unexpected argument/);
  assert.ok(!outcome.output.includes('person@example.test'));
});
