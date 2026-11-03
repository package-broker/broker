/**
 * Live release gate for Workers notification egress (DEC-NPM-36). It deploys a throwaway fixture
 * Worker to the operator's account, proves Cloudflare refuses prohibited targets with raw fetch
 * (no broker precheck) and through the broker transport, runs public POST/PUT, redirect and
 * timeout controls, checks that instrumented prohibited receivers saw zero bytes, deletes the
 * Worker and prints sanitized pass/fail JSON. Only a live run can pass.
 */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REQUIRED_ENV = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'PB_GATE_PUBLIC_URL',
  'PB_GATE_REDIRECT_URL',
  'PB_GATE_SLOW_URL',
  'PB_GATE_PRIVATE_HOST_URL',
  'PB_GATE_DIRECT_IP_URL',
  'PB_GATE_COUNTER_URL',
];

export const FIXED_PROHIBITED = [
  ['loopback-ipv4', 'https://127.0.0.1/'],
  ['private-ipv4', 'https://10.0.0.1/'],
  ['cgnat-ipv4', 'https://100.64.0.1/'],
  ['loopback-ipv6', 'https://[::1]/'],
  ['link-local-metadata', 'https://169.254.169.254/latest/meta-data/'],
  ['localhost-name', 'https://localhost/'],
];

export class GateConfigError extends Error {
  constructor(missing) {
    super(`missing or invalid gate settings: ${missing.join(', ')}`);
    this.name = 'GateConfigError';
  }
}

export function readGateEnv(env) {
  const bad = REQUIRED_ENV.filter((name) => {
    const value = env[name];
    if (typeof value !== 'string' || value.length === 0) return true;
    return name.startsWith('PB_GATE_') && !value.startsWith('https://');
  });
  if (bad.length > 0) throw new GateConfigError(bad);
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    counterToken: env.PB_GATE_COUNTER_TOKEN ?? null,
    publicUrl: env.PB_GATE_PUBLIC_URL,
    redirectUrl: env.PB_GATE_REDIRECT_URL,
    slowUrl: env.PB_GATE_SLOW_URL,
    counterUrl: env.PB_GATE_COUNTER_URL,
    prohibited: [
      ...FIXED_PROHIBITED,
      ['controlled-host-to-private', env.PB_GATE_PRIVATE_HOST_URL],
      ['direct-public-ip', env.PB_GATE_DIRECT_IP_URL],
    ],
  };
}

/** Every case runs twice: `platform` is raw native fetch, `broker` is the delivery transport. */
export function gateCases(settings) {
  const cases = [];
  for (const mode of ['platform', 'broker']) {
    for (const [id, url] of settings.prohibited)
      cases.push({ id: `${mode}:blocked:${id}`, mode, method: 'POST', url, expect: 'blocked' });
    for (const method of ['POST', 'PUT'])
      cases.push({
        id: `${mode}:public:${method}`,
        mode,
        method,
        url: settings.publicUrl,
        expect: 'delivered',
      });
    cases.push({
      id: `${mode}:redirect`,
      mode,
      method: 'POST',
      url: settings.redirectUrl,
      expect: 'redirect',
    });
  }
  cases.push({
    id: 'broker:timeout',
    mode: 'broker',
    method: 'POST',
    url: settings.slowUrl,
    expect: 'timeout',
  });
  return cases;
}

const safeErrorClass = (name) =>
  typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : null;
const safeCloudflareCode = (code) => (/^\d{3,6}$/.test(String(code)) ? String(code) : null);

const inRange = (status, low, high) => Number.isInteger(status) && status >= low && status <= high;

/** `blocked` accepts a thrown fetch, a broker refusal or a platform error status, never 2xx/3xx. */
export function judge(expectation, observed) {
  if (observed === undefined || observed === null) return false;
  switch (expectation) {
    case 'blocked':
      return observed.kind !== 'response' || !inRange(observed.status, 200, 399);
    case 'delivered':
      return observed.kind === 'response' && inRange(observed.status, 200, 299);
    case 'redirect':
      return observed.kind === 'response' && inRange(observed.status, 300, 399);
    case 'timeout':
      return observed.kind === 'timeout';
    default:
      return false;
  }
}

/**
 * Pass requires a live observation for every case, every expectation met and zero bytes at the
 * prohibited receivers between two successful counter reads.
 */
export function verdict({ cases, observations, counter }) {
  const byId = new Map(observations.map((entry) => [entry.id, entry]));
  const checks = cases.map((gateCase) => {
    const observed = byId.get(gateCase.id);
    let outcome;
    if (observed === undefined) outcome = 'missing';
    else if (observed.live !== true) outcome = 'not_live';
    else outcome = judge(gateCase.expect, observed) ? 'pass' : 'fail';
    return {
      id: gateCase.id,
      expect: gateCase.expect,
      observed: observed?.kind ?? null,
      status: Number.isInteger(observed?.status) ? observed.status : null,
      outcome,
      errorClass: safeErrorClass(observed?.errorClass),
      cloudflareCode: safeCloudflareCode(observed?.cloudflareCode),
    };
  });
  const before = counter?.before;
  const after = counter?.after;
  const counted = Number.isSafeInteger(before) && Number.isSafeInteger(after);
  const prohibitedBytes = counted ? after - before : null;
  const pass = checks.every((check) => check.outcome === 'pass') && prohibitedBytes === 0;
  return { pass, prohibitedBytes, checks };
}

