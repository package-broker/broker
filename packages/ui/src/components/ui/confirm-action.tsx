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
}: {
  action: string;
  target: string;
  scope: string;
  description: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
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
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{action}?</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <dl className="detail-list">
              <dt>Target</dt>
              <dd>{target}</dd>
              <dt>Scope</dt>
              <dd>{scope}</dd>
            </dl>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
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
