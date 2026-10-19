import { sql } from 'kysely';
import type { CatalogueWriteGuard, SyncResult } from '@package-broker/core/db/catalogue';
import type { OrgContext, Statement, StatementResult } from '@package-broker/core/db/port';
import { validateVersion } from '@package-broker/core/catalogue/versions';
import { assertCheck, compile, db, newOpId } from '../kysely.js';
import { assertCatalogueWriteGuard, monotonicNow } from '../internal/catalogue-write-guard.js';

export const MAX_TAGS_PER_CALL = 100;

const TAG_GRAMMAR = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NOW = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export type DistTagActorType = 'user' | 'sync' | 'import';

export interface DistTagRequest {
  readonly packageId: string;
  readonly ecosystem: 'composer' | 'npm';
  /** Tag to version_normalized; the package's tags become exactly this map. */
  readonly tags: Readonly<Record<string, string>>;
  readonly actorType: DistTagActorType;
  readonly actorId: string | null;
  readonly opId: string;
}

export interface DistTagPlan {
  readonly statements: readonly Statement[];
  /** Call after successful execution of this plan's complete batch. */
  result(results: readonly StatementResult[]): SyncResult;
}

export class DistTagRefusedError extends Error {
  constructor(readonly tags: readonly string[]) {
    super('DIST_TAGS_REFUSED');
    this.name = 'DistTagRefusedError';
  }
}

function isSemver(tag: string): boolean {
  const bare = /^[=v]+\d/.test(tag) ? tag.replace(/^[=v]+/, '') : tag;
  try {
    validateVersion({ ecosystem: 'npm', version: bare, versionNormalized: bare });
    return true;
  } catch {
    return false;
  }
}

const grammarOk = (tag: string): boolean => TAG_GRAMMAR.test(tag) && !isSemver(tag);

/**
 * Makes a package's npm dist tags equal to the request map. History rows are written only for
 * real changes, before the rows they describe change. Under a sync or import actor a tag that
 * breaks the grammar, or whose target is not a live version of this package, is skipped and
 * reported; under a user actor either one refuses the batch. Skipped tags keep their current value.
 */
