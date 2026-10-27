import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RUNTIME_DOCUMENT_BYTES,
  MAX_RUNTIME_PROVIDERS,
  parseRuntimeProviders,
  RUNTIME_PROVIDERS_VARIABLE,
} from './runtime.js';

const corp = {
  id: 'corp',
  kind: 'oidc',
  issuer: 'https://idp.example.com',
  clientId: 'broker',
  policy: { verifiedDomains: ['example.com'], autoJoin: false },
} as const;
const second = { ...corp, id: 'second', issuer: 'https://second.example.com' };
const parse = (entries: readonly unknown[]) => parseRuntimeProviders(JSON.stringify(entries));
const empty = { accepted: [], rejected: [], suppressedIds: [], documentProblem: null };

function expectFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectFrozen(child);
}

describe('parseRuntimeProviders', () => {
  it('names the runtime binding and byte cap', () => {
    expect(RUNTIME_PROVIDERS_VARIABLE).toBe('PB_IDP_PROVIDERS');
    expect(MAX_RUNTIME_DOCUMENT_BYTES).toBe(5120);
    expect(MAX_RUNTIME_PROVIDERS).toBe(64);
  });

  it.each([undefined, '', '   '])('treats %j as absent', (raw) => {
    expect(parseRuntimeProviders(raw)).toEqual(empty);
  });

  it('parses valid JSON at exactly 5120 raw bytes', () => {
    const raw = JSON.stringify([corp]).padEnd(5120, ' ');
    expect(new TextEncoder().encode(raw)).toHaveLength(5120);
    expect(parseRuntimeProviders(raw)).toEqual({
      ...empty,
      accepted: [corp],
      suppressedIds: ['corp'],
    });
  });

  it.each([
    JSON.stringify([corp]).padEnd(5121, ' '),
    `["${'é'.repeat(2560)}"]`,
    '['.padEnd(5121, ' '),
  ])('rejects oversized text before parsing', (raw) => {
    expect(parseRuntimeProviders(raw)).toEqual({ ...empty, documentProblem: 'too_large' });
  });

  it('counts UTF-8 bytes rather than characters', () => {
    const raw = `["${'é'.repeat(2560)}"]`;
    expect(raw.length).toBeLessThan(5120);
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(5120);
    expect(parseRuntimeProviders(raw).documentProblem).toBe('too_large');
  });

  it('accepts a multibyte document of exactly 5120 bytes', () => {
    const provider = { ...corp, displayName: 'Société' };
    const json = JSON.stringify([provider]);
    const raw = json + ' '.repeat(5120 - new TextEncoder().encode(json).length);
    expect(new TextEncoder().encode(raw)).toHaveLength(5120);
    expect(raw.length).toBeLessThan(5120);
    expect(parseRuntimeProviders(raw)).toEqual({
      ...empty,
      accepted: [provider],
      suppressedIds: ['corp'],
    });
  });

  it('rejects multi-megabyte values before encoding them', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      expect(parseRuntimeProviders('['.repeat(2_000_000))).toEqual({
        ...empty,
        documentProblem: 'too_large',
      });
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it.each([
    ['[{"id":"corp"},', 'syntax'],
    ['{}', 'not_array'],
    ['"x"', 'not_array'],
    ['null', 'not_array'],
    [JSON.stringify([{ id: 'corp' }, ...Array<null>(64).fill(null)]), 'over_cap'],
  ])('rejects the entire document for %s', (raw, documentProblem) => {
    expect(parseRuntimeProviders(raw)).toEqual({ ...empty, documentProblem });
  });

  it('allows 64 elements through semantic validation', () => {
    const result = parse(Array<null>(64).fill(null));
    expect(result.documentProblem).toBeNull();
    expect(result.rejected).toHaveLength(64);
  });

  it('keeps both good entries around a bad entry', () => {
    const result = parse([corp, null, second]);
    expect(result.accepted).toEqual([corp, second]);
    expect(result.rejected).toEqual([
      {
        index: 1,
        codes: ['unreadable'],
        problems: ['providers[1]: configuration must be an object'],
      },
    ]);
    expect(result.suppressedIds).toEqual(['corp', 'second']);
  });

  it('suppresses valid unreserved ids from invalid entries in first-seen order', () => {
    const result = parse([
      { id: 'corp' },
      second,
      { id: 'corp' },
      { id: 'local' },
      { id: 'Corp' },
      { id: 42 },
      null,
      ['corp'],
      { id: 'third', kind: 'unsupported' },
    ]);
    expect(result.suppressedIds).toEqual(['corp', 'second', 'third']);
  });

  it('rejects both definitions of a duplicate id', () => {
    const result = parse([corp, { ...second, id: 'corp' }]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map(({ index, id, codes }) => ({ index, id, codes }))).toEqual([
      { index: 0, id: 'corp', codes: ['duplicate_id'] },
      { index: 1, id: 'corp', codes: ['duplicate_id'] },
    ]);
    expect(result.suppressedIds).toEqual(['corp']);
  });

  it('rejects a good entry when a later invalid entry duplicates its id', () => {
    const result = parse([corp, { id: 'corp' }, second]);
    expect(result.accepted).toEqual([second]);
    expect(result.rejected.map((entry) => entry.codes)).toEqual([
      ['duplicate_id'],
      ['duplicate_id', 'kind'],
    ]);
  });

  it('rejects all three definitions sharing an anchor under different ids', () => {
    const result = parse([corp, { ...corp, id: 'second' }, { ...corp, id: 'third' }]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map(({ index, id, codes }) => ({ index, id, codes }))).toEqual([
      { index: 0, id: 'corp', codes: ['duplicate_anchor'] },
      { index: 1, id: 'second', codes: ['duplicate_anchor'] },
      { index: 2, id: 'third', codes: ['duplicate_anchor'] },
    ]);
  });

  it('retains both duplicate codes and original indexes across other rejections', () => {
    const result = parse([null, corp, second, corp]);
    expect(result.accepted).toEqual([second]);
    expect(result.rejected.map(({ index, codes }) => ({ index, codes }))).toEqual([
      { index: 0, codes: ['unreadable'] },
      { index: 1, codes: ['duplicate_anchor', 'duplicate_id'] },
      { index: 3, codes: ['duplicate_anchor', 'duplicate_id'] },
    ]);
  });

  it('keeps distinct real indexes when an unreadable entry precedes duplicates', () => {
    const unreadable = { ...corp, scopes: Array<string>(33).fill('openid') };
    const result = parse([unreadable, corp, { ...corp, id: 'third' }]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map(({ index, id, codes }) => ({ index, id, codes }))).toEqual([
      { index: 0, id: undefined, codes: ['duplicate_anchor', 'duplicate_id', 'unreadable'] },
      { index: 1, id: 'corp', codes: ['duplicate_anchor', 'duplicate_id'] },
      { index: 2, id: 'third', codes: ['duplicate_anchor'] },
    ]);
    expect(result.rejected[0]?.problems).toContain(
      'providers[0]: configuration must be a readable object',
    );
    expect(result.rejected[1]?.problems).toContain('providers[1]: id duplicates providers[0]');
    expect(result.rejected[1]?.problems).toContain(
      'providers[1]: trust anchor duplicates providers[0]',
    );
    expectFrozen(result);
  });

  it('rejects both a good provider and a duplicate with 33 scopes', () => {
    const result = parse([corp, { ...corp, scopes: Array<string>(33).fill('openid') }]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.codes)).toEqual([
      ['duplicate_anchor', 'duplicate_id'],
      ['duplicate_anchor', 'duplicate_id', 'unreadable'],
    ]);
    expect(result.rejected[0]?.problems).toEqual([
      'providers[0]: id duplicates providers[1]',
      'providers[0]: trust anchor duplicates providers[1]',
    ]);
  });

  it('rejects both providers sharing an anchor even when one policy is invalid', () => {
    const result = parse([corp, { ...corp, id: 'second', policy: { bogus: 1 } }]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map(({ index, id, codes }) => ({ index, id, codes }))).toEqual([
      { index: 0, id: 'corp', codes: ['duplicate_anchor'] },
      { index: 1, id: 'second', codes: ['duplicate_anchor', 'kind_rules'] },
    ]);
    expect(result.rejected[1]?.problems.join(' ')).toContain('unsupported key "bogus"');
    expect(result.rejected[1]?.problems).toContain(
      'providers[1]: trust anchor duplicates providers[0]',
    );
  });

  it('rejects all three duplicate ids with the other lowest index in each problem', () => {
    const result = parse([
      corp,
      { ...second, id: 'corp' },
      { ...corp, issuer: 'https://third.example.com' },
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual(
      [1, 0, 0].map((other, index) => ({
        index,
        id: 'corp',
        codes: ['duplicate_id'],
        problems: [`providers[${index}]: id duplicates providers[${other}]`],
      })),
    );
  });

  it('compares canonical raw anchors even when one issuer fails validation', () => {
    const result = parse([corp, { ...corp, id: 'second', issuer: 'https://IDP.EXAMPLE.COM:443/' }]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.codes)).toEqual([
      ['duplicate_anchor'],
      ['duplicate_anchor', 'kind_rules'],
    ]);
  });

  it('adds duplicate codes to already rejected unsafe ids without echoing the id', () => {
    const result = parse([
      { ...corp, id: 'Corp' },
      { ...second, id: 'Corp' },
    ]);
    expect(result.accepted).toEqual([]);
    for (const rejection of result.rejected) {
      expect(rejection.codes).toEqual(['duplicate_id', 'field:id', 'kind_rules']);
      expect(rejection).not.toHaveProperty('id');
    }
    expectFrozen(result);
  });

  it('rejects duplicate Access anchors', () => {
    const access = {
      id: 'access',
      kind: 'cloudflare-access',
      teamDomain: 'team.cloudflareaccess.com',
      audience: 'ab12'.repeat(16),
      trustEmailVerification: true,
      policy: corp.policy,
    };
    const result = parse([access, { ...access, id: 'other' }]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.codes)).toEqual([
      ['duplicate_anchor'],
      ['duplicate_anchor'],
    ]);
  });

  it.each(['__proto__', 'constructor'])('rejects own %s keys without pollution', (key) => {
    for (const inPolicy of [false, true]) {
      const extra = `"${key}":{"runtimePolluted":true}`;
      const raw = inPolicy
        ? JSON.stringify([corp]).replace('"autoJoin":false', `"autoJoin":false,${extra}`)
        : JSON.stringify([corp]).replace('"id":"corp"', `"id":"corp",${extra}`);
      const result = parseRuntimeProviders(raw);
      expect(result.accepted).toEqual([]);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.codes).toContain('kind_rules');
      expect(result.rejected[0]?.problems.join(' ')).toContain(`unsupported key "${key}"`);
      expect(result.suppressedIds).toEqual(['corp']);
      expect(Object.hasOwn(Object.prototype, 'runtimePolluted')).toBe(false);
    }
  });

  it('handles deep nesting within the byte bound without throwing', () => {
    const raw = '['.repeat(2500) + '0' + ']'.repeat(2500);
    expect(new TextEncoder().encode(raw).length).toBeLessThan(5120);
    const result = parseRuntimeProviders(raw);
    expect(result.accepted).toEqual([]);
    expect(result.documentProblem === 'syntax' || result.rejected.length > 0).toBe(true);
  });

  it('handles deep nesting inside policy without throwing', () => {
    const nested = '['.repeat(2400) + '0' + ']'.repeat(2400);
    const raw = JSON.stringify([{ ...corp, policy: null }]).replace(
      '"policy":null',
      `"policy":${nested}`,
    );
    expect(new TextEncoder().encode(raw).length).toBeLessThan(5120);
    const result = parseRuntimeProviders(raw);
    expect(result.accepted).toEqual([]);
    expect(result.documentProblem === 'syntax' || result.rejected.length === 1).toBe(true);
  });

  it('freezes results and all returned arrays and entries', () => {
    for (const result of [
      parseRuntimeProviders(undefined),
      parseRuntimeProviders('{'),
      parse([corp, null, second]),
      parse([corp, corp]),
    ])
      expectFrozen(result);
  });
});
