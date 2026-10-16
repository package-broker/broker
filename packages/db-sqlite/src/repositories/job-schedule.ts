import { sql, type RawBuilder } from 'kysely';
import type { OrgContext, SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import {
  DEFAULT_MAX_ATTEMPTS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_JOB_ATTEMPTS,
  assertQualifiedJobName,
  normalizeRunAt,
  validateSchedule,
} from '@package-broker/core/platform/jobs';
import { db } from '../kysely.js';

const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
const NOW = sql.raw(`strftime('${FORMAT}','now')`);
const DUE_PAGE_LIMIT = 100;
const SLOT_LENGTH = 24;
const SLOT_DATE_LENGTH = 11;
const SLOT_DATE_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T';
const SLOT_TIME_GLOB = '[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z';
const KEY_PREFIX = 'schedule:';
const MAX_NAME = MAX_IDEMPOTENCY_KEY_LENGTH - KEY_PREFIX.length - 1 - SLOT_LENGTH;
const MINUTE_MS = 60_000;
const MAX_EVERY_SECONDS = 366 * 24 * 60 * 60;
const LAST_REPRESENTABLE_MS = Date.parse('9999-12-31T23:59:59.000Z');

export interface ScheduleDefinition {
  /** Qualified job name; it is also the job type, so the definition must accept the `{}` payload. */
  readonly name: string;
  readonly everySeconds: number;
  /** Used only when the row is created; defaults to the next minute boundary of DB time. */
  readonly nextRunAt?: string;
  /** Defaults to the core default. Held in memory by `sync`, so call `sync` on the same instance that ticks. */
  readonly maxAttempts?: number;
}

export interface JobScheduleRepository {
  /** Creates the row if missing. An existing row keeps its slot and is re-enabled. `nextRunAt` is truncated to the minute. */
  upsert(
    ctx: OrgContext,
    row: { name: string; everySeconds: number; nextRunAt: string },
  ): Promise<void>;
  /**
   * Upserts every definition and disables every other row of the org in one batch. A row that is
   * registered again by a later sync is re-enabled. Scheduled jobs always carry the `{}` payload.
   */
  sync(ctx: OrgContext, definitions: readonly ScheduleDefinition[]): Promise<void>;
  /** Rejects with `JobScheduleTickError` (carrying the jobs that did fire) when any row failed. */
  tick(ctx: OrgContext, now?: never): Promise<readonly { name: string; jobId: string }[]>;
  disable(ctx: OrgContext, name: string): Promise<void>;
}

export class JobScheduleTickError extends AggregateError {
  readonly fired: readonly { name: string; jobId: string }[];

  constructor(errors: readonly unknown[], fired: readonly { name: string; jobId: string }[]) {
    super(errors, 'job_schedule_tick_failed');
    this.name = 'JobScheduleTickError';
    this.fired = fired;
  }
}

interface Checked {
  readonly name: string;
  readonly everySeconds: number;
  readonly nextRunAt: string | null;
  readonly maxAttempts: number;
}

function statement(query: RawBuilder<unknown>): Statement {
  const compiled = query.compile(db);
  return { sql: compiled.sql, params: compiled.parameters as readonly SqlValue[] };
}

function scheduleName(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_NAME) {
    throw new RangeError('name must be a qualified job name that fits the idempotency key');
  }
  assertQualifiedJobName(value);
  return value;
}

function minuteAligned(value: string): string {
  const time = Date.parse(normalizeRunAt(value));
  return new Date(Math.floor(time / MINUTE_MS) * MINUTE_MS).toISOString();
}

function check(definition: ScheduleDefinition): Checked {
  const name = scheduleName(definition.name);
  validateSchedule({ everySeconds: definition.everySeconds });
  if (definition.everySeconds > MAX_EVERY_SECONDS) {
    throw new RangeError(`everySeconds must be at most ${String(MAX_EVERY_SECONDS)}`);
  }
  const maxAttempts = definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_JOB_ATTEMPTS) {
    throw new RangeError('maxAttempts is out of range');
  }
  const nextRunAt = definition.nextRunAt === undefined ? null : minuteAligned(definition.nextRunAt);
  if (
    nextRunAt !== null &&
    Date.parse(nextRunAt) + definition.everySeconds * 1000 > LAST_REPRESENTABLE_MS
  ) {
    throw new RangeError('nextRunAt leaves no representable next slot');
  }
  return { name, everySeconds: definition.everySeconds, nextRunAt, maxAttempts };
}

