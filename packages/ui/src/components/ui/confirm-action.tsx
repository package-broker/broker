import { useState } from 'react';
import { Button } from './button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog.js';

export function ConfirmAction({
  action,
  target,
  scope,
  description,
  disabled = false,
  onConfirm,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  title,
  touchTargets = false,
}: {
  action: string;
  target: string;
  scope: string;
  description: string;
  disabled?: boolean;
  onConfirm: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  title?: string;
  touchTargets?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      {hideTrigger ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-red-700 hover:bg-red-50 hover:text-red-800"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          {action}
        </Button>
      )}
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent
            className={touchTargets ? '[&_button]:min-h-11 [&_button]:min-w-11' : undefined}
          >
            <DialogHeader className={touchTargets ? 'pr-12' : undefined}>
              <DialogTitle>{title ?? `${action}?`}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <dl className="detail-list">
              <dt>Target</dt>
              <dd>{target}</dd>
              <dt>Scope</dt>
              <dd>{scope}</dd>
            </dl>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  setOpen(false);
                  onConfirm();
                }}
              >
                Confirm {action.toLowerCase()}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
