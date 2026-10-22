import { Collapsible } from '@base-ui/react/collapsible';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './button.js';
export interface FilterChip {
  label: string;
  value: string;
  onRemove: () => void;
}
export function FilterToolbar({
  children,
  chips = [],
}: {
  children: ReactNode;
  chips?: readonly FilterChip[];
}) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const change = () => setOpen(media.matches);
    change();
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return (
    <div className="my-4">
      <Collapsible.Root open={open} onOpenChange={setOpen} className="filter-toolbar">
        <Collapsible.Trigger className="w-full p-3 text-left font-medium md:hidden">
          Filters{chips.length ? ` (${chips.length})` : ''} <span aria-hidden="true">⌄</span>
        </Collapsible.Trigger>
        <Collapsible.Panel>{children}</Collapsible.Panel>
      </Collapsible.Root>
      {chips.length ? (
        <div aria-label="Active filters" className="mt-2 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <span key={chip.label} className="filter-chip">
              <span className="min-w-0 break-all">
                {chip.label}: {chip.value}
              </span>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                aria-label={`Remove ${chip.label} filter`}
                onClick={chip.onRemove}
              >
                ×
              </Button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
