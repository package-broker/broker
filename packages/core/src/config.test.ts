import { describe, expect, it } from 'vitest';
import {
  brokerAssetsProblems,
  brokerVulnerabilityProblems,
  vulnerabilityEnabled,
  brokerMcpProblems,
  brokerObservabilityProblems,
  mcpEnabled,
  type BrokerConfig,
  defineAssets,
  defineConfig,
} from './config.js';
import { collectRegistrations, KernelConfigError } from './kernel/registry.js';

describe('build assets config', () => {
  const ui = defineAssets({ kind: 'ui', provider: '@package-broker/ui-assets' });
  const withAssets = (assets?: unknown): BrokerConfig =>
    ({
      platform: 'node',
      plugins: [],
      ...(assets === undefined ? {} : { assets }),
    }) as unknown as BrokerConfig;

  it('selects no assets when absent or empty', () => {
    expect(defineConfig(withAssets()).assets).toBeUndefined();
    expect(brokerAssetsProblems(withAssets())).toEqual([]);
    expect(brokerAssetsProblems(withAssets([]))).toEqual([]);
  });

  it('accepts a single ui selection', () => {
    expect(brokerAssetsProblems(withAssets([ui]))).toEqual([]);
  });

  it('rejects duplicate ui selections even with different providers', () => {
    expect(brokerAssetsProblems(withAssets([ui, { ...ui, provider: 'custom-assets' }]))).toEqual([
      'assets: duplicate ui selection',
    ]);
  });

  it('rejects unsupported kinds', () => {
    expect(brokerAssetsProblems(withAssets([{ ...ui, kind: 'secret' }]))).toEqual([
      'assets: unsupported kind',
    ]);
  });

  it.each([null, {}, 'secret', 1])('rejects a non-list selection (%#)', (value) => {
    expect(brokerAssetsProblems(withAssets(value))).toEqual(['assets: must be a list']);
  });

  it('validates each declaration', () => {
    expect(brokerAssetsProblems(withAssets([null, { kind: 'ui' }]))).toEqual([
      'assets: declaration must be an object',
      'assets: provider must be a package specifier',
    ]);
  });

  it('rejects an asset declaration placed in plugins during composition', () => {
    const selected = defineConfig({
      ...withAssets([ui]),
      plugins: [ui] as unknown as BrokerConfig['plugins'],
    });
    expect(() => collectRegistrations(selected.plugins)).toThrow(KernelConfigError);
    expect(() => collectRegistrations(selected.plugins)).toThrow('unknown key "kind"');
    expect(() => collectRegistrations(selected.plugins)).toThrow('unknown key "provider"');
  });
});

function config(observability?: unknown): BrokerConfig {
  return {
    platform: 'node',
    plugins: [],
    ...(observability === undefined ? {} : { observability }),
  } as BrokerConfig;
}

describe('brokerObservabilityProblems', () => {
  it('accepts an absent observability block', () => {
    expect(brokerObservabilityProblems(config())).toEqual([]);
  });

  it('accepts an empty block and both boolean values', () => {
    expect(brokerObservabilityProblems(config({}))).toEqual([]);
    expect(brokerObservabilityProblems(config({ trustInboundTraceparent: true }))).toEqual([]);
    expect(brokerObservabilityProblems(config({ trustInboundTraceparent: false }))).toEqual([]);
  });

  it('rejects a non-boolean flag without echoing the value', () => {
    const problems = brokerObservabilityProblems(config({ trustInboundTraceparent: 'yes-secret' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('observability.trustInboundTraceparent');
    expect(problems.join()).not.toContain('yes-secret');
  });

  it('rejects an unknown key that holds a boolean', () => {
    const problems = brokerObservabilityProblems(config({ sampleRate: true }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('unknown key');
  });

  it('rejects an unknown key without echoing its value', () => {
    const problems = brokerObservabilityProblems(config({ sampleRate: 'leak-me' }));
    expect(problems).toHaveLength(1);
    expect(problems.join()).not.toContain('leak-me');
  });

  it.each([['text'], [null], [[]], [7]])('rejects a non-object observability %j', (value) => {
    const problems = brokerObservabilityProblems({
      platform: 'node',
      plugins: [],
      observability: value,
    } as unknown as BrokerConfig);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('observability');
  });
});

function mcpConfig(mcp?: unknown): BrokerConfig {
  return { platform: 'node', plugins: [], ...(mcp === undefined ? {} : { mcp }) } as BrokerConfig;
}

describe('mcpEnabled', () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ enabled: false }, false],
    [{ enabled: true }, true],
    [{ enabled: 'true' }, false],
  ])('reads %j as %j', (mcp, enabled) => {
    expect(mcpEnabled(mcpConfig(mcp))).toBe(enabled);
  });
});

describe('brokerMcpProblems', () => {
  it.each([undefined, {}, { enabled: false }, { enabled: true }])('accepts %j', (mcp) => {
    expect(brokerMcpProblems(mcpConfig(mcp))).toEqual([]);
  });

  it('rejects a non-object block without echoing its value', () => {
    const problems = brokerMcpProblems(mcpConfig('yes'));
    expect(problems).toEqual(['mcp: must be an object']);
    expect(problems.join()).not.toContain('yes');
  });

  it('rejects a non-boolean flag without echoing its value', () => {
    const problems = brokerMcpProblems(mcpConfig({ enabled: 'true' }));
    expect(problems).toEqual(['mcp.enabled: must be a boolean']);
    expect(problems.join()).not.toContain('true');
  });

  it('rejects an unknown key without echoing its value', () => {
    const problems = brokerMcpProblems(mcpConfig({ enabled: true, extra: 1 }));
    expect(problems).toEqual(['mcp: contains an unknown key']);
    expect(problems.join()).not.toContain('1');
  });

  it.each([[null], [[]], [7]])('rejects a non-object block %j', (mcp) => {
    expect(brokerMcpProblems(mcpConfig(mcp))).toEqual(['mcp: must be an object']);
  });
});

describe('vulnerability configuration', () => {
  const input = (vulnerability?: unknown): BrokerConfig =>
    ({
      platform: 'node',
      plugins: [],
      ...(vulnerability === undefined ? {} : { vulnerability }),
    }) as BrokerConfig;
  it.each([undefined, {}, { enabled: true }, { enabled: false }])('accepts %j', (value) => {
    expect(brokerVulnerabilityProblems(input(value))).toEqual([]);
    expect(vulnerabilityEnabled(input(value))).toBe(
      value === undefined || !('enabled' in value) || value.enabled,
    );
  });
  it.each([null, [], 'secret', 42].map((value) => [value]))(
    'rejects malformed blocks %j with fixed messages',
    (value) => {
      expect(brokerVulnerabilityProblems(input(value))).toEqual([
        'vulnerability: must be an object',
      ]);
      expect(vulnerabilityEnabled(input(value))).toBe(false);
    },
  );
  it('rejects invalid flags and unknown keys without echoing sentinels', () => {
    expect(
      brokerVulnerabilityProblems(input({ enabled: 'secret@example.test', 'token-secret': true })),
    ).toEqual([
      'vulnerability.enabled: must be a boolean',
      'vulnerability: contains an unknown key',
    ]);
    expect(vulnerabilityEnabled(input({ enabled: 'true' }))).toBe(false);
  });
});
