import { describe, expect, it } from 'vitest';
import { brokerObservabilityProblems, type BrokerConfig } from './config.js';

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
