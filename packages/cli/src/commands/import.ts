import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { isUlid } from '@package-broker/core/ids';
import { isCanonicalUrl } from '@package-broker/core/import/source-config';
import type { CredentialKind } from '@package-broker/core/sources/credentials';
import {
  brokerOrigin,
  ImportClient,
  ImportClientError,
  importManifest,
  localError,
  object,
  timestamp,
  type CredentialBinding,
  type CredentialResolver,
  type RunStatus,
  uploadsAccepted,
} from '../import/client.js';

export interface ImportOptions {
  readonly command: 'submit' | 'status' | 'credentials' | 'verify' | 'accept';
  readonly broker: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly run?: string;
  readonly manifest?: string;
  readonly credentials?: string;
  readonly receipt?: string;
  readonly principal?: string;
  readonly resume?: boolean;
  readonly tokenFile?: string;
  readonly waitSeconds?: number;
  readonly fetch?: typeof fetch;
  readonly resolve?: CredentialResolver;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

async function readLocal(path: string, maxBytes: number): Promise<string> {
  try {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error();
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const result = await file.read(buffer, size, buffer.length - size, null);
        if (result.bytesRead === 0) break;
        size += result.bytesRead;
      }
      if (size > maxBytes) throw new Error();
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    } finally {
      await file.close();
    }
  } catch {
    throw localError('input_unreadable', 'Could not read a local input within its size limit.');
  }
}

export function localResolver(env: ImportOptions['env']): CredentialResolver {
  return async (reference) => {
    if (reference === 'env:PB_IMPORT_TOKEN')
      throw localError(
        'invalid_credential_ref',
        'The broker token cannot be used as a source credential.',
      );
    if (/^env:[A-Z_][A-Z0-9_]{0,127}$/.test(reference)) {
      const value = env[reference.slice(4)];
      if (value !== undefined) return value;
    }
    if (
      reference.startsWith('file:') &&
      reference.length > 5 &&
      Buffer.byteLength(reference.slice(5)) <= 1024 &&
      !/\p{Cc}/u.test(reference)
    )
      return readLocal(reference.slice(5), 16384);
    throw localError('credential_resolution_failed', 'Could not resolve credential material.');
  };
}

const KINDS: readonly CredentialKind[] = [
  'http_basic',
  'bearer',
  'header',
  'query',
  'github_app',
  'npm_token',
  'ssh_key',
];
const strictKeys = (obj: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(obj).every((key) => keys.includes(key));
function identity(value: string): string {
  const url = new URL(value);
  return url.hostname === 'github.com'
    ? `${url.origin}${url.pathname
        .replace(/\/$/, '')
        .replace(/\.git$/, '')
        .toLowerCase()}`
    : value;
}

export function credentialBindings(
  text: string,
  manifest: Awaited<ReturnType<typeof importManifest>>['manifest'],
): CredentialBinding[] {
  const invalid = () =>
    localError(
      'invalid_credential_map',
      'Use explicit source references, matching credential references and supported kinds.',
    );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!object(raw) || raw.version !== 1) throw invalid();
  const result: CredentialBinding[] = [];
  if (strictKeys(raw, ['version', 'sources']) && Array.isArray(raw.sources)) {
    for (const entry of raw.sources as unknown[]) {
      if (
        !object(entry) ||
        !strictKeys(entry, ['external_ref', 'credential_ref', 'kind']) ||
        typeof entry.external_ref !== 'string' ||
        typeof entry.credential_ref !== 'string' ||
        !KINDS.includes(entry.kind as CredentialKind)
      )
        throw invalid();
      result.push({
        external_ref: entry.external_ref,
        credential_ref: entry.credential_ref,
        kind: entry.kind as CredentialKind,
      });
    }
    return result;
  }
  // The planner's repository map is an adapter; the transport only sees external refs.
  if (
    manifest.source_system !== 'satis' ||
    !strictKeys(raw, ['version', 'repositories']) ||
    !Array.isArray(raw.repositories)
  )
    throw invalid();
  const seen = new Set<string>();
  for (const entry of raw.repositories as unknown[]) {
    if (
      !object(entry) ||
      !strictKeys(entry, ['url', 'kind', 'ref']) ||
      typeof entry.url !== 'string' ||
      !isCanonicalUrl(entry.url) ||
      typeof entry.ref !== 'string' ||
      !KINDS.includes(entry.kind as CredentialKind)
    )
      throw invalid();
    const key = identity(entry.url);
    if (seen.has(key)) throw invalid();
    seen.add(key);
    for (const item of manifest.items) {
      if (item.type !== 'source' || item.credential_ref === null) continue;
      const repository = 'repository' in item.config ? item.config.repository : null;
      const target =
        item.url ??
        (typeof repository === 'string'
          ? repository.startsWith('https://')
            ? repository
            : `https://github.com/${repository}`
          : null);
      if (target !== null && identity(target) === key) {
        if (item.credential_ref !== entry.ref) throw invalid();
        result.push({
          external_ref: item.external_ref,
          credential_ref: entry.ref,
          kind: entry.kind as CredentialKind,
        });
      }
    }
  }
  return result;
}

