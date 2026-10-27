import { sql, type RawBuilder } from 'kysely';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import {
  IdempotencyConflictError,
  JOB_LEASE_SECONDS,
  JOB_REAP_PAGE_LIMIT,
  JOB_STATUS_HISTORY_LIMIT,
  StaleFenceError,
  type JobClaim,
  type JobEnqueue,
  type JobGuard,
  type JobRepository,
  type JobSettle,
} from '@package-broker/core/platform/job-repository';
import {
  JobError,
  MAX_JOB_ATTEMPTS,
  normalizeRunAt,
  retryDelaySeconds,
  type JobAttemptOutcome,
  type JobAttemptSummary,
  type JobErrorCode,
  type JobState,
  type JobStatus,
} from '@package-broker/core/platform/jobs';
import { SOURCE_ERROR_CODES } from '@package-broker/core/sources/source-error-codes';
import type { SourceErrorCode } from '@package-broker/core/db/source';
import { db } from '../kysely.js';

const FORMAT = '%Y-%m-%dT%H:%M:%fZ';
const NOW = sql.raw(`strftime('${FORMAT}','now')`);
export const BACKOFF_STEPS = 11;
const MAX_RELEASE_DELAY_SECONDS = 30 * 24 * 60 * 60;
const MAX_LEASE_SECONDS = 3600;
const MAX_RUNNING_LIMIT = 1000;
const MAX_TYPES = 1000;
const MAX_TEXT = 512;
const MAX_PAYLOAD_BYTES = 131072;
const MAX_TYPES_BYTES = 65536;
const CORRUPT_SCAN_LIMIT = 10;
const encoder = new TextEncoder();

function typeList(types: readonly string[]): string {
  if (!Array.isArray(types)) throw new RangeError('types must be an array');
  if (types.length > MAX_TYPES) throw new RangeError('too many job types');
  const json = JSON.stringify(types.map((type) => text('type', type)));
  if (encoder.encode(json).length > MAX_TYPES_BYTES) {
    throw new RangeError('registered types exceed the parameter budget');
  }
  return json;
}

const ERROR_CODES: Readonly<Record<JobErrorCode, true>> = {
  invalid_name: true,
  invalid_version: true,
  invalid_definition: true,
  invalid_schedule: true,
  invalid_payload: true,
  payload_too_large: true,
  invalid_idempotency_key: true,
  invalid_run_at: true,
  invalid_attempt: true,
  unknown_job_type: true,
  idempotency_conflict: true,
  lease_lost: true,
  timeout: true,
  aborted: true,
  handler_error: true,
};

function isJobErrorCode(value: unknown): value is JobErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}

export const JOB_DUE_PAGE_LIMIT = 100;
export const JOB_UNREGISTERED_GRACE_SECONDS = 24 * 60 * 60;

export interface DueJobLister {
  /**
   * IDs of claimable jobs: queued, due by database time, of a registered type and not waiting on a
   * resource that a running job holds; of several due rows on one resource only the first is listed. Ordered by `(run_at, id)`; `afterId` continues after that
   * job's current position, and an unknown or no longer queued cursor yields an empty page.
   */
  listDue(
    ctx: OrgContext,
    input: {
      readonly types: readonly string[];
      readonly limit: number;
      readonly afterId?: string | undefined;
    },
  ): Promise<readonly string[]>;
  /**
   * Marks dead (last error `unknown_job_type`) at most `limit` queued jobs whose type is not in
   * `types`, that have been due for at least `graceSeconds`, and whose type had no attempt start or
   * finish within that window (so a type that was registered again recently is spared). An empty
   * `types` list buries nothing. Returns the number of rows changed.
   */
  buryUnregistered(
    ctx: OrgContext,
    input: {
      readonly types: readonly string[];
      readonly graceSeconds: number;
      readonly limit: number;
    },
  ): Promise<number>;
}

export type SqliteJobRepository = JobRepository & DueJobLister;

export interface JobRepositoryOptions {
  readonly random?: () => number;
}

