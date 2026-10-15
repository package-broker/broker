import { describe, expect, it } from 'vitest';
import type { CredentialRecord, CredentialRepository } from '../db/credentials.js';
import { orgContext, type Statement } from '../db/port.js';
import { fixedClock, ulid } from '../ids.js';
import {
  SecretDecryptError,
  createSecretCipher,
  credentialAad,
  type Sealed,
  type SecretCipher,
  type SecretDecryptProblem,
} from './cipher.js';
import { CredentialNotFoundError, createCredentialStore } from './credential-store.js';
import { createKeyring } from './keyring.js';
import type { MasterKey } from './master-key.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ORG = orgContext('01J00000000000000000000A0A');
const NOW = '2026-10-15T10:00:00.000Z';
const KIND = 'github-app-key';

function masterKey(version: number, start: number): MasterKey {
  return { version, bytes: Uint8Array.from({ length: 32 }, (_, index) => start + index) };
}

function cipherFor(...keys: MasterKey[]): SecretCipher {
  return createSecretCipher(createKeyring(keys), 'credential-encryption');
}

interface CountingCipher extends SecretCipher {
  readonly opened: number;
  readonly plaintexts: Uint8Array[];
}

function counting(inner: SecretCipher): CountingCipher {
  let opened = 0;
  const plaintexts: Uint8Array[] = [];
  return {
    plaintexts,
    currentVersion: inner.currentVersion,
    seal: (plaintext, aad) => inner.seal(plaintext, aad),
    open: async (sealed, aad) => {
      opened += 1;
      const plaintext = await inner.open(sealed, aad);
      plaintexts.push(plaintext);
      return plaintext;
    },
    needsReseal: (sealed) => inner.needsReseal(sealed),
    get opened() {
      return opened;
    },
  };
}

interface FakeRepository extends CredentialRepository {
  readonly rows: Map<string, CredentialRecord>;
  readonly owners: Map<string, string>;
  readonly statements: Statement[];
  readonly resealCalls: { id: string; expectedVersion: number; keyVersion: number; now: string }[];
  refuseReseal: boolean;
}

function fakeRepository(): FakeRepository {
  const rows = new Map<string, CredentialRecord>();
  const owners = new Map<string, string>();
  const statements: Statement[] = [];
  const resealCalls: FakeRepository['resealCalls'] = [];
  const ownedBy = (orgId: string, id: string): boolean => (owners.get(id) ?? ORG.orgId) === orgId;
  const repository: FakeRepository = {
    rows,
    owners,
    statements,
    resealCalls,
    refuseReseal: false,
    insertStatement(ctx, row) {
      checkInsert(ctx.orgId, row);
      const statement: Statement = { sql: 'insert credential', params: [row.id] };
      statements.push(statement);
      return statement;
    },
    async insert(ctx, row) {
      checkInsert(ctx.orgId, row);
      owners.set(row.id, ctx.orgId);
      rows.set(row.id, {
        id: row.id,
        projectId: row.projectId,
        kind: row.kind,
        sealed: row.sealed,
        aad: row.aad,
        rotatedAt: row.rotatedAt,
      });
    },
    async get(ctx, id) {
      return ownedBy(ctx.orgId, id) ? (rows.get(id) ?? null) : null;
    },
    async listBelowVersion(ctx, version, afterId, limit) {
      return [...rows.values()]
        .filter(
          (row) =>
            ownedBy(ctx.orgId, row.id) &&
            row.sealed.keyVersion < version &&
            (afterId === null || row.id > afterId),
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit);
    },
    async reseal(ctx, id, expectedVersion, sealed, now) {
      resealCalls.push({ id, expectedVersion, keyVersion: sealed.keyVersion, now });
      const row = rows.get(id);
      if (
        repository.refuseReseal ||
        row === undefined ||
        !ownedBy(ctx.orgId, id) ||
        row.sealed.keyVersion !== expectedVersion
      ) {
        return false;
      }
      rows.set(id, { ...row, sealed, rotatedAt: now });
      return true;
    },
    async delete(ctx, id) {
      if (!ownedBy(ctx.orgId, id)) return false;
      return rows.delete(id);
    },
  };
  return repository;
}

function checkInsert(orgId: string, row: CredentialRecord): void {
  if (row.aad !== credentialAad({ id: row.id, orgId, kind: row.kind })) {
    throw new TypeError('aad does not match the credential id, organization and kind');
  }
  if (row.sealed.nonce.length !== 12) throw new TypeError('nonce must be 12 bytes');
}