export function distTagStatements(
  ctx: OrgContext,
  guard: CatalogueWriteGuard,
  request: DistTagRequest,
): DistTagPlan {
  assertCatalogueWriteGuard(ctx, guard);
  const { packageId, ecosystem, actorType, actorId, opId } = request;
  if (ecosystem !== 'npm') throw new TypeError('composer packages have no dist tags');
  const entries = Object.entries(request.tags);
  if (entries.length > MAX_TAGS_PER_CALL) {
    throw new RangeError(`a call carries at most ${String(MAX_TAGS_PER_CALL)} tags`);
  }
  const user = actorType === 'user';
  const badGrammar = entries.filter(([tag]) => !grammarOk(tag)).map(([tag]) => tag);
  if (user && badGrammar.length > 0) throw new DistTagRefusedError(badGrammar);
  const valid = entries.filter(([tag]) => grammarOk(tag));

  const packageMatches = assertCheck(
    sql<boolean>`EXISTS (SELECT 1 FROM package
      WHERE package.id = ${packageId} AND package.org_id = ${ctx.orgId}
        AND package.ecosystem = 'npm')`,
  );
  const targetOf = (target: string) => sql<string>`(SELECT version.id FROM version
    WHERE version.package_id = ${packageId} AND version.org_id = ${ctx.orgId}
      AND version.version_normalized = ${target} AND version.status != 'tombstoned')`;

  const checks: Statement[] = [];
  const probes: Statement[] = [];
  const sets: Statement[] = [];
  for (const [tag, target] of valid) {
    if (user) {
      checks.push(...assertCheck(sql<boolean>`${targetOf(target)} IS NOT NULL`));
    } else {
      probes.push(
        compile(
          db
            .selectNoFrom(sql<string>`${tag}`.as('tag'))
            .where(sql<boolean>`${targetOf(target)} IS NULL`),
        ),
      );
    }
    sets.push(
      compile(
        db
          .insertInto('dist_tag_history')
          .columns([
            'id',
            'org_id',
            'package_id',
            'tag',
            'version_id',
            'previous_version_id',
            'action',
            'actor_type',
            'actor_id',
            'op_id',
          ])
          .expression(
            db
              .selectFrom('version')
              .select([
                sql<string>`${newOpId()}`.as('id'),
                'version.org_id',
                'version.package_id',
                sql<string>`${tag}`.as('tag'),
                'version.id',
                sql<string | null>`(SELECT dist_tag.version_id FROM dist_tag
                  WHERE dist_tag.package_id = version.package_id AND dist_tag.org_id = ${ctx.orgId}
                    AND dist_tag.tag = ${tag})`.as('previous_version_id'),
                sql<string>`'set'`.as('action'),
                sql<string>`${actorType}`.as('actor_type'),
                sql<string | null>`${actorId}`.as('actor_id'),
                sql<string>`${opId}`.as('op_id'),
              ])
              .where('version.id', '=', targetOf(target))
              .where(
                sql<boolean>`NOT EXISTS (SELECT 1 FROM dist_tag AS collision
                  WHERE collision.package_id = version.package_id AND collision.tag = ${tag}
                    AND collision.org_id <> ${ctx.orgId})`,
              )
              .where(
                sql<boolean>`NOT EXISTS (SELECT 1 FROM dist_tag
                  WHERE dist_tag.package_id = version.package_id AND dist_tag.org_id = ${ctx.orgId}
                    AND dist_tag.tag = ${tag} AND dist_tag.version_id = version.id)`,
              ),
          ),
      ),
      compile(
        db
          .insertInto('dist_tag')
          .columns(['org_id', 'package_id', 'tag', 'version_id'])
          .expression(
            db
              .selectFrom('version')
              .select([
                'version.org_id',
                'version.package_id',
                sql<string>`${tag}`.as('tag'),
                'version.id',
              ])
              .where('version.id', '=', targetOf(target)),
          )
          .onConflict((oc) =>
            oc
              .columns(['package_id', 'tag'])
              .doUpdateSet({ version_id: sql<string>`excluded.version_id`, updated_at: NOW })
              .where(
                sql<boolean>`dist_tag.org_id = ${ctx.orgId} AND dist_tag.version_id IS NOT excluded.version_id`,
              ),
          ),
      ),
    );
  }

  const keep = JSON.stringify(entries.map(([tag]) => tag));
  const absent = sql<boolean>`dist_tag.package_id = ${packageId} AND dist_tag.org_id = ${ctx.orgId}
    AND dist_tag.tag NOT IN (SELECT value FROM json_each(${keep}))`;
  const removeHistory = compile(
    db
      .insertInto('dist_tag_history')
      .columns([
        'id',
        'org_id',
        'package_id',
        'tag',
        'version_id',
        'previous_version_id',
        'action',
        'actor_type',
        'actor_id',
        'op_id',
      ])
      .expression(
        db
          .selectFrom('dist_tag')
          .select([
            // One statement removes many rows: share the ULID time prefix, generate 64 random bits per row.
            sql<string>`${newOpId().slice(0, 10)} || upper(hex(randomblob(8)))`.as('id'),
            'dist_tag.org_id',
            'dist_tag.package_id',
            'dist_tag.tag',
            sql<string | null>`NULL`.as('version_id'),
            'dist_tag.version_id',
            sql<string>`'remove'`.as('action'),
            sql<string>`${actorType}`.as('actor_type'),
            sql<string | null>`${actorId}`.as('actor_id'),
            sql<string>`${opId}`.as('op_id'),
          ])
          .where(absent),
      ),
  );
  const remove = compile(db.deleteFrom('dist_tag').where(absent));
  const advance = compile(
    db
      .updateTable('package')
      .set({
        rev: sql<number>`package.rev + 1`,
        modified_at: monotonicNow,
      })
      .where('package.id', '=', packageId)
      .where('package.org_id', '=', ctx.orgId)
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM dist_tag_history
          WHERE dist_tag_history.package_id = package.id AND dist_tag_history.op_id = ${opId})`,
      ),
  );

  const head = [...guard, ...packageMatches, ...checks];
  const statements = [...head, ...probes, ...sets, removeHistory, remove, advance];
  const setOffset = head.length + probes.length;
  return {
    statements,
    result(results) {
      if (results.length !== statements.length) throw new TypeError('incomplete dist tag results');
      const skipped = [
        ...badGrammar,
        ...results
          .slice(head.length, setOffset)
          .flatMap((r) => r.rows.map((row) => String(row.tag))),
      ];
      const setChanges = results
        .slice(setOffset, setOffset + sets.length)
        .reduce((sum, result, index) => sum + (index % 2 === 0 ? result.changes : 0), 0);
      const removed = results[setOffset + sets.length]?.changes ?? 0;
      return {
        packageId,
        inserted: 0,
        updated: setChanges + removed,
        unchanged: valid.length - (skipped.length - badGrammar.length) - setChanges,
        conflicts: [],
        refused: [],
        skippedTags: skipped,
        statements: statements.length,
      };
    },
  };
}
