import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importRoutes } from '@package-broker/core/api/routes/import';
import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineTokenAccess,
} from '@package-broker/core/authz/engine';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { importWriteTokenFence } from '@package-broker/core/kernel/import-token-fence';
import { formatToken } from '@package-broker/core/secrets/token-format';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { systemClock, ulid } from '@package-broker/core/ids';
import { createImportCredentialService } from '@package-broker/core/import/credentials';
import { createImportRunService } from '@package-broker/core/import/run-service';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { auditPendingStatement } from '@package-broker/db-sqlite/repositories/audit-pending';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import { createImportCredentialRepository } from '@package-broker/db-sqlite/repositories/import-credential';
import { createImportRunStore } from '@package-broker/db-sqlite/repositories/import-run';
import {
  openMigratedDatabase,
  type MigratedDatabase,
} from '@package-broker/db-sqlite/testing/migrated-database';
import { run } from '../cli.js';
import { ImportClient, importManifest, type CredentialResolver } from '../import/client.js';
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
  credentials: [{ sourceRef: 'satis:source/test', bound: false }],
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
  it('binds an unresolved receipt to its token before replaying with the same principal label', async () => {
    const otherToken = 'different-principal-token-sentinel';
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(SECRET);
    });
    expect(await runImport({ ...options, fetch: fetcher })).toBe(6);
    const saved = await readFile(options.receipt!, 'utf8');
    fetcher.mockClear();
    expect(
      await runImport({
        ...options,
        resume: true,
        env: { PB_IMPORT_TOKEN: otherToken },
        fetch: fetcher,
      }),
    ).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readFile(options.receipt!, 'utf8')).toBe(saved);
    expect(JSON.parse(saved)).toMatchObject({ tokenFingerprint: await sha256Hex(TOKEN) });
    expect(saved).not.toContain(TOKEN);
    expect(saved).not.toContain(otherToken);
    expect(output()).not.toContain(TOKEN);
    expect(output()).not.toContain(otherToken);
    expect(await runImport({ ...options, resume: true, fetch: fetcher })).toBe(6);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses replay of an unresolved legacy receipt without a token fingerprint', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(SECRET);
    });
    expect(await runImport({ ...options, fetch: fetcher })).toBe(6);
    const saved = JSON.parse(await readFile(options.receipt!, 'utf8')) as Record<string, unknown>;
    delete saved.tokenFingerprint;
    await writeFile(options.receipt!, JSON.stringify(saved));
    fetcher.mockClear();
    expect(await runImport({ ...options, resume: true, fetch: fetcher })).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([false, true])('reads known receipts with rotated tokens, legacy=%s', async (legacy) => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'GET' ? json(ready) : created(),
    );
    expect(await runImport({ ...options, fetch: fetcher })).toBe(0);
    if (legacy) {
      const saved = JSON.parse(await readFile(options.receipt!, 'utf8')) as Record<string, unknown>;
      delete saved.tokenFingerprint;
      await writeFile(options.receipt!, JSON.stringify(saved));
    }
    fetcher.mockClear();
    expect(
      await runImport({
        ...options,
        resume: true,
        env: { PB_IMPORT_TOKEN: 'rotated-token' },
        fetch: fetcher,
      }),
    ).toBe(0);
    expect(fetcher.mock.calls.map((call) => call[1]!.method)).toEqual(['GET']);
  });
  it.each(['failed', 'cancelled', 'rolled_back'])(
    'returns failure for a known receipt run in state %s',
    async (state) => {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
        init?.method === 'GET' ? json({ ...ready, state }) : created(),
      );
      expect(await runImport({ ...options, fetch: fetcher })).toBe(0);
      fetcher.mockClear();
      expect(await runImport({ ...options, resume: true, fetch: fetcher })).toBe(1);
      expect(fetcher.mock.calls.map((call) => call[1]!.method)).toEqual(['GET']);
      expect(output()).toContain(`${ID}: ${state};`);
    },
  );
  it.each(['failed', 'cancelled', 'rolled_back'])(
    'returns failure after unresolved submit replay finds state %s',
    async (state) => {
      const fetcher = vi.fn<typeof fetch>(async () => {
        throw new Error(SECRET);
      });
      expect(await runImport({ ...options, fetch: fetcher })).toBe(6);
      fetcher.mockClear();
      fetcher.mockImplementation(async (_url, init) =>
        init?.method === 'GET'
          ? json({ ...ready, state })
          : Response.json(
              { id: ID, planHash: plan.hash, state: 'planned' },
              { status: 201, headers: { 'idempotent-replayed': 'true' } },
            ),
      );
      expect(await runImport({ ...options, resume: true, fetch: fetcher })).toBe(1);
      expect(fetcher.mock.calls.map((call) => call[1]!.method)).toEqual(['POST', 'GET']);
      expect(output()).toContain(`${ID}: ${state};`);
      expect(JSON.parse(await readFile(options.receipt!, 'utf8'))).toMatchObject({ run: ID });
    },
  );
  it('stops unknown submit replay at the one-hour guard margin', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(SECRET);
    });
    expect(await runImport({ ...options, fetch: fetcher })).toBe(6);
    fetcher.mockClear();
    expect(
      await runImport({
        ...options,
        fetch: fetcher,
        resume: true,
        now: () => NOW + 23 * 3600000 - 1,
      }),
    ).toBe(6);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    expect(
      await runImport({ ...options, fetch: fetcher, resume: true, now: () => NOW + 23 * 3600000 }),
    ).toBe(6);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reads and prints the live state after a replayed submit', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'GET'
        ? json({ ...ready, state: 'verified' })
        : Response.json(
            { id: ID, planHash: plan.hash, state: 'planned' },
            { status: 201, headers: { 'idempotent-replayed': 'true' } },
          ),
    );
    expect(await runImport({ ...options, fetch: fetcher })).toBe(0);
    expect(fetcher.mock.calls.map((call) => call[1]!.method)).toEqual(['POST', 'GET']);
    expect(output()).toContain(`${ID}: verified;`);
    expect(output()).not.toContain(`${ID}: planned`);
  });
  it('refuses resolving the broker token as source material', async () => {
    await expect(localResolver(options.env)('env:PB_IMPORT_TOKEN')).rejects.toMatchObject({
      code: 'invalid_credential_ref',
      exitCode: 2,
    });
    expect(output()).not.toContain(TOKEN);
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
  it('refuses a closed window with a clear message without resolving secrets', async () => {
    const resolve = vi.fn(async () => SECRET);
    expect(
      await runImport({
        ...options,
        command: 'credentials',
        run: ID,
        fetch: vi.fn(async () => json({ ...ready, credentialWindowUntil: null })),
        resolve,
      }),
    ).toBe(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(output()).toContain('credential_window_closed');
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
  it.each([null, '', 'rate limit: ' + SECRET])(
    'waits on a non-JSON 429 body %s using Retry-After',
    async (body) => {
      let time = NOW;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(body, { status: 429, headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce(json(ready));
      const sleep = vi.fn(async (ms: number) => {
        time += ms;
      });
      expect(
        await runImport({
          ...options,
          command: 'status',
          run: ID,
          waitSeconds: 5,
          fetch: fetcher,
          now: () => time,
          sleep,
        }),
      ).toBe(0);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(output()).not.toContain(SECRET);
    },
  );
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

  it('retries the first verify status read after Retry-After without repeating POST', async () => {
    let time = NOW;
    let reads = 0;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init!.method === 'POST') return new Response(null, { status: 204 });
      if (reads++ === 0) return Response.json({}, { status: 429, headers: { 'retry-after': '2' } });
      return json({ ...ready, state: 'verified' });
    });
    const sleep = vi.fn(async (ms: number) => {
      time += ms;
    });
    expect(
      await runImport({
        ...options,
        command: 'verify',
        run: ID,
        waitSeconds: 5,
        now: () => time,
        fetch: fetcher,
        sleep,
      }),
    ).toBe(0);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
    expect(fetcher.mock.calls.map((call) => call[1]!.method)).toEqual(['POST', 'GET', 'GET']);
  });
  it.each(['status', 'verify', 'accept', 'verify-post'] as const)(
    'caps a stalled %s request to the remaining wait budget',
    async (command) => {
      vi.useFakeTimers();
      try {
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), ms);
          return controller.signal;
        });
        let time = NOW;
        const signals: AbortSignal[] = [];
        const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
          const signal = init!.signal!;
          signals.push(signal);
          if (init!.method === 'POST' && command !== 'verify-post') {
            time += 1200;
            return new Response(null, { status: 204 });
          }
          return new Promise<Response>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          );
        });
        const pending = runImport({
          ...options,
          command: command === 'verify-post' ? 'verify' : command,
          run: ID,
          waitSeconds: 2,
          now: () => time,
          fetch: fetcher,
        });
        await vi.advanceTimersByTimeAsync(0);
        const remaining = command === 'verify' ? 800 : 2000;
        await vi.advanceTimersByTimeAsync(remaining - 1);
        expect(signals.at(-1)!.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toBe(3);
        expect(signals.at(-1)!.aborted).toBe(true);
        expect(timeout).toHaveBeenLastCalledWith(remaining);
        timeout.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('does not start another read when sleeping exhausts the deadline', async () => {
    let time = NOW;
    const fetcher = vi.fn(async () => json({ ...ready, state: 'planned' }));
    expect(
      await runImport({
        ...options,
        command: 'status',
        run: ID,
        waitSeconds: 1,
        now: () => time,
        fetch: fetcher,
        sleep: async (ms) => {
          time += ms;
        },
      }),
    ).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(1);
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

describe('against the real import routes on SQLite', () => {
  const ORIGIN = 'https://broker.test';
  const SESSION_SECRET = 'A'.repeat(43);
  const CSRF = 'B'.repeat(43);
  const anchors = [
    {
      provider: 'oidc',
      anchor: 'oidc:https://idp.example.test',
      emailAuthoritative: true,
      emailAuthoritativeDomains: ['example.test'],
    },
  ];
  const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
  const source = (ref: string) => ({
    ...raw.items[0]!,
    external_ref: ref,
    name: ref,
    url: `https://${ref}.example.test/`,
    credential_ref: `env:${ref.toUpperCase()}_AUTH`,
  });
  const twoSources = { ...raw, source_system: 'test', items: [source('alpha'), source('beta')] };
  const secretOf = (ref: string) => `${SECRET}-${ref}`;
  type Hook = (method: string, path: string) => 'before' | 'after' | undefined;

  let database: MigratedDatabase;
  let executor: SqlExecutor;
  let ctx: OrgContext;
  let app: { fetch(request: Request): Promise<Response> };
  let hook: Hook;
  let sent: string[];
  let bearerMode: boolean;
  let tokenAllowed: boolean;
  const bearer = formatToken('svc', 'abcdefghijkl', new Uint8Array(32).fill(6));
  const tokenKeyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(9) }]);
  const tokenFence = vi.fn(importWriteTokenFence);

  const session = (method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          origin: ORIGIN,
          cookie: `${SESSION_COOKIE}=${SESSION_SECRET}`,
          'x-csrf-token': CSRF,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  // The routes under test run unchanged; only the bearer token is swapped for the harness session.
  const broker: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init!.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${bearerMode ? bearer : TOKEN}`);
    if (!bearerMode) {
      headers.delete('authorization');
      headers.set('origin', ORIGIN);
      headers.set('cookie', `${SESSION_COOKIE}=${SESSION_SECRET}`);
      headers.set('x-csrf-token', CSRF);
    } else {
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('x-csrf-token')).toBe(false);
    }
    const method = init!.method ?? 'GET';
    const step = hook(method, url.pathname);
    if (step === 'before') throw new Error(SECRET);
    sent.push(`${method} ${url.pathname}`);
    const response = await app.fetch(
      new Request(url, {
        method,
        headers,
        ...(init!.body === undefined ? {} : { body: init!.body as string }),
      }),
    );
    if (step === 'after') throw new Error(SECRET);
    return response;
  };
  const runRows = () =>
    executor.all<{ id: string }>(stmt('SELECT id FROM import_run WHERE org_id = ?', ctx.orgId));
  const statusOf = async (id: string) =>
    (await (await session('GET', `/_pb/import-runs/${id}`)).json()) as {
      state: string;
      credentialWindowUntil: string | null;
      credentials: { sourceRef: string; bound: boolean }[];
    };
  const submitted = async () => {
    expect(await runImport({ ...options, now: Date.now, fetch: broker })).toBe(0);
    return (JSON.parse(await readFile(options.receipt!, 'utf8')) as { run: string }).run;
  };
  const approve = async (id: string) => {
    const { planHash } = (await (await session('GET', `/_pb/import-runs/${id}`)).json()) as {
      planHash: string;
    };
    expect((await session('POST', `/_pb/import-runs/${id}/approve`, { planHash })).status).toBe(
      204,
    );
  };
  const apply = async (id: string) => {
    await executor.batch([
      ...['alpha', 'beta'].flatMap((ref) => [
        stmt(
          "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, 'composer', 'composer_repository')",
          `source-${ref}`,
          ctx.orgId,
          ref,
        ),
        stmt(
          "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action) VALUES (?, ?, ?, 'source', ?, ?, 'create')",
          `ref-${ref}`,
          ctx.orgId,
          id,
          `source-${ref}`,
          ref,
        ),
      ]),
      stmt("UPDATE import_run SET state = 'applied' WHERE org_id = ? AND id = ?", ctx.orgId, id),
    ]);
  };
  const credentials = (resolve: CredentialResolver, id: string) =>
    runImport({
      ...options,
      now: Date.now,
      command: 'credentials',
      run: id,
      fetch: broker,
      resolve,
    });
  const expectNoLeak = async () => {
    expect(output()).not.toContain(SECRET);
    expect(output()).not.toContain(TOKEN);
    for (const file of await readdir(dir))
      expect(await readFile(join(dir, file), 'utf8')).not.toContain(SECRET);
  };

  beforeEach(async () => {
    hook = () => undefined;
    sent = [];
    bearerMode = false;
    tokenAllowed = true;
    tokenFence.mockClear();
    database = await openMigratedDatabase({ twoOrganizations: true });
    executor = database.executor;
    if (database.orgs === null) throw new Error('missing organizations');
    ctx = database.orgs.a;
    await executor.batch([
      stmt(
        "INSERT INTO user_account (id, org_id, email) VALUES ('actor', ?, 'actor@example.test')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'actor', 'oidc', 'subject', 'actor@example.test', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO role (id, org_id, key, name, scope) VALUES ('importer', ?, 'importer', 'Importer', 'organization')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:write')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:approve')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', 'actor@example.test', 'organization', 'importer')",
        ctx.orgId,
      ),
      stmt(
        `INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, last_seen_at, reauth_at)
        VALUES ('session', ?, 'actor', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        ctx.orgId,
        'a'.repeat(64),
        'b'.repeat(64),
      ),
    ]);
    const objects = new Map<string, Uint8Array>();
    const blobs = createBlobStore(
      {
        async putStaged() {
          throw new Error('not_implemented');
        },
        async openStaged() {
          throw new Error('not_implemented');
        },
        async promote() {
          throw new Error('not_implemented');
        },
        async discardStaged() {
          throw new Error('not_implemented');
        },
        async listStaged() {
          throw new Error('not_implemented');
        },
        async putVerified(key, body, input) {
          objects.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
          return { size: input.size, mediaType: input.mediaType };
        },
        async get(key) {
          const bytes = objects.get(key);
          return bytes === undefined
            ? null
            : {
                size: bytes.length,
                mediaType: 'application/json',
                range: null,
                body: new Response(bytes).body!,
              };
        },
        async head(key) {
          const bytes = objects.get(key);
          return bytes === undefined ? null : { size: bytes.length, mediaType: 'application/json' };
        },
        async remove(key) {
          objects.delete(key);
        },
      },
      createBlobRepository(executor),
      { admission: createBlobUploadAdmission() },
    );
    const routes = importRoutes({
      service: createImportRunService({
        store: createImportRunStore({ executor, blobs, providerAnchors: anchors }),
        ids: { ulid },
        clock: systemClock,
      }),
      credentials: createImportCredentialService({
        store: createImportCredentialRepository(executor, { blobs, providerAnchors: anchors }),
        credentials: createCredentialStore({
          repository: createCredentialRepository(executor),
          cipher: createSecretCipher(
            createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
            'credential-encryption',
          ),
          ids: { ulid },
          clock: systemClock,
        }),
        runtime: 'node',
        ids: { ulid },
        auditStatement: auditPendingStatement,
      }),
      clock: systemClock,
      ids: { ulid },
      clientIp: () => null,
      auditStatement: auditPendingStatement,
      tokenFence,
    });
    const csrfHash = await sha256Hex(CSRF);
    app = await createKernel({
      platform: 'node',
      plugins: [],
      coreRoutes: routes,
      ports: { organizations: { get: async () => null }, clock: systemClock, ids: { ulid } },
      resolveOrg: async () => ctx,
      health: async () => true,
      log: () => undefined,
      authorization: createAuthorizationEngine({
        access: {
          lookupSession: async () => ({
            session: { id: 'session', csrfHash },
            user: { id: 'actor' },
            identity: null,
            protectedHolder: false,
            project: null,
            organizationPermissions: ['org:import:write', 'org:import:approve'],
            projectPermissions: [],
          }),
          lookupToken: async (_org, input) =>
            input.selector !== 'abcdefghijkl'
              ? null
              : (Object.defineProperty(
                  {
                    token: {
                      id: 'import-token',
                      kind: 'svc',
                      expired: false,
                      revoked: false,
                      lastUsedAt: null,
                      userId: null,
                      servicePrincipalId: 'import-service',
                      bindingOk: true,
                      projectMode: 'all',
                      scope: { level: 'full', readOnly: false },
                    },
                    principalStatus: 'active',
                    projectVisible: true,
                    project: null,
                    validation: { kind: null, identityId: null, fresh: true, evidenceAt: null },
                    organizationPermissions: tokenAllowed ? ['org:import:write'] : [],
                    projectPermissions: [],
                  },
                  'verifier',
                  {
                    value: {
                      secretHash: await hashToken(tokenKeyring, 1, bearer),
                      pepperVersion: 1,
                    },
                  },
                ) as unknown as EngineTokenAccess),
          touchSession: async () => true,
          touchToken: async () => true,
        },
        tokenUse: {
          keyring: tokenKeyring,
          nowMs: () => Date.now(),
          dispatch: (task) => {
            void task();
          },
          log: () => undefined,
        },
        patValidation: patValidationGate,
        publicOrigin: ORIGIN,
        providerAnchors: async () => [],
      }),
    });
    await writeFile(options.manifest!, JSON.stringify(twoSources));
    await writeFile(
      options.credentials!,
      JSON.stringify({
        version: 1,
        sources: ['alpha', 'beta'].map((ref) => ({
          external_ref: ref,
          credential_ref: `env:${ref.toUpperCase()}_AUTH`,
          kind: 'bearer',
        })),
      }),
    );
    options = {
      ...options,
      env: {
        PB_IMPORT_TOKEN: TOKEN,
        ALPHA_AUTH: JSON.stringify({ token: secretOf('alpha') }),
        BETA_AUTH: JSON.stringify({ token: secretOf('beta') }),
      },
    };
  });
  afterEach(async () => {
    await database.close();
  });

  it('uses bearer authority and token fences for create, verify and PUT, with GET permission checks and principal-scoped replay', async () => {
    bearerMode = true;
    options = { ...options, env: { ...options.env, PB_IMPORT_TOKEN: bearer } };
    await executor.batch([
      stmt(
        "INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES ('import-service', ?, 'Importer', 'actor')",
        ctx.orgId,
      ),
      stmt(
        "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, 'import-service', 'org:import:write')",
        ctx.orgId,
      ),
      stmt(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, service_principal_id, expires_at, project_mode)
        VALUES ('import-token', ?, 'svc', 'abcdefghijkl', ?, 1, 'Importer', '["full"]', 'import-service', strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'), 'all')`,
        ctx.orgId,
        await hashToken(tokenKeyring, 1, bearer),
      ),
    ]);
    const client = new ImportClient({ broker: ORIGIN, token: bearer, fetch: broker });
    const plan = await importManifest(JSON.stringify(twoSources));
    const result = await client.submit(plan.canonical, 'bearer-key');
    expect(result.replayed).toBe(false);
    expect(await client.status(result.id)).toMatchObject({ state: 'planned' });
    expect(await client.submit(plan.canonical, 'bearer-key')).toMatchObject({
      id: result.id,
      replayed: true,
    });
    expect(
      await executor.all(
        stmt(
          'SELECT principal_key FROM api_idempotency WHERE org_id = ? AND key = ?',
          ctx.orgId,
          'bearer-key',
        ),
      ),
    ).toEqual([{ principal_key: 'service:import-service' }]);
    await approve(result.id);
    await apply(result.id);
    expect(await credentials(localResolver(options.env), result.id)).toBe(0);
    await client.verify(result.id);
    expect(await client.status(result.id)).toMatchObject({ state: 'verifying' });
    expect(await Promise.all(tokenFence.mock.results.map((entry) => entry.value))).toEqual(
      Array.from({ length: 5 }, () =>
        expect.objectContaining({
          tokenId: 'import-token',
          tokenKind: 'svc',
          principalId: 'import-service',
          permission: 'org:import:write',
        }),
      ),
    );
    tokenAllowed = false;
    for (const [method, path, body] of [
      ['POST', '', plan.canonical],
      ['GET', `/${result.id}`, undefined],
      ['POST', `/${result.id}/verify`, undefined],
      [
        'PUT',
        `/${result.id}/credentials/alpha`,
        JSON.stringify({ kind: 'bearer', material: JSON.stringify({ token: SECRET }) }),
      ],
    ] as const) {
      const response = await broker(`${ORIGIN}/_pb/import-runs${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status).toBe(403);
    }
    expect(output()).not.toContain(bearer);
    await expectNoLeak();
  });
  it('resumes a submit whose response was lost into the same run', async () => {
    hook = (method) => (method === 'POST' ? 'after' : undefined);
    expect(await runImport({ ...options, now: Date.now, fetch: broker })).toBe(6);
    const [created] = await runRows();
    expect(created).toBeDefined();
    hook = () => undefined;
    expect(await runImport({ ...options, now: Date.now, fetch: broker, resume: true })).toBe(0);
    expect(await runRows()).toEqual([created]);
    expect(JSON.parse(await readFile(options.receipt!, 'utf8'))).toMatchObject({
      run: created!.id,
    });
    expect(output()).toContain(`${created!.id}: planned;`);
    expect(sent).toEqual([
      'POST /_pb/import-runs',
      'POST /_pb/import-runs',
      `GET /_pb/import-runs/${created!.id}`,
    ]);
    await expectNoLeak();
  });

  it('reports a reused key with a different manifest as an idempotency mismatch', async () => {
    const client = new ImportClient({ broker: ORIGIN, token: TOKEN, fetch: broker });
    const first = await importManifest(JSON.stringify(twoSources));
    const second = await importManifest(
      JSON.stringify({ ...twoSources, items: [source('alpha')] }),
    );
    expect(await client.submit(first.canonical, 'reused-key')).toMatchObject({ replayed: false });
    await expect(client.submit(second.canonical, 'reused-key')).rejects.toMatchObject({
      code: 'idempotency_mismatch',
      exitCode: 1,
    });
    expect(await runRows()).toHaveLength(1);
  });

  it('waits for approval and apply, then refuses once the window has closed', async () => {
    const id = await submitted();
    const resolve = vi.fn(localResolver(options.env));
    expect(await credentials(resolve, id)).toBe(3);
    expect(output()).toContain('opens when the run is approved');
    await approve(id);
    expect(await credentials(resolve, id)).toBe(3);
    expect(output()).toContain('Wait for apply to finish');
    await apply(id);
    await executor.batch([
      stmt(
        "UPDATE import_run SET credential_window_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE org_id = ? AND id = ?",
        ctx.orgId,
        id,
      ),
    ]);
    expect(await credentials(resolve, id)).toBe(1);
    expect(output()).toContain('credential_window_closed');
    expect(resolve).not.toHaveBeenCalled();
    expect(sent.filter((line) => line.startsWith('PUT'))).toEqual([]);
    expect((await statusOf(id)).credentials.every((entry) => !entry.bound)).toBe(true);
  });

  it('completes a partial upload on rerun, uploading only the unbound source', async () => {
    const id = await submitted();
    await approve(id);
    await apply(id);
    expect(
      await runImport({ ...options, now: Date.now, command: 'status', run: id, fetch: broker }),
    ).toBe(0);
    expect(output()).toMatch(/applied; .*credentials=0\/2 bound, upload until /);
    hook = (method, path) => (method === 'PUT' && path.endsWith('/beta') ? 'before' : undefined);
    const resolve = vi.fn(localResolver(options.env));
    expect(await credentials(resolve, id)).toBe(6);
    expect((await statusOf(id)).credentials).toEqual([
      { sourceRef: 'alpha', bound: true },
      { sourceRef: 'beta', bound: false },
    ]);
    hook = () => undefined;
    resolve.mockClear();
    sent = [];
    expect(await credentials(resolve, id)).toBe(0);
    expect(resolve.mock.calls).toEqual([['env:BETA_AUTH']]);
    expect(sent.filter((line) => line.startsWith('PUT'))).toEqual([
      `PUT /_pb/import-runs/${id}/credentials/beta`,
    ]);
    expect(output()).toContain('Uploaded credentials for 1 source entries; 1 already bound.');
    expect((await statusOf(id)).credentials).toEqual([
      { sourceRef: 'alpha', bound: true },
      { sourceRef: 'beta', bound: true },
    ]);
    await expectNoLeak();
  });

  it('treats an upload whose response was lost as bound on rerun', async () => {
    const id = await submitted();
    await approve(id);
    await apply(id);
    hook = (method, path) => (method === 'PUT' && path.endsWith('/beta') ? 'after' : undefined);
    const resolve = vi.fn(localResolver(options.env));
    expect(await credentials(resolve, id)).toBe(6);
    hook = () => undefined;
    resolve.mockClear();
    sent = [];
    expect(await credentials(resolve, id)).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(sent).toEqual([`GET /_pb/import-runs/${id}`]);
    expect(output()).toContain('Uploaded credentials for 0 source entries; 2 already bound.');
    await expectNoLeak();
  });
});
