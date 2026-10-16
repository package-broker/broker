import { sql } from 'kysely';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import type { RepresentationForm } from '../schema.js';

const SECONDS = '%Y-%m-%dT%H:%M:%SZ';
const SHA256 = /^[0-9a-f]{64}$/;
const FORMS: readonly RepresentationForm[] = ['composer-p2', 'composer-p2-dev'];

export interface RepresentationClockInput {
  readonly projectId: string;
  readonly keyHash: string;
  readonly form: RepresentationForm;
  readonly validator: string;
}

export interface RepresentationClockReading {
  readonly validator: string;
  readonly lastModified: string;
}

export interface RepresentationClockRepository {
  advance(ctx: OrgContext, input: RepresentationClockInput): Promise<RepresentationClockReading>;
}

interface ClockRow {
  readonly validator: string;
  readonly last_modified: string;
}

function assertInput(input: RepresentationClockInput): void {
  if (typeof input.projectId !== 'string' || input.projectId === '') {
    throw new TypeError('projectId must be a non-empty string');
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
          .select(['validator', 'last_modified'])
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', input.projectId)
          .where('key_hash', '=', input.keyHash)
          .where('form', '=', input.form),
      ) as ScalarStatement;
      const [current] = await executor.all<ClockRow>(read);
      if (current?.validator === input.validator) {
        return { validator: current.validator, lastModified: current.last_modified };
      }
      const upsert = compile(
        db
          .insertInto('representation_clock')
          .columns(['org_id', 'project_id', 'key_hash', 'form', 'validator', 'last_modified'])
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
              ])
              .where('project.id', '=', input.projectId)
              .where('project.org_id', '=', ctx.orgId),
          )
          .onConflict((conflict) =>
            conflict
              .columns(['project_id', 'key_hash', 'form'])
              .doUpdateSet((eb) => ({
                validator: eb.ref('excluded.validator'),
                last_modified: sql<string>`max(excluded.last_modified, strftime(${sql.lit(SECONDS)}, representation_clock.last_modified, '+1 seconds'))`,
              }))
              .where('representation_clock.org_id', '=', ctx.orgId)
              .where('representation_clock.validator', '<>', (eb) => eb.ref('excluded.validator')),
          ),
      ) as ScalarStatement;
      const [, result] = await executor.batch([upsert, read]);
      const row = result?.rows[0] as ClockRow | undefined;
      if (row === undefined) throw new Error('representation clock: project not found');
      return { validator: row.validator, lastModified: row.last_modified };
    },
  };
}
