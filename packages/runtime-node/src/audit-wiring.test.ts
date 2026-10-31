import { createHash, randomBytes } from 'node:crypto';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import * as auditModule from './audit.js';
import { createJobLoop } from './jobs/loop.js';
import { createAuthorizationEngine, patValidationGate } from '@package-broker/core/authz/engine';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import { describe, it, expect, vi } from 'vitest';
import type { PluginDefinition, AuditTrailDefinition } from '@package-broker/core/plugin';
import type { BrokerConfig } from '@package-broker/core/config';
import { MIN_AUDIT_JOURNAL_BYTES } from '@package-broker/core/audit/config';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { noopObservability } from '@package-broker/core/platform/observability';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createNodeAudit } from './audit.js';
import { createNodeServer } from './index.js';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';

const create: AuditTrailDefinition['create'] = (context) => ({
  async handle(...args) {
    const [operation] = args;
    if (operation === 'auditHead') {
      const head = await context.journal.head();
      return {
        seq: head.headSeq,
        hash: head.headHash,
        pendingCount: head.pendingCount,
        lastVerifiedAt: null,
      };
    }
    return { items: [], next: null };
  },
});
const trail: PluginDefinition = {
  id: 'trail',
  package: '@test/trail',
  apiVersion: 4,
  platforms: ['node'],
  binds: ['audit-trail'],
  auditTrail: { toggleEnv: 'PB_AUDIT_TRAIL', create },
};
const capacity = { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES };
const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

async function fixture() {
  const database = await openMigratedDatabase({ d1PatternLimit: true });
  const id = ulid();
  await createOrganizationBootstrap(database.executor).bootstrap({
    id,
    slug: 'audit',
    name: 'Audit',
    now: new Date().toISOString(),
  });
  return { database, org: orgContext(id) };
}

async function establishTrail({ database, org }: Awaited<ReturnType<typeof fixture>>) {
  const audit = await createNodeAudit({
    config: { platform: 'node', plugins: [trail], audit: { capacity } },
    env: () => undefined,
    executor: database.executor,
    observability: noopObservability,
    maxJournalBytes: capacity.maxJournalBytes,
    generation: 0,
    telemetryActive: false,
    registration: () => collectRegistrations([trail]),
  });
  expect(await audit.effective(org)).toMatchObject({ mode: 'trail', policy: 'availability' });
}

