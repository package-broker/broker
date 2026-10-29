import { describe, expect, it } from 'vitest';
import {
  brokerAuditProblems,
  brokerAuditWarnings,
  defineConfig,
  type BrokerConfig,
} from '../config.js';
import type { PluginDefinition } from '../plugin.js';
import { DEFAULT_CLOUDFLARE_AUDIT_JOURNAL_BYTES, MIN_AUDIT_JOURNAL_BYTES } from './config.js';

const sink = (id: string): PluginDefinition => ({
  id: `plugin-${id}`,
  package: '@test/audit-sink',
  platforms: ['node', 'cloudflare'],
  apiVersion: 4,
  auditSinks: [
    {
      id,
      kind: 'webhook',
      destination: { protocol: 'https-json', urlEnv: 'AUDIT_URL' },
      activation: 'env',
      custody: 'durable',
      sourceIp: 'include',
      create: () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
    },
  ],
});
const trail: PluginDefinition = {
  id: 'trail',
  package: '@test/audit-trail',
  platforms: ['node', 'cloudflare'],
  apiVersion: 4,
  binds: ['audit-trail'],
  auditTrail: { toggleEnv: 'PB_AUDIT_TRAIL', create: () => ({}) },
};
const config = (audit?: unknown, overrides: Partial<BrokerConfig> = {}): BrokerConfig =>
  ({
    platform: 'node',
    plugins: [],
    ...overrides,
    ...(audit === undefined ? {} : { audit }),
  }) as BrokerConfig;

