import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertBuiltModules,
  assertWorkerBundle,
  fixtureDestination,
  injectSourcePollClock,
  repository,
  removeWebhookRegistration,
  upstreamOrigins,
} from './local.js';
import * as local from './local.js';
import { createRegistryFixture, registryScenario, runRegistryAssembly } from './registry.spec.js';
import { releaseScenarios } from './runner.js';
import type { ScenarioResult } from './runner.js';

const pass = { status: 'PASS', reason: 'Executed every leg.' } as const;
const absent = { status: 'NOT RUN', reason: 'Listener unavailable.' } as const;
const failure = {
  status: 'FAIL',
  reason: 'node: signed webhook returned HTTP 404.',
} as const;

describe('local production assembly', () => {
  it.each(upstreamOrigins)('routes %s only to the loopback fixture', (origin) => {
    expect(fixtureDestination(origin + '/package?q=1', 'http://127.0.0.1:1234')).toBe(
      'http://127.0.0.1:1234/__upstream/' + new URL(origin).hostname + '/package?q=1',
    );
  });

  it.each(['https://evil.test/', 'https://user:secret@api.github.com/', 'http://api.github.com/'])(
    'refuses unexpected upstream %s',
    (url) => {
      expect(() => fixtureDestination(url, 'http://127.0.0.1:1234')).toThrow();
    },
  );

  it.each(['https://fixture.test', 'http://localhost:1234', 'http://10.0.0.1:1234'])(
    'refuses a non-loopback fixture %s',
    (origin) => {
      expect(() => fixtureDestination('https://api.github.com/', origin)).toThrow();
    },
  );

  it.each([
    ['https://127.0.0.1:1234', 'NonLoopbackFixture'],
    ['http://localhost:1234', 'NonLoopbackFixture'],
    ['http://10.0.0.1:1234', 'NonLoopbackFixture'],
    ['http://127.0.0.1.evil.test:1234', 'NonLoopbackFixture'],
    ['http://user:secret@127.0.0.1:1234', 'InvalidFixtureOrigin'],
    ['http://127.0.0.1:1234/path', 'InvalidFixtureOrigin'],
    ['http://127.0.0.1:1234?query=1', 'InvalidFixtureOrigin'],
    ['http://127.0.0.1:1234#fragment', 'InvalidFixtureOrigin'],
    ['http://127.0.0.1', 'InvalidFixturePort'],
    ['http://127.0.0.1:0', 'InvalidFixturePort'],
  ] as const)('rejects Node fixture %s before starting infrastructure', async (origin, error) => {
    await expect(local.startLocal('node', origin)).rejects.toThrow(error);
  });

  it('fails empty module evidence and workspace source imports', () => {
    expect(() => assertBuiltModules([])).toThrow('EmptyModuleEvidence');
    expect(() => assertBuiltModules(['file:///repo/packages/runtime-node/src/entry.ts'])).toThrow(
      'WorkspaceSourceLoaded',
    );
    expect(() => assertBuiltModules(['file:///isolated/server.js', 'node:http'])).not.toThrow();
  });

  it('rejects source paths anywhere in the Worker bundle and unbundled workspace imports', () => {
    expect(() => assertWorkerBundle('// packages/core/src/kernel.ts')).toThrow(
      'WorkspaceSourceInWorkerBundle',
    );
    expect(() => assertWorkerBundle("import kernel from '@package-broker/core';")).toThrow(
      'UnbundledWorkspaceImport',
    );
    expect(() =>
      assertWorkerBundle("import { Buffer } from 'node:buffer'; export default {};"),
    ).not.toThrow();
  });

  it('removes the built webhook registration, leaving the handler code and other registrations', () => {
    const input =
      'function createWebhookIntake(deps) { return deps; }\n' +
      'coreRoutes: Object.freeze([createWebhookIntake({ ...deps.webhook, jobs })]),\njobs: registered';
    const mutated = removeWebhookRegistration(input);
    expect(mutated).toContain('function createWebhookIntake');
    expect(mutated).toContain('coreRoutes: Object.freeze([])');
    expect(mutated).toContain('jobs: registered');
    expect(() => removeWebhookRegistration(mutated)).toThrow('WebhookMutationTargetMissing');
    expect(() => removeWebhookRegistration(input + input)).toThrow('WebhookMutationTargetMissing');
  });

  it('has no runtime workspace source imports in the launcher', async () => {
    const source = await readFile(new URL('./local.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)].map(
      (match) => match[1]!,
    );
    expect(imports.every((path) => path.startsWith('node:'))).toBe(true);
  });

  it('advances poll minutes without advancing database or other job clocks', async () => {
    const bundle = `function createSourcePollJob(deps) {
      return defineJob({ ...sourcePollJob, validate: validatePoll, async handler(input, job) {
        validatePoll(input);
        return deps.capture(job);
      } });
    }`;
    const capture = vi.fn();
    const validatePoll = vi.fn();
    const defineJob = vi.fn((definition: unknown) => definition);
    const create = runInNewContext(injectSourcePollClock(bundle) + '\ncreateSourcePollJob;', {
      Date,
      sourcePollJob: {},
      defineJob,
      validatePoll,
    }) as (deps: { capture: typeof capture }) => {
      handler(input: unknown, job: unknown): Promise<void>;
    };
    const clock = { now: () => new Date('2026-10-24T12:00:00Z') };
    const platform = {};
    const job = { org: { orgId: 'acme' }, ports: { clock, platform } };
    const poll = create({ capture });
    await poll.handler({}, job);
    await poll.handler({}, job);
    const [first, second] = capture.mock.calls.map(([value]) => value as typeof job);
    expect(
      second!.ports.clock.now().getTime() - first!.ports.clock.now().getTime(),
    ).toBeGreaterThanOrEqual(60_000);
    expect(first!.org).toBe(job.org);
    expect(first!.ports.platform).toBe(platform);
    expect(job.ports.clock).toBe(clock);
    expect(clock.now().toISOString()).toBe('2026-10-24T12:00:00.000Z');
    expect(defineJob).toHaveBeenCalledOnce();
    expect(validatePoll).toHaveBeenCalledTimes(2);
    expect(() => injectSourcePollClock('')).toThrow('SourcePollClockTargetMissing');
    expect(() => injectSourcePollClock(bundle + bundle)).toThrow('SourcePollClockTargetMissing');
  });

  it.each([
    [new local.LocalUnavailable('Loopback listeners are unavailable.'), 'NOT RUN'],
    [new Error('startup failure'), 'FAIL'],
  ] as const)(
    'classifies unavailable infrastructure separately from failure: %s',
    async (error, expected) => {
      const probe = vi.spyOn(local, 'reserveLoopbackPort').mockRejectedValueOnce(error);
      const start = vi.spyOn(local, 'startLocal');
      try {
        expect((await registryScenario('node')).status).toBe(expected);
        expect(start).not.toHaveBeenCalled();
      } finally {
        probe.mockRestore();
        start.mockRestore();
      }
    },
  );

  it('registers the real assembly scenario only for layer L', () => {
    const registrations = releaseScenarios.filter(({ id }) => id === 'mirror-proxy-assembly');
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.layer).toBe('L');
    expect(registrations[0]?.run).toBeTypeOf('function');
  });

  it('runs both baselines before requiring the webhook mutation to fail', async () => {
    const run = vi
      .fn<typeof import('./registry.spec.js').registryScenario>()
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(failure);
    expect((await runRegistryAssembly(run)).status).toBe('PASS');
    expect(run.mock.calls).toEqual([['node'], ['cloudflare'], ['node', { removeWebhook: true }]]);
  });

  it.each([
    absent,
    pass,
    { status: 'FAIL', reason: 'Failed before mutation was applied.' } as ScenarioResult,
  ])('cannot certify the mutation using %j', async (result) => {
    const run = vi
      .fn<typeof import('./registry.spec.js').registryScenario>()
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(pass)
      .mockResolvedValueOnce(result);
    expect((await runRegistryAssembly(run)).status).not.toBe('PASS');
  });

  it.each([absent, failure])(
    'does not count an incomplete baseline as passing: %j',
    async (result) => {
      const run = vi
        .fn<typeof import('./registry.spec.js').registryScenario>()
        .mockResolvedValueOnce(pass)
        .mockResolvedValueOnce(result);
      expect((await runRegistryAssembly(run)).status).toBe(result.status);
      expect(run).toHaveBeenCalledTimes(2);
    },
  );
});

