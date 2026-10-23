import { isValidElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterToolbar, LoadedListFilters } from './toolbar.js';

function find(node: ReactNode, type: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, type)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return;
  return node.type === type ? node.props : find(node.props.children as ReactNode, type);
}
afterEach(() => vi.unstubAllGlobals());

describe('loaded list filters', () => {
  it.each([false, true])('initially follows the desktop media query (%s)', (matches) => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches }) });
    const html = renderToString(fixture().tree);
    expect(/<details[^>]*\sopen=""/.test(html)).toBe(matches);
  });

  function fixture() {
    const onChange = vi.fn();
    const tree = LoadedListFilters({
      values: { q: 'build', status: 'active' },
      fields: [
        { key: 'q', label: 'Name (this page)' },
        { key: 'status', label: 'Status', options: ['active', 'revoked'] },
      ],
      onChange,
    });
    return { tree, onChange };
  }
  it('uses native disclosure without inline styles and labels every input', () => {
    const { tree } = fixture();
    const html = renderToString(tree);
    expect(html).toContain('<details open=""');
    expect(html).toContain('<summary');
    expect(html).toContain('Name (this page)');
    expect(html).toContain('Remove Status filter');
    expect(html).not.toMatch(/<style\b|\sstyle=/i);
    expect(tree.type).toBe(FilterToolbar);
  });
  it('applies submitted values rather than the existing filter values', () => {
    const { tree, onChange } = fixture();
    vi.stubGlobal(
      'FormData',
      class {
        get(key: string) {
          return key === 'q' ? 'deploy' : 'revoked';
        }
      },
    );
    const preventDefault = vi.fn();
    (find(tree, 'form')!.onSubmit as (event: unknown) => void)({
      preventDefault,
      currentTarget: {},
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({ q: 'deploy', status: 'revoked' });
  });
  it('removes one chip while preserving other applied filters', () => {
    const { tree, onChange } = fixture();
    tree.props.chips![0]!.onRemove();
    expect(onChange).toHaveBeenCalledWith({ q: '', status: 'active' });
  });
  it('resets unapplied native field values even when applied filters are already empty', () => {
    const onChange = vi.fn();
    const tree = LoadedListFilters({
      values: { q: '', status: '' },
      fields: [
        { key: 'q', label: 'Name' },
        { key: 'status', label: 'Status', options: ['active', 'revoked'] },
      ],
      onChange,
    });
    const form = find(tree, 'form')!;
    const fields = { q: { value: 'unapplied' }, status: { value: 'revoked' } };
    const reset = vi.fn(() => {
      fields.q.value = '';
      fields.status.value = '';
    });
    const children = (form.children as ReactNode[]).flat();
    const clear = children.find(
      (child) =>
        isValidElement<{ children: ReactNode }>(child) && child.props.children === 'Clear filters',
    );
    if (!isValidElement<{ onClick: (event: unknown) => void }>(clear))
      throw new Error('Missing clear button');
    clear.props.onClick({ currentTarget: { form: { reset } } });
    expect(reset).toHaveBeenCalledOnce();
    expect(fields.q.value).toBe('');
    expect(fields.status.value).toBe('');
    expect(onChange).toHaveBeenCalledWith({ q: '', status: '' });
  });
  it('clears every filter', () => {
    const { tree, onChange } = fixture();
    function clear(node: ReactNode): ((event: unknown) => void) | undefined {
      if (Array.isArray(node)) return node.map(clear).find(Boolean);
      if (!isValidElement<Record<string, unknown>>(node)) return;
      return node.props.children === 'Clear filters'
        ? (node.props.onClick as (event: unknown) => void)
        : clear(node.props.children as ReactNode);
    }
    clear(tree)!({ currentTarget: { form: { reset: vi.fn() } } });
    expect(onChange).toHaveBeenCalledWith({ q: '', status: '' });
  });
});
