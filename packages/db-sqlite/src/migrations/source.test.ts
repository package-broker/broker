import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { loadMigrationSource, MigrationSourceError, sha256Hex } from './source.js';
import { splitStatements } from './split.js';

const initUrl = new URL('../../migrations/0001_init.sql', import.meta.url);
const initText = readFileSync(initUrl, 'utf8');

const rejects = (owner: string, file: string, text: string) =>
  expect(loadMigrationSource(owner, file, text)).rejects.toBeInstanceOf(MigrationSourceError);

test('loads the real initial migration', async () => {
  const source = await loadMigrationSource('core', '0001_init.sql', initText);
  const lf = initText.replace(/\r\n/g, '\n');

  expect(source).toMatchObject({
    id: 'core:0001_init',
    owner: 'core',
    name: '0001_init',
    sequence: 1,
    phase: 'expand',
  });
  expect(source.sql).toBe(lf);
  expect(source.checksum).toBe(createHash('sha256').update(lf, 'utf8').digest('hex'));
});

test('the initial migration splits into tables, indexes and one insert', () => {
  const statements = splitStatements(initText);
  const count = (pattern: RegExp) => statements.filter((s) => pattern.test(s)).length;
  const indexes = (initText.match(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/gim) ?? []).length;

  expect(count(/^CREATE\s+TABLE\b/i)).toBe(55);
  expect(count(/^CREATE\s+(UNIQUE\s+)?INDEX\b/i)).toBe(indexes);
  expect(count(/^INSERT\b/i)).toBe(1);
});

test('sha256Hex is lowercase hex over UTF-8', async () => {
  expect(await sha256Hex('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  expect(await sha256Hex('zażółć')).toBe(
    createHash('sha256').update('zażółć', 'utf8').digest('hex'),
  );
});

test('CRLF and LF give one checksum, a changed text another', async () => {
  const lf = await loadMigrationSource('core', '0002_a.sql', 'CREATE TABLE a (id TEXT);\n');
  const crlf = await loadMigrationSource('core', '0002_a.sql', 'CREATE TABLE a (id TEXT);\r\n');
  const spaced = await loadMigrationSource('core', '0002_a.sql', 'CREATE TABLE a (id TEXT); \n');

  expect(crlf.checksum).toBe(lf.checksum);
  expect(crlf.sql).toBe(lf.sql);
  expect(spaced.checksum).not.toBe(lf.checksum);
});

test('expand rejects destructive statements', async () => {
  await rejects('core', '0002_a.sql', 'DROP TABLE x;');
  await rejects('core', '0002_a.sql', 'DELETE FROM x;');
  await rejects('core', '0002_a.sql', 'ALTER TABLE x RENAME TO y;');
  await rejects('core', '0002_a.sql', 'ALTER TABLE x DROP COLUMN c;');
  await rejects('core', '0002_a.sql', 'CREATE TABLE a (id TEXT); drop index i;');
});

test('expand lint reads code only', async () => {
  await expect(
    loadMigrationSource('core', '0002_a.sql', "INSERT INTO t VALUES ('DROP TABLE x');"),
  ).resolves.toMatchObject({ phase: 'expand' });
  await expect(
    loadMigrationSource('core', '0002_a.sql', '-- DROP TABLE x\nCREATE TABLE a (id TEXT);'),
  ).resolves.toMatchObject({ phase: 'expand' });
});

test('contract accepts what expand rejects', async () => {
  const source = await loadMigrationSource(
    'core',
    '0003_b.sql',
    '-- pb:phase contract\nDROP TABLE x;\nDELETE FROM y;\nALTER TABLE a RENAME TO b;',
  );
  expect(source.phase).toBe('contract');
});

test('an explicit expand phase is accepted and an unknown one is not', async () => {
  await expect(
    loadMigrationSource('core', '0002_a.sql', '-- pb:phase expand\nCREATE TABLE a (id TEXT);'),
  ).resolves.toMatchObject({ phase: 'expand' });
  await rejects('core', '0002_a.sql', '-- pb:phase later\nCREATE TABLE a (id TEXT);');
});

test('rejects a bad owner or file name', async () => {
  await rejects('Core', '0001_init.sql', 'SELECT 1;');
  await rejects('core', '1_init.sql', 'SELECT 1;');
  await rejects('core', '0001-init.sql', 'SELECT 1;');
});
