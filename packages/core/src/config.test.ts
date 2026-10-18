import { describe, expect, it } from 'vitest';
import {
  brokerMcpProblems,
  brokerObservabilityProblems,
  mcpEnabled,
  type BrokerConfig,
} from './config.js';

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
