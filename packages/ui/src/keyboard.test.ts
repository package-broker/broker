import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isValidElement, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Button } from './components/ui/button.js';
import { Dialog, DialogContent, DialogFooter } from './components/ui/dialog.js';
import { ConfirmAction } from './components/ui/confirm-action.js';
import { DropdownMenu } from './components/ui/dropdown-menu.js';
import { Textarea } from './components/ui/textarea.js';
import { SourceForm } from './pages/sources/source-form.js';

vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return {
    ...actual,
    useId: vi.fn(() => 'dialog-id'),
    useContext: vi.fn(),
    useEffect: vi.fn(),
    useRef: vi.fn(() => ({ current: null })),
    useState: vi.fn((initial) => [initial, vi.fn()]),
  };
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function find(node: ReactNode, type: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, type)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return;
  if (node.type === type) return node.props;
  return find(node.props.children as ReactNode, type);
}

function mountDialog(
  fields: unknown[] = [],
  children: ReactNode = null,
  initial?: 'body' | 'null',
) {
  vi.useFakeTimers();
  const body = {};
  const listeners = new Map<string, () => void>();
  const element = () => ({
    isConnected: true,
    disabled: false,
    rendered: true,
    matches() {
      return this.disabled;
    },
    getClientRects() {
      return this.rendered ? [1] : [];
    },
    closest: vi.fn<(selector: string) => unknown>(() => null),
    focus: vi.fn(function (this: unknown) {
      ownerDocument.activeElement = this;
    }),
  });
  const opener = element();
  const heading = element();
  const action = element();
  const ownerDocument = {
    body,
    documentElement: {},
    activeElement: opener as unknown,
    querySelector: vi.fn((selector: string) => (selector === '#page-heading' ? heading : null)),
    addEventListener: vi.fn((name: string, fn: () => void) => listeners.set(name, fn)),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
  };
  const dialog = {
    ownerDocument,
    contains: vi.fn(() => false),
    showModal: vi.fn(() => {
      ownerDocument.activeElement = dialog;
    }),
    close: vi.fn(() => {
      ownerDocument.activeElement = opener;
    }),
    querySelectorAll: vi.fn((selector: string) => {
      if (selector === 'input:not([type="hidden"]), select, textarea') return fields;
      if (selector === '[data-dialog-footer] button:not([data-variant="destructive"])')
        return [action];
      return [];
    }),
    querySelector: vi.fn(() => action),
  };
  if (initial) ownerDocument.activeElement = initial === 'body' ? body : null;
  const observe = vi.fn();
  const disconnect = vi.fn();
  let mutation!: () => void;
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(callback: () => void) {
        mutation = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const setOpen = vi.fn();
  vi.mocked(useContext).mockReturnValue({ open: true, setOpen });
  const dialogRef = { current: dialog };
  const restoreRef = { current: null };
  vi.mocked(useRef).mockReturnValueOnce(dialogRef).mockReturnValueOnce(restoreRef);
  const tree = DialogContent({ children });
  const effect = vi.mocked(useEffect).mock.calls.at(-1)![0];
  const cleanup = effect() as () => void;
  return {
    tree,
    renderClosed: () => {
      vi.mocked(useContext).mockReturnValue({ open: false, setOpen });
      vi.mocked(useRef).mockReturnValueOnce(dialogRef).mockReturnValueOnce(restoreRef);
      DialogContent({ children });
      vi.mocked(useEffect).mock.calls.at(-1)![0]();
    },
    observe,
    dialog,
    cleanup,
    effect,
    opener,
    heading,
    action,
    setOpen,
    mutate: () => mutation(),
    disconnect,
    listeners,
    element,
  };
}

it('focuses the first enabled visible form field on opening', () => {
  const hidden = { matches: () => false, getClientRects: () => [], focus: vi.fn() };
  const disabled = { matches: () => true, getClientRects: () => [1], focus: vi.fn() };
  const field = { matches: () => false, getClientRects: () => [1], focus: vi.fn() };
  const later = { ...field, focus: vi.fn() };
  const v = mountDialog([hidden, disabled, field, later]);
  expect(v.dialog.showModal).toHaveBeenCalledOnce();
  expect(field.focus).toHaveBeenCalledOnce();
  expect(hidden.focus).not.toHaveBeenCalled();
  expect(disabled.focus).not.toHaveBeenCalled();
  expect(later.focus).not.toHaveBeenCalled();
  expect(v.action.focus).not.toHaveBeenCalled();
});

it('initially focuses Cancel in ConfirmAction through the shared dialog mechanism', () => {
  vi.mocked(useState).mockReturnValueOnce([true, vi.fn()]);
  const tree = ConfirmAction({
    action: 'Delete',
    target: 'Source',
    scope: 'Organization',
    description: 'Removes this source.',
    onConfirm: vi.fn(),
  });
  const content = find(tree, DialogContent)!;
  const footer = find(content.children as ReactNode, DialogFooter)!;
  expect(DialogFooter(footer).props).toHaveProperty('data-dialog-footer');
  const buttons = footer.children as ReactNode[];
  const cancel = find(buttons[0], Button)!;
  expect(cancel.children).toBe('Cancel');
  expect(cancel.variant).toBe('outline');
  expect(Button(find(buttons[1], Button)!).props['data-variant']).toBe('destructive');
  expect(Button(cancel).props['data-variant']).toBe('outline');
  const v = mountDialog([], content.children as ReactNode);
  expect(v.dialog.querySelectorAll).toHaveBeenCalledWith(
    '[data-dialog-footer] button:not([data-variant="destructive"])',
  );
  expect(v.action.focus).toHaveBeenCalledOnce();
});

it.each([true, false])('returns focus after close with trigger connected=%s', async (connected) => {
  const v = mountDialog();
  v.opener.isConnected = connected;
  v.cleanup();
  await Promise.resolve();
  expect(v.dialog.close).toHaveBeenCalledOnce();
  expect(connected ? v.opener.focus : v.heading.focus).toHaveBeenCalledOnce();
  expect(connected ? v.heading.focus : v.opener.focus).not.toHaveBeenCalled();
});

it('keeps the queued restore when a mounted dialog renders closed', async () => {
  const v = mountDialog();
  v.cleanup();
  v.renderClosed();
  await Promise.resolve();
  expect(v.opener.focus).toHaveBeenCalledOnce();
});

it.each(['body', 'null'] as const)('uses the heading without an opener (%s)', async (initial) => {
  const v = mountDialog([], null, initial);
  v.cleanup();
  v.dialog.ownerDocument.activeElement = null;
  await Promise.resolve();
  expect(v.heading.focus).toHaveBeenCalledOnce();
});

it('restores focus when the window has lost focus', async () => {
  const v = mountDialog();
  v.cleanup();
  v.dialog.ownerDocument.activeElement = null;
  await Promise.resolve();
  expect(v.opener.focus).toHaveBeenCalledOnce();
});

it('maps native Escape cancellation to closing the dialog', () => {
  const v = mountDialog();
  const cancel = find(v.tree, 'dialog')!.onCancel as (event: unknown) => void;
  const event = { defaultPrevented: false, preventDefault: vi.fn() };
  cancel(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(v.setOpen).toHaveBeenCalledWith(false);
});

it('consumes Escape in a DropdownMenu rendered inside a Dialog', () => {
  const menuTree = DropdownMenu({ children: 'Menu item' });
  const wrapper = Dialog({ open: true, children: menuTree });
  const v = mountDialog([], wrapper);
  expect(find(v.tree, 'details')).toBeDefined();
  const cancel = find(v.tree, 'dialog')!.onCancel as (event: unknown) => void;
  let nativeCancel: ((event: Event) => void) | undefined;
  const nativeDialog = {
    addEventListener: vi.fn((_type: string, callback: (event: Event) => void) => {
      nativeCancel = callback;
    }),
    removeEventListener: vi.fn(),
  };
  const summary = { focus: vi.fn() };
  const menu = {
    open: true,
    contains: () => true,
    closest: () => nativeDialog,
    querySelector: () => summary,
  };
  const event = {
    key: 'Escape',
    defaultPrevented: false,
    currentTarget: menu,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  menuTree.props.onKeyDown!(event as never);
  expect(menu.open).toBe(false);
  expect(summary.focus).toHaveBeenCalledOnce();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  const native = new Event('cancel', { cancelable: true });
  nativeCancel!(native);
  expect(native.defaultPrevented).toBe(true);
  expect(v.setOpen).not.toHaveBeenCalled();
  vi.runOnlyPendingTimers();
  expect(nativeDialog.removeEventListener).toHaveBeenCalledWith('cancel', nativeCancel, true);
  cancel({ defaultPrevented: false, preventDefault: vi.fn() });
  expect(v.setOpen).toHaveBeenCalledWith(false);
});

it('waits for a busy trigger to become enabled', async () => {
  const v = mountDialog();
  v.opener.disabled = true;
  v.cleanup();
  await Promise.resolve();
  expect(v.opener.focus).not.toHaveBeenCalled();
  v.opener.disabled = false;
  v.mutate();
  expect(v.opener.focus).toHaveBeenCalledOnce();
});

it('falls back when an async delete detaches the trigger after close', async () => {
  const v = mountDialog();
  v.cleanup();
  await Promise.resolve();
  expect(v.opener.focus).toHaveBeenCalledOnce();
  v.opener.isConnected = false;
  v.mutate();
  expect(v.heading.focus).toHaveBeenCalledOnce();
  expect(v.observe).toHaveBeenLastCalledWith(v.dialog.ownerDocument.documentElement, {
    subtree: true,
    childList: true,
  });
  expect(v.disconnect).toHaveBeenCalledTimes(2);
});

it('uses the summary when the opener is inside closed details', async () => {
  const v = mountDialog();
  const summary = v.element();
  v.opener.closest.mockReturnValue({ querySelector: () => summary });
  v.opener.rendered = false;
  v.cleanup();
  await Promise.resolve();
  expect(summary.focus).toHaveBeenCalledOnce();
  expect(v.heading.focus).not.toHaveBeenCalled();
});

it('restores an opener inside the still-open parent dialog', async () => {
  const v = mountDialog();
  const parent = {
    ...v.element(),
    open: true,
    children: [v.opener, v.dialog],
    contains(node: unknown) {
      return this.children.includes(node as never);
    },
  };
  v.dialog.ownerDocument.querySelector.mockImplementation((selector) =>
    selector === 'dialog[open]' ? parent : selector === '#page-heading' ? v.heading : null,
  );
  v.opener.closest.mockImplementation((selector) => (selector === 'dialog[open]' ? parent : null));
  v.dialog.close.mockImplementation(() => {
    v.dialog.ownerDocument.activeElement = parent.children[0];
  });
  v.cleanup();
  await Promise.resolve();
  expect(v.opener.focus).toHaveBeenCalledOnce();
});

it('does not take focus from another open dialog or a user-selected control', async () => {
  const v = mountDialog();
  v.cleanup();
  v.dialog.ownerDocument.activeElement = v.element();
  await Promise.resolve();
  expect(v.opener.focus).not.toHaveBeenCalled();
  expect(v.disconnect).toHaveBeenCalledOnce();
});

it('bounds restoration for an unrendered opener to five seconds', async () => {
  const v = mountDialog();
  v.opener.rendered = false;
  v.cleanup();
  await Promise.resolve();
  v.mutate();
  expect(v.heading.focus).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5000);
  expect(v.heading.focus).toHaveBeenCalledOnce();
  expect(v.disconnect).toHaveBeenCalled();
});

it('cancels the stale restore during StrictMode effect/cleanup/effect replay', async () => {
  const v = mountDialog();
  v.cleanup();
  const cleanup = v.effect() as () => void;
  await Promise.resolve();
  expect(v.dialog.showModal).toHaveBeenCalledTimes(2);
  expect(v.opener.focus).not.toHaveBeenCalled();
  expect(v.heading.focus).not.toHaveBeenCalled();
  cleanup();
  await Promise.resolve();
  vi.advanceTimersByTime(5000);
  expect(v.disconnect).toHaveBeenCalled();
});

it.each([
  [false, false, false],
  [true, false, true],
  [false, true, true],
])('textarea Enter with meta=%s ctrl=%s submits=%s', (metaKey, ctrlKey, submits) => {
  const requestSubmit = vi.fn();
  const event = {
    key: 'Enter',
    metaKey,
    ctrlKey,
    defaultPrevented: false,
    nativeEvent: { isComposing: false },
    currentTarget: { form: { requestSubmit } },
    preventDefault: vi.fn(),
  };
  Textarea({}).props.onKeyDown(event);
  expect(requestSubmit).toHaveBeenCalledTimes(submits ? 1 : 0);
  expect(event.preventDefault).toHaveBeenCalledTimes(submits ? 1 : 0);
});

it('ignores textarea submission shortcuts during composition or when prevented', () => {
  for (const composing of [true, false]) {
    const requestSubmit = vi.fn();
    Textarea({}).props.onKeyDown({
      key: 'Enter',
      ctrlKey: true,
      defaultPrevented: !composing,
      nativeEvent: { isComposing: composing },
      currentTarget: { form: { requestSubmit } },
      preventDefault: vi.fn(),
    });
    expect(requestSubmit).not.toHaveBeenCalled();
  }
});

it('refuses repeated form submissions from Enter while the source request is busy', () => {
  const NativeFormData = FormData;
  vi.stubGlobal(
    'FormData',
    class extends NativeFormData {
      constructor() {
        super();
        this.set('name', 'Keyboard source');
        this.set('pollIntervalSeconds', '300');
        this.set('removalPolicy', 'flag');
      }
    },
  );
  const onSubmit = vi.fn();
  const props = { source: null, busy: false, errors: {}, alert: null, onSubmit, onClose: vi.fn() };
  const event = { preventDefault: vi.fn(), currentTarget: {} };
  const submit = find(SourceForm(props), 'form')!.onSubmit as (event: unknown) => void;
  submit(event);
  expect(onSubmit).toHaveBeenCalledOnce();
  const busySubmit = find(SourceForm({ ...props, busy: true }), 'form')!.onSubmit as (
    event: unknown,
  ) => void;
  busySubmit(event);
  busySubmit(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(3);
  expect(onSubmit).toHaveBeenCalledOnce();
});

function keyboardViolations(source: string) {
  const tree = ts.createSourceFile(
    'scan.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: string[] = [];
  let forms = 0;
  function validTabIndex(value: ts.Node | undefined): boolean {
    if (!value) return false;
    if (ts.isParenthesizedExpression(value)) return validTabIndex(value.expression);
    if (ts.isConditionalExpression(value))
      return validTabIndex(value.whenTrue) && validTabIndex(value.whenFalse);
    return ['-1', '0', 'undefined'].includes(
      ts.isStringLiteral(value) ? value.text : value.getText(tree),
    );
  }
  function checkSpread(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (
          prop.name &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
          prop.name.text === 'tabIndex'
        ) {
          if (!ts.isPropertyAssignment(prop) || !validTabIndex(prop.initializer))
            violations.push(prop.getText(tree));
        }
      }
    }
    ts.forEachChild(node, checkSpread);
  }
  function visit(node: ts.Node, inForm = false) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = node.attributes.properties;
      const tag = node.tagName.getText(tree);
      if (tag === 'form') {
        forms++;
        if (
          !attrs.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(tree) === 'onSubmit')
        )
          violations.push('form without onSubmit');
      }
      if (
        inForm &&
        (tag === 'Button' || tag === 'button') &&
        !attrs.some(
          (attr) =>
            ts.isJsxAttribute(attr) && attr.name.getText(tree) === 'type' && attr.initializer,
        )
      )
        violations.push(`${tag} without type`);
      for (const attr of attrs) {
        if (ts.isJsxSpreadAttribute(attr)) checkSpread(attr.expression);
        else if (attr.name.getText(tree) === 'tabIndex') {
          const value =
            attr.initializer && ts.isJsxExpression(attr.initializer)
              ? attr.initializer.expression
              : attr.initializer;
          if (!validTabIndex(value)) violations.push(attr.getText(tree));
        }
      }
    }
    const childInForm =
      inForm || (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'form');
    ts.forEachChild(node, (child) => visit(child, childInForm));
  }
  visit(tree);
  return { violations, forms };
}

