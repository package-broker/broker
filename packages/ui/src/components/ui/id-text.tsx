import { useState } from 'react';
import { Button } from './button.js';

export function middleTruncate(value: string, length = 18): string {
  if (value.length <= length) return value;
  const half = Math.floor((length - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState('');
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-1.5"
        aria-label={label}
        title={label}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => setStatus('Copied.'),
            () => setStatus('Unable to copy.'),
          );
          if (!navigator.clipboard) setStatus('Unable to copy.');
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </Button>
      <span className="sr-only" role="status">
        {status}
      </span>
    </>
  );
}
export function IdText({
  value,
  label = 'ID',
  full = false,
}: {
  value: string | null;
  label?: string;
  full?: boolean;
}) {
  if (!value) return <span className="text-neutral-600">—</span>;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <code
        title={value}
        className={
          full ? 'min-w-0 break-all font-mono text-xs' : 'font-mono text-xs whitespace-nowrap'
        }
      >
        {full ? value : middleTruncate(value)}
      </code>
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  );
}
