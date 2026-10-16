import { sql } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import type { RepresentationForm } from '../schema.js';

const SECONDS = '%Y-%m-%dT%H:%M:%SZ';
const SHA256 = /^[0-9a-f]{64}$/;
const FORMS: readonly RepresentationForm[] = ['composer-p2', 'composer-p2-dev'];

export interface RepresentationClockInput {
  readonly projectId: string;
  readonly packageId: string;
  readonly keyHash: string;
  readonly form: RepresentationForm;
  readonly validator: string;
  readonly rev: number;
}

export interface RepresentationClockReading {
  readonly stale: boolean;
  readonly validator: string;
  readonly lastModified: string;
}

export interface RepresentationClockRepository {
  advance(ctx: OrgContext, input: RepresentationClockInput): Promise<RepresentationClockReading>;
}

interface ClockRow {
  readonly package_id: string;
  readonly rev: number;
  readonly validator: string;
  readonly last_modified: string;
}

function assertInput(input: RepresentationClockInput): void {
  if (typeof input.rev !== 'number') throw new TypeError('rev must be a number');
  if (!Number.isSafeInteger(input.rev) || input.rev < 0) {
    throw new RangeError('rev must be a non-negative safe integer');
  }
  if (typeof input.projectId !== 'string' || input.projectId === '') {
    throw new TypeError('projectId must be a non-empty string');
  }
  if (typeof input.packageId !== 'string' || input.packageId === '') {
    throw new TypeError('packageId must be a non-empty string');
  }
  if (!SHA256.test(input.keyHash))
    throw new TypeError('keyHash must be 64 lowercase hex characters');
  if (!SHA256.test(input.validator)) {
    throw new TypeError('validator must be 64 lowercase hex characters');
  }
  if (!FORMS.includes(input.form)) throw new TypeError('form must be a Composer document form');
}

export function createRepresentationClock(
  executor: ScalarSqlExecutor,
): RepresentationClockRepository {
  return {
    async advance(ctx, input) {
      assertInput(input);
      const read = compile(
        db
          .selectFrom('representation_clock')
          .select(['validator', 'last_modified', 'rev', 'package_id'])
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', input.projectId)
          .where('key_hash', '=', input.keyHash)
          .where('form', '=', input.form),
      ) as ScalarStatement;
      const [current] = await executor.all<ClockRow>(read);
      if (
        current?.package_id === input.packageId &&
        current.validator === input.validator &&
        current.rev >= input.rev
      ) {
        return {
          validator: current.validator,
          lastModified: current.last_modified,
          stale: current.rev > input.rev,
        };
      }
      const upsert = compile(
        db
          .insertInto('representation_clock')
          .columns([
            'org_id',
            'project_id',
            'key_hash',
            'form',
            'validator',
            'last_modified',
            'rev',
            'package_id',
          ])
          .expression((eb) =>
            eb
              .selectFrom('project')
              .select([
                'project.org_id',
                'project.id',
                eb.val(input.keyHash).as('key_hash'),
                eb.val(input.form).as('form'),
                eb.val(input.validator).as('validator'),
                sql<string>`strftime(${sql.lit(SECONDS)}, 'now')`.as('last_modified'),
                eb.val(input.rev).as('rev'),
                eb.val(input.packageId).as('package_id'),
              ])
              .where('project.id', '=', input.projectId)
              .where('project.org_id', '=', ctx.orgId),
          )
          .onConflict((conflict) =>
            conflict
              .columns(['project_id', 'key_hash', 'form'])
              .doUpdateSet((eb) => ({
                validator: eb.ref('excluded.validator'),
                rev: eb.ref('excluded.rev'),
                package_id: eb.ref('excluded.package_id'),
                last_modified: sql<string>`CASE WHEN excluded.validator <> representation_clock.validator OR excluded.package_id <> representation_clock.package_id THEN max(excluded.last_modified, strftime(${sql.lit(SECONDS)}, representation_clock.last_modified, '+1 seconds')) ELSE representation_clock.last_modified END`,
              }))
              .where('representation_clock.org_id', '=', ctx.orgId)
              .where((eb) =>
                eb.or([
                  eb('excluded.package_id', '<>', eb.ref('representation_clock.package_id')),
                  eb.and([
                    eb('excluded.package_id', '=', eb.ref('representation_clock.package_id')),
                    eb.or([
                      eb('excluded.rev', '>', eb.ref('representation_clock.rev')),
                      eb.and([
                        eb('excluded.rev', '=', eb.ref('representation_clock.rev')),
                        eb('representation_clock.validator', '<>', eb.ref('excluded.validator')),
                      ]),
                    ]),
                  ]),
                ]),
              ),
          ),
      ) as ScalarStatement;
      const [, result] = await executor.batch([upsert, read]);
      const row = result?.rows[0] as ClockRow | undefined;
      if (row === undefined) throw new Error('representation clock: project not found');
      return {
        validator: row.validator,
        lastModified: row.last_modified,
        stale: row.package_id === input.packageId && row.rev > input.rev,
      };
    },
  };
}
