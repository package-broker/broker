import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { hostname } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  InventoryStore,
  abortOnlyRule,
  emptyInventory,
  installIdentity,
  inventoryTransportPolicy,
  lifecycleRule,
  validateInventory,
} from './inventory.js';

let project: string;
const identity = installIdentity({ accountId: 'a'.repeat(32), workerName: 'broker' });
const stores = (outDir = '.pb/cloudflare', inventory?: string) =>
  InventoryStore.create({
    project,
    outDir,
    identity,
    ...(inventory === undefined ? {} : { inventory }),
  });
beforeEach(async () => {
  await mkdir('.pb', { recursive: true });
  project = await mkdtemp(resolve('.pb/inventory-test-'));
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});
it('writes atomic private state outside build output and survives cleaning the build', async () => {
  const store = await stores();
  const inventory = emptyInventory(identity, Date.now());
  await store.write(inventory);
  expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  expect(await store.read()).toEqual(inventory);
  await mkdir(join(project, '.pb/cloudflare'), { recursive: true });
  await rm(join(project, '.pb/cloudflare'), { recursive: true });
  expect(await store.read()).toEqual(inventory);
});
it('refuses overlap, containment escape, symlinks, aliases and nonregular state', async () => {
  for (const out of ['.', '.pb', '.pb/state', '.pb/state/cloudflare', '.pb/state/cloudflare/out'])
    await expect(stores(out)).rejects.toMatchObject({ code: 'unsafe_path' });
  await expect(stores('.pb/cloudflare', '../inventory.foreign.json')).rejects.toMatchObject({
    code: 'unsafe_path',
  });
  const store = await stores();
  await mkdir(store.directory, { recursive: true });
  await symlink(store.directory, join(project, 'alias'));
  await expect(stores('alias')).rejects.toMatchObject({ code: 'unsafe_path' });
  await symlink(join(project, 'missing'), store.path);
  await expect(stores()).rejects.toMatchObject({ code: 'unsafe_path' });
  await rm(store.path);
  await mkdir(store.path);
  await expect(stores()).rejects.toMatchObject({ code: 'unsafe_path' });
});
it('rejects symlinked state directories and unignored state', async () => {
  await mkdir(join(project, '.pb'), { recursive: true });
  await symlink(project, join(project, '.pb/state'));
  await expect(stores()).rejects.toMatchObject({ code: 'unsafe_path' });
  // A project outside any Git repository cannot establish ignored state.
  await expect(
    InventoryStore.create({ project: '/', outDir: '/out', identity }),
  ).rejects.toMatchObject({ code: 'unsafe_path' });
});
it('does not change existing bytes or modes on read, and validates identity and schema', async () => {
  const store = await stores();
  const inventory = emptyInventory(identity, Date.now());
  await store.write(inventory);
  const before = await readFile(store.path);
  const info = await stat(store.path);
  await store.read();
  expect(await readFile(store.path)).toEqual(before);
  expect((await stat(store.path)).mtimeMs).toBe(info.mtimeMs);
  expect(() => validateInventory({ ...inventory, schema_version: 1 }, identity)).toThrow();
  for (const key of [
    'account_id',
    'deployment_id',
    'owner_digest',
    'jurisdiction',
    'run_identity',
  ]) {
    expect(() =>
      validateInventory({ ...inventory, identity: { ...identity, [key]: 'foreign' } }, identity),
    ).toThrow();
  }
  expect(() =>
    validateInventory({ ...inventory, operations: [{ id: 'bad' }] }, identity),
  ).toThrow();
  await writeFile(store.path, '{truncated');
  await expect(store.read()).rejects.toMatchObject({ code: 'invalid_inventory' });
});
it('keeps a live or unverifiable lock and releases only its own lock', async () => {
  const store = await stores();
  const release = await store.lock(Date.now());
  expect((await stat(store.lockPath)).mode & 0o777).toBe(0o600);
  const bytes = await readFile(store.lockPath);
  await expect(store.lock(Date.now())).rejects.toMatchObject({ exitCode: 4 });
  expect(await readFile(store.lockPath)).toEqual(bytes);
  await release();
  await expect(stat(store.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(
    store.lockPath,
    JSON.stringify({ pid: 123, host: 'foreign-host', started_at: new Date().toISOString() }),
  );
  await expect(store.lock(Date.now())).rejects.toMatchObject({ exitCode: 4 });
});
it('keeps raw inventories private on success and failure, and rejects ambiguous install identities', () => {
  expect(inventoryTransportPolicy('private')).toEqual({
    raw_inventory: true,
    retention_days: 30,
    scope: 'exact_inventory_only',
  });
  expect(inventoryTransportPolicy('public').raw_inventory).toBe(false);
  expect(inventoryTransportPolicy('unknown').raw_inventory).toBe(false);
  const other = installIdentity({
    accountId: identity.account_id,
    workerName: 'broker-pro',
    environment: 'duction',
  });
  expect(other.owner_digest).not.toBe(identity.owner_digest);
  for (const workerName of ['X', '-a', 'a-', 'a'.repeat(25), 'a/b'])
    expect(() => installIdentity({ accountId: identity.account_id, workerName })).toThrow();
});

it('refuses concurrent automatic recovery of a dead owner and preserves the lock', async () => {
  const first = await stores();
  const second = await stores();
  await mkdir(first.directory, { recursive: true });
  const bytes = JSON.stringify({
    pid: 2147483647,
    host: hostname(),
    started_at: new Date(0).toISOString(),
    nonce: 'dead-owner',
  });
  await writeFile(first.lockPath, bytes, { mode: 0o600 });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  });
  try {
    const results = await Promise.allSettled([first.lock(Date.now()), second.lock(Date.now())]);
    // Release any unexpected acquisition before asserting, so a failure leaves no writer behind.
    for (const result of results) if (result.status === 'fulfilled') await result.value();
    expect(results).toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'install_locked', exitCode: 4 }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({ code: 'install_locked', exitCode: 4 }),
      },
    ]);
    expect(await readFile(first.lockPath, 'utf8')).toBe(bytes);
  } finally {
    kill.mockRestore();
  }
});