function sequentialIds(): { ulid(): string } {
  let counter = 0;
  return {
    ulid: () => {
      counter += 1;
      return ulid(1_700_000_000_000 + counter);
    },
  };
}

function setup(cipher: SecretCipher = cipherFor(masterKey(1, 0x00))) {
  const repository = fakeRepository();
  const counted = counting(cipher);
  const store = createCredentialStore({
    repository,
    cipher: counted,
    ids: sequentialIds(),
    clock: fixedClock(NOW),
  });
  return { repository, cipher: counted, store };
}

function input(text: string) {
  return { kind: KIND, projectId: null, plaintext: encoder.encode(text) };
}

async function problemOf(promise: Promise<unknown>): Promise<SecretDecryptProblem | undefined> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SecretDecryptError);
    return (error as SecretDecryptError).problem;
  }
  return undefined;
}

async function seedRow(
  repository: FakeRepository,
  cipher: SecretCipher,
  id: string,
  text: string,
): Promise<CredentialRecord> {
  const aad = credentialAad({ id, orgId: ORG.orgId, kind: KIND });
  const record: CredentialRecord = {
    id,
    projectId: null,
    kind: KIND,
    sealed: await cipher.seal(encoder.encode(text), aad),
    aad,
    rotatedAt: null,
  };
  repository.rows.set(id, record);
  return record;
}

function sealedBytes(sealed: Sealed): string {
  return `${sealed.keyVersion}:${Buffer.from(sealed.nonce).toString('hex')}:${Buffer.from(sealed.ciphertext).toString('hex')}`;
}

