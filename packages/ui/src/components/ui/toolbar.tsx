import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './button.js';
import { Input } from './input.js';
import { Label } from './label.js';
import { Select } from './select.js';
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
  const [open, setOpen] = useState(() =>
    typeof window === 'undefined' || !window.matchMedia
      ? true
      : window.matchMedia('(min-width: 768px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const change = () => setOpen(media.matches);
    change();
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return (
    <div className="my-4">
      <details
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
        className="filter-toolbar"
      >
        <summary className="w-full cursor-pointer p-3 text-left font-medium md:hidden">
          Filters{chips.length ? ` (${chips.length})` : ''} <span aria-hidden="true">⌄</span>
        </summary>
        <div data-panel>{children}</div>
      </details>
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

export function LoadedListFilters<K extends string>({
  values,
  fields,
  onChange,
}: {
  values: Record<K, string>;
  fields: readonly { key: K; label: string; options?: readonly string[] }[];
  onChange: (values: Record<K, string>) => void;
}) {
  return (
    <FilterToolbar
      chips={fields
        .filter(({ key }) => values[key])
        .map(({ key, label }) => ({
          label,
          value: values[key],
          onRemove: () => onChange({ ...values, [key]: '' }),
        }))}
    >
      <form
        className="my-4"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const next = { ...values };
          for (const { key } of fields) next[key] = String(data.get(key) ?? '');
          onChange(next);
        }}
      >
        {fields.map(({ key, label, options }) => (
          <div key={`${key}:${values[key]}`}>
            <Label className="grid gap-1">
              {label}
              {options ? (
                <Select name={key} defaultValue={values[key]}>
                  <option value="">All</option>
                  {options.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input type="search" name={key} defaultValue={values[key]} />
              )}
            </Label>
          </div>
        ))}
        <Button type="submit">Apply filters</Button>
        <Button
          type="button"
          variant="outline"
          onClick={(event) => {
            event.currentTarget.form?.reset();
            const next = { ...values };
            for (const { key } of fields) next[key] = '';
            onChange(next);
          }}
        >
          Clear filters
        </Button>
      </form>
    </FilterToolbar>
  );
}
