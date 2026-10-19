import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import type { KernelOptions } from '@package-broker/core/kernel/kernel';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';

const captured = vi.hoisted(() => ({ options: [] as KernelOptions[] }));
vi.mock('@package-broker/core/kernel/kernel', async (original) => {
  const actual = await original<typeof import('@package-broker/core/kernel/kernel')>();
  return {
    ...actual,
    createKernel: (options: KernelOptions) => {
      captured.options.push(options);
      return actual.createKernel(options);
    },
  };
});
vi.mock('@package-broker/core/kernel/org', async (original) => {
  const actual = await original<typeof import('@package-broker/core/kernel/org')>();
  return { ...actual, createOrgResolver: () => async () => orgContext('org-ui') };
});

const document = '<!doctype html><title>Package Broker</title>';
const manifest = {
  version: 1,
  entry: 'index.html',
  files: { 'index.html': { contentType: 'text/html', bytes: document.length } },
};
const engine: AuthorizationEngine = {
  authorize: vi.fn(async ({ request }) =>
    request.headers.get('cookie') === 'test-session=valid'
      ? {
          allow: true as const,
          principal: { kind: 'user' as const, id: 'user-ui' },
          projectId: null,
        }
      : { allow: false as const, status: 401 as const },
  ),
};

import { createWorker, type Env } from './index.js';

function keyringOnlyD1(): NonNullable<Env['DB']> {
  const verifier = new Map<number, string>();
  type Recorded = {
    sql: string;
    values: unknown[];
    bind: (...next: unknown[]) => Recorded;
    all: () => Promise<unknown>;
  };
  const run = (sql: string, values: unknown[]) => {
    const insert = /^\s*insert into keyring_verifier .*X'([0-9a-f]{64})'/is.exec(sql);
    if (insert !== null) {
      const version = values[0] as number;
      if (verifier.has(version)) return { results: [], meta: { changes: 0 } };
      verifier.set(version, (insert[1] as string).toUpperCase());
      return { results: [], meta: { changes: 1 } };
    }
    if (/from "keyring_verifier"/i.test(sql)) {
      return {
        results: [...verifier]
          .sort(([left], [right]) => right - left)
          .map(([key_version, mac_hex]) => ({ key_version, mac_hex })),
      };
    }
    if (/from local_login/i.test(sql)) return { results: [] };
    throw new Error('unexpected SQL');
  };
  const make = (sql: string, values: unknown[]): Recorded => ({
    sql,
    values,
    bind: (...next) => make(sql, next),
    all: () => Promise.resolve(run(sql, values)),
  });
  return {
    prepare: (sql: string) => make(sql, []),
    batch: (statements: Recorded[]) =>
      Promise.resolve(statements.map((statement) => run(statement.sql, statement.values))),
  } as unknown as NonNullable<Env['DB']>;
}

describe('Worker UI mount', () => {
  it('adds only UI routes and requires the engine authenticated boundary', async () => {
    const worker = createWorker([], { authorization: engine, log: () => undefined });
    const authEnv: Env = {
      DB: keyringOnlyD1(),
      PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      PB_PUBLIC_URL: 'https://broker.test',
    };
    await worker.services(authEnv);
    const baseline = [...(captured.options.at(-1)?.coreRoutes ?? [])];
    const env = {
      ...authEnv,
      ASSETS: {
        fetch: async (input: Request | string) =>
          new URL(typeof input === 'string' ? input : input.url).pathname === '/manifest.json'
            ? Response.json(manifest)
            : new Response(document),
      },
    };
    await worker.services(env);
    const fetchUi = (request: Request) => worker.fetch(request, env);
    try {
      for (const path of [
        '/_pb/ui/',
        '/_pb/ui',
        '/_pb/ui/manifest.json',
        '/_pb/ui/assets/index.html',
      ]) {
        const anonymous = await fetchUi(new Request(`https://broker.test${path}`));
        expect(anonymous.status, `anonymous ${path}`).toBe(401);
      }
      for (const [path, expected] of [
        ['/_pb/ui/', document],
        ['/_pb/ui', document],
        ['/_pb/ui/manifest.json', JSON.stringify(manifest)],
      ]) {
        const response = await fetchUi(
          new Request(`https://broker.test${path}`, {
            headers: { cookie: 'test-session=valid' },
          }),
        );
        expect(response.status, path).toBe(200);
        expect(await response.text()).toBe(expected);
      }
      expect(
        (
          await fetchUi(
            new Request('https://broker.test/_pb/projects', {
              headers: { cookie: 'test-session=valid' },
            }),
          )
        ).status,
      ).toBe(404);
      const routes = captured.options.at(-1)?.coreRoutes ?? [];

      expect(
        routes
          .filter(
            (route) =>
              !baseline.some(
                (previous) => previous.method === route.method && previous.path === route.path,
              ),
          )
          .map((route) => ({
            method: route.method,
            path: route.path,
            boundary: route.boundary,
            needsOrg: route.needsOrg,
          })),
      ).toEqual([
        { method: 'GET', path: '/_pb/ui', boundary: 'authenticated', needsOrg: true },
        { method: 'GET', path: '/_pb/ui/assets/:file', boundary: 'authenticated', needsOrg: true },
        { method: 'GET', path: '/_pb/ui/manifest.json', boundary: 'authenticated', needsOrg: true },
      ]);
      expect(baseline.some((route) => route.path === '/_pb/session')).toBe(true);
      const otherDocument = document.replace('Broker', 'Server');
      const otherEnv = {
        ...authEnv,
        ASSETS: {
          fetch: async (input: Request | string) =>
            new URL(typeof input === 'string' ? input : input.url).pathname === '/manifest.json'
              ? Response.json(manifest)
              : new Response(otherDocument),
        },
      };
      const other = await worker.fetch(
        new Request('https://broker.test/_pb/ui/', {
          headers: { cookie: 'test-session=valid' },
        }),
        otherEnv,
      );
      expect(other.status).toBe(200);
      expect(await other.text()).toBe(otherDocument);
    } finally {
      vi.clearAllMocks();
    }
  });
});
