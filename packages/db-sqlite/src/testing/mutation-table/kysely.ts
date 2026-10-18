import { ANCHORS, NOT_NULL, ref as fixtureRef, seedBindings, seedSubject } from './fixtures.js';
import type { Kysely } from 'kysely';
import { epochEntry } from './cache-epoch-cases.js';
import { expect } from 'vitest';
import { sql } from 'kysely';
import type { OrgContext } from '@package-broker/core/db/port';
import {
  adminEligibility,
  anchorMatches,
  authoritativeVerifiedIdentity,
  boundVerifiedIdentity,
  compile,
  db,
  guardBindings,
  opGuard,
  ownsIdentity,
  protectedHolder,
  usableLocalLogin,
  verifiedIdentity,
  type Guard,
  type HolderAlias,
} from '../../kysely.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';

type Branch = 'local' | 'email' | 'group';
type Layer = 'user' | 'grant' | 'role' | 'member' | 'login' | 'credential' | 'identity' | 'binding';
const providers = [
  {
    provider: 'oidc',
    anchor: 'issuer',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const aliases: HolderAlias = {
  user: 'u',
  grant: 'g',
  role: 'r',
  member: 'm',
  login: 'l',
  credential: 'c',
  identity: 'i',
  binding: 'b',
};

async function authority(context: CaseContext, branch: Branch, layer: Layer): Promise<void> {
  const { own, foreign } = orgOf(context);
  const org = (part: Layer): string => {
    const shifted =
      part === layer ||
      (part === 'role' &&
        (layer === 'grant' || (branch !== 'group' && layer === 'user') || layer === 'member')) ||
      (part === 'grant' && ((branch !== 'group' && layer === 'user') || layer === 'member'));
    return shifted ? foreign.orgId : own.orgId;
  };
  const seed = seeder(context.executor);
  const stamp = new Date().toISOString();
  await seed(
    "INSERT INTO user_account (id, org_id, email) VALUES ('U', ?, 'holder@example.test')",
    org('user'),
  );
  await seed(
    "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('R', ?, 'admin', 'Admin', 'organization', 1)",
    org('role'),
  );
  await seed(
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, role_id) VALUES ('G', ?, ?, ?, ?, 'organization', 'R')",
    org('grant'),
    branch === 'group' ? 'group' : 'email',
    branch === 'group' ? 'admins' : 'holder@example.test',
    branch === 'group' ? 'oidc' : null,
  );
  if (branch === 'local') {
    await seed(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('C', ?, 'totp', X'01', zeroblob(12), 1, 'totp')",
      org('credential'),
    );
    await seed(
      "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, last_op_id) VALUES ('U', ?, 'pbkdf2-sha256$x', 'C', ?, 'op')",
      org('login'),
      stamp,
    );
  } else {
    await seed(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('I', ?, 'U', 'oidc', 'subject', 'holder@example.test', 1, ?)",
      org('identity'),
      stamp,
    );
    await seed(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'issuer')",
      org('binding'),
    );
    if (branch === 'group')
      await seed(
        "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, 'U', 'oidc', 'admins', ?)",
        org('member'),
        stamp,
      );
  }
}

async function holds(context: CaseContext, guard: Guard): Promise<number | undefined> {
  const rows = await context.executor.all<{ holds: number }>(
    context.mutate(compile(db.selectNoFrom(sql<number>`${guard}`.as('holds')))),
  );
  return rows[0]?.holds;
}

function simpleCase(
  name: string,
  branch: Branch,
  layer: Layer,
  build: (ctx: OrgContext) => Guard,
): ContractCase {
  return {
    name,
    async run(context) {
      await authority(context, branch, layer);
      expect(await holds(context, build(orgOf(context).own))).toBe(0);
    },
  };
}

const op = simpleCase(
  'a foreign local login cannot satisfy the operation guard',
  'local',
  'login',
  (ctx) => opGuard(ctx, 'local_login', { userId: 'U' }, 'op'),
);
const identity = simpleCase(
  'a foreign identity cannot establish ownership',
  'email',
  'identity',
  (ctx) => ownsIdentity(ctx, { provider: 'oidc', subject: 'subject', userId: 'U' }),
);
const anchor = simpleCase(
  'a foreign binding cannot establish the provider anchor',
  'email',
  'binding',
  (ctx) => anchorMatches(ctx, 'oidc', 'issuer'),
);

const ref = (alias: string, tail = '\\?') => new RegExp(`"${alias}"\\."org_id" = ${tail}`);
const always = '(1 = 1)';
const notNull = '(? is not null)';

