import type { EngineTokenAccess } from '@package-broker/core/authz/engine';
import type { TokenAccess, createAccessRepository } from '../repositories/access.js';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as grants from '../repositories/grant.js';
import type { SqlExecutor } from '@package-broker/core/db/port';
import * as scope from '@package-broker/core/authz/scope';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { tokenContractCases } from './token-contract.js';

afterEach(() => vi.restoreAllMocks());

describe('token lookup scope mutation', () => {
  it('catches removal of the project cap intersection', async () => {
    const effective = scope.tokenEffectivePermissions;
    vi.spyOn(scope, 'tokenEffectivePermissions').mockImplementation((input) =>
      effective(input.boundary === 'project' ? { ...input, tokenMaxScope: 'full' } : input),
    );
    await expect(tokenContractCases.projectCap(() => openMigratedDatabase())).rejects.toThrow(
      /to deeply equal/,
    );
  });
});

describe('token lookup SQL mutation', () => {
  it('catches a null project_token_max_scope selected by lookupToken', async () => {
    let mutations = 0;
    await expect(
      tokenContractCases.projectCap(
        () => openMigratedDatabase(),
        (executor): SqlExecutor => ({
          driver: executor.driver,
          batch: executor.batch.bind(executor),
          all: (statement) => {
            if (statement.sql.includes('"p"."token_max_scope" as "project_token_max_scope"')) {
              mutations += 1;
            }
            return executor.all({
              ...statement,
              sql: statement.sql.replace(
                '"p"."token_max_scope" as "project_token_max_scope"',
                'null as "project_token_max_scope"',
              ),
            });
          },
        }),
      ),
    ).rejects.toThrow(/to deeply equal/);
    expect(mutations).toBeGreaterThan(0);
  });
});

describe('creator removal mutation', () => {
  it('catches a membership removal that also revokes the creator token', async () => {
    const create = grants.createGrantRepository;
    vi.spyOn(grants, 'createGrantRepository').mockImplementation((executor, options) => {
      const repository = create(executor, options);
      return {
        ...repository,
        async deleteOrganization(...args) {
          const result = await repository.deleteOrganization(...args);
          if (typeof result === 'object' && result.outcome === 'deleted') {
            await executor.batch([
              {
                sql: 'UPDATE token SET revoked_at = ? WHERE org_id = ?',
                params: [new Date().toISOString(), args[0].orgId],
              },
            ]);
          }
          return result;
        },
      };
    });
    await expect(tokenContractCases.creatorRemoved(() => openMigratedDatabase())).rejects.toThrow(
      /to deeply equal/,
    );
  });
});

describe('token lookup negative contract coverage', () => {
  it.each([
    'revoked',
    'expired',
    'crossOrg',
    'wrongSelector',
    'projectBinding',
    'projectGrantDeleted',
  ])('runs the shared %s case', async (name) => {
    expect(tokenContractCases).toHaveProperty(name);
    const run = Reflect.get(tokenContractCases, name) as typeof tokenContractCases.nullSlug;
    await run(() => openMigratedDatabase());
  });
});

describe('token access engine contract', () => {
  it('assigns the SQLite token view and lookup result to EngineTokenAccess without casts', () => {
    expectTypeOf<TokenAccess>().toExtend<EngineTokenAccess>();
    expectTypeOf<ReturnType<ReturnType<typeof createAccessRepository>['lookupToken']>>().toExtend<
      Promise<EngineTokenAccess | null>
    >();
  });
});
