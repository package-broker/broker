import { existsSync, unlinkSync } from 'node:fs';
import { open, unlink, type FileHandle } from 'node:fs/promises';
import { randomToken, sha256Hex } from '@package-broker/core/auth/primitives';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { DbError } from '@package-broker/core/db/errors';
import { orgContext, type ScalarSqlExecutor } from '@package-broker/core/db/port';
import { isoTimestamp, systemClock, ulid } from '@package-broker/core/ids';
import {
  isReservedProviderId,
  isValidProviderId,
  isValidTrustAnchor,
} from '@package-broker/core/identity/port';
import { normalizeEmail } from '@package-broker/core/identity/policy';
import { formatMasterKey, generateMasterKey } from '@package-broker/core/secrets/master-key';
import {
  bootstrapAdmin,
  resetLocalLogin,
} from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import {
  readProviderBinding,
  rebindProvider,
} from '@package-broker/db-sqlite/repositories/provider-binding';
import { openBetterSqliteExecutor } from '@package-broker/runtime-node/db/better-sqlite3-executor';
import { createD1HttpExecutor } from '../cloudflare/d1-http-executor.js';

type Env = Readonly<Record<string, string | undefined>>;

export type AdminTarget =
  | { readonly kind: 'sqlite'; readonly file: string }
  | {
      readonly kind: 'cloudflare';
      readonly databaseId: string;
      readonly env: Env;
      readonly fetch?: typeof fetch;
    };

export interface AdminOptions {
  readonly email: string;
  readonly target: AdminTarget;
  readonly tokenFile?: string | undefined;
  readonly stdoutIsTTY?: boolean;
}

type Command =
  'admin bootstrap' | 'admin reset-local' | 'admin rebind-provider' | 'admin show-provider-binding';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
const RESPONSE_READ_FAILED = 'd1 http response read failed';
const SETUP_TOKEN_TTL_MS = 24 * 3_600_000;
const KEY_VERSION = /^[1-9][0-9]{0,8}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID_SHAPE = /^[0-9a-f]{32}$/;
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;
const NEXT = [
  'POST /_pb/auth/local/setup/start {"token"}',
  'POST /_pb/auth/local/setup/finish {"token","password","code"}',
];

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && /^\w{1,64}$/.test(name) ? name : 'Error';
}

function say(command: string, text: string): void {
  console.error(`${command}: ${text}`);
}

export async function runGenerateMasterKey(o: {
  keyVersion?: string | undefined;
}): Promise<number> {
  const command = 'secrets generate-master-key';
  const version = o.keyVersion === undefined ? 1 : Number(o.keyVersion);
  if (o.keyVersion !== undefined && !KEY_VERSION.test(o.keyVersion)) {
    say(command, 'invalid_key_version');
    return 2;
  }
  try {
    const key = formatMasterKey(generateMasterKey(version));
    console.error(
      'store this key in a secret manager and set PB_MASTER_KEY; it is not shown again',
    );
    console.log(key);
    return 0;
  } catch (error) {
    if (error instanceof RangeError) {
      say(command, 'invalid_key_version');
      return 2;
    }
    say(command, `failed (${errorName(error)})`);
    return 1;
  }
}

function cloudflareExecutor(
  command: Command,
  target: Extract<AdminTarget, { kind: 'cloudflare' }>,
): ScalarSqlExecutor | null {
  const apiToken = target.env.CLOUDFLARE_API_TOKEN;
  const accountId = target.env.CLOUDFLARE_ACCOUNT_ID;
  if (apiToken === undefined || apiToken === '') {
    say(command, 'CLOUDFLARE_API_TOKEN is required');
    return null;
  }
  if (accountId === undefined || accountId === '') {
    say(command, 'CLOUDFLARE_ACCOUNT_ID is required');
    return null;
  }
  if (!TOKEN_SHAPE.test(apiToken)) {
    say(command, 'CLOUDFLARE_API_TOKEN must be visible ASCII without whitespace');
    return null;
  }
  if (!ACCOUNT_ID_SHAPE.test(accountId)) {
    say(command, 'CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hex characters');
    return null;
  }
  if (!UUID_SHAPE.test(target.databaseId)) {
    say(command, '--database-id must be a UUID');
    return null;
  }
  return createD1HttpExecutor({
    accountId,
    databaseId: target.databaseId,
    apiToken,
    ...(target.fetch === undefined ? {} : { fetch: target.fetch }),
  });
}

interface Opened {
  readonly executor: ScalarSqlExecutor;
  close(): Promise<void>;
}

function openTarget(command: Command, target: AdminTarget): Opened | null {
  if (target.kind === 'cloudflare') {
    const executor = cloudflareExecutor(command, target);
    return executor === null ? null : { executor, close: async () => undefined };
  }
  if (!existsSync(target.file)) {
    say(command, 'sqlite_file_not_found');
    return null;
  }
  return openBetterSqliteExecutor(target.file);
}