it.each(['d1', 'r2'] as const)(
  'requires known matching jurisdiction on completed %s receipts',
  (key) => {
    const inventory = emptyInventory(identity, Date.now());
    const resource = {
      name: `broker-production-${key === 'd1' ? 'db' : 'blobs'}`,
      id: key === 'd1' ? '11111111-1111-4111-8111-111111111111' : 'broker-production-blobs',
      state: 'complete' as const,
      evidence: {
        source: 'adopted' as const,
        operation_id: null,
        verified_at: new Date().toISOString(),
      },
    };
    for (const jurisdiction of [null, undefined, 'default'] as const) {
      inventory.resources[key] = {
        ...resource,
        ...(jurisdiction === undefined ? {} : { jurisdiction }),
      };
      expect(() => validateInventory(inventory, identity)).toThrow(
        'Inventory identity or journal is invalid',
      );
    }
    inventory.resources[key] = { ...resource, jurisdiction: 'eu' };
    expect(validateInventory(inventory, identity)).toBe(inventory);
  },
);

it('keeps a custom nested journal contained and uses the same install lock', async () => {
  const standard = await stores();
  const custom = await stores('.pb/cloudflare', '.pb/state/cloudflare/private/custom.json');
  await custom.write(emptyInventory(identity, Date.now()));
  expect(custom.lockPath).toBe(standard.lockPath);
  expect((await stat(custom.stateRoot)).mode & 0o777).toBe(0o700);
  const release = await custom.lock(Date.now());
  await expect(standard.lock(Date.now())).rejects.toMatchObject({ exitCode: 4 });
  await release();
});

it.each([[], '', 1, true, null].map((resources) => [resources]))(
  'rejects non-object resource maps: %j',
  (resources) => {
    const inventory = { ...emptyInventory(identity, Date.now()), resources };
    expect(() => validateInventory(inventory, identity)).toThrow(
      'Inventory identity or journal is invalid',
    );
  },
);

it('refuses JSON-only ignore rules that expose atomic temporary inventory files', async () => {
  await promisify(execFile)('git', ['init', '--quiet', project]);
  await writeFile(join(project, '.gitignore'), '.pb/state/cloudflare/*.json\n');
  await expect(stores()).rejects.toMatchObject({ code: 'unsafe_path' });
  await expect(stat(join(project, '.pb/state/cloudflare'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await writeFile(join(project, '.gitignore'), '.pb/state/cloudflare/\n');
  const store = await stores();
  await store.write(emptyInventory(identity, Date.now()));
  expect(await store.read()).not.toBeNull();
});

const DEFAULT_RULE = {
  id: 'Default Multipart Abort Rule',
  enabled: true,
  conditions: { prefix: '' },
  abortMultipartUploadsTransition: { condition: { type: 'Age' as const, maxAge: 604800 } },
};

it('accepts the live empty conditions and normalizes them to an empty prefix', () => {
  const live = { ...DEFAULT_RULE, conditions: {} };
  expect(lifecycleRule(live)).toBe(true);
  expect(abortOnlyRule(live)).toEqual(DEFAULT_RULE);
  expect(abortOnlyRule(DEFAULT_RULE)).toEqual(DEFAULT_RULE);
  for (const conditions of [{ prefix: '', suffix: '' }, { suffix: '' }, { prefix: 1 }, null, []])
    expect(lifecycleRule({ ...DEFAULT_RULE, conditions })).toBe(false);
});

it('accepts only normalized lifecycle baselines in a stored inventory', () => {
  const withBaseline = (rule: unknown) => {
    const inventory = emptyInventory(identity, Date.parse('2026-10-27T12:00:00Z'));
    inventory.operations.push({
      id: 'create-r2',
      kind: 'r2',
      name: `${identity.script_name}-blobs`,
      spec_sha256: 'e'.repeat(64),
      absence_observed_at: inventory.updated_at,
      started_at: inventory.updated_at,
      state: 'confirmed',
      resolved_id: `${identity.script_name}-blobs`,
    });
    inventory.resources.r2 = {
      name: `${identity.script_name}-blobs`,
      id: `${identity.script_name}-blobs`,
      jurisdiction: 'eu',
      state: 'complete',
      evidence: { source: 'created', operation_id: 'create-r2', verified_at: inventory.updated_at },
      lifecycle_baseline: [rule as never],
    };
    return inventory;
  };
  const normalized = withBaseline(DEFAULT_RULE);
  expect(validateInventory(normalized, identity)).toBe(normalized);
  expect(() =>
    validateInventory(withBaseline({ ...DEFAULT_RULE, conditions: {} }), identity),
  ).toThrow(expect.objectContaining({ code: 'invalid_inventory' }));
});