/** Serializes only fixed vocabulary; any configured value that still appears is redacted. */
export function sanitizedReport(result, secrets) {
  const report = {
    gate: 'notification-workers-egress',
    pass: result.pass === true,
    prohibitedBytes: result.prohibitedBytes,
    checks: result.checks.map((check) => ({
      id: String(check.id),
      expect: String(check.expect),
      observed: check.observed === null ? null : String(check.observed),
      status: check.status,
      outcome: String(check.outcome),
      errorClass: safeErrorClass(check.errorClass),
      cloudflareCode: safeCloudflareCode(check.cloudflareCode),
    })),
  };
  let text = JSON.stringify(report);
  for (const secret of secrets)
    if (typeof secret === 'string' && secret.length >= 4)
      text = text.split(secret).join('[redacted]');
  return text;
}

const API = 'https://api.cloudflare.com/client/v4';

async function api(settings, method, path, body, headers = {}) {
  const response = await fetch(`${API}/accounts/${settings.accountId}${path}`, {
    method,
    headers: { authorization: `Bearer ${settings.apiToken}`, ...headers },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.success === false)
    throw new Error(`Cloudflare API ${method} failed with status ${response.status}`);
  return json?.result;
}

/** Bundled by the cli's esbuild as a separate process; this script imports no build tooling. */
function bundleFixture() {
  return execFileSync(
    'pnpm',
    [
      '--filter',
      '@package-broker/cli',
      'exec',
      'esbuild',
      fileURLToPath(new URL('./notification-egress-worker.mjs', import.meta.url)),
      '--bundle',
      '--format=esm',
      '--platform=neutral',
      '--target=es2022',
      '--main-fields=module,main',
      '--conditions=workerd,worker,import,default',
      '--log-level=error',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
}

async function readCounter(settings) {
  const response = await fetch(settings.counterUrl, {
    signal: AbortSignal.timeout(15_000),
    headers:
      settings.counterToken === null ? {} : { authorization: `Bearer ${settings.counterToken}` },
  });
  const json = await response.json();
  if (!response.ok || !Number.isSafeInteger(json?.bytes)) throw new Error('counter unreadable');
  return json.bytes;
}

export async function observeCases(
  endpoint,
  secret,
  cases,
  { fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  let ready = false;
  for (let attempt = 0; attempt < 12 && !ready; attempt += 1) {
    const response = await fetchImpl(endpoint.replace(/\/run$/, '/ready'), {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    ready = response?.ok === true;
    await response?.body?.cancel();
    if (!ready) await sleep(5000);
  }
  if (!ready) throw new Error('gate worker unavailable');
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ cases }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('gate run failed');
  return response.json();
}

async function runLive(settings) {
  const name = `pb-notify-gate-${randomBytes(4).toString('hex')}`;
  const secret = randomBytes(24).toString('base64url');
  const cases = gateCases(settings);
  const form = new FormData();
  form.append(
    'metadata',
    JSON.stringify({
      main_module: 'gate.mjs',
      compatibility_date: '2026-10-01',
      bindings: [{ type: 'secret_text', name: 'GATE_SECRET', text: secret }],
    }),
  );
  form.append(
    'gate.mjs',
    new Blob([bundleFixture()], { type: 'application/javascript+module' }),
    'gate.mjs',
  );
  await api(settings, 'PUT', `/workers/scripts/${name}`, form);
  try {
    await api(
      settings,
      'POST',
      `/workers/scripts/${name}/subdomain`,
      JSON.stringify({ enabled: true }),
      { 'content-type': 'application/json' },
    );
    const { subdomain } = await api(settings, 'GET', '/workers/subdomain');
    const endpoint = `https://${name}.${subdomain}.workers.dev/run`;
    const before = await readCounter(settings);
    const observations = await observeCases(endpoint, secret, cases);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const after = await readCounter(settings);
    return { cases, observations: observations ?? [], counter: { before, after } };
  } finally {
    await api(settings, 'DELETE', `/workers/scripts/${name}?force=true`).catch(() => undefined);
  }
}

export async function main(env = process.env, run = runLive) {
  const settings = readGateEnv(env);
  const outcome = await run(settings);
  const result = verdict(outcome);
  const secrets = [
    ...REQUIRED_ENV.map((name) => env[name]),
    env.PB_GATE_COUNTER_TOKEN,
    ...settings.prohibited.map(([, url]) => url),
    ...[settings.publicUrl, settings.redirectUrl, settings.slowUrl, settings.counterUrl].flatMap(
      (url) => [url, new URL(url).host],
    ),
  ];
  return { pass: result.pass, report: sanitizedReport(result, secrets) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    ({ pass, report }) => {
      process.stdout.write(`${report}\n`);
      process.exitCode = pass ? 0 : 1;
    },
    (error) => {
      process.stderr.write(
        `${error instanceof GateConfigError ? error.message : 'notification egress gate failed to run'}\n`,
      );
      process.exitCode = 2;
    },
  );
}
