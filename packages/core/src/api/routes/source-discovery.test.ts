import { expect, it, vi } from 'vitest';
import { createKernel } from '../../kernel/kernel.js';
import { createAuthorizationEngine, patValidationGate } from '../../authz/engine.js';
import { SESSION_COOKIE } from '../../auth/cookies.js';
import { sha256Hex } from '../../auth/primitives.js';
import { orgContext } from '../../db/port.js';
import { fixedClock, ulid } from '../../ids.js';
import { createKeyring } from '../../secrets/keyring.js';
import { sourceDiscoveryRoutes } from './source-discovery.js';

const origin = 'https://broker.test';
const csrf = 'B'.repeat(43);
const clock = fixedClock('2026-11-01T00:00:00.000Z');
const credentialId = '01JA0000000000000000000001';
async function harness(platform: 'node' | 'cloudflare', permissions = ['org:sources:write']) {
  const dryRun = vi.fn().mockResolvedValue({ ok: true, value: { entries: [], nextCursor: '2' } });
  const apply = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      created: 0,
      existing: 0,
      skipped: 1,
      failed: 0,
      results: [{ repository: 'acme/fork', outcome: 'skipped', reason: 'fork' }],
      remainingRepositories: ['acme/next'],
      nextCursor: '2',
    },
  });
  const app = await createKernel({
    platform,
    plugins: [],
    coreRoutes: sourceDiscoveryRoutes({
      discovery: { dryRun, apply },
      ids: { ulid },
      clock,
      clientIp: () => null,
    }),
    ports: { organizations: { get: async () => null }, ids: { ulid }, clock },
    resolveOrg: async () => orgContext('org'),
    health: async () => true,
    log: () => {},
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async () => ({
          session: { id: 'session', csrfHash: await sha256Hex(csrf) },
          user: { id: 'user' },
          identity: null,
          protectedHolder: false,
          project: null,
          organizationPermissions: permissions,
          projectPermissions: [],
        }),
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
        nowMs: () => clock.now().getTime(),
        dispatch: (run) => {
          void run();
        },
        log: () => {},
      },
      patValidation: patValidationGate,
      publicOrigin: origin,
      providerAnchors: async () => [],
    }),
  });
  const request = (path: string, body: unknown) =>
    app.fetch(
      new Request(origin + path, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}`,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify(body),
      }),
    );
  return { request, dryRun, apply };
}

it.each(['node', 'cloudflare'] as const)(
  'mounts organization discovery with validated inputs and continuation on %s',
  async (platform) => {
    const h = await harness(platform);
    const response = await h.request('/_pb/sources/discovery/plan', {
      credentialId,
      installationId: 42,
      pattern: '*',
      cursor: null,
      includeForks: true,
      ecosystem: 'npm',
    });
    expect(response.status).toBe(200);
    expect(h.dryRun).toHaveBeenCalledWith(
      orgContext('org'),
      expect.objectContaining({ userId: 'user' }),
      expect.objectContaining({ includeForks: true, ecosystem: 'npm' }),
    );
    const applied = await h.request('/_pb/sources/discovery/apply', {
      credentialId,
      installationId: 42,
      repositories: ['acme/fork'],
      nextCursor: '2',
    });
    expect(applied.status).toBe(200);
    expect(JSON.stringify(await applied.json())).toContain('remainingRepositories');
  },
);

it('denies discovery before invoking a service without source write permission', async () => {
  const h = await harness('node', ['org:sources:read']);
  expect(
    (
      await h.request('/_pb/sources/discovery/plan', {
        credentialId,
        installationId: 42,
        pattern: '*',
        cursor: null,
      })
    ).status,
  ).toBe(403);
  expect(h.dryRun).not.toHaveBeenCalled();
});

it('rejects oversized repository pages before invoking discovery', async () => {
  const h = await harness('node');
  expect(
    (
      await h.request('/_pb/sources/discovery/apply', {
        credentialId,
        installationId: 42,
        repositories: Array(21).fill('acme/repo'),
      })
    ).status,
  ).toBe(400);
  expect(h.apply).not.toHaveBeenCalled();
});
