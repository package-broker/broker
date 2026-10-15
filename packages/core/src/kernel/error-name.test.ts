import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../db/errors.js';
import { KernelConfigError } from './registry.js';
import { reportableErrorName } from './error-name.js';

describe('reportableErrorName', () => {
  it.each([
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ReferenceError',
    'EvalError',
    'URIError',
    'AggregateError',
    'DOMException',
    'AbortError',
    'TimeoutError',
    'OidcProviderError',
    'NonError',
  ])('returns the allowlisted name %s', (name) => {
    const error = new Error('x');
    error.name = name;

    expect(reportableErrorName(error)).toBe(name);
  });

  it('returns the name of a project error class', () => {
    expect(reportableErrorName(new KernelConfigError(['bad']))).toBe('KernelConfigError');
    expect(reportableErrorName(new DbError('busy', 'busy'))).toBe('DbError');
  });

  it('returns a standard error name', () => {
    expect(reportableErrorName(new TypeError('x'))).toBe('TypeError');
  });

  it('maps arbitrary plugin text to Error', () => {
    const error = new Error('boom');
    error.name = 'ada@example.test token=x';

    expect(reportableErrorName(error)).toBe('Error');
  });

  it('never invokes a name getter', () => {
    const getter = vi.fn(() => 'TypeError');
    const error = new Error('x');
    Object.defineProperty(error, 'name', { get: getter });

    expect(reportableErrorName(error)).toBe('Error');
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', 'ada@example.test token=x'],
    ['a number', 42],
    ['a boolean', true],
    ['undefined', undefined],
    ['null', null],
    ['a symbol', Symbol('x')],
    ['a bigint', 1n],
    ['a function', () => undefined],
  ])('maps %s to Error', (_label, value) => {
    expect(reportableErrorName(value)).toBe('Error');
  });

  it('maps a hostile prototype lookup to Error', () => {
    const trap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('ada@example.test token=x');
        },
      },
    );

    expect(reportableErrorName(trap)).toBe('Error');
  });

  it('never invokes a name getter on a class prototype', () => {
    const getter = vi.fn(() => 'TypeError');
    class Hostile extends Error {
      override get name(): string {
        return getter();
      }
    }

    expect(reportableErrorName(new Hostile('x'))).toBe('Error');
    expect(getter).not.toHaveBeenCalled();
  });

  it('reports an allowlisted data name inherited through a custom prototype', () => {
    const proto = { name: 'DbError' };

    expect(reportableErrorName(Object.create(proto))).toBe('DbError');
    expect(reportableErrorName(Object.create({ name: 'plugin text' }))).toBe('Error');
  });

  it.each([[42], [null], [{}], [['TypeError']]])('maps a non-string name %j to Error', (name) => {
    const error = new Error('x');
    Object.defineProperty(error, 'name', { value: name });

    expect(reportableErrorName(error)).toBe('Error');
  });

  it('reads the name of a genuine DOMException', () => {
    expect(reportableErrorName(new DOMException('x', 'AbortError'))).toBe('AbortError');
    expect(reportableErrorName(new DOMException('x', 'TimeoutError'))).toBe('TimeoutError');
    expect(reportableErrorName(new DOMException('x', 'plugin text'))).toBe('Error');
    expect(reportableErrorName(AbortSignal.abort().reason)).toBe('AbortError');
  });

  it('maps a DOMException look-alike to Error', () => {
    expect(reportableErrorName(Object.create(DOMException.prototype))).toBe('Error');
  });

  it('stops a prototype cycle after a bounded walk', () => {
    const cyclic: object = new Proxy({}, { getPrototypeOf: (): object => cyclic });

    expect(reportableErrorName(cyclic)).toBe('Error');
  });
});