describe('audit build configuration', () => {
  it('preserves old configurations and accepts empty optional blocks', () => {
    const old = config();
    expect(defineConfig(old)).toBe(old);
    expect(old.audit).toBeUndefined();
    for (const audit of [undefined, {}, { capacity: {}, alerts: {}, egress: {} }]) {
      expect(brokerAuditProblems(config(audit), 'node')).toEqual([]);
      expect(brokerAuditWarnings(config(audit), 'node')).toEqual([]);
    }
  });

  it('exposes the typed audit configuration through defineConfig', () => {
    const selected = defineConfig({
      platform: 'node',
      plugins: [sink('archive')],
      audit: {
        policy: 'availability',
        acceptNoDurableAudit: true,
        capacity: { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES },
        alerts: { webhookEnv: 'AUDIT_ALERT_URL' },
        egress: { allowPrivate: ['archive'] },
      },
    });
    expect(brokerAuditProblems(selected, 'node')).toEqual([]);
  });

  it.each([null, [], 'secret@example.test', 42])('rejects malformed audit blocks (%#)', (value) => {
    expect(brokerAuditProblems(config(value), 'node')).toEqual(['audit: must be an object']);
  });

  it.each(['capacity', 'alerts', 'egress'])('rejects malformed %s sections', (key) => {
    for (const value of [null, [], 'secret@example.test', 42]) {
      expect(brokerAuditProblems(config({ [key]: value }), 'node')).toEqual([
        `audit.${key}: must be an object`,
      ]);
    }
  });

  it('rejects unknown keys without disclosing keys or values', () => {
    expect(
      brokerAuditProblems(
        config({
          'secret@example.test': 'Bearer secret',
          capacity: { 'secret@example.test': 'secret' },
          alerts: { 'secret@example.test': 'secret' },
          egress: { 'secret@example.test': 'secret' },
        }),
        'node',
      ),
    ).toEqual([
      'audit: contains an unknown key',
      'audit.capacity: contains an unknown key',
      'audit.alerts: contains an unknown key',
      'audit.egress: contains an unknown key',
    ]);
  });

  it.each([false, null, 'true', 1])('requires explicit true acceptance (%#)', (value) => {
    expect(brokerAuditProblems(config({ acceptNoDurableAudit: value }), 'node')).toEqual([
      'audit.acceptNoDurableAudit: must be true when specified',
    ]);
  });

  it.each([null, true, 'REQUIRED', 'secret@example.test'])(
    'rejects invalid policies (%#)',
    (policy) => {
      expect(brokerAuditProblems(config({ policy }), 'node')).toEqual([
        'audit.policy: must be availability or required',
      ]);
    },
  );

  it('refuses required policy with acceptance of no durable audit', () => {
    expect(
      brokerAuditProblems(
        config({
          policy: 'required',
          acceptNoDurableAudit: true,
          alerts: { webhookEnv: 'ALERT_URL' },
        }),
        'node',
      ),
    ).toEqual(['audit: required policy forbids acceptNoDurableAudit']);
  });

  it.each([
    0,
    -1,
    MIN_AUDIT_JOURNAL_BYTES - 1,
    MIN_AUDIT_JOURNAL_BYTES + 0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '67108864',
    null,
  ])('rejects invalid budgets (%#)', (maxJournalBytes) => {
    expect(brokerAuditProblems(config({ capacity: { maxJournalBytes } }), 'node')).toEqual([
      'audit.capacity.maxJournalBytes: must be a safe integer of at least 64 MiB',
    ]);
  });

  it.each([
    MIN_AUDIT_JOURNAL_BYTES,
    DEFAULT_CLOUDFLARE_AUDIT_JOURNAL_BYTES,
    Number.MAX_SAFE_INTEGER,
  ])('accepts valid budgets %s', (maxJournalBytes) => {
    expect(brokerAuditProblems(config({ capacity: { maxJournalBytes } }), 'node')).toEqual([]);
  });

  it.each([
    '',
    'https://secret@example.test',
    'Bearer secret',
    'ALERT\n',
    'A'.repeat(257),
    null,
    1,
  ])('rejects invalid alert references (%#)', (webhookEnv) => {
    expect(brokerAuditProblems(config({ alerts: { webhookEnv } }), 'node')).toEqual([
      'audit.alerts.webhookEnv: must be an environment variable name',
    ]);
  });

  it('checks duplicate sink ids across and within plugins even without an audit block', () => {
    const first = sink('archive');
    expect(
      brokerAuditProblems(config(undefined, { plugins: [first, sink('archive')] }), 'node'),
    ).toEqual(['audit: duplicate sink id']);
    expect(
      brokerAuditProblems(
        config(
          {},
          { plugins: [{ ...first, auditSinks: [...first.auditSinks!, ...first.auditSinks!] }] },
        ),
        'node',
      ),
    ).toEqual(['audit: duplicate sink id']);
  });

  it('requires an alert route even with a durable sink or trail', () => {
    expect(
      brokerAuditProblems(
        config({ policy: 'required' }, { plugins: [trail, sink('archive')] }),
        'node',
      ),
    ).toEqual(['audit: required policy needs a telemetry OTLP endpoint or alerts.webhookEnv']);
    expect(
      brokerAuditProblems(
        config({ policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } }),
        'node',
      ),
    ).toEqual([]);
  });

  it('checks the telemetry route for the selected platform only', () => {
    const ports = {
      node: { observability: { endpointEnv: 'OTLP_ENDPOINT' } },
    } as NonNullable<BrokerConfig['platformPorts']>;
    expect(
      brokerAuditProblems(config({ policy: 'required' }, { platformPorts: ports }), 'node'),
    ).toEqual([]);
    expect(
      brokerAuditProblems(
        config({ policy: 'required' }, { platform: 'cloudflare', platformPorts: ports }),
        'cloudflare',
      ),
    ).toEqual(['audit: required policy needs a telemetry OTLP endpoint or alerts.webhookEnv']);
  });

  it('reports an ignored trail toggle as a warning rather than a problem', () => {
    const selected = config(
      { policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } },
      { plugins: [trail] },
    );
    expect(brokerAuditProblems(selected, 'node')).toEqual([]);
    expect(brokerAuditWarnings(selected, 'node')).toEqual([
      'audit: trail toggleEnv is ignored under required policy',
    ]);
    expect(
      brokerAuditWarnings(config({ policy: 'availability' }, { plugins: [trail] }), 'node'),
    ).toEqual([]);
    expect(brokerAuditWarnings(config({ policy: 'required' }), 'node')).toEqual([]);
    expect(
      brokerAuditWarnings(
        config(
          { policy: 'required' },
          { plugins: [{ ...trail, auditTrail: { create: () => ({}) } }] },
        ),
        'node',
      ),
    ).toEqual([]);
  });

  it('rejects holes in the private egress allowlist', () => {
    expect(brokerAuditProblems(config({ egress: { allowPrivate: new Array(1) } }), 'node')).toEqual(
      ['audit.egress.allowPrivate: contains an invalid sink id'],
    );
  });

  it('allows private egress only for declared sink ids on Node', () => {
    const plugins = [sink('archive')];
    expect(
      brokerAuditProblems(config({ egress: { allowPrivate: ['archive'] } }, { plugins }), 'node'),
    ).toEqual([]);
    expect(
      brokerAuditProblems(
        config({ egress: { allowPrivate: ['archive'] } }, { plugins, platform: 'cloudflare' }),
        'cloudflare',
      ),
    ).toEqual(['audit.egress.allowPrivate: private egress is available only on Node']);
    expect(
      brokerAuditProblems(
        config({ egress: { allowPrivate: [] } }, { platform: 'cloudflare' }),
        'node',
      ),
    ).toEqual([]);
    expect(brokerAuditProblems(config({ egress: { allowPrivate: ['unknown'] } }), 'node')).toEqual([
      'audit.egress.allowPrivate: references an undeclared sink',
    ]);
    expect(
      brokerAuditProblems(
        config({ egress: { allowPrivate: ['archive', 'archive'] } }, { plugins }),
        'node',
      ),
    ).toEqual(['audit.egress.allowPrivate: sink ids must be unique']);
    expect(brokerAuditProblems(config({ egress: { allowPrivate: 'archive' } }), 'node')).toEqual([
      'audit.egress.allowPrivate: must be a list of sink ids',
    ]);
    expect(brokerAuditProblems(config({ egress: { allowPrivate: [null] } }), 'node')).toEqual([
      'audit.egress.allowPrivate: contains an invalid sink id',
    ]);
    expect(
      brokerAuditProblems(config({ egress: { allowPrivate: ['secret@example.test'] } }), 'node'),
    ).toEqual([
      'audit.egress.allowPrivate: contains an invalid sink id',
      'audit.egress.allowPrivate: references an undeclared sink',
    ]);
  });
  it('uses the build target for private egress even when config.platform differs', () => {
    const audit = { egress: { allowPrivate: ['archive'] } };
    const plugins = [sink('archive')];
    expect(brokerAuditProblems(config(audit, { plugins, platform: 'cloudflare' }), 'node')).toEqual(
      [],
    );
    expect(brokerAuditProblems(config(audit, { plugins, platform: 'node' }), 'cloudflare')).toEqual(
      ['audit.egress.allowPrivate: private egress is available only on Node'],
    );
  });

  it('uses only an own target telemetry stanza, allowing missing observability', () => {
    const node = { observability: { endpointEnv: 'OTLP_ENDPOINT' } };
    const missing = ['audit: required policy needs a telemetry OTLP endpoint or alerts.webhookEnv'];
    const selected = config(
      { policy: 'required' },
      {
        platform: 'cloudflare',
        platformPorts: { node } as NonNullable<BrokerConfig['platformPorts']>,
      },
    );
    expect(brokerAuditProblems(selected, 'node')).toEqual([]);
    expect(brokerAuditProblems({ ...selected, platform: 'node' }, 'cloudflare')).toEqual(missing);
    for (const platformPorts of [{ node: {} }, Object.create({ node }) as object]) {
      expect(
        brokerAuditProblems(
          config(
            { policy: 'required' },
            {
              platformPorts: platformPorts as NonNullable<BrokerConfig['platformPorts']>,
            },
          ),
          'node',
        ),
      ).toEqual(missing);
    }
  });

  it.each([10_000_000_000, Math.floor(10_000_000_000 / 1.01) + 1, Number.MAX_SAFE_INTEGER])(
    'rejects Cloudflare budgets beyond the D1 limit including the reserve (%s)',
    (maxJournalBytes) => {
      const selected = config({ capacity: { maxJournalBytes } });
      expect(brokerAuditProblems(selected, 'cloudflare')).toEqual([
        'audit.capacity.maxJournalBytes: exceeds the Cloudflare database limit with reserve',
      ]);
      expect(brokerAuditProblems(selected, 'node')).toEqual([]);
    },
  );

  it.each([
    MIN_AUDIT_JOURNAL_BYTES,
    DEFAULT_CLOUDFLARE_AUDIT_JOURNAL_BYTES,
    Math.floor(10_000_000_000 / 1.01),
  ])('accepts Cloudflare budgets through the limit (%s)', (maxJournalBytes) => {
    expect(
      brokerAuditProblems(
        config({ capacity: { maxJournalBytes } }, { platform: 'node' }),
        'cloudflare',
      ),
    ).toEqual([]);
  });

  it('keeps the 64 MiB minimum on Cloudflare', () => {
    expect(
      brokerAuditProblems(
        config({ capacity: { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES - 1 } }),
        'cloudflare',
      ),
    ).toEqual(['audit.capacity.maxJournalBytes: must be a safe integer of at least 64 MiB']);
  });

  it.each([
    'PB_SECRET',
    'pb_secret',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'otel_exporter_otlp_logs_headers',
    'PB_AUDIT_WEBHOOK_URL',
    'pb_audit_webhook_headers',
    'CLOUDFLARE_API_TOKEN',
    'cloudflare_api_token',
    'COMPOSER_AUTH',
    'PATH',
    'AUDIT_URL',
    'audit_url',
  ])('rejects reserved and sink destination alert names (%s)', (webhookEnv) => {
    expect(
      brokerAuditProblems(
        config({ alerts: { webhookEnv } }, { plugins: [sink('archive')] }),
        'node',
      ),
    ).toEqual(['audit.alerts.webhookEnv: must not be a reserved or destination variable']);
  });

  it.each(['PB_AUDIT_WEBHOOK_URL', 'https://secret@example.test'])(
    'reports both an invalid webhook and a missing required-policy route (%s)',
    (webhookEnv) => {
      const problems = brokerAuditProblems(
        config({ policy: 'required', alerts: { webhookEnv } }),
        'node',
      );
      expect(problems).toEqual([
        webhookEnv === 'PB_AUDIT_WEBHOOK_URL'
          ? 'audit.alerts.webhookEnv: must not be a reserved or destination variable'
          : 'audit.alerts.webhookEnv: must be an environment variable name',
        'audit: required policy needs a telemetry OTLP endpoint or alerts.webhookEnv',
      ]);
    },
  );

  it.each([
    {},
    1,
    'secret@example.test',
    null,
    [null],
    new Array(1),
    [
      Object.defineProperty({}, 'id', {
        get: () => {
          throw new Error('secret@example.test');
        },
      }),
    ],
  ])('reports malformed sink definitions without throwing (%#)', (auditSinks) => {
    const plugin = { ...sink('archive'), auditSinks } as unknown as PluginDefinition;
    const selected = config(
      { policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } },
      { plugins: [plugin] },
    );
    expect(brokerAuditProblems(selected, 'node')).toEqual([
      'audit: sink definitions are malformed',
    ]);
    expect(brokerAuditWarnings(selected, 'node')).toEqual([]);
  });

  it('never invokes audit or sink accessors', () => {
    let reads = 0;
    const getter = {
      enumerable: true,
      get: () => {
        reads++;
        throw new Error('secret@example.test');
      },
    };
    const selected = config();
    Object.defineProperty(selected, 'audit', getter);
    expect(brokerAuditProblems(selected, 'node')).toEqual(['audit: configuration is malformed']);
    expect(brokerAuditWarnings(selected, 'node')).toEqual([]);
    for (const plugin of [
      Object.defineProperty(sink('archive'), 'auditSinks', getter),
      {
        ...sink('archive'),
        auditSinks: [Object.defineProperty({}, 'id', getter)],
      } as unknown as PluginDefinition,
    ]) {
      expect(brokerAuditProblems(config(undefined, { plugins: [plugin] }), 'node')).toEqual([
        'audit: sink definitions are malformed',
      ]);
    }
    for (const audit of [
      Object.defineProperty({}, 'policy', getter),
      {
        alerts: Object.defineProperty({}, 'webhookEnv', getter),
      },
      { egress: { allowPrivate: Object.defineProperty(['archive'], '0', getter) } },
    ]) {
      expect(brokerAuditProblems(config(audit), 'node')).toEqual([
        'audit: configuration is malformed',
      ]);
      expect(brokerAuditWarnings(config(audit), 'cloudflare')).toEqual([]);
    }
    expect(reads).toBe(0);
  });

  it('ignores inherited audit declarations', () => {
    const selected = config();
    Object.setPrototypeOf(selected, { audit: { policy: 'required' } });
    expect(brokerAuditProblems(selected, 'node')).toEqual([]);
    expect(brokerAuditWarnings(selected, 'node')).toEqual([]);
  });
  it.each(['platformPorts', 'node', 'observability', 'endpointEnv', 'headersEnv'])(
    'refuses telemetry accessors at %s without invoking or disclosing them',
    (key) => {
      let reads = 0;
      const telemetry = { endpointEnv: 'OTLP_ENDPOINT' };
      const node = { observability: telemetry };
      const ports = { node };
      const selected = config(
        { policy: 'required' },
        {
          platformPorts: ports as NonNullable<BrokerConfig['platformPorts']>,
        },
      );
      const owner =
        key === 'platformPorts'
          ? selected
          : key === 'node'
            ? ports
            : key === 'observability'
              ? node
              : telemetry;
      Object.defineProperty(owner, key, {
        get: () => {
          reads++;
          throw new Error('Bearer secret@example.test');
        },
      });
      expect(brokerAuditProblems(selected, 'node')).toEqual([
        'audit: telemetry configuration is malformed',
        'audit: required policy needs a telemetry OTLP endpoint or alerts.webhookEnv',
      ]);
      expect(reads).toBe(0);
    },
  );

  it('ignores inherited telemetry properties at every level', () => {
    const telemetry = { endpointEnv: 'OTLP_ENDPOINT' };
    const node = { observability: telemetry };
    const ports = { node };
    for (const platformPorts of [
      Object.create(ports),
      { node: Object.create(node) },
      { node: { observability: Object.create(telemetry) } },
    ]) {
      expect(
        brokerAuditProblems(config({ policy: 'required' }, { platformPorts }), 'node'),
      ).toEqual(['audit: required policy needs a telemetry OTLP endpoint or alerts.webhookEnv']);
    }
    const selected = config({ policy: 'required' });
    Object.setPrototypeOf(selected, { platformPorts: ports });
    expect(brokerAuditProblems(selected, 'node')).toEqual([
      'audit: required policy needs a telemetry OTLP endpoint or alerts.webhookEnv',
    ]);
  });

  it.each([
    'CUSTOM_OPTION',
    'custom_option',
    'TRAIL_SWITCH',
    'trail_switch',
    'CUSTOM_ENDPOINT',
    'custom_endpoint',
    'CUSTOM_HEADERS',
    'custom_headers',
  ])('rejects alert collisions with all declared variables (%s)', (webhookEnv) => {
    const archive = sink('archive');
    const plugins = [
      {
        ...archive,
        auditSinks: archive.auditSinks!.map((entry) => ({
          ...entry,
          envNames: ['CUSTOM_OPTION'],
        })),
      },
      { ...trail, auditTrail: { ...trail.auditTrail!, toggleEnv: 'TRAIL_SWITCH' } },
    ];
    expect(
      brokerAuditProblems(
        config(
          { alerts: { webhookEnv } },
          {
            plugins,
            platformPorts: {
              node: {
                observability: {
                  endpointEnv: 'CUSTOM_ENDPOINT',
                  headersEnv: 'CUSTOM_HEADERS',
                },
              },
            } as NonNullable<BrokerConfig['platformPorts']>,
          },
        ),
        'node',
      ),
    ).toEqual(['audit.alerts.webhookEnv: must not be a reserved or destination variable']);
  });

  it('checks telemetry collisions only for the build target', () => {
    expect(
      brokerAuditProblems(
        config(
          { alerts: { webhookEnv: 'CUSTOM_ENDPOINT' } },
          {
            platform: 'cloudflare',
            platformPorts: {
              cloudflare: { observability: { endpointEnv: 'CUSTOM_ENDPOINT' } },
            } as NonNullable<BrokerConfig['platformPorts']>,
          },
        ),
        'node',
      ),
    ).toEqual([]);
  });

  it('continues after malformed plugins and reports malformed definitions once', () => {
    const malformed = { ...sink('bad'), auditSinks: null } as unknown as PluginDefinition;
    const selected = config(
      {
        policy: 'required',
        alerts: { webhookEnv: 'audit_url' },
        egress: { allowPrivate: ['archive'] },
      },
      {
        plugins: [malformed, malformed, sink('archive'), sink('archive'), trail],
      },
    );
    expect(brokerAuditProblems(selected, 'node')).toEqual([
      'audit: duplicate sink id',
      'audit: sink definitions are malformed',
      'audit.alerts.webhookEnv: must not be a reserved or destination variable',
      'audit: required policy needs a telemetry OTLP endpoint or alerts.webhookEnv',
    ]);
    expect(brokerAuditWarnings(selected, 'node')).toEqual([
      'audit: trail toggleEnv is ignored under required policy',
    ]);
  });

  it('snapshots enumerable own string keys only', () => {
    let reads = 0;
    const audit = {};
    for (const key of ['policy', Symbol('secret')]) {
      Object.defineProperty(audit, key, {
        get: () => {
          reads++;
          throw new Error('secret');
        },
      });
    }
    Object.defineProperty(audit, Symbol('enumerable secret'), {
      enumerable: true,
      get: () => {
        reads++;
        throw new Error('secret');
      },
    });
    expect(brokerAuditProblems(config(audit), 'node')).toEqual([]);
    expect(brokerAuditWarnings(config(audit), 'node')).toEqual([]);
    expect(reads).toBe(0);
  });

  it('rejects arrays with a custom prototype', () => {
    const allowPrivate = Object.setPrototypeOf(['archive'], Object.create(Array.prototype));
    expect(brokerAuditProblems(config({ egress: { allowPrivate } }), 'node')).toEqual([
      'audit: configuration is malformed',
    ]);
  });

  it.each([-1, 1.5, NaN, Infinity, 1025])(
    'rejects malformed snapshot array lengths (%s)',
    (length) => {
      const allowPrivate = new Proxy([], {
        getOwnPropertyDescriptor: (target, key) =>
          key === 'length'
            ? { ...Object.getOwnPropertyDescriptor(target, key)!, value: length }
            : Object.getOwnPropertyDescriptor(target, key),
      });
      expect(brokerAuditProblems(config({ egress: { allowPrivate } }), 'node')).toEqual([
        'audit: configuration is malformed',
      ]);
    },
  );
});
