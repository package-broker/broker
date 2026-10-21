import { hashPassword } from '@package-broker/core/auth/password';
import { encodeTotpEnvelope, generateTotpSecret } from '@package-broker/core/auth/totp';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createSecretCipher, credentialAad } from '@package-broker/core/secrets/cipher';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import { verifyKeyring } from '@package-broker/core/secrets/keyring-verifier';
import { createKeyringVerifierStore } from '@package-broker/db-sqlite/repositories/keyring-verifier';

export async function createLocalLoginSeed(
  executor: SqlExecutor,
  keyring: Keyring,
  input: { readonly orgId: string; readonly userId: string; readonly credentialId: string },
) {
  await verifyKeyring(keyring, createKeyringVerifierStore(executor));
  const aad = credentialAad({ id: input.credentialId, orgId: input.orgId, kind: 'totp' });
  const sealed = await createSecretCipher(keyring, 'credential-encryption').seal(
    encodeTotpEnvelope(input.userId, generateTotpSecret()),
    aad,
  );
  const passwordHash = await hashPassword('fixture password for reader', keyring);
  return { sealed, aad, passwordHash };
}
