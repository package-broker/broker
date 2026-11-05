import { PackageNameError, packageKey } from '../catalogue/names.js';
import type { PolicyFetch } from './policy-fetch.js';

export function isNpmClaim(pattern: string): boolean {
  const name = pattern.endsWith('/*') ? `${pattern.slice(0, -1)}a` : pattern;
  try {
    packageKey(name, { ecosystem: 'npm' });
    return true;
  } catch (error) {
    if (error instanceof PackageNameError) return false;
    throw error;
  }
}

export async function probeNpmClaim(
  fetch: PolicyFetch,
  name: string,
  signal?: AbortSignal,
): Promise<'name_public' | 'name_public_unverified' | null> {
  try {
    const response = await fetch({
      url: `https://registry.npmjs.org/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`,
      method: 'HEAD',
      purpose: 'metadata',
      destinations: ['https://registry.npmjs.org'],
      redirects: 'error',
      maxBytes: 1024,
      timeoutMs: 5000,
      ...(signal === undefined ? {} : { signal }),
    });
    await response.body?.cancel();
    if (response.status === 200) return 'name_public';
    return response.status === 404 ? null : 'name_public_unverified';
  } catch {
    return 'name_public_unverified';
  }
}
