import { readFileSync } from 'node:fs';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { useTable } from '@tanstack/react-table';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from './table.js';

vi.mock('@tanstack/react-table', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-table')>();
  return { ...actual, useTable: vi.fn(actual.useTable) };
});

function control(node: ReactNode, label: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = control(child, label);
      if (found) return found;
    }
  }
  if (!isValidElement<Record<string, unknown>>(node)) return;
  if (node.props['aria-label'] === label) return node.props;
  return (
    control(node.props.children as ReactNode, label) ??
    control(node.props.controls as ReactNode, label)
  );
}

function renderTable() {
  let tree: ReactNode;
  function Capture() {
    tree = DataTable({
      label: 'Runs',
      items: [{ id: 'b' }, { id: 'a' }],
      columns: [
        { key: 'id', label: 'Run ID', value: (item) => item.id },
        { key: 'extra', label: 'Extra', priority: 3, value: (item) => item.id },
        { key: 'actions', label: 'Actions', value: () => '', sortable: false },
      ],
    });
    return tree;
  }
  const html = renderToString(createElement(Capture));
  const table = vi.mocked(useTable).mock.results.at(-1)!.value;
  return {
    html,
    table,
    change(label: string, value: string) {
      const props = control(tree, label);
      expect(props, label).toBeDefined();
      (props!.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    },
    rerender() {
      vi.mocked(useTable).mockReturnValueOnce({ ...table, state: table.store.get() });
      return renderToString(createElement(Capture));
    },
  };
}

describe('responsive table controls', () => {
  it('keys rows and their editable cells by source identity', () => {
    const view = renderTable();
    expect(view.table.getRowModel().rows.map((row: { id: string }) => row.id)).toEqual(['b', 'a']);
    view.change('Sort Runs on this page', 'id:asc');
    expect(view.table.getRowModel().rows.map((row: { id: string }) => row.id)).toEqual(['a', 'b']);
  });
  it('can explicitly show a responsive priority column, hide it, and restore automatic visibility', () => {
    const view = renderTable();
    expect(view.html).toContain('aria-label="Sort Runs on this page"');
    view.change('Extra visibility', 'show');
    expect(view.table.getColumn('extra').getIsVisible()).toBe(true);
    expect(view.rerender()).toMatch(/<td[^>]*data-label="Extra"[^>]*data-visibility="visible"/);
    view.change('Extra visibility', 'hide');
    expect(view.table.getColumn('extra').getIsVisible()).toBe(false);
    expect(view.rerender()).not.toContain('data-label="Extra"');
    view.change('Extra visibility', 'auto');
    expect(view.table.store.get().columnVisibility).not.toHaveProperty('extra');
    expect(view.rerender()).toContain('data-label="Extra"');
    const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
    for (const priority of [2, 3])
      expect(css).toContain(`.priority-${priority}:not([data-visibility='visible'])`);
  });

  it('offers sorting outside the hidden card headers and sorts the current page in both directions', () => {
    const view = renderTable();
    expect(view.html.indexOf('aria-label="Sort Runs on this page"')).toBeLessThan(
      view.html.indexOf('<table '),
    );
    expect(view.html).not.toContain('value="actions:asc"');
    view.change('Sort Runs on this page', 'id:asc');
    expect(
      view.table.getRowModel().rows.map((row: { original: { id: string } }) => row.original),
    ).toEqual([{ id: 'a' }, { id: 'b' }]);
    view.change('Sort Runs on this page', 'id:desc');
    expect(
      view.table.getRowModel().rows.map((row: { original: { id: string } }) => row.original),
    ).toEqual([{ id: 'b' }, { id: 'a' }]);
    view.change('Sort Runs on this page', '');
    expect(view.table.store.get().sorting).toEqual([]);
    const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /@container broker-table \(max-width: 640px\)\s*\{\s*\.card-sort\s*\{\s*display: flex;/,
    );
  });
});
