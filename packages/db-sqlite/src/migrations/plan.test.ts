import { expect, test } from 'vitest';
import { assertPlannedSources, planMigrations } from './plan.js';
import { MigrationSourceError, sha256Hex, type MigrationSource } from './source.js';

async function make(owner: string, sequence: number, suffix = 'x'): Promise<MigrationSource> {
  const name = `${String(sequence).padStart(4, '0')}_${suffix}`;
  const sql = `CREATE TABLE ${owner}_${name} (id INTEGER);`;
  return {
    id: `${owner}:${name}`,
    owner,
    name,
    sequence,
    sql,
    checksum: await sha256Hex(sql),
    phase: 'expand',
  };
}

const init = () => make('core', 1, 'init');
const ids = (list: readonly MigrationSource[]) => list.map((source) => source.id);
const planRejects = (sources: MigrationSource[], owners: string[] = ['core', 'github']) =>
  expect(planMigrations(sources, owners)).rejects.toBeInstanceOf(MigrationSourceError);
const assertRejects = (sources: MigrationSource[]) =>
  expect(assertPlannedSources(sources)).rejects.toBeInstanceOf(MigrationSourceError);

test('planMigrations sorts by owner position then sequence', async () => {
  const plugin = await make('github', 1, 'a');
  const second = await make('core', 2, 'b');
  const planned = await planMigrations([plugin, second, await init()], ['core', 'github']);

  expect(ids(planned)).toEqual(['core:0001_init', 'core:0002_b', 'github:0001_a']);
});

test('planMigrations output passes assertPlannedSources', async () => {
  const planned = await planMigrations(
    [await make('github', 2, 'b'), await make('github', 1, 'a'), await init()],
    ['core', 'github'],
  );

  await expect(assertPlannedSources(planned)).resolves.toBeUndefined();
});

test('planMigrations rejects a duplicate id', async () => {
  await planRejects([await init(), await init()]);
});

test('planMigrations rejects a duplicate owner and sequence', async () => {
  await planRejects([await init(), await make('core', 2, 'a'), await make('core', 2, 'b')]);
});

test('planMigrations rejects an unknown owner', async () => {
  await planRejects([await init(), await make('gitlab', 1, 'a')]);
});

test('planMigrations rejects an owner order that does not start with core', async () => {
  await planRejects([await init()], ['github', 'core']);
});

test('planMigrations rejects an owner order with core twice', async () => {
  await planRejects([await init()], ['core', 'github', 'core']);
});

test('planMigrations rejects a missing core:0001_init', async () => {
  await planRejects([await make('core', 2, 'b')]);
});

test('planMigrations rejects a checksum mismatch and names the id', async () => {
  const changed = { ...(await make('core', 2, 'b')), sql: 'DROP TABLE x;' };

  await expect(planMigrations([await init(), changed], ['core'])).rejects.toThrow(changed.id);
});

test('assertPlannedSources rejects an empty list', async () => {
  await assertRejects([]);
});

test('assertPlannedSources rejects a list not starting with core:0001_init', async () => {
  await assertRejects([await make('core', 2, 'b'), await init()]);
});

test('assertPlannedSources rejects plugin sources before core', async () => {
  await assertRejects([await init(), await make('github', 1, 'a'), await make('core', 2, 'b')]);
});

test('assertPlannedSources rejects non-contiguous owners', async () => {
  await assertRejects([
    await init(),
    await make('github', 1, 'a'),
    await make('gitlab', 1, 'a'),
    await make('github', 2, 'b'),
  ]);
});

test('assertPlannedSources rejects out-of-order sequences', async () => {
  await assertRejects([await init(), await make('core', 3, 'c'), await make('core', 2, 'b')]);
});

test('assertPlannedSources rejects duplicate ids and duplicate sequences', async () => {
  await assertRejects([await init(), await init()]);
  await assertRejects([await init(), await make('core', 2, 'a'), await make('core', 2, 'b')]);
});

test('assertPlannedSources rejects a tampered checksum and names the id', async () => {
  const tampered = { ...(await make('core', 2, 'b')), sql: 'DROP TABLE x;' };

  await expect(assertPlannedSources([await init(), tampered])).rejects.toThrow(tampered.id);
});

test('planMigrations rejects a migration that sorts before core:0001_init', async () => {
  const before = await make('core', 0, 'before');

  await expect(planMigrations([before, await init()], ['core'])).rejects.toThrow(before.id);
});

test('planMigrations and assertPlannedSources agree on the planned list', async () => {
  const planned = await planMigrations(
    [
      await make('github', 1, 'a'),
      await make('core', 3, 'c'),
      await init(),
      await make('core', 2, 'b'),
    ],
    ['core', 'github'],
  );

  await expect(assertPlannedSources(planned)).resolves.toBeUndefined();
});
