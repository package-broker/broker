import { expect, it, vi } from 'vitest';
import { resolveLocalAuth } from './local-auth.js';

const source = (text: unknown) => ({
  bindings: [{ name: 'PB_AUTH_LOCAL', type: 'plain_text', text }],
});

it('resolves flag, environment, live binding and default in order', () => {
  expect(resolveLocalAuth({})).toBe('enabled');
  expect(resolveLocalAuth({ sources: [{ bindings: [] }] })).toBe('enabled');
  expect(resolveLocalAuth({ sources: [source('disabled')] })).toBe('disabled');
  expect(resolveLocalAuth({ env: 'enabled', sources: [source('disabled')] })).toBe('enabled');
  expect(resolveLocalAuth({ flag: 'disabled', env: 'disabled' })).toBe('disabled');
  expect(resolveLocalAuth({ flag: 'enabled', sources: [source('disabled')] })).toBe('enabled');
});

it.each(['', 'Enabled', 'DISABLED', 'break-glass', ' disabled', null, false, 1, {}])(
  'rejects invalid explicit or live values without disclosing them: %j',
  (value) => {
    for (const options of [{ flag: value }, { env: value }, { sources: [source(value)] }]) {
      expect(() => resolveLocalAuth(options)).toThrow(
        expect.objectContaining({ code: 'invalid_input', exitCode: 2 }),
      );
    }
  },
);

it('rejects flag/env disagreement and invalid inputs even with a valid override', () => {
  expect(() => resolveLocalAuth({ flag: 'enabled', env: 'disabled' })).toThrow(
    'PB_AUTH_LOCAL conflicts with --local-auth',
  );
  expect(() => resolveLocalAuth({ flag: 'enabled', env: 'private-value' })).toThrow(
    /^auth_local_invalid$/,
  );
  expect(() => resolveLocalAuth({ flag: 'private-value', env: 'enabled' })).toThrow(
    /^auth_local_invalid$/,
  );
  expect(() => resolveLocalAuth({ env: 'private-value', stage: 'setup' })).toThrow(
    expect.objectContaining({ stage: 'setup' }),
  );
});

it('allows explicit repair of an invalid live mode, preserving strict omission', () => {
  const sources = [source('private-value')];
  expect(() => resolveLocalAuth({ sources })).toThrow(/^auth_local_invalid$/);
  expect(resolveLocalAuth({ flag: 'enabled', sources })).toBe('enabled');
  expect(resolveLocalAuth({ env: 'disabled', sources })).toBe('disabled');
});

it('rejects duplicate, malformed and secret bindings even with explicit overrides', () => {
  const binding = source('enabled').bindings[0]!;
  for (const bindings of [
    [binding, binding],
    [{ ...binding, type: 'secret_text' }],
    [{ ...binding, type: 'json' }],
    [{ ...binding, text: null }],
    [{ name: 'PB_AUTH_LOCAL', type: 'plain_text' }],
  ]) {
    for (const flag of [undefined, 'enabled'])
      expect(() => resolveLocalAuth({ sources: [{ bindings }], flag })).toThrow(
        expect.objectContaining({ code: 'invalid_input', exitCode: 2 }),
      );
  }
  expect(() => resolveLocalAuth({ flag: 'enabled', secretNames: ['PB_AUTH_LOCAL'] })).toThrow(
    'Remove the secret first: wrangler secret delete PB_AUTH_LOCAL',
  );
  expect(
    resolveLocalAuth({ sources: [{ bindings: [null, {}, source('enabled').bindings[0]] }] }),
  ).toBe('enabled');
});

it('requires agreement across live versions unless explicitly overridden', () => {
  for (const sources of [
    [source('enabled'), source('disabled')],
    [{ bindings: [] }, source('disabled')],
  ]) {
    expect(() => resolveLocalAuth({ sources })).toThrow(
      expect.objectContaining({ code: 'configuration_conflict', exitCode: 8 }),
    );
    expect(resolveLocalAuth({ sources, flag: 'disabled' })).toBe('disabled');
  }
  expect(resolveLocalAuth({ sources: [source('disabled'), source('disabled')] })).toBe('disabled');
});

it('freezes resumed mode instead of resolving it from changed live state or ambient absence', () => {
  const frozen = { local_auth: 'disabled' as const };
  expect(resolveLocalAuth({ frozen })).toBe('disabled');
  expect(resolveLocalAuth({ frozen, sources: [source('enabled')] })).toBe('disabled');
  expect(resolveLocalAuth({ frozen, flag: 'disabled', env: 'disabled' })).toBe('disabled');
  for (const explicit of [{ flag: 'enabled' }, { env: 'enabled' }])
    expect(() => resolveLocalAuth({ frozen, ...explicit })).toThrow(
      expect.objectContaining({ code: 'configuration_conflict', exitCode: 8 }),
    );
  expect(resolveLocalAuth({ frozen: {}, sources: [source('disabled')] })).toBe('enabled');
  expect(() => resolveLocalAuth({ frozen: {}, flag: 'disabled' })).toThrow(
    expect.objectContaining({ code: 'configuration_conflict' }),
  );
});

it('never coerces or echoes invalid input into diagnostics', () => {
  const toString = vi.fn(() => 'private-value');
  for (const value of ['private-value', { toString }]) {
    for (const options of [{ flag: value }, { env: value }, { sources: [source(value)] }]) {
      try {
        resolveLocalAuth(options);
        expect.fail('invalid input was accepted');
      } catch (error) {
        expect(error).toMatchObject({ code: 'invalid_input', exitCode: 2 });
        expect((error as Error).message).not.toContain('private-value');
      }
    }
  }
  expect(toString).not.toHaveBeenCalled();
});

it('still rejects secret and duplicate bindings when resuming a frozen attempt', () => {
  const frozen = { local_auth: 'disabled' as const };
  expect(() => resolveLocalAuth({ frozen, secretNames: ['PB_AUTH_LOCAL'] })).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  const binding = source('disabled').bindings[0]!;
  expect(() => resolveLocalAuth({ frozen, sources: [{ bindings: [binding, binding] }] })).toThrow(
    'Duplicate PB_AUTH_LOCAL bindings',
  );
});
