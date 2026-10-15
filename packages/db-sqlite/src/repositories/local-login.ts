import { expressionBuilder, sql, type Compilable } from 'kysely';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { normalizeEmail } from '@package-broker/core/identity/policy';
import type {
  LocalLoginReader,
  LocalLoginSnapshot,
  Reservation,
  TotpState,
} from '@package-broker/core/db/local-login';
import { adminEligibility, compile, db, type Database } from '../kysely.js';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SETUP_HASH = /^[0-9a-f]{64}$/;
const LOCK_EVERY = 5;

interface SnapshotRow {
  readonly user_id: string;
  readonly email: string;
  readonly user_active: number;
  readonly admin_eligible: number;
  readonly password_hash: string | null;
  readonly totp_credential_id: string | null;
  readonly totp_enabled: number;
  readonly totp_last_step: number | null;
  readonly credential_rev: number;
  readonly failed_count: number;
  readonly locked_until: string | null;
}

const loginEb = expressionBuilder<Database, 'local_login'>();

function run<R>(executor: SqlExecutor, query: Compilable): Promise<R[]> {
  return executor.all<R>(compile(query));
}

function timestamp(field: string, value: string): string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) {
    throw new TypeError(`${field} must be a UTC timestamp with millisecond precision`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a UTC timestamp with millisecond precision`);
  }
  return value;
}

function setupHashOf(value: string): string {
  if (typeof value !== 'string' || !SETUP_HASH.test(value)) {
    throw new TypeError('setupHash must be 64 lowercase hexadecimal characters');
  }
  return value;
}

function totpStateOf(row: SnapshotRow): TotpState {
  if (row.totp_enabled !== 1) return 'none';
  return row.totp_credential_id === null ? 'setup_required' : 'enabled';
}

function toSnapshot(row: SnapshotRow): LocalLoginSnapshot {
  return {
    userId: row.user_id,
    email: row.email,
    userActive: row.user_active === 1,
    adminEligible: row.admin_eligible === 1,
    passwordHash: row.password_hash,
    totpCredentialId: row.totp_credential_id,
    totpEnabled: row.totp_enabled === 1,
    totpState: totpStateOf(row),
    totpLastStep: row.totp_last_step,
    credentialRev: row.credential_rev,
    failedCount: row.failed_count,
    lockedUntil: row.locked_until,
  };
}

function adminEligibleOf(ctx: OrgContext) {
  return sql<number>`${adminEligibility(ctx, loginEb.ref('local_login.user_id'))}`.as(
    'admin_eligible',
  );
}

function selectSnapshot(ctx: OrgContext) {
  return db
    .selectFrom('local_login')
    .innerJoin('user_account', (join) =>
      join
        .onRef('user_account.id', '=', 'local_login.user_id')
        .onRef('user_account.org_id', '=', 'local_login.org_id'),
    )
    .select([
      'local_login.user_id as user_id',
      'user_account.email as email',
      sql<number>`user_account.status = 'active'`.as('user_active'),
      adminEligibleOf(ctx),
      'local_login.password_hash as password_hash',
      'local_login.totp_credential_id as totp_credential_id',
      sql<number>`local_login.totp_enabled_at is not null`.as('totp_enabled'),
      'local_login.totp_last_step as totp_last_step',
      'local_login.credential_rev as credential_rev',
      'local_login.failed_count as failed_count',
      'local_login.locked_until as locked_until',
    ])
    .where('local_login.org_id', '=', ctx.orgId);
}

async function findOne(
  executor: SqlExecutor,
  query: Compilable,
): Promise<LocalLoginSnapshot | null> {
  const [row] = await run<SnapshotRow>(executor, query);
  return row === undefined ? null : toSnapshot(row);
}

export function createLocalLoginReader(executor: SqlExecutor): LocalLoginReader {
  return {
    async findByEmail(ctx, email) {
      const normalized = normalizeEmail(email);
      if (normalized === null) return null;
      return findOne(executor, selectSnapshot(ctx).where('user_account.email', '=', normalized));
    },

    async findBySetupHash(ctx, setupHash, now) {
      const hash = setupHashOf(setupHash);
      const instant = timestamp('now', now);
      return findOne(
        executor,
        selectSnapshot(ctx)
          .where('local_login.setup_hash', '=', hash)
          .where('local_login.setup_expires_at', '>', instant),
      );
    },

    async reserveAttempt(ctx, userId, now, lockUntil): Promise<Reservation> {
      const instant = timestamp('now', now);
      const lockedUntil = timestamp('lockUntil', lockUntil);
      if (lockedUntil <= instant) {
        throw new RangeError('lockUntil must be after now');
      }
      const [row] = await run<SnapshotRow>(
        executor,
        db
          .updateTable('local_login')
          .set({
            failed_count: sql<number>`failed_count + 1`,
            locked_until: sql<
              string | null
            >`case when (failed_count + 1) % ${sql.lit(LOCK_EVERY)} = 0 then ${lockedUntil} else locked_until end`,
            updated_at: instant,
          })
          .where('local_login.org_id', '=', ctx.orgId)
          .where('local_login.user_id', '=', userId)
          .where((eb) =>
            eb.or([
              eb('local_login.locked_until', 'is', null),
              eb('local_login.locked_until', '<=', instant),
            ]),
          )
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('user_account')
                .select(sql.lit(1).as('one'))
                .whereRef('user_account.id', '=', 'local_login.user_id')
                .whereRef('user_account.org_id', '=', 'local_login.org_id'),
            ),
          )
          .returning((eb) => [
            'local_login.user_id as user_id',
            eb
              .selectFrom('user_account')
              .select('user_account.email')
              .whereRef('user_account.id', '=', 'local_login.user_id')
              .whereRef('user_account.org_id', '=', 'local_login.org_id')
              .as('email'),
            eb
              .selectFrom('user_account')
              .select(sql<number>`user_account.status = 'active'`.as('active'))
              .whereRef('user_account.id', '=', 'local_login.user_id')
              .whereRef('user_account.org_id', '=', 'local_login.org_id')
              .as('user_active'),
            adminEligibleOf(ctx),
            'local_login.password_hash as password_hash',
            'local_login.totp_credential_id as totp_credential_id',
            sql<number>`local_login.totp_enabled_at is not null`.as('totp_enabled'),
            'local_login.totp_last_step as totp_last_step',
            'local_login.credential_rev as credential_rev',
            'local_login.failed_count as failed_count',
            'local_login.locked_until as locked_until',
          ]),
      );
      if (row !== undefined) return { reserved: true, snapshot: toSnapshot(row) };

      const existing = await run<{ one: number }>(
        executor,
        db
          .selectFrom('local_login')
          .innerJoin('user_account', (join) =>
            join
              .onRef('user_account.id', '=', 'local_login.user_id')
              .onRef('user_account.org_id', '=', 'local_login.org_id'),
          )
          .select(sql<number>`1`.as('one'))
          .where('local_login.org_id', '=', ctx.orgId)
          .where('local_login.user_id', '=', userId),
      );
      return { reserved: false, reason: existing.length === 0 ? 'missing' : 'locked' };
    },
  };
}
