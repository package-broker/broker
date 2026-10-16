import { describe, expect, it } from 'vitest';
import type { SourceProvider } from '../sources/provider.js';
import type { PluginDefinition } from '../plugin.js';
import { KernelConfigError, collectRegistrations } from './registry.js';

function plugin(id: string, overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id,
    package: `@test/${id}`,
    apiVersion: 3,
    platforms: ['node'],
    ...overrides,
  };
}

function provider(id: string): SourceProvider {
  return {
    id,
    sourceTypes: [],
    ecosystems: [],
    describe: () => Promise.resolve({ kind: 'not_found', definitive: false }),
    openDist: () => Promise.reject(new Error('unused')),
  } as unknown as SourceProvider;
}

function problemsOf(plugins: readonly PluginDefinition[]): readonly string[] {
  try {
    collectRegistrations(plugins);
  } catch (error) {
    expect(error).toBeInstanceOf(KernelConfigError);
    return (error as KernelConfigError).problems;
  }
  throw new Error('expected KernelConfigError');
}

describe('source providers in collectRegistrations', () => {
  it('registers providers keyed by id and binds source', () => {
    const github = provider('github');
    const result = collectRegistrations([
      plugin('gh', { binds: ['source'], sourceProviders: () => [github] }),
    ]);
    expect(result.bindings.get('source')).toBe('gh');
    expect([...result.sourceProviders.keys()]).toEqual(['github']);
    expect(result.sourceProviders.get('github')).toBe(github);
  });

  it('has no source providers when no plugin binds source', () => {
    expect(collectRegistrations([plugin('a')]).sourceProviders.size).toBe(0);
  });

  it('calls the factory without arguments', () => {
    let received: unknown[] | null = null;
    collectRegistrations([
      plugin('gh', {
        binds: ['source'],
        sourceProviders: (...args: unknown[]) => {
          received = args;
          return [];
        },
      }),
    ]);
    expect(received).toEqual([]);
  });

  it('rejects binds source without sourceProviders', () => {
    expect(problemsOf([plugin('gh', { binds: ['source'] })])).toEqual([
      'plugin "gh" binds source but has no sourceProviders',
    ]);
  });

  it('rejects sourceProviders without the source bind', () => {
    expect(problemsOf([plugin('gh', { sourceProviders: () => [] })])).toEqual([
      'plugin "gh" has sourceProviders but does not bind source',
    ]);
    expect(
      problemsOf([plugin('gh', { binds: ['identity'], sourceProviders: () => [] })]),
    ).toContain('plugin "gh" has sourceProviders but does not bind source');
  });

  it.each([['text'], [42], [null], [{}]])('rejects a non-function sourceProviders %j', (value) => {
    expect(
      problemsOf([plugin('gh', { binds: ['source'], sourceProviders: value as never })]),
    ).toEqual(['plugin "gh" sourceProviders must be a function']);
  });

  it('rejects sourceProviders on apiVersion 2', () => {
    expect(
      problemsOf([plugin('gh', { apiVersion: 2, binds: ['source'], sourceProviders: () => [] })]),
    ).toEqual(['plugin "gh" declares sourceProviders and requires apiVersion 3']);
  });

  it('fails when two plugins supply the same provider id', () => {
    const problems = problemsOf([
      plugin('a', { binds: ['source'], sourceProviders: () => [provider('git')] }),
      plugin('b', { binds: ['source'], sourceProviders: () => [provider('git')] }),
    ]);
    expect(problems).toContain('source provider "git" is supplied by plugins "a" and "b"');
  });

  it('fails when one factory returns the same id twice', () => {
    expect(
      problemsOf([
        plugin('a', {
          binds: ['source'],
          sourceProviders: () => [provider('git'), provider('git')],
        }),
      ]),
    ).toEqual(['source provider "git" is supplied by plugins "a" and "a"']);
  });

  it('rejects a factory that throws, returns a non-array or yields an invalid provider', () => {
    expect(
      problemsOf([
        plugin('a', {
          binds: ['source'],
          sourceProviders: () => {
            throw new TypeError('secret-token');
          },
        }),
      ]),
    ).toEqual(['plugin "a" sourceProviders threw TypeError']);
    expect(
      problemsOf([plugin('a', { binds: ['source'], sourceProviders: (() => 1) as never })]),
    ).toEqual(['plugin "a" sourceProviders must return an array']);
    expect(
      problemsOf([
        plugin('a', { binds: ['source'], sourceProviders: (() => [{ id: '' }]) as never }),
      ]),
    ).toEqual(['plugin "a" sourceProviders returned a provider without an id']);
  });

  it('rejects an async factory without leaving an unhandled rejection', () => {
    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      expect(
        problemsOf([
          plugin('a', {
            binds: ['source'],
            sourceProviders: (() => Promise.reject(new Error('secret-token'))) as never,
          }),
        ]),
      ).toEqual(['plugin "a" sourceProviders must be synchronous']);
      return new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
        expect(rejections).toEqual([]);
      });
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});