describe('Node audit assembly', () => {
  it.each(['on', 'off'] as const)(
    'uses the same effective %s toggle for me, status and the composed journal',
    async (toggle) => {
      const { database, org } = await fixture();
      await establishTrail({ database, org });
      const broker = createNodeServer([trail], {
        executor: database.executor,
        audit: { capacity, acceptNoDurableAudit: true },
        auditEnv: { PB_AUDIT_TRAIL: toggle },
        auth: {
          keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
          publicOrigin: 'https://broker.test',
          env: {},
        },
        log: () => {},
        authorization: createAuthorizationEngine({
          access: {
            lookupSession: async () => ({
              session: { id: 'session', csrfHash: '0'.repeat(64) },
              user: { id: 'reader' },
              identity: null,
              protectedHolder: true,
              project: null,
              organizationPermissions: PERMISSIONS.map((permission) => permission.name),
              projectPermissions: [],
            }),
            lookupToken: async () => null,
            touchSession: async () => true,
            touchToken: async () => true,
          },
          tokenUse: {
            keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
            nowMs: Date.now,
            dispatch: () => {},
            log: () => {},
          },
          patValidation: patValidationGate,
          publicOrigin: 'https://broker.test',
          providerAnchors: async () => [],
        }),
        platformServices: {
          jobStore: createJobRepository(database.executor),
          blob: {
            head: async () => null,
            get: async () => null,
            put: async () => {
              throw new Error('unused');
            },
          },
          cache: { get: async () => null, set: async () => {}, delete: async () => {} },
        },
      });
      try {
        const kernel = await broker.ready();
        const fetch = (path: string) =>
          kernel.fetch(
            new Request(`https://broker.test/_pb/${path}`, {
              headers: { cookie: `__Host-pb_session=${'A'.repeat(43)}` },
            }),
          );
        const me = await fetch('me');
        expect(me.status).toBe(200);
        expect(await me.json()).toMatchObject({ features: { auditTrail: toggle === 'on' } });
        const status = await fetch('audit/status');
        expect(status.status).toBe(200);
        expect(await status.json()).toMatchObject({
          mode: toggle === 'on' ? 'trail' : 'none',
          trailActive: toggle === 'on',
          capacity: { maxJournalBytes: capacity.maxJournalBytes },
        });
        const head = await fetch('audit/head');
        expect(head.status).toBe(toggle === 'on' ? 200 : 404);
        if (toggle === 'on')
          expect(await head.json()).toMatchObject({ seq: 0, hash: '0'.repeat(64) });
        expect((await fetch('audit/health')).status).toBe(200);
        expect(kernel.registration.jobs.map((job) => job.qualifiedName)).toEqual(
          expect.arrayContaining([
            'core:audit-maintain:v1',
            'core:audit-health-observe:v1',
            'core:audit-frontier:v1',
          ]),
        );
        if (toggle === 'off')
          expect(
            await database.executor.all({
              sql: 'SELECT kind FROM audit_ledger WHERE org_id = ? ORDER BY kind',
              params: [org.orgId],
            }),
          ).toEqual([{ kind: 'cutover' }, { kind: 'mode_change' }]);
      } finally {
        await broker.close();
        await database.close();
      }
    },
  );

  it('refuses malformed effective configuration at boot with a fixed error', async () => {
    const broker = createNodeServer([trail], {
      audit: { capacity },
      auditEnv: { PB_AUDIT_TRAIL: 'invalid' },
      log: () => {},
    });
    try {
      await expect(broker.ready()).rejects.toMatchObject({
        code: 'invalid_trail_env',
        message: 'Invalid effective audit configuration',
      });
    } finally {
      await broker.close();
    }
  });

  it('refuses an active sink without a configured deployment id', async () => {
    const sink: PluginDefinition = {
      id: 'sink',
      package: '@test/sink',
      apiVersion: 4,
      platforms: ['node'],
      auditSinks: [
        {
          id: 'archive',
          kind: 'webhook',
          activation: 'env',
          custody: 'durable',
          sourceIp: 'include',
          destination: {
            protocol: 'https-json',
            urlEnv: 'ARCHIVE_URL',
            headersEnv: 'ARCHIVE_HEADERS',
          },
          create: vi.fn(),
        },
      ],
    };
    const broker = createNodeServer([sink], {
      auditEnv: {
        ARCHIVE_URL: 'https://archive.example.test',
        ARCHIVE_HEADERS: 'Authorization=fixture',
      },
      log: () => {},
    });
    try {
      await expect(broker.ready()).rejects.toThrow(
        'Audit sinks require a configured deployment id',
      );
    } finally {
      await broker.close();
    }
  });

  it('honours the stored required ratchet, ignores the trail toggle and persists a build raise', async () => {
    const { database, org } = await fixture();
    await establishTrail({ database, org });
    const config: BrokerConfig = {
      platform: 'node',
      plugins: [trail],
      audit: { capacity, policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } },
    };
    const log = vi.fn();
    const audit = await createNodeAudit({
      config,
      env: (name) => ({ ALERT_URL: 'https://alerts.example.test', PB_AUDIT_TRAIL: 'off' })[name],
      executor: database.executor,
      observability: { ...noopObservability, log },
      maxJournalBytes: capacity.maxJournalBytes,
      generation: 0,
      telemetryActive: false,
      registration: () => collectRegistrations([trail]),
    });
    expect(log).toHaveBeenCalledWith({
      level: 'warn',
      event: 'audit.trail_toggle_ignored',
      reason_code: 'audit.trail_toggle_ignored',
    });
    try {
      expect(await audit.effective(org)).toMatchObject({
        policy: 'required',
        mode: 'trail',
        trailActive: true,
      });
      expect(await audit.effective(org)).toMatchObject({ policySource: 'stored' });
      expect(
        await database.executor.all({
          sql: "SELECT kind FROM audit_ledger WHERE org_id = ? AND kind = 'policy_change'",
          params: [org.orgId],
        }),
      ).toHaveLength(1);
    } finally {
      await database.close();
    }
  });

  it('refuses an organization with stored required policy when its journal budget is missing', async () => {
    const { database, org } = await fixture();
    await database.executor.batch([
      { sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", params: [org.orgId] },
    ]);
    const audit = await createNodeAudit({
      config: { platform: 'node', plugins: [], audit: { acceptNoDurableAudit: true } },
      env: () => undefined,
      executor: database.executor,
      observability: noopObservability,
      maxJournalBytes: capacity.maxJournalBytes,
      generation: 0,
      telemetryActive: false,
      registration: () => collectRegistrations([]),
    });
    try {
      await expect(audit.effective(org)).rejects.toThrow('journal_budget_required');
    } finally {
      await database.close();
    }
  });

  it('persists a required build ratchet even when the organization has no active durable sink', async () => {
    const { database, org } = await fixture();
    const sink: PluginDefinition = {
      id: 'sink',
      package: '@test/sink',
      apiVersion: 4,
      platforms: ['node'],
      auditSinks: [
        {
          id: 'archive',
          kind: 'custom',
          activation: 'env',
          custody: 'durable',
          sourceIp: 'include',
          destination: {
            protocol: 'https-json',
            urlEnv: 'ARCHIVE_URL',
            headersEnv: 'ARCHIVE_HEADERS',
          },
          create: () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
        },
      ],
    };
    const registration = {
      ...collectRegistrations([]),
      audit: { trail: null, sinks: [{ plugin: sink.id, definition: sink.auditSinks![0]! }] },
    };
    const audit = await createNodeAudit({
      config: {
        platform: 'node',
        plugins: [sink],
        audit: { capacity, policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } },
      },
      env: (name) => (name === 'ALERT_URL' ? 'https://alerts.example.test' : undefined),
      executor: database.executor,
      observability: noopObservability,
      maxJournalBytes: capacity.maxJournalBytes,
      generation: 0,
      telemetryActive: false,
      registration: () => registration,
    });
    try {
      await expect(audit.effective(org)).rejects.toThrow('durable_path_required');
      await expect(audit.effective(org)).rejects.toThrow('durable_path_required');
      expect(
        await database.executor.all({
          sql: 'SELECT policy FROM audit_chain WHERE org_id = ?',
          params: [org.orgId],
        }),
      ).toEqual([{ policy: 'required' }]);
      expect(
        await database.executor.all({
          sql: "SELECT kind FROM audit_ledger WHERE org_id = ? AND kind = 'policy_change'",
          params: [org.orgId],
        }),
      ).toEqual([{ kind: 'policy_change' }]);
    } finally {
      await database.close();
    }
  });
});

