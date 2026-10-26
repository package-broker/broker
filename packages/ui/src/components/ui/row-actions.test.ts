import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button.js';
import { DropdownMenu, DropdownMenuItem } from './dropdown-menu.js';
import { RowActions, type RowAction, type RowActionsProps } from './row-actions.js';

function elements(node: ReactNode, type: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [...(node.type === type ? [node.props] : []), ...elements(node.props.children, type)];
}

function fixture(disabled = false, pending = false) {
  const onSelect = vi.fn();
  const action: RowAction = {
    id: 'edit',
    label: 'Edit',
    variant: 'outline',
    onSelect,
    disabled,
    pending,
    describedBy: 'reason',
  };
  const tree = RowActions({ entityLabel: 'Alpha', actions: [action], overflow: [action] });
  return { tree, onSelect, html: renderToStaticMarkup(tree) };
}

describe('RowActions', () => {
  it('owns visible action metrics and names the overflow trigger', () => {
    const buttons = elements(fixture().tree, Button);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.size).toBe('sm');
    expect(buttons[0]!.className).toContain('w-fit');
    expect(fixture().html).toContain('More actions for Alpha');
    expect(fixture().html).not.toContain('style=');
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('guards visible and overflow activation (disabled=%s, pending=%s)', (disabled, pending) => {
    const { tree, onSelect, html } = fixture(disabled, pending);
    for (const type of [Button, DropdownMenuItem]) {
      const props = elements(tree, type)[0]!;
      expect(props.disabled).toBe(disabled);
      expect(props['aria-disabled']).toBe(pending || undefined);
      expect(props['aria-busy']).toBe(pending || undefined);
      expect(props['aria-describedby']).toBe('reason');
      expect(props['aria-label']).toBe('Edit Alpha');
      const preventDefault = vi.fn();
      (props.onClick as (event: unknown) => void)({ preventDefault });
      if (type === DropdownMenuItem)
        expect(preventDefault).toHaveBeenCalledTimes(disabled || pending ? 1 : 0);
    }
    expect(onSelect).toHaveBeenCalledTimes(disabled || pending ? 0 : 2);
    expect(html).toContain('>Edit</button>');
    expect(html).not.toContain('Loading');
  });

  it('omits empty overflow and accepts an overflow-only row', () => {
    expect(elements(RowActions({ entityLabel: 'A', actions: [] }), DropdownMenu)).toHaveLength(0);
    const { onSelect } = fixture();
    const html = renderToStaticMarkup(
      createElement(RowActions, {
        entityLabel: 'A',
        actions: [],
        overflow: [{ id: 'sync', label: 'Sync now', onSelect }],
      }),
    );
    expect(html).toContain('More actions for A');
  });

  it('defaults native buttons to button while preserving explicit form types and Slot semantics', () => {
    expect(renderToStaticMarkup(createElement(Button, {}, 'Edit'))).toContain('type="button"');
    for (const type of ['submit', 'reset'] as const) {
      expect(renderToStaticMarkup(createElement(Button, { type }, 'Go'))).toContain(
        `type="${type}"`,
      );
    }
    const link = renderToStaticMarkup(
      createElement(Button, { asChild: true }, createElement('a', { href: '#details' }, 'Details')),
    );
    expect(link).not.toContain('type=');
    for (const type of ['button', 'submit', 'reset'] as const) {
      const child = renderToStaticMarkup(
        createElement(Button, { asChild: true }, createElement('button', { type }, 'Go')),
      );
      expect(child).toContain(`type="${type}"`);
    }
  });

  it('escapes labels and entity names', () => {
    const html = renderToStaticMarkup(
      createElement(RowActions, {
        entityLabel: '<script>entity</script>',
        actions: [{ id: 'edit', label: '<img src=x>', onSelect: vi.fn() }],
      }),
    );
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toMatch(/<script|<img/);
  });

  it('rejects geometry and arbitrary children in the public types', () => {
    const action: RowAction = { id: 'edit', label: 'Edit', onSelect() {} };
    // @ts-expect-error RowActions owns the size.
    const size: RowAction = { ...action, size: 'lg' };
    // @ts-expect-error Action descriptors cannot inject classes.
    const classes: RowAction = { ...action, className: 'w-full' };
    // @ts-expect-error Action descriptors cannot inject styles.
    const style: RowAction = { ...action, style: { height: 80 } };
    // @ts-expect-error Action descriptors cannot render arbitrary children.
    const children: RowAction = { ...action, children: createElement(Button) };
    // @ts-expect-error The group has no size escape hatch.
    const groupSize: RowActionsProps = { entityLabel: 'A', actions: [], size: 'lg' };
    // @ts-expect-error The group has no class escape hatch.
    const groupClasses: RowActionsProps = { entityLabel: 'A', actions: [], className: 'w-full' };
    // @ts-expect-error The group has no style escape hatch.
    const groupStyle: RowActionsProps = { entityLabel: 'A', actions: [], style: {} };
    const baseline = renderToStaticMarkup(
      createElement(RowActions, { entityLabel: 'A', actions: [action] }),
    );
    for (const invalid of [size, classes, style, children]) {
      expect(
        renderToStaticMarkup(createElement(RowActions, { entityLabel: 'A', actions: [invalid] })),
      ).toBe(baseline);
    }
    const empty = renderToStaticMarkup(
      createElement(RowActions, { entityLabel: 'A', actions: [] }),
    );
    for (const invalid of [groupSize, groupClasses, groupStyle]) {
      expect(renderToStaticMarkup(createElement(RowActions, invalid))).toBe(empty);
    }
  });
});
