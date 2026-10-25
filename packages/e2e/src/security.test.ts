import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertCredentialContainment,
  assertHostile,
  assertSsrf,
  excluded,
  runtimeExclusions,
  hostileCases,
  settleMs,
  ssrfCases,
  startSecurityScenario,
} from './security.spec.js';
import type { SecurityScenario } from './security.spec.js';
import { buildBundles } from './local.js';
import {
  assertNoSecrets,
  canary,
  connectToUnguardedResolution,
  disableDnsGuard,
  disablePolicyFetch,
  HeaderRecorder,
  nodeSecurityTransport,
  securityDestination,
} from './sentinels.js';

const fixture = 'http://127.0.0.1:10001';
const sentinel = 'http://127.0.0.1:10002';
const ipv6 = 'http://[::1]:10003';
const self = 'http://127.0.0.1:10004';

describe('security evidence helpers', () => {
  it('keeps canaries out of failures and rejects incomplete or unexercised recorder evidence', () => {
    const secret = canary();
    const recorder = new HeaderRecorder(new Map([['https://first.test', secret]]));
    expect(() => recorder.assertContained(['https://first.test'])).toThrow('RecipientNotExercised');
    recorder.record('https://first.test', { authorization: `Bearer ${secret}` });
    recorder.record('https://second.test', {});
    expect(() =>
      recorder.assertContained(['https://first.test', 'https://second.test']),
    ).not.toThrow();
    recorder.record('https://second.test', { authorization: `Bearer ${secret}` });
    expect(() => recorder.assertContained(['https://second.test'])).toThrow(
      'CredentialReachedForbiddenOrigin',
    );
    const inUrl = new HeaderRecorder(new Map([['https://first.test', secret]]));
    inUrl.record('https://first.test', { authorization: `Bearer ${secret}` }, `/p?t=${secret}`);
    expect(() => inUrl.assertContained(['https://first.test'])).toThrow(
      'CredentialReachedForbiddenOrigin',
    );
    const overflow = new HeaderRecorder(new Map());
    for (let i = 0; i <= 1000; i++) overflow.record('https://second.test', {});
    expect(() => overflow.assertContained([])).toThrow('IncompleteHeaderEvidence');
    try {
      assertNoSecrets('prefix ' + secret, [secret]);
      assert.fail('LeakWasNotDetected');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain('SensitiveDataInOutput');
    }
    expect(() => assertNoSecrets('safe output', [secret])).not.toThrow();
  });

  it('emulates only declared destinations and refuses accidental public traffic', () => {
    for (const url of ['https://127.0.0.1/', 'https://169.254.169.254/', self])
      expect(securityDestination(url, fixture, sentinel, ipv6, self)).toBe(sentinel);
    expect(securityDestination('https://[::1]/', fixture, sentinel, ipv6, self)).toBe(ipv6);
    expect(() =>
      securityDestination('https://unknown.test', fixture, sentinel, ipv6, self),
    ).toThrow('UnexpectedSecurityUpstream');
    expect(() =>
      securityDestination('https://user:secret@repo.packagist.org', fixture, sentinel, ipv6, self),
    ).toThrow('UnexpectedSecurityURL');
  });

  it('routes by the address the product lookup returned and keeps a guard refusal unconnected', async () => {
    const transport: { request?: (options: Record<string, unknown>) => unknown } = {};
    const connects: unknown[] = [];
    const failures: unknown[] = [];
    const preload = nodeSecurityTransport(fixture, sentinel, ipv6).replace(
      "(await import('node:dns/promises')).default",
      'dnsModule',
    );
    const plainHttp: { request: (options: Record<string, unknown>) => unknown } = {
      request(options) {
        assert(!('agent' in options), 'AgentBypassesCreateConnection');
        const created = (error: unknown) => {
          if (error) failures.push(error);
        };
        const socket = (
          options['createConnection'] as (
            settings: object,
            created: (error: unknown, socket?: unknown) => void,
          ) => unknown
        )({}, created);
        if (socket) created(null);
      },
    };
    await runInNewContext(`(async () => { ${preload} })()`, {
      https: transport,
      URL,
      net: {
        isIP,
        connect(port: number, host: string) {
          connects.push([port, host]);
          return { port, host };
        },
      },
      dnsModule: {},
      http: plainHttp,
    });
    const send = (host: string, answers: string[] | Error) => {
      connects.length = 0;
      transport.request!({
        host,
        servername: host,
        path: '/p2/fx/lib.json',
        lookup: (_host: string, _settings: object, callback: (...args: unknown[]) => void) =>
          answers instanceof Error
            ? callback(answers)
            : callback(
                null,
                answers.map((address) => ({ address, family: isIP(address) })),
              ),
      });
      return [...connects];
    };
    expect(send('repo.packagist.org', ['93.184.216.34'])).toEqual([[10001, '127.0.0.1']]);
    expect(send('rebind.security.test', ['127.0.0.1'])).toEqual([[10002, '127.0.0.1']]);
    expect(send('mixed.security.test', ['93.184.216.34', '127.0.0.1'])).toEqual([
      [10002, '127.0.0.1'],
    ]);
    expect(send('ipv6.security.test', ['::1'])).toEqual([[10003, '::1']]);
    expect(send('broker.security.test', ['93.184.216.34'])).toEqual([[10002, '127.0.0.1']]);
    const guardError = new Error('GuardRefused');
    expect(send('repo.packagist.org', guardError)).toEqual([]);
    expect(failures).toEqual([guardError]);
    connects.length = 0;
    transport.request!({ host: '169.254.169.254', servername: '', path: '/' });
    expect(connects).toEqual([[10002, '127.0.0.1']]);
    expect(() => transport.request!({ host: 'unknown.example', path: '/' })).toThrow(
      'UnexpectedSecurityUpstream',
    );
    connects.length = 0;
    let looked = false;
    transport.request!({
      host: '127.0.0.1',
      servername: 'repo.packagist.org',
      path: '/',
      lookup: () => {
        looked = true;
      },
    });
    expect([connects, looked]).toEqual([[[10002, '127.0.0.1']], false]);
    connects.length = 0;
    plainHttp.request({ host: '127.0.0.1', path: '/' });
    expect(connects).toEqual([[10002, '127.0.0.1']]);
  });

  it('patches exactly one built policy factory and fails closed when the target drifts', () => {
    const source = 'function createPolicyFetch(options) { return original; }';
    expect(disablePolicyFetch(source)).toContain('return async (request)');
    expect(() => disablePolicyFetch('no factory')).toThrow('PolicyMutationTargetMissing');
    expect(() => disablePolicyFetch(source + source)).toThrow('PolicyMutationTargetMissing');
  });
});

