import { dirname, resolve } from 'node:path';
import { ORG_SLUG_PATTERN } from '@package-broker/core/db/organization';
import { DbError } from '@package-broker/core/db/errors';
import { isoTimestamp, systemClock, ulid } from '@package-broker/core/ids';
import { MigrationLockedError } from '@package-broker/db-sqlite/migrations/lock';
import {
  migrate,
  MigrationChecksumError,
  type MigrateResult,
} from '@package-broker/db-sqlite/migrations/runner';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import {
  assertPrebuiltConfiguration,
  materializePrebuilt,
  prebuiltEnvelope,
  removePrebuilt,
} from '../prebuilt.js';
import { createD1HttpExecutor } from '../cloudflare/d1-http-executor.js';
import { redact } from '../cloudflare/d1-http-response.js';
import {
  BuiltManifestError,
  LegacyRouteTableError,
  loadBuiltMigrations,
  builtRouteProblems,
} from './built-manifest.js';
import {
  CloudflareError,
  cloudflareCredentials,
  commandEnvelope,
  failCommand,
  type CommandEnvelope,
} from './cloudflare/api.js';

import {
  InventoryStore,
  InventoryTransaction,
  installIdentity,
  type Inventory,
  type Jurisdiction,
} from './cloudflare/inventory.js';

type Env = Readonly<Record<string, string | undefined>>;

interface CloudflareOptions {
  readonly databaseId: string;
  readonly env: Env;
  readonly fetch?: typeof fetch;
}

export function safeCloudflareDiagnostic(error: unknown, secrets: readonly string[]): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  const text =
    typeof name === 'string' && typeof message === 'string'
      ? `${name}: ${message}`
      : `Error: ${String(error)}`;
  return redact(text, secrets)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]');
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_SHAPE = /^[0-9a-f]{32}$/;
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;
const LOCK_TTL_SECONDS = 600;
const MIGRATION_TIMEOUT_MS = 300_000;
const RESPONSE_READ_FAILED = 'd1 http response read failed';

function migrationTimeoutMs(env: Env): number {
  const configured = env.PB_D1_MIGRATION_TIMEOUT_MS;
  if (configured === undefined) return MIGRATION_TIMEOUT_MS;
  const timeout = Number(configured);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) {
    throw new CloudflareError('invalid_input', 2, false, 'migrate');
  }
  return timeout;
}

function outcomeUnknown(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof DbError && current.message === RESPONSE_READ_FAILED) return true;
    current = current.cause;
  }
  return false;
}

function credentials(
  o: CloudflareOptions,
  reportError: (error: unknown, secrets: readonly string[]) => void,
): { apiToken: string; accountId: string } | null {
  const apiToken = o.env.CLOUDFLARE_API_TOKEN;
  const accountId = o.env.CLOUDFLARE_ACCOUNT_ID;
  const secrets = [apiToken ?? '', accountId ?? ''];
  if (apiToken === undefined || apiToken === '') {
    reportError(new Error('CLOUDFLARE_API_TOKEN is required'), secrets);
    return null;
  }
  if (accountId === undefined || accountId === '') {
    reportError(new Error('CLOUDFLARE_ACCOUNT_ID is required'), secrets);
    return null;
  }
  if (!TOKEN_SHAPE.test(apiToken)) {
    reportError(
      new TypeError('CLOUDFLARE_API_TOKEN must be visible ASCII without whitespace'),
      secrets,
    );
    return null;
  }
  if (!ACCOUNT_ID_SHAPE.test(accountId)) {
    reportError(
      new TypeError('CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hex characters'),
      secrets,
    );
    return null;
  }
  if (!UUID_SHAPE.test(o.databaseId)) {
    reportError(new TypeError('--database-id must be a UUID'), secrets);
    return null;
  }
  return { apiToken, accountId };
}

