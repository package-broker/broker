import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FIXED_PROHIBITED,
  GateConfigError,
  REQUIRED_ENV,
  gateCases,
  judge,
  main,
  readGateEnv,
  sanitizedReport,
  verdict,
  observeCases,
} from '../packages/runtime-cloudflare/scripts/notification-egress-gate.mjs';

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: 'acct-0123456789',
  CLOUDFLARE_API_TOKEN: 'token-SECRET-0123456789',
  PB_GATE_PUBLIC_URL: 'https://receiver.gate-owner.net/ok?k=SECRET-Q',
  PB_GATE_REDIRECT_URL: 'https://receiver.gate-owner.net/redirect',
  PB_GATE_SLOW_URL: 'https://receiver.gate-owner.net/slow',
  PB_GATE_PRIVATE_HOST_URL: 'https://private-gate.gate-owner.net/',
  PB_GATE_DIRECT_IP_URL: 'https://203.0.113.200/',
  PB_GATE_COUNTER_URL: 'https://counter.gate-owner.net/bytes',
  PB_GATE_COUNTER_TOKEN: 'counter-SECRET-token',
};

function expected(gateCase) {
  switch (gateCase.expect) {
    case 'blocked':
      return {
        errorClass: 'TypeError',
        cloudflareCode: '1003',
        kind: gateCase.mode === 'broker' ? 'refused' : 'error',
        status: null,
      };
    case 'delivered':
      return { kind: 'response', status: 204 };
    case 'redirect':
      return { kind: 'response', status: 302 };
    default:
      return { kind: 'timeout', status: null };
  }
}

function fakeRun(over = {}) {
  return async (settings) => {
    const cases = gateCases(settings);
    return {
      cases,
      observations: cases.map((gateCase) => ({
        id: gateCase.id,
        live: true,
        ...expected(gateCase),
        ...(over[gateCase.id] ?? {}),
      })),
      counter: { before: 10, after: 10, ...(over.counter ?? {}) },
    };
  };
}

