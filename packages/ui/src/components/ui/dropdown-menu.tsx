import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils.js';

export function DropdownMenu({ className, onKeyDown, ...props }: ComponentProps<'details'>) {
  return (
    <details
      className={cn('relative', className)}
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          event.key === 'Escape' &&
          event.currentTarget.open &&
          event.currentTarget.contains(event.target as Node)
        ) {
          // A cancelled Escape keydown is not turned into a close request for the enclosing modal dialog.
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
    />
  );
}

export function DropdownMenuTrigger({ className, ...props }: ComponentProps<'summary'>) {
  return (
    <summary
      className={cn(
        'cursor-pointer rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'absolute right-0 top-full z-50 mt-1 min-w-32 rounded-md border border-neutral-200 bg-white p-1 text-neutral-900 shadow-md',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuItem({ className, onClick, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          const details = event.currentTarget.closest('details');
          if (details) details.open = false;
        }
      }}
    />
  );
}