function simpleEntry(builder: string, contractCase: ContractCase, alias: string): MutationEntry {
  return {
    builder,
    file: 'kysely.ts',
    cases: [contractCase],
    predicates: [
      {
        name: `${alias} belongs to the organization`,
        locate: ref(alias),
        neutral: notNull,
        copies: 1,
        caseName: contractCase.name,
      },
    ],
  };
}

const adminCases = (['user', 'grant', 'role'] as const).map((layer) =>
  simpleCase(`admin eligibility rejects a foreign ${layer}`, 'email', layer, (ctx) =>
    adminEligibility(ctx, 'U'),
  ),
);
const adminEntry: MutationEntry = {
  builder: 'adminEligibility',
  file: 'kysely.ts',
  cases: adminCases,
  predicates: ['user', 'grant', 'role'].map((layer, index) => ({
    name: `admin ${layer} belongs to the organization`,
    locate: ref(
      `guard_${layer}`,
      index === 0 ? '\\?' : index === 1 ? '"guard_user"\\."org_id"' : '"guard_grant"\\."org_id"',
    ),
    neutral: index === 0 ? notNull : always,
    copies: 1,
    caseName: adminCases[index]!.name,
  })),
};

function evidenceCase(
  builder: 'usableLocalLogin' | 'verifiedIdentity' | 'boundVerifiedIdentity',
  layer: Layer,
): ContractCase {
  return {
    name: `${builder} rejects a foreign ${layer}`,
    async run(context) {
      const { own } = orgOf(context);
      await authority(context, builder === 'usableLocalLogin' ? 'local' : 'email', layer);
      const bindings = guardBindings(
        { values: 'v', anchors: 'a' },
        { org_id: own.orgId },
        providers,
      );
      const query =
        builder === 'usableLocalLogin'
          ? usableLocalLogin(own, aliases)
          : builder === 'verifiedIdentity'
            ? verifiedIdentity(own, aliases, providers, undefined)
            : boundVerifiedIdentity(bindings, aliases, true);
      const creator =
        builder === 'boundVerifiedIdentity'
          ? bindings.creator
          : (db as unknown as typeof bindings.creator);
      const outer = creator
        .selectFrom('user_account as u')
        .select('u.id')
        .where('u.id', '=', 'U')
        .where((eb) => eb.exists(query));
      expect(await context.executor.all(context.mutate(compile(outer)))).toEqual([]);
    },
  };
}

const evidenceEntries = (
  ['usableLocalLogin', 'verifiedIdentity', 'boundVerifiedIdentity'] as const
).map((builder): MutationEntry => {
  const layers =
    builder === 'usableLocalLogin'
      ? (['login', 'credential'] as const)
      : (['identity', 'binding'] as const);
  const cases = layers.map((layer) => evidenceCase(builder, layer));
  return {
    builder,
    file: 'kysely.ts',
    cases,
    predicates: layers.map((layer, index) => ({
      name: `${layer} evidence belongs to the organization`,
      locate: ref(
        aliases[layer],
        builder === 'boundVerifiedIdentity' ? '\\(select "v"\\."org_id" from "v"\\)' : '\\?',
      ),
      neutral: builder === 'boundVerifiedIdentity' ? always : notNull,
      copies: 1,
      caseName: cases[index]!.name,
    })),
  };
});

function holderCase(branch: Branch, layer: Layer, recovery = false): ContractCase {
  return {
    name: `${recovery ? 'recovery' : branch} holder rejects a foreign ${layer}`,
    async run(context) {
      await authority(context, branch, layer);
      const guard = protectedHolder(
        orgOf(context).own,
        sql.ref('candidate.id'),
        recovery
          ? { kind: 'local_recovery' }
          : { kind: 'fresh', now: new Date().toISOString(), providers },
      );
      const query = db
        .selectFrom('user_account as candidate')
        .select('candidate.id')
        .where('candidate.id', '=', 'U')
        .where(guard);
      expect(await context.executor.all(context.mutate(compile(query)))).toEqual([]);
    },
  };
}

