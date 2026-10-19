import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const ruleId = 'no-restricted-syntax';
const message = 'Raw SQL belongs in a db-sqlite repository (ADR-002)';
const eslint = new ESLint({ cwd: repoRoot });

async function syntaxErrors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((entry) => entry.ruleId === ruleId)
    .map((entry) => entry.message);
}

describe('raw SQL lint rule', () => {
  it('flags SQL in a string literal outside the database layer', async () => {
    const errors = await syntaxErrors(
      "export const q = 'SELECT * FROM organization';",
      'packages/core/src/x.ts',
    );
    expect(errors).toEqual([message]);
  });

  it('flags SQL in a template literal outside the database layer', async () => {
    const errors = await syntaxErrors(
      'export const q = `insert into t`;',
      'packages/core/src/x.ts',
    );
    expect(errors).toEqual([message]);
  });

  it('allows SQL in db-sqlite repositories', async () => {
    const errors = await syntaxErrors(
      "export const q = 'SELECT * FROM organization';",
      'packages/db-sqlite/src/repositories/x.ts',
    );
    expect(errors).toEqual([]);
  });

  it('allows SQL in runtime db adapters', async () => {
    const errors = await syntaxErrors(
      "export const q = 'SELECT * FROM organization';",
      'packages/runtime-node/src/db/x.ts',
    );
    expect(errors).toEqual([]);
  });

  it('allows SQL in test files', async () => {
    const errors = await syntaxErrors(
      "export const q = 'SELECT * FROM organization';",
      'packages/core/src/x.test.ts',
    );
    expect(errors).toEqual([]);
  });

  it('flags prose that starts with a SQL keyword', async () => {
    const errors = await syntaxErrors(
      "export const q = 'select a book';",
      'packages/core/src/x.ts',
    );
    expect(errors).toEqual([message]);
  });
});

describe('response error message lint rule', () => {
  const safeMessage = 'Response errors must use fixed client-safe messages, never an error message';

  it.each([
    "errorEnvelope('x', err.message, id)",
    "envelopeResponse(500, 'internal', err.message, id)",
    'Response.json({ m: e.message })',
    'jsonResponse({ m: err.message })',
    'new Response(err.stack)',
    'Response.json({ nested: { stack: err["stack"] } })',
    'jsonResponse({ stack: err.stack })',
    'new Response(err.message)',
    'c.json({ error: err.message })',
    'c.text(err.message)',
    'Response.json({ nested: { m: e["message"] } })',
  ])('flags %s in every package, including database adapters', async (code) => {
    for (const filePath of [
      'packages/core/src/x.ts',
      'packages/db-sqlite/src/x.ts',
      'packages/runtime-node/src/db/x.ts',
      'packages/ui/src/x.ts',
    ]) {
      expect(await syntaxErrors(code, filePath)).toEqual([safeMessage]);
    }
  });

  it.each([
    "errorEnvelope('internal', 'Internal error', id)",
    "Response.json({ error: 'Internal error' })",
    'log(err.message)',
    'log(err.stack)',
    "jsonResponse({ error: 'Internal error' })",
  ])('allows fixed strings and reads outside response arguments: %s', async (code) => {
    expect(await syntaxErrors(code, 'packages/core/src/x.ts')).toEqual([]);
  });

  it('excludes test fixtures', async () => {
    for (const filePath of [
      'packages/core/src/x.test.ts',
      'packages/db-sqlite/src/x.test.ts',
      'packages/ui/src/x.test.ts',
    ]) {
      expect(await syntaxErrors('Response.json({ m: e.message })', filePath)).toEqual([]);
    }
  });
});