function executorFor(
  o: CloudflareOptions,
  credentials: { apiToken: string; accountId: string },
  timeoutMs?: number,
): ReturnType<typeof createD1HttpExecutor> {
  return createD1HttpExecutor({
    accountId: credentials.accountId,
    databaseId: o.databaseId,
    apiToken: credentials.apiToken,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
}

export interface CloudflareOperationResult<T> {
  exitCode: number;
  value: T | null;
  output: CommandEnvelope;
  diagnostics: string[];
}
export interface CloudflareMigrateOptions {
  prebuilt?: boolean;
  databaseId?: string;
  workerName?: string;
  configPath?: string;
  inventory?: string;
  environment?: string;
  deploymentId?: string;
  runIdentity?: string;
  transaction?: InventoryTransaction;
  jurisdiction?: Jurisdiction;
  outDir?: string;
  dryRun: boolean;
  env: Env;
  fetch?: typeof fetch;
  json?: boolean;
  allowContract?: readonly string[];
  verifyOnly?: boolean;
  onBeforeApply?: Parameters<typeof migrate>[2]['onBeforeApply'];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  diagnostic?: (message: string) => void;
  legacyDiagnostics?: boolean;
}

export async function migrateCloudflare(
  o: CloudflareMigrateOptions,
  operations: { materializePrebuilt?: typeof materializePrebuilt } = {},
): Promise<CloudflareOperationResult<MigrateResult>> {
  const diagnostics: string[] = [];
  const emit = (message: string) => {
    diagnostics.push(message);
    try {
      const delivered: unknown = o.diagnostic?.(message);
      if (typeof (delivered as { then?: unknown } | undefined)?.then === 'function')
        void Promise.resolve(delivered).catch(() => undefined);
    } catch {
      // Diagnostic delivery must not change the operation or its cleanup.
    }
  };
  const report = (error: unknown, secrets: readonly string[]) => {
    emit(
      o.legacyDiagnostics
        ? safeCloudflareDiagnostic(error, secrets)
        : 'migration_failed: inspect the typed error and migration state',
    );
  };
  const output = commandEnvelope('migrate', o.dryRun);
  const result: CloudflareOperationResult<MigrateResult> = {
    exitCode: 1,
    value: null,
    output,
    diagnostics,
  };
  const finish = (
    exitCode: number,
    value: MigrateResult | null = null,
  ): CloudflareOperationResult<MigrateResult> => {
    if (value) {
      output.migrations_applied = value.applied;
      output.pending_migrations = value.pending;
      output.status = o.dryRun ? 'planned' : 'ok';
    } else
      failCommand(
        output,
        new CloudflareError(
          exitCode === 2
            ? 'invalid_input'
            : exitCode === 6
              ? 'outcome_unknown'
              : 'migration_failed',
          exitCode,
          false,
          'migrate',
        ),
      );
    result.exitCode = exitCode;
    result.value = value;
    return result;
  };
  let prebuiltOut: string | undefined;
  let release: (() => Promise<void>) | undefined;
  let secrets: string[] = [o.env.CLOUDFLARE_API_TOKEN ?? '', o.env.CLOUDFLARE_ACCOUNT_ID ?? ''];
  try {
    let databaseId = o.databaseId;
    let journal: Inventory | null = null;
    let store: InventoryStore | undefined;
    const now = o.now ?? Date.now;
    const project = dirname(resolve(o.configPath ?? 'broker.config.ts'));
    let outDir = o.prebuilt
      ? resolve(project, o.outDir ?? '.pb/prebuilt/cloudflare')
      : resolve(o.outDir ?? '.pb/cloudflare');
    if (o.prebuilt) {
      await assertPrebuiltConfiguration(project, o.configPath);
      const materialized = await (operations.materializePrebuilt ?? materializePrebuilt)({
        project,
        outDir,
      });
      outDir = prebuiltOut = materialized.outDir;
      output.prebuilt = prebuiltEnvelope(materialized);
      output.artifact_sha256 = output.prebuilt.artifact_sha256;
    }
    if (o.transaction && o.workerName === undefined) throw new CloudflareError('invalid_input', 2);
    if (o.workerName !== undefined || o.inventory !== undefined) {
      if (!o.workerName) throw new CloudflareError('invalid_input', 2);
      const auth = cloudflareCredentials(o.env);
      const identity = installIdentity({
        ...auth,
        workerName: o.workerName,
        ...(o.environment === undefined ? {} : { environment: o.environment }),
        ...(o.deploymentId === undefined ? {} : { deploymentId: o.deploymentId }),
        ...(o.jurisdiction === undefined ? {} : { jurisdiction: o.jurisdiction }),
        ...(o.runIdentity === undefined ? {} : { runIdentity: o.runIdentity }),
      });
      store = await InventoryStore.create({
        project,
        outDir,
        identity,
        ...(o.inventory === undefined ? {} : { inventory: o.inventory }),
      });
      if (o.transaction) o.transaction.assertStore(store);
      else if (!o.dryRun) release = await store.lock(now());
      journal = await store.read();
      if (databaseId && journal?.resources.d1?.id && databaseId !== journal.resources.d1.id)
        throw new CloudflareError('ownership_conflict', 8, false, 'migrate');
      databaseId ??= journal?.resources.d1?.id ?? undefined;
      if (!o.dryRun && (!journal || journal.resources.d1?.state !== 'complete'))
        throw new CloudflareError('invalid_input', 2);
    }
    if (databaseId !== undefined || o.workerName === undefined) {
      if (credentials({ ...o, databaseId: databaseId ?? '' }, report) === null) return finish(2);
    }
    const sources = await loadBuiltMigrations(outDir);
    let problems: string[] | null;
    try {
      problems = await builtRouteProblems(outDir);
    } catch (error) {
      if (!(error instanceof LegacyRouteTableError)) throw error;
      emit(`error: ${error.message}`);
      return finish(2);
    }
    if (problems === null)
      emit('warning: manifest has no route table; route permissions were not checked');
    else {
      for (const problem of problems)
        emit(
          o.legacyDiagnostics
            ? `error: ${problem}`.replace(/[\r\n]+/g, ' ')
            : 'error: manifest route validation failed; run pb build again',
        );
      if (problems.length > 0) return finish(2);
    }
    if (databaseId === undefined && o.dryRun && o.workerName !== undefined) {
      const result = finish(0, {
        applied: [],
        skipped: [],
        unknown: [],
        pending: sources.map((s) => s.id),
      });
      result.output.remote_state = 'absent';
      result.output.plan.push({ stage: 'migrate', action: 'remote_state_absent' });
      return result;
    }
    const execution = { ...o, databaseId: databaseId ?? '' };
    const auth = credentials(execution, report);
    if (auth === null) return finish(2);
    output.database_id = execution.databaseId;
    output.remote_state = 'present';
    secrets = [auth.apiToken, auth.accountId];
    const save = async () => {
      if (journal && store) {
        journal.revision++;
        journal.updated_at = new Date(now()).toISOString();
        await store.write(journal);
      }
    };
    const holder = ulid();
    const executor = executorFor(execution, auth, migrationTimeoutMs(o.env));
    if (!o.dryRun) emit(`lock holder ${holder}`);
    const contractAllowlist = o.allowContract ?? (store !== undefined || o.json ? [] : undefined);
    if (!o.dryRun && contractAllowlist !== undefined) {
      const plan = await migrate(executor, sources, { holder, dryRun: true });
      if (
        sources.some(
          (s) =>
            s.phase === 'contract' &&
            plan.pending.includes(s.id) &&
            !contractAllowlist.includes(s.id),
        )
      )
        throw new CloudflareError('configuration_conflict', 11, false, 'migrate');
    }
    const result = await migrate(executor, sources, {
      holder,
      dryRun: o.dryRun || o.verifyOnly === true,
      lockTtlSeconds: LOCK_TTL_SECONDS,
      ...(o.now === undefined ? {} : { now: o.now }),
      ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
      onBeforeApply: async (source) => {
        if (
          contractAllowlist !== undefined &&
          source.phase === 'contract' &&
          !contractAllowlist.includes(source.id)
        )
          throw new CloudflareError('configuration_conflict', 11, false, 'migrate');
        if (source.phase === 'contract' && journal) {
          journal.migrations.rollback_compatible = false;
          if (!journal.migrations.contract_ids.includes(source.id))
            journal.migrations.contract_ids.push(source.id);
          await save();
        }
        await o.onBeforeApply?.(source);
      },
      log: (event) => {
        if (event.level !== 'info')
          emit(
            o.legacyDiagnostics
              ? redact(`${event.level}: ${event.message}`.replace(/[\r\n]+/g, ' '), secrets)
              : 'warn: migration warning; inspect migration state and lock expiry before continuing',
          );
      },
    });
    if (o.verifyOnly && (result.pending.length || result.unknown.length))
      throw new CloudflareError('configuration_conflict', 11, false, 'migrate');
    if (!o.dryRun && journal) {
      journal.migrations.applied_this_transaction = o.transaction
        ? o.transaction.recordAppliedMigrations(result.applied)
        : result.applied;
      const applied = new Set([...result.applied, ...result.skipped]);
      journal.migrations.ledger = sources
        .filter((s) => applied.has(s.id))
        .map(({ id, checksum, phase }) => ({ id, checksum, phase }));
      await save();
    }
    return finish(0, result);
  } catch (error) {
    report(error, secrets);
    if (outcomeUnknown(error)) {
      emit(
        `outcome unknown: the change may have been applied; re-run pb cloudflare migrate to read the recorded state; if the re-run reports the lock held by the holder printed above, it expires ${LOCK_TTL_SECONDS / 60} minutes after the last applied migration; wait and run migrate again`,
      );
      return finish(6);
    }
    if (error instanceof CloudflareError) {
      const result = finish(error.exitCode);
      failCommand(
        result.output,
        error.stage === 'prebuilt'
          ? error
          : new CloudflareError(
              error.code,
              error.exitCode,
              error.retryable,
              'migrate',
              error.status,
              error.check,
            ),
      );
      return result;
    }
    if (
      error instanceof MigrationChecksumError ||
      (error instanceof BuiltManifestError &&
        /checksum does not match the file/.test(error.message))
    )
      return finish(3);
    if (
      error instanceof MigrationLockedError ||
      (error instanceof DbError && error.kind === 'busy')
    )
      return finish(4);
    if (error instanceof BuiltManifestError && (o.json || o.workerName !== undefined))
      return finish(2);
    return finish(1);
  } finally {
    if (prebuiltOut) await removePrebuilt(prebuiltOut).catch(() => undefined);
    if (release) {
      try {
        await release();
      } catch {
        const error = new CloudflareError('install_locked', 4, false, 'migrate');
        result.exitCode = failCommand(output, error).exitCode;
      }
    }
  }
}
export async function runCloudflareMigrate(o: CloudflareMigrateOptions): Promise<number> {
  const result = await migrateCloudflare({
    ...o,
    legacyDiagnostics: !o.json,
    ...(!o.json ? { diagnostic: o.diagnostic ?? ((message) => console.error(message)) } : {}),
  });
  // JSON callers only receive fixed safe diagnostics; legacy output stays compatible.
  if (o.json) console.log(JSON.stringify(result.output));
  else {
    if (result.value) console.log(JSON.stringify(result.value));
  }
  return result.exitCode;
}

export interface CloudflareBootstrapOptions {
  databaseId: string;
  slug: string;
  name: string;
  env: Env;
  fetch?: typeof fetch;
  now?: () => number;
  legacyDiagnostics?: boolean;
}
type OrganizationResult = Awaited<
  ReturnType<ReturnType<typeof createOrganizationBootstrap>['bootstrap']>
>;
export async function bootstrapCloudflare(
  o: CloudflareBootstrapOptions,
): Promise<CloudflareOperationResult<OrganizationResult>> {
  const diagnostics: string[] = [];
  const report = (error: unknown, secrets: readonly string[]) => {
    diagnostics.push(
      o.legacyDiagnostics
        ? safeCloudflareDiagnostic(error, secrets)
        : 'org_bootstrap_failed: inspect the typed error',
    );
  };
  const output = commandEnvelope('bootstrap');
  const finish = (
    exitCode: number,
    value: OrganizationResult | null = null,
  ): CloudflareOperationResult<OrganizationResult> => {
    if (exitCode)
      failCommand(
        output,
        new CloudflareError(
          exitCode === 5
            ? 'organization_slug_mismatch'
            : exitCode === 6
              ? 'outcome_unknown'
              : exitCode === 2
                ? 'invalid_input'
                : 'provider_failure',
          exitCode,
          false,
          'org_bootstrap',
        ),
      );
    return { exitCode, value, output, diagnostics };
  };
  const auth = credentials(o, report);
  if (auth === null) return finish(2);
  output.database_id = o.databaseId;
  const secrets = [auth.apiToken, auth.accountId];
  if (!ORG_SLUG_PATTERN.test(o.slug)) {
    report(new TypeError(`invalid organization slug ${JSON.stringify(o.slug)}`), secrets);
    return finish(2);
  }
  try {
    const result = await createOrganizationBootstrap(executorFor(o, auth)).bootstrap({
      id: ulid(),
      slug: o.slug,
      name: o.name,
      now: isoTimestamp(o.now === undefined ? systemClock.now() : new Date(o.now())),
    });
    if (!result.created && result.slug !== o.slug) {
      report(
        Object.assign(new Error(`organization already bootstrapped as ${result.slug}`), {
          name: 'AlreadyBootstrapped',
        }),
        secrets,
      );
      return finish(5, result);
    }
    return finish(0, result);
  } catch (error) {
    report(error, secrets);
    if (outcomeUnknown(error)) {
      diagnostics.push(
        'outcome unknown: the change may have been applied; re-run pb cloudflare bootstrap; it is idempotent',
      );
      return finish(6);
    }
    return finish(1);
  }
}
export async function runCloudflareBootstrap(o: CloudflareBootstrapOptions): Promise<number> {
  const result = await bootstrapCloudflare({ ...o, legacyDiagnostics: true });
  for (const diagnostic of result.diagnostics) console.error(diagnostic);
  if (result.exitCode === 0 && result.value) console.log(JSON.stringify(result.value));
  return result.exitCode;
}
