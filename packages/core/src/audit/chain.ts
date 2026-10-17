export interface AuditRow {
  id: string;
  org_id: string;
  seq: number;
  prev_hash: string;
  hash: string;
  created_at: string;
  actor_type: 'user' | 'service_principal' | 'customer' | 'system';
  actor_id: string | null;
  token_selector: string | null;
  source_ip: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  project_id: string | null;
  payload_json: string;
}

export interface ChainBreak {
  seq: number;
  reason: 'seq_gap' | 'prev_hash' | 'hash';
}

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

const HASHED_COLUMNS = Object.freeze([
  'action',
  'actor_id',
  'actor_type',
  'created_at',
  'id',
  'org_id',
  'payload_json',
  'prev_hash',
  'project_id',
  'seq',
  'target_id',
  'target_type',
  'token_selector',
] as const);

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertSeq(seq: unknown): void {
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) {
    throw new TypeError('audit row seq must be a positive safe integer');
  }
}

export function canonicalRow(row: AuditRow): string {
  assertSeq(row.seq);
  const sorted: Record<string, string | number | null> = {};
  for (const column of HASHED_COLUMNS) {
    const value = Object.hasOwn(row, column) ? row[column] : undefined;
    if (value === undefined) {
      throw new TypeError(`audit row column ${column} is undefined`);
    }
    sorted[column] = value;
  }
  return JSON.stringify(sorted);
}

export async function hashRow(prevHash: string, row: AuditRow): Promise<string> {
  if (!HASH_PATTERN.test(prevHash)) {
    throw new TypeError('prevHash must be 64 lowercase hex characters');
  }
  if (prevHash !== row.prev_hash) {
    throw new TypeError('prevHash must equal row.prev_hash');
  }
  const bytes = new TextEncoder().encode(prevHash + canonicalRow(row));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyChain(
  rows: readonly AuditRow[],
  startPrevHash?: string,
): Promise<ChainBreak | null> {
  let expectedPrev = startPrevHash ?? AUDIT_GENESIS_HASH;
  let expectedSeq = startPrevHash === undefined ? 1 : null;
  for (const row of rows) {
    assertSeq(row.seq);
    if (expectedSeq !== null && row.seq !== expectedSeq) {
      return { seq: row.seq, reason: 'seq_gap' };
    }
    if (row.prev_hash !== expectedPrev) {
      return { seq: row.seq, reason: 'prev_hash' };
    }
    if ((await hashRow(row.prev_hash, row)) !== row.hash) {
      return { seq: row.seq, reason: 'hash' };
    }
    expectedPrev = row.hash;
    expectedSeq = row.seq + 1;
  }
  return null;
}
