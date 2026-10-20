import { expect } from 'vitest';
import { credentialAad } from '@package-broker/core/secrets/cipher';
import { createLocalLoginSetupWriter } from '../../repositories/local-login-setup.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { FUTURE, HASH, seedUser } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignCredential: ContractCase = {
  name: 'TOTP restaging preserves a foreign credential child of an own local login',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', own.orgId);
    await seed(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('OLD', ?, 'totp', X'01', zeroblob(12), 1, 'aad')",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO local_login (user_id, org_id, setup_hash, setup_expires_at, totp_credential_id) VALUES ('U', ?, ?, ?, 'OLD')",
      own.orgId,
      HASH,
      FUTURE,
    );
    const now = new Date().toISOString();
    expect(
      await createLocalLoginSetupWriter(executing(context)).stagePendingTotp(own, {
        userId: 'U',
        setupHash: HASH,
        now,
        credential: {
          id: 'NEW',
          projectId: null,
          kind: 'totp',
          sealed: { ciphertext: new Uint8Array([1]), nonce: new Uint8Array(12), keyVersion: 1 },
          aad: credentialAad({ id: 'NEW', orgId: own.orgId, kind: 'totp' }),
          rotatedAt: null,
          now,
        },
      }),
    ).toBe(true);
    expect(
      await context.executor.all({ sql: "SELECT id FROM credential WHERE id = 'OLD'", params: [] }),
    ).toEqual([{ id: 'OLD' }]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry(
    'local-login-setup',
    'createLocalLoginSetupWriter',
    foreignCredential,
    /(?<=delete from "credential" where )"org_id" = \?/,
    [
      {
        locate: /"(?:local_login|credential|guard_op)"\."org_id" = \?/,
        reason:
          'The own local login and new credential are controls; opGuard and credential ownership predicates are independently registered in kysely.ts and credential-factory.ts.',
      },
      {
        locate: /(?<!delete from "credential" where )(?<![\w.])"org_id" = \?/,
        reason:
          'markSetup and pointAtPending target the own local-login control; the foreign pending credential deletion is mutated independently.',
      },
    ],
  ),
];
