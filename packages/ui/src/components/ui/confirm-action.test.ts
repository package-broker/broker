import { isValidElement, useState, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmAction } from './confirm-action.js';
import { Dialog } from './dialog.js';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});
afterEach(() => vi.clearAllMocks());

function find(
  node: ReactNode,
  matches: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, matches)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return;
  return matches(node.props) ? node.props : find(node.props.children as ReactNode, matches);
}
function view(open = false, disabled = false) {
  const onConfirm = vi.fn();
  const setOpen = vi.fn();
  vi.mocked(useState).mockReturnValueOnce([open, setOpen]);
  const tree = ConfirmAction({
    action: 'Revoke',
    target: 'CI token (token-id)',
    scope: 'Project: storefront',
    description: 'Clients lose access immediately. This cannot be undone.',
    disabled,
    onConfirm,
  });
  return { tree, onConfirm, setOpen, html: renderToString(tree) };
}
const click = (props: Record<string, unknown> | undefined) => {
  expect(props).toBeDefined();
  (props!.onClick as () => void)();
};

describe('destructive confirmation', () => {
  it('opens confirmation without sending the action', () => {
    const v = view();
    expect(v.html).not.toContain('<dialog');
    click(find(v.tree, (props) => props.children === 'Revoke'));
    expect(v.setOpen).toHaveBeenCalledWith(true);
    expect(v.onConfirm).not.toHaveBeenCalled();
  });
  it('shows the action, target, scope and consequence and sends only on confirmation', () => {
    const v = view(true);
    expect(v.html).toContain('CI token (token-id)');
    expect(v.html).toContain('Project: storefront');
    expect(v.html).toContain('This cannot be undone.');
    expect(v.html).toContain('aria-labelledby=');
    expect(v.html).not.toMatch(/<style\b|\sstyle=/i);
    click(find(v.tree, (props) => props.variant === 'destructive'));
    expect(v.onConfirm).toHaveBeenCalledTimes(1);
    expect(v.setOpen).toHaveBeenCalledWith(false);
  });
  it('cancels without sending and wires dialog dismissal', () => {
    const v = view(true);
    click(find(v.tree, (props) => props.children === 'Cancel'));
    expect(v.setOpen).toHaveBeenCalledWith(false);
    expect(v.onConfirm).not.toHaveBeenCalled();
    const dialog = isValidElement<{ children: ReactNode }>(v.tree)
      ? (v.tree.props.children as ReactNode[]).find(
          (child) => isValidElement(child) && child.type === Dialog,
        )
      : undefined;
    expect(isValidElement(dialog)).toBe(true);
    if (!isValidElement<{ onOpenChange: (open: boolean) => void }>(dialog))
      throw new Error('Missing dialog');
    dialog.props.onOpenChange(false);
    expect(v.onConfirm).not.toHaveBeenCalled();
  });
  it('refuses confirmation when the action becomes disabled', () => {
    const v = view(true, true);
    const confirm = find(v.tree, (props) => props.variant === 'destructive');
    expect(confirm?.disabled).toBe(true);
    click(confirm);
    expect(v.onConfirm).not.toHaveBeenCalled();
  });
  it('escapes a hostile target', () => {
    vi.mocked(useState).mockReturnValueOnce([true, vi.fn()]);
    const html = renderToString(
      ConfirmAction({
        action: 'Revoke',
        target: '<script>private</script>',
        scope: 'Organization',
        description: 'Stops access.',
        onConfirm: vi.fn(),
      }),
    );
    expect(html).toContain('&lt;script&gt;private&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});