describe('credential store', () => {
  it('reads back what put stored, bound to the row aad', async () => {
    const { repository, store } = setup();

    const id = await store.put(ORG, input('s3cret-value'));

    const row = repository.rows.get(id);
    expect(row?.aad).toBe(credentialAad({ id, orgId: ORG.orgId, kind: KIND }));
    expect(row?.projectId).toBeNull();
    expect(decoder.decode(await store.read(ORG, id))).toBe('s3cret-value');
  });

  it('gives each credential a fresh id', async () => {
    const { store } = setup();

    const first = await store.put(ORG, input('one'));
    const second = await store.put(ORG, input('two'));

    expect(first).not.toBe(second);
  });

  it('prepare returns the repository statement and the new id without inserting', async () => {
    const { repository, store } = setup();

    const prepared = await store.prepare(ORG, { ...input('batched'), projectId: 'proj-1' });

    expect(repository.statements).toEqual([prepared.statement]);
    expect(prepared.statement.params).toEqual([prepared.id]);
    expect(repository.rows.size).toBe(0);
  });

  it('prepare seals under the aad of the id it returns', async () => {
    const { repository, cipher, store } = setup();
    let captured: CredentialRecord | undefined;
    const insertStatement = repository.insertStatement;
    repository.insertStatement = (ctx, row) => {
      captured = row;
      return insertStatement(ctx, row);
    };

    const prepared = await store.prepare(ORG, input('batched'));

    expect(captured?.id).toBe(prepared.id);
    const aad = credentialAad({ id: prepared.id, orgId: ORG.orgId, kind: KIND });
    expect(captured?.aad).toBe(aad);
    const opened = await cipher.open((captured as CredentialRecord).sealed, aad);
    expect(decoder.decode(opened)).toBe('batched');
  });

  it('seal returns the row as it would be inserted without touching the repository', async () => {
    const { repository, cipher, store } = setup();
    const calls: string[] = [];
    for (const name of [
      'insertStatement',
      'insert',
      'get',
      'listBelowVersion',
      'reseal',
      'delete',
    ]) {
      const key = name as keyof CredentialRepository;
      (repository as unknown as Record<string, unknown>)[key] = () => {
        calls.push(name);
        throw new Error('repository must not be called');
      };
    }

    const row = await store.seal(ORG, { ...input('own insert'), projectId: 'proj-1' });

    expect(calls).toEqual([]);
    expect(repository.rows.size).toBe(0);
    expect(row.now).toBe(NOW);
    expect(row.kind).toBe(KIND);
    expect(row.projectId).toBe('proj-1');
    expect(row.rotatedAt).toBeNull();
    expect(row.sealed.keyVersion).toBe(cipher.currentVersion);
    const aad = credentialAad({ id: row.id, orgId: ORG.orgId, kind: KIND });
    expect(row.aad).toBe(aad);
    expect(decoder.decode(await cipher.open(row.sealed, aad))).toBe('own insert');
  });

  it('a sealed row inserted through the repository reads back', async () => {
    const { repository, store } = setup();
    const row = await store.seal(ORG, input('round trip'));

    await repository.insert(ORG, row);

    expect(decoder.decode(await store.read(ORG, row.id))).toBe('round trip');
  });

  it('stamps the insert with the clock', async () => {
    const { repository, store } = setup();
    let seen: string | undefined;
    const insert = repository.insert;
    repository.insert = (ctx, row) => {
      seen = row.now;
      return insert(ctx, row);
    };

    await store.put(ORG, input('timed'));

    expect(seen).toBe(NOW);
  });

  it('rejects an unknown id', async () => {
    const { store } = setup();

    await expect(store.read(ORG, '01JNOSUCHCREDENTIAL00000000')).rejects.toBeInstanceOf(
      CredentialNotFoundError,
    );
  });

  it('refuses a row whose aad names another id without opening it', async () => {
    const { repository, cipher, store } = setup();
    const id = await store.put(ORG, input('payload'));
    const row = repository.rows.get(id) as CredentialRecord;
    repository.rows.set(id, {
      ...row,
      aad: credentialAad({ id: '01JOTHERID0000000000000000', orgId: ORG.orgId, kind: KIND }),
    });

    expect(await problemOf(store.read(ORG, id))).toBe('aad_mismatch');
    expect(cipher.opened).toBe(0);
  });

  it('refuses ciphertext moved to another row together with its aad text', async () => {
    const { repository, cipher, store } = setup();
    const original = await store.put(ORG, input('payload'));
    const source = repository.rows.get(original) as CredentialRecord;
    const movedId = '01JMOVEDROW00000000000000';
    repository.rows.set(movedId, { ...source, id: movedId });

    expect(await problemOf(store.read(ORG, movedId))).toBe('aad_mismatch');
    expect(cipher.opened).toBe(0);
    expect(decoder.decode(await store.read(ORG, original))).toBe('payload');
  });

  it('does not find a credential of another organization', async () => {
    const { store } = setup();
    const id = await store.put(ORG, input('payload'));

    await expect(store.read(orgContext('01J00000000000000000000B0B'), id)).rejects.toBeInstanceOf(
      CredentialNotFoundError,
    );
  });

  it('refuses a row of another organization if a repository returns it anyway (defence in depth)', async () => {
    const { repository, cipher, store } = setup();
    const id = await store.put(ORG, input('payload'));
    repository.get = async (_ctx, rowId) => repository.rows.get(rowId) ?? null;

    expect(await problemOf(store.read(orgContext('01J00000000000000000000B0B'), id))).toBe(
      'aad_mismatch',
    );
    expect(cipher.opened).toBe(0);
  });

  it('refuses a stored kind that cannot form an aad', async () => {
    const { repository, cipher, store } = setup();
    const id = '01JBADKIND00000000000000A1';
    repository.rows.set(id, {
      id,
      projectId: null,
      kind: 'GitHub',
      sealed: await cipher.seal(encoder.encode('payload'), 'credential/x/y/z'),
      aad: `credential/${id}/${ORG.orgId}/GitHub`,
      rotatedAt: null,
    });

    expect(await problemOf(store.read(ORG, id))).toBe('aad_mismatch');
    expect(cipher.opened).toBe(0);
  });
});

