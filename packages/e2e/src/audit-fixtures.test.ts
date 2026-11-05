import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { retentionBundle } from './audit-retention-fixture.js';
import { deliveryBuild, deliveryEntry } from './audit-delivery-fixture.js';
import { assertWireIdentity, decodeOtlp } from './audit-wire-fixture.js';
import {
  postponeRequiredSchedules,
  requiredBundle,
  requiredControlEvents,
} from './audit-required-fixture.js';

const source = (runtime: string) =>
  readFile(
    new URL(
      `../../../.pb/${runtime}/${runtime === 'node' ? 'server' : 'worker'}.js`,
      import.meta.url,
    ),
    'utf8',
  );

type ResolveDestination = (options: {
  id: string;
  runtime: 'docker' | 'cloudflare';
  destination: { protocol: 'https-json' | 'otlp-http-json'; urlEnv?: string };
  activation: 'env';
  env: (name: string) => string | undefined;
}) => Promise<{ receiverFingerprint: string; activationSource: string } | null>;

function bundleTransport(bundle: string): ResolveDestination {
  const declaration = (name: string) => {
    const start = bundle.indexOf(`function ${name}(`);
    assert(start >= 0, 'BundleFunctionMissing');
    return bundle.slice(start, bundle.indexOf('\n}', start) + 2);
  };
  const destinationStart = bundle.indexOf('var DEFAULT_AUDIT_DESTINATIONS =');
  const transportStart = /var DEFAULT_TIMEOUT_MS\d* = 1500;/.exec(bundle)!.index;
  const resolveStart = bundle.indexOf('async function resolveAuditDestination(');
  const suffixes = /PRIVATE_SUFFIXES = (\[[^;]+\]);/.exec(bundle)![1];
  const code =
    `var PRIVATE_SUFFIXES = ${suffixes};\n` +
    [
      'ipv4',
      'isLoopback',
      'isPrivateHost',
      'hasHostSuffix',
      'isPrivateIpv4',
      'isCloudMetadataHost',
      'isAuditDeniedHost',
    ]
      .map(declaration)
      .join('\n') +
    bundle.slice(
      destinationStart,
      bundle.indexOf('\n}', bundle.indexOf('function auditDestinationNames(')) + 2,
    ) +
    bundle.slice(transportStart, bundle.indexOf('\n}', resolveStart) + 2) +
    '\nresolveAuditDestination';
  return runInNewContext(code, {
    URL,
    crypto,
    TextEncoder,
    AuditSinkConfigError: class extends Error {
      constructor(code: string) {
        super(code);
      }
    },
    classifyAddress() {
      throw new Error('UnexpectedLiteralFixture');
    },
  }) as ResolveDestination;
}

