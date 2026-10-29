import { describe, expect, it } from 'vitest';
import type { BrokerConfig } from '../config.js';
import type { PluginDefinition } from '../plugin.js';
import { DEFAULT_CLOUDFLARE_AUDIT_JOURNAL_BYTES, MIN_AUDIT_JOURNAL_BYTES } from './config.js';
import {
  AUDIT_NONE_WARNING,
  AuditEffectiveConfigError,
  validateAuditBuild,
  resolveOrgAudit,
  type AuditEffectiveConfigErrorCode,
  type OrgAuditRefusalCode,
  type OrgAuditOptions,
} from './effective.js';

type EffectiveAuditOptions = Omit<OrgAuditOptions, 'build'> & {
  config: BrokerConfig;
  target: BrokerConfig['platform'];
  env: (name: string) => string | undefined;
};
function resolveEffectiveAuditConfig(input: EffectiveAuditOptions) {
  const build = validateAuditBuild(input.config, input.env, input.target);
  const result = resolveOrgAudit({ ...input, build });
  if (!result.ok) throw result;
  return result.effective;
}

const trail: PluginDefinition = {
  id: 'trail',
  package: '@test/audit-trail',
  platforms: ['node', 'cloudflare'],
  apiVersion: 4,
  binds: ['audit-trail'],
  auditTrail: { toggleEnv: 'PB_AUDIT_TRAIL', create: () => ({}) },
};
function sink(custody: 'delivery' | 'durable'): PluginDefinition {
  return {
    id: 'archive',
    package: '@test/audit-sink',
    platforms: ['node', 'cloudflare'],
    apiVersion: 4,
    auditSinks: [
      {
        id: 'archive',
        kind: 'webhook',
        activation: 'env',
        custody,
        sourceIp: 'include',
        destination: { protocol: 'https-json', urlEnv: 'PB_AUDIT_WEBHOOK_URL' },
        create: () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }),
      },
    ],
  };
}
function options(
  plugins: readonly PluginDefinition[] = [trail],
  audit: BrokerConfig['audit'] = {},
  environment: Record<string, string> = {},
): EffectiveAuditOptions {
  return {
    config: { platform: 'cloudflare', plugins, audit },
    target: 'cloudflare',
    env: (name) => environment[name],
    storedPolicy: null,
    sinks: [],
    alertPathActive: false,
  };
}
function bootError(input: EffectiveAuditOptions, code: AuditEffectiveConfigErrorCode) {
  let caught: unknown;
  try {
    validateAuditBuild(input.config, input.env, input.target);
  } catch (value) {
    caught = value;
  }
  expect(caught).toBeInstanceOf(AuditEffectiveConfigError);
  expect(caught).toMatchObject({ name: 'AuditEffectiveConfigError', code });
  return caught;
}
function orgError(input: EffectiveAuditOptions, code: OrgAuditRefusalCode) {
  const build = validateAuditBuild(input.config, input.env, input.target);
  expect(resolveOrgAudit({ ...input, build })).toEqual({
    ok: false,
    code,
    persistRaise:
      (input.storedPolicy === 'required' || build.policy === 'required') &&
      input.storedPolicy !== 'required',
  });
}