describe('credential store resealBatch', () => {
  const V1 = masterKey(1, 0x00);
  const V2 = masterKey(2, 0x20);
  const V3 = masterKey(3, 0x40);
  const V4 = masterKey(4, 0x60);
  const ids = [
    '01JROW000000000000000000A1',
    '01JROW000000000000000000A2',
    '01JROW000000000000000000A3',
    '01JROW000000000000000000A4',
    '01JROW000000000000000000A5',
  ];

  it('moves v2 rows to v3, counts v1 rows as lost and pages through all of them', async () => {
    const oldCipher = cipherFor(V2);
    const unloadedCipher = cipherFor(V1);
    const { repository, store } = setup(cipherFor(V3, V2));
    await seedRow(repository, oldCipher, ids[0] as string, 'zero');
    await seedRow(repository, unloadedCipher, ids[1] as string, 'one');
    await seedRow(repository, oldCipher, ids[2] as string, 'two');
    await seedRow(repository, unloadedCipher, ids[3] as string, 'three');
    await seedRow(repository, oldCipher, ids[4] as string, 'four');
    const lostBefore = [1, 3].map((index) =>
      sealedBytes((repository.rows.get(ids[index] as string) as CredentialRecord).sealed),
    );

    const first = await store.resealBatch(ORG, { afterId: null, limit: 2 });
    expect(first).toEqual({ resealed: 1, lost: 1, failed: 0, nextAfterId: ids[1] });
    const second = await store.resealBatch(ORG, { afterId: first.nextAfterId, limit: 2 });
    expect(second).toEqual({ resealed: 1, lost: 1, failed: 0, nextAfterId: ids[3] });
    const third = await store.resealBatch(ORG, { afterId: second.nextAfterId, limit: 2 });
    expect(third).toEqual({ resealed: 1, lost: 0, failed: 0, nextAfterId: null });

    for (const [index, text] of [
      [0, 'zero'],
      [2, 'two'],
      [4, 'four'],
    ] as const) {
      const row = repository.rows.get(ids[index] as string) as CredentialRecord;
      expect(row.sealed.keyVersion).toBe(3);
      expect(row.rotatedAt).toBe(NOW);
      expect(decoder.decode(await store.read(ORG, ids[index] as string))).toBe(text);
    }
    const lostAfter = [1, 3].map((index) =>
      sealedBytes((repository.rows.get(ids[index] as string) as CredentialRecord).sealed),
    );
    expect(lostAfter).toEqual(lostBefore);
    expect(repository.resealCalls.map((call) => call.expectedVersion)).toEqual([2, 2, 2]);
  });

  it('counts a moved ciphertext as lost and leaves the row unchanged', async () => {
    const oldCipher = cipherFor(V2);
    const { repository, cipher, store } = setup(cipherFor(V3, V2));
    const source = await seedRow(repository, oldCipher, ids[0] as string, 'payload');
    const moved: CredentialRecord = { ...source, id: ids[1] as string };
    repository.rows.set(moved.id, moved);

    const result = await store.resealBatch(ORG, { afterId: ids[0] as string, limit: 10 });

    expect(result).toEqual({ resealed: 0, lost: 1, failed: 0, nextAfterId: null });
    expect(cipher.opened).toBe(0);
    expect(repository.rows.get(moved.id)).toEqual(moved);
    expect(repository.resealCalls).toEqual([]);
  });

  it('skips a row whose conditional reseal returns false', async () => {
    const { repository, store } = setup(cipherFor(V3, V2));
    await seedRow(repository, cipherFor(V2), ids[0] as string, 'raced');
    repository.refuseReseal = true;

    const result = await store.resealBatch(ORG, { afterId: null, limit: 5 });

    expect(result).toEqual({ resealed: 0, lost: 0, failed: 0, nextAfterId: null });
    expect(repository.resealCalls).toHaveLength(1);
  });

  it('reports no progress cursor for an empty page', async () => {
    const { store } = setup(cipherFor(V3, V2));

    expect(await store.resealBatch(ORG, { afterId: null, limit: 3 })).toEqual({
      resealed: 0,
      lost: 0,
      failed: 0,
      nextAfterId: null,
    });
  });

  it('returns the last id of a full page', async () => {
    const { repository, store } = setup(cipherFor(V3, V2));
    await seedRow(repository, cipherFor(V2), ids[0] as string, 'a');
    await seedRow(repository, cipherFor(V2), ids[1] as string, 'b');

    const result = await store.resealBatch(ORG, { afterId: null, limit: 2 });

    expect(result).toEqual({ resealed: 2, lost: 0, failed: 0, nextAfterId: ids[1] });
  });

  it('counts a tampered row as failed, leaves it alone and keeps paging', async () => {
    const { repository, cipher, store } = setup(cipherFor(V3, V2));
    const row = await seedRow(repository, cipherFor(V2), ids[0] as string, 'tampered');
    const damaged = new Uint8Array(row.sealed.ciphertext);
    damaged[0] = (damaged[0] as number) ^ 0xff;
    const damagedRow = { ...row, sealed: { ...row.sealed, ciphertext: damaged } };
    repository.rows.set(row.id, damagedRow);
    await seedRow(repository, cipherFor(V2), ids[1] as string, 'valid');

    const first = await store.resealBatch(ORG, { afterId: null, limit: 1 });
    expect(first).toEqual({ resealed: 0, lost: 0, failed: 1, nextAfterId: ids[0] });
    const second = await store.resealBatch(ORG, { afterId: first.nextAfterId, limit: 1 });
    expect(second).toEqual({ resealed: 1, lost: 0, failed: 0, nextAfterId: ids[1] });

    expect(repository.rows.get(ids[0] as string)).toEqual(damagedRow);
    expect(decoder.decode(await store.read(ORG, ids[1] as string))).toBe('valid');
    expect(cipher.opened).toBe(3);
  });

  it('counts a row with a malformed nonce as failed', async () => {
    const { repository, store } = setup(cipherFor(V3, V2));
    const row = await seedRow(repository, cipherFor(V2), ids[0] as string, 'short nonce');
    repository.rows.set(row.id, { ...row, sealed: { ...row.sealed, nonce: new Uint8Array(4) } });

    expect(await store.resealBatch(ORG, { afterId: null, limit: 5 })).toEqual({
      resealed: 0,
      lost: 0,
      failed: 1,
      nextAfterId: null,
    });
  });

  it('counts a row whose kind cannot form an aad as lost', async () => {
    const { repository, store } = setup(cipherFor(V3, V2));
    const id = ids[0] as string;
    const row = await seedRow(repository, cipherFor(V2), id, 'odd kind');
    const odd = { ...row, kind: 'GitHub', aad: `credential/${id}/${ORG.orgId}/GitHub` };
    repository.rows.set(id, odd);

    expect(await store.resealBatch(ORG, { afterId: null, limit: 5 })).toEqual({
      resealed: 0,
      lost: 1,
      failed: 0,
      nextAfterId: null,
    });
    expect(repository.rows.get(id)).toEqual(odd);
  });

  it('zeroes every decrypted plaintext it handled', async () => {
    const { repository, cipher, store } = setup(cipherFor(V3, V2));
    await seedRow(repository, cipherFor(V2), ids[0] as string, 'wipe me');
    repository.refuseReseal = true;

    await store.resealBatch(ORG, { afterId: null, limit: 5 });

    expect(cipher.plaintexts).toHaveLength(1);
    expect(cipher.plaintexts[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it('moves rows from every older loaded version to the current one', async () => {
    const { repository, store } = setup(cipherFor(V4, V3, V2, V1));
    await seedRow(repository, cipherFor(V1), ids[0] as string, 'from v1');
    await seedRow(repository, cipherFor(V2), ids[1] as string, 'from v2');
    await seedRow(repository, cipherFor(V3), ids[2] as string, 'from v3');
    await seedRow(repository, cipherFor(V4), ids[3] as string, 'at v4');

    const result = await store.resealBatch(ORG, { afterId: null, limit: 10 });

    expect(result).toEqual({ resealed: 3, lost: 0, failed: 0, nextAfterId: null });
    for (const [index, text] of [
      [0, 'from v1'],
      [1, 'from v2'],
      [2, 'from v3'],
      [3, 'at v4'],
    ] as const) {
      const id = ids[index] as string;
      expect((repository.rows.get(id) as CredentialRecord).sealed.keyVersion).toBe(4);
      expect(decoder.decode(await store.read(ORG, id))).toBe(text);
    }
    expect(repository.resealCalls.map((call) => call.expectedVersion)).toEqual([1, 2, 3]);
  });

  it('counts a row on a version missing from the ring as lost', async () => {
    const { repository, store } = setup(cipherFor(V4, V2));
    await seedRow(repository, cipherFor(V3), ids[0] as string, 'gap');
    await seedRow(repository, cipherFor(V2), ids[1] as string, 'loaded');
    const gapBefore = sealedBytes(
      (repository.rows.get(ids[0] as string) as CredentialRecord).sealed,
    );

    const result = await store.resealBatch(ORG, { afterId: null, limit: 10 });

    expect(result).toEqual({ resealed: 1, lost: 1, failed: 0, nextAfterId: null });
    expect(sealedBytes((repository.rows.get(ids[0] as string) as CredentialRecord).sealed)).toBe(
      gapBefore,
    );
  });
});
