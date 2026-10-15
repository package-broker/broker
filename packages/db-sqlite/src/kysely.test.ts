import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { isUlid } from '@package-broker/core/ids';
import { compile, db, newOpId } from './kysely.js';

describe('compile', () => {
  it('binds a plain parameter', () => {
    const statement = compile(
      db.selectFrom('organization').select('id').where('singleton', '=', 1),
    );

    expect(statement.sql).toBe('select "id" from "organization" where "singleton" = ?');
    expect(statement.params).toEqual([1]);
  });

  it('inlines a literal with no parameters', () => {
    const statement = compile(
      db.selectFrom('organization').select('id').where('singleton', '=', sql.lit(1)),
    );

    expect(statement.params).toEqual([]);
  });

  it('compiles an upsert with a conflict target', () => {
    const statement = compile(
      db
        .insertInto('organization')
        .values({ id: 'org', slug: 'acme', name: 'Acme' })
        .onConflict((oc) => oc.column('singleton').doNothing())
        .returning(['id', 'slug', 'name']),
    );

    expect(statement.sql).toContain('on conflict ("singleton") do nothing returning');
    expect(statement.params).toEqual(['org', 'acme', 'Acme']);
  });

  it('rejects a boolean parameter', () => {
    const query = db
      .selectFrom('organization')
      .select('id')
      .where('singleton', '=', true as never);

    expect(() => compile(query)).toThrow(TypeError);
  });

  it('rejects an unsafe integer parameter', () => {
    const query = db
      .selectFrom('organization')
      .select('id')
      .where('singleton', '=', 2 ** 53);

    expect(() => compile(query)).toThrow(TypeError);
  });

  it('rejects NaN and Infinity parameters', () => {
    const nan = db.selectFrom('organization').select('id').where('singleton', '=', Number.NaN);
    const infinite = db
      .selectFrom('organization')
      .select('id')
      .where('singleton', '=', Number.POSITIVE_INFINITY);

    expect(() => compile(nan)).toThrow(TypeError);
    expect(() => compile(infinite)).toThrow(TypeError);
  });

  it('rejects an unknown column', () => {
    // @ts-expect-error the column does not exist on organization
    const query = db.selectFrom('organization').select('unknown_column');

    expect(query).toBeDefined();
  });
});

describe('newOpId', () => {
  it('returns a fresh ULID', () => {
    const first = newOpId();
    const second = newOpId();

    expect(isUlid(first)).toBe(true);
    expect(first).not.toBe(second);
  });
});
