import { describe, expect, it } from 'vitest';
import { AUDIT_GENESIS_HASH, type AuditRow, canonicalRow, hashRow, verifyChain } from './chain.js';

const ROW1_HASH = '15bd66283f29e8842c2e4298547005f431ad62c3d20aacc58a3090abfabbb7e4';
const ROW2_HASH = 'd8000aaf961f24d114d557e56ea996baaeef6ed1df6fb33188e5c6a572515110';

const ROW1_CANONICAL =
  '{"action":"role.create","actor_id":"01J0USER000000000000000000","actor_type":"user","created_at":"2026-10-16T09:00:00.000Z","id":"01J0AUDIT000000000000000A","org_id":"01J0ACME000000000000000000","payload_json":"{\\"changes\\":{\\"name\\":{\\"new\\":\\"Auditor\\"}},\\"op_id\\":\\"01J0OPID000000000000000000\\",\\"request_id\\":\\"req-1\\"}","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","project_id":null,"seq":1,"target_id":"01J0ROLE000000000000000000","target_type":"role","token_selector":null}';

const row1: AuditRow = {
  id: '01J0AUDIT000000000000000A',
  org_id: '01J0ACME000000000000000000',
  seq: 1,
  prev_hash: AUDIT_GENESIS_HASH,
  hash: ROW1_HASH,
  created_at: '2026-10-16T09:00:00.000Z',
  actor_type: 'user',
  actor_id: '01J0USER000000000000000000',
  token_selector: null,
  source_ip: '203.0.113.7',
  action: 'role.create',
  target_type: 'role',
  target_id: '01J0ROLE000000000000000000',
  project_id: null,
  payload_json:
    '{"changes":{"name":{"new":"Auditor"}},"op_id":"01J0OPID000000000000000000","request_id":"req-1"}',
};

const row2: AuditRow = {
  ...row1,
  id: '01J0AUDIT000000000000000B',
  seq: 2,
  prev_hash: ROW1_HASH,
  hash: ROW2_HASH,
  action: 'role.delete',
  target_id: '01J0ROLE000000000000000001',
  payload_json: '{"op_id":"01J0OPID000000000000000001","request_id":"req-2"}',
};

const row3: AuditRow = { ...row2, id: '01J0AUDIT000000000000000C', seq: 3, prev_hash: ROW2_HASH };

async function chained(): Promise<AuditRow[]> {
  const third = { ...row3, hash: await hashRow(ROW2_HASH, row3) };
  return [row1, row2, third];
}

describe('canonicalRow', () => {
  it('reproduces the fixed vector for row 1', () => {
    expect(canonicalRow(row1)).toBe(ROW1_CANONICAL);
  });

  it('orders keys by code unit regardless of the object literal order', () => {
    const shuffled: AuditRow = {
      target_type: row1.target_type,
      payload_json: row1.payload_json,
      seq: row1.seq,
      source_ip: row1.source_ip,
      hash: row1.hash,
      id: row1.id,
      project_id: row1.project_id,
      action: row1.action,
      created_at: row1.created_at,
      token_selector: row1.token_selector,
      org_id: row1.org_id,
      actor_id: row1.actor_id,
      prev_hash: row1.prev_hash,
      target_id: row1.target_id,
      actor_type: row1.actor_type,
    };
    const keys = Object.keys(JSON.parse(canonicalRow(shuffled)) as object);
    expect(keys).toEqual([...keys].sort());
    expect(canonicalRow(shuffled)).toBe(ROW1_CANONICAL);
  });

  it('contains no hash key', () => {
    expect(JSON.parse(canonicalRow(row1))).not.toHaveProperty('hash');
  });

  it('contains no source_ip key', () => {
    expect(JSON.parse(canonicalRow(row1))).not.toHaveProperty('source_ip');
  });
});

describe('hashRow', () => {
  it('genesis hash is 64 zero characters', () => {
    expect(AUDIT_GENESIS_HASH).toBe('0'.repeat(64));
  });

  it('reproduces the row 1 vector', async () => {
    expect(await hashRow(AUDIT_GENESIS_HASH, row1)).toBe(ROW1_HASH);
  });

  it('reproduces the row 2 vector', async () => {
    expect(await hashRow(ROW1_HASH, row2)).toBe(ROW2_HASH);
  });

  it('is unchanged when source_ip changes', async () => {
    expect(await hashRow(AUDIT_GENESIS_HASH, { ...row1, source_ip: '198.51.100.9' })).toBe(
      ROW1_HASH,
    );
  });

  it('is unchanged when source_ip is null', async () => {
    expect(await hashRow(AUDIT_GENESIS_HASH, { ...row1, source_ip: null })).toBe(ROW1_HASH);
  });

  const mutations: Array<[string, Partial<AuditRow>]> = [
    ['id', { id: '01J0AUDIT000000000000000Z' }],
    ['org_id', { org_id: '01J0OTHER000000000000000000' }],
    ['seq', { seq: 2 }],
    ['prev_hash', { prev_hash: '1'.repeat(64) }],
    ['created_at', { created_at: '2026-10-16T09:00:00.001Z' }],
    ['actor_type', { actor_type: 'system' }],
    ['actor_id', { actor_id: '01J0USER000000000000000001' }],
    ['token_selector', { token_selector: 'sel' }],
    ['action', { action: 'role.update' }],
    ['target_type', { target_type: 'project' }],
    ['target_id', { target_id: '01J0ROLE000000000000000009' }],
    ['project_id', { project_id: '01J0PROJ000000000000000000' }],
    ['payload_json', { payload_json: '{}' }],
  ];

  it.each(mutations)('changes when %s changes', async (_column, change) => {
    const changed = { ...row1, ...change };
    expect(await hashRow(changed.prev_hash, changed)).not.toBe(ROW1_HASH);
  });
});