interface Receipt {
  readonly version: 1;
  readonly origin: string;
  readonly hash: string;
  readonly key: string;
  readonly principal: string;
  readonly tokenFingerprint?: string;
  readonly attemptedAt: string;
  readonly run: string | null;
}
async function writeReceipt(path: string, receipt: Receipt, fresh: boolean): Promise<void> {
  const target = fresh ? path : `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(target, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(receipt));
      await file.sync();
    } finally {
      await file.close();
    }
    if (!fresh) await rename(target, path);
  } catch {
    throw localError(
      'receipt_unwritable',
      'Could not save receipt; use --resume for an existing receipt.',
    );
  } finally {
    if (!fresh) await unlink(target).catch(() => undefined);
  }
}

async function submit(
  options: ImportOptions,
  client: ImportClient,
  token: string,
): Promise<number> {
  const tokenFingerprint = createHash('sha256').update(token).digest('hex');
  if (
    !options.manifest ||
    !options.receipt ||
    !options.principal ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(options.principal)
  )
    throw localError(
      'invalid_input',
      'Submit requires --manifest, --receipt and a non-secret --principal label.',
    );
  const plan = await importManifest(await readLocal(options.manifest, 1048576));
  if (plan.manifest.items.length === 0) throw localError('no_changes', 'No changes to submit.');
  const now = (options.now ?? Date.now)();
  let receipt: Receipt;
  if (options.resume) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readLocal(options.receipt, 4096));
    } catch {
      throw localError('invalid_receipt', 'Could not read a valid submit receipt.');
    }
    if (
      !object(raw) ||
      !strictKeys(raw, [
        'version',
        'origin',
        'hash',
        'key',
        'principal',
        'tokenFingerprint',
        'attemptedAt',
        'run',
      ]) ||
      raw.version !== 1 ||
      raw.origin !== client.origin ||
      raw.hash !== plan.hash ||
      raw.principal !== options.principal ||
      !(
        raw.tokenFingerprint === undefined ||
        (typeof raw.tokenFingerprint === 'string' && /^[a-f0-9]{64}$/.test(raw.tokenFingerprint))
      ) ||
      typeof raw.key !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(raw.key) ||
      !timestamp(raw.attemptedAt) ||
      !(raw.run === null || (typeof raw.run === 'string' && isUlid(raw.run)))
    )
      throw localError(
        'receipt_mismatch',
        'Receipt does not match this origin, principal label or manifest.',
      );
    receipt = raw as unknown as Receipt;
    if (receipt.run !== null) {
      const status = await client.status(receipt.run);
      if (status.planHash !== plan.hash)
        throw localError('plan_hash_mismatch', 'The receipt run does not match the manifest.');
      printStatus(status, now);
      return failed(status) ? 1 : 0;
    }
    if (receipt.tokenFingerprint !== tokenFingerprint)
      throw localError(
        'receipt_mismatch',
        'Receipt does not match this authentication token; reconcile the run in the UI.',
      );
    const age = now - Date.parse(receipt.attemptedAt);
    if (age < 0 || age >= 86400000 - 3600000)
      throw new ImportClientError(
        'outcome_unknown',
        6,
        'Submit replay window expired; reconcile the run in the UI.',
      );
  } else {
    receipt = {
      version: 1,
      origin: client.origin,
      hash: plan.hash,
      key: randomUUID(),
      principal: options.principal,
      tokenFingerprint,
      attemptedAt: new Date(now).toISOString(),
      run: null,
    };
    await writeReceipt(options.receipt, receipt, true);
  }
  const result = await client.submit(plan.canonical, receipt.key);
  if (result.planHash !== plan.hash)
    throw new ImportClientError(
      'outcome_unknown',
      6,
      'Broker plan hash differs; reconcile the run in the UI.',
    );
  try {
    await writeReceipt(options.receipt, { ...receipt, run: result.id }, false);
  } catch {
    throw new ImportClientError(
      'receipt_unwritable',
      6,
      'Run created but receipt could not be saved; reconcile in the UI before retrying.',
    );
  }
  if (result.replayed) {
    const status = await client.status(result.id);
    if (status.planHash !== plan.hash)
      throw localError('plan_hash_mismatch', 'The receipt run does not match the manifest.');
    printStatus(status, (options.now ?? Date.now)());
    return failed(status) ? 1 : 0;
  } else {
    console.log(`${result.id}: planned. Review, approve and apply in the UI at ${client.origin}.`);
  }
  return 0;
}

function printStatus(status: RunStatus, nowMs: number): void {
  const bound = status.credentials.filter((entry) => entry.bound).length;
  const credentials =
    status.credentials.length === 0
      ? ''
      : `; credentials=${bound}/${status.credentials.length} bound${uploadsAccepted(status, nowMs) ? `, upload until ${status.credentialWindowUntil}` : ''}`;
  console.log(
    `${status.id}: ${status.state}; approved=${status.approvedAt ?? 'pending'}; accepted=${status.acceptedAt ?? 'pending'}${credentials}`,
  );
}
function failed(status: RunStatus): boolean {
  return ['failed', 'rolled_back', 'cancelled'].includes(status.state);
}

export async function runImport(options: ImportOptions): Promise<number> {
  try {
    brokerOrigin(options.broker);
    const envToken = options.env['PB_IMPORT_TOKEN'];
    if (options.tokenFile !== undefined && envToken !== undefined)
      throw localError('ambiguous_token', 'Use either PB_IMPORT_TOKEN or --token-file.');
    const token =
      options.tokenFile === undefined
        ? envToken
        : (await readLocal(options.tokenFile, 4096)).trim();
    const client = new ImportClient({
      broker: options.broker,
      token: token ?? '',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (options.command === 'submit') return await submit(options, client, token!);
    if (!options.run) throw localError('invalid_run', 'Supply an import run ID.');
    if (options.command === 'credentials') {
      if (!options.manifest || !options.credentials)
        throw localError('invalid_input', 'Credentials requires --manifest and --credentials.');
      const plan = await importManifest(await readLocal(options.manifest, 1048576));
      const bindings = credentialBindings(
        await readLocal(options.credentials, 8 * 1048576),
        plan.manifest,
      );
      const result = await client.credentials(
        options.run,
        plan.manifest,
        bindings,
        options.resolve ?? localResolver(options.env),
      );
      console.log(
        `Uploaded credentials for ${result.uploaded} source entries; ${result.skipped} already bound.`,
      );
      return 0;
    }
    const wait = options.waitSeconds ?? 0;
    if (!Number.isInteger(wait) || wait < 0 || wait > 300)
      throw localError('invalid_wait', 'Use --wait-seconds between 0 and 300.');
    const now = options.now ?? Date.now;
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + wait * 1000;
    let reads = 0;
    const readStatus = async (): Promise<RunStatus> => {
      while (true) {
        if (wait > 0 && reads++ > wait)
          throw new ImportClientError('wait_timeout', 3, 'Import status wait timed out.');
        try {
          return await client.status(options.run!, wait > 0 ? deadline : undefined);
        } catch (error) {
          if (!(error instanceof ImportClientError) || error.code !== 'rate_limited' || wait === 0)
            throw error;
          const delay = error.retryAfterMs ?? 1000;
          if (delay > 30000 || now() + delay >= deadline)
            throw new ImportClientError('wait_timeout', 3, 'Import status wait timed out.');
          await sleep(delay);
        }
      }
    };
    if (options.command === 'verify')
      await client.verify(options.run, wait > 0 ? deadline : undefined);
    let status = await readStatus();
    const pending = () =>
      options.command === 'accept'
        ? status.acceptedAt === null
        : options.command === 'verify'
          ? status.state !== 'verified'
          : ['planned', 'applying', 'verifying'].includes(status.state);
    // The iteration bound also limits waits when a test clock or system clock stops advancing.
    for (
      let i = 0;
      i < wait && pending() && !failed(status) && (options.now ?? Date.now)() < deadline;
      i++
    ) {
      await sleep(Math.min(1000, Math.max(0, deadline - now())));
      status = await readStatus();
    }
    printStatus(status, now());
    if (failed(status)) return 1;
    if (options.command === 'accept' && status.acceptedAt === null) {
      console.log(`Accept run ${status.id} in the UI at ${client.origin}.`);
      return 3;
    }
    return pending() && (wait > 0 || options.command === 'verify') ? 3 : 0;
  } catch (error) {
    if (error instanceof ImportClientError) {
      console.error(`${error.code}: ${error.message}`);
      return error.exitCode;
    }
    console.error('import_failed: Import command failed.');
    return 1;
  }
}
