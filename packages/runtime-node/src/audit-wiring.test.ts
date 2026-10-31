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

  it('keeps sinks gated while the other runtime is unwired', async () => {
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
          destination: { protocol: 'https-json', urlEnv: 'ARCHIVE_URL' },
          create: vi.fn(),
        },
      ],
    };
    const broker = createNodeServer([sink], { log: () => {} });
    try {
      await expect(broker.ready()).rejects.toThrow('audit plugins are not available in this build');
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
    const audit = await createNodeAudit({
      config,
      env: (name) => ({ ALERT_URL: 'https://alerts.example.test', PB_AUDIT_TRAIL: 'off' })[name],
      executor: database.executor,
      observability: noopObservability,
      maxJournalBytes: capacity.maxJournalBytes,
      generation: 0,
      telemetryActive: false,
      registration: () => collectRegistrations([trail]),
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
          destination: { protocol: 'https-json', urlEnv: 'ARCHIVE_URL' },
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
