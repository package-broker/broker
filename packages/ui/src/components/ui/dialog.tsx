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

export function DialogContent({ className, children, ...props }: ComponentProps<'dialog'>) {
  const context = useContext(DialogContext);
  const ref = useRef<HTMLDialogElement>(null);
  const open = context?.open ?? false;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    dialog.showModal();
    return () => {
      dialog.close();
    };
  }, [open]);
  const container = portalContainer();
  const content = (
    <dialog
      {...props}
      ref={ref}
      aria-labelledby={context?.titleId}
      aria-describedby={context?.descriptionId}
      onCancel={(event) => {
        props.onCancel?.(event);
        if (!event.defaultPrevented) {
          event.preventDefault();
          context?.setOpen(false);
        }
      }}
      className={cn(
        'fixed inset-0 m-auto w-full max-w-lg gap-4 rounded-lg border border-neutral-200 bg-white p-6 text-neutral-900 shadow-lg open:grid backdrop:bg-black/50',
        className,
      )}
    >
      {children}
      <DialogClose
        className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
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
    </dialog>
  );
  return container ? createPortal(content, container) : content;
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-row justify-end gap-2', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<'h2'>) {
  const context = useContext(DialogContext);
  return (
    <h2
      id={context?.titleId}
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
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
