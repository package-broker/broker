import { expect } from 'vitest';
import { createLocalLoginSuccessWriter } from '../../repositories/local-login-success.js';
import { createLocalLoginReader } from '../../repositories/local-login.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { FUTURE, HASH, OTHER_HASH, seedSubject } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignSession: ContractCase = {
  name: 'local reauthentication refuses a foreign session child without advancing its own login',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    const subject = await seedSubject(context, 'admin');
    await seed("UPDATE role SET protects_last_holder = 1 WHERE id = 'R-admin'");
    await seed(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('C', ?, 'totp', X'01', zeroblob(12), 1, 'aad')",
      own.orgId,
    );
    await seed(
      "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at, totp_last_step) VALUES (?, ?, 'pbkdf2-sha256$x', 'C', ?, 1)",
      subject.userId,
      own.orgId,
      FUTURE,
    );
    await seed(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES ('FOREIGN', ?, ?, ?, ?, ?)",
      foreign.orgId,
      subject.userId,
      HASH,
      OTHER_HASH,
      FUTURE,
    );
    const snapshot = await createLocalLoginReader(context.executor).findByEmail(
      own,
      'admin@example.test',
    );
    expect(snapshot?.adminEligible).toBe(true);
    if (snapshot === null) throw new Error('missing login control');
    expect(
      await createLocalLoginSuccessWriter(executing(context)).succeed(own, {
        snapshot,
        step: 2,
        rehash: null,
        session: null,
        previousSecretHash: null,
        reauthSessionId: 'FOREIGN',
        now: new Date().toISOString(),
      }),
    ).toBe(false);
    expect(
      await context.executor.all({ sql: 'SELECT totp_last_step FROM local_login', params: [] }),
    ).toEqual([{ totp_last_step: 1 }]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry(
    'local-login-success',
    'createLocalLoginSuccessWriter',
    foreignSession,
    /(?<=from "session" where )"session"\."org_id" = \?/,
    [
      {
        locate: /"(?:local_login|guard_\w+)"\."org_id" = /,
        reason:
          'The own local login is a control; adminEligibility and opGuard are independently registered in kysely.ts.',
      },
      {
        locate: /(?<=update "session" set [^;]{0,100})"session"\."org_id" = \?/,
        reason:
          'The reauthentication update repeats the same globally unique session id already checked by reauthSessionExists; without the operation marker it cannot update any session.',
      },
    ],
  ),
];
