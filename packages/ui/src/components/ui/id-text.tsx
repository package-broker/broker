import { useState } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from './button.js';

export function middleTruncate(value: string, length = 18): string {
  if (value.length <= length) return value;
  const half = Math.floor((length - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}
export function CopyButton({
  value,
  label,
  className,
  manualFallback = false,
}: {
  value: string;
  label: string;
  className?: string;
  manualFallback?: boolean;
}) {
  const [status, setStatus] = useState('');
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn('h-7 shrink-0 px-1.5', className)}
        aria-label={label}
        title={label}
        onClick={() => {
          void (async () => {
            try {
              if (!navigator.clipboard) throw new Error('Clipboard unavailable');
              await navigator.clipboard.writeText(value);
              setStatus('Copied.');
            } catch {
              setStatus('Unable to copy.');
            }
          })();
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
      <span className={manualFallback ? 'basis-full' : 'sr-only'} role="status">
        {manualFallback
          ? status === 'Copied.'
            ? 'ID copied.'
            : status === 'Unable to copy.'
              ? 'Could not copy ID. Copy the value below.'
              : ''
          : status}
      </span>
      {manualFallback && status === 'Unable to copy.' ? (
        <code className="basis-full break-all">{value}</code>
      ) : null}
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
