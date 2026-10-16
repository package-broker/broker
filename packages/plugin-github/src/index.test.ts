import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { describe, expect, it } from 'vitest';
import github from './index.js';

describe('plugin-github', () => {
  it('declares its plugin definition', () => {
    const plugin = github();
    expect(plugin.id).toBe('github');
    expect(plugin.apiVersion).toBe(3);
  });

  it('registers through collectRegistrations', () => {
    expect(() => collectRegistrations([github()])).not.toThrow();
  });
});
