import { useState } from 'react';
import type { DataColumn } from './table.js';

export function ReadableList<T extends { id: string }>({
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
  const [sort, setSort] = useState('');
  const [key, direction] = sort.split(':');
  const column = columns.find((entry) => entry.key === key);
  const rows = column
    ? [...items].sort((a, b) => {
        const left = column.value(a),
          right = column.value(b);
        const comparison =
          typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left).localeCompare(String(right), undefined, { numeric: true });
        return direction === 'desc' ? -comparison : comparison;
      })
    : items;
  const render = (item: T, entry: DataColumn<T>) =>
    entry.render ? entry.render(item) : entry.value(item);
  return (
    <div className="readable-list">
      <div className="flex flex-wrap items-center gap-3 py-3 text-sm">
        <label className="grid gap-1">
          Sort this page
          <select
            className="min-h-11 rounded border bg-white p-2"
            aria-label={`Sort ${label} on this page`}
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="">Original order</option>
            {columns
              .filter((entry) => entry.sortable !== false)
              .map((entry) => (
                <optgroup key={entry.key} label={entry.label}>
                  <option value={`${entry.key}:asc`}>{entry.label} ↑</option>
                  <option value={`${entry.key}:desc`}>{entry.label} ↓</option>
                </optgroup>
              ))}
          </select>
        </label>
        <span>Sorting applies to this page</span>
      </div>
      <div className="readable-desktop overflow-x-auto rounded border border-neutral-200">
        <table className="w-full table-fixed border-collapse text-left text-sm">
          <caption className="sr-only">{label}</caption>
          <thead>
            <tr>
              {columns.map((entry) => (
                <th
                  key={entry.key}
                  scope="col"
                  className="p-4"
                  aria-sort={
                    entry.sortable === false
                      ? undefined
                      : key !== entry.key
                        ? 'none'
                        : direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                  }
                >
                  {entry.sortable === false ? (
                    entry.label
                  ) : (
                    <button
                      className="min-h-11 text-left"
                      type="button"
                      onClick={() =>
                        setSort(
                          `${entry.key}:${key === entry.key && direction === 'asc' ? 'desc' : 'asc'}`,
                        )
                      }
                    >
                      {entry.label}{' '}
                      <span aria-hidden="true">
                        {key === entry.key ? (direction === 'asc' ? '↑' : '↓') : '↕'}
                      </span>
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr
                key={item.id}
                aria-selected={selectedId ? item.id === selectedId : undefined}
                className="border-t border-neutral-200 align-top"
              >
                {columns.map((entry, index) =>
                  index === 0 ? (
                    <th className="p-4 font-normal" scope="row" key={entry.key}>
                      {render(item, entry)}
                    </th>
                  ) : (
                    <td className="p-4" key={entry.key}>
                      {render(item, entry)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="readable-mobile grid gap-3" aria-label={label}>
        {rows.map((item) => (
          <li
            data-selected={selectedId ? item.id === selectedId : undefined}
            className="rounded border border-neutral-200 bg-white p-4"
            key={item.id}
          >
            <div className="mb-4">{render(item, columns[0]!)}</div>
            <dl className="grid gap-4">
              {columns.slice(1).map((entry) => (
                <div key={entry.key}>
                  <dt className="mb-1 text-sm font-semibold">{entry.label}</dt>
                  <dd>{render(item, entry)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