function firstRun(item: Checked): RawBuilder<string> {
  return item.nextRunAt === null
    ? sql<string>`strftime('%Y-%m-%dT%H:%M:00.000Z','now','+1 minute')`
    : sql<string>`${item.nextRunAt}`;
}

function upsertStatement(ctx: OrgContext, item: Checked): Statement {
  return statement(sql`INSERT INTO job_schedule (org_id, name, every_seconds, next_run_at, enabled)
    VALUES (${ctx.orgId}, ${item.name}, ${item.everySeconds}, ${firstRun(item)}, 1)
    ON CONFLICT (org_id, name) DO UPDATE SET enabled = 1
    WHERE job_schedule.every_seconds = excluded.every_seconds`);
}

const INTERVAL_CHANGED = 'everySeconds is fixed per definition version; register a new version';

export function createJobScheduleRepository(executor: SqlExecutor): JobScheduleRepository {
  const registered = new Map<string, Checked>();

  async function intervalClash(ctx: OrgContext, items: readonly Checked[]): Promise<boolean> {
    const intervals = JSON.stringify(
      items.map((item) => ({ name: item.name, every: item.everySeconds })),
    );
    const rows = await executor.all<{ name: string }>(
      statement(sql`SELECT s.name FROM job_schedule s
        JOIN json_each(${intervals}) j ON s.name = json_extract(j.value, '$.name')
        WHERE s.org_id = ${ctx.orgId} AND s.every_seconds <> json_extract(j.value, '$.every')
        LIMIT 1`),
    );
    return rows.length > 0;
  }

  async function dueNames(ctx: OrgContext): Promise<string[]> {
    const names: string[] = [];
    let after = '';
    for (;;) {
      const page = await executor.all<{ name: string }>(
        statement(sql`SELECT name FROM job_schedule
          WHERE org_id = ${ctx.orgId} AND enabled = 1 AND every_seconds IS NOT NULL
            AND next_run_at <= ${NOW} AND name > ${after}
          ORDER BY name LIMIT ${DUE_PAGE_LIMIT}`),
      );
      for (const row of page) names.push(row.name);
      const last = page[page.length - 1];
      if (last === undefined || page.length < DUE_PAGE_LIMIT) return names;
      after = last.name;
    }
  }

  async function missingNames(ctx: OrgContext): Promise<string[]> {
    if (registered.size === 0) return [];
    const names = JSON.stringify([...registered.keys()]);
    const rows = await executor.all<{ value: string }>(
      statement(sql`SELECT value FROM json_each(${names})
        WHERE value NOT IN (SELECT name FROM job_schedule WHERE org_id = ${ctx.orgId})`),
    );
    return rows.map((row) => row.value);
  }

  return {
    async upsert(ctx, row) {
      const item = check(row);
      const [, stored] = await executor.batch([
        upsertStatement(ctx, item),
        statement(sql`SELECT every_seconds FROM job_schedule
          WHERE org_id = ${ctx.orgId} AND name = ${item.name}`),
      ]);
      const current = (stored?.rows[0] as { every_seconds: number | null } | undefined)
        ?.every_seconds;
      if (current !== item.everySeconds) throw new RangeError(INTERVAL_CHANGED);
    },

    async sync(ctx, definitions) {
      const items = definitions.map(check);
      if (new Set(items.map((item) => item.name)).size !== items.length) {
        throw new RangeError('duplicate schedule name');
      }
      const names = JSON.stringify(items.map((item) => item.name));
      const intervals = JSON.stringify(
        items.map((item) => ({ name: item.name, every: item.everySeconds })),
      );
      try {
        await executor.batch([
          ...items.map((item) => upsertStatement(ctx, item)),
          // json_extract raises on malformed JSON, which rolls the whole batch back; the input
          // depends on row data so the statement cannot be folded away.
          statement(sql`SELECT json_extract(
              CASE WHEN s.every_seconds <> json_extract(j.value, '$.every') THEN '{' ELSE '{}' END,
              '$')
            FROM job_schedule s JOIN json_each(${intervals}) j
              ON s.name = json_extract(j.value, '$.name')
            WHERE s.org_id = ${ctx.orgId}`),
          statement(sql`UPDATE job_schedule SET enabled = 0
            WHERE org_id = ${ctx.orgId} AND enabled = 1
              AND name NOT IN (SELECT value FROM json_each(${names}))`),
        ]);
      } catch (error) {
        if (await intervalClash(ctx, items))
          throw new RangeError(INTERVAL_CHANGED, { cause: error });
        throw error;
      }
      registered.clear();
      for (const item of items) registered.set(item.name, item);
    },

    async tick(ctx) {
      const work = new Set<string>(await dueNames(ctx));
      for (const name of await missingNames(ctx)) work.add(name);

      const fired: { name: string; jobId: string }[] = [];
      const errors: unknown[] = [];
      for (const name of work) {
        const jobId = ulid();
        const definition = registered.get(name);
        const maxAttempts = definition?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        const prefix = `${KEY_PREFIX}${name}:`;
        const slot = sql`strftime('${sql.raw(FORMAT)}',
          unixepoch(s.next_run_at)
            + ((unixepoch(${NOW}) - unixepoch(s.next_run_at)) / s.every_seconds) * s.every_seconds,
          'unixepoch')`;
        const statements: Statement[] = [];
        if (definition !== undefined) {
          statements.push(
            statement(sql`INSERT INTO job_schedule
                (org_id, name, every_seconds, next_run_at, enabled)
              VALUES (${ctx.orgId}, ${name}, ${definition.everySeconds},
                ${firstRun({ ...definition, nextRunAt: null })}, 1)
              ON CONFLICT (org_id, name) DO NOTHING`),
          );
        }
        const insertAt = statements.length;
        statements.push(
          statement(sql`INSERT INTO job (id, org_id, type, payload_json, idempotency_key, max_attempts)
            SELECT ${jobId}, s.org_id, s.name, '{}', ${prefix} || ${slot}, ${maxAttempts}
            FROM job_schedule s
            WHERE s.org_id = ${ctx.orgId} AND s.name = ${name} AND s.enabled = 1
              AND s.every_seconds IS NOT NULL AND s.next_run_at <= ${NOW}
            ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`),
          // The slot is read back from the newest slot job, so it cannot drift from the insert above.
          statement(sql`UPDATE job_schedule SET
              last_slot = newest.slot,
              next_run_at = strftime('${sql.raw(FORMAT)}', newest.slot,
                printf('+%d seconds', job_schedule.every_seconds))
            FROM (SELECT substr(max(idempotency_key), ${prefix.length + 1}) AS slot FROM job
              WHERE org_id = ${ctx.orgId} AND type = ${name} AND idempotency_key >= ${prefix}
                AND idempotency_key < ${`${KEY_PREFIX}${name};`}
                AND length(idempotency_key) = ${prefix.length + SLOT_LENGTH}
                AND substr(idempotency_key, ${prefix.length + 1}, ${SLOT_DATE_LENGTH}) GLOB ${SLOT_DATE_GLOB}
                AND substr(idempotency_key, ${prefix.length + 1 + SLOT_DATE_LENGTH}) GLOB ${SLOT_TIME_GLOB}) AS newest
            WHERE job_schedule.org_id = ${ctx.orgId} AND job_schedule.name = ${name}
              AND job_schedule.enabled = 1 AND job_schedule.every_seconds IS NOT NULL
              AND newest.slot >= job_schedule.next_run_at AND newest.slot <= ${NOW}`),
        );
        try {
          const results = await executor.batch(statements);
          if (results[insertAt]?.changes === 1) fired.push({ name, jobId });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new JobScheduleTickError(errors, fired);
      return fired;
    },

    async disable(ctx, name) {
      await executor.batch([
        statement(sql`UPDATE job_schedule SET enabled = 0
          WHERE org_id = ${ctx.orgId} AND name = ${scheduleName(name)}`),
      ]);
    },
  };
}
