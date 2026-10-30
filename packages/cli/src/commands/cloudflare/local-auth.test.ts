import { expect, it, vi } from 'vitest';
import { inputMessages } from './input-messages.js';
import { CloudflareError } from './api.js';
import { resolveLocalAuth } from './local-auth.js';

const source = (text: unknown) => ({
  bindings: [{ name: 'PB_AUTH_LOCAL', type: 'plain_text', text }],
});

it('resolves flag, environment, live binding and default in order', () => {
  expect(resolveLocalAuth({ sources: null })).toBe('enabled');
  expect(resolveLocalAuth({ sources: [{ bindings: [] }] })).toBe('enabled');
  expect(resolveLocalAuth({ sources: [source('disabled')] })).toBe('disabled');
  expect(resolveLocalAuth({ env: 'enabled', sources: [source('disabled')] })).toBe('enabled');
  expect(resolveLocalAuth({ sources: null, flag: 'disabled', env: 'disabled' })).toBe('disabled');
  expect(resolveLocalAuth({ flag: 'enabled', sources: [source('disabled')] })).toBe('enabled');
});

it.each(['', 'Enabled', 'DISABLED', 'break-glass', ' disabled', null, false, 1, {}])(
  'rejects invalid explicit or live values without disclosing them: %j',
  (value) => {
    for (const options of [{ flag: value }, { env: value }, { sources: [source(value)] }]) {
      expect(() => resolveLocalAuth({ sources: null, ...options })).toThrow(
        expect.objectContaining({ code: 'invalid_input', exitCode: 2 }),
      );
    }
  },
);

it('rejects flag/env disagreement and invalid inputs even with a valid override', () => {
  expect(() => resolveLocalAuth({ sources: null, flag: 'enabled', env: 'disabled' })).toThrow(
    'PB_AUTH_LOCAL conflicts with --local-auth',
  );
  expect(() => resolveLocalAuth({ sources: null, flag: 'enabled', env: 'private-value' })).toThrow(
    /^auth_local_invalid$/,
  );
  expect(() => resolveLocalAuth({ sources: null, flag: 'private-value', env: 'enabled' })).toThrow(
    /^auth_local_invalid$/,
  );
  expect(() => resolveLocalAuth({ sources: null, env: 'private-value', stage: 'setup' })).toThrow(
    expect.objectContaining({ stage: 'setup' }),
  );
});

it('allows explicit repair of an invalid live mode, preserving strict omission', () => {
  const sources = [source('private-value')];
  expect(() => resolveLocalAuth({ sources })).toThrow(/^Invalid live PB_AUTH_LOCAL binding$/);
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
  expect(() =>
    resolveLocalAuth({ sources: null, flag: 'enabled', secretNames: ['PB_AUTH_LOCAL'] }),
  ).toThrow('Remove the secret first: wrangler secret delete PB_AUTH_LOCAL');
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
    for (const flag of ['enabled', 'disabled'] as const)
      expect(resolveLocalAuth({ sources, flag })).toBe(flag);
  }
  expect(resolveLocalAuth({ sources: [source('disabled'), source('disabled')] })).toBe('disabled');
});

it('freezes resumed mode instead of resolving it from changed live state or ambient absence', () => {
  const frozen = { local_auth: 'disabled' as const };
  expect(resolveLocalAuth({ sources: null, frozen })).toBe('disabled');
  expect(resolveLocalAuth({ frozen, sources: [source('enabled')] })).toBe('disabled');
  expect(resolveLocalAuth({ sources: null, frozen, flag: 'disabled', env: 'disabled' })).toBe(
    'disabled',
  );
  for (const explicit of [{ flag: 'enabled' }, { env: 'enabled' }])
    expect(() => resolveLocalAuth({ sources: null, frozen, ...explicit })).toThrow(
      expect.objectContaining({ code: 'configuration_conflict', exitCode: 8 }),
    );
});

it('never coerces or echoes invalid input into diagnostics', () => {
  const toString = vi.fn(() => 'private-value');
  for (const value of ['private-value', { toString }]) {
    for (const options of [{ flag: value }, { env: value }, { sources: [source(value)] }]) {
      try {
        resolveLocalAuth({ sources: null, ...options });
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
  expect(() => resolveLocalAuth({ sources: null, frozen, secretNames: ['PB_AUTH_LOCAL'] })).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  const binding = source('disabled').bindings[0]!;
  expect(() => resolveLocalAuth({ frozen, sources: [{ bindings: [binding, binding] }] })).toThrow(
    'Duplicate PB_AUTH_LOCAL bindings',
  );
});

it('resolves legacy frozen attempts from live state and refuses conflicting explicit input', () => {
  const sources = [source('disabled')];
  expect(resolveLocalAuth({ frozen: {}, sources })).toBe('disabled');
  expect(resolveLocalAuth({ frozen: {}, sources, flag: 'disabled' })).toBe('disabled');
  for (const explicit of [{ flag: 'enabled' }, { env: 'enabled' }])
    expect(() => resolveLocalAuth({ frozen: {}, sources, ...explicit })).toThrow(
      expect.objectContaining({ code: 'configuration_conflict', fields: ['local_auth'] }),
    );
  expect(resolveLocalAuth({ frozen: {}, sources: [{ bindings: [] }] })).toBe('enabled');
});

it('requires a successful live read or explicit absence of a Worker', () => {
  expect(resolveLocalAuth({ sources: null })).toBe('enabled');
  for (const sources of [undefined, [], [{}], [source('disabled'), {}], [undefined], Array(1)]) {
    for (const extra of [{}, { flag: 'enabled' }, { frozen: { local_auth: 'enabled' } }]) {
      expect(() => resolveLocalAuth({ sources, ...extra } as never)).toThrow(
        expect.objectContaining({
          code: 'invalid_input',
          message: 'Local auth live state is incomplete',
        }),
      );
    }
  }
});

it('registers fixed input reasons for the deploy failure wrapper', () => {
  for (const [options, message] of [
    [{ flag: 'private-value' }, 'auth_local_invalid'],
    [{ env: 'private-value' }, 'auth_local_invalid'],
    [{ sources: [source('private-value')] }, 'Invalid live PB_AUTH_LOCAL binding'],
    [{ flag: 'enabled', env: 'disabled' }, 'PB_AUTH_LOCAL conflicts with --local-auth'],
    [
      { secretNames: ['PB_AUTH_LOCAL'] },
      'Remove the secret first: wrangler secret delete PB_AUTH_LOCAL',
    ],
    [
      { sources: [{ bindings: [{ name: 'PB_AUTH_LOCAL', type: 'secret_text' }] }] },
      'Remove the secret first: wrangler secret delete PB_AUTH_LOCAL',
    ],
  ] as const) {
    try {
      resolveLocalAuth({ sources: null, ...options });
      expect.fail('invalid input was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareError);
      expect(inputMessages.get(error as CloudflareError)).toBe(message);
      expect((error as Error).message).toBe(message);
    }
  }
});
