import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { importManifest } from '../import/client.js';
import { credentialBindings, localResolver, runImport, type ImportOptions } from './import.js';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SECRET = 'sentinel-material-must-not-leak';
const TOKEN = 'sentinel-broker-token-must-not-leak';
const raw = {
  version: 1,
  source_system: 'satis',
  widening: [],
  items: [
    {
      type: 'source',
      external_ref: 'satis:source/test',
      name: 'satis-test',
      ecosystem: 'composer',
      source_type: 'composer_repository',
      project: null,
      url: 'https://repo.test/',
      credential_ref: 'env:SOURCE_AUTH',
      config: {
        selection: { packages: ['acme/lib'], patterns: [], expandPatterns: false },
        distHosts: [],
        mirrorsFallback: false,
      },
    },
  ],
};
const plan = await importManifest(JSON.stringify(raw));
const ready = {
  id: ID,
  state: 'applied',
  planHash: plan.hash,
  approvedAt: '2026-10-24T11:50:00.000Z',
  credentialWindowUntil: '2026-10-24T12:50:00.000Z',
  acceptedAt: null,
};
const map = {
  version: 1,
  repositories: [{ url: 'https://repo.test/', kind: 'bearer', ref: 'env:SOURCE_AUTH' }],
};
let dir: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let options: ImportOptions;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-T839-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(raw));
  await writeFile(join(dir, 'map.json'), JSON.stringify(map));
  options = {
    command: 'submit',
    broker: 'https://broker.test',
    env: { PB_IMPORT_TOKEN: TOKEN, SOURCE_AUTH: JSON.stringify({ token: SECRET }) },
    manifest: join(dir, 'manifest.json'),
    credentials: join(dir, 'map.json'),
    receipt: join(dir, 'receipt.json'),
    principal: 'operator',
    now: () => NOW,
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});
const output = () => JSON.stringify([log.mock.calls, error.mock.calls]);
const json = (value: unknown) => Response.json(value);
const created = () =>
  Response.json({ id: ID, planHash: plan.hash, state: 'planned' }, { status: 201 });

describe('submit receipt', () => {
  it('persists before POST, reuses a lost-response key, then uses GET for known runs', async () => {
    const runs = new Map<string, string>();
    let lose = true;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'GET') return json(ready);
      const saved = JSON.parse(await readFile(options.receipt!, 'utf8')) as {
        key: string;
        run: string | null;
      };
      expect(saved.run).toBeNull();
      expect(new Headers(init!.headers).get('idempotency-key')).toBe(saved.key);
      expect(init!.body).toBe(plan.canonical);
      runs.set(saved.key, ID);
      if (lose) {
        lose = false;
        throw new Error(SECRET);
      }
      return created();
    });
    expect(await runImport({ ...options, fetch: fetcher })).toBe(6);
    expect(await runImport({ ...options, fetch: fetcher, resume: true })).toBe(0);
    expect(
      await runImport({ ...options, fetch: fetcher, resume: true, now: () => NOW + 90000000 }),
    ).toBe(0);
    expect(runs.size).toBe(1);
    expect(fetcher.mock.calls.map((call) => call[1]!.method)).toEqual(['POST', 'POST', 'GET']);
    expect((await stat(options.receipt!)).mode & 0o777).toBe(0o600);
    expect(output()).not.toContain(SECRET);
    expect(output()).not.toContain(TOKEN);
    for (const file of await readdir(dir)) {
      const content = await readFile(join(dir, file), 'utf8');
      expect(content).not.toContain(SECRET);
      expect(content).not.toContain(TOKEN);
    }
  });
  it('requires an explicit resume and refuses changed origin, principal, manifest and expired replay', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(SECRET);
    });
    expect(await runImport({ ...options, fetch: fetcher })).toBe(6);
    fetcher.mockClear();
    expect(await runImport({ ...options, fetch: fetcher })).toBe(2);
    expect(
      await runImport({ ...options, fetch: fetcher, resume: true, broker: 'https://other.test' }),
    ).toBe(2);
    expect(await runImport({ ...options, fetch: fetcher, resume: true, principal: 'other' })).toBe(
      2,
    );
    expect(
      await runImport({ ...options, fetch: fetcher, resume: true, now: () => NOW + 86400000 }),
    ).toBe(6);
    expect(await runImport({ ...options, fetch: fetcher, resume: true, now: () => NOW - 1 })).toBe(
      6,
    );
    await writeFile(options.manifest!, JSON.stringify({ ...raw, source_system: 'different' }));
    expect(await runImport({ ...options, fetch: fetcher, resume: true })).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses no-op plans before creating a receipt or sending', async () => {
    await writeFile(options.manifest!, JSON.stringify({ ...raw, items: [] }));
    const fetcher = vi.fn<typeof fetch>();
    expect(await runImport({ ...options, fetch: fetcher })).toBe(2);
    expect(output()).toContain('No changes to submit.');
    expect(await readdir(dir)).not.toContain('receipt.json');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports a sent outcome if the run receipt cannot be updated after POST', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      await unlink(options.receipt!);
      await mkdir(options.receipt!);
      return created();
    });
    expect(await runImport({ ...options, fetch: fetcher })).toBe(6);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output()).toContain('Run created but receipt could not be saved');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not persist a mismatching server plan hash', async () => {
    expect(
      await runImport({
        ...options,
        fetch: vi.fn(async () =>
          Response.json({ id: ID, planHash: '0'.repeat(64), state: 'planned' }, { status: 201 }),
        ),
      }),
    ).toBe(6);
    expect(JSON.parse(await readFile(options.receipt!, 'utf8'))).toMatchObject({ run: null });
  });
});

