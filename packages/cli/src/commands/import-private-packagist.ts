import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  planPrivatePackagistImport,
  type PrivatePackagistPlanInput,
} from '../import/private-packagist/plan.js';
import { PackagistApi, PackagistError } from '../import/private-packagist/api.js';
import { fetchSnapshot, writeSnapshot } from '../import/private-packagist/snapshot.js';
import { planPrivatePackagistDates } from '../import/private-packagist/dates.js';

export interface ImportPrivatePackagistOptions {
  readonly org: string;
  readonly snapshot: string;
  readonly apiKeyFile?: string;
  readonly apiSecretFile?: string;
  readonly versions?: boolean;
  readonly requireOrgMatch?: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}

async function readCredential(path: string | undefined): Promise<string> {
  if (!path) throw new PackagistError('invalid_input');
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        typeof process.getuid !== 'function' ||
        info.uid !== process.getuid() ||
        (info.mode & 0o177) !== 0 ||
        info.size > 4096
      )
        throw new PackagistError('credential_file');
      const bytes = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const value = bytes.subarray(0, bytesRead).toString('utf8').trim();
      if (bytesRead > 4096 || value.length < 8 || /[\r\n]/.test(value))
        throw new PackagistError('credential_file');
      return value;
    } finally {
      await handle.close();
    }
  } catch {
    throw new PackagistError('credential_file');
  }
}

