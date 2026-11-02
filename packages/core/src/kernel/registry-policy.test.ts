import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HookMap, PluginDefinition } from '../plugin.js';
import { KernelConfigError, collectRegistrations } from './registry.js';

const first: HookMap['registry.read'] = () => undefined;
const second: HookMap['registry.read'] = () => ({ deny: true, reason: 'restricted' });

function plugin(id: string, overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id,
    package: `@test/${id}`,
    apiVersion: 4,
    platforms: ['node', 'cloudflare'],
    ...overrides,
  };
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

describe('registry.read registration', () => {
  it('collects API 4 hooks in compiled registration order with their plugin ids', () => {
    const { hooks } = collectRegistrations([
      plugin('a', {
        register(registry) {
          registry.hook('registry.read', first);
        },
      }),
      plugin('b', {
        register(registry) {
          registry.hook('registry.read', second);
          registry.hook('registry.read', first);
        },
      }),
    ]);
    expect(hooks['registry.read']).toEqual([
      { plugin: 'a', handler: first },
      { plugin: 'b', handler: second },
      { plugin: 'b', handler: first },
    ]);
  });

  it('freezes the order so it cannot change after composition', () => {
    const { hooks } = collectRegistrations([
      plugin('a', {
        register(registry) {
          registry.hook('registry.read', first);
        },
      }),
    ]);
    const list = hooks['registry.read'] as Array<unknown>;
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => list.push({ plugin: 'late', handler: second })).toThrow(TypeError);
    expect(() => {
      list[0] = { plugin: 'swapped', handler: second };
    }).toThrow(TypeError);
  });

  it('starts empty, so a build without policy plugins has no hooks', () => {
    expect(collectRegistrations([plugin('quiet')]).hooks['registry.read']).toEqual([]);
  });

  it('refuses the hook from an API 3 plugin', () => {
    expect(
      problemsOf([
        plugin('legacy', {
          apiVersion: 3,
          register(registry) {
            registry.hook('registry.read', first);
          },
        }),
      ]),
    ).toEqual(['plugin "legacy" hook "registry.read" requires apiVersion 4']);
  });

  it('keeps rejecting unknown hook names and non-function handlers', () => {
    expect(
      problemsOf([
        plugin('typo', {
          register(registry) {
            (registry.hook as (name: string, handler: unknown) => void)('registry.reads', first);
            registry.hook('registry.read', 'nope' as never);
          },
        }),
      ]),
    ).toEqual([
      'plugin "typo" registered unknown hook "registry.reads"',
      'plugin "typo" hook "registry.read" handler must be a function',
    ]);
  });

  it('has no runtime loader: policy code never imports modules dynamically', () => {
    const dir = new URL('../registry/policy/', import.meta.url);
    const sources = readdirSync(dir).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const text = readFileSync(new URL(name, dir), 'utf8');
      expect(text, name).not.toMatch(/\bimport\s*\(|\brequire\s*\(|new Function|\beval\s*\(/);
    }
  });
});
