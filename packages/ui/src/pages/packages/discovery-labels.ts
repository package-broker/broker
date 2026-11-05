import type { operations } from '../../api-types.js';

export type DiscoveryConnection =
  operations['listSourceDiscoveryConnections']['responses'][200]['content']['application/json']['items'][number];
export function connectionLabel(c: DiscoveryConnection): string {
  return `${c.sourceNames.join(', ')}${c.sourceCount > c.sourceNames.length ? ` and ${c.sourceCount - c.sourceNames.length} more sources` : ''} · Installation ${c.installationId}`;
}
export const PATTERN_HELP =
  'Use * for any name or ? for one character. The default * includes all names.';
export const PATTERN_ERROR =
  'Enter a repository name pattern of 1 to 100 letters, numbers, dots, underscores, hyphens, * or ?.';
export function validDiscoveryPattern(pattern: string): boolean {
  return /^[A-Za-z0-9._*?-]{1,100}$/.test(pattern || '*');
}

const reasons: Record<string, string> = {
  fork: 'Fork — Enable Include forks to consider this repository.',
  archived: 'Archived — Archived repositories are not imported.',
  no_manifest: 'No package manifest — Add a manifest for this ecosystem before importing.',
  invalid_name: 'Invalid package name — Correct the manifest name before importing.',
  name_public: 'Public package name — Choose a private name before importing.',
  name_public_unverified:
    'Name could not be verified — Try again when the public registry is available.',
  claim_overlap: 'Name claimed by another source — Resolve the source conflict before importing.',
  filtered_out: 'Outside the name pattern — Change the pattern to include this repository.',
  error_451: 'Repository legally unavailable (451) — This repository cannot be imported.',
  error_404: 'Repository unavailable (404) — Check the connection has access before trying again.',
  unsupported_ecosystem:
    'Unsupported ecosystem — This repository has no Composer or npm package to import.',
};
export function discoveryReason(reason: string | null | undefined) {
  return (
    reasons[reason ?? ''] ?? 'Import refused — Review the repository settings before trying again.'
  );
}