describe('credentials and token input', () => {
  it('uses env JSON material without writing or displaying it, even on a server refusal', async () => {
    const files = await readdir(dir);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      if (init!.method === 'GET') return json(ready);
      expect(JSON.parse(init!.body as string)).toEqual({
        kind: 'bearer',
        material: JSON.stringify({ token: SECRET }),
      });
      return Response.json(
        {
          error: { code: 'conflict', message: SECRET, details: [{ secret: SECRET }] },
          token: TOKEN,
        },
        { status: 409 },
      );
    });
    expect(await runImport({ ...options, command: 'credentials', run: ID, fetch: fetcher })).toBe(
      1,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output()).toContain('conflict: Conflict');
    expect(output()).not.toContain(SECRET);
    expect(output()).not.toContain(TOKEN);
    expect(await readdir(dir)).toEqual(files);
    for (const file of files) expect(await readFile(join(dir, file), 'utf8')).not.toContain(SECRET);
  });
  it('fails closed on the current server DTO without resolving secrets', async () => {
    const currentDto = { ...ready, credentialWindowUntil: undefined };
    const resolve = vi.fn(async () => SECRET);
    expect(
      await runImport({
        ...options,
        command: 'credentials',
        run: ID,
        fetch: vi.fn(async () => json(currentDto)),
        resolve,
      }),
    ).toBe(2);
    expect(resolve).not.toHaveBeenCalled();
    expect(output()).toContain('credential_window_unavailable');
  });
  it('supports existing file references without copying their contents', async () => {
    const path = join(dir, 'auth-input');
    const material = JSON.stringify({ token: SECRET });
    await writeFile(path, material);
    expect(await localResolver({})(`file:${path}`)).toBe(material);
    expect(await localResolver({})(`file:${relative(process.cwd(), path)}`)).toBe(material);
    expect(await readdir(dir)).toEqual(
      expect.arrayContaining(['auth-input', 'manifest.json', 'map.json']),
    );
    expect(output()).not.toContain(SECRET);
  });
  it.each(['op://vault/item', 'env:MISSING', 'file:', 'env:lowercase'])(
    'refuses unsupported/missing reference %s safely',
    async (reference) => {
      await expect(localResolver({})(reference)).rejects.toBeInstanceOf(Error);
    },
  );
  it('reads a token file and refuses ambiguous auth before any HTTP request', async () => {
    const tokenFile = join(dir, 'token-input');
    await writeFile(tokenFile, `${TOKEN}\n`);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      return json(ready);
    });
    expect(
      await runImport({
        ...options,
        command: 'status',
        run: ID,
        tokenFile,
        env: {},
        fetch: fetcher,
      }),
    ).toBe(0);
    fetcher.mockClear();
    expect(
      await runImport({ ...options, command: 'status', run: ID, tokenFile, fetch: fetcher }),
    ).toBe(2);
    expect(
      await runImport({ ...options, command: 'status', run: ID, env: {}, fetch: fetcher }),
    ).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output()).not.toContain(TOKEN);
  });
  it('accepts strict generic bindings and refuses missing kinds or mismatching Satis refs', () => {
    expect(
      credentialBindings(
        JSON.stringify({
          version: 1,
          sources: [
            {
              external_ref: 'satis:source/test',
              credential_ref: 'env:SOURCE_AUTH',
              kind: 'bearer',
            },
          ],
        }),
        plan.manifest,
      ),
    ).toHaveLength(1);
    expect(() =>
      credentialBindings(
        JSON.stringify({
          version: 1,
          sources: [{ external_ref: 'satis:source/test', credential_ref: 'env:SOURCE_AUTH' }],
        }),
        plan.manifest,
      ),
    ).toThrow();
    expect(() =>
      credentialBindings(
        JSON.stringify({
          version: 1,
          repositories: [{ ...map.repositories[0], ref: 'env:OTHER' }],
        }),
        plan.manifest,
      ),
    ).toThrow();
  });
});