it.each([
  '<div tabIndex />',
  '<div tabIndex={1} />',
  '<div {...{tabIndex: 1}} />',
  '<div {...(ok ? {tabIndex: 0} : {tabIndex: 2})} />',
  '<div {...{tabIndex: ok ? 0 : 2}} />',
  '<form onSubmit={submit}><Button>Cancel</Button></form>',
  '<form onSubmit={submit}><div><Button /></div></form>',
])('rejects unsafe keyboard markup: %s', (source) => {
  expect(keyboardViolations(source).violations.length).toBeGreaterThan(0);
});

it('accepts optional tab stops and explicitly typed form buttons', () => {
  expect(
    keyboardViolations(
      '<form onSubmit={submit}><Button type="button" /><div tabIndex={label ? 0 : undefined} {...(ok ? {tabIndex: -1} : {tabIndex: undefined})} /></form>',
    ).violations,
  ).toEqual([]);
});

it('requires form submit handlers, explicit form button types and nonpositive tab stops throughout UI sources', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const paths = readdirSync(root, { recursive: true, withFileTypes: true }).filter(
    (entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name),
  );
  let forms = 0;
  for (const entry of paths) {
    const path = `${entry.parentPath}/${entry.name}`;
    const result = keyboardViolations(readFileSync(path, 'utf8'));
    expect(result.violations, path).toEqual([]);
    forms += result.forms;
  }
  expect(forms).toBeGreaterThan(20);
});
