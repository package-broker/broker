import { describe, expect, it } from 'vitest';
import type { ProviderContext, ProviderSource } from './provider.js';
import { UpstreamError } from './policy-fetch.js';
import {
  ProviderRegistryError,
  SESSION_PAGE_CAP,
  assertDescribeResult,
  collectListing,
  createPackageDescription,
  createProviderRegistry,
  isPackageDescription,
  snapshotRef,
  type ListingInput,
  type ListingPage,
  type SnapshotRef,
  type SourceProvider,
  type VersionCandidate,
} from './provider.js';

const snap = (id: string): SnapshotRef => snapshotRef(`"${id}"`);

function provider(id: string, sourceTypes: SourceProvider['sourceTypes']): SourceProvider {
  return {
    id,
    sourceTypes,
    ecosystems: ['composer'],
    describe: () => Promise.resolve({ kind: 'not_found', definitive: false }),
    openDist: () => Promise.reject(new Error('unused')),
  };
}

async function* members(
  count: number,
  failAt?: number,
  ordinalOf: (index: number) => number = (index) => index,
): AsyncGenerator<VersionCandidate> {
  for (let index = 0; index < count; index += 1) {
    if (index === failAt) throw new Error('stream broke');
    yield { ordinal: ordinalOf(index), version: `1.0.${index}`, form: 'composer-p2', raw: '{}' };
  }
}

async function drain(source: AsyncIterable<VersionCandidate>): Promise<number> {
  let seen = 0;
  for await (const member of source) {
    void member;
    seen += 1;
  }
  return seen;
}

const base = { name: 'acme/pkg', snapshot: snap('etag-1'), validators: {} };

describe('snapshotRef', () => {
  it('accepts strong ETags and byte digests', () => {
    expect(snapshotRef('"abc"').id).toBe('"abc"');
    expect(snapshotRef(`sha256:${'a'.repeat(64)}`).id).toContain('sha256:');
  });

  it('rejects weak ETags and anything else', () => {
    for (const id of [
      'W/"abc"',
      'abc',
      '',
      'sha256:xyz',
      '""',
      `sha256:${'A'.repeat(64)}`,
      '"open',
    ]) {
      expect(() => snapshotRef(id)).toThrow(TypeError);
    }
  });
});

describe('createPackageDescription', () => {
  it('is complete only after every member was read and documents were complete', async () => {
    const description = createPackageDescription({
      ...base,
      members: members(3),
      documentsComplete: true,
    });
    expect(isPackageDescription(description)).toBe(true);
    expect(isPackageDescription({ ...description })).toBe(false);
    expect(description.upstreamComplete).toBe(false);
    expect(await drain(description.members)).toBe(3);
    expect(description.upstreamComplete).toBe(true);
  });

  it('reports incomplete when the member stream errors', async () => {
    const description = createPackageDescription({
      ...base,
      members: members(3, 1),
      documentsComplete: true,
    });
    await expect(drain(description.members)).rejects.toThrow('stream broke');
    expect(description.upstreamComplete).toBe(false);
  });

  it('reports incomplete when the consumer stops early', async () => {
    const description = createPackageDescription({
      ...base,
      members: members(3),
      documentsComplete: true,
    });
    for await (const member of description.members) {
      void member;
      break;
    }
    expect(description.upstreamComplete).toBe(false);
  });

  it('reports incomplete when a document was not fully returned', async () => {
    const description = createPackageDescription({
      ...base,
      members: members(2),
      documentsComplete: false,
    });
    await drain(description.members);
    expect(description.upstreamComplete).toBe(false);
  });

  it('reads a deferred documentsComplete after the members are drained', async () => {
    let complete = true;
    const description = createPackageDescription({
      ...base,
      members: members(2),
      documentsComplete: () => complete,
    });
    await drain(description.members);
    expect(description.upstreamComplete).toBe(true);
    complete = false;
    expect(description.upstreamComplete).toBe(false);
  });

  it('stays incomplete when next() is called again after a rejection', async () => {
    for (const ordinalOf of [undefined, () => 0]) {
      const description = createPackageDescription({
        ...base,
        members: members(3, ordinalOf === undefined ? 1 : undefined, ordinalOf),
        documentsComplete: true,
      });
      const iterator = description.members[Symbol.asyncIterator]();
      let rejected = false;
      for (let step = 0; step < 6 && !rejected; step += 1) {
        try {
          await iterator.next();
        } catch {
          rejected = true;
        }
      }
      expect(rejected).toBe(true);
      for (let step = 0; step < 4; step += 1) await iterator.next().catch(() => undefined);
      expect(description.upstreamComplete).toBe(false);
    }
  });

  it('allows the members to be read only once', async () => {
    const description = createPackageDescription({
      ...base,
      members: members(1),
      documentsComplete: true,
    });
    await drain(description.members);
    await expect(drain(description.members)).rejects.toThrow(/already/);
  });

  it('throws on non-increasing ordinals', async () => {
    for (const ordinalOf of [() => 0, (index: number) => 5 - index]) {
      const description = createPackageDescription({
        ...base,
        members: members(3, undefined, ordinalOf),
        documentsComplete: true,
      });
      await expect(drain(description.members)).rejects.toThrow(RangeError);
    }
  });
});