describe('status, verify, accept and CLI dispatch', () => {
  it.each([
    'planned',
    'applying',
    'applied',
    'verifying',
    'verified',
    'failed',
    'cancelled',
    'rolled_back',
  ])('maps status %s', async (state) => {
    expect(
      await runImport({
        ...options,
        command: 'status',
        run: ID,
        fetch: vi.fn(async () => json({ ...ready, state })),
      }),
    ).toBe(['failed', 'cancelled', 'rolled_back'].includes(state) ? 1 : 0);
    expect(output()).toContain(state);
  });
  it('bounds polling and reports pending until apply finishes', async () => {
    const fetcher = vi.fn(async () => json({ ...ready, state: 'planned' }));
    const sleep = vi.fn(async () => undefined);
    expect(
      await runImport({
        ...options,
        command: 'status',
        run: ID,
        waitSeconds: 2,
        fetch: fetcher,
        sleep,
      }),
    ).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
  it('honors Retry-After within the wait budget and stops on a larger delay', async () => {
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async () =>
      reads++ === 0
        ? Response.json(
            { error: { code: 'unavailable', message: SECRET } },
            { status: 429, headers: { 'retry-after': '2' } },
          )
        : json(ready),
    );
    const sleep = vi.fn(async () => undefined);
    expect(
      await runImport({
        ...options,
        command: 'status',
        run: ID,
        waitSeconds: 5,
        fetch: fetcher,
        sleep,
      }),
    ).toBe(0);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
    const blocked = vi.fn(async () =>
      Response.json({}, { status: 429, headers: { 'retry-after': '999999' } }),
    );
    expect(
      await runImport({
        ...options,
        command: 'status',
        run: ID,
        waitSeconds: 5,
        fetch: blocked,
        sleep,
      }),
    ).toBe(3);
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(output()).not.toContain(SECRET);
  });

  it('verifies through POST then observes the state transition', async () => {
    const states = ['verifying', 'verified'];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      init!.method === 'POST'
        ? new Response(null, { status: 204 })
        : json({ ...ready, state: states.shift() }),
    );
    expect(
      await runImport({
        ...options,
        command: 'verify',
        run: ID,
        waitSeconds: 2,
        fetch: fetcher,
        sleep: async () => undefined,
      }),
    ).toBe(0);
    expect(String(fetcher.mock.calls[0]![0]).endsWith(`/${ID}/verify`)).toBe(true);
    expect(fetcher.mock.calls.map((call) => call[1]!.method)).toEqual(['POST', 'GET', 'GET']);
  });
  it('accept hands off to the UI and never posts, then succeeds only for acceptedAt', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ ...ready, state: 'verified' }));
    expect(await runImport({ ...options, command: 'accept', run: ID, fetch: fetcher })).toBe(3);
    expect(output()).toContain('Accept run');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
    expect(
      await runImport({
        ...options,
        command: 'accept',
        run: ID,
        fetch: vi.fn(async () =>
          json({ ...ready, state: 'verified', acceptedAt: '2026-10-24T12:00:00.000Z' }),
        ),
      }),
    ).toBe(0);
  });
  it('dispatches submit flags and bounded wait through the CLI', async () => {
    vi.stubEnv('PB_IMPORT_TOKEN', TOKEN);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'POST' ? created() : json(ready),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      await run([
        'import',
        'submit',
        '--manifest',
        options.manifest!,
        '--receipt',
        options.receipt!,
        '--principal',
        'operator',
        '--broker',
        options.broker,
      ]),
    ).toBe(0);
    expect(JSON.parse(await readFile(options.receipt!, 'utf8'))).toMatchObject({ run: ID });
    expect(await run(['import', 'status', ID, '--broker', options.broker, '--wait'])).toBe(0);
    expect(
      await run([
        'import',
        'status',
        ID,
        '--broker',
        options.broker,
        '--wait',
        '--wait-seconds',
        '1',
      ]),
    ).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dispatches run positionals and rejects approve, token flag values and extra arguments', async () => {
    vi.stubEnv('PB_IMPORT_TOKEN', TOKEN);
    const fetcher = vi.fn(async () => json(ready));
    vi.stubGlobal('fetch', fetcher);
    expect(await run(['import', 'status', ID, '--broker', options.broker])).toBe(0);
    expect(await run(['import', 'approve', ID, '--broker', options.broker])).toBe(2);
    expect(await run(['import', 'status', ID, '--broker', options.broker, '--token', TOKEN])).toBe(
      2,
    );
    expect(await run(['import', 'status', ID, 'extra', '--broker', options.broker])).toBe(2);
    expect(
      await run(['import', 'status', ID, '--broker', options.broker, '--wait-seconds', '301']),
    ).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output()).not.toContain(TOKEN);
  });
});
