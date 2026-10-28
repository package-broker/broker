import { describe, expect, it, vi } from 'vitest';
import type { AuditSinkDefinition, PluginDefinition } from '../plugin.js';
import { collectRegistrations, KernelConfigError } from './registry.js';
import { collectAuditDefinitions, snapshotPluginGate } from './registry-audit.js';

function plugin(overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return { id: 'audit', package: '@test/audit', apiVersion: 4, platforms: ['node'], ...overrides };
}
function sink(overrides: Partial<AuditSinkDefinition> = {}): AuditSinkDefinition {
  return {
    id: 'archive',
    kind: 'webhook',
    destination: { protocol: 'https-json', urlEnv: 'ARCHIVE_URL' },
    activation: 'env',
    custody: 'durable',
    sourceIp: 'include',
    create: () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
    ...overrides,
  };
}
function reject(overrides: Partial<PluginDefinition>, message: string) {
  expect(() => collectRegistrations([plugin(overrides)])).toThrow(KernelConfigError);
  expect(() => collectRegistrations([plugin(overrides)])).toThrow(message);
}

function collectValidatedAudit(plugins: readonly PluginDefinition[]) {
  const problems: string[] = [];
  const gates = plugins.map((entry) => snapshotPluginGate(entry, problems));
  const audit = collectAuditDefinitions(plugins, gates, problems);
  if (problems.length > 0) throw new KernelConfigError(problems);
  return { audit };
}