describe('audit bundle fixtures', () => {
  it.each(['node', 'cloudflare'] as const)(
    '%s delivery starts with valid destinations and preserves the real transport',
    async (runtime) => {
      const original = await source(runtime);
      const directory = await deliveryBuild(runtime);
      const fixture = await readFile(
        `${directory}/${runtime === 'node' ? 'server' : 'worker'}.js`,
        'utf8',
      );
      const patched = deliveryEntry(fixture, runtime, 'http://127.0.0.1:1234');
      execFileSync(process.execPath, ['--check', '--input-type=module'], {
        input: patched,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(original).not.toMatch(
        /__pbAuditFixture|pbAuditFixture|FixtureAckCrash|fixtureAuditExecutor|__fixture\//,
      );
      const context = {
        fetch: vi.fn(),
        AbortSignal,
        __pbAuditFixture: undefined as unknown as {
          transport(options: Parameters<ResolveDestination>[0]): Parameters<ResolveDestination>[0];
        },
      };
      runInNewContext(deliveryEntry('', runtime, 'http://127.0.0.1:1234'), context);
      const resolve = bundleTransport(original);
      const adapt: ResolveDestination = (options) =>
        resolve(context.__pbAuditFixture.transport(options));
      for (const [id, destination] of [
        ['webhook', { protocol: 'https-json' as const, urlEnv: 'PB_AUDIT_WEBHOOK_URL' }],
        ['otlp', { protocol: 'otlp-http-json' as const }],
      ] as const) {
        const resolved = await adapt({
          id,
          runtime: runtime === 'node' ? 'docker' : 'cloudflare',
          destination,
          activation: 'env',
          env: () => undefined,
        });
        expect(resolved?.receiverFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(resolved?.activationSource).toBe(
          id === 'webhook' ? 'PB_AUDIT_WEBHOOK_URL' : 'PB_AUDIT_OTLP_ENDPOINT',
        );
      }
    },
  );

  it.each(['node', 'cloudflare'] as const)(
    '%s parallel delivery builds have independent output directories',
    async (runtime) => {
      const directories = await Promise.all([deliveryBuild(runtime), deliveryBuild(runtime)]);
      try {
        expect(directories[0]).not.toBe(directories[1]);
        const bundles = await Promise.all(
          directories.map((directory) =>
            readFile(`${directory}/${runtime === 'node' ? 'server' : 'worker'}.js`, 'utf8'),
          ),
        );
        expect(bundles.every((bundle) => bundle.includes('__pbAuditFixture'))).toBe(true);
      } finally {
        await Promise.all(
          directories.map((directory) => rm(directory, { recursive: true, force: true })),
        );
      }
    },
  );

  it.each(['node', 'cloudflare'] as const)(
    '%s retention pauses the bundled sealer',
    async (runtime) => {
      const patched = retentionBundle(await source(runtime));
      execFileSync(process.execPath, ['--check', '--input-type=module'], {
        input: patched,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(() => retentionBundle(patched)).toThrow('RetentionSealerAlreadyPatched');
    },
  );

  it.each(['node', 'cloudflare'] as const)(
    '%s required fixtures patch both policy configurations once',
    async (runtime) => {
      const bundle = await source(runtime);
      for (const noPath of [false, true]) {
        const patched = requiredBundle(bundle, {}, noPath, 'fixture-syntax');
        execFileSync(process.execPath, ['--check', '--input-type=module'], {
          input: patched,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        expect(() => requiredBundle(patched, {}, noPath, 'again')).toThrow(
          'RequiredFixturePatchTargetChanged',
        );
      }
    },
  );
});

describe('required audit control evidence', () => {
  it('reads control change payloads, retaining revision, absent sink and organization isolation', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE audit_pending (org_id TEXT, action TEXT, payload_json TEXT)');
      for (const operation of ['unblock', 'replay', 'rebind', 'alert_ack']) {
        const payload = JSON.stringify({
          changes: {
            operation: { new: operation },
            ...(operation === 'alert_ack'
              ? { alert_code: { new: 'audit.capacity' }, revision: { new: 3 } }
              : { sink_id: { new: 'webhook' } }),
          },
        });
        db.prepare('INSERT INTO audit_pending VALUES (?, ?, ?)').run(
          'org-a',
          'audit.sink_admin',
          payload,
        );
        db.prepare('INSERT INTO audit_pending VALUES (?, ?, ?)').run(
          'org-b',
          'audit.sink_admin',
          payload,
        );
      }
      const events = await requiredControlEvents(
        async <T extends Record<string, unknown>>(sql: string) =>
          db.prepare(sql).all('org-a') as T[],
      );
      expect(events.map((row) => row.operation)).toEqual([
        'unblock',
        'replay',
        'rebind',
        'alert_ack',
      ]);
      expect(events.at(-1)).toEqual({
        action: 'audit.sink_admin',
        operation: 'alert_ack',
        alert_code: 'audit.capacity',
        revision: 3,
        sink_id: null,
      });
      expect(events.slice(0, 3).every((row) => row.sink_id === 'object')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('audit receiver organization boundary', () => {
  const event = { kind: 'event', chain_id: 'chain', epoch: 1, org_id: 'expected' };
  const envelope = { chain_id: 'chain', epoch: 1, org_id: 'expected', records: [event] };
  it('requires the bootstrap identity even on the first delivery', () => {
    expect(() => assertWireIdentity(envelope, undefined)).toThrow('ForeignReceiverOrganization');
    expect(() => assertWireIdentity({ ...envelope, org_id: 'foreign' }, 'expected')).toThrow(
      'ForeignReceiverOrganization',
    );
    expect(() => assertWireIdentity(envelope, 'expected')).not.toThrow();
  });
  it.each([
    [{ ...event, org_id: 'foreign' }, 'ForeignReceiverRecordOrganization'],
    [{ ...event, chain_id: 'foreign' }, 'ForeignReceiverRecordIdentity'],
    [{ ...event, epoch: 0 }, 'ForeignReceiverRecordIdentity'],
  ])('refuses mismatching record identities', (record, error) => {
    expect(() => assertWireIdentity({ ...envelope, records: [record] }, 'expected')).toThrow(
      String(error),
    );
  });
  it('rejects empty OTLP resources', () => {
    expect(() => decodeOtlp({ resourceLogs: [] })).toThrow('InvalidOtlpResources');
  });
});

describe('required schedule initialization', () => {
  it('registers schedules before postponing them, drains dispatched work and leaves other organizations untouched', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE job_schedule (org_id TEXT, name TEXT, next_run_at TEXT);
        CREATE TABLE job (org_id TEXT, type TEXT, state TEXT);
        INSERT INTO job_schedule VALUES ('foreign', 'core:audit-seal:v1', '2026-01-01');`);
      let ticks = 0;
      const broker = {
        async tick() {
          if (++ticks === 1)
            db.exec(`
            INSERT INTO job_schedule VALUES ('expected', 'core:audit-seal:v1', '2026-01-01');
            INSERT INTO job_schedule VALUES ('expected', 'core:audit-maintain:v1', '2026-01-01');
            INSERT INTO job VALUES ('expected', 'core:audit-seal:v1', 'running');`);
          else db.prepare("UPDATE job SET state = 'succeeded' WHERE org_id = ?").run('expected');
        },
        async read<T extends Record<string, unknown>>(
          sql: string,
          params: (string | number)[] = [],
        ) {
          return db.prepare(sql).all(...params) as T[];
        },
      };
      await postponeRequiredSchedules(broker, 'expected', () => {
        db.prepare(
          "UPDATE job_schedule SET next_run_at = '2099-01-01T00:00:00.000Z' WHERE org_id = ?",
        ).run('expected');
      });
      expect(ticks).toBe(2);
      expect(db.prepare('SELECT state FROM job WHERE org_id = ?').get('expected')).toEqual({
        state: 'succeeded',
      });
      expect(
        db.prepare('SELECT next_run_at FROM job_schedule WHERE org_id = ?').get('foreign'),
      ).toEqual({ next_run_at: '2026-01-01' });
      await expect(
        postponeRequiredSchedules({ ...broker, tick: async () => {} }, 'missing', () => {}, false),
      ).rejects.toThrow('RequiredSchedulesNotPostponed');
    } finally {
      db.close();
    }
  });
});
