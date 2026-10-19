import type { ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import {
  KeyringMismatchError,
  KeyringStoreUnavailableError,
  type KeyringVerifierStore,
  type StoredVerifier,
} from '@package-broker/core/secrets/keyring-verifier';
import { sql } from 'kysely';
import { compile, db } from '../kysely.js';

const MAC_BYTES = 32;
const HEX = /^[0-9a-fA-F]{64}$/;
const MISSING_TABLE = /no such table/i;

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
  const out = new Uint8Array(MAC_BYTES);
  for (let index = 0; index < MAC_BYTES; index += 1) {
    out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function mentionsMissingTable(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (MISSING_TABLE.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (mentionsMissingTable(error)) throw new KeyringStoreUnavailableError();
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

const USED_VERSIONS: ScalarStatement = {
  sql: `SELECT key_version AS version FROM credential
UNION SELECT pepper_version FROM token
UNION SELECT CAST(substr(rest, 1, instr(rest, '$') - 1) AS INTEGER)
  FROM (SELECT substr(password_hash, instr(password_hash, '$v=') + 3) AS rest
        FROM local_login WHERE password_hash IS NOT NULL)
ORDER BY 1`,
  params: [],
};

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
    usedVersions() {
      return guarded(async () => {
        const rows = await executor.all<{ version: number }>(USED_VERSIONS);
        return rows.map((row) => row.version);
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
      await guarded(() =>
        executor.batch([
          {
            sql: `INSERT INTO keyring_verifier (key_version, mac) VALUES (?, ${blobLiteral(row.mac)}) ON CONFLICT (key_version) DO NOTHING`,
            params: [versionOf(row)],
          },
        ]),
      );
    },
  };
}
