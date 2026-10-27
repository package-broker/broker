import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '@package-broker/core/auth/module';
import * as sso from '@package-broker/core/auth/routes-sso';
import { resolveTokenLifetimePolicy } from '@package-broker/core/authz/token-lifetime';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAccessServices } from './access-services.js';

const ANCHOR = 'oidc:https://idp.example.test';

describe('assembled provider binding reader', () => {
  let database: MigratedDatabase;

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await database.close();
  });

  function assemble(executor: SqlExecutor = database.executor) {
    const module = vi.spyOn(auth, 'createAuthModule');
    const routes = vi.spyOn(sso, 'createSsoRoutes');
    createAccessServices({
      executor,
      keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]),
      providers: new Map(),
      clock: systemClock,
      ids: { ulid },
      log: () => undefined,
      dispatch: () => undefined,
      publicOrigin: 'https://broker.example.test',
      clientIp: () => null,
      registration: collectRegistrations([]),
      tokens: { lifetime: resolveTokenLifetimePolicy(undefined), offboarding: {} },
    });
    expect(module).toHaveBeenCalledOnce();
    const reader = module.mock.calls[0]![0].repositories.bindings;
    expect(routes).toHaveBeenCalledOnce();
    expect(routes.mock.calls[0]![0].bindings).toBe(reader);
    return reader;
  }

  async function bind() {
    await database.executor.batch([
      {
        sql: 'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        params: [database.orgs!.a.orgId, 'oidc', ANCHOR],
      },
    ]);
  }

  it('returns null when the organization and provider have no binding', async () => {
    expect(await assemble().anchor(database.orgs!.a, 'oidc')).toBeNull();
  });

  it('returns the stored anchor through the reader supplied to the module and SSO routes', async () => {
    await bind();
    const reader = assemble();
    expect(await reader.anchor(database.orgs!.a, 'oidc')).toBe(ANCHOR);
    expect(await reader.anchor(database.orgs!.a, 'other')).toBeNull();
  });

  it('isolates the same provider in another organization', async () => {
    await bind();
    const reader = assemble();
    expect(await reader.anchor(database.orgs!.b, 'oidc')).toBeNull();
    await database.executor.batch([
      {
        sql: 'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        params: [database.orgs!.b.orgId, 'oidc', 'oidc:https://other.example.test'],
      },
    ]);
    expect(await reader.anchor(database.orgs!.b, 'oidc')).toBe('oidc:https://other.example.test');
    expect(await reader.anchor(database.orgs!.a, 'oidc')).toBe(ANCHOR);
  });

  it('rejects with the executor error instead of treating a failed read as unbound', async () => {
    const failure = new Error('binding read failed');
    const reader = assemble({
      driver: database.executor.driver,
      all: () => Promise.reject(failure),
      batch: (statements) => database.executor.batch(statements),
    });
    await expect(reader.anchor(database.orgs!.a, 'oidc')).rejects.toBe(failure);
  });
});
