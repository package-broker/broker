import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn, portalContainer } from '../../lib/utils.js';
import { OverlayHost } from './overlay-host.js';
import { useMergedRefs } from '../../lib/use-merged-refs.js';

const DialogContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
} | null>(null);

export function Dialog(props: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const titleId = useId();
  const descriptionId = useId();
  return (
    <DialogContext.Provider
      value={{
        open: props.open ?? open,
        setOpen: (next) => {
          setOpen(next);
          props.onOpenChange?.(next);
        },
        titleId,
        descriptionId,
      }}
    >
      {props.children}
    </DialogContext.Provider>
  );
}

export function DialogTrigger({ onClick, ...props }: ComponentProps<'button'>) {
  const context = useContext(DialogContext);
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context?.setOpen(true);
      }}
    />
  );
}

export function DialogClose({ onClick, ...props }: ComponentProps<'button'>) {
  const context = useContext(DialogContext);
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context?.setOpen(false);
      }}
    />
  );
}

export function DialogContent({
  className,
  children,
  variant,
  ref: callerRef,
  ...props
}: ComponentProps<'dialog'> & { variant?: 'source' }) {
  const context = useContext(DialogContext);
  const ref = useRef<HTMLDialogElement>(null);
  const mergedRef = useMergedRefs(callerRef, ref);
  const open = context?.open ?? false;
  const stopRestore = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!open) return;
    stopRestore.current?.();
    if (!ref.current) return;
    const dialog = ref.current;
    const document = dialog.ownerDocument;
    const active = document.activeElement as HTMLElement | null;
    const menu = active?.closest('[role="menu"]');
    const menuTrigger = menu?.getAttribute('aria-labelledby');
    const opener = menuTrigger
      ? document.getElementById(menuTrigger)
      : active === document.body
        ? null
        : active;
    dialog.showModal();
    const visible = (element: HTMLElement) =>
      !element.matches(':disabled') && element.getClientRects().length > 0;
    const first = (selector: string) =>
      Array.from(dialog.querySelectorAll<HTMLElement>(selector)).find(visible);
    const target =
      first('input:not([type="hidden"]), select, textarea') ??
      first('[data-initial-focus]') ??
      first('[data-dialog-footer] button:not([data-variant="destructive"])') ??
      dialog.querySelector<HTMLElement>('button[aria-label="Close"]');
    target?.focus();
    let cancelled = false;
    return () => {
      dialog.close();
      const stop = () => {
        cancelled = true;
      };
      stopRestore.current = stop;
      queueMicrotask(() => {
        if (cancelled) return;
        let restoring = false;
        let restored = false;
        const observer = new MutationObserver(() => restore());
        const deadline = setTimeout(() => {
          restore(true);
          cleanup();
        }, 5000);
        function cleanup() {
          cancelled = true;
          observer.disconnect();
          clearTimeout(deadline);
          document.removeEventListener('focusin', onFocus);
          document.removeEventListener('keydown', onInteraction, true);
          document.removeEventListener('pointerdown', onInteraction, true);
        }
        function onFocus() {
          if (
            !restoring &&
            document.activeElement !== null &&
            document.activeElement !== document.body &&
            !dialog.contains(document.activeElement)
          )
            cleanup();
        }
        function onInteraction() {
          if (
            document.activeElement !== null &&
            document.activeElement !== document.body &&
            !dialog.contains(document.activeElement)
          )
            cleanup();
        }
        function restore(expired = false) {
          if (cancelled) return;
          const active = document.activeElement;
          if (
            active !== null &&
            active !== document.body &&
            active !== opener &&
            !dialog.contains(active)
          ) {
            cleanup();
            return;
          }
          if (restored && opener?.isConnected) return;
          const menu = opener?.closest('details:not([open])');
          const candidate = menu?.querySelector<HTMLElement>('summary') ?? opener;
          const fallback = document.querySelector<HTMLElement>('#page-heading');
          const target =
            !candidate?.isConnected || (expired && !visible(candidate)) ? fallback : candidate;
          if (!target || !visible(target)) return;
          restoring = true;
          target.focus();
          restoring = false;
          if (target !== opener) cleanup();
          else {
            restored = true;
            observer.disconnect();
            observer.observe(document.documentElement, { subtree: true, childList: true });
          }
        }
        stopRestore.current = cleanup;
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['disabled', 'hidden', 'style', 'class', 'open'],
        });
        document.addEventListener('focusin', onFocus);
        document.addEventListener('keydown', onInteraction, true);
        document.addEventListener('pointerdown', onInteraction, true);
        restore();
      });
    };
  }, [open]);
  const container = portalContainer();
  const content = (
    <dialog
      {...props}
      ref={mergedRef}
      aria-labelledby={context?.titleId}
      aria-describedby={context?.descriptionId}
      onCancel={(event) => {
        props.onCancel?.(event);
        if (!event.defaultPrevented) {
          event.preventDefault();
          context?.setOpen(false);
        }
      }}
      onClose={(event) => {
        props.onClose?.(event);
        if (open && !event.currentTarget.open) context?.setOpen(false);
      }}
      className={cn(
        'fixed inset-0 m-auto w-[calc(100%_-_2rem)] min-w-0 max-w-lg max-h-[90dvh] overflow-visible rounded-lg border-0 bg-transparent p-0 text-neutral-900 shadow-lg backdrop:bg-black/50',
        variant === 'source' &&
          'h-dvh max-h-none w-full max-w-none rounded-none sm:h-auto sm:max-h-[90dvh] sm:w-[calc(100%_-_2rem)] sm:max-w-lg sm:rounded-lg',
        className,
      )}
    >
      <OverlayHost>
        <div
          className={cn(
            'relative grid min-w-0 max-h-[90dvh] gap-4 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-6',
            variant === 'source' &&
              'flex h-dvh max-h-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[90dvh] sm:rounded-lg',
          )}
        >
          {children}
          <DialogClose
            className={cn(
              'absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600',
              variant === 'source' && 'flex h-11 w-11 items-center justify-center',
            )}
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </DialogClose>
        </div>
      </OverlayHost>
    </dialog>
  );
  return container ? createPortal(content, container) : content;
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex min-w-0 flex-col gap-1.5 pr-7', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-dialog-footer
      className={cn('flex flex-wrap justify-end gap-2', className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<'h2'>) {
  const context = useContext(DialogContext);
  return (
    <h2
      id={context?.titleId}
      className={cn('break-words text-lg font-semibold leading-snug tracking-tight', className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }: ComponentProps<'p'>) {
  const context = useContext(DialogContext);
  return (
    <p
      id={context?.descriptionId}
      className={cn('text-sm text-neutral-600', className)}
      {...props}
    />
  );
}