describe('effective audit configuration', () => {
  it('uses the composed trail and Cloudflare budget by default', () => {
    expect(resolveEffectiveAuditConfig(options())).toEqual({
      policy: 'availability',
      policySource: 'build',
      persistRaise: false,
      mode: 'trail',
      trailActive: true,
      activeSinkIds: [],
      blockedSinkIds: [],
      durableSinkIds: [],
      durablePath: true,
      maxJournalBytes: DEFAULT_CLOUDFLARE_AUDIT_JOURNAL_BYTES,
      warnings: [],
    });
  });

  it.each(['on', undefined])('keeps the trail active for %s', (toggle) => {
    const input = options();
    expect(
      resolveEffectiveAuditConfig({
        ...input,
        env: (name) => (name === 'PB_AUDIT_TRAIL' ? toggle : undefined),
      }).mode,
    ).toBe('trail');
  });

  it.each(['inactive', 'disabled', 'retired'] as const)(
    'does not count a %s durable sink as active',
    (state) => {
      const input = options([sink('durable')]);
      orgError({ ...input, sinks: [{ id: 'archive', state }] }, 'none_not_accepted');
      orgError(
        { ...input, storedPolicy: 'required', sinks: [{ id: 'archive', state }] },
        'durable_path_required',
      );
    },
  );

  it.each(['delivery', 'durable'] as const)('resolves export mode with %s custody', (custody) => {
    const input = {
      ...options([sink(custody)]),
      sinks: [{ id: 'archive', state: 'active' as const }],
    };
    expect(resolveEffectiveAuditConfig(input)).toMatchObject({
      mode: 'export',
      activeSinkIds: ['archive'],
      blockedSinkIds: [],
      durablePath: custody === 'durable',
      durableSinkIds: custody === 'durable' ? ['archive'] : [],
    });
    if (custody === 'delivery')
      orgError({ ...input, storedPolicy: 'required' }, 'durable_path_required');
    else
      expect(
        resolveEffectiveAuditConfig({ ...input, storedPolicy: 'required', alertPathActive: true })
          .policy,
      ).toBe('required');
  });

  it('prefers trail mode when sinks are also active', () => {
    expect(
      resolveEffectiveAuditConfig({
        ...options([trail, sink('durable')]),
        sinks: [{ id: 'archive', state: 'active' }],
      }),
    ).toMatchObject({ mode: 'trail', durableSinkIds: ['archive'] });
  });

  it.each(['build', 'env'] as const)('requires explicit none acceptance from %s', (source) => {
    const input = options(
      [],
      source === 'build' ? { acceptNoDurableAudit: true } : {},
      source === 'env' ? { PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT: 'true' } : {},
    );
    expect(resolveEffectiveAuditConfig(input)).toMatchObject({
      mode: 'none',
      durablePath: false,
      warnings: [AUDIT_NONE_WARNING],
    });
    orgError({ ...input, storedPolicy: 'required' }, 'required_acceptance');
  });

  it('turning the trail off needs acceptance unless an exporter is active', () => {
    bootError(options([trail], {}, { PB_AUDIT_TRAIL: 'off' }), 'none_not_accepted');
    expect(
      resolveEffectiveAuditConfig({
        ...options([trail, sink('delivery')], {}, { PB_AUDIT_TRAIL: 'off' }),
        sinks: [{ id: 'archive', state: 'active' }],
      }).mode,
    ).toBe('export');
  });

  it.each(['off', 'invalid', ''])('ignores the trail toggle %j under required policy', (toggle) => {
    expect(
      resolveEffectiveAuditConfig({
        ...options(
          [trail],
          { alerts: { webhookEnv: 'AUDIT_ALERT_URL' } },
          { PB_AUDIT_TRAIL: toggle, PB_AUDIT_POLICY: 'required' },
        ),
        storedPolicy: 'required',
        alertPathActive: true,
      }),
    ).toMatchObject({
      trailActive: true,
      warnings: ['audit: trail toggleEnv is ignored under required policy'],
    });
  });

  it.each(['env', 'stored', 'build'] as const)(
    'raises policy via %s and requires a working alert path',
    (source) => {
      const input = {
        ...options(
          [trail],
          {
            ...(source === 'build' ? { policy: 'required' as const } : {}),
            alerts: { webhookEnv: 'AUDIT_ALERT_URL' },
          },
          source === 'env' ? { PB_AUDIT_POLICY: 'required' } : {},
        ),
        ...(source === 'stored' ? { storedPolicy: 'required' as const } : {}),
      };
      orgError(input, 'alert_path_required');
      expect(resolveEffectiveAuditConfig({ ...input, alertPathActive: true })).toMatchObject({
        policy: 'required',
        policySource: source,
        persistRaise: source !== 'stored',
      });
    },
  );

  it('retains the stored required policy after the environment is removed', () => {
    expect(
      resolveEffectiveAuditConfig({ ...options(), storedPolicy: 'required', alertPathActive: true })
        .policy,
    ).toBe('required');
    orgError(
      { ...options([], { acceptNoDurableAudit: true }), storedPolicy: 'required' },
      'required_acceptance',
    );
  });

  it.each([{ plugins: [] }, { plugins: [sink('delivery')] }])(
    'refuses required builds without a durable path',
    ({ plugins }) => {
      bootError(
        options(plugins, { policy: 'required', alerts: { webhookEnv: 'AUDIT_ALERT_URL' } }),
        'durable_path_required',
      );
    },
  );

  it.each(['REQUIRED', 'required\n', 'secret@example.test'])(
    'refuses invalid policy without echoing it',
    (value) => {
      const caught = bootError(
        options([trail], {}, { PB_AUDIT_POLICY: value }),
        'invalid_policy_env',
      );
      expect(String(caught)).not.toContain(value);
      expect(JSON.stringify(caught)).not.toContain(JSON.stringify(value).slice(1, -1));
    },
  );

  it.each(['yes', '', 'TRUE', 'true\n'])('refuses invalid acceptance %j', (value) => {
    bootError(
      options([trail], {}, { PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT: value }),
      'invalid_acceptance_env',
    );
  });

  it('false acceptance does not permit none or override build acceptance', () => {
    bootError(options([], {}, { PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT: 'false' }), 'none_not_accepted');
    expect(
      resolveEffectiveAuditConfig(
        options([], { acceptNoDurableAudit: true }, { PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT: 'false' }),
      ).mode,
    ).toBe('none');
  });

  it.each(['OFF', '', 'off\n'])('refuses invalid trail toggle %j', (value) => {
    bootError(options([trail], {}, { PB_AUDIT_TRAIL: value }), 'invalid_trail_env');
  });

  it('requires a Node journal budget only with a composed trail', () => {
    const input = options();
    input.config = { ...input.config, platform: 'node' };
    input.target = 'node';
    bootError(input, 'journal_budget_required');
    expect(
      resolveEffectiveAuditConfig({
        ...input,
        config: {
          ...input.config,
          audit: { capacity: { maxJournalBytes: MIN_AUDIT_JOURNAL_BYTES } },
        },
      }).maxJournalBytes,
    ).toBe(MIN_AUDIT_JOURNAL_BYTES);
  });

  it.each([{ plugins: [] }, { plugins: [sink('durable')] }])(
    'boots Node without a trail or budget',
    ({ plugins }) => {
      const input = options(plugins, { acceptNoDurableAudit: true });
      const build = validateAuditBuild({ ...input.config, platform: 'node' }, input.env, 'node');
      expect(build.maxJournalBytes).toBeNull();
      expect(resolveOrgAudit({ ...input, build })).toMatchObject({
        ok: true,
        effective: { mode: 'none' },
      });
    },
  );

  it('rejects invalid static configuration before resolving the environment', () => {
    bootError(options([trail], { capacity: { maxJournalBytes: 1 } }), 'invalid_config');
    bootError(
      options([trail], { policy: 'required', acceptNoDurableAudit: true }),
      'invalid_config',
    );
    bootError(options([trail, trail]), 'invalid_config');
  });

  it('rejects unknown or duplicate lifecycle entries', () => {
    orgError({ ...options(), sinks: [{ id: 'unknown', state: 'active' }] }, 'invalid_sink_state');
    orgError(
      {
        ...options([sink('durable')]),
        sinks: [
          { id: 'archive', state: 'active' },
          { id: 'archive', state: 'inactive' },
        ],
      },
      'invalid_sink_state',
    );
  });
  it.each(['disabled', 'retired'] as const)('skips a removed %s sink', (state) => {
    expect(
      resolveEffectiveAuditConfig({ ...options(), sinks: [{ id: 'removed', state }] }),
    ).toMatchObject({ mode: 'trail', activeSinkIds: [], durableSinkIds: [] });
  });

  it.each(['active', 'inactive', 'blocked'] as const)(
    'refuses an unknown %s sink per organization',
    (state) => {
      const input = options();
      const build = validateAuditBuild(input.config, input.env, input.target);
      expect(resolveOrgAudit({ ...input, build, sinks: [{ id: 'removed', state }] })).toEqual({
        ok: false,
        code: 'invalid_sink_state',
        persistRaise: false,
      });
    },
  );

  it.each(['delivery', 'durable'] as const)(
    'counts a blocked %s sink for export mode',
    (custody) => {
      const input = {
        ...options([sink(custody)]),
        sinks: [{ id: 'archive', state: 'blocked' as const }],
      };
      expect(resolveEffectiveAuditConfig(input)).toMatchObject({
        mode: 'export',
        activeSinkIds: ['archive'],
        blockedSinkIds: ['archive'],
        durablePath: custody === 'durable',
      });
    },
  );

  it('boots required export-only with a blocked durable sink', () => {
    const input = options([sink('durable')], {
      policy: 'required',
      alerts: { webhookEnv: 'AUDIT_ALERT_URL' },
    });
    const build = validateAuditBuild(input.config, input.env, input.target);
    expect(
      resolveOrgAudit({
        ...input,
        build,
        sinks: [{ id: 'archive', state: 'blocked' }],
        alertPathActive: true,
      }),
    ).toMatchObject({
      ok: true,
      effective: {
        policy: 'required',
        mode: 'export',
        durablePath: true,
        durableSinkIds: ['archive'],
      },
    });
  });

  it('isolates a stored required refusal from other organizations on the same deployment', () => {
    const input = options([sink('delivery')]);
    const build = validateAuditBuild(input.config, input.env, input.target);
    const shared = {
      ...input,
      build,
      sinks: [{ id: 'archive', state: 'active' as const }],
      alertPathActive: true,
    };
    expect(resolveOrgAudit({ ...shared, storedPolicy: 'required' })).toEqual({
      ok: false,
      code: 'durable_path_required',
      persistRaise: false,
    });
    expect(resolveOrgAudit({ ...shared, storedPolicy: 'availability' })).toMatchObject({
      ok: true,
      effective: { policy: 'availability', mode: 'export', persistRaise: false },
    });
  });

  it.each(['build', 'env', 'stored'] as const)(
    'availability env never lowers %s required policy',
    (source) => {
      const input = options(
        [trail],
        {
          ...(source === 'build' ? { policy: 'required' as const } : {}),
          alerts: { webhookEnv: 'AUDIT_ALERT_URL' },
        },
        { PB_AUDIT_POLICY: source === 'env' ? 'required' : 'availability' },
      );
      expect(
        resolveEffectiveAuditConfig({
          ...input,
          storedPolicy: source === 'stored' ? 'required' : 'availability',
          alertPathActive: true,
        }),
      ).toMatchObject({
        policy: 'required',
        policySource: source,
        persistRaise: source !== 'stored',
      });
    },
  );

  it('stored required takes precedence over build and environment required', () => {
    const input = options(
      [trail],
      { policy: 'required', alerts: { webhookEnv: 'AUDIT_ALERT_URL' } },
      { PB_AUDIT_POLICY: 'required' },
    );
    expect(
      resolveEffectiveAuditConfig({ ...input, storedPolicy: 'required', alertPathActive: true }),
    ).toMatchObject({ policySource: 'stored', persistRaise: false });
  });

  it('keeps a required trail enabled with an active durable exporter', () => {
    const input = options([trail, sink('durable')], {}, { PB_AUDIT_TRAIL: 'off' });
    expect(
      resolveEffectiveAuditConfig({
        ...input,
        storedPolicy: 'required',
        alertPathActive: true,
        sinks: [{ id: 'archive', state: 'active' }],
      }),
    ).toMatchObject({ mode: 'trail', trailActive: true, durableSinkIds: ['archive'] });
  });

  it('acceptance with delivery-only export needs no none warning', () => {
    expect(
      resolveEffectiveAuditConfig({
        ...options([sink('delivery')], { acceptNoDurableAudit: true }),
        sinks: [{ id: 'archive', state: 'active' }],
      }),
    ).toMatchObject({ mode: 'export', durablePath: false, warnings: [] });
  });

  it('rejects a target mismatch at boot', () => {
    const input = options();
    bootError({ ...input, target: 'node' }, 'invalid_config');
  });

  it('retains captured policy and sink definitions after original inputs change', () => {
    const definition = sink('durable');
    const environment = { PB_AUDIT_POLICY: 'required' };
    const config = {
      platform: 'cloudflare' as const,
      plugins: [definition],
      audit: { alerts: { webhookEnv: 'AUDIT_ALERT_URL' } },
    };
    const build = validateAuditBuild(
      config,
      (name) => environment[name as keyof typeof environment],
      'cloudflare',
    );
    environment.PB_AUDIT_POLICY = 'availability';
    config.plugins.length = 0;
    config.audit.alerts.webhookEnv = 'CHANGED_ALERT_URL';
    expect(
      resolveOrgAudit({
        build,
        storedPolicy: null,
        sinks: [{ id: 'archive', state: 'active' }],
        alertPathActive: true,
      }),
    ).toMatchObject({
      ok: true,
      effective: { policy: 'required', policySource: 'env', persistRaise: true, mode: 'export' },
    });
  });

  it('rejects accessors without invoking them or echoing thrown data', () => {
    const input = options();
    Object.defineProperty(input.config, 'audit', {
      get: () => {
        throw new Error('secret@example.test');
      },
    });
    const caught = bootError(input, 'invalid_config');
    expect(String(caught)).not.toContain('secret@example.test');
    expect(JSON.stringify(caught)).not.toContain('secret@example.test');
  });
  it('accepts availability policy env as a no-op and rejects an empty policy', () => {
    expect(
      resolveEffectiveAuditConfig(options([trail], {}, { PB_AUDIT_POLICY: 'availability' })),
    ).toMatchObject({ policy: 'availability', policySource: 'build', persistRaise: false });
    bootError(options([trail], {}, { PB_AUDIT_POLICY: '' }), 'invalid_policy_env');
  });

  it('requires a Node budget even when the composed trail is toggled off', () => {
    const input = options([trail], { acceptNoDurableAudit: true }, { PB_AUDIT_TRAIL: 'off' });
    bootError(
      { ...input, target: 'node', config: { ...input.config, platform: 'node' } },
      'journal_budget_required',
    );
  });

  it('rejects deployment required acceptance at boot', () => {
    const input = options(
      [trail],
      {},
      { PB_AUDIT_POLICY: 'required', PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT: 'true' },
    );
    let caught: unknown;
    try {
      validateAuditBuild(input.config, input.env, input.target);
    } catch (value) {
      caught = value;
    }
    expect(caught).toMatchObject({
      name: 'AuditEffectiveConfigError',
      code: 'required_acceptance',
    });
  });

  it('refuses stored required acceptance only for that organization', () => {
    const input = options([], { acceptNoDurableAudit: true });
    const build = validateAuditBuild(input.config, input.env, input.target);
    expect(resolveOrgAudit({ ...input, build, storedPolicy: 'required' })).toEqual({
      ok: false,
      code: 'required_acceptance',
      persistRaise: false,
    });
    expect(resolveOrgAudit({ ...input, build })).toMatchObject({
      ok: true,
      effective: { mode: 'none' },
    });
  });
  it.each(['REQUIRED', undefined, 'future'])('refuses invalid stored policy %j', (storedPolicy) => {
    const input = options();
    const build = validateAuditBuild(input.config, input.env, input.target);
    expect(
      resolveOrgAudit({ ...input, build, storedPolicy } as unknown as OrgAuditOptions),
    ).toEqual({
      ok: false,
      code: 'invalid_stored_policy',
      persistRaise: false,
    });
  });

  it('preserves an environment policy raise while refusing an inactive durable sink', () => {
    const input = options(
      [sink('durable')],
      { alerts: { webhookEnv: 'AUDIT_ALERT_URL' } },
      { PB_AUDIT_POLICY: 'required' },
    );
    const build = validateAuditBuild(input.config, input.env, input.target);
    expect(
      resolveOrgAudit({ ...input, build, sinks: [{ id: 'archive', state: 'inactive' }] }),
    ).toEqual({
      ok: false,
      code: 'durable_path_required',
      persistRaise: true,
    });
  });

  it.each(['build', 'env'] as const)(
    'rejects %s required without an alert route at boot',
    (source) => {
      bootError(
        options(
          [trail],
          source === 'build' ? { policy: 'required' } : {},
          source === 'env' ? { PB_AUDIT_POLICY: 'required' } : {},
        ),
        'alert_path_required',
      );
    },
  );

  it('rejects availability without sinks, trail or acceptance at boot', () => {
    bootError(options([]), 'none_not_accepted');
    bootError(options([trail], {}, { PB_AUDIT_TRAIL: 'off' }), 'none_not_accepted');
  });

  it('accepts a configured telemetry alert route for environment required', () => {
    const input = options([trail], {}, { PB_AUDIT_POLICY: 'required' });
    input.config = {
      ...input.config,
      platformPorts: {
        cloudflare: {
          blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 67108864 },
          cache: { adapter: 'cache-api', namespace: 'pb-metadata-v1' },
          jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
          observability: {
            adapter: 'workers',
            deploymentIdEnv: 'DEPLOYMENT_ID',
            endpointEnv: 'AUDIT_TELEMETRY_URL',
          },
        },
      },
    };
    expect(validateAuditBuild(input.config, input.env, input.target).policy).toBe('required');
  });
  it('reads the plugin array length once through its own data descriptor', () => {
    const input = options();
    let lengthReads = 0;
    input.config = {
      ...input.config,
      plugins: new Proxy([trail], {
        get(target, key, receiver) {
          if (key === 'length') throw new Error('ordinary length reads are forbidden');
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
          if (key === 'length') lengthReads++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }),
    };
    expect(validateAuditBuild(input.config, input.env, input.target).trailPresent).toBe(true);
    expect(lengthReads).toBe(1);
  });
});