describe('T448 fixture transport', () => {
  it('serves real Git protocol advertisements and proxy bytes with bounded counters', async () => {
    const fixture = createRegistryFixture();
    const headers = {
      'user-agent': 'local-assembly',
      authorization: 'Basic ' + btoa('x-access-token:ghs_step7FixtureInstallationToken'),
    };
    const advertisement = await fixture.transport('https://github.com/acme/mirror.git/info/refs', {
      headers,
    });
    expect(await advertisement.text()).toContain('fetch=filter');
    const metadata = await fixture.transport('https://repo.packagist.org/p2/acme/proxy.json', {
      headers: { 'user-agent': 'local-assembly' },
    });
    const body = (await metadata.json()) as {
      packages: Record<string, { dist: { url: string } }[]>;
    };
    const url = body.packages['acme/proxy']![0]!.dist.url;
    await fixture.transport(url, { headers: { 'user-agent': 'local-assembly' } });
    await fixture.transport(url, { headers: { 'user-agent': 'local-assembly' } });
    expect(fixture.count('/acme/proxy/legacy.zip/')).toBe(2);
    expect(fixture.calls).toHaveLength(4);
  });

  it('refuses unplanned origins and broker cookies', async () => {
    const fixture = createRegistryFixture();
    await expect(
      fixture.transport('https://unexpected.test/', { headers: { 'user-agent': 'fixture' } }),
    ).rejects.toThrow('UnexpectedUpstream');
    await expect(
      fixture.transport('https://repo.packagist.org/', {
        headers: { 'user-agent': 'fixture', cookie: 'secret' },
      }),
    ).rejects.toThrow('CookieReachedUpstream');
  });
});

const run = promisify(execFile);

describe('production bundle HTTP scenario', () => {
  beforeAll(async () => {
    for (const script of ['build', 'bundle'])
      await run('pnpm', [script], { cwd: repository, maxBuffer: 64 * 1024 * 1024 });
  }, 600_000);

  it.each(['node', 'cloudflare'])(
    'can inject the poll clock into the %s bundle',
    async (runtime) => {
      const entry = runtime === 'node' ? 'server.js' : 'worker.js';
      const bundle = await readFile(
        new URL(`../../../.pb/${runtime}/${entry}`, import.meta.url),
        'utf8',
      );
      expect(() => injectSourcePollClock(bundle)).not.toThrow();
    },
  );

  it('passes both production assemblies and fails the patched Node webhook leg', async () => {
    const result = await runRegistryAssembly();
    expect(result.status, result.reason).toBe('PASS');
  }, 300_000);
});