describe('notification egress gate', () => {
  it('retries readiness only and sends public cases just once with a client timeout', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      assert.ok(init.signal instanceof AbortSignal);
      if (url.endsWith('/ready'))
        return new Response(null, { status: calls.length < 3 ? 503 : 200 });
      throw new Error('response lost after public receiver accepted');
    };
    await assert.rejects(
      observeCases('https://gate.example/run', 'secret', [{ id: 'public' }], {
        fetchImpl,
        sleep: async () => {},
      }),
    );
    assert.equal(calls.filter((call) => call.url.endsWith('/run')).length, 1);
  });

  it('retains the safe error class and Cloudflare code for blocked observations', async () => {
    const { report } = await main(ENV, fakeRun());
    const blocked = JSON.parse(report).checks.filter((check) => check.expect === 'blocked');
    assert.ok(
      blocked.every((check) => check.errorClass === 'TypeError' && check.cloudflareCode === '1003'),
    );
  });

  it('runs platform fixture cases concurrently and records safe error classes and Cloudflare codes', async () => {
    const source = readFileSync(
      new URL(
        '../packages/runtime-cloudflare/scripts/notification-egress-worker.mjs',
        import.meta.url,
      ),
      'utf8',
    )
      .replace(/^import .*;$/gm, '')
      .replace('export default', 'globalThis.fixture =');
    const releases = [];
    const context = vm.createContext({
      URL,
      Response,
      TextEncoder,
      AbortSignal,
      fetch: () =>
        new Promise((resolve, reject) =>
          releases.push(() =>
            reject(Object.assign(new TypeError('error code: 1003 SECRET'), { code: 1003 })),
          ),
        ),
    });
    vm.runInContext(source, context);
    const result = context.fixture.fetch(
      {
        method: 'POST',
        url: 'https://gate.example/run',
        headers: new Headers({ authorization: 'Bearer s' }),
        json: async () => ({
          cases: [
            { id: 'a', mode: 'platform' },
            { id: 'b', mode: 'platform' },
          ],
        }),
      },
      { GATE_SECRET: 's' },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const started = releases.length;
    // Release any serial continuation too, so a failed concurrency assertion cannot hang.
    for (let i = 0; i < 2; i += 1) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setImmediate(resolve));
    }
    const observations = await (await result).json();
    assert.equal(started, 2);
    assert.ok(
      observations.every(
        (entry) => entry.errorClass === 'TypeError' && entry.cloudflareCode === '1003',
      ),
    );
    assert.ok(!JSON.stringify(observations).includes('SECRET'));
  });

  it('needs every account, receiver and counter setting, all receivers over HTTPS', () => {
    assert.throws(() => readGateEnv({}), GateConfigError);
    for (const name of REQUIRED_ENV) {
      const env = { ...ENV, [name]: '' };
      assert.throws(
        () => readGateEnv(env),
        (error) => error.message.includes(name),
      );
    }
    assert.throws(() => readGateEnv({ ...ENV, PB_GATE_PUBLIC_URL: 'http://x.example.com/' }));
    assert.doesNotThrow(() => readGateEnv(ENV));
  });

  it('runs every prohibited target on the platform path and the broker path', () => {
    const cases = gateCases(readGateEnv(ENV));
    const blocked = cases.filter((c) => c.expect === 'blocked');
    assert.equal(blocked.length, (FIXED_PROHIBITED.length + 2) * 2);
    for (const mode of ['platform', 'broker']) {
      const urls = blocked.filter((c) => c.mode === mode).map((c) => c.url);
      for (const [, url] of FIXED_PROHIBITED) assert.ok(urls.includes(url));
      assert.ok(urls.includes(ENV.PB_GATE_PRIVATE_HOST_URL));
      assert.ok(urls.includes(ENV.PB_GATE_DIRECT_IP_URL));
      for (const method of ['POST', 'PUT'])
        assert.ok(
          cases.some((c) => c.mode === mode && c.expect === 'delivered' && c.method === method),
        );
      assert.ok(cases.some((c) => c.mode === mode && c.expect === 'redirect'));
    }
    assert.ok(cases.some((c) => c.mode === 'broker' && c.expect === 'timeout'));
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  });

  it('judges each expectation strictly', () => {
    assert.equal(judge('blocked', { kind: 'refused' }), true);
    assert.equal(judge('blocked', { kind: 'error' }), true);
    assert.equal(judge('blocked', { kind: 'response', status: 403 }), true);
    assert.equal(judge('blocked', { kind: 'response', status: 200 }), false);
    assert.equal(judge('blocked', { kind: 'response', status: 302 }), false);
    assert.equal(judge('delivered', { kind: 'response', status: 204 }), true);
    assert.equal(judge('delivered', { kind: 'response', status: 302 }), false);
    assert.equal(judge('redirect', { kind: 'response', status: 307 }), true);
    assert.equal(judge('redirect', { kind: 'response', status: 200 }), false);
    assert.equal(judge('timeout', { kind: 'timeout' }), true);
    assert.equal(judge('timeout', { kind: 'network' }), false);
    assert.equal(judge('blocked', undefined), false);
    assert.equal(judge('unknown', { kind: 'refused' }), false);
  });

  it('passes a complete live run with zero prohibited bytes', async () => {
    const { pass, report } = await main(ENV, fakeRun());
    assert.equal(pass, true);
    assert.equal(JSON.parse(report).pass, true);
  });

  it('fails when a prohibited receiver saw any byte', async () => {
    assert.equal((await main(ENV, fakeRun({ counter: { after: 11 } }))).pass, false);
    assert.equal((await main(ENV, fakeRun({ counter: { after: null } }))).pass, false);
  });

  it('fails when the platform delivered to a prohibited target', async () => {
    const run = fakeRun({
      'platform:blocked:controlled-host-to-private': { kind: 'response', status: 200 },
    });
    assert.equal((await main(ENV, run)).pass, false);
  });

  it('never passes mocked, skipped or missing observations', async () => {
    const settings = readGateEnv(ENV);
    const cases = gateCases(settings);
    const live = (await fakeRun()(settings)).observations;
    const mocked = live.map((o, i) => (i === 0 ? { ...o, live: false } : o));
    assert.equal(
      verdict({ cases, observations: mocked, counter: { before: 0, after: 0 } }).pass,
      false,
    );
    assert.equal(
      verdict({ cases, observations: live.slice(1), counter: { before: 0, after: 0 } }).pass,
      false,
    );
    assert.equal(
      verdict({ cases, observations: [], counter: { before: 0, after: 0 } }).pass,
      false,
    );
  });

  it('reports no destination, host, token or account value', async () => {
    const { report } = await main(
      ENV,
      fakeRun({
        'broker:public:POST': { kind: 'response', status: 500, leak: ENV.PB_GATE_PUBLIC_URL },
      }),
    );
    for (const value of Object.values(ENV)) assert.ok(!report.includes(value), value);
    for (const host of ['receiver.gate-owner.net', 'private-gate.gate-owner.net', '203.0.113.200'])
      assert.ok(!report.includes(host), host);
    const parsed = JSON.parse(report);
    assert.deepEqual(Object.keys(parsed.checks[0]).sort(), [
      'cloudflareCode',
      'errorClass',
      'expect',
      'id',
      'observed',
      'outcome',
      'status',
    ]);
  });

  it('redacts a configured value that reached a reported field', () => {
    const text = sanitizedReport(
      {
        pass: false,
        prohibitedBytes: 0,
        checks: [
          { id: 'x', expect: 'blocked', observed: 'SECRET-VALUE', status: null, outcome: 'fail' },
        ],
      },
      ['SECRET-VALUE'],
    );
    assert.ok(!text.includes('SECRET-VALUE'));
  });
});
