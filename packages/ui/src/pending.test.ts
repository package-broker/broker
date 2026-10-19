import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPending, savePending, type PendingStorage } from './pending.js';

const NOW = 1_800_000_000_000;
const action = {
  method: 'POST',
  path: '/_pb/projects/p/sources',
  idempotencyKey: 'key-1',
  body: { name: 'source', auth: { value: 'redaction-sentinel', keep: true } },
  credential: false,
  secretFields: ['auth.value'],
};
const stored = {
  method: action.method,
  path: action.path,
  idempotencyKey: action.idempotencyKey,
  body: { name: 'source', auth: { keep: true } },
  savedAt: NOW,
};

function setup() {
  const entries = new Map<string, string>();
  const storage: PendingStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const raw = () => [...entries.values()][0]!;
  const seed = (value: unknown) => {
    savePending(storage, action);
    storage.setItem([...entries.keys()][0]!, JSON.stringify(value));
  };
  return { storage, entries, raw, seed };
}

afterEach(() => vi.restoreAllMocks());

describe('pending action storage', () => {
  it('removes declared nested secrets without changing the input', () => {
    const { storage, raw } = setup();
    expect(savePending(storage, action)).toEqual({ ok: true });
    expect(raw()).not.toContain('redaction-sentinel');
    expect(JSON.parse(raw())).toEqual(stored);
    expect(action.body.auth.value).toBe('redaction-sentinel');
  });

  it('omits a credential body entirely', () => {
    const { storage, raw } = setup();
    expect(savePending(storage, { ...action, credential: true })).toEqual({ ok: true });
    expect(JSON.parse(raw())).not.toHaveProperty('body');
    expect(raw()).not.toContain('redaction-sentinel');
  });

  it('removes top-level and array-index dot paths, ignoring absent paths', () => {
    const { storage, raw } = setup();
    savePending(storage, {
      ...action,
      body: { hidden: 'redaction-sentinel', items: [{ hidden: 'redaction-sentinel', keep: 1 }] },
      secretFields: ['hidden', 'items.0.hidden', 'missing.value', 'items.0.keep.child'],
    });
    expect(raw()).not.toContain('redaction-sentinel');
    expect(JSON.parse(raw()).body).toEqual({ items: [{ keep: 1 }] });
  });

  it('does not apply an implicit secret allowlist', () => {
    const { storage, raw } = setup();
    savePending(storage, {
      ...action,
      body: { password: 'ordinary-test-value' },
      secretFields: [],
    });
    expect(JSON.parse(raw()).body).toEqual({ password: 'ordinary-test-value' });
  });

  it('does not traverse inherited properties while redacting', () => {
    const { storage } = setup();
    savePending(storage, { ...action, secretFields: ['__proto__.toString'] });
    expect(Object.hasOwn(Object.prototype, 'toString')).toBe(true);
  });

  it('overwrites one fixed slot and returns the latest action once', () => {
    const { storage, entries } = setup();
    savePending(storage, action);
    savePending(storage, { ...action, idempotencyKey: 'key-2' });
    expect(entries.size).toBe(1);
    expect(loadPending(storage, NOW)).toEqual({
      ok: true,
      action: { ...stored, idempotencyKey: 'key-2' },
    });
    expect(entries.size).toBe(0);
    expect(loadPending(storage, NOW)).toEqual({ ok: true, action: null });
  });

  it('supports a request without a body or idempotency key', () => {
    const { storage } = setup();
    savePending(storage, {
      method: 'DELETE',
      path: action.path,
      credential: false,
      secretFields: [],
    });
    expect(loadPending(storage, NOW)).toEqual({
      ok: true,
      action: { method: 'DELETE', path: action.path, savedAt: NOW },
    });
  });

  it('accepts an entry exactly ten minutes old', () => {
    const { storage } = setup();
    savePending(storage, action);
    expect(loadPending(storage, NOW + 600_000)).toEqual({ ok: true, action: stored });
  });

  it('rejects and removes an entry ten minutes and one second old', () => {
    const { storage, entries } = setup();
    savePending(storage, action);
    expect(loadPending(storage, NOW + 601_000)).toEqual({ ok: true, action: null });
    expect(entries.size).toBe(0);
  });

  it('rejects and removes a future timestamp', () => {
    const { storage, seed, entries } = setup();
    seed({ ...stored, savedAt: NOW + 1 });
    expect(loadPending(storage, NOW)).toEqual({ ok: true, action: null });
    expect(entries.size).toBe(0);
  });

  it.each([
    'https://evil.example/_pb/x',
    '//evil.example/_pb/x',
    '/other/x',
    '/_pb/../x',
    '/_pb/x//y',
    '/_pb/x\\y',
    '/_pb/https:evil',
    '/_pb/%2E%2e/x',
    '/_pb/./x',
    '/_pb/x?y=z',
    '/_pb/x#y',
    '/_pb/{x}',
    '/_pb/x\ny',
  ])('refuses unsafe path %j without storing', (path) => {
    const { storage, entries } = setup();
    expect(savePending(storage, { ...action, path })).toEqual({ ok: false });
    expect(entries.size).toBe(0);
  });

  it.each([
    ['extra key', { ...stored, extra: true }],
    ['wrong method type', { ...stored, method: 1 }],
    ['unsupported method', { ...stored, method: 'INVALID' }],
    ['wrong path type', { ...stored, path: null }],
    ['unsafe stored path', { ...stored, path: '/_pb/../x' }],
    ['wrong timestamp type', { ...stored, savedAt: 'now' }],
    ['missing timestamp', { method: 'POST', path: action.path }],
    ['wrong idempotency type', { ...stored, idempotencyKey: 1 }],
    ['null', null],
    ['array', []],
  ])('rejects and removes an entry with %s', (_name, value) => {
    const { storage, seed, entries } = setup();
    seed(value);
    expect(loadPending(storage, NOW)).toEqual({ ok: true, action: null });
    expect(entries.size).toBe(0);
  });

  it('rejects and removes malformed JSON', () => {
    const { storage, entries } = setup();
    savePending(storage, action);
    storage.setItem([...entries.keys()][0]!, '{');
    expect(loadPending(storage, NOW)).toEqual({ ok: true, action: null });
    expect(entries.size).toBe(0);
  });

  it('returns failure when writing throws', () => {
    const { storage } = setup();
    storage.setItem = () => {
      throw new Error('blocked');
    };
    expect(savePending(storage, action)).toEqual({ ok: false });
  });

  it('returns failure when reading throws', () => {
    const { storage } = setup();
    storage.getItem = () => {
      throw new Error('blocked');
    };
    expect(loadPending(storage, NOW)).toEqual({ ok: false });
  });

  it('returns failure when removal throws and does not expose the action', () => {
    const { storage } = setup();
    savePending(storage, action);
    storage.removeItem = () => {
      throw new Error('blocked');
    };
    expect(loadPending(storage, NOW)).toEqual({ ok: false });
  });

  it.each([
    ['missing credential flag', { credential: undefined }],
    ['missing secret fields', { secretFields: undefined }],
    ['non-string secret field', { secretFields: [1] }],
  ])('refuses an action with %s', (_name, policy) => {
    const { storage, entries } = setup();
    expect(savePending(storage, { ...action, ...policy } as never)).toEqual({ ok: false });
    expect(entries.size).toBe(0);
  });

  it('rejects and removes a non-finite timestamp', () => {
    const { storage, entries } = setup();
    savePending(storage, action);
    storage.setItem([...entries.keys()][0]!, JSON.stringify(stored).replace(String(NOW), '1e400'));
    expect(loadPending(storage, NOW)).toEqual({ ok: true, action: null });
    expect(entries.size).toBe(0);
  });

  it('rejects and removes an entry when now is non-finite', () => {
    const { storage, entries } = setup();
    savePending(storage, action);
    expect(loadPending(storage, Number.NaN)).toEqual({ ok: true, action: null });
    expect(entries.size).toBe(0);
  });

  it('returns failure for an unserializable body', () => {
    const { storage, entries } = setup();
    expect(savePending(storage, { ...action, body: 1n })).toEqual({ ok: false });
    expect(entries.size).toBe(0);
  });
});