async function createTokenFile(
  command: Command,
  path: string,
): Promise<FileHandle | 'exists' | 'failed'> {
  try {
    return await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') {
      say(command, 'token_file_exists');
      return 'exists';
    }
    say(command, `token_file_failed (${errorName(error)})`);
    return 'failed';
  }
}

function lostResponse(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof DbError && current.message === RESPONSE_READ_FAILED) return true;
    current = current.cause;
  }
  return false;
}

function roleIds(): Record<DefaultRoleKey, string> {
  const ids = {} as Record<DefaultRoleKey, string>;
  for (const { key } of DEFAULT_ROLES) ids[key] = ulid();
  return ids;
}

type Outcome =
  | { readonly issued: true; readonly result: string }
  | { readonly issued: false; readonly exit: number; readonly text: string };

async function issue(command: Command, o: AdminOptions): Promise<number> {
  const email = typeof o.email === 'string' ? normalizeEmail(o.email) : null;
  if (email === null) {
    say(command, 'invalid_email');
    return 2;
  }

  let handle: FileHandle | null = null;
  let created = false;
  let issued = false;
  let signalled = false;
  let opened: Opened | null = null;
  const onSignal = (signal: NodeJS.Signals): void => {
    signalled = true;
    if (created && o.tokenFile !== undefined) {
      try {
        unlinkSync(o.tokenFile);
      } catch {
        /* the file may already be gone */
      }
    }
    for (const name of SIGNALS) process.off(name, onSignal);
    process.kill(process.pid, signal);
  };
  if (o.tokenFile !== undefined) for (const name of SIGNALS) process.on(name, onSignal);

  try {
    if (o.tokenFile !== undefined) {
      const file = await createTokenFile(command, o.tokenFile);
      if (file === 'exists') return 2;
      if (file === 'failed') return 1;
      handle = file;
      created = true;
    }

    opened = openTarget(command, o.target);
    if (opened === null) return 2;

    const organization = await createOrganizationBootstrap(opened.executor).findSingleton();
    if (organization === null) {
      say(command, 'organization not found; run pb bootstrap or pb cloudflare bootstrap first');
      return 5;
    }

    const now = systemClock.now();
    const token = randomToken();
    const input = {
      email,
      userId: ulid(),
      setupHash: await sha256Hex(token),
      setupExpiresAt: isoTimestamp(new Date(now.getTime() + SETUP_TOKEN_TTL_MS)),
      grantId: ulid(),
      roleIds: roleIds(),
      opId: ulid(),
      now: isoTimestamp(now),
    };
    const ctx = orgContext(organization.id);

    if (handle !== null) {
      await handle.writeFile(`${token}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
    }

    const outcome = await runOperation(command, opened.executor, ctx, input);
    if (signalled) {
      say(command, 'outcome unknown; re-running is safe');
      return 7;
    }
    if (!outcome.issued) {
      say(command, outcome.text);
      return outcome.exit;
    }
    issued = true;

    if (command === 'admin bootstrap') {
      say(
        command,
        'does not check for existing administrators; it adds or refreshes this e-mail as an organization admin',
      );
    }
    const toTerminal = o.stdoutIsTTY ?? process.stdout.isTTY === true;
    if (o.tokenFile === undefined && !toTerminal) {
      say(
        command,
        'warning: the setup token is being written to a non-terminal stdout; use --token-file to keep it out of logs',
      );
    }
    console.log(
      JSON.stringify({
        result: outcome.result,
        setupToken: o.tokenFile === undefined ? token : null,
        tokenFile: o.tokenFile ?? null,
        expiresAt: input.setupExpiresAt,
        next: NEXT,
      }),
    );
    return 0;
  } catch (error) {
    if (error instanceof DbError && error.kind === 'foreign_key') {
      say(command, 'organization not found; run pb bootstrap or pb cloudflare bootstrap first');
      return 5;
    }
    if (lostResponse(error)) {
      say(command, 'outcome unknown; re-running is safe');
      return 7;
    }
    say(command, `failed (${errorName(error)})`);
    return 1;
  } finally {
    for (const name of SIGNALS) process.off(name, onSignal);
    await handle?.close().catch(() => undefined);
    if (created && !issued && o.tokenFile !== undefined)
      await unlink(o.tokenFile).catch(() => undefined);
    await opened?.close().catch(() => undefined);
  }
}

async function runOperation(
  command: Command,
  executor: ScalarSqlExecutor,
  ctx: ReturnType<typeof orgContext>,
  input: Parameters<typeof bootstrapAdmin>[2],
): Promise<Outcome> {
  if (command === 'admin bootstrap') {
    const result = await bootstrapAdmin(executor, ctx, input);
    if (result === 'already_set_up') {
      return {
        issued: false,
        exit: 6,
        text: 'already_set_up; nothing changed; run pb admin reset-local to issue a new setup token',
      };
    }
    return { issued: true, result };
  }
  const { email, setupHash, setupExpiresAt, grantId, roleIds: ids, opId, now } = input;
  const result = await resetLocalLogin(executor, ctx, {
    email,
    setupHash,
    setupExpiresAt,
    grantId,
    roleIds: ids,
    opId,
    now,
  });
  if (result === 'not_found') {
    return {
      issued: false,
      exit: 6,
      text: 'not_found; no local user with that e-mail; nothing changed',
    };
  }
  if (result === 'admin_role_missing') {
    return {
      issued: false,
      exit: 8,
      text: 'admin_role_missing; the organization has no organization_admin role; run pb admin bootstrap first',
    };
  }
  return { issued: true, result };
}

export function runAdminBootstrap(o: AdminOptions): Promise<number> {
  return issue('admin bootstrap', o);
}

export function runAdminResetLocal(o: AdminOptions): Promise<number> {
  return issue('admin reset-local', o);
}

export interface RebindProviderOptions {
  readonly provider: string;
  readonly confirm: string;
  readonly expectedAnchor: string;
  readonly newAnchor: string;
  readonly target: AdminTarget;
}

function rebindUsageError(o: RebindProviderOptions): string | null {
  if (typeof o.provider !== 'string' || o.confirm !== o.provider) return 'confirm_mismatch';
  if (!isValidProviderId(o.provider) || isReservedProviderId(o.provider)) {
    return 'invalid_provider';
  }
  for (const anchor of [o.expectedAnchor, o.newAnchor]) {
    if (typeof anchor !== 'string' || !isValidTrustAnchor(anchor)) return 'invalid_anchor';
  }
  return o.expectedAnchor === o.newAnchor ? 'anchors_equal' : null;
}

export async function runAdminRebindProvider(o: RebindProviderOptions): Promise<number> {
  const command = 'admin rebind-provider';
  const usageError = rebindUsageError(o);
  if (usageError !== null) {
    say(command, usageError);
    return 2;
  }

  let opened: Opened | null = null;
  try {
    opened = openTarget(command, o.target);
    if (opened === null) return 2;

    const organization = await createOrganizationBootstrap(opened.executor).findSingleton();
    if (organization === null) {
      say(command, 'organization not found; run pb bootstrap or pb cloudflare bootstrap first');
      return 5;
    }

    const result = await rebindProvider(
      opened.executor,
      orgContext(organization.id),
      o.provider,
      o.expectedAnchor,
      o.newAnchor,
      isoTimestamp(systemClock.now()),
    );
    if (!result.swapped) {
      say(
        command,
        'anchor_mismatch; no binding with that provider and expected anchor; nothing changed',
      );
      return 6;
    }
    console.log(
      JSON.stringify({
        provider: o.provider,
        identities: result.identities,
        sessions: result.sessions,
      }),
    );
    return 0;
  } catch (error) {
    if (lostResponse(error)) {
      say(
        command,
        'outcome unknown; the swap may have applied; a re-run that reports anchor_mismatch means it did or the anchor is wrong',
      );
      return 7;
    }
    say(command, `failed (${errorName(error)})`);
    return 1;
  } finally {
    await opened?.close().catch(() => undefined);
  }
}

export interface ShowProviderBindingOptions {
  readonly provider: string;
  readonly target: AdminTarget;
}

export async function runAdminShowProviderBinding(o: ShowProviderBindingOptions): Promise<number> {
  const command = 'admin show-provider-binding';
  if (
    typeof o.provider !== 'string' ||
    !isValidProviderId(o.provider) ||
    isReservedProviderId(o.provider)
  ) {
    say(command, 'invalid_provider');
    return 2;
  }

  let opened: Opened | null = null;
  try {
    opened = openTarget(command, o.target);
    if (opened === null) return 2;

    const organization = await createOrganizationBootstrap(opened.executor).findSingleton();
    if (organization === null) {
      say(command, 'organization not found; run pb bootstrap or pb cloudflare bootstrap first');
      return 5;
    }

    const binding = await readProviderBinding(
      opened.executor,
      orgContext(organization.id),
      o.provider,
    );
    if (binding === null) {
      say(command, 'no_binding; nothing is bound for that provider');
      return 6;
    }
    console.log(
      JSON.stringify({
        provider: o.provider,
        anchor: binding.anchor,
        createdAt: binding.createdAt,
      }),
    );
    return 0;
  } catch (error) {
    if (lostResponse(error)) {
      say(command, 'outcome unknown; re-running is safe');
      return 7;
    }
    say(command, `failed (${errorName(error)})`);
    return 1;
  } finally {
    await opened?.close().catch(() => undefined);
  }
}