describe('input validation', () => {
  it('ignores extra keys on the row', async () => {
    const extra = { ...row1, user_email: 'a@example.com', secret: 'x' } as AuditRow;
    expect(await hashRow(AUDIT_GENESIS_HASH, extra)).toBe(ROW1_HASH);
    expect(canonicalRow(extra)).toBe(ROW1_CANONICAL);
  });

  it('throws on a missing column', () => {
    const missing: Partial<AuditRow> = { ...row1 };
    delete missing.actor_id;
    expect(() => canonicalRow(missing as AuditRow)).toThrow(TypeError);
  });

  it('encodes null as JSON null', () => {
    expect(canonicalRow({ ...row1, actor_id: null })).toContain('"actor_id":null');
  });

  it.each([
    ['NaN', Number.NaN],
    ['1.5', 1.5],
    ['a string', '1'],
    ['2^53', 2 ** 53],
  ])('canonicalRow throws when seq is %s', (_label, seq) => {
    expect(() => canonicalRow({ ...row1, seq: seq as number })).toThrow(TypeError);
  });

  it('verifyChain throws when seq is not a safe integer', async () => {
    await expect(verifyChain([{ ...row1, seq: 1.5 }])).rejects.toThrow(TypeError);
  });

  it('hashRow rejects a prevHash that is not lowercase hex', async () => {
    const upper = 'A'.repeat(64);
    await expect(hashRow(upper, { ...row1, prev_hash: upper })).rejects.toThrow(TypeError);
  });

  it('hashRow rejects a prevHash of the wrong length', async () => {
    await expect(hashRow('0'.repeat(63), { ...row1, prev_hash: '0'.repeat(63) })).rejects.toThrow(
      TypeError,
    );
  });

  it('hashRow rejects a prevHash different from row.prev_hash', async () => {
    await expect(hashRow('1'.repeat(64), row1)).rejects.toThrow(TypeError);
  });
});

describe('null actor and target vector', () => {
  const nullRow: AuditRow = { ...row1, actor_type: 'system', actor_id: null, target_id: null };

  it('reproduces the independently computed hash', async () => {
    expect(await hashRow(AUDIT_GENESIS_HASH, nullRow)).toBe(
      '20396310e9c466a7931d0f6fcadad5062c8ba7a010f3f4ef71ac59d344ae043f',
    );
  });
});

describe('verifyChain', () => {
  it('returns null for a valid chain', async () => {
    expect(await verifyChain([row1, row2])).toBeNull();
  });

  it('returns null for an empty chain', async () => {
    expect(await verifyChain([])).toBeNull();
  });

  it('flags a changed payload as a hash break at that seq', async () => {
    const tampered = { ...row1, payload_json: '{"op_id":"x"}' };
    expect(await verifyChain([tampered, row2])).toEqual({ seq: 1, reason: 'hash' });
  });

  it('flags a replaced prev_hash as a prev_hash break', async () => {
    const broken = { ...row2, prev_hash: '2'.repeat(64) };
    expect(await verifyChain([row1, broken])).toEqual({ seq: 2, reason: 'prev_hash' });
  });

  it('flags a removed first row as a seq gap', async () => {
    const [, second, third] = await chained();
    expect(await verifyChain([second!, third!])).toEqual({ seq: 2, reason: 'seq_gap' });
  });

  it('flags a removed middle row as a seq gap', async () => {
    const [first, , third] = await chained();
    expect(await verifyChain([first!, third!])).toEqual({ seq: 3, reason: 'seq_gap' });
  });

  it('honours startPrevHash for a chain that does not start at genesis', async () => {
    expect(await verifyChain([row2], ROW1_HASH)).toBeNull();
  });

  it('flags a start that does not link to startPrevHash', async () => {
    expect(await verifyChain([row2], '3'.repeat(64))).toEqual({ seq: 2, reason: 'prev_hash' });
  });

  it('never returns row content', async () => {
    const sentinel = 'SENTINEL-PAYLOAD-VALUE';
    const tampered = { ...row1, payload_json: sentinel };
    const result = await verifyChain([tampered, row2]);
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});
