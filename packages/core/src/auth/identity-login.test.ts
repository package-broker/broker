import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { completeIdentityLogin } from './identity-login.js';
import type { IdentityLoginDeps } from './identity-login.js';
import { SESSION_ABSOLUTE_MS, createSessionService } from './session.js';
import type { SessionMeta, SessionService } from './session.js';
import { orgContext } from '../db/port.js';
import type { LoginLookup, LoginPlan, LoginWriter, UserRepository } from '../db/users.js';
import { fixedClock } from '../ids.js';
import type { IdentityProvider, VerifiedIdentity } from '../identity/port.js';
import type { HookMap } from '../plugin.js';

const NOW = '2026-10-15T12:00:00.000Z';
const ISSUED_AT = '2026-10-15T11:59:00.000Z';
const AUTH_TIME = '2026-10-15T11:58:00.000Z';
const ctx = orgContext('01J0ORGA00000000000000000A');
const ANCHOR = 'oidc:https://dex.example.test';
const KNOWN_USER = '01J0USERKNOWN0000000000001';
const LINKED_USER = '01J0USERLINKED000000000001';
const STORED_IDENTITY = '01J0IDENTITY000000000000K1';
const EMAIL = 'ada@example.test';
const HOOK_REASON_TEXT = 'ada@example.test is on a deny list';

const meta: SessionMeta = {
  ip: '203.0.113.7',
  userAgent: 'test-agent',
  previousSecretHash: 'c'.repeat(64),
};

type ResolveIdentityHandler = HookMap['auth.resolveIdentity'];
type MapGroupsHandler = HookMap['auth.mapGroups'];

function provider(overrides: Partial<IdentityProvider> = {}): IdentityProvider {
  return {
    id: 'dex',
    kind: 'oidc',
    displayName: 'Dex',
    trustAnchor: ANCHOR,
    policy: { verifiedDomains: ['example.test'], autoJoin: false },
    supportsReauth: true,
    start: () => Promise.reject(new Error('unused')),
    finish: () => Promise.reject(new Error('unused')),
    ...overrides,
  };
}

function identity(overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  return {
    provider: 'dex',
    subject: 'sub-1',
    email: EMAIL,
    emailVerified: true,
    displayName: 'Ada',
    groups: ['staff'],
    issuedAt: ISSUED_AT,
    authTime: null,
    ...overrides,
  };
}

function lookup(overrides: Partial<LoginLookup> = {}): LoginLookup {
  return {
    boundAnchor: null,
    identity: null,
    identityUser: null,
    userByEmail: null,
    invited: false,
    ...overrides,
  };
}

const knownLookup = (overrides: Partial<LoginLookup> = {}): LoginLookup =>
  lookup({
    boundAnchor: ANCHOR,
    identity: {
      id: STORED_IDENTITY,
      userId: KNOWN_USER,
      provider: 'dex',
      subject: 'sub-1',
      email: EMAIL,
      validatedAt: '2026-10-14T00:00:00.000Z',
    },
    identityUser: { id: KNOWN_USER, email: EMAIL, status: 'active' },
    ...overrides,
  });

interface Harness {
  readonly deps: IdentityLoginDeps;
  readonly events: string[];
  readonly lookupForLogin: Mock<UserRepository['lookupForLogin']>;
  readonly commit: Mock<LoginWriter['commit']>;
  readonly setCookies: ReturnType<typeof vi.fn>;
  readonly resolveHandler: Mock<ResolveIdentityHandler>;
  readonly mapHandler: Mock<MapGroupsHandler>;
  readonly onHookError: ReturnType<typeof vi.fn>;
  plans(): LoginPlan[];
}

function harness(
  options: {
    readonly lookups?: readonly LoginLookup[];
    readonly commits?: readonly ('created' | 'refused')[];
    readonly resolve?: (input: unknown) => unknown;
    readonly map?: (input: unknown) => unknown;
  } = {},
): Harness {
  const events: string[] = [];
  const lookups = [...(options.lookups ?? [lookup()])];
  const commits = [...(options.commits ?? ['created'])];
  let sequence = 0;

  const lookupForLogin = vi.fn<UserRepository['lookupForLogin']>(() => {
    events.push('lookup');
    return Promise.resolve((lookups.length > 1 ? lookups.shift() : lookups[0]) as LoginLookup);
  });
  const commit = vi.fn<LoginWriter['commit']>(() => {
    events.push('commit');
    return Promise.resolve((commits.length > 1 ? commits.shift() : commits[0]) ?? 'created');
  });
  const setCookies = vi.fn((): readonly string[] => [
    '__Host-pb_session=s; Path=/',
    '__Host-pb_csrf=c; Path=/',
  ]);
  const resolveHandler = vi.fn<ResolveIdentityHandler>((input) => {
    events.push('resolveIdentity');
    return options.resolve?.(input) as ReturnType<ResolveIdentityHandler>;
  });
  const mapHandler = vi.fn<MapGroupsHandler>((input) => {
    events.push('mapGroups');
    return options.map?.(input) as ReturnType<MapGroupsHandler>;
  });
  const onHookError = vi.fn();

  const users = {
    lookupForLogin,
    getIdentity: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
  } as unknown as UserRepository;
  const writer = { commit } as unknown as LoginWriter;
  const sessions = { setCookies } as unknown as SessionService;

  const deps: IdentityLoginDeps = {
    users,
    writer,
    sessions,
    hooks: {
      'auth.resolveIdentity': [{ plugin: 'p-resolve', handler: resolveHandler }],
      'auth.mapGroups': [{ plugin: 'p-map', handler: mapHandler }],
    },
    clock: fixedClock(NOW),
    ids: {
      ulid: () => {
        sequence += 1;
        return `01J0GEN${String(sequence).padStart(19, '0')}`;
      },
    },
    onHookError,
  };
  return {
    deps,
    events,
    lookupForLogin,
    commit,
    setCookies,
    resolveHandler,
    mapHandler,
    onHookError,
    plans: () => commit.mock.calls.map((call) => call[1]),
  };
}

const login = (h: Harness, id: VerifiedIdentity = identity(), p: IdentityProvider = provider()) =>
  completeIdentityLogin(h.deps, ctx, p, id, meta);

