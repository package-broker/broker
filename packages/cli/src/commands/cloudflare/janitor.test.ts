import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyInventory, installIdentity } from './inventory.js';
import { janitor } from './janitor.js';
import { cleanupInventory } from './teardown.js';

const project = resolve(import.meta.dirname, '../../../../..');
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'secret_SENTINEL' };
const epoch = 1792300000;
const now = () => (epoch + 7 * 3600) * 1000;
let directory: string;
beforeEach(async () => {
  directory = join(project, '.pb/state/cloudflare', `t852-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function fixture(name: string, runIdentity: string | null, updated = epoch * 1000) {
  const journal = emptyInventory(
    installIdentity({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      workerName: name,
      ...(runIdentity === null ? {} : { runIdentity }),
    }),
    updated,
  );
  journal.resources.d1 = {
    name: `${journal.identity.script_name}-db`,
    id: '11111111-1111-4111-8111-111111111111',
    state: 'complete',
    jurisdiction: 'eu',
    evidence: { source: 'created', operation_id: 'create-db', verified_at: journal.updated_at },
  };
  journal.operations.push({
    id: 'create-db',
    kind: 'd1',
    name: journal.resources.d1.name,
    spec_sha256: 'e'.repeat(64),
    absence_observed_at: journal.updated_at,
    started_at: journal.updated_at,
    state: 'confirmed',
    resolved_id: journal.resources.d1.id,
  });
  const inventory = join(directory, `inventory.${randomUUID()}.json`);
  await writeFile(inventory, JSON.stringify(journal));
  return inventory;
}

it('reaps a stale inventory for the exact repository and epoch', async () => {
  const name = `pb-e2e-456-${epoch}`;
  const inventory = await fixture(name, `${name}-run-1-cloudflare`);
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) =>
    Response.json({
      success: true,
      result: new URL(String(input)).pathname.endsWith('/workers/scripts') ? [] : null,
      result_info: { total_pages: 1 },
    }),
  );
  const result = await janitor({ project, inventory, repositoryId: '456', now, env, fetch });
  expect(result.exitCode).toBe(0);
  expect(result.output.command).toBe('janitor');
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls[0]).toBeDefined();
});

it('skips young, refreshed, foreign, production and prefix-only inventories without any API call', async () => {
  const fetch = vi.fn(async () => {
    throw new Error('must not call');
  });
  const name = `pb-e2e-456-${epoch}`;
  for (const inventory of [
    await fixture(`pb-e2e-456-${epoch + 3600}`, `pb-e2e-456-${epoch + 3600}`),
    await fixture(name, name, now() - 3600_000),
    await fixture(`pb-e2e-4564-${epoch}`, `pb-e2e-4564-${epoch}`),
    await fixture(name, null),
    await fixture('pb-e2e-prefix', 'pb-e2e-prefix'),
    await fixture('pb-e2e-prefix', name),
  ]) {
    const result = await janitor({ project, inventory, repositoryId: '456', now, env, fetch });
    expect(result.exitCode).toBe(0);
    expect(result.output.checks).toContainEqual({ name: 'inventory', status: 'skipped' });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('discovers nested inventories, continues after failure, and returns nonzero for leftovers', async () => {
  const name = `pb-e2e-456-${epoch}`;
  const one = await fixture(name, name);
  await fixture(name, name);
  await mkdir(join(directory, 'nested'));
  await rename(one, join(directory, 'nested/inventory.run.json'));
  const fetch = vi.fn(async () => Response.json({ success: false, result: null }, { status: 403 }));
  const result = await janitor({
    project,
    inventoryDirectory: directory,
    repositoryId: '456',
    now,
    env,
    fetch,
  });
  expect(result.exitCode).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain(one);
});

it('refuses malformed inventories and invalid repository selectors, and supports dry run', async () => {
  const name = `pb-e2e-456-${epoch}`;
  const inventory = await fixture(name, name);
  const fetch = vi.fn(async () => {
    throw new Error('must not call');
  });
  expect(
    (await janitor({ project, inventory, repositoryId: '456', now, env, fetch, dryRun: true }))
      .output.status,
  ).toBe('planned');
  expect(
    (await janitor({ project, inventory, repositoryId: '456*', now, env, fetch })).exitCode,
  ).toBe(2);
  await writeFile(inventory, '{');
  expect(
    (await janitor({ project, inventory, repositoryId: '456', now, env, fetch })).exitCode,
  ).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});

it('skips a fresh inventory while its provisioner holds the lock', async () => {
  const name = `pb-e2e-456-${epoch}`;
  const inventory = await fixture(name, name, now());
  const fetch = vi.fn(async () => {
    throw new Error('must not call');
  });
  const options = { project, inventory, repositoryId: '456', now, env, fetch };
  const { store } = await cleanupInventory(options);
  const release = await store.lock(now());
  try {
    expect((await janitor(options)).exitCode).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await release();
  }
});

it('matches a compact Worker name to the exact repository and epoch in the run identity', async () => {
  const repositoryId = '123456789';
  const name = `pb-e2e-${BigInt(repositoryId).toString(36)}-${epoch.toString(36)}`;
  const inventory = await fixture(name, `pb-e2e-${repositoryId}-${epoch}-run-1-cloudflare`);
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) =>
    Response.json({
      success: true,
      result: new URL(String(input)).pathname.endsWith('/workers/scripts') ? [] : null,
      result_info: { total_pages: 1 },
    }),
  );
  const result = await janitor({ project, inventory, repositoryId, now, env, fetch });
  expect(result.exitCode).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  fetch.mockClear();
  expect(
    (await janitor({ project, inventory, repositoryId: '123456788', now, env, fetch })).exitCode,
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it('skips foreign-account inventories and unrelated JSON files during discovery', async () => {
  const name = `pb-e2e-456-${epoch}`;
  const inventory = await fixture(name, name);
  const foreign = JSON.parse(await readFile(inventory, 'utf8'));
  foreign.identity.account_id = 'f'.repeat(32);
  await writeFile(inventory, JSON.stringify(foreign));
  await writeFile(join(directory, 'outputs.json'), '{');
  await writeFile(join(directory, 'lock.worker.json'), '{}');
  const fetch = vi.fn();
  const result = await janitor({
    project,
    inventoryDirectory: directory,
    repositoryId: '456',
    now,
    env,
    fetch,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output.checks).toEqual([{ name: 'inventory', status: 'skipped' }]);
  expect(fetch).not.toHaveBeenCalled();
});

it('retains adopted data without any provider calls', async () => {
  const name = `pb-e2e-456-${epoch}`;
  const inventory = await fixture(name, name);
  const journal = JSON.parse(await readFile(inventory, 'utf8'));
  journal.resources.d1.evidence = {
    source: 'adopted',
    operation_id: null,
    verified_at: journal.updated_at,
  };
  await writeFile(inventory, JSON.stringify(journal));
  const fetch = vi.fn();
  const result = await janitor({ project, inventory, repositoryId: '456', now, env, fetch });
  expect(result.exitCode).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});

it('scans account Worker references once and reuses only foreign reference reads for selected inventories', async () => {
  const name = `pb-e2e-456-${epoch}`;
  await fixture(`${name}-a`, `${name}-a`);
  await fixture(`${name}-b`, `${name}-b`);
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const result = url.pathname.endsWith('/workers/scripts')
      ? [{ id: 'foreign-worker' }]
      : url.pathname.endsWith('/settings')
        ? { bindings: [] }
        : url.pathname.endsWith('/versions')
          ? { items: [{ id: 'foreign-version' }] }
          : url.pathname.endsWith('/versions/foreign-version')
            ? { resources: { bindings: [] } }
            : null;
    return Response.json({ success: true, result, result_info: { total_pages: 1 } });
  });
  const result = await janitor({
    project,
    inventoryDirectory: directory,
    repositoryId: '456',
    now,
    env,
    fetch,
  });
  expect(result.exitCode).toBe(0);
  for (const suffix of [
    '/workers/scripts',
    '/foreign-worker/settings',
    '/foreign-worker/versions',
    '/versions/foreign-version',
  ])
    expect(paths.filter((path) => path.endsWith(suffix))).toHaveLength(1);
  expect(result.output.checks.filter((check) => check.status === 'deleted')).toHaveLength(2);
});

it('removes successfully deleted Workers from the shared scan before the next inventory', async () => {
  const name = `pb-e2e-456-${epoch}`;
  const workers = new Set<string>();
  for (const suffix of ['a', 'b']) {
    const inventory = await fixture(`${name}-${suffix}`, `${name}-${suffix}`);
    const journal = JSON.parse(await readFile(inventory, 'utf8'));
    const script = journal.identity.script_name;
    workers.add(script);
    journal.resources = {
      worker: {
        name: script,
        id: script,
        state: 'complete',
        evidence: { source: 'adopted', operation_id: null, verified_at: journal.updated_at },
      },
    };
    journal.operations = [];
    await writeFile(inventory, JSON.stringify(journal));
  }
  let scans = 0;
  const readWorkers = new Set<string>();
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith('/workers/scripts')) {
      scans++;
      return Response.json({ success: true, result: [...workers].map((id) => ({ id })) });
    }
    const worker = path.match(/\/workers\/scripts\/([^/]+)/)?.[1];
    if (worker) {
      expect(workers.has(worker)).toBe(true);
      if (init?.method === 'DELETE') {
        workers.delete(worker);
        return Response.json({ success: true, result: null });
      }
      readWorkers.add(worker);
    }
    const result = path.endsWith('/settings')
      ? { bindings: [], tags: [] }
      : path.endsWith('/schedules')
        ? { schedules: [] }
        : path.endsWith('/versions')
          ? { items: [] }
          : path.endsWith('/subdomain')
            ? { enabled: false, previews_enabled: false }
            : [];
    return Response.json({ success: true, result, result_info: { total_pages: 1 } });
  });
  const result = await janitor({
    project,
    inventoryDirectory: directory,
    repositoryId: '456',
    now,
    env,
    fetch,
  });
  expect(result.exitCode).toBe(0);
  expect(workers.size).toBe(0);
  expect(scans).toBe(1);
  expect(readWorkers.size).toBe(2);
});
