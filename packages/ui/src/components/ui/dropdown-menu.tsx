import { CSPProvider } from '@base-ui/react/csp-provider';
import { Menu } from '@base-ui/react/menu';
import type { BaseUIEvent } from '@base-ui/react/types';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
  useRef,
  type ComponentProps,
  type RefObject,
} from 'react';
import { cn } from '../../lib/utils.js';
import { useMergedRefs } from '../../lib/use-merged-refs.js';
import { useOverlayHost } from './overlay-host.js';

const MenuTriggerContext = createContext<{
  trigger: RefObject<HTMLButtonElement | null>;
  popup: RefObject<HTMLDivElement | null>;
} | null>(null);

function visibleTrigger(trigger: HTMLButtonElement | null) {
  if (!trigger) return null;
  if (trigger.isConnected && trigger.getClientRects().length) return trigger;
  const label = trigger.getAttribute('aria-label');
  if (!label) return null;
  const rowKey = trigger.getAttribute('data-row-key');
  return (
    Array.from(
      (trigger.closest('.readable-list') ?? trigger.ownerDocument).querySelectorAll('button'),
    ).find(
      (button) =>
        button.getAttribute('aria-label') === label &&
        button.getAttribute('data-row-key') === rowKey &&
        button.getClientRects().length,
    ) ?? null
  );
}

export function DropdownMenu({
  open,
  children,
  closeWhenHidden = false,
  ...props
}: ComponentProps<'div'> & { open?: boolean; closeWhenHidden?: boolean }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const context = useMemo(() => ({ trigger, popup }), []);
  const [isOpen, setOpen] = useState(open ?? false);
  useEffect(() => {
    if (!isOpen || !closeWhenHidden || !trigger.current) return;
    const observer = new ResizeObserver(() => {
      const opener = trigger.current;
      if (!opener || opener.getClientRects().length) return;
      setOpen(false);
      visibleTrigger(opener)?.focus({ preventScroll: true });
    });
    observer.observe(trigger.current);
    return () => observer.disconnect();
  }, [isOpen, closeWhenHidden]);
  return (
    <CSPProvider disableStyleElements>
      <MenuTriggerContext.Provider value={context}>
        <Menu.Root
          open={isOpen}
          modal={false}
          onOpenChange={(nextOpen, details) => {
            // A trigger can keep focus while a re-render or resize leaves it outside the viewport.
            if (nextOpen) trigger.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            if (details.reason === 'escape-key') {
              const target = details.event.target as Node | null;
              if (!trigger.current?.contains(target) && !popup.current?.contains(target)) {
                details.cancel();
                return;
              }
            }
            setOpen(nextOpen);
          }}
        >
          <div {...props}>{children}</div>
        </Menu.Root>
      </MenuTriggerContext.Provider>
    </CSPProvider>
  );
}

export function DropdownMenuTrigger({
  className,
  ref,
  onKeyDown,
  ...props
}: ComponentProps<'button'>) {
  const context = useContext(MenuTriggerContext);
  const mergedRef = useMergedRefs(ref, context?.trigger);
  return (
    <Menu.Trigger
      {...props}
      ref={mergedRef}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === 'Escape' && event.currentTarget.getAttribute('aria-expanded') === 'true')
          event.preventDefault();
      }}
      className={cn(
        'inline-flex w-auto shrink-0 cursor-pointer items-center justify-center rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
        className,
      )}
    />
  );
}

export function DropdownMenuContent({ className, ref, ...props }: ComponentProps<'div'>) {
  const host = useOverlayHost();
  const context = useContext(MenuTriggerContext);
  const mergedRef = useMergedRefs(ref, context?.popup);
  if (!host) return null;
  return (
    <Menu.Portal container={host}>
      <Menu.Positioner
        className="menu-positioner"
        positionMethod="fixed"
        side="bottom"
        align="end"
        sideOffset={4}
        collisionPadding={8}
        collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
      >
        <Menu.Popup
          {...props}
          ref={mergedRef}
          className={cn(
            'menu-popup min-w-32 rounded-md border border-neutral-200 bg-white p-1 text-neutral-900 shadow-md',
            className,
          )}
          onKeyDown={(event) => {
            props.onKeyDown?.(event);
            // Cancel the native dialog's close request without disabling Base UI's dismissal.
            if (event.key === 'Escape') event.preventDefault();
          }}
          finalFocus={() => {
            const element = context?.trigger.current;
            const document = host.ownerDocument;
            const active = document?.activeElement;
            if (active && active !== document.body && active !== element && !host.contains(active))
              return false;
            return visibleTrigger(element ?? null) ?? document.getElementById('page-heading');
          }}
        />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  className,
  disabled,
  onClick,
  'aria-disabled': ariaDisabled,
  ...props
}: ComponentProps<'button'>) {
  const context = useContext(MenuTriggerContext);
  return (
    <Menu.Item
      disabled={disabled}
      nativeButton
      render={
        <button
          type="button"
          {...props}
          // An explicit undefined would replace the aria-disabled Base UI sets for disabled items.
          {...(ariaDisabled === undefined ? {} : { 'aria-disabled': ariaDisabled })}
          onClick={(event) => {
            if (disabled) {
              event.preventDefault();
              (event as BaseUIEvent<typeof event>).preventBaseUIHandler();
              return;
            }
            onClick?.(event);
            if (event.defaultPrevented) {
              (event as BaseUIEvent<typeof event>).preventBaseUIHandler();
            } else {
              // Keep a connected opener when the selected item opens a native dialog.
              context?.trigger.current?.focus({ preventScroll: true });
            }
          }}
        />
      }
      className={cn(
        'block w-full max-w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-neutral-100 data-[highlighted]:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
    />
  );
}