function manyGroups(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `group-${String(index)}`);
}

describe('completeIdentityLogin: deciding the user', () => {
  it('logs a known identity in as its own user', async () => {
    const h = harness({ lookups: [knownLookup()] });
    const outcome = await login(h);
    expect(outcome).toEqual({
      ok: true,
      userId: KNOWN_USER,
      sessionId: h.plans()[0]?.session.id,
      cookies: ['__Host-pb_session=s; Path=/', '__Host-pb_csrf=c; Path=/'],
    });
    const plan = h.plans()[0];
    expect(plan).toMatchObject({
      userId: KNOWN_USER,
      createUser: false,
      identityId: STORED_IDENTITY,
      email: EMAIL,
      provider: 'dex',
      trustAnchor: ANCHOR,
      subject: 'sub-1',
      emailVerified: true,
      displayName: 'Ada',
      groups: ['staff'],
    });
  });

  it('links an unknown identity to the existing user with the same e-mail', async () => {
    const h = harness({
      lookups: [
        lookup({ userByEmail: { id: LINKED_USER, status: 'active', linkedAtProvider: false } }),
      ],
    });
    const outcome = await login(h);
    expect(outcome).toMatchObject({ ok: true, userId: LINKED_USER });
    const plan = h.plans()[0];
    expect(plan).toMatchObject({ userId: LINKED_USER, createUser: false });
    expect(plan?.identityId).toMatch(/^01J0GEN/);
  });

  it('creates a user when the policy auto-joins', async () => {
    const h = harness();
    const outcome = await login(
      h,
      identity(),
      provider({ policy: { verifiedDomains: ['example.test'], autoJoin: true } }),
    );
    const plan = h.plans()[0];
    expect(outcome).toMatchObject({ ok: true, userId: plan?.userId });
    expect(plan).toMatchObject({ createUser: true, autoJoin: true });
    expect(plan?.userId).toMatch(/^01J0GEN/);
    expect(plan?.identityId).not.toBe(plan?.userId);
  });

  it('creates a user without auto-join when the e-mail or a group is invited', async () => {
    const h = harness({ lookups: [lookup({ invited: true })] });
    const outcome = await login(h);
    const plan = h.plans()[0];
    expect(outcome).toMatchObject({ ok: true, userId: plan?.userId });
    expect(plan).toMatchObject({ createUser: true, autoJoin: false });
  });

  it('refuses with not_invited and never writes when nothing admits the user', async () => {
    const h = harness();
    expect(await login(h)).toEqual({ ok: false, reason: 'not_invited' });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.resolveHandler).not.toHaveBeenCalled();
  });

  it('refuses a suspended known user and a suspended user found by e-mail', async () => {
    const known = harness({
      lookups: [
        knownLookup({ identityUser: { id: KNOWN_USER, email: EMAIL, status: 'suspended' } }),
      ],
    });
    expect(await login(known)).toEqual({ ok: false, reason: 'user_suspended' });
    expect(known.commit).not.toHaveBeenCalled();

    const byEmail = harness({
      lookups: [
        lookup({ userByEmail: { id: LINKED_USER, status: 'suspended', linkedAtProvider: false } }),
      ],
    });
    expect(await login(byEmail)).toEqual({ ok: false, reason: 'user_suspended' });
    expect(byEmail.commit).not.toHaveBeenCalled();
  });

  it('refuses a known identity whose user is missing as invalid_identity', async () => {
    const h = harness({ lookups: [knownLookup({ identityUser: null })] });
    expect(await login(h)).toEqual({ ok: false, reason: 'invalid_identity' });
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('refuses invalid_identity when the identity belongs to another user than its user row', async () => {
    const base = knownLookup();
    const h = harness({
      lookups: [
        {
          ...base,
          identity: base.identity && { ...base.identity, userId: LINKED_USER },
        },
      ],
    });
    expect(await login(h)).toEqual({ ok: false, reason: 'invalid_identity' });
    expect(h.resolveHandler).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('refuses already_linked for a second subject at a provider the e-mail user already uses', async () => {
    const h = harness({
      lookups: [
        lookup({ userByEmail: { id: LINKED_USER, status: 'active', linkedAtProvider: true } }),
      ],
    });
    const outcome = await login(h, identity({ subject: 'attacker-sub' }));
    expect(outcome).toEqual({ ok: false, reason: 'already_linked' });
    expect(h.mapHandler).toHaveBeenCalledTimes(1);
    expect(h.resolveHandler).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.setCookies).not.toHaveBeenCalled();
  });

  it('refuses already_linked even when autoJoin or an invitation would admit a new user', async () => {
    const h = harness({
      lookups: [
        lookup({
          invited: true,
          userByEmail: { id: LINKED_USER, status: 'active', linkedAtProvider: true },
        }),
      ],
    });
    const open = provider({ policy: { verifiedDomains: ['example.test'], autoJoin: true } });
    expect(await login(h, identity({ subject: 'attacker-sub' }), open)).toEqual({
      ok: false,
      reason: 'already_linked',
    });
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('links when the e-mail user only has an identity at another provider', async () => {
    const h = harness({
      lookups: [
        lookup({ userByEmail: { id: LINKED_USER, status: 'active', linkedAtProvider: false } }),
      ],
    });
    expect(await login(h, identity({ subject: 'second-provider-sub' }))).toMatchObject({
      ok: true,
      userId: LINKED_USER,
    });
    expect(h.plans()[0]).toMatchObject({ userId: LINKED_USER, createUser: false });
  });

  it('does not apply already_linked to a known identity', async () => {
    const h = harness({
      lookups: [
        knownLookup({
          userByEmail: { id: KNOWN_USER, status: 'active', linkedAtProvider: true },
        }),
      ],
    });
    expect(await login(h)).toMatchObject({ ok: true, userId: KNOWN_USER });
  });

  it('reports a suspended e-mail user before already_linked', async () => {
    const h = harness({
      lookups: [
        lookup({ userByEmail: { id: LINKED_USER, status: 'suspended', linkedAtProvider: true } }),
      ],
    });
    expect(await login(h)).toEqual({ ok: false, reason: 'user_suspended' });
  });

  it('prefers the identity over the e-mail match', async () => {
    const h = harness({
      lookups: [
        knownLookup({
          userByEmail: { id: LINKED_USER, status: 'active', linkedAtProvider: false },
        }),
      ],
    });
    expect(await login(h)).toMatchObject({ ok: true, userId: KNOWN_USER });
  });
});

describe('completeIdentityLogin: e-mail and policy', () => {
  it.each([
    ['empty', ''],
    ['no at sign', 'ada.example.test'],
    ['no dotted domain', 'ada@localhost'],
    ['non-ASCII', 'ada@exämple.test'],
    ['two at signs', 'a@b@example.test'],
    ['not a string', 42 as unknown as string],
  ])('refuses email_missing for an e-mail that is %s', async (_name, email) => {
    const h = harness({ lookups: [knownLookup()] });
    expect(await login(h, identity({ email }))).toEqual({ ok: false, reason: 'email_missing' });
    expect(h.mapHandler).not.toHaveBeenCalled();
    expect(h.lookupForLogin).not.toHaveBeenCalled();
  });

  it('looks the user up by the normalized e-mail', async () => {
    const h = harness({ lookups: [knownLookup()] });
    await login(h, identity({ email: '  Ada@Example.TEST ' }));
    expect(h.lookupForLogin).toHaveBeenCalledWith(ctx, {
      provider: 'dex',
      subject: 'sub-1',
      email: EMAIL,
      groups: ['staff'],
    });
    expect(h.plans()[0]?.email).toBe(EMAIL);
  });

  it('refuses a boolean false emailVerified as email_unverified even for a known identity', async () => {
    const h = harness({ lookups: [knownLookup()] });
    expect(await login(h, identity({ emailVerified: false }))).toEqual({
      ok: false,
      reason: 'email_unverified',
    });
    expect(h.lookupForLogin).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['undefined', undefined],
    ['null', null],
  ])(
    'refuses emailVerified that is %s as invalid_identity before any hook',
    async (_name, value) => {
      const h = harness({ lookups: [knownLookup()] });
      const outcome = await login(h, identity({ emailVerified: value as unknown as boolean }));
      expect(outcome).toEqual({ ok: false, reason: 'invalid_identity' });
      expect(h.mapHandler).not.toHaveBeenCalled();
      expect(h.lookupForLogin).not.toHaveBeenCalled();
      expect(h.commit).not.toHaveBeenCalled();
    },
  );

  it('refuses a domain outside the policy even for a known identity', async () => {
    const h = harness({ lookups: [knownLookup()] });
    const outcome = await login(h, identity({ email: 'ada@other.test' }));
    expect(outcome).toEqual({ ok: false, reason: 'domain_not_verified' });
    expect(h.lookupForLogin).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('refuses a sub-domain of a verified domain', async () => {
    const h = harness({ lookups: [knownLookup()] });
    const outcome = await login(h, identity({ email: 'ada@evil.example.test' }));
    expect(outcome).toEqual({ ok: false, reason: 'domain_not_verified' });
  });
});

describe('completeIdentityLogin: runtime validation of the plugin identity', () => {
  it('throws a TypeError before any hook or read when the provider id differs', async () => {
    const h = harness({ lookups: [knownLookup()] });
    await expect(login(h, identity({ provider: 'other' }))).rejects.toBeInstanceOf(TypeError);
    expect(h.mapHandler).not.toHaveBeenCalled();
    expect(h.lookupForLogin).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['not a string', 7 as unknown as string],
    ['with a control character', 'sub\u0000-1'],
    ['too long', 's'.repeat(256)],
  ])('refuses a subject that is %s without a lookup', async (_name, subject) => {
    const h = harness({ lookups: [knownLookup()] });
    expect(await login(h, identity({ subject }))).toEqual({
      ok: false,
      reason: 'invalid_identity',
    });
    expect(h.mapHandler).not.toHaveBeenCalled();
    expect(h.lookupForLogin).not.toHaveBeenCalled();
  });

  it('refuses an identity with accessors without calling them', async () => {
    const h = harness({ lookups: [knownLookup()] });
    const reads = vi.fn<() => string>();
    reads.mockReturnValueOnce('sub-1').mockReturnValueOnce('sub-2');
    const accessor = { ...identity() };
    Object.defineProperty(accessor, 'subject', { get: reads, enumerable: true });
    expect(await login(h, accessor)).toEqual({ ok: false, reason: 'invalid_identity' });
    expect(reads).not.toHaveBeenCalled();
    expect(h.lookupForLogin).not.toHaveBeenCalled();
    expect(h.mapHandler).not.toHaveBeenCalled();
  });

  it.each(['email', 'emailVerified', 'groups', 'issuedAt', 'authTime', 'provider'])(
    'refuses an accessor for %s',
    async (field) => {
      const h = harness({ lookups: [knownLookup()] });
      const getter = vi.fn(() => (identity() as unknown as Record<string, unknown>)[field]);
      const accessor = { ...identity() };
      Object.defineProperty(accessor, field, { get: getter, enumerable: true });
      expect(await login(h, accessor)).toEqual({ ok: false, reason: 'invalid_identity' });
      expect(getter).not.toHaveBeenCalled();
      expect(h.lookupForLogin).not.toHaveBeenCalled();
    },
  );

  it('refuses an identity that is not an object or whose descriptors throw', async () => {
    for (const value of [
      null,
      'identity',
      new Proxy(identity(), {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      }),
    ]) {
      const h = harness({ lookups: [knownLookup()] });
      expect(await login(h, value as unknown as VerifiedIdentity)).toEqual({
        ok: false,
        reason: 'invalid_identity',
      });
      expect(h.lookupForLogin).not.toHaveBeenCalled();
    }
  });

  it('keeps using the copy when the caller mutates the identity during a hook', async () => {
    const id = { ...identity() };
    const h = harness({
      lookups: [knownLookup()],
      map: () => {
        id.subject = 'sub-2';
        id.email = 'other@example.test';
        return undefined;
      },
    });
    expect(await login(h, id)).toMatchObject({ ok: true });
    expect(h.plans()[0]).toMatchObject({ subject: 'sub-1', email: EMAIL });
  });

  it('refuses groups that are not an array or hold a non-string', async () => {
    for (const groups of [
      'staff' as unknown as string[],
      null as unknown as string[],
      ['staff', 3 as unknown as string],
      ['staff', undefined as unknown as string],
      [['staff'] as unknown as string],
      Object.assign(['staff'], { 5: 'sparse' }),
    ]) {
      const h = harness({ lookups: [knownLookup()] });
      expect(await login(h, identity({ groups }))).toEqual({
        ok: false,
        reason: 'invalid_identity',
      });
      expect(h.mapHandler).not.toHaveBeenCalled();
      expect(h.lookupForLogin).not.toHaveBeenCalled();
    }
  });

  it('treats missing groups as an empty list', async () => {
    const h = harness({ lookups: [knownLookup()] });
    const withoutGroups: Record<string, unknown> = { ...identity() };
    delete withoutGroups['groups'];
    expect(await login(h, withoutGroups as unknown as VerifiedIdentity)).toMatchObject({
      ok: true,
    });
    expect(h.plans()[0]?.groups).toEqual([]);
  });

  it('refuses groups with an accessor element or a throwing trap as invalid_identity', async () => {
    const withIndexGetter: string[] = [];
    Object.defineProperty(withIndexGetter, '0', { get: () => 'staff', enumerable: true });
    const throwing = new Proxy(['staff'], {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    for (const groups of [withIndexGetter, throwing]) {
      const h = harness({ lookups: [knownLookup()] });
      expect(await login(h, identity({ groups }))).toEqual({
        ok: false,
        reason: 'invalid_identity',
      });
      expect(h.mapHandler).not.toHaveBeenCalled();
    }
  });

  it('reads groups without iterating them', async () => {
    const groups = Object.assign(['staff'], {
      [Symbol.iterator]() {
        throw new Error('iterator');
      },
    });
    const h = harness({ lookups: [knownLookup()] });
    expect(await login(h, identity({ groups }))).toMatchObject({ ok: true });
    expect(h.plans()[0]?.groups).toEqual(['staff']);
  });

  describe('evidence time', () => {
    const base = Date.parse(NOW);
    const at = (offsetMs: number): string => new Date(base + offsetMs).toISOString();
    const DAY = 86_400_000;

    it.each([
      ['malformed issuedAt', { issuedAt: 'yesterday' }],
      ['issuedAt not a string', { issuedAt: 1760000000000 as unknown as string }],
      ['malformed authTime with a valid issuedAt', { authTime: 'yesterday' }],
      ['authTime not a string', { authTime: 5 as unknown as string }],
      ['non-canonical authTime', { authTime: '2026-10-15T11:58:00Z' }],
      ['issuedAt in 2099', { issuedAt: '2099-01-01T00:00:00.000Z' }],
      ['authTime in 2099', { authTime: '2099-01-01T00:00:00.000Z', issuedAt: ISSUED_AT }],
      ['issuedAt at the epoch', { issuedAt: '1970-01-01T00:00:00.000Z' }],
      ['authTime at the epoch', { authTime: '1970-01-01T00:00:00.000Z' }],
      ['issuedAt 61 seconds ahead', { issuedAt: at(61_000) }],
      ['issuedAt older than 10 years', { issuedAt: at(-3_700 * DAY) }],
      ['authTime 61 seconds after issuedAt', { authTime: at(-59_000), issuedAt: at(-120_000) }],
    ])('refuses %s without a hook or read', async (_name, overrides) => {
      const h = harness({ lookups: [knownLookup()] });
      expect(await login(h, identity(overrides))).toEqual({
        ok: false,
        reason: 'invalid_identity',
      });
      expect(h.mapHandler).not.toHaveBeenCalled();
      expect(h.lookupForLogin).not.toHaveBeenCalled();
      expect(h.commit).not.toHaveBeenCalled();
    });

    it.each([
      ['issuedAt 60 seconds ahead', { issuedAt: at(60_000) }],
      ['issuedAt just under 10 years old', { issuedAt: at(-3_650 * DAY) }],
      ['authTime 60 seconds after issuedAt', { authTime: at(-60_000), issuedAt: at(-120_000) }],
      ['authTime before issuedAt', { authTime: at(-300_000), issuedAt: at(-120_000) }],
    ])('accepts %s and records it as given', async (_name, overrides) => {
      const h = harness({ lookups: [knownLookup()] });
      expect(await login(h, identity(overrides))).toMatchObject({ ok: true });
      const given = identity(overrides);
      expect(h.plans()[0]?.evidenceTime).toBe(given.authTime ?? given.issuedAt);
    });
  });

  it('treats a non-string display name as absent', async () => {
    const h = harness({ lookups: [knownLookup()] });
    await login(h, identity({ displayName: 42 as unknown as string }));
    expect(h.plans()[0]?.displayName).toBeNull();
  });

  it('throws a fixed TypeError for a missing or malformed provider', async () => {
    for (const broken of [
      undefined,
      null,
      'dex',
      {},
      { ...provider(), id: 7 },
      { ...provider(), policy: null },
      { ...provider(), policy: { verifiedDomains: 'example.test', autoJoin: false } },
      { ...provider(), policy: { verifiedDomains: ['example.test', 3], autoJoin: false } },
    ]) {
      const h = harness({ lookups: [knownLookup()] });
      const attempt = completeIdentityLogin(
        h.deps,
        ctx,
        broken as unknown as IdentityProvider,
        identity(),
        meta,
      );
      await expect(attempt).rejects.toBeInstanceOf(TypeError);
      await expect(attempt).rejects.toThrow(
        'identity provider has an invalid id, trust anchor or policy',
      );
      expect(h.lookupForLogin).not.toHaveBeenCalled();
      expect(h.mapHandler).not.toHaveBeenCalled();
    }
  });

  it('refuses a provider with an accessor without calling it', async () => {
    const anchors = vi.fn(() => ANCHOR);
    const policyDomains = vi.fn(() => ['example.test']);
    const brokenProviders: IdentityProvider[] = [];
    for (const field of ['id', 'trustAnchor', 'policy'] as const) {
      const accessor = { ...provider() };
      Object.defineProperty(accessor, field, { get: anchors, enumerable: true });
      brokenProviders.push(accessor);
    }
    const nestedPolicy = { autoJoin: false };
    Object.defineProperty(nestedPolicy, 'verifiedDomains', {
      get: policyDomains,
      enumerable: true,
    });
    brokenProviders.push({ ...provider(), policy: nestedPolicy as never });
    for (const broken of brokenProviders) {
      const h = harness({ lookups: [knownLookup()] });
      await expect(login(h, identity(), broken)).rejects.toBeInstanceOf(TypeError);
      expect(h.lookupForLogin).not.toHaveBeenCalled();
    }
    expect(anchors).not.toHaveBeenCalled();
    expect(policyDomains).not.toHaveBeenCalled();
  });

  it('uses the provider as it was at the start even if it changes during a hook', async () => {
    const live = { ...provider(), policy: { verifiedDomains: ['example.test'], autoJoin: false } };
    const h = harness({
      lookups: [lookup({ boundAnchor: ANCHOR, invited: false })],
      map: () => {
        live.trustAnchor = 'oidc:https://other.example.test';
        live.id = 'other';
        live.policy.autoJoin = true;
        live.policy.verifiedDomains.push('evil.test');
        return undefined;
      },
    });
    expect(await login(h, identity(), live)).toEqual({ ok: false, reason: 'not_invited' });
    expect(h.lookupForLogin.mock.calls[0]?.[1].provider).toBe('dex');
  });

  it('writes the trust anchor and provider id read at the start', async () => {
    const live = { ...provider() };
    const h = harness({
      lookups: [knownLookup()],
      resolve: () => {
        live.trustAnchor = 'oidc:https://other.example.test';
        live.id = 'other';
        return undefined;
      },
    });
    expect(await login(h, identity(), live)).toMatchObject({ ok: true });
    expect(h.plans()[0]).toMatchObject({ provider: 'dex', trustAnchor: ANCHOR });
  });

  it('throws a TypeError for a provider with an invalid id or trust anchor', async () => {
    for (const broken of [
      provider({ id: 'local' }),
      provider({ id: 'Dex' }),
      provider({ trustAnchor: 'https://dex.example.test' }),
    ]) {
      const h = harness({ lookups: [knownLookup()] });
      await expect(login(h, identity({ provider: broken.id }), broken)).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(h.lookupForLogin).not.toHaveBeenCalled();
    }
  });
});

describe('completeIdentityLogin: provider anchor and e-mail change', () => {
  it('refuses provider_rebound when the stored anchor differs, even for a known identity', async () => {
    const h = harness({
      lookups: [knownLookup({ boundAnchor: 'oidc:https://other.example.test' })],
    });
    expect(await login(h)).toEqual({ ok: false, reason: 'provider_rebound' });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.resolveHandler).not.toHaveBeenCalled();
  });

  it('refuses provider_rebound for a new user too', async () => {
    const h = harness({
      lookups: [lookup({ boundAnchor: 'oidc:https://other.example.test', invited: true })],
    });
    expect(await login(h)).toEqual({ ok: false, reason: 'provider_rebound' });
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('accepts a missing or equal stored anchor', async () => {
    const equal = harness({ lookups: [knownLookup({ boundAnchor: ANCHOR })] });
    expect(await login(equal)).toMatchObject({ ok: true });
    const missing = harness({ lookups: [knownLookup({ boundAnchor: null })] });
    expect(await login(missing)).toMatchObject({ ok: true });
  });

  it('refuses email_changed when a known identity arrives with another e-mail', async () => {
    const h = harness({
      lookups: [
        knownLookup({
          identityUser: { id: KNOWN_USER, email: 'old@example.test', status: 'active' },
        }),
      ],
    });
    expect(await login(h)).toEqual({ ok: false, reason: 'email_changed' });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.resolveHandler).not.toHaveBeenCalled();
  });

  it('checks the anchor before the e-mail change', async () => {
    const h = harness({
      lookups: [
        knownLookup({
          boundAnchor: 'oidc:https://other.example.test',
          identityUser: { id: KNOWN_USER, email: 'old@example.test', status: 'active' },
        }),
      ],
    });
    expect(await login(h)).toEqual({ ok: false, reason: 'provider_rebound' });
  });

  it('reports a suspended user only after the anchor and e-mail checks', async () => {
    const h = harness({
      lookups: [
        knownLookup({
          identityUser: { id: KNOWN_USER, email: 'old@example.test', status: 'suspended' },
        }),
      ],
    });
    expect(await login(h)).toEqual({ ok: false, reason: 'email_changed' });
  });
});

describe('completeIdentityLogin: resolveIdentity hook', () => {
  it('receives the resolved user id of a known identity after the lookup and before the commit', async () => {
    const h = harness({ lookups: [knownLookup()] });
    await login(h, identity({ authTime: AUTH_TIME }));
    expect(h.events).toEqual(['mapGroups', 'lookup', 'resolveIdentity', 'commit']);
    const input = h.resolveHandler.mock.calls[0]?.[0] as {
      org: unknown;
      userId: unknown;
      identity: VerifiedIdentity;
    };
    expect(input.userId).toBe(KNOWN_USER);
    expect(input.org).toEqual(ctx);
    expect(input.identity).toEqual({
      provider: 'dex',
      subject: 'sub-1',
      email: EMAIL,
      emailVerified: true,
      displayName: 'Ada',
      groups: ['staff'],
      issuedAt: ISSUED_AT,
      authTime: AUTH_TIME,
    });
  });

  it('receives the planned id of a new user, which is the id the writer gets', async () => {
    const h = harness({ lookups: [lookup({ invited: true })] });
    await login(h);
    const input = h.resolveHandler.mock.calls[0]?.[0] as { userId: unknown };
    expect(input.userId).toBe(h.plans()[0]?.userId);
    expect(input.userId).toMatch(/^01J0GEN/);
  });

  it('receives the linked user id for an identity linked by e-mail', async () => {
    const h = harness({
      lookups: [
        lookup({ userByEmail: { id: LINKED_USER, status: 'active', linkedAtProvider: false } }),
      ],
    });
    await login(h);
    expect((h.resolveHandler.mock.calls[0]?.[0] as { userId: unknown }).userId).toBe(LINKED_USER);
  });

  it('refuses hook_denied without a write and without leaking the hook reason', async () => {
    const h = harness({
      lookups: [knownLookup()],
      resolve: () => ({ deny: true, reason: HOOK_REASON_TEXT }),
    });
    const outcome = await login(h);
    expect(outcome).toEqual({ ok: false, reason: 'hook_denied' });
    expect(JSON.stringify(outcome)).not.toContain('example.test');
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.setCookies).not.toHaveBeenCalled();
  });

  it('refuses hook_denied for a hook that throws and reports the error', async () => {
    const boom = new Error('provider said ada@example.test');
    const h = harness({
      lookups: [knownLookup()],
      resolve: () => {
        throw boom;
      },
    });
    const outcome = await login(h);
    expect(outcome).toEqual({ ok: false, reason: 'hook_denied' });
    expect(h.onHookError).toHaveBeenCalledWith({ plugin: 'p-resolve', error: boom });
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('refuses hook_denied for an invalid hook result', async () => {
    const h = harness({ lookups: [knownLookup()], resolve: () => 'allow' });
    expect(await login(h)).toEqual({ ok: false, reason: 'hook_denied' });
  });
});

describe('completeIdentityLogin: groups', () => {
  it('logs in 1 200 groups that mapGroups narrows to 3', async () => {
    const all = manyGroups(1200);
    const h = harness({
      lookups: [knownLookup()],
      map: () => ({ keep: ['group-1', 'group-500', 'group-1199'] }),
    });
    expect(await login(h, identity({ groups: all }))).toMatchObject({ ok: true });
    expect(h.plans()[0]?.groups).toEqual(['group-1', 'group-500', 'group-1199']);
    expect(h.lookupForLogin.mock.calls[0]?.[1].groups).toEqual([
      'group-1',
      'group-500',
      'group-1199',
    ]);
    expect(
      (h.resolveHandler.mock.calls[0]?.[0] as { identity: VerifiedIdentity }).identity.groups,
    ).toEqual(['group-1', 'group-500', 'group-1199']);
  });

  it('refuses 1 200 groups that no hook narrows', async () => {
    const h = harness({ lookups: [knownLookup()] });
    expect(await login(h, identity({ groups: manyGroups(1200) }))).toEqual({
      ok: false,
      reason: 'too_many_groups',
    });
    expect(h.mapHandler).toHaveBeenCalledTimes(1);
    expect(h.lookupForLogin).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('accepts exactly 1 000 groups and refuses 1 001', async () => {
    const ok = harness({ lookups: [knownLookup()] });
    expect(await login(ok, identity({ groups: manyGroups(1000) }))).toMatchObject({ ok: true });
    const tooMany = harness({ lookups: [knownLookup()] });
    expect(await login(tooMany, identity({ groups: manyGroups(1001) }))).toEqual({
      ok: false,
      reason: 'too_many_groups',
    });
  });

  it('refuses 5 001 groups before any hook runs', async () => {
    const h = harness({ lookups: [knownLookup()], map: () => ({ keep: [] }) });
    expect(await login(h, identity({ groups: manyGroups(5001) }))).toEqual({
      ok: false,
      reason: 'too_many_groups',
    });
    expect(h.mapHandler).not.toHaveBeenCalled();
    expect(h.resolveHandler).not.toHaveBeenCalled();
    expect(h.lookupForLogin).not.toHaveBeenCalled();
  });

  it('lets mapGroups narrow exactly 5 000 groups', async () => {
    const h = harness({ lookups: [knownLookup()], map: () => ({ keep: ['group-7'] }) });
    expect(await login(h, identity({ groups: manyGroups(5000) }))).toMatchObject({ ok: true });
  });

  it('accepts a 256-character name and refuses 257, counting code points', async () => {
    const ok = harness({ lookups: [knownLookup()] });
    expect(
      await login(ok, identity({ groups: ['x'.repeat(256), '\u{1F642}'.repeat(256)] })),
    ).toMatchObject({
      ok: true,
    });
    const long = harness({ lookups: [knownLookup()] });
    expect(await login(long, identity({ groups: ['x'.repeat(257)] }))).toEqual({
      ok: false,
      reason: 'too_many_groups',
    });
    const astral = harness({ lookups: [knownLookup()] });
    expect(await login(astral, identity({ groups: ['\u{1F642}'.repeat(257)] }))).toEqual({
      ok: false,
      reason: 'too_many_groups',
    });
  });

  it('lets mapGroups drop an over-long name', async () => {
    const h = harness({ lookups: [knownLookup()], map: () => ({ keep: ['staff'] }) });
    expect(await login(h, identity({ groups: ['staff', 'x'.repeat(300)] }))).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ['empty name', ''],
    ['lone surrogate', 'a\ud800'],
  ])('refuses a group with an %s', async (_name, group) => {
    const h = harness({ lookups: [knownLookup()] });
    expect(await login(h, identity({ groups: [group] }))).toEqual({
      ok: false,
      reason: 'invalid_identity',
    });
    expect(h.lookupForLogin).not.toHaveBeenCalled();
  });

  it('removes duplicate groups before the hooks and keeps the order', async () => {
    const h = harness({ lookups: [knownLookup()] });
    await login(h, identity({ groups: ['b', 'a', 'b'] }));
    expect(h.mapHandler.mock.calls[0]?.[0]?.groups).toEqual(['b', 'a']);
    expect(h.plans()[0]?.groups).toEqual(['b', 'a']);
  });

  it('refuses hook_denied when mapGroups widens, throws or denies', async () => {
    for (const map of [
      () => ({ keep: ['staff', 'admins'] }),
      () => {
        throw new Error('nope');
      },
      () => 'keep-all',
    ]) {
      const h = harness({ lookups: [knownLookup()], map });
      expect(await login(h)).toEqual({ ok: false, reason: 'hook_denied' });
      expect(h.lookupForLogin).not.toHaveBeenCalled();
    }
  });

  it('gives mapGroups the organization, the provider id and the groups', async () => {
    const h = harness({ lookups: [knownLookup()] });
    await login(h);
    expect(h.mapHandler.mock.calls[0]?.[0]).toEqual({
      org: ctx,
      provider: 'dex',
      groups: ['staff'],
    });
  });

  it('runs mapGroups before the domain policy and the lookup', async () => {
    const h = harness({ lookups: [knownLookup()] });
    await login(h, identity({ emailVerified: false }));
    expect(h.mapHandler).toHaveBeenCalledTimes(1);
    expect(h.lookupForLogin).not.toHaveBeenCalled();
  });
});

describe('completeIdentityLogin: evidence time, session and write plan', () => {
  it('uses authTime as the evidence time when present', async () => {
    const h = harness({ lookups: [knownLookup()] });
    await login(h, identity({ authTime: AUTH_TIME }));
    expect(h.plans()[0]?.evidenceTime).toBe(AUTH_TIME);
    expect(h.plans()[0]?.now).toBe(NOW);
  });

  it('uses issuedAt when authTime is null, never the clock', async () => {
    const h = harness({ lookups: [knownLookup()] });
    await login(h);
    expect(h.plans()[0]?.evidenceTime).toBe(ISSUED_AT);
    expect(h.plans()[0]?.evidenceTime).not.toBe(NOW);
  });

  it('builds a session for the planned user and identity, valid for 12 hours', async () => {
    const h = harness({ lookups: [knownLookup()] });
    const outcome = await login(h);
    const plan = h.plans()[0] as LoginPlan;
    expect(SESSION_ABSOLUTE_MS).toBe(12 * 3_600_000);
    expect(plan.session).toMatchObject({
      userId: KNOWN_USER,
      identityId: STORED_IDENTITY,
      expiresAt: '2026-10-16T00:00:00.000Z',
      ip: meta.ip,
      userAgent: meta.userAgent,
      now: NOW,
    });
    expect(plan.session.identityId).toBe(plan.identityId);
    expect(plan.session.now).toBe(plan.now);
    expect(plan.session.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.session.csrfHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.session.secretHash).not.toBe(plan.session.csrfHash);
    expect(plan.previousSecretHash).toBe(meta.previousSecretHash);
    expect(outcome).toMatchObject({ ok: true, sessionId: plan.session.id });
    expect(plan.session.id).not.toBe(plan.userId);
  });

  it('turns the secrets of the plan into cookies with the same expiry', async () => {
    const h = harness({ lookups: [knownLookup()] });
    await login(h);
    const [secrets, expiresAt] = h.setCookies.mock.calls[0] as unknown as [
      { secret: string; csrf: string; secretHash: string; csrfHash: string },
      string,
    ];
    const plan = h.plans()[0] as LoginPlan;
    expect(expiresAt).toBe(plan.session.expiresAt);
    expect(secrets.secretHash).toBe(plan.session.secretHash);
    expect(secrets.csrfHash).toBe(plan.session.csrfHash);
    expect(secrets.secret).not.toBe(secrets.secretHash);
  });

  it('sets real cookies that last at most 12 hours', async () => {
    const h = harness({ lookups: [knownLookup()] });
    const sessions = createSessionService({
      sessions: {} as never,
      clock: fixedClock(NOW),
      publicOrigin: 'https://broker.example.test',
    });
    const outcome = await completeIdentityLogin(
      { ...h.deps, sessions },
      ctx,
      provider(),
      identity(),
      meta,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.cookies).toHaveLength(2);
      for (const cookie of outcome.cookies) expect(cookie).toContain('Max-Age=43200');
    }
  });

  it('passes autoJoin explicitly from the policy', async () => {
    const off = harness({ lookups: [knownLookup()] });
    await login(off);
    expect(firstPlan(off).autoJoin).toBe(false);
    const on = harness({ lookups: [knownLookup()] });
    await login(
      on,
      identity(),
      provider({ policy: { verifiedDomains: ['example.test'], autoJoin: true } }),
    );
    expect(firstPlan(on).autoJoin).toBe(true);
  });

  it('puts no e-mail, hook reason or error text in any outcome', async () => {
    const outcomes = [
      await login(
        harness({
          lookups: [knownLookup()],
          resolve: () => ({ deny: true, reason: HOOK_REASON_TEXT }),
        }),
      ),
      await login(
        harness({
          lookups: [knownLookup()],
          map: () => {
            throw new Error(HOOK_REASON_TEXT);
          },
        }),
      ),
      await login(harness()),
      await login(harness({ lookups: [knownLookup()] })),
    ];
    for (const outcome of outcomes) {
      const text = JSON.stringify(outcome);
      expect(text).not.toContain('@');
      expect(text).not.toContain('deny list');
    }
  });
});

describe('completeIdentityLogin: lost write race', () => {
  it('repeats the lookup once and signs in when the second commit succeeds', async () => {
    const h = harness({
      lookups: [
        lookup({ invited: true }),
        lookup({ userByEmail: { id: LINKED_USER, status: 'active', linkedAtProvider: false } }),
      ],
      commits: ['refused', 'created'],
    });
    const outcome = await login(h);
    expect(outcome).toMatchObject({ ok: true, userId: LINKED_USER });
    expect(h.events).toEqual([
      'mapGroups',
      'lookup',
      'resolveIdentity',
      'commit',
      'lookup',
      'resolveIdentity',
      'commit',
    ]);
    const [first, second] = h.plans() as [LoginPlan, LoginPlan];
    expect(first.createUser).toBe(true);
    expect(second).toMatchObject({ userId: LINKED_USER, createUser: false });
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session.secretHash).not.toBe(first.session.secretHash);
    expect(h.setCookies).toHaveBeenCalledTimes(1);
  });

  it('mints a fresh user id for a retried creation', async () => {
    const h = harness({ lookups: [lookup({ invited: true })], commits: ['refused', 'created'] });
    await login(h);
    const [first, second] = h.plans() as [LoginPlan, LoginPlan];
    expect(first.userId).not.toBe(second.userId);
    expect(first.identityId).not.toBe(second.identityId);
    const hookUsers = h.resolveHandler.mock.calls.map(
      (call) => (call[0] as { userId: string }).userId,
    );
    expect(hookUsers).toEqual([first.userId, second.userId]);
  });

  it('refuses conflict when the second commit is refused too, without cookies', async () => {
    const h = harness({ lookups: [knownLookup()], commits: ['refused', 'refused'] });
    expect(await login(h)).toEqual({ ok: false, reason: 'conflict' });
    expect(h.commit).toHaveBeenCalledTimes(2);
    expect(h.lookupForLogin).toHaveBeenCalledTimes(2);
    expect(h.setCookies).not.toHaveBeenCalled();
  });

  it('applies the refusal rules to the second lookup', async () => {
    const h = harness({
      lookups: [
        lookup({ invited: true }),
        lookup({ userByEmail: { id: LINKED_USER, status: 'suspended', linkedAtProvider: false } }),
      ],
      commits: ['refused'],
    });
    expect(await login(h)).toEqual({ ok: false, reason: 'user_suspended' });
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it('lets a failing writer, lookup or cookie builder propagate', async () => {
    const writer = harness({ lookups: [knownLookup()] });
    writer.commit.mockRejectedValueOnce(new Error('db down'));
    await expect(login(writer)).rejects.toThrow('db down');

    const reader = harness({ lookups: [knownLookup()] });
    reader.lookupForLogin.mockRejectedValueOnce(new Error('db down'));
    await expect(login(reader)).rejects.toThrow('db down');

    const cookies = harness({ lookups: [knownLookup()] });
    cookies.setCookies.mockImplementationOnce(() => {
      throw new RangeError('expiry');
    });
    await expect(login(cookies)).rejects.toBeInstanceOf(RangeError);
  });
});

function firstPlan(harnessValue: Harness): LoginPlan & { autoJoin: boolean } {
  return harnessValue.plans()[0] as LoginPlan & { autoJoin: boolean };
}

describe('completeIdentityLogin: denial attribution', () => {
  it.each([
    ['denied', () => ({ deny: true, reason: 'free text ada@example.test token=abc123' })],
    ['invalid_hook_result', () => ({ deny: 'yes', note: 'secret abc123' })],
    [
      'hook_error',
      () => {
        throw new Error('secret ada@example.test token=abc123');
      },
    ],
  ])('reports only the plugin id and %s code', async (code, resolve) => {
    const h = harness({ lookups: [knownLookup()], resolve });
    const onDenied = vi.fn();
    const outcome = await completeIdentityLogin(
      { ...h.deps, onDenied },
      ctx,
      provider(),
      identity(),
      meta,
    );

    expect(outcome).toEqual({ ok: false, reason: 'hook_denied' });
    expect(onDenied.mock.calls).toEqual([[{ plugin: 'p-resolve', code }]]);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.setCookies).not.toHaveBeenCalled();
  });

  it('attributes the denial to the second hook when the first hook approves', async () => {
    const h = harness({ lookups: [knownLookup()] });
    const first = vi.fn<ResolveIdentityHandler>(() => undefined);
    const second = vi.fn<ResolveIdentityHandler>(() => ({
      deny: true as const,
      reason: HOOK_REASON_TEXT,
    }));
    const onDenied = vi.fn();
    const deps: IdentityLoginDeps = {
      ...h.deps,
      hooks: {
        ...h.deps.hooks,
        'auth.resolveIdentity': [
          { plugin: 'p-first', handler: first },
          { plugin: 'p-second', handler: second },
        ],
      },
      onDenied,
    };

    expect(await completeIdentityLogin(deps, ctx, provider(), identity(), meta)).toEqual({
      ok: false,
      reason: 'hook_denied',
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(onDenied.mock.calls).toEqual([[{ plugin: 'p-second', code: 'denied' }]]);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.setCookies).not.toHaveBeenCalled();
  });

  it('reports only the first hook when it denies and a later hook would deny too', async () => {
    const h = harness({ lookups: [knownLookup()] });
    const first = vi.fn<ResolveIdentityHandler>(() => ({
      deny: true as const,
      reason: HOOK_REASON_TEXT,
    }));
    const second = vi.fn<ResolveIdentityHandler>(() => ({
      deny: true as const,
      reason: HOOK_REASON_TEXT,
    }));
    const onDenied = vi.fn();
    const deps: IdentityLoginDeps = {
      ...h.deps,
      hooks: {
        ...h.deps.hooks,
        'auth.resolveIdentity': [
          { plugin: 'p-first', handler: first },
          { plugin: 'p-second', handler: second },
        ],
      },
      onDenied,
    };

    expect(await completeIdentityLogin(deps, ctx, provider(), identity(), meta)).toEqual({
      ok: false,
      reason: 'hook_denied',
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(onDenied.mock.calls).toEqual([[{ plugin: 'p-first', code: 'denied' }]]);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.setCookies).not.toHaveBeenCalled();
  });

  it.each([
    ['not invited', 'not_invited', () => harness()],
    [
      'provider rebound',
      'provider_rebound',
      () =>
        harness({
          lookups: [knownLookup({ boundAnchor: 'oidc:https://other.example.test' })],
        }),
    ],
    [
      'missing identity user',
      'invalid_identity',
      () => harness({ lookups: [knownLookup({ identityUser: null })] }),
    ],
  ])('does not report a denial for the non-hook refusal %s', async (_name, reason, make) => {
    const h = make();
    const onDenied = vi.fn();
    const outcome = await completeIdentityLogin(
      { ...h.deps, onDenied },
      ctx,
      provider(),
      identity(),
      meta,
    );

    expect(outcome).toEqual({ ok: false, reason });
    expect(onDenied).not.toHaveBeenCalled();
  });

  it.each([
    () => {
      throw new Error('reporter failed');
    },
    () => Promise.reject(new Error('reporter failed')),
  ])('reports the denial and preserves the refusal when the reporter fails', async (failure) => {
    const h = harness({ lookups: [knownLookup()], resolve: () => ({ deny: true }) });
    const onDenied = vi.fn(failure as () => void);
    expect(
      await completeIdentityLogin({ ...h.deps, onDenied }, ctx, provider(), identity(), meta),
    ).toEqual({ ok: false, reason: 'hook_denied' });
    expect(onDenied).toHaveBeenCalledWith({ plugin: 'p-resolve', code: 'denied' });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.setCookies).not.toHaveBeenCalled();
  });

  it('does not report a denial for a successful login', async () => {
    const h = harness({ lookups: [knownLookup()] });
    const onDenied = vi.fn();
    expect(
      await completeIdentityLogin({ ...h.deps, onDenied }, ctx, provider(), identity(), meta),
    ).toMatchObject({ ok: true });
    expect(onDenied).not.toHaveBeenCalled();
  });
});