interface JobRow {
  readonly id: string;
  readonly type: string;
  readonly payload_json: string;
  readonly idempotency_key: string;
  readonly resource_key: string | null;
  readonly project_id: string | null;
  readonly initiator_token_id: string | null;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly fence: number;
  readonly lease_owner: string;
  readonly lease_until: string;
  readonly state: JobState;
  readonly run_at: string;
  readonly last_error: string | null;
}

interface AttemptRow {
  readonly attempt: number;
  readonly outcome: JobAttemptOutcome;
  readonly error: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
}

function statement(query: RawBuilder<unknown>): Statement {
  const compiled = query.compile(db);
  return { sql: compiled.sql, params: compiled.parameters as readonly SqlValue[] };
}

export function text(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) {
    throw new RangeError(
      `${field} must be a non-empty string of at most ${String(MAX_TEXT)} characters`,
    );
  }
  return value;
}

function integer(field: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return value;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function ulidOwner(value: unknown): string {
  if (typeof value !== 'string' || !ULID.test(value)) {
    throw new RangeError('owner must be a ULID');
  }
  return value;
}

export function jsonPayload(value: unknown): string {
  if (typeof value !== 'string' || encoder.encode(value).length > MAX_PAYLOAD_BYTES) {
    throw new JobError('invalid_payload');
  }
  try {
    JSON.parse(value);
  } catch {
    throw new JobError('invalid_payload');
  }
  return value;
}

function storedCode(value: string | null): JobErrorCode | null {
  if (value === null) return null;
  return isJobErrorCode(value) ? value : 'handler_error';
}

function plus(base: RawBuilder<unknown>, seconds: RawBuilder<unknown>): RawBuilder<string> {
  return sql<string>`strftime('${sql.raw(FORMAT)}', ${base}, printf('+%.3f seconds', ${seconds}))`;
}

function guardOf(ctx: OrgContext, guard: JobGuard) {
  return sql`job.id = ${text('id', guard.id)} AND job.org_id = ${ctx.orgId}
    AND job.lease_owner = ${text('owner', guard.owner)}
    AND job.fence = ${integer('fence', guard.fence, 1, Number.MAX_SAFE_INTEGER)}
    AND job.state = 'running'`;
}

function marker(outcome: JobAttemptOutcome, column: 'next_run_at' | 'finished_at') {
  return sql`(SELECT a.${sql.raw(column)} FROM job_attempt a
    WHERE a.job_id = job.id AND a.fence = job.fence AND a.outcome = ${outcome})`;
}

export function createJobRepository(
  executor: SqlExecutor,
  options: JobRepositoryOptions = {},
): SqliteJobRepository {
  const jitter = (): RawBuilder<number> => {
    if (options.random === undefined) {
      return sql<number>`(0.8 + 0.2 * (abs(random() % 1000001)) / 1000000.0)`;
    }
    const draw = options.random();
    if (typeof draw !== 'number' || !Number.isFinite(draw) || draw < 0 || draw > 1) {
      throw new RangeError('random must return a number between 0 and 1');
    }
    return sql<number>`${0.8 + 0.2 * draw}`;
  };

  function backoffAt(
    attempts: RawBuilder<unknown>,
    max: RawBuilder<unknown>,
  ): RawBuilder<string | null> {
    const steps = Array.from({ length: BACKOFF_STEPS }, (_, index) => {
      return sql`WHEN ${index + 1} THEN ${retryDelaySeconds(index + 1, () => 1)}`;
    });
    const delay = sql`CASE min(${attempts}, ${BACKOFF_STEPS}) ${sql.join(steps, sql` `)} END * ${jitter()}`;
    return sql<
      string | null
    >`CASE WHEN ${attempts} >= ${max} THEN NULL ELSE ${plus(NOW, delay)} END`;
  }

  const nextRunOf = (): RawBuilder<string | null> =>
    sql<string | null>`(SELECT ${backoffAt(sql.raw('j.attempts'), sql.raw('j.max_attempts'))}
      FROM job j WHERE j.id = job_attempt.job_id)`;

  function expireAttempts(ctx: OrgContext, ids: RawBuilder<unknown>): Statement {
    return statement(sql`UPDATE job_attempt SET outcome = 'lease_expired', error = 'lease_lost',
      finished_at = ${NOW}, next_run_at = ${nextRunOf()}
      WHERE job_attempt.org_id = ${ctx.orgId} AND job_attempt.outcome = 'running'
      AND job_attempt.job_id IN (${ids})
      AND EXISTS (SELECT 1 FROM job x WHERE x.id = job_attempt.job_id
        AND x.fence = job_attempt.fence AND x.state = 'running' AND x.lease_until <= ${NOW})`);
  }

  function expireOrphans(ctx: OrgContext, ids: RawBuilder<unknown>): Statement {
    const attempts = sql.raw('attempts');
    const max = sql.raw('max_attempts');
    return statement(sql`UPDATE job SET
      state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
      run_at = COALESCE(${backoffAt(attempts, max)}, run_at),
      last_error = 'lease_lost', sync_error = NULL,
      finished_at = CASE WHEN attempts >= max_attempts THEN ${NOW} ELSE NULL END,
      lease_owner = NULL, lease_until = NULL, updated_at = ${NOW}
      WHERE job.org_id = ${ctx.orgId} AND job.state = 'running' AND job.lease_until <= ${NOW}
      AND job.id IN (${ids})
      AND NOT EXISTS (SELECT 1 FROM job_attempt a WHERE a.job_id = job.id AND a.fence = job.fence
        AND a.outcome = 'running') RETURNING id`);
  }

  const requeueExpired = (ctx: OrgContext): Statement =>
    requeueJob(
      'lease_expired',
      sql`job.org_id = ${ctx.orgId} AND job.state = 'running' AND job.lease_until <= ${NOW}`,
      'lease_lost',
    );

  async function sqliteAccepts(value: string): Promise<boolean> {
    const rows = await executor.all<{ ok: number }>(
      statement(sql`SELECT json_valid(${value}) AS ok`),
    );
    return rows[0]?.ok === 1;
  }

  async function requireChange(statements: Statement[]): Promise<void> {
    const results = await executor.batch(statements);
    const last = results[results.length - 1];
    const first = results[0];
    if (first === undefined || last === undefined || first.changes < 1 || last.changes < 1) {
      throw new StaleFenceError();
    }
  }

  function requeueJob(
    outcome: JobAttemptOutcome,
    where: RawBuilder<unknown>,
    lastError: JobErrorCode | null,
    syncError: SourceErrorCode | null = null,
  ): Statement {
    const next = marker(outcome, 'next_run_at');
    const finished = marker(outcome, 'finished_at');
    const dead = outcome === 'released' ? sql`0` : sql`${next} IS NULL`;
    return statement(sql`UPDATE job SET
      state = CASE WHEN ${dead} THEN 'dead' ELSE 'queued' END,
      attempts = ${outcome === 'released' ? sql`max(attempts - 1, 0)` : sql`attempts`},
      run_at = COALESCE(${next}, run_at),
      sync_error = CASE WHEN job.type = 'core:package-sync:v1' AND job.lease_until > ${finished}
        THEN ${syncError} ELSE NULL END,
      last_error = ${lastError === null ? sql`last_error` : sql`${lastError}`},
      finished_at = CASE WHEN ${dead} THEN ${finished} ELSE NULL END,
      lease_owner = NULL,
      lease_until = NULL,
      updated_at = ${finished}
      WHERE ${where}
      AND EXISTS (SELECT 1 FROM job_attempt a WHERE a.job_id = job.id AND a.fence = job.fence
        AND a.worker = job.lease_owner AND a.outcome = ${outcome} AND a.finished_at IS NOT NULL) RETURNING id`);
  }

  return {
    async enqueue(ctx, row: JobEnqueue) {
      const id = text('id', row.id);
      const type = text('type', row.type);
      const key = text('idempotencyKey', row.idempotencyKey);
      const payloadJson = jsonPayload(row.payloadJson);
      const runAt = row.runAt === null ? null : normalizeRunAt(row.runAt);
      if (
        typeof row.maxAttempts !== 'number' ||
        !Number.isSafeInteger(row.maxAttempts) ||
        row.maxAttempts < 1 ||
        row.maxAttempts > MAX_JOB_ATTEMPTS
      ) {
        throw new JobError('invalid_attempt');
      }
      const projectId = row.projectId === null ? null : text('projectId', row.projectId);
      const tokenId =
        row.initiatorTokenId === null ? null : text('initiatorTokenId', row.initiatorTokenId);
      const resourceKey = row.resourceKey === null ? null : text('resourceKey', row.resourceKey);

      const [inserted, existing, project] = await executor
        .batch([
          statement(sql`INSERT INTO job
          (id, org_id, type, payload_json, resource_key, idempotency_key, max_attempts, run_at,
           project_id, initiator_token_id)
          SELECT ${id}, ${ctx.orgId}, ${type}, ${payloadJson}, ${resourceKey}, ${key},
            ${row.maxAttempts}, COALESCE(${runAt}, ${NOW}), ${projectId}, ${tokenId}
          WHERE ${projectId} IS NULL
            OR EXISTS (SELECT 1 FROM project WHERE id = ${projectId} AND org_id = ${ctx.orgId})
          ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`),
          statement(sql`SELECT id, type, payload_json, project_id, resource_key FROM job
          WHERE org_id = ${ctx.orgId} AND idempotency_key = ${key}`),
          statement(sql`SELECT id FROM project WHERE org_id = ${ctx.orgId} AND id = ${projectId}`),
          statement(sql`INSERT INTO source_sync_package
            (org_id, source_id, package_key, generation, job_id, state)
            SELECT j.org_id, s.id, json_extract(j.payload_json, '$.key'), s.sync_generation, j.id, j.state
            FROM job j JOIN source s ON s.org_id = j.org_id
              AND s.id = json_extract(j.payload_json, '$.sourceId')
            WHERE j.org_id = ${ctx.orgId} AND j.id = ${id}
              AND j.type = 'core:package-sync:v1' AND j.state = 'queued'
              AND s.sync_generation = json_extract(j.payload_json, '$.syncGeneration')
              AND json_type(j.payload_json, '$.key') = 'text'
            ON CONFLICT (org_id, source_id, package_key) DO UPDATE SET
              job_id = excluded.job_id, state = excluded.state, error = NULL
            WHERE source_sync_package.org_id = ${ctx.orgId}
              AND source_sync_package.generation = excluded.generation
              AND source_sync_package.job_id <> excluded.job_id
              AND EXISTS (SELECT 1 FROM job parent
                WHERE parent.org_id = ${ctx.orgId} AND parent.id = source_sync_package.job_id
                  AND parent.id = json_extract(${payloadJson}, '$.parentJob.id')
                  AND parent.lease_owner = json_extract(${payloadJson}, '$.parentJob.owner')
                  AND parent.fence = json_extract(${payloadJson}, '$.parentJob.fence')
                  AND parent.state = 'running' AND parent.lease_until > ${NOW})`),
        ])
        .catch(async (error: unknown) => {
          if (
            error instanceof DbError &&
            error.kind === 'check' &&
            !(await sqliteAccepts(payloadJson))
          ) {
            throw new JobError('invalid_payload');
          }
          throw error;
        });
      if (projectId !== null && (project?.rows.length ?? 0) === 0) {
        throw new JobError('invalid_payload');
      }
      if (inserted?.changes === 1) return { id, created: true };
      const stored = existing?.rows[0] as
        | {
            id: string;
            type: string;
            payload_json: string;
            project_id: string | null;
            resource_key: string | null;
          }
        | undefined;
      if (stored === undefined) throw new JobError('invalid_payload');
      if (
        stored.type !== type ||
        stored.payload_json !== payloadJson ||
        stored.project_id !== projectId ||
        stored.resource_key !== resourceKey
      ) {
        throw new IdempotencyConflictError();
      }
      return { id: stored.id, created: false };
    },

    async status(ctx, id): Promise<JobStatus | null> {
      const [jobs, attempts] = await executor.batch([
        statement(sql`SELECT id, type, state, attempts, max_attempts, run_at, last_error
          FROM job WHERE org_id = ${ctx.orgId} AND id = ${text('id', id)}`),
        statement(sql`SELECT attempt, outcome, error, started_at, finished_at FROM job_attempt
          WHERE org_id = ${ctx.orgId} AND job_id = ${id}
          ORDER BY fence DESC LIMIT ${JOB_STATUS_HISTORY_LIMIT}`),
      ]);
      const row = jobs?.rows[0] as JobRow | undefined;
      if (row === undefined) return null;
      const history = (attempts?.rows as unknown as AttemptRow[])
        .map((item): JobAttemptSummary => ({
          attempt: item.attempt,
          outcome: item.outcome,
          errorCode: storedCode(item.error),
          startedAt: item.started_at,
          finishedAt: item.finished_at,
        }))
        .reverse();
      return {
        id: row.id,
        type: row.type,
        state: row.state,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        runAt: row.run_at,
        lastErrorCode: storedCode(row.last_error),
        history,
      };
    },

    async claim(ctx, owner, input): Promise<JobClaim | null> {
      const who = ulidOwner(owner);
      const lease = integer('leaseSeconds', input.leaseSeconds, 1, MAX_LEASE_SECONDS);
      const cap = integer('maxRunning', input.maxRunning, 1, MAX_RUNNING_LIMIT);
      const types = typeList(input.types);
      if (input.types.length === 0) return null;
      const target = input.id === undefined ? sql`` : sql`AND c.id = ${text('id', input.id)}`;
      const eligible = sql`c.org_id = ${ctx.orgId} AND c.state = 'queued' AND c.run_at <= ${NOW}
        AND c.type IN (SELECT value FROM json_each(${types})) ${target}`;
      const holders = sql`SELECT h.id FROM job h WHERE h.org_id = ${ctx.orgId}
        AND h.state = 'running' AND h.lease_until <= ${NOW}
        AND h.resource_key IN (SELECT c.resource_key FROM job c WHERE ${eligible}
          AND c.resource_key IS NOT NULL)`;

      const unused = sql`NOT EXISTS (SELECT 1 FROM job_attempt WHERE id = ${who})`;
      const validPayload = sql`json_valid(c.payload_json) AND instr(c.payload_json, char(0)) = 0`;
      const corrupt = sql`SELECT c.id FROM job c WHERE ${eligible} AND NOT (${validPayload})
        ORDER BY c.run_at, c.id LIMIT ${CORRUPT_SCAN_LIMIT}`;
      const results = await executor.batch([
        statement(sql`SELECT count(*) AS n FROM job_attempt WHERE id = ${who}`),
        expireAttempts(ctx, holders),
        requeueExpired(ctx),
        expireOrphans(ctx, holders),
        statement(sql`UPDATE job SET state = 'dead', sync_error = NULL, last_error = 'invalid_payload',
          finished_at = ${NOW}, updated_at = ${NOW}
          WHERE org_id = ${ctx.orgId} AND state = 'queued' AND ${unused}
          AND run_at <= ${NOW}
          AND id IN (${corrupt})`),
        statement(sql`UPDATE job SET
          state = 'running', sync_error = NULL,
          attempts = attempts + 1,
          fence = fence + 1,
          lease_owner = ${who},
          lease_until = ${plus(NOW, sql`${lease}`)},
          updated_at = ${NOW}
          WHERE org_id = ${ctx.orgId} AND state = 'queued' AND ${unused} AND id = (
            SELECT c.id FROM job c
            WHERE ${eligible} AND (${validPayload})
              AND (c.resource_key IS NULL OR NOT EXISTS (
                SELECT 1 FROM job r WHERE r.org_id = c.org_id AND r.resource_key = c.resource_key
                  AND r.state = 'running'))
              AND (SELECT count(*) FROM job r WHERE r.org_id = ${ctx.orgId}
                AND r.state = 'running' AND r.lease_until > ${NOW}) < ${cap}
            ORDER BY c.run_at, c.id LIMIT 1)`),
        statement(sql`INSERT INTO job_attempt (id, org_id, job_id, attempt, fence, worker, outcome)
          SELECT ${who}, org_id, id, attempts, fence, lease_owner, 'running' FROM job
          WHERE org_id = ${ctx.orgId} AND lease_owner = ${who} AND state = 'running'
          AND ${unused}`),
        statement(sql`SELECT id, type, payload_json, idempotency_key, resource_key, project_id,
            initiator_token_id, attempts, max_attempts, fence, lease_owner, lease_until
          FROM job WHERE org_id = ${ctx.orgId} AND lease_owner = ${who} AND state = 'running'`),
      ]);
      if (Number((results[0]?.rows[0] as { n: number } | undefined)?.n ?? 0) > 0) return null;
      const selected = results[results.length - 1];
      const row = selected?.rows[0] as JobRow | undefined;
      if (row === undefined) return null;
      return {
        id: row.id,
        owner: row.lease_owner,
        fence: row.fence,
        type: row.type,
        payloadJson: row.payload_json,
        idempotencyKey: row.idempotency_key,
        resourceKey: row.resource_key,
        projectId: row.project_id,
        initiatorTokenId: row.initiator_token_id,
        attempt: row.attempts,
        maxAttempts: row.max_attempts,
        leaseUntil: row.lease_until,
      };
    },

    async heartbeat(ctx, guard) {
      const [result] = await executor.batch([
        statement(sql`UPDATE job SET
          lease_until = max(lease_until, ${plus(NOW, sql`${JOB_LEASE_SECONDS}`)}), updated_at = ${NOW}
          WHERE job.org_id = ${ctx.orgId} AND ${guardOf(ctx, guard)} AND job.lease_until > ${NOW}`),
      ]);
      if (result === undefined || result.changes < 1) throw new StaleFenceError();
    },

    async settle(ctx, guard, outcome: JobSettle) {
      const live = sql`EXISTS (SELECT 1 FROM job WHERE job.id = job_attempt.job_id
        AND job.org_id = job_attempt.org_id AND job.lease_owner = job_attempt.worker
        AND job.fence = job_attempt.fence AND job.state = 'running')`;
      const attemptWhere = sql`job_attempt.org_id = ${ctx.orgId} AND job_attempt.job_id = ${guard.id}
        AND job_attempt.fence = ${guard.fence} AND job_attempt.worker = ${guard.owner}
        AND job_attempt.outcome = 'running' AND ${live}`;
      const jobWhere = sql`job.org_id = ${ctx.orgId} AND ${guardOf(ctx, guard)}`;

      if (outcome.outcome === 'succeeded') {
        await requireChange([
          statement(sql`UPDATE job_attempt SET outcome = 'succeeded', finished_at = ${NOW}
            WHERE ${attemptWhere}`),
          statement(sql`UPDATE job SET state = 'succeeded', lease_owner = NULL, lease_until = NULL,
            last_error = NULL, sync_error = NULL, finished_at = ${marker('succeeded', 'finished_at')},
            updated_at = ${marker('succeeded', 'finished_at')}
            WHERE ${jobWhere} AND EXISTS (SELECT 1 FROM job_attempt a WHERE a.job_id = job.id
              AND a.fence = job.fence AND a.worker = job.lease_owner AND a.outcome = 'succeeded')`),
        ]);
        return;
      }
      if (outcome.outcome === 'released') {
        const delay = integer('delaySeconds', outcome.delaySeconds, 0, MAX_RELEASE_DELAY_SECONDS);
        await requireChange([
          statement(sql`UPDATE job_attempt SET outcome = 'released', finished_at = ${NOW},
            next_run_at = ${plus(NOW, sql`${delay}`)} WHERE ${attemptWhere}`),
          requeueJob('released', jobWhere, null),
        ]);
        return;
      }
      const code = isJobErrorCode(outcome.errorCode) ? outcome.errorCode : 'handler_error';
      await requireChange([
        statement(sql`UPDATE job_attempt SET outcome = 'failed', error = ${code}, finished_at = ${NOW},
          next_run_at = CASE WHEN ${outcome.permanent === true ? 1 : 0} = 1 THEN NULL
            ELSE ${nextRunOf()} END
          WHERE ${attemptWhere}`),
        requeueJob(
          'failed',
          jobWhere,
          code,
          outcome.syncError !== undefined && SOURCE_ERROR_CODES.includes(outcome.syncError)
            ? outcome.syncError
            : null,
        ),
      ]);
    },

    /**
     * One batch. Each of the two kinds (expired attempts, orphans without a running attempt at the
     * current fence) is capped at `limit`, so a call processes at most 2 x limit rows.
     */
    async reap(ctx, limit) {
      const page = integer('limit', limit, 1, JOB_REAP_PAGE_LIMIT);
      const expired = (live: RawBuilder<unknown>) => sql`SELECT p.id FROM job p
        WHERE p.org_id = ${ctx.orgId} AND p.state = 'running' AND p.lease_until <= ${NOW}
        AND ${live} (SELECT 1 FROM job_attempt q WHERE q.job_id = p.id AND q.fence = p.fence
          AND q.outcome = 'running')
        ORDER BY p.lease_until, p.id LIMIT ${page}`;
      const [, requeued, orphans] = await executor.batch([
        expireAttempts(ctx, expired(sql`EXISTS`)),
        requeueExpired(ctx),
        expireOrphans(ctx, expired(sql`NOT EXISTS`)),
      ]);
      return (requeued?.rows.length ?? 0) + (orphans?.rows.length ?? 0);
    },

    async listDue(ctx, input) {
      const page = integer('limit', input.limit, 1, JOB_DUE_PAGE_LIMIT);
      const types = typeList(input.types);
      if (input.types.length === 0) return [];
      const after =
        input.afterId === undefined
          ? sql``
          : sql`AND (j.run_at, j.id) > (SELECT c.run_at, c.id FROM job c
              WHERE c.org_id = ${ctx.orgId} AND c.id = ${text('afterId', input.afterId)}
              AND c.state = 'queued')`;
      const rows = await executor.all<{ id: string }>(
        statement(sql`SELECT j.id FROM job j
          WHERE j.state = 'queued' AND j.run_at <= ${NOW} AND j.org_id = ${ctx.orgId}
          AND j.type IN (SELECT value FROM json_each(${types}))
          AND (j.resource_key IS NULL OR (
            NOT EXISTS (SELECT 1 FROM job r WHERE r.org_id = j.org_id
              AND r.resource_key = j.resource_key AND r.state = 'running')
            AND NOT EXISTS (SELECT 1 FROM job e WHERE e.org_id = j.org_id
              AND e.resource_key = j.resource_key AND e.state = 'queued' AND e.run_at <= ${NOW}
              AND e.type IN (SELECT value FROM json_each(${types}))
              AND (e.run_at, e.id) < (j.run_at, j.id))))
          ${after}
          ORDER BY j.run_at, j.id LIMIT ${page}`),
      );
      return rows.map((row) => row.id);
    },

    async buryUnregistered(ctx, input) {
      const types = typeList(input.types);
      const grace = integer('graceSeconds', input.graceSeconds, 0, MAX_RELEASE_DELAY_SECONDS);
      const page = integer('limit', input.limit, 1, JOB_DUE_PAGE_LIMIT);
      if (input.types.length === 0) return 0;
      const cutoff = sql`strftime(${sql.raw(`'${FORMAT}'`)}, 'now', printf('-%d seconds', ${grace}))`;
      const [result] = await executor.batch([
        statement(sql`UPDATE job SET state = 'dead', sync_error = NULL, last_error = 'unknown_job_type',
          finished_at = ${NOW}, updated_at = ${NOW}
          WHERE org_id = ${ctx.orgId} AND state = 'queued' AND id IN (
            SELECT u.id FROM job u
            WHERE u.state = 'queued' AND u.org_id = ${ctx.orgId}
              AND u.run_at <= ${cutoff}
              AND u.type NOT IN (SELECT value FROM json_each(${types}))
              AND NOT EXISTS (SELECT 1 FROM job_attempt a JOIN job t ON t.id = a.job_id
                WHERE a.org_id = ${ctx.orgId} AND t.type = u.type
                AND (a.started_at > ${cutoff} OR a.finished_at > ${cutoff}))
            ORDER BY u.run_at, u.id LIMIT ${page}) RETURNING id`),
      ]);
      return result?.rows.length ?? 0;
    },
  };
}
