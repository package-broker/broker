import {
  useId,
  type HTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
  type ReactNode,
} from 'react';
import {
  columnVisibilityFeature,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { cn } from '../../lib/utils.js';

export function Table({
  className,
  label,
  controls,
  ...props
}: HTMLAttributes<HTMLTableElement> & { label?: string; controls?: ReactNode }) {
  const hint = useId();
  return (
    <div className={label ? 'table-container' : 'relative w-full overflow-auto'}>
      {controls}
      {label ? (
        <p id={hint} className="table-hint">
          Scroll horizontally for more columns. On small screens, each row shows labelled values.
        </p>
      ) : null}
      <div
        role={label ? 'region' : undefined}
        aria-label={label}
        aria-describedby={label ? hint : undefined}
        tabIndex={label ? 0 : undefined}
        className={label ? 'table-scroll' : undefined}
      >
        <table
          className={cn('w-full caption-bottom text-sm', label && 'responsive-table', className)}
          {...props}
        />
      </div>
    </div>
  );
}
export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('[&_tr]:border-b', className)} {...props} />;
}
export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}
export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn('border-b border-neutral-200 hover:bg-neutral-50', className)} {...props} />
  );
}
export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn('h-10 px-3 text-left align-middle font-medium text-neutral-600', className)}
      {...props}
    />
  );
}
export function TableCell({
  className,
  children,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('p-3 align-middle', className)} {...props}>
      <div className="cell-value">{children}</div>
    </td>
  );
}
const features = tableFeatures({
  columnVisibilityFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});
export interface DataColumn<T> {
  key: string;
  label: string;
  value: (item: T) => string | number;
  render?: (item: T) => ReactNode;
  priority?: 2 | 3;
  sortable?: boolean;
}
export function DataTable<T extends { id: string }>({
  label,
  items,
  columns,
  selectedId,
}: {
  label: string;
  items: readonly T[];
  columns: readonly DataColumn<T>[];
  selectedId?: string;
}) {
  const table = useTable({
    features,
    data: items as T[],
    columns: columns.map((column) => ({
      id: column.key,
      accessorFn: column.value,
      sortFn: 'alphanumeric' as const,
      enableSorting: column.sortable !== false,
    })),
  });
  return (
    <div className="list-card">
      <details className="column-options">
        <summary>Columns · Sort this page</summary>
        <div className="flex flex-wrap gap-3 p-3">
          {table
            .getAllLeafColumns()
            .slice(1)
            .map((column, index) => (
              <label key={column.id} className="inline-flex items-center gap-2">
                {columns[index + 1]?.label}
                <select
                  aria-label={`${columns[index + 1]?.label} visibility`}
                  value={
                    table.state.columnVisibility[column.id] === true
                      ? 'show'
                      : table.state.columnVisibility[column.id] === false
                        ? 'hide'
                        : 'auto'
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    table.setColumnVisibility((current) => {
                      const next = { ...current };
                      if (value === 'auto') delete next[column.id];
                      else next[column.id] = value === 'show';
                      return next;
                    });
                  }}
                >
                  <option value="auto">Automatic</option>
                  <option value="show">Show</option>
                  <option value="hide">Hide</option>
                </select>
              </label>
            ))}
        </div>
      </details>
      <Table
        label={label}
        controls={
          <label className="card-sort">
            Sort this page
            <select
              aria-label={`Sort ${label} on this page`}
              value={
                table.state.sorting[0]
                  ? `${table.state.sorting[0]!.id}:${table.state.sorting[0]!.desc ? 'desc' : 'asc'}`
                  : ''
              }
              onChange={(event) => {
                const [id, direction] = event.target.value.split(':');
                table.setSorting(id ? [{ id, desc: direction === 'desc' }] : []);
              }}
            >
              <option value="">Original order</option>
              {columns
                .filter((column) => column.sortable !== false)
                .map((column) => (
                  <optgroup key={column.key} label={column.label}>
                    <option value={`${column.key}:asc`}>{column.label} ↑</option>
                    <option value={`${column.key}:desc`}>{column.label} ↓</option>
                  </optgroup>
                ))}
            </select>
          </label>
        }
      >
        <caption className="sr-only">{label}</caption>
        <TableHeader>
          <TableRow>
            {table.getHeaderGroups()[0]?.headers.map((header) => {
              const column = columns.find((entry) => entry.key === header.column.id)!;
              const sorted = header.column.getIsSorted();
              return (
                <TableHead
                  key={header.id}
                  className={column.priority ? `priority-${column.priority}` : undefined}
                  data-visibility={
                    table.state.columnVisibility[column.key] === true ? 'visible' : undefined
                  }
                  aria-sort={
                    column.sortable === false
                      ? undefined
                      : sorted === 'asc'
                        ? 'ascending'
                        : sorted === 'desc'
                          ? 'descending'
                          : 'none'
                  }
                >
                  {column.sortable === false ? (
                    column.label
                  ) : (
                    <button type="button" onClick={header.column.getToggleSortingHandler()}>
                      {column.label}{' '}
                      <span aria-hidden="true">
                        {sorted === 'asc' ? '↑' : sorted === 'desc' ? '↓' : '↕'}
                      </span>
                    </button>
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              aria-selected={selectedId ? selectedId === row.original.id : undefined}
            >
              {row.getVisibleCells().map((cell) => {
                const column = columns.find((entry) => entry.key === cell.column.id)!;
                return (
                  <TableCell
                    key={cell.id}
                    data-label={column.label}
                    data-visibility={
                      table.state.columnVisibility[column.key] === true ? 'visible' : undefined
                    }
                    className={column.priority ? `priority-${column.priority}` : undefined}
                  >
                    {column.render ? column.render(row.original) : column.value(row.original)}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
