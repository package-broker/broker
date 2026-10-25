import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { PackagistApi, PackagistError } from '../import/private-packagist/api.js';
import { fetchSnapshot, writeSnapshot } from '../import/private-packagist/snapshot.js';

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
      if (!info.isFile() || (info.mode & 0o177) !== 0 || info.size > 4096)
        throw new PackagistError('credential_file');
      const bytes = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const value = bytes.subarray(0, bytesRead).toString('utf8').trim();
      if (bytesRead > 4096 || !value || /[\r\n]/.test(value))
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
      ['packagist_request', 'packagist_auth', 'clock_skew', 'redirect_refused'].includes(error.code)
      ? 1
      : 2;
  }
}