describe('assertDescribeResult', () => {
  it('refuses not_modified for a snapshot read', () => {
    expect(() => assertDescribeResult({ snapshot: snap('s') }, { kind: 'not_modified' })).toThrow(
      TypeError,
    );
    expect(() => assertDescribeResult({ validators: {} }, { kind: 'not_modified' })).not.toThrow();
  });
});

describe('collectListing', () => {
  const keyed = (byCursor: Readonly<Record<string, ListingPage | Error>>) => {
    const requested: (string | null)[] = [];
    const fetchPage = (cursor: string | null) => {
      requested.push(cursor);
      const entry = byCursor[cursor ?? ''];
      if (entry === undefined) return Promise.reject(new Error(`unexpected cursor ${cursor}`));
      return entry instanceof Error ? Promise.reject(entry) : Promise.resolve(entry);
    };
    return { fetchPage, requested };
  };
  const start: ListingInput = { cursor: null, snapshot: null, pageBudget: 10, pagesSoFar: 0 };
  const noop = () => Promise.resolve();

  it('walks the cursor chain to the last page under one snapshot', async () => {
    const { fetchPage, requested } = keyed({
      '': { names: ['a', 'b'], next: 'c1', last: false, snapshot: snap('s') },
      c1: { names: ['c'], next: null, last: true, snapshot: snap('s') },
    });
    const result = await collectListing(fetchPage, noop, start);
    expect(requested).toEqual([null, 'c1']);
    expect(result).toMatchObject({ complete: true, count: 3, next: null, stop: 'last' });
  });

  it('counts distinct names only', async () => {
    const { fetchPage } = keyed({
      '': { names: ['a', 'a'], next: 'c1', last: false, snapshot: snap('s') },
      c1: { names: ['a', 'b'], next: null, last: true, snapshot: snap('s') },
    });
    expect((await collectListing(fetchPage, noop, start)).count).toBe(2);
  });

  it('resumes from a cursor within the budget and returns the continuation', async () => {
    const { fetchPage, requested } = keyed({
      c1: { names: ['b'], next: 'c2', last: false, snapshot: snap('s') },
      c2: { names: ['c'], next: 'c3', last: false, snapshot: snap('s') },
    });
    const result = await collectListing(fetchPage, noop, {
      cursor: 'c1',
      snapshot: snap('s'),
      pageBudget: 2,
      pagesSoFar: 4,
    });
    expect(requested).toEqual(['c1', 'c2']);
    expect(result).toMatchObject({
      complete: false,
      next: 'c3',
      stop: 'budget',
      abandoned: false,
      pagesSoFar: 6,
    });
  });

  it('abandons when the first page differs from the session snapshot', async () => {
    const { fetchPage } = keyed({
      c1: { names: ['b'], next: null, last: true, snapshot: snap('other') },
    });
    const result = await collectListing(fetchPage, noop, {
      cursor: 'c1',
      snapshot: snap('s'),
      pageBudget: 5,
      pagesSoFar: 0,
    });
    expect(result).toMatchObject({ complete: false, abandoned: true, count: 0 });
  });

  it('is incomplete when the snapshot changes mid-listing', async () => {
    const { fetchPage } = keyed({
      '': { names: ['a'], next: 'c1', last: false, snapshot: snap('s1') },
      c1: { names: ['b'], next: null, last: true, snapshot: snap('s2') },
    });
    const result = await collectListing(fetchPage, noop, start);
    expect(result).toMatchObject({ complete: false, count: 1, abandoned: true });
  });

  it('returns an UpstreamError as incomplete and keeps the cursor', async () => {
    const failure = new UpstreamError('http_status', 500);
    const { fetchPage } = keyed({
      '': { names: ['a', 'b'], next: 'c1', last: false, snapshot: snap('s') },
      c1: failure,
    });
    const result = await collectListing(fetchPage, noop, start);
    expect(result).toMatchObject({ complete: false, count: 2, next: 'c1', stop: 'error' });
    expect(result.error).toBe(failure);
  });

  it('rethrows errors that are not upstream errors', async () => {
    const { fetchPage } = keyed({ '': new TypeError('bug') });
    await expect(collectListing(fetchPage, noop, start)).rejects.toThrow(TypeError);
  });

  it('is incomplete when pages stop without a last page', async () => {
    const { fetchPage } = keyed({
      '': { names: ['a'], next: null, last: false, snapshot: snap('s') },
    });
    expect((await collectListing(fetchPage, noop, start)).complete).toBe(false);
  });

  it('is incomplete when the last page still names a next cursor', async () => {
    const { fetchPage } = keyed({
      '': { names: ['a'], next: 'c1', last: true, snapshot: snap('s') },
    });
    expect(await collectListing(fetchPage, noop, start)).toMatchObject({
      complete: false,
      stop: 'inconsistent_last',
    });
  });

  it('stops on a repeated cursor', async () => {
    const { fetchPage, requested } = keyed({
      '': { names: ['a'], next: 'c1', last: false, snapshot: snap('s') },
      c1: { names: ['b'], next: 'c1', last: false, snapshot: snap('s') },
    });
    const result = await collectListing(fetchPage, noop, start);
    expect(requested).toEqual([null, 'c1']);
    expect(result).toMatchObject({ complete: false, stop: 'cycle', next: null });
  });

  it('throws AbortError when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchPage, requested } = keyed({});
    await expect(
      collectListing(fetchPage, noop, { ...start, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requested).toEqual([]);
  });

  it('propagates an onNames rejection and awaits it before the next page', async () => {
    const { fetchPage, requested } = keyed({
      '': { names: ['a'], next: 'c1', last: false, snapshot: snap('s') },
      c1: { names: ['b'], next: null, last: true, snapshot: snap('s') },
    });
    const order: string[] = [];
    await collectListing(
      (cursor) => {
        order.push(`fetch ${cursor}`);
        return fetchPage(cursor);
      },
      async (names) => {
        await Promise.resolve();
        order.push(`names ${names.join()}`);
      },
      start,
    );
    expect(order).toEqual(['fetch null', 'names a', 'fetch c1', 'names b']);

    const failing = keyed({
      '': { names: ['a'], next: 'c1', last: false, snapshot: snap('s') },
    });
    await expect(
      collectListing(failing.fetchPage, () => Promise.reject(new Error('store down')), start),
    ).rejects.toThrow('store down');
    expect(failing.requested).toEqual([null]);
    expect(requested).toEqual([null, 'c1']);
  });
});

describe('listing limits', () => {
  const page = (id: string): ListingPage => ({
    names: ['a'],
    next: 'n',
    last: false,
    snapshot: snap(id),
  });
  const fetchPage = () => Promise.resolve(page('s'));
  const noop = () => Promise.resolve();

  it('rejects an invalid pageBudget or pagesSoFar', async () => {
    for (const pageBudget of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        collectListing(fetchPage, noop, {
          cursor: null,
          snapshot: null,
          pageBudget,
          pagesSoFar: 0,
        }),
      ).rejects.toThrow(RangeError);
    }
    await expect(
      collectListing(fetchPage, noop, {
        cursor: null,
        snapshot: null,
        pageBudget: 1,
        pagesSoFar: -1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it('stops at the session cap without fetching', async () => {
    let calls = 0;
    const result = await collectListing(
      () => {
        calls += 1;
        return fetchPage();
      },
      noop,
      { cursor: 'x', snapshot: snap('s'), pageBudget: 50, pagesSoFar: SESSION_PAGE_CAP },
    );
    expect(calls).toBe(0);
    expect(result).toMatchObject({ complete: false, stop: 'budget', pagesSoFar: SESSION_PAGE_CAP });
  });

  it('rejects malformed snapshot ids on pages and on the input', async () => {
    const weak = { names: [], next: null, last: true, snapshot: { id: 'W/"x"' } };
    await expect(
      collectListing(() => Promise.resolve(weak), noop, {
        cursor: null,
        snapshot: null,
        pageBudget: 1,
        pagesSoFar: 0,
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      collectListing(fetchPage, noop, {
        cursor: null,
        snapshot: { id: 'bad' },
        pageBudget: 1,
        pagesSoFar: 0,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('validates the snapshot given to createPackageDescription', () => {
    expect(() =>
      createPackageDescription({
        name: 'a/b',
        snapshot: { id: '""' },
        members: members(0),
        validators: {},
        documentsComplete: true,
      }),
    ).toThrow(TypeError);
  });

  it('rejects negative and fractional ordinals', async () => {
    for (const ordinalOf of [() => -1, () => 0.5]) {
      const description = createPackageDescription({
        name: 'a/b',
        snapshot: snap('s'),
        members: members(1, undefined, ordinalOf),
        validators: {},
        documentsComplete: true,
      });
      await expect(drain(description.members)).rejects.toThrow(RangeError);
    }
  });
});

describe('guarded providers keep the original receiver', () => {
  class Github implements SourceProvider {
    readonly id = 'github';
    readonly sourceTypes = ['vcs'] as const;
    readonly ecosystems = ['composer'] as const;
    readonly #label = 'private-state';
    describe(): Promise<never> {
      return Promise.reject(new Error('unused'));
    }
    openDist() {
      return Promise.resolve({ body: new ReadableStream<Uint8Array>(), size: this.#label.length });
    }
    discoverRepositories() {
      return Promise.resolve({
        repositories: [{ id: '1', name: this.#label, url: 'https://example.com/a' }],
        next: null,
      });
    }
  }

  it('calls prototype methods that use private fields through the registry', async () => {
    const registry = createProviderRegistry();
    registry.register(new Github());
    const guarded = registry.get('vcs', 'github');
    const ctx = {} as ProviderContext;
    const source = {} as ProviderSource;
    const dist = await guarded.openDist(ctx, source, {
      packageName: 'a/b',
      version: '1',
      url: null,
      distType: null,
      sourceRef: null,
    });
    expect(dist.size).toBe('private-state'.length);
    const page = await guarded.discoverRepositories?.(ctx, {} as never, null);
    expect(page?.repositories[0]?.name).toBe('private-state');
  });
});

describe('guarded providers', () => {
  const ctx = {} as ProviderContext;
  const source = {
    id: 's1',
    ecosystem: 'composer',
    url: null,
    type: 'vcs',
    config: { provider: 'github', repository: 'a/b', refs: { tags: true, branches: [] } },
  } as ProviderSource;

  const registerWith = (describeImpl: SourceProvider['describe']) => {
    const registry = createProviderRegistry();
    registry.register({ ...provider('github', ['vcs']), describe: describeImpl });
    return registry.forSource(source);
  };

  it('refuses not_modified for a snapshot read', async () => {
    const guarded = registerWith(() => Promise.resolve({ kind: 'not_modified' }));
    await expect(guarded.describe(ctx, source, 'a/b', { snapshot: snap('s') })).rejects.toThrow(
      TypeError,
    );
    await expect(guarded.describe(ctx, source, 'a/b', {})).resolves.toEqual({
      kind: 'not_modified',
    });
  });

  it('refuses a found result that was not built by createPackageDescription', async () => {
    const forged = { name: 'a/b', snapshot: snap('s'), members: members(0), validators: {} };
    const guarded = registerWith(() =>
      Promise.resolve({ kind: 'found', description: forged as never }),
    );
    await expect(guarded.describe(ctx, source, 'a/b', {})).rejects.toThrow(TypeError);
  });

  it('passes a genuine description and validates listing snapshots', async () => {
    const description = createPackageDescription({
      name: 'a/b',
      snapshot: snap('s'),
      members: members(1),
      validators: {},
      documentsComplete: true,
    });
    const registry = createProviderRegistry();
    registry.register({
      ...provider('github', ['vcs']),
      describe: () => Promise.resolve({ kind: 'found', description }),
      listPackages: () =>
        Promise.resolve({ names: [], next: null, last: true, snapshot: { id: 'W/"x"' } }),
    });
    const guarded = registry.forSource(source);
    await expect(guarded.describe(ctx, source, 'a/b', {})).resolves.toMatchObject({
      kind: 'found',
    });
    await expect(guarded.listPackages?.(ctx, source, null)).rejects.toThrow(TypeError);
  });
});

describe('createProviderRegistry', () => {
  it('returns the registered provider', () => {
    const registry = createProviderRegistry();
    const packagist = provider('packagist', ['packagist_proxy']);
    registry.register(packagist);
    const guarded = registry.get('packagist_proxy', 'packagist');
    expect(guarded.id).toBe(packagist.id);
    expect(registry.get('packagist_proxy')).toBe(guarded);
    const source = {
      id: 's1',
      ecosystem: 'composer',
      url: null,
      type: 'packagist_proxy',
      config: { githubToken: false },
      providerId: 'packagist',
    } as ProviderSource;
    expect(registry.forSource(source)).toBe(guarded);
  });

  it('dispatches vcs sources by provider id', () => {
    const registry = createProviderRegistry();
    registry.register(provider('github', ['vcs']));
    registry.register(provider('git', ['vcs']));
    const vcs = {
      id: 's1',
      ecosystem: 'composer',
      url: null,
      type: 'vcs',
      config: { provider: 'github', repository: 'a/b', refs: { tags: true, branches: [] } },
    } as ProviderSource;
    expect(registry.forSource(vcs)).toBe(registry.get('vcs', 'github'));
    expect(
      registry.forSource({ ...vcs, config: { ...vcs.config, provider: 'git' } } as ProviderSource)
        .id,
    ).toBe('git');
  });

  it('throws on a duplicate (type, id) registration', () => {
    const registry = createProviderRegistry();
    registry.register(provider('p', ['vcs']));
    try {
      registry.register(provider('p', ['vcs']));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRegistryError);
      expect((error as ProviderRegistryError).code).toBe('duplicate');
    }
  });

  it('does not leave a half registration after a duplicate', () => {
    const registry = createProviderRegistry();
    registry.register(provider('p', ['vcs']));
    expect(() => registry.register(provider('p', ['npmjs_proxy', 'vcs']))).toThrow(
      ProviderRegistryError,
    );
    expect(() => registry.get('npmjs_proxy', 'p')).toThrow(ProviderRegistryError);
  });

  it('refuses empty source types and hosted', () => {
    const registry = createProviderRegistry();
    for (const types of [[], ['hosted']] as const) {
      try {
        registry.register(provider('p', types));
        expect.unreachable();
      } catch (error) {
        expect((error as ProviderRegistryError).code).toBe('invalid');
      }
    }
  });

  it('throws a typed error for an unregistered type or id', () => {
    const registry = createProviderRegistry();
    registry.register(provider('p', ['vcs']));
    for (const lookup of [() => registry.get('npmjs_proxy'), () => registry.get('vcs', 'other')]) {
      try {
        lookup();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderRegistryError);
        expect((error as ProviderRegistryError).code).toBe('unregistered');
      }
    }
  });

  it('refuses an ambiguous lookup without an id', () => {
    const registry = createProviderRegistry();
    registry.register(provider('a', ['vcs']));
    registry.register(provider('b', ['vcs']));
    try {
      registry.get('vcs');
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderRegistryError).code).toBe('ambiguous');
    }
  });
});

describe('createPackageDescription: skipped members', () => {
  it('defaults to an empty frozen list and leaves completeness unchanged', async () => {
    const description = createPackageDescription({
      ...base,
      members: members(2),
      documentsComplete: true,
    });
    await drain(description.members);
    expect(description.skippedMembers).toEqual([]);
    expect(Object.isFrozen(description.skippedMembers)).toBe(true);
    expect(description.upstreamComplete).toBe(true);
  });

  it('reads deferred skipped members after the drain and reports incomplete', async () => {
    const skipped: { version: string; reason: 'member_too_large' }[] = [];
    const description = createPackageDescription({
      ...base,
      members: (async function* () {
        yield* members(1);
        skipped.push({ version: '2.0.0', reason: 'member_too_large' });
      })(),
      documentsComplete: true,
      skippedMembers: () => skipped,
    });
    await drain(description.members);
    const listed = description.skippedMembers;
    expect(listed).toEqual([{ version: '2.0.0', reason: 'member_too_large' }]);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
    skipped.push({ version: '3.0.0', reason: 'member_too_large' });
    expect(listed).toHaveLength(1);
    expect(description.upstreamComplete).toBe(false);
  });

  it('reports incomplete for a fixed non-empty skipped list', async () => {
    const description = createPackageDescription({
      ...base,
      members: members(1),
      documentsComplete: true,
      skippedMembers: [{ version: '1.0.9', reason: 'member_too_large' }],
    });
    await drain(description.members);
    expect(description.upstreamComplete).toBe(false);
  });
});
