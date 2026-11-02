import { describe, expect, it, vi } from 'vitest';
import type { HookMap, ReadPolicyInput, VersionFact } from '../../plugin.js';
import { RegistryPolicyUnavailableError } from './errors.js';
import {
  HOOK_CANDIDATE_BATCH,
  createHookBudget,
  runRequestHooks,
  runVersionHooks,
  type HookContext,
  type RegisteredReadHook,
} from './hooks.js';

type Handler = HookMap['registry.read'];

const CONTEXT: HookContext = {
  orgId: 'org-a',
  projectId: 'P',
  principal: { kind: 'user', id: 'U' },
  ecosystem: 'npm',
  client: { family: 'npm', version: '10.2.4' },
  now: '2026-11-01T00:00:00.000Z',
};

function fact(n: number): VersionFact {
  return {
    packageId: 'K',
    sourceId: 'S',
    packageKey: 'left-pad',
    versionId: `V${n}`,
    version: `1.0.${n}`,
    normalizedVersion: `1.0.${n}`,
    revision: 1,
    publishedAt: '2026-01-01T00:00:00.000Z',
    ageBasis: 'published',
  };
}

const hooks = (...handlers: Handler[]): RegisteredReadHook[] =>
  handlers.map((handler, index) => ({ plugin: `p${index}`, handler }));
const budget = () => createHookBudget({ budgetMs: 1000 });
const versions = (list: RegisteredReadHook[], facts: VersionFact[]) =>
  runVersionHooks(list, CONTEXT, facts, budget());
const deniedIds = async (list: RegisteredReadHook[], facts: VersionFact[]) =>
  (await versions(list, facts)).denied.map((d) => `${d.plugin}:${d.versionId}:${d.reason}`);

describe('request phase', () => {
  it('passes with no hooks and on abstention', async () => {
    expect(
      await runRequestHooks([], CONTEXT, { kind: 'metadata', packageKey: 'left-pad' }, budget()),
    ).toBeNull();
    expect(
      await runRequestHooks(
        hooks(() => undefined),
        CONTEXT,
        { kind: 'metadata', packageKey: null },
        budget(),
      ),
    ).toBeNull();
  });

  it('passes frozen narrow input with the kind and package, and stops at the first denial', async () => {
    const seen: ReadPolicyInput[] = [];
    const later = vi.fn<Handler>();
    const denial = await runRequestHooks(
      hooks(
        (input) => {
          seen.push(input);
          return undefined;
        },
        () => ({ deny: true, reason: 'client_unsupported' }),
        later,
      ),
      CONTEXT,
      { kind: 'dist', packageKey: 'left-pad' },
      budget(),
    );
    expect(denial).toEqual({ plugin: 'p1', reason: 'client_unsupported' });
    expect(later).not.toHaveBeenCalled();
    const [input] = seen;
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input?.org)).toBe(true);
    expect(Object.keys(input!).sort()).toEqual(
      [
        'client',
        'ecosystem',
        'kind',
        'now',
        'org',
        'packageKey',
        'phase',
        'principal',
        'projectId',
        'signal',
      ].sort(),
    );
    expect(input).toMatchObject({
      phase: 'request',
      kind: 'dist',
      packageKey: 'left-pad',
      org: { orgId: 'org-a' },
    });
    expect(input?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses deniedVersions in the request phase', async () => {
    await expect(
      runRequestHooks(
        hooks(() => ({ deniedVersions: [{ versionId: 'V1', revision: 1, reason: 'restricted' }] })),
        CONTEXT,
        { kind: 'metadata', packageKey: 'left-pad' },
        budget(),
      ),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });
});