const notRunTitles: string[] = [];
const registeredExclusions = new Set<string>();
function notRun(runtime: 'node' | 'cloudflare', id: string, label: string) {
  const reason = excluded(runtime, id);
  assert(reason, 'UnlistedExclusion');
  const title = `NOT RUN (${runtime === 'cloudflare' ? 'Workers' : 'Node'}): ${label}: ${reason}`;
  registeredExclusions.add(`${runtime}:${id}`);
  notRunTitles.push(title);
  it.skip(title, () => {});
}

afterAll(() => {
  if (notRunTitles.length) console.log(['NOT RUN summary:', ...notRunTitles].join('\n'));
});

describe('security oracles on built bundles', () => {
  beforeAll(() => buildBundles(), 600_000);

  it('can patch the emitted Node bundle without touching the original', async () => {
    const built = await readFile(new URL('../../../.pb/node/server.js', import.meta.url), 'utf8');
    expect(disablePolicyFetch(built)).not.toBe(built);
  });

  for (const runtime of ['node', 'cloudflare'] as const) {
    describe(`${runtime} production security effects`, () => {
      let scenario: SecurityScenario;
      let baseline: number[] = [];
      const sentinelCounts = () => [scenario.sentinel.connections(), scenario.ipv6.connections()];
      beforeAll(async () => {
        scenario = await startSecurityScenario(runtime);
        baseline = sentinelCounts();
      }, 180_000);
      afterEach(async () => {
        if (scenario) await scenario.evidence();
      });
      afterAll(async () => {
        if (!scenario) return;
        try {
          await delay(settleMs);
          expect(sentinelCounts()).toEqual(baseline);
        } finally {
          await scenario.close();
        }
      });

      it('publishes the benign archive as an independent positive control', async () => {
        const { buildCorpus } = await import('./fixtures/corpus.js');
        const body = buildCorpus().get('lib.zip')!;
        const name = 'fx/positive-control';
        const response = await scenario.exercise({
          name,
          body,
          target: `https://codeload.github.com/archive/${name}`,
        });
        expect(response.status).toBe(200);
        expect(await scenario.catalogue(name)).toHaveLength(1);
        expect((await scenario.broker.storageKeys()).length).toBeGreaterThan(0);
      }, 60_000);

      for (const [id, target] of ssrfCases)
        for (const redirect of [false, true]) {
          const label = `${id} ${redirect ? 'redirect' : 'direct'}`;
          const reason = excluded(runtime, id);
          if (reason) notRun(runtime, id, label);
          else
            it(
              runtime === 'node'
                ? `refuses ${label} with 502 upstream_refused, refusal counter +1 and zero sentinel connections`
                : `refuses ${label} with 502 upstream_refused and zero sentinel connections`,
              async () => {
                await assertSsrf(scenario, id, target, redirect);
              },
              60_000,
            );
        }
      for (const exclusion of runtimeExclusions.filter((entry) => entry.runtime === runtime))
        for (const id of exclusion.cases)
          if (!ssrfCases.some(([candidate]) => candidate === id)) notRun(runtime, id, id);

      it('contains each origin canary across credentialed redirects to listed and unlisted hosts', async () => {
        await assertCredentialContainment(scenario);
      }, 60_000);

      for (const member of hostileCases)
        it(
          member === 'oversized-archive.zip'
            ? runtime === 'node'
              ? `refuses ${member} over the size cap: 502, quarantine, nothing stored, body_too_large counter +1`
              : `refuses ${member} over the size cap: 502, quarantine, nothing stored`
            : `bounds ${member}: no extraction, no write outside the blob store, byte-for-byte serving`,
          async () => {
            await assertHostile(scenario, member);
          },
          60_000,
        );
    });
  }

  it('registers every runtime exclusion as a visible NOT RUN entry', () => {
    for (const exclusion of runtimeExclusions)
      for (const id of exclusion.cases)
        expect(registeredExclusions.has(`${exclusion.runtime}:${id}`), id).toBe(true);
  });

  const mutations = [
    {
      runtime: 'cloudflare',
      label: 'policy-fetch disabled',
      patch: disablePolicyFetch,
      ids: ['literal-metadata', 'literal-loopback', 'self-origin'],
    },
    {
      runtime: 'node',
      label: 'DNS guard disabled',
      patch: disableDnsGuard,
      ids: ['dns-loopback', 'dns-metadata', 'dns-rebind'],
    },
    {
      runtime: 'node',
      label: 'connection to an unguarded second resolution',
      patch: connectToUnguardedResolution,
      ids: ['dns-loopback', 'dns-metadata', 'dns-ipv6', 'dns-rebind'],
    },
    {
      runtime: 'node',
      label: 'policy-fetch and DNS guard disabled',
      patch: (bundle: string) => disableDnsGuard(disablePolicyFetch(bundle)),
      ids: ['literal-metadata', 'dns-loopback', 'self-origin'],
    },
  ] as const;
  for (const mutation of mutations)
    describe(`${mutation.runtime} with ${mutation.label}`, () => {
      let scenario: SecurityScenario;
      beforeAll(async () => {
        scenario = await startSecurityScenario(mutation.runtime, mutation.patch);
      }, 180_000);
      afterAll(async () => {
        if (scenario) await scenario.close();
      });
      for (const id of mutation.ids)
        it(`fails the ${id} SSRF oracle with SentinelConnectionObserved`, async () => {
          const target = ssrfCases.find(([candidate]) => candidate === id)![1];
          await expect(assertSsrf(scenario, id, target)).rejects.toThrow(
            'SentinelConnectionObserved',
          );
          scenario.fixture.assertHealthy();
          await scenario.broker.moduleEvidence();
        }, 60_000);
    });
});
