import type { Compilable, Updateable } from 'kysely';
import { sql } from 'kysely';
import { ORG_SLUG_PATTERN } from '@package-broker/core/db/organization';
import type {
  BootstrapInput,
  BootstrapResult,
  Organization,
  OrganizationBootstrap,
  OrganizationIdentity,
  OrganizationRepository,
  OrganizationSettings,
} from '@package-broker/core/db/organization';
import type {
  OrgContext,
  OrgId,
  ScalarSqlExecutor,
  ScalarStatement,
} from '@package-broker/core/db/port';
import { compile, db } from '../kysely.js';
import type { OrganizationTable } from '../schema.js';

interface IdentityRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

interface OrganizationRow extends IdentityRow {
  readonly retention_removed_upstream_days: number;
  readonly token_default_expiry_days: number;
  readonly token_ci_readonly_expiry_days: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function run<R>(executor: ScalarSqlExecutor, query: Compilable): Promise<R[]> {
  return executor.all<R>(compile(query) as ScalarStatement);
}

function identity(row: IdentityRow): OrganizationIdentity {
  return { id: row.id as OrgId, slug: row.slug, name: row.name };
}

function safeInteger(field: string, value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  return value;
}

function toOrganization(row: OrganizationRow): Organization {
  return {
    ...identity(row),
    settings: {
      retentionRemovedUpstreamDays: row.retention_removed_upstream_days,
      tokenDefaultExpiryDays: row.token_default_expiry_days,
      tokenCiReadonlyExpiryDays: row.token_ci_readonly_expiry_days,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createOrganizationRepository(executor: ScalarSqlExecutor): OrganizationRepository {
  return {
    async get(ctx: OrgContext): Promise<Organization | null> {
      const rows = await run<OrganizationRow>(
        executor,
        db.selectFrom('organization').selectAll().where('id', '=', ctx.orgId),
      );
      const row = rows[0];
      return row === undefined ? null : toOrganization(row);
    },

    async updateSettings(
      ctx: OrgContext,
      patch: Partial<OrganizationSettings> & { readonly name?: string },
      now: string,
    ): Promise<Organization | null> {
      const values: Updateable<OrganizationTable> = {};
      if (patch.retentionRemovedUpstreamDays !== undefined) {
        values.retention_removed_upstream_days = safeInteger(
          'retentionRemovedUpstreamDays',
          patch.retentionRemovedUpstreamDays,
        );
      }
      if (patch.tokenDefaultExpiryDays !== undefined) {
        values.token_default_expiry_days = safeInteger(
          'tokenDefaultExpiryDays',
          patch.tokenDefaultExpiryDays,
        );
      }
      if (patch.tokenCiReadonlyExpiryDays !== undefined) {
        values.token_ci_readonly_expiry_days = safeInteger(
          'tokenCiReadonlyExpiryDays',
          patch.tokenCiReadonlyExpiryDays,
        );
      }
      if (patch.name !== undefined) values.name = patch.name;
      values.updated_at = now;

      const rows = await run<OrganizationRow>(
        executor,
        db.updateTable('organization').set(values).where('id', '=', ctx.orgId).returningAll(),
      );
      const row = rows[0];
      return row === undefined ? null : toOrganization(row);
    },
  };
}

export function createOrganizationBootstrap(executor: ScalarSqlExecutor): OrganizationBootstrap {
  async function findSingleton(): Promise<OrganizationIdentity | null> {
    const rows = await run<IdentityRow>(
      executor,
      db
        .selectFrom('organization')
        .select(['id', 'slug', 'name'])
        .where('singleton', '=', sql.lit(1)),
    );
    const row = rows[0];
    return row === undefined ? null : identity(row);
  }

  return {
    findSingleton,

    async bootstrap(input: BootstrapInput): Promise<BootstrapResult> {
      if (!ORG_SLUG_PATTERN.test(input.slug)) {
        throw new TypeError(`invalid organization slug ${JSON.stringify(input.slug)}`);
      }

      const rows = await run<IdentityRow>(
        executor,
        db
          .insertInto('organization')
          .values({
            id: input.id,
            slug: input.slug,
            name: input.name,
            created_at: input.now,
            updated_at: input.now,
          })
          .onConflict((conflict) => conflict.column('singleton').doNothing())
          .returning(['id', 'slug', 'name']),
      );
      const row = rows[0];
      if (row !== undefined) return { created: true, ...identity(row) };

      const existing = await findSingleton();
      if (existing === null) {
        throw new Error('organization row disappeared between the insert and the read');
      }
      return { created: false, ...existing };
    },
  };
}