it('defers ordinary queued and scheduled jobs on a refusal and retries after reconfiguration', async () => {
  const { database, org } = await fixture();
  await database.executor.batch([
    { sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", params: [org.orgId] },
  ]);
  const handler = vi.fn(async () => {});
  const ordinary: PluginDefinition = {
    id: 'ordinary',
    package: '@test/ordinary',
    apiVersion: 4,
    platforms: ['node'],
    register(registry) {
      for (const name of ['queued', 'scheduled'])
        registry.job({
          name,
          version: 1,
          validate: () => ({}),
          handler,
          ...(name === 'scheduled' ? { schedule: { everySeconds: 60 } } : {}),
        });
    },
  };
  const records: import('@package-broker/core/platform/observability').ObsRecord[] = [];
  const options = {
    executor: database.executor,
    audit: { capacity },
    log: () => {},
    observability: {
      deploymentId: 'test',
      sink: {
        emit: (record: import('@package-broker/core/platform/observability').ObsRecord) => {
          records.push(record);
        },
      },
    },
    platformServices: {
      jobStore: createJobRepository(database.executor),
      blob: {
        head: async () => null,
        get: async () => null,
        put: async () => {
          throw new Error('unused');
        },
      },
      cache: { get: async () => null, set: async () => {}, delete: async () => {} },
    },
  };
  const jobs = createJobRepository(database.executor);
  const queued = await jobs.enqueue(org, {
    id: ulid(),
    type: 'ordinary:queued:v1',
    payloadJson: '{}',
    idempotencyKey: ulid(),
    maxAttempts: 1,
    resourceKey: null,
    projectId: null,
    initiatorTokenId: null,
    runAt: new Date().toISOString(),
  });
  await database.executor.batch([
    {
      sql: "INSERT INTO job_schedule (org_id, name, every_seconds, next_run_at, enabled) VALUES (?, 'ordinary:scheduled:v1', 60, '2000-01-01T00:00:00.000Z', 1)",
      params: [org.orgId],
    },
  ]);
  const broker = createNodeServer([ordinary], options);
  try {
    const kernel = await broker.ready();
    const loop = createJobLoop({
      executor: database.executor,
      jobs: kernel.registration.jobs,
      scope: kernel.jobScope,
      observability: noopObservability,
    });
    loop.start();
    try {
      await vi.waitFor(async () => {
        const rows = await database.executor.all<{
          state: string;
          attempts: number;
          run_at: string;
        }>({
          sql: "SELECT state, attempts, run_at FROM job WHERE org_id = ? AND type LIKE 'ordinary:%'",
          params: [org.orgId],
        });
        expect(rows).toHaveLength(2);
        expect(
          rows.every(
            (row) =>
              row.state === 'queued' && row.attempts === 0 && Date.parse(row.run_at) > Date.now(),
          ),
        ).toBe(true);
      });
      expect(handler).not.toHaveBeenCalled();
      expect(
        records.filter(
          (record) =>
            record.kind === 'log' && record.record.event === 'audit.effective_unavailable',
        ),
      ).toHaveLength(1);
    } finally {
      await loop.stop();
    }
    await broker.close();
    const recovered = createNodeServer([ordinary, trail], {
      ...options,
      audit: { capacity, alerts: { webhookEnv: 'ALERT_URL' } },
      auditEnv: { ALERT_URL: 'https://alerts.example.test' },
    });
    try {
      const ready = await recovered.ready();
      await database.executor.batch([
        {
          sql: "UPDATE job SET run_at = ? WHERE org_id = ? AND type LIKE 'ordinary:%'",
          params: [new Date(Date.now() - 1000).toISOString(), org.orgId],
        },
      ]);
      const retry = createJobLoop({
        executor: database.executor,
        jobs: ready.registration.jobs,
        scope: ready.jobScope,
        observability: noopObservability,
      });
      retry.start();
      try {
        await vi.waitFor(async () => {
          expect(await jobs.status(org, queued.id)).toMatchObject({ state: 'succeeded' });
          expect(handler).toHaveBeenCalledTimes(2);
        });
      } finally {
        await retry.stop();
      }
    } finally {
      await recovered.close();
    }
  } finally {
    await broker.close();
    await database.close();
  }
});

it.each(['service', 'job'] as const)(
  'fails an audit schedule when its %s is unavailable',
  async (missing) => {
    const { database, org } = await fixture();
    const original = auditModule.createNodeAudit;
    const spy = vi.spyOn(auditModule, 'createNodeAudit').mockImplementation(async (input) => {
      if (missing === 'service') return undefined as never;
      return { ...(await original(input)), jobs: [] };
    });
    const broker = createNodeServer([trail], {
      executor: database.executor,
      audit: { capacity },
      log: () => {},
      platformServices: {
        jobStore: createJobRepository(database.executor),
        blob: {
          head: async () => null,
          get: async () => null,
          put: async () => {
            throw new Error('unused');
          },
        },
        cache: { get: async () => null, set: async () => {}, delete: async () => {} },
      },
    });
    const kernel = await broker.ready();
    try {
      const job = kernel.registration.jobs.find(
        (job) => job.qualifiedName === 'core:audit-frontier:v1',
      )!;
      await expect(
        job.definition.handler(
          {},
          {
            ...kernel.jobScope(job, { jobId: ulid(), attempt: 1 }),
            org,
            jobId: ulid(),
            idempotencyKey: ulid(),
            attempt: 1,
            fence: 1,
            signal: AbortSignal.timeout(1000),
          },
        ),
      ).rejects.toMatchObject({ name: 'PlatformUnavailableError' });
    } finally {
      spy.mockRestore();
      await broker.close();
      await database.close();
    }
  },
);

it.each(['none_not_accepted', 'durable_path_required'] as const)(
  'allows first-admin setup while %s fences other writes',
  async (code) => {
    const { database, org } = await fixture();
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    expect(
      await bootstrapAdmin(database.executor, org, {
        email: 'setup@example.test',
        userId: ulid(),
        setupHash: createHash('sha256').update(token).digest('hex'),
        setupExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        grantId: ulid(),
        roleIds: Object.fromEntries(DEFAULT_ROLES.map(({ key }) => [key, ulid()])) as Record<
          DefaultRoleKey,
          string
        >,
        opId: ulid(),
        now: now.toISOString(),
      }),
    ).toBe('created');
    if (code === 'durable_path_required')
      await database.executor.batch([
        { sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?", params: [org.orgId] },
      ]);
    const broker = createNodeServer([], {
      executor: database.executor,
      audit: { capacity },
      auth: {
        keyring: createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]),
        publicOrigin: 'https://broker.test',
        env: {},
      },
      log: () => {},
    });
    const kernel = await broker.ready();
    const send = (request: Request) => kernel.fetch(request);
    const audit = await auditModule.createNodeAudit({
      config: { platform: 'node', plugins: [], audit: { capacity } },
      env: () => undefined,
      executor: database.executor,
      observability: noopObservability,
      maxJournalBytes: capacity.maxJournalBytes,
      generation: 0,
      telemetryActive: false,
      registration: () => collectRegistrations([]),
    });
    const post = (path: string, body: unknown = {}) =>
      send(
        new Request(`https://broker.test/_pb/${path}`, {
          method: 'POST',
          headers: { origin: 'https://broker.test', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    try {
      const assertFenced = async () => {
        for (const [method, path] of [
          ['POST', 'auth/local/setup/other'],
          ['POST', 'auth/sso/provider/callback'],
          ['PUT', 'auth/local/setup/start'],
          ['DELETE', 'auth/local/setup/finish'],
        ] as const) {
          await expect(
            audit.resolveRequest(org, new Request(`https://broker.test/_pb/${path}`, { method })),
          ).rejects.toMatchObject({ code });
        }
        for (const path of ['projects']) {
          const response = await post(path);
          expect(response.status, path).toBe(503);
          expect(response.headers.has('retry-after'), path).toBe(false);
          expect(await response.json()).toMatchObject({ error: { code } });
        }
      };
      await assertFenced();
      const started = await post('auth/local/setup/start', { token });
      expect(started.status).toBe(200);
      const { secret } = (await started.json()) as { secret: string };
      const finished = await post('auth/local/setup/finish', {
        token,
        password: 'correct horse battery staple 42',
        code: await totpCode(base32Decode(secret), Math.floor(Date.now() / 30_000)),
      });
      expect(finished.status).toBe(204);
      expect(
        finished.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-pb_session=')),
      ).toBe(true);
      await assertFenced();
    } finally {
      await broker.close();
      await database.close();
    }
  },
);
