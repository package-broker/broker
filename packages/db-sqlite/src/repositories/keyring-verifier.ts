import { PASSWORD_HASH_PATTERN, PASSWORD_ITERATIONS } from '@package-broker/core/auth/password';
import { base64urlDecode } from '@package-broker/core/auth/primitives';
import { credentialAad } from '@package-broker/core/secrets/cipher';
import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import {
  KeyringMismatchError,
  KeyringVersionInUseError,
  KeyringPasswordHashUnreadableError,
  KeyringStoreUnavailableError,
  type KeyringVerifierStore,
  type StoredVerifier,
} from '@package-broker/core/secrets/keyring-verifier';
import { sql } from 'kysely';
import { compile, db } from '../kysely.js';

const MAC_BYTES = 32;
const HEX = /^[0-9a-fA-F]{64}$/;
const MISSING_SCHEMA = /no such (?:table|index)/i;

interface Row {
  readonly key_version: number;
  readonly mac_hex: unknown;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function mentionsMissingSchema(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (MISSING_SCHEMA.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (mentionsMissingSchema(error)) throw new KeyringStoreUnavailableError();
    throw error;
  }
}

/**
 * Scalar executors cannot bind BLOBs, so the MAC is written as a BLOB literal built from 32 bytes
 * rendered as 64 hex digits (never caller text) and read back through hex().
 */
function blobLiteral(mac: Uint8Array): string {
  if (mac.length !== MAC_BYTES) throw new RangeError('Keyring verifier must be 32 bytes');
  return `X'${toHex(mac)}'`;
}

function versionOf(row: StoredVerifier): number {
  if (!Number.isSafeInteger(row.version) || row.version < 1) {
    throw new RangeError('Keyring verifier version is out of range');
  }
  return row.version;
}

function configuredVersions(versions: readonly number[]): void {
  if (
    versions.length < 1 ||
    versions.length > 4 ||
    versions.some((v) => !Number.isSafeInteger(v) || v < 1)
  ) {
    throw new RangeError('Expected one to four configured key versions');
  }
}

export function createKeyringVerifierStore(executor: ScalarSqlExecutor): KeyringVerifierStore {
  return {
    list() {
      return guarded(async () => {
        const rows = await executor.all<Row>(
          compile(
            db
              .selectFrom('keyring_verifier')
              .select(['key_version', sql<string>`hex(mac)`.as('mac_hex')])
              .orderBy('key_version', 'desc'),
          ) as ScalarStatement,
        );
        return rows.map((row): StoredVerifier => {
          const hex = row.mac_hex;
          if (typeof hex !== 'string' || !HEX.test(hex)) {
            throw new KeyringMismatchError(row.key_version);
          }
          return { version: row.key_version, mac: fromHex(hex) };
        });
      });
    },
    async checkUsedVersions(configured) {
      configuredVersions(configured);
      return guarded(async () => {
        let used = false;
        // Startup checks the installation's singleton organization before serving requests.
        const scope = 'org_id = (SELECT id FROM organization)';
        const slots = configured.map(() => '?').join(', ');
        for (const [table, query] of [
          [
            'credential',
            `SELECT 1, key_version AS version FROM credential INDEXED BY credential_version_in_use WHERE key_version NOT IN (${slots}) AND ${scope} LIMIT 1`,
          ],
          [
            'token',
            `SELECT 1, pepper_version AS version FROM token INDEXED BY token_pepper_version WHERE pepper_version NOT IN (${slots}) AND ${scope} LIMIT 1`,
          ],
        ] as const) {
          const missing = await executor.all<{ version: number }>({
            sql: query,
            params: [...configured],
          });
          if (missing[0] !== undefined)
            throw new KeyringVersionInUseError(missing[0].version, table);
          const any = await executor.all({
            sql: `SELECT 1 FROM ${table} WHERE ${scope} LIMIT 1`,
            params: [],
          });
          used ||= any.length > 0;
        }
        const hashes = await executor.all<{ password_hash: string }>({
          sql: `SELECT password_hash FROM local_login WHERE password_hash IS NOT NULL AND ${scope}`,
          params: [],
        });
        for (const row of hashes) {
          const match = PASSWORD_HASH_PATTERN.exec(row.password_hash);
          if (match === null || Number(match[1]) !== PASSWORD_ITERATIONS)
            throw new KeyringPasswordHashUnreadableError();
          try {
            base64urlDecode(match[3] as string);
            base64urlDecode(match[4] as string);
          } catch {
            throw new KeyringPasswordHashUnreadableError();
          }
          const version = Number(match[2]);
          if (!configured.includes(version))
            throw new KeyringVersionInUseError(version, 'local_login');
        }
        return used || hashes.length > 0;
      });
    },
    async credentialSamples(configured) {
      configuredVersions(configured);
      return guarded(async () => {
        const samples = [];
        for (const version of configured) {
          const [row] = await executor.all<{
            id: string;
            org_id: string;
            kind: string;
            aad: string;
            ciphertext_hex: string;
            nonce_hex: string;
          }>({
            sql: 'SELECT id, org_id, kind, aad, hex(ciphertext) AS ciphertext_hex, hex(nonce) AS nonce_hex FROM credential WHERE key_version = ? AND org_id = (SELECT id FROM organization) LIMIT 1',
            params: [version],
          });
          if (row === undefined) continue;
          try {
            if (row.aad !== credentialAad({ id: row.id, orgId: row.org_id, kind: row.kind }))
              throw new Error();
          } catch {
            throw new KeyringMismatchError(version);
          }
          samples.push({
            sealed: {
              keyVersion: version,
              ciphertext: fromHex(row.ciphertext_hex),
              nonce: fromHex(row.nonce_hex),
            },
            aad: row.aad,
          });
        }
        return samples;
      });
    },
    enroll(row) {
      return guarded(async () => {
        const [result] = await executor.batch([
          {
            sql: `INSERT INTO keyring_verifier (key_version, mac) SELECT ?, ${blobLiteral(row.mac)} WHERE NOT EXISTS (SELECT 1 FROM keyring_verifier)`,
            params: [versionOf(row)],
          },
        ]);
        return (result?.changes ?? 0) > 0;
      });
    },
    async add(row) {
      const results = await guarded(() =>
        executor.batch([
          {
            sql: `INSERT INTO keyring_verifier (key_version, mac) VALUES (?, ${blobLiteral(row.mac)}) ON CONFLICT (key_version) DO NOTHING`,
            params: [versionOf(row)],
          },
        ]),
      );
      return (results[0]?.changes ?? 0) > 0;
    },
  };
}
