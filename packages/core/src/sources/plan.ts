export type SkipReason =
  | 'archived'
  | 'no_manifest'
  | 'invalid_name'
  | 'npm_from_vcs_unsupported'
  | 'filtered_out'
  | 'error_451'
  | 'error_404';

export interface DiscoveryCandidate {
  readonly repository: string;
  readonly ecosystem: 'composer' | 'npm';
  readonly packageName: string;
}

export interface PlanEntry {
  readonly repository: string;
  readonly ecosystem: 'composer' | 'npm' | null;
  readonly packageName: string | null;
  readonly action: 'new' | 'existing' | 'skipped';
  readonly reason: SkipReason | null;
}
