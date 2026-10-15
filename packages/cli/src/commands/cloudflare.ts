import { ORG_SLUG_PATTERN } from '@package-broker/core/db/organization';
import { DbError } from '@package-broker/core/db/errors';
import { isoTimestamp, systemClock, ulid } from '@package-broker/core/ids';
import { MigrationLockedError } from '@package-broker/db-sqlite/migrations/lock';
import { migrate, MigrationChecksumError } from '@package-broker/db-sqlite/migrations/runner';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createD1HttpExecutor } from '../cloudflare/d1-http-executor.js';
import { redact } from '../cloudflare/d1-http-response.js';
import { BuiltManifestError, loadBuiltMigrations } from './built-manifest.js';

type Env = Readonly<Record<string, string | undefined>>;

interface CloudflareOptions {
  readonly databaseId: string;
  readonly env: Env;
  readonly fetch?: typeof fetch;
}

function reportError(error: unknown, secrets: readonly string[]): void {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  const text =
    typeof name === 'string' && typeof message === 'string'
      ? `${name}: ${message}`
      : `Error: ${String(error)}`;
  console.error(redact(text.replace(/[\r\n]+/g, ' '), secrets));
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_SHAPE = /^[0-9a-f]{32}$/;
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;
const LOCK_TTL_SECONDS = 600;
const RESPONSE_READ_FAILED = 'd1 http response read failed';

function outcomeUnknown(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof DbError && current.message === RESPONSE_READ_FAILED) return true;
    current = current.cause;
  }
  return false;
}

function credentials(o: CloudflareOptions): { apiToken: string; accountId: string } | null {
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
): ReturnType<typeof createD1HttpExecutor> {
  return createD1HttpExecutor({
    accountId: credentials.accountId,
    databaseId: o.databaseId,
    apiToken: credentials.apiToken,
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
}

export async function runCloudflareMigrate(o: {
  databaseId: string;
  outDir: string;
  dryRun: boolean;
  env: Env;
  fetch?: typeof fetch;
}): Promise<number> {
  const auth = credentials(o);
  if (auth === null) return 2;
  const secrets = [auth.apiToken, auth.accountId];
  try {
    const sources = await loadBuiltMigrations(o.outDir);
    const holder = ulid();
    if (!o.dryRun) console.error(`lock holder ${holder}`);
    const result = await migrate(executorFor(o, auth), sources, {
      holder,
      dryRun: o.dryRun,
      lockTtlSeconds: LOCK_TTL_SECONDS,
      log: (event) => {
        if (event.level !== 'info') {
          console.error(
            redact(`${event.level}: ${event.message}`.replace(/[\r\n]+/g, ' '), secrets),
          );
        }
      },
    });
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    reportError(error, secrets);
    if (outcomeUnknown(error)) {
      console.error(
        `outcome unknown: the change may have been applied; re-run pb cloudflare migrate to read the recorded state; if the re-run reports the lock held by the holder printed above, it expires ${LOCK_TTL_SECONDS / 60} minutes after this run started; wait and run migrate again`,
      );
      return 6;
    }
    if (
      error instanceof MigrationChecksumError ||
      (error instanceof BuiltManifestError &&
        /checksum does not match the file/.test(error.message))
    )
      return 3;
    if (
      error instanceof MigrationLockedError ||
      (error instanceof DbError && error.kind === 'busy')
    )
      return 4;
    return 1;
  }
}

export async function runCloudflareBootstrap(o: {
  databaseId: string;
  slug: string;
  name: string;
  env: Env;
  fetch?: typeof fetch;
}): Promise<number> {
  const auth = credentials(o);
  if (auth === null) return 2;
  const secrets = [auth.apiToken, auth.accountId];
  if (!ORG_SLUG_PATTERN.test(o.slug)) {
    reportError(new TypeError(`invalid organization slug ${JSON.stringify(o.slug)}`), secrets);
    return 2;
  }
  try {
    const result = await createOrganizationBootstrap(executorFor(o, auth)).bootstrap({
      id: ulid(),
      slug: o.slug,
      name: o.name,
      now: isoTimestamp(systemClock.now()),
    });
    if (!result.created && result.slug !== o.slug) {
      reportError(
        Object.assign(new Error(`organization already bootstrapped as ${result.slug}`), {
          name: 'AlreadyBootstrapped',
        }),
        secrets,
      );
      return 5;
    }
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    reportError(error, secrets);
    if (outcomeUnknown(error)) {
      console.error(
        'outcome unknown: the change may have been applied; re-run pb cloudflare bootstrap; it is idempotent',
      );
      return 6;
    }
    return 1;
  }
}
