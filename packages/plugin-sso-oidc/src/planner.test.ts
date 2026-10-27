import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from './definitions.js';
import { planProviders } from './planner.js';
import { parseRuntimeProviders } from './runtime.js';

function provider(id: string, issuer = `https://${id}.example.com`): ProviderConfig {
  return {
    id,
    kind: 'oidc',
    issuer,
    clientId: 'broker',
    policy: { verifiedDomains: ['example.com'], autoJoin: false },
  };
}

const parse = (entries: readonly unknown[]) => parseRuntimeProviders(JSON.stringify(entries));
const compiledSet = (length: number) =>
  Array.from({ length }, (_, index) => provider(`compiled-${index}`));
const emptyDiagnostics = { overridden: [], suppressed: [], displaced: [], overflow: [] };

describe('planProviders', () => {
  it('returns compiled providers in order when no runtime document exists', () => {
    const compiled = [provider('second'), provider('first')];
    expect(planProviders(compiled, parseRuntimeProviders(undefined))).toEqual({
      effective: compiled,
      ...emptyDiagnostics,
    });
  });

  it.each(['[', '{}', '['.padEnd(5121, ' '), JSON.stringify(Array<null>(65).fill(null))])(
    'preserves compiled providers for a broken document: %s',
    (raw) => {
      const compiled = [provider('corp')];
      const runtime = parseRuntimeProviders(raw);
      expect(runtime.documentProblem).not.toBeNull();
      expect(planProviders(compiled, runtime)).toEqual({
        effective: compiled,
        ...emptyDiagnostics,
      });
    },
  );

  it('ignores suppression and accepted entries when the document has a problem', () => {
    const compiled = [provider('corp')];
    const runtime = { ...parse([provider('corp')]), documentProblem: 'syntax' as const };
    expect(planProviders(compiled, runtime)).toEqual({
      effective: compiled,
      ...emptyDiagnostics,
    });
  });

  it('replaces the same id and appends runtime providers after compiled survivors', () => {
    const compiled = [provider('corp'), provider('survivor')];
    const replacement = provider('corp', 'https://replacement.example.com');
    const fresh = provider('fresh');
    expect(planProviders(compiled, parse([replacement, fresh]))).toEqual({
      ...emptyDiagnostics,
      effective: [compiled[1], replacement, fresh],
      overridden: ['corp'],
    });
  });

  it('suppresses an invalid runtime id without restoring its compiled version', () => {
    const survivor = provider('survivor');
    expect(planProviders([provider('corp'), survivor], parse([{ id: 'corp' }]))).toEqual({
      ...emptyDiagnostics,
      effective: [survivor],
      suppressed: ['corp'],
    });
  });

  it.each([1, 2])('displaces %i compiled entries sharing a canonical anchor', (count) => {
    const compiled = Array.from({ length: count }, (_, index) =>
      provider(`old-${index}`, 'https://IDP.example.com:443/%74enant/'),
    );
    const replacement = provider('replacement', 'https://idp.example.com/tenant');
    expect(planProviders(compiled, parse([replacement]))).toEqual({
      ...emptyDiagnostics,
      effective: [replacement],
      displaced: compiled.map(({ id }) => ({ compiled: id, by: 'replacement' })),
    });
  });

  it('does not displace a compiled anchor through a rejected runtime entry', () => {
    const compiled = [provider('corp')];
    const invalid = { ...provider('invalid', 'https://corp.example.com'), clientId: '' };
    expect(planProviders(compiled, parse([invalid]))).toEqual({
      ...emptyDiagnostics,
      effective: compiled,
    });
  });

  it('removes one compiled entry by id and another by anchor', () => {
    const replacement = provider('first', 'https://second.example.com');
    expect(planProviders([provider('first'), provider('second')], parse([replacement]))).toEqual({
      ...emptyDiagnostics,
      effective: [replacement],
      overridden: ['first'],
      displaced: [{ compiled: 'second', by: 'first' }],
    });
  });

  it('resolves all id overrides before considering swapped anchors', () => {
    const compiled = [provider('first'), provider('second')];
    const replacements = [
      provider('second', 'https://first.example.com'),
      provider('first', 'https://second.example.com'),
    ];
    expect(planProviders(compiled, parse(replacements))).toEqual({
      ...emptyDiagnostics,
      effective: replacements,
      overridden: ['first', 'second'],
    });
  });

  it('overflows a new runtime entry when all 64 compiled slots survive', () => {
    const compiled = compiledSet(64);
    expect(planProviders(compiled, parse([provider('fresh')]))).toEqual({
      ...emptyDiagnostics,
      effective: compiled,
      overflow: ['fresh'],
    });
  });

  it('allows an override when there are 64 compiled providers', () => {
    const compiled = compiledSet(64);
    const replacement = provider('compiled-0', 'https://replacement.example.com');
    const plan = planProviders(compiled, parse([replacement]));
    expect(plan).toEqual({
      ...emptyDiagnostics,
      effective: [...compiled.slice(1), replacement],
      overridden: ['compiled-0'],
    });
    expect(plan.effective).toHaveLength(64);
  });

  it('fills the last slot with the first runtime entry in document order', () => {
    const compiled = compiledSet(63);
    const first = provider('first');
    expect(planProviders(compiled, parse([first, provider('second')]))).toEqual({
      ...emptyDiagnostics,
      effective: [...compiled, first],
      overflow: ['second'],
    });
  });

  it.each([false, true])(
    'computes a late override before capacity (override first: %s)',
    (early) => {
      const compiled = compiledSet(64);
      const replacement = provider('compiled-0', 'https://replacement.example.com');
      const fresh = [provider('first'), provider('second')];
      const entries = early ? [replacement, ...fresh] : [...fresh, replacement];
      expect(planProviders(compiled, parse(entries))).toEqual({
        ...emptyDiagnostics,
        effective: [...compiled.slice(1), replacement],
        overridden: ['compiled-0'],
        overflow: ['first', 'second'],
      });
    },
  );

  it('gives a displacing runtime entry capacity before a new provider', () => {
    const compiled = compiledSet(64);
    const fresh = provider('fresh');
    const replacement = provider('replacement', 'https://compiled-0.example.com');
    expect(planProviders(compiled, parse([fresh, replacement]))).toEqual({
      ...emptyDiagnostics,
      effective: [...compiled.slice(1), replacement],
      displaced: [{ compiled: 'compiled-0', by: 'replacement' }],
      overflow: ['fresh'],
    });
  });

  it('freezes every returned array and displacement record without mutating inputs', () => {
    const compiled = Object.freeze([provider('old')]);
    const runtime = parse([provider('replacement', 'https://old.example.com')]);
    for (const plan of [
      planProviders(compiled, runtime),
      planProviders(compiled, parseRuntimeProviders('[')),
    ]) {
      for (const list of Object.values(plan)) expect(Object.isFrozen(list)).toBe(true);
      for (const entry of plan.displaced) expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(compiled).toEqual([provider('old')]);
    expect(runtime).toEqual(parse([provider('replacement', 'https://old.example.com')]));
  });

  it('matches Cloudflare Access anchors in their case-insensitive canonical form', () => {
    const access: ProviderConfig = {
      id: 'access',
      kind: 'cloudflare-access',
      teamDomain: 'corp.cloudflareaccess.com',
      audience: 'a'.repeat(64),
      trustEmailVerification: true,
      policy: { verifiedDomains: ['example.com'], autoJoin: false },
    };
    const compiled = {
      ...access,
      id: 'old',
      teamDomain: access.teamDomain.toUpperCase(),
      audience: access.audience.toUpperCase(),
    };
    const runtime = parse([access]);
    expect(runtime.accepted).toEqual([access]);
    expect(planProviders([compiled], runtime)).toEqual({
      ...emptyDiagnostics,
      effective: [access],
      displaced: [{ compiled: 'old', by: 'access' }],
    });
  });

  it('classifies a rejected id also matched by an accepted anchor only as suppressed', () => {
    const replacement = provider('replacement', 'https://corp.example.com');
    expect(planProviders([provider('corp')], parse([{ id: 'corp' }, replacement]))).toEqual({
      ...emptyDiagnostics,
      effective: [replacement],
      suppressed: ['corp'],
    });
  });

  it('deduplicates override and suppression diagnostics for repeated compiled ids', () => {
    const compiled = [provider('corp'), provider('corp'), provider('bad'), provider('bad')];
    const replacement = provider('corp', 'https://replacement.example.com');
    expect(planProviders(compiled, parse([replacement, { id: 'bad' }]))).toEqual({
      ...emptyDiagnostics,
      effective: [replacement],
      overridden: ['corp'],
      suppressed: ['bad'],
    });
  });

  it('removes same-id compiled entries even if parser suppression omits the id', () => {
    const replacement = provider('corp', 'https://replacement.example.com');
    const runtime = { ...parse([replacement]), suppressedIds: [] };
    expect(planProviders([provider('corp'), provider('corp')], runtime)).toEqual({
      ...emptyDiagnostics,
      effective: [replacement],
      overridden: ['corp'],
    });
  });

  it('reserves replacement capacity and keeps admitted runtime entries in document order', () => {
    const compiled = compiledSet(63);
    const first = provider('first');
    const override = provider('compiled-0', 'https://override.example.com');
    const displacing = provider('replacement', 'https://compiled-1.example.com');
    const runtime = parse([first, provider('second'), displacing, override]);
    expect(planProviders(compiled, runtime)).toEqual({
      ...emptyDiagnostics,
      effective: [...compiled.slice(2), first, displacing, override],
      overridden: ['compiled-0'],
      displaced: [{ compiled: 'compiled-1', by: 'replacement' }],
      overflow: ['second'],
    });
  });
});
