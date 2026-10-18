import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { isUlid } from '@package-broker/core/ids';
import type { OrgContext } from '@package-broker/core/db/port';
import {
  EVIDENCE_FUTURE_SKEW_MS,
  EVIDENCE_MAX_AGE_MS,
  compile,
  databaseTimeMs,
  db,
  newOpId,
  protectedHolder,
} from './kysely.js';

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

describe('protectedHolder database time', () => {
  const org = { orgId: 'org-a' } as OrgContext;
  const input = {
    kind: 'fresh',
    now: '1970-01-01T00:00:00.000Z',
    providers: [
      {
        provider: 'idp',
        anchor: 'anchor',
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ],
  } as const;
  const render = (options?: Parameters<typeof protectedHolder>[3]) =>
    compile(
      db
        .selectFrom('user_account as holder')
        .select('holder.id')
        .where((eb) => protectedHolder(org, eb.ref('holder.id'), input, options)),
    );

  it('renders the database clock in place of the supplied instant', () => {
    const statement = render({ now: databaseTimeMs });

    expect(statement.sql).toContain("unixepoch('now', 'subsec')");
  });

  it('does not bind the supplied instant when the database clock is used', () => {
    const statement = render({ now: databaseTimeMs });

    expect(statement.params).not.toContain(0 - EVIDENCE_MAX_AGE_MS);
    expect(statement.params).not.toContain(EVIDENCE_FUTURE_SKEW_MS);
  });

  it('keeps binding the supplied instant when no database clock is given', () => {
    const statement = render();

    expect(statement.sql).not.toContain("unixepoch('now', 'subsec')");
    expect(statement.params).toContain(-EVIDENCE_MAX_AGE_MS);
    expect(statement.params).toContain(EVIDENCE_FUTURE_SKEW_MS);
  });
});
