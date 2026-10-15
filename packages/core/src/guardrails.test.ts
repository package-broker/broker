import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const ruleId = 'no-restricted-syntax';
const message = 'Raw SQL belongs in a db-sqlite repository (ADR-002)';
const eslint = new ESLint({ cwd: repoRoot });

async function sqlErrors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((entry) => entry.ruleId === ruleId)
    .map((entry) => entry.message);
}

describe('raw SQL lint rule', () => {
  it('flags SQL in a string literal outside the database layer', async () => {
    const errors = await sqlErrors(
      "export const q = 'SELECT * FROM organization';",
      'packages/core/src/x.ts',
    );
    expect(errors).toEqual([message]);
  });

  it('flags SQL in a template literal outside the database layer', async () => {
    const errors = await sqlErrors('export const q = `insert into t`;', 'packages/core/src/x.ts');
    expect(errors).toEqual([message]);
  });

  it('allows SQL in db-sqlite repositories', async () => {
    const errors = await sqlErrors(
      "export const q = 'SELECT * FROM organization';",
      'packages/db-sqlite/src/repositories/x.ts',
    );
    expect(errors).toEqual([]);
  });

  it('allows SQL in runtime db adapters', async () => {
    const errors = await sqlErrors(
      "export const q = 'SELECT * FROM organization';",
      'packages/runtime-node/src/db/x.ts',
    );
    expect(errors).toEqual([]);
  });

  it('allows SQL in test files', async () => {
    const errors = await sqlErrors(
      "export const q = 'SELECT * FROM organization';",
      'packages/core/src/x.test.ts',
    );
    expect(errors).toEqual([]);
  });

  it('flags prose that starts with a SQL keyword', async () => {
    const errors = await sqlErrors("export const q = 'select a book';", 'packages/core/src/x.ts');
    expect(errors).toEqual([message]);
  });
});
