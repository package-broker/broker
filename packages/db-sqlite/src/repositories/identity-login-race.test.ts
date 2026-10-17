import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeIdentityLogin } from '@package-broker/core/auth/identity-login';
import type { IdentityLoginDeps } from '@package-broker/core/auth/identity-login';
import { createSessionService } from '@package-broker/core/auth/session';
import type { SessionMeta } from '@package-broker/core/auth/session';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { IdentityProvider, VerifiedIdentity } from '@package-broker/core/identity/port';
import type { HookMap } from '@package-broker/core/plugin';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createLoginWriter } from './login.js';
import { createSessionRepository } from './session.js';
import { createUserRepository } from './user.js';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const EMAIL = 'victim@example.test';
const VICTIM_USER = '01J0USERVICTIM00000000000V1';
const VICTIM_SUBJECT = 'sub-victim';
const ATTACKER_SUBJECT = 'sub-attacker';
const META: SessionMeta = { ip: null, userAgent: null, previousSecretHash: null };

const provider: IdentityProvider = {
  id: 'dex',
  kind: 'oidc',
  displayName: 'Dex',
  trustAnchor: 'oidc:https://dex.example.test',
  policy: {
    verifiedDomains: ['example.test'],
    emailAuthoritativeDomains: ['example.test'],
    autoJoin: false,
  },
  supportsReauth: false,
  start: () => Promise.reject(new Error('unused')),
  finish: () => Promise.reject(new Error('unused')),
};

function identityFor(subject: string): VerifiedIdentity {
  return {
    provider: 'dex',
    subject,
    email: EMAIL,
    emailVerified: true,
    displayName: null,
    groups: [],
    issuedAt: new Date(NOW).toISOString(),
    authTime: null,
  };
}

let database: MigratedDatabase;
let executor: SqlExecutor;
let org: OrgContext;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  org = database.orgs.a;
  executor = database.executor;
  await executor.batch([
    {
      sql: 'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      params: [VICTIM_USER, org.orgId, EMAIL, 'active'],
    },
  ]);
});

afterEach(async () => {
  await database.close();
});

function depsWith(resolve: HookMap['auth.resolveIdentity']): IdentityLoginDeps {
  const clock = { now: () => new Date(NOW) };
  return {
    users: createUserRepository(executor),
    writer: createLoginWriter(executor),
    sessions: createSessionService({
      sessions: createSessionRepository(executor),
      clock,
      publicOrigin: 'https://broker.test',
    }),
    hooks: {
      'auth.resolveIdentity': [{ plugin: 'gate', handler: resolve }],
      'auth.mapGroups': [],
    },
    clock,
    ids: { ulid: () => ulid(NOW) },
  };
}

describe('identity login write race', () => {
  it('ends already_linked for the attacker when the victim links between lookup and commit', async () => {
    let attackerParked: () => void = () => undefined;
    const parked = new Promise<void>((resolve) => {
      attackerParked = resolve;
    });
    let releaseAttacker: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAttacker = resolve;
    });
    const deps = depsWith(async (input) => {
      if (input.identity.subject === ATTACKER_SUBJECT) {
        attackerParked();
        await gate;
      }
      return undefined;
    });

    const attacker = completeIdentityLogin(
      deps,
      org,
      provider,
      identityFor(ATTACKER_SUBJECT),
      META,
    );
    await parked;
    const victim = await completeIdentityLogin(
      deps,
      org,
      provider,
      identityFor(VICTIM_SUBJECT),
      META,
    );
    expect(victim.ok).toBe(true);
    releaseAttacker();
    const outcome = await attacker;

    expect(outcome).toEqual({ ok: false, reason: 'already_linked' });
    const identities = await executor.all<{ subject: string; user_id: string }>({
      sql: 'SELECT subject, user_id FROM identity ORDER BY subject',
      params: [],
    });
    expect(identities).toEqual([{ subject: VICTIM_SUBJECT, user_id: VICTIM_USER }]);
    const sessions = await executor.all<{ user_id: string; identity_id: string }>({
      sql: 'SELECT user_id, identity_id FROM session',
      params: [],
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.user_id).toBe(VICTIM_USER);
    const linked = await executor.all<{ id: string }>({
      sql: 'SELECT id FROM identity WHERE subject = ?',
      params: [VICTIM_SUBJECT],
    });
    expect(sessions[0]?.identity_id).toBe(linked[0]?.id);
  });

  it('lets the attacker create nothing when the victim wins and the hook ran for both', async () => {
    const seen: string[] = [];
    let releaseAttacker: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAttacker = resolve;
    });
    let attackerParked: () => void = () => undefined;
    const parked = new Promise<void>((resolve) => {
      attackerParked = resolve;
    });
    const deps = depsWith(async (input) => {
      seen.push(input.identity.subject);
      if (input.identity.subject === ATTACKER_SUBJECT) {
        attackerParked();
        await gate;
      }
      return undefined;
    });

    const attacker = completeIdentityLogin(
      deps,
      org,
      provider,
      identityFor(ATTACKER_SUBJECT),
      META,
    );
    await parked;
    await completeIdentityLogin(deps, org, provider, identityFor(VICTIM_SUBJECT), META);
    releaseAttacker();
    await attacker;

    expect(seen).toEqual([ATTACKER_SUBJECT, VICTIM_SUBJECT]);
    const users = await executor.all<{ id: string }>({
      sql: 'SELECT id FROM user_account',
      params: [],
    });
    expect(users).toEqual([{ id: VICTIM_USER }]);
  });
});
