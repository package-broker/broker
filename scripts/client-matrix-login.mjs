import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  harnessAssert as assert,
  CLIENT_VERSIONS,
  runCommand,
  redactClientOutput,
} from './client-matrix.mjs';

export function loginCommand(client) {
  return {
    command: client,
    args: client === 'yarn' ? ['npm', 'login', '--web-login'] : ['login', '--auth-type=web'],
  };
}

export function loginOutcome(client, result, requests) {
  if (
    result.code !== 0 &&
    ((client === 'yarn' &&
      /Unsupported option name\s*\(["']--web-login["']\)/.test(result.output)) ||
      (client === 'pnpm' &&
        /Unknown option:\s*["']?(?:--)?auth-type["']?(?:\s|$)|unexpected argument ['"]--auth-type['"] found/.test(
          result.output,
        ))) &&
    requests.length === 0
  )
    return {
      status: 'refused',
      reason: 'client_does_not_support_web_login_option',
      output: redactClientOutput(result.output),
    };
  assert.equal(result.code, 0, 'Web login command failed');
  assert.ok(
    requests.some((r) => r.method === 'POST' && r.url.endsWith('/-/v1/login')),
    'Missing client login request',
  );
  assert.ok(
    requests.some((r) => r.method === 'GET' && r.url.includes('/-/v1/done/')),
    'Missing client done request',
  );
  return { status: 'captured' };
}

export async function captureLoginRequest(request) {
  const path = new URL(request.url).pathname;
  if (!/^\/alpha\/npm\/-\/v1\/(?:login|done\/[A-Za-z0-9_-]{43})$/.test(path)) return null;
  return {
    method: request.method,
    url:
      'https://registry.example.test' +
      path
        .replace('/alpha/', '/demo/')
        .replace(/(\/done\/)[A-Za-z0-9_-]{43}$/, '$1' + 'b'.repeat(43)),
    body: request.method === 'POST' ? await request.clone().text() : null,
  };
}

export async function approveLogin(broker, origin, start) {
  const login = await start.clone().json();
  const selector = new URL(login.loginUrl).hash.split('/').at(-1);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(selector), 'Invalid login capability');
  assert.equal(new URL(login.doneUrl).origin, origin, 'Login escaped registry origin');
  const pending = await broker.dispatch(new Request(login.doneUrl));
  assert.equal(pending.status, 202, 'Login was not initially pending');
  assert.ok(isDeepStrictEqual(await pending.json(), {}), 'Unexpected pending login body');
  assert.equal(pending.headers.get('retry-after'), '5', 'Missing login retry hint');
  const path = `${origin}/_pb/me/npm-login/${selector}`;
  const review = await broker.dispatch(
    new Request(path, { headers: broker.browserHeaders(origin) }),
  );
  assert.equal(review.status, 200, 'Login review failed');
  assert.equal((await review.json()).project.slug, 'alpha', 'Login selected wrong project');
  const approve = await broker.dispatch(
    new Request(path, {
      method: 'POST',
      headers: broker.browserHeaders(origin),
      body: JSON.stringify({ scope: 'read' }),
    }),
  );
  assert.equal(approve.status, 200, 'Login browser approval failed');
  assert.ok(
    isDeepStrictEqual(await approve.json(), { ok: true }),
    'Unexpected login approval body',
  );
  return login.doneUrl;
}

export async function runLogin({ client, project, env, front, broker, debug, run = runCommand }) {
  const requests = [];
  let doneUrl;
  front.login(async (request, response) => {
    const captured = await captureLoginRequest(request);
    if (captured === null) return;
    requests.push(captured);
    if (captured.method === 'POST') {
      assert.equal(response.status, 200, 'Login start failed');
      doneUrl = await approveLogin(broker, front.origin, response);
    }
  });
  try {
    const command = loginCommand(client);
    const result = await run(
      command.command,
      command.args,
      project,
      { ...env, npm_config_browser: 'false' },
      { debug, input: '\n' },
    );
    front.assertHealthy();
    const outcome = loginOutcome(client, result, requests);
    if (outcome.status === 'captured') {
      assert.ok(doneUrl !== undefined, 'Client did not start web login');
      const replay = await broker.dispatch(new Request(doneUrl));
      assert.equal(replay.status, 404, 'Consumed login was delivered twice');
      const token = await broker.inspectLogin();
      assert.equal(token.length, 1, 'Web login did not mint exactly one PAT');
      assert.equal(token[0].project_mode, 'selected', 'Login token escaped selected project');
      assert.equal(token[0].project_id, broker.projectId, 'Login token selected wrong project');
      assert.equal(token[0].state, 'consumed', 'Login token was not collected');
      assert.equal(token[0].token_ciphertext, null, 'Login retained sealed token');
      const identity = await run(
        client,
        client === 'yarn' ? ['npm', 'whoami'] : ['whoami'],
        project,
        env,
        { debug },
      );
      assert.equal(identity.code, 0, 'Client did not persist a usable login token');
    }
    if (debug) console.log(`client-matrix: ${client} login ${outcome.status}`);
    return {
      client,
      version: CLIENT_VERSIONS[client],
      transport: 'real CLI through runtime HTTP bridge; approval through authenticated API',
      ...outcome,
      requests,
    };
  } finally {
    front.login(null);
  }
}

export async function saveLoginCapture(directory, target, evidence) {
  await writeFile(
    join(directory, `web-login-${target}-${evidence.client}-${evidence.version}.json`),
    JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600 },
  );
}