describe('versions phase', () => {
  it('abstains on undefined and on an empty denied list', async () => {
    expect(
      await deniedIds(
        hooks(
          () => undefined,
          () => ({ deniedVersions: [] }),
        ),
        [fact(1)],
      ),
    ).toEqual([]);
  });

  it('denies named candidates and accumulates across hooks; later hooks cannot restore', async () => {
    const third = vi.fn<Handler>(() => ({ deniedVersions: [] }));
    const result = await versions(
      hooks(
        () => ({ deniedVersions: [{ versionId: 'V1', revision: 1, reason: 'restricted' }] }),
        (input) => {
          expect(input.phase === 'versions' && input.versions.map((v) => v.versionId)).toEqual([
            'V2',
            'V3',
          ]);
          return {
            deniedVersions: [{ versionId: 'V3', revision: 1, reason: 'client_unsupported' }],
          };
        },
        third,
      ),
      [fact(1), fact(2), fact(3)],
    );
    expect(result.request).toBeNull();
    expect(result.denied.map((d) => `${d.plugin}:${d.versionId}:${d.reason}`)).toEqual([
      'p0:V1:restricted',
      'p1:V3:client_unsupported',
    ]);
    const [input] = third.mock.calls[0]!;
    expect(input.phase === 'versions' && input.versions.map((v) => v.versionId)).toEqual(['V2']);
  });

  it('a whole-request denial stops every later hook and page', async () => {
    const later = vi.fn<Handler>();
    const facts = Array.from({ length: HOOK_CANDIDATE_BATCH + 1 }, (_, n) => fact(n));
    const result = await versions(
      hooks(() => ({ deny: true, reason: 'restricted' }), later),
      facts,
    );
    expect(result.request).toEqual({ plugin: 'p0', reason: 'restricted' });
    expect(later).not.toHaveBeenCalled();
  });

  it('calls hooks with at most 64 candidates, skipping calls with no survivors', async () => {
    const sizes: number[] = [];
    const counting: Handler = (input) => {
      if (input.phase === 'versions') sizes.push(input.versions.length);
      return undefined;
    };
    await versions(
      hooks(counting),
      Array.from({ length: 130 }, (_, n) => fact(n)),
    );
    expect(sizes).toEqual([64, 64, 2]);
    sizes.length = 0;
    const denyAll: Handler = (input) =>
      input.phase === 'versions'
        ? {
            deniedVersions: input.versions.map((v) => ({
              versionId: v.versionId,
              revision: v.revision,
              reason: 'restricted' as const,
            })),
          }
        : undefined;
    await versions(hooks(denyAll, counting), [fact(1)]);
    expect(sizes).toEqual([]);
  });

  it('hands every hook its own frozen copy of the candidates', async () => {
    const original = fact(1);
    const seen: Array<{ same: boolean; list: boolean; entry: boolean }> = [];
    const inspect: Handler = (input) => {
      if (input.phase === 'versions') {
        seen.push({
          same: input.versions[0] === original,
          list: Object.isFrozen(input.versions),
          entry: Object.isFrozen(input.versions[0]),
        });
      }
      return undefined;
    };
    await versions(hooks(inspect, inspect), [original]);
    expect(seen).toEqual([
      { same: false, list: true, entry: true },
      { same: false, list: true, entry: true },
    ]);
    let mutated = false;
    await expect(
      versions(
        hooks((input) => {
          if (input.phase !== 'versions') return undefined;
          (input.versions[0] as { revision: number }).revision = 9;
          mutated = true;
          return undefined;
        }),
        [original],
      ),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    expect(mutated).toBe(false);
    expect(original.revision).toBe(1);
  });

  it('refuses candidates that share a version id at two revisions before any hook runs', async () => {
    const handler = vi.fn<Handler>(() => undefined);
    const onFailure = vi.fn();
    const twice = [fact(1), { ...fact(1), revision: 2 }];
    for (const list of [twice, [...Array.from({ length: 63 }, (_, n) => fact(n + 2)), ...twice]]) {
      await expect(
        runVersionHooks(
          hooks(handler),
          CONTEXT,
          list,
          createHookBudget({ budgetMs: 1000, onFailure }),
        ),
      ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    await expect(runVersionHooks([], CONTEXT, twice, budget())).resolves.toEqual({
      request: null,
      denied: [],
    });
  });

  it('fails closed on a duplicate entry among several candidates', async () => {
    await expect(
      versions(
        hooks(() => ({
          deniedVersions: [
            { versionId: 'V1', revision: 1, reason: 'restricted' },
            { versionId: 'V1', revision: 1, reason: 'client_unsupported' },
          ],
        })),
        [fact(1), fact(2)],
      ),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });

  const invalid: Array<[string, () => unknown]> = [
    ['allow', () => ({ allow: true })],
    ['deny false', () => ({ deny: false, reason: 'restricted' })],
    ['deny without reason', () => ({ deny: true })],
    ['free-text reason', () => ({ deny: true, reason: 'because I said so' })],
    ['extra field', () => ({ deny: true, reason: 'restricted', note: 'x' })],
    ['Response', () => new Response('denied')],
    ['string', () => 'deny'],
    ['null', () => null],
    ['array', () => [{ deny: true, reason: 'restricted' }]],
    [
      'class instance',
      () =>
        new (class {
          deny = true as const;
          reason = 'restricted' as const;
        })(),
    ],
    [
      'unknown version id',
      () => ({ deniedVersions: [{ versionId: 'V9', revision: 1, reason: 'restricted' }] }),
    ],
    [
      'unknown revision',
      () => ({ deniedVersions: [{ versionId: 'V1', revision: 2, reason: 'restricted' }] }),
    ],
    [
      'duplicate entry',
      () => ({
        deniedVersions: [
          { versionId: 'V1', revision: 1, reason: 'restricted' },
          { versionId: 'V1', revision: 1, reason: 'restricted' },
        ],
      }),
    ],
    [
      'entry extra field',
      () => ({
        deniedVersions: [{ versionId: 'V1', revision: 1, reason: 'restricted', allow: true }],
      }),
    ],
    [
      'entry bad reason',
      () => ({ deniedVersions: [{ versionId: 'V1', revision: 1, reason: 'malware' }] }),
    ],
    [
      'deniedVersions not an array',
      () => ({ deniedVersions: { 0: { versionId: 'V1', revision: 1, reason: 'restricted' } } }),
    ],
    ['array with extra key', () => ({ deniedVersions: Object.assign([], { allow: true }) })],
    ['both shapes', () => ({ deny: true, reason: 'restricted', deniedVersions: [] })],
    [
      'accessor result',
      () =>
        Object.defineProperty({ reason: 'restricted' }, 'deny', {
          enumerable: true,
          get: () => true,
        }),
    ],
    [
      'accessor entry',
      () => ({
        deniedVersions: [
          Object.defineProperty({ revision: 1, reason: 'restricted' }, 'versionId', {
            enumerable: true,
            get: () => 'V1',
          }),
        ],
      }),
    ],
    ['symbol key', () => ({ deny: true, reason: 'restricted', [Symbol('x')]: 1 })],
    [
      'throwing proxy',
      () =>
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('secret-token-123');
            },
          },
        ),
    ],
  ];

  for (const [name, result] of invalid) {
    it(`fails closed on an invalid result: ${name}`, async () => {
      await expect(versions(hooks(result as Handler), [fact(1)])).rejects.toBeInstanceOf(
        RegistryPolicyUnavailableError,
      );
    });
  }

  it('fails closed on a throw or a rejection, with a fixed error', async () => {
    for (const handler of [
      () => {
        throw new Error('token=secret');
      },
      () => Promise.reject(new Error('token=secret')),
    ] as Handler[]) {
      const error = await versions(hooks(handler), [fact(1)]).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RegistryPolicyUnavailableError);
      expect((error as Error).message).toBe('Package policy is unavailable');
    }
  });

  it('reports failures with fixed codes only', async () => {
    const onFailure = vi.fn();
    await versions(
      hooks(() => ({ allow: true }) as never),
      [fact(1)],
    ).catch(() => undefined);
    await runVersionHooks(
      hooks(() => {
        throw new Error('secret');
      }),
      CONTEXT,
      [fact(1)],
      createHookBudget({ budgetMs: 1000, onFailure }),
    ).catch(() => undefined);
    expect(onFailure.mock.calls).toEqual([[{ plugin: 'p0', code: 'hook_error' }]]);
  });
});