const holderCases: ContractCase[] = [];
const holderPredicates: MutationEntry['predicates'][number][] = [];
for (const branch of ['local', 'email', 'group', 'recovery'] as const) {
  const actual = branch === 'recovery' ? 'local' : branch;
  const layers: Layer[] = [
    'user',
    'grant',
    'role',
    ...(actual === 'local'
      ? (['login', 'credential'] as const)
      : actual === 'email'
        ? (['identity', 'binding'] as const)
        : (['member', 'identity', 'binding'] as const)),
  ];
  for (const layer of layers) {
    const contractCase = holderCase(actual, layer, branch === 'recovery');
    holderCases.push(contractCase);
    const copies =
      branch === 'recovery' || ['login', 'credential', 'member'].includes(layer)
        ? 1
        : ['identity', 'binding'].includes(layer)
          ? 2
          : 3;
    const copy =
      copies === 1
        ? 0
        : ['identity', 'binding'].includes(layer)
          ? actual === 'email'
            ? 0
            : 1
          : ['local', 'email', 'group'].indexOf(actual);
    const tail =
      layer === 'grant'
        ? `"guard_${actual === 'group' ? 'member' : 'user'}"\\."org_id"`
        : layer === 'role'
          ? '"guard_grant"\\."org_id"'
          : '\\(select "guard_values"\\."org_id" from "guard_values"\\)';
    // Grant joins use a different operand in the group branch, so their locator sees fewer copies.
    const grantCopies =
      layer === 'grant' && branch !== 'recovery' ? (actual === 'group' ? 1 : 2) : copies;
    const grantCopy = layer === 'grant' && actual === 'group' ? 0 : copy;
    holderPredicates.push({
      name: `${branch} holder ${layer} belongs to the organization`,
      locate: ref(`guard_${layer}`, tail),
      neutral: always,
      copies: grantCopies,
      caseName: contractCase.name,
      waivedCopies: Object.fromEntries(
        Array.from({ length: grantCopies }, (_, index) => index)
          .filter((index) => index !== grantCopy)
          .map((index) => [
            index,
            `Independently stripped by "${(['identity', 'binding'].includes(layer) ? ['email', 'group'] : ['local', 'email', 'group'])[index]} holder rejects a foreign ${layer}"; this case isolates ${branch}.`,
          ]),
      ),
    });
  }
}

const authoritativeIdentityCase = (layer: 'identity' | 'binding'): ContractCase => ({
  name: `an authoritative ${layer} row of another organization does not verify the user`,
  async run(context) {
    const { own } = orgOf(context);
    await seedBindings(context);
    const control = await seedSubject(context, 'ok');
    const bad = await seedSubject(context, 'bad', { mismatched: layer });
    const alias = {
      user: 'reader_user',
      identity: 'reader_identity',
      binding: 'reader_binding',
      grant: 'reader_grant',
      role: 'reader_role',
      member: 'reader_member',
      login: 'reader_login',
      credential: 'reader_credential',
    };
    const rowsOf = (userId: string, mutated: boolean) => {
      const statement = compile(
        (db as unknown as Kysely<Record<string, Record<string, unknown>>>)
          .selectFrom('user_account as reader_user')
          .select('reader_user.id')
          .where('reader_user.org_id', '=', own.orgId)
          .where('reader_user.id', '=', userId)
          .where((eb) => eb.exists(authoritativeVerifiedIdentity(own, alias, ANCHORS))),
      );
      return context.executor.all(mutated ? context.mutate(statement) : statement);
    };
    expect(await rowsOf(control.userId, false)).toHaveLength(1);
    expect(await rowsOf(bad.userId, true)).toEqual([]);
  },
});

export const kyselyEntries: readonly MutationEntry[] = [
  {
    builder: 'authoritativeVerifiedIdentity',
    file: 'kysely.ts',
    cases: [authoritativeIdentityCase('identity'), authoritativeIdentityCase('binding')],
    waivers: [
      {
        locate: fixtureRef('reader_user', 'org_id', '\\?'),
        reason: 'scopes the outer user query, not part of the identity builder',
      },
    ],
    predicates: [
      {
        name: 'the authoritative identity is scoped to the organization',
        locate: fixtureRef('reader_identity', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: authoritativeIdentityCase('identity').name,
      },
      {
        name: 'the authoritative provider binding is scoped to the organization',
        locate: fixtureRef('reader_binding', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: authoritativeIdentityCase('binding').name,
      },
    ],
  },
  epochEntry('kysely.ts', 'cacheEpochBumpStatements'),
  epochEntry('kysely.ts', 'assertGuard'),
  simpleEntry('opGuard', op, 'guard_op'),
  simpleEntry('ownsIdentity', identity, 'guard_identity'),
  simpleEntry('anchorMatches', anchor, 'guard_binding'),
  adminEntry,
  ...evidenceEntries,
  {
    builder: 'protectedHolder',
    file: 'kysely.ts',
    cases: holderCases,
    predicates: holderPredicates,
  },
];
