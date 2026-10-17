import { afterEach, describe, expect, it, vi } from 'vitest';
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