describe('audit registration', () => {
  it('captures one trail and multiple sinks without invoking factories', () => {
    const create = vi.fn(() => ({}));
    const sinkCreate = vi.fn(sink().create);
    const registration = collectValidatedAudit([
      plugin({
        binds: ['audit-trail'],
        auditTrail: { toggleEnv: 'PB_AUDIT_TRAIL', create },
        auditSinks: [sink({ create: sinkCreate })],
      }),
      plugin({
        id: 'second',
        auditSinks: [sink({ id: 'siem', destination: { protocol: 'otlp-http-json' } })],
      }),
    ]);
    expect(registration.audit.trail).toEqual({
      plugin: 'audit',
      definition: { toggleEnv: 'PB_AUDIT_TRAIL', create },
    });
    expect(registration.audit.sinks.map((s) => [s.plugin, s.definition.id])).toEqual([
      ['audit', 'archive'],
      ['second', 'siem'],
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(sinkCreate).not.toHaveBeenCalled();
  });

  it.each([
    { binds: ['audit-trail'] },
    { auditTrail: { create: () => ({}) } },
    { auditSinks: [] },
  ] as Partial<PluginDefinition>[])(
    'gates every audit declaration under apiVersion 3 (%#)',
    (declaration) => {
      reject({ ...declaration, apiVersion: 3 }, 'require apiVersion 4');
    },
  );

  it('rejects a second trail and duplicate sink ids across plugins', () => {
    const definition = plugin({
      binds: ['audit-trail'],
      auditTrail: { create: () => ({}) },
      auditSinks: [sink()],
    });
    expect(() => collectRegistrations([definition, { ...definition, id: 'second' }])).toThrow(
      'only one audit trail',
    );
    expect(() =>
      collectRegistrations([
        plugin({ auditSinks: [sink()] }),
        plugin({ id: 'second', auditSinks: [sink()] }),
      ]),
    ).toThrow('sink ids must be unique');
    reject({ auditSinks: [sink(), sink()] }, 'sink ids must be unique');
  });

  it.each([
    { binds: ['audit-trail'] },
    { auditTrail: { create: () => ({}) } },
  ] as Partial<PluginDefinition>[])(
    'requires the trail binding and definition together (%#)',
    (declaration) => {
      reject(declaration, 'if and only if');
    },
  );

  it.each([
    null,
    {},
    { create: 1 },
    { create: () => ({}), toggleEnv: '' },
    { create: () => ({}), toggleEnv: 'bad-name' },
    { create: () => ({}), extra: 'secret' },
  ])('refuses malformed trail definitions (%#)', (auditTrail) => {
    reject({ binds: ['audit-trail'], auditTrail: auditTrail as never }, 'malformed');
  });

  it.each([
    { id: 'archive\n' },
    { kind: 'webhook\n' },
    { envNames: ['OPTION\n'] },
    { id: '' },
    { id: 'Bad_ID' },
    { id: 'a'.repeat(33) },
    { kind: '' },
    { kind: 'Bad' },
    { create: undefined },
    { create: 1 },
    { factory: () => ({}) },
    { activation: 'sometimes' },
    { custody: 'unknown' },
    { sourceIp: undefined },
    { maxBatchEvents: 0 },
    { maxBatchEvents: 101 },
    { maxBatchEvents: 1.5 },
    { maxBatchEvents: NaN },
    { skipAfter: 0 },
    { skipAfter: 11 },
    { skipAfter: Infinity },
    { destination: null },
    { destination: {} },
    { destination: { protocol: 'https-json' } },
    { destination: { protocol: 'https-json', urlEnv: 'BAD-NAME' } },
    { destination: { protocol: 'https-json', urlEnv: 'URL', endpointEnv: 'OTHER' } },
    { destination: { protocol: 'otlp-http-json', urlEnv: 'URL' } },
    { destination: { protocol: 'otlp-http-json', endpointEnv: 'URL', headersEnv: 'URL' } },
    { destination: { protocol: 'otlp-http-json', headersEnv: 42 } },
    { destination: { protocol: 'otlp-http-json', url: 'https://secret.example' } },
    { envNames: ['A', 'A'] },
    { envNames: ['bad-name'] },
    { envNames: [1] },
    { envNames: 'A' },
  ])('refuses malformed sink definitions (%#)', (override) => {
    reject({ auditSinks: [sink(override as never)] }, 'malformed');
  });

  it.each([null, {}, Array(1), [null]])('refuses malformed sink collections (%#)', (auditSinks) => {
    reject({ auditSinks: auditSinks as never }, 'malformed');
  });

  it.each([
    'PB_SESSION_SECRET',
    'PB_AUDIT_WEBHOOK_HEADERS',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_EXPORTER_OTLP_CERTIFICATE',
    'ARCHIVE_URL',
  ])('denies env access to %s', (name) => {
    reject({ auditSinks: [sink({ envNames: [name] })] }, 'reserved or destination');
  });

  it.each([false, true])(
    'denies another sink’s destination variables regardless of order (%s)',
    (reverse) => {
      const definitions = [
        plugin({ auditSinks: [sink({ envNames: ['OTHER_HEADERS', 'OTHER_URL'] })] }),
        plugin({
          id: 'second',
          auditSinks: [
            sink({
              id: 'other',
              destination: {
                protocol: 'https-json',
                urlEnv: 'OTHER_URL',
                headersEnv: 'OTHER_HEADERS',
              },
            }),
          ],
        }),
      ];
      expect(() => collectRegistrations(reverse ? definitions.reverse() : definitions)).toThrow(
        'reserved or destination',
      );
    },
  );

  it('accepts bounds, custom names and distinct destinations', () => {
    expect(
      collectValidatedAudit([
        plugin({
          auditSinks: [
            sink({ maxBatchEvents: 1, skipAfter: 1, envNames: ['CUSTOM_OPTION'] }),
            sink({
              id: 'other',
              maxBatchEvents: 100,
              skipAfter: 10,
              destination: { protocol: 'https-json', urlEnv: 'OTHER_URL' },
            }),
          ],
        }),
      ]).audit.sinks,
    ).toHaveLength(2);
  });

  it('freezes snapshots before the input can change', () => {
    const definition = sink({ envNames: ['CUSTOM_OPTION'] });
    const auditTrail = { create: () => ({}), toggleEnv: 'PB_AUDIT_TRAIL' };
    const result = collectValidatedAudit([
      plugin({
        binds: ['audit-trail'],
        auditTrail,
        auditSinks: [definition],
      }),
    ]);
    Object.assign(definition, { id: 'changed' });
    Object.assign(definition.destination, { urlEnv: 'CHANGED' });
    (definition.envNames as string[]).push('PB_SECRET');
    auditTrail.toggleEnv = 'CHANGED';
    expect(result.audit.sinks[0]!.definition).toMatchObject({
      id: 'archive',
      destination: { urlEnv: 'ARCHIVE_URL' },
      envNames: ['CUSTOM_OPTION'],
    });
    expect(result.audit.trail!.definition.toggleEnv).toBe('PB_AUDIT_TRAIL');
    for (const value of [
      result.audit,
      result.audit.sinks,
      result.audit.sinks[0],
      result.audit.sinks[0]!.definition,
      result.audit.sinks[0]!.definition.destination,
      result.audit.sinks[0]!.definition.envNames,
      result.audit.trail,
      result.audit.trail!.definition,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('catches throwing getters without exposing their text', () => {
    const secret = 'person@example.com https://user:secret@example.com';
    const definition = plugin();
    Object.defineProperty(definition, 'auditSinks', {
      get() {
        throw new Error(secret);
      },
    });
    try {
      collectRegistrations([definition]);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(KernelConfigError);
      expect((error as Error).message).toBe('plugin "audit" audit definition is malformed');
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each([-1, 1.5, NaN, '1', 1025])('rejects invalid array length %s', (length) => {
    const entries = new Proxy([], {
      get(target, key, receiver) {
        return key === 'length' ? length : (Reflect.get(target, key, receiver) as unknown);
      },
    });
    reject({ auditSinks: entries as never }, 'malformed');
  });

  it('does not let array iterators hide invalid entries', () => {
    const definitions = Object.assign([null], { [Symbol.iterator]: function* () {} });
    reject({ auditSinks: definitions as never }, 'malformed');
  });
  it.each([
    { auditSinks: [sink()] },
    { binds: ['audit-trail'], auditTrail: { create: () => ({}) } },
  ] as Partial<PluginDefinition>[])(
    'fails closed until runtime consumers exist (%#)',
    (overrides) => {
      reject(overrides, 'audit plugins are not available in this build');
    },
  );

  it('keeps compositions without audit plugins available', () => {
    expect(collectRegistrations([plugin()]).audit).toEqual({ trail: null, sinks: [] });
  });

  it('accepts future API versions in the audit declaration gate', () => {
    expect(
      collectValidatedAudit([plugin({ apiVersion: 5, auditSinks: [sink()] })]).audit.sinks,
    ).toHaveLength(1);
  });

  it('ignores overridden includes and iterators on binds', () => {
    const includes = vi.fn(() => false);
    const binds = Object.assign(['audit-trail'], { includes, [Symbol.iterator]: function* () {} });
    reject({ apiVersion: 3, binds: binds as never }, 'require apiVersion 4');
    reject({ binds: binds as never }, 'if and only if');
    expect(includes).not.toHaveBeenCalled();
  });

  it.each(['apiVersion', 'binds'])('refuses changing %s accessors without invoking them', (key) => {
    const get = vi
      .fn()
      .mockReturnValueOnce(key === 'apiVersion' ? 4 : [])
      .mockReturnValue(key === 'apiVersion' ? 3 : ['audit-trail']);
    const definition = plugin();
    Object.defineProperty(definition, key, { get });
    expect(() => collectRegistrations([definition])).toThrow('own data properties required');
    expect(get).not.toHaveBeenCalled();
  });

  it('uses one descriptor snapshot through a proxy for both registration gates', () => {
    const reads = new Map<PropertyKey, number>();
    const definition = new Proxy(plugin({ apiVersion: 3, binds: ['audit-trail'] }), {
      getOwnPropertyDescriptor(target, key) {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        if (key === 'apiVersion')
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: reads.get(key) === 1 ? 3 : 4,
          };
        if (key === 'binds')
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: reads.get(key) === 1 ? ['audit-trail'] : [],
          };
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key, receiver) {
        if (key === 'apiVersion' || key === 'binds') throw new Error('gate reread');
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(() => collectRegistrations([definition])).toThrow('require apiVersion 4');
    expect(reads.get('apiVersion')).toBe(1);
    expect(reads.get('binds')).toBe(1);
  });

  it('uses trusted own binding entries through an array proxy', () => {
    const binds = new Proxy(['audit-trail'], {
      get() {
        throw new Error('untrusted read');
      },
    });
    reject({ binds: binds as never }, 'if and only if');
  });

  it.each(['PB_MASTER_KEY', 'PB_SESSION_SECRET', 'PB_PUBLIC_URL', 'DB', 'CLOUDFLARE_API_TOKEN'])(
    'refuses core destination variable %s',
    (name) => {
      for (const destination of [
        { protocol: 'https-json', urlEnv: name },
        { protocol: 'https-json', urlEnv: 'URL', headersEnv: name },
        { protocol: 'otlp-http-json', endpointEnv: name },
        { protocol: 'otlp-http-json', headersEnv: name },
      ])
        reject({ auditSinks: [sink({ destination: destination as never })] }, 'malformed');
    },
  );

  it.each(['urlEnv', 'headersEnv'])('refuses OTLP variables as webhook %s', (key) => {
    reject(
      {
        auditSinks: [
          sink({
            destination: {
              protocol: 'https-json',
              urlEnv: 'URL',
              [key]: 'OTEL_EXPORTER_OTLP_HEADERS',
            },
          }),
        ],
      },
      'malformed',
    );
  });

  it.each([
    'PB_AUDIT_OTLP_ENDPOINT',
    'PB_AUDIT_OTLP_HEADERS',
    'PB_AUDIT_WEBHOOK_URL',
    'PB_AUDIT_WEBHOOK_HEADERS',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
  ])('accepts documented destination variable %s', (name) => {
    expect(
      collectValidatedAudit([
        plugin({
          auditSinks: [sink({ destination: { protocol: 'otlp-http-json', endpointEnv: name } })],
        }),
      ]).audit.sinks,
    ).toHaveLength(1);
  });

  it.each(['urlEnv', 'headersEnv'])('refuses %s shared between sinks', (key) => {
    const destination = { protocol: 'https-json', urlEnv: 'URL', [key]: 'SHARED' } as const;
    reject(
      {
        auditSinks: [
          sink({ destination }),
          sink({
            id: 'second',
            destination: { protocol: 'https-json', urlEnv: 'OTHER_URL', [key]: 'SHARED' },
          }),
        ],
      },
      'must not be shared',
    );
  });

  it.each([
    'DB',
    'STORAGE',
    'JOBS',
    'ASSETS',
    'ANALYTICS',
    'MCP_RATE_LIMIT',
    'DEPLOYMENT_ID',
    'COMPOSER_AUTH',
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
  ])('refuses core variable %s for env access and trail toggle', (name) => {
    reject({ auditSinks: [sink({ envNames: [name] })] }, 'reserved or destination');
    reject(
      { binds: ['audit-trail'], auditTrail: { create: () => ({}), toggleEnv: name } },
      'reserved or destination',
    );
  });

  it.each([
    'ARCHIVE_URL',
    'PB_AUDIT_WEBHOOK_HEADERS',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'PB_MASTER_KEY',
  ])('refuses destination or core toggle %s', (toggleEnv) => {
    reject(
      {
        binds: ['audit-trail'],
        auditTrail: { create: () => ({}), toggleEnv },
        auditSinks: [sink()],
      },
      'reserved or destination',
    );
  });
});