export async function runImportPrivatePackagistFetch(
  options: ImportPrivatePackagistOptions,
): Promise<number> {
  try {
    if (
      (options.apiKeyFile !== undefined && options.env.PP_API_KEY_FILE !== undefined) ||
      (options.apiSecretFile !== undefined && options.env.PP_API_SECRET_FILE !== undefined)
    )
      throw new PackagistError('ambiguous_credentials');
    if (!options.snapshot || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.org))
      throw new PackagistError('invalid_input');
    const key = await readCredential(options.apiKeyFile ?? options.env.PP_API_KEY_FILE);
    const secret = await readCredential(options.apiSecretFile ?? options.env.PP_API_SECRET_FILE);
    const api = new PackagistApi({
      key,
      secret,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const { snapshot, notices } = await fetchSnapshot(api, options);
    await writeSnapshot(options.snapshot, snapshot);
    for (const notice of notices) console.log(notice);
    const count = Object.values(snapshot.objects).reduce((sum, rows) => sum + rows.length, 0);
    console.log(
      `Private Packagist snapshot: ${count} objects. Confidential; delete after import acceptance.`,
    );
    return 0;
  } catch (error) {
    console.error(
      error instanceof PackagistError
        ? `${error.code}: ${error.message}`
        : 'private_packagist_fetch_failed',
    );
    return error instanceof PackagistError &&
      [
        'packagist_request',
        'packagist_auth',
        'packagist_signature',
        'clock_skew',
        'redirect_refused',
      ].includes(error.code)
      ? 1
      : 2;
  }
}

export interface ImportPrivatePackagistPlanOptions {
  readonly snapshot: string;
  readonly map: string;
  readonly out: string;
  readonly credentialsOut: string;
  readonly members?: string;
  readonly baseline?: string;
  readonly mode?: 'merge' | 'override';
  readonly includeOrgAdmins?: boolean;
  readonly runtime?: 'workers' | 'node';
  readonly packagist?: string;
  readonly compactSelection?: boolean;
  readonly compactVendors?: readonly string[];
  readonly acceptProjectWidening?: readonly string[];
  readonly quiet?: boolean;
}
class PlanFileError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
async function readPlanInput(
  path: string,
  confidential = false,
): Promise<{ text: string; readable: boolean }> {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      const readable = (info.mode & 0o044) !== 0;
      if (!info.isFile()) throw new PlanFileError('input_unreadable');
      if (confidential && readable) throw new PlanFileError('snapshot_permissions');
      const limit = 64 * 1024 * 1024;
      if (info.size > limit) throw new PlanFileError('input_too_large');
      const bytes = Buffer.alloc(info.size + 1);
      let bytesRead = 0;
      while (bytesRead <= info.size) {
        const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead !== info.size) throw new PlanFileError('input_changed');
      return { text: bytes.subarray(0, bytesRead).toString('utf8'), readable };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw error instanceof PlanFileError ? error : new PlanFileError('input_unreadable');
  }
}
async function writePlanOutputs(
  outputs: readonly { path: string; bytes: string }[],
): Promise<void> {
  const temporary: string[] = [];
  const linked: string[] = [];
  try {
    for (const output of outputs) {
      const path = join(dirname(output.path), `.pb-plan-${randomUUID()}.tmp`);
      const handle = await open(path, 'wx', 0o600);
      temporary.push(path);
      try {
        await handle.writeFile(output.bytes, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const [i, output] of outputs.entries()) {
      await link(temporary[i]!, output.path);
      linked.push(output.path);
    }
  } catch (error) {
    for (const path of linked) await unlink(path).catch(() => undefined);
    throw new PlanFileError(
      (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'output_exists' : 'output_unwritable',
    );
  } finally {
    for (const path of temporary) await unlink(path).catch(() => undefined);
  }
}
export async function runImportPrivatePackagistPlan(
  options: ImportPrivatePackagistPlanOptions,
): Promise<number> {
  try {
    const inputs = [options.snapshot, options.map, options.members, options.baseline]
      .filter((p): p is string => p !== undefined)
      .map((p) => resolve(p));
    if (
      resolve(options.out) === resolve(options.credentialsOut) ||
      [options.out, options.credentialsOut].some((p) => inputs.includes(resolve(p)))
    )
      throw new PlanFileError('output_exists');
    const snapshot = await readPlanInput(options.snapshot, true);
    const map = await readPlanInput(options.map);
    const members =
      options.members === undefined ? undefined : await readPlanInput(options.members);
    const baseline =
      options.baseline === undefined ? undefined : await readPlanInput(options.baseline);
    const input: PrivatePackagistPlanInput = {
      snapshot: snapshot.text,
      map: map.text,
      options,
      ...(members === undefined ? {} : { members: members.text }),
      ...(baseline === undefined ? {} : { baseline: baseline.text }),
    };
    const result = await planPrivatePackagistImport(input);
    if (members?.readable) result.summary.warning.push({ code: 'members_permissions', count: 1 });
    if (result.ok)
      await writePlanOutputs([
        { path: options.out, bytes: result.canonical },
        { path: options.credentialsOut, bytes: result.credentialsOut },
      ]);
    const groups = [
      ['create', result.summary.create],
      ['existing', result.summary.existing],
      ['warning', result.summary.warning],
      ['needs-input', result.summary.needsInput],
      ['unsupported', result.summary.unsupported],
    ] as const;
    for (const [label, entries] of groups) {
      console.log(`${label}: ${entries.length}`);
      if (!options.quiet) for (const entry of entries) console.log(`  ${JSON.stringify(entry)}`);
    }
    if (!result.ok) {
      for (const d of result.diagnostics)
        console.error(
          `${d.code} ${d.pointer || '/'}${d.cap === undefined ? '' : ` [${d.cap}]`}${d.detail === undefined ? '' : ` ${d.detail}`}`,
        );
      return 2;
    }
    console.log(`planHash: ${result.hash}`);
    return 0;
  } catch (error) {
    console.error(error instanceof PlanFileError ? error.code : 'private_packagist_plan_failed');
    return 2;
  }
}

export interface ImportPrivatePackagistDatesOptions {
  readonly snapshot: string;
  readonly map: string;
  readonly baseline: string;
  readonly out: string;
  readonly packages?: readonly string[];
  readonly quiet?: boolean;
}

export async function runImportPrivatePackagistDates(
  options: ImportPrivatePackagistDatesOptions,
): Promise<number> {
  try {
    if (
      [options.snapshot, options.map, options.baseline].some(
        (p) => resolve(p) === resolve(options.out),
      )
    )
      throw new PlanFileError('output_exists');
    const snapshot = await readPlanInput(options.snapshot, true);
    const map = await readPlanInput(options.map);
    const baseline = await readPlanInput(options.baseline);
    const result = await planPrivatePackagistDates({
      snapshot: snapshot.text,
      map: map.text,
      baseline: baseline.text,
      ...(options.packages === undefined ? {} : { packages: options.packages }),
    });
    if (!result.ok) {
      for (const d of result.diagnostics)
        console.error(
          `${d.code} ${d.pointer || '/'}${d.cap === undefined ? '' : ` [${d.cap}]`}${d.selector === undefined ? '' : ` ${JSON.stringify(d.selector)}`}`,
        );
      if (result.diagnostics.some((d) => d.code === 'versions_missing'))
        console.error('Re-run fetch --versions.');
      return 2;
    }
    await writePlanOutputs([{ path: options.out, bytes: result.canonical }]);
    console.log(`version_override: ${result.summary.overrides}`);
    console.log(`releasedAt_missing: ${result.summary.missingReleasedAt}`);
    console.log(`planHash: ${result.hash}`);
    if (!options.quiet)
      console.log(
        'Submit this dates run after the sources are enabled and synced; the server refuses overrides for versions that do not exist.',
      );
    return 0;
  } catch (error) {
    console.error(error instanceof PlanFileError ? error.code : 'private_packagist_dates_failed');
    return 2;
  }
}
