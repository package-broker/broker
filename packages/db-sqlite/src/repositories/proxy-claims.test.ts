import { expect, it } from 'vitest';
import { sql } from 'kysely';
import { orgContext } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import { proxyClaimsVerified } from './proxy-claims.js';

it('refuses oversized proof JSON before binding a D1 parameter', () => {
  const proof = Array.from({ length: 230 }, () => 'a'.repeat(214));
  const statement = compile(
    db.selectNoFrom(sql`${proxyClaimsVerified(orgContext('org'), proof)}`.as('verified')),
  );
  expect(statement.sql).toBe('select 0 as "verified"');
  expect(statement.params).toEqual([]);
});
