import { Badge } from './badge.js';

export const STATUS_LABELS = {
  active: 'Active',
  yanked: 'Yanked',
  quarantined: 'Quarantined',
  tombstoned: 'Tombstoned',
  removed_upstream: 'Removed upstream',
  planned: 'Planned',
  applying: 'Applying',
  failed: 'Failed',
  applied: 'Applied',
  verifying: 'Verifying',
  verified: 'Verified',
  rolled_back: 'Rolled back',
  cancelled: 'Cancelled',
} as const;
export type Status = keyof typeof STATUS_LABELS;
export const STATUS_COLORS: Record<Status, string> = {
  yanked: 'border-red-200 bg-red-50 text-red-800',
  active: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  applied: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  verified: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  quarantined: 'border-amber-300 bg-amber-50 text-amber-900',
  removed_upstream: 'border-amber-300 bg-amber-50 text-amber-900',
  applying: 'border-amber-300 bg-amber-50 text-amber-900',
  verifying: 'border-amber-300 bg-amber-50 text-amber-900',
  tombstoned: 'border-red-200 bg-red-50 text-red-800',
  failed: 'border-red-200 bg-red-50 text-red-800',
  planned: 'border-blue-200 bg-blue-50 text-blue-800',
  rolled_back: 'border-neutral-200 bg-neutral-100 text-neutral-700',
  cancelled: 'border-neutral-200 bg-neutral-100 text-neutral-700',
};
export function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant="outline" className={`w-fit whitespace-nowrap ${STATUS_COLORS[status]}`}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
