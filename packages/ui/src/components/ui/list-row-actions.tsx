import { useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { RowActions, type RowAction } from './row-actions.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './dialog.js';
import { ConfirmAction } from './confirm-action.js';

export function ListRowActions({
  id,
  name,
  primary,
  children,
  mutation,
  scope,
}: {
  id: string;
  name: string;
  primary?: RowAction | undefined;
  children?: ReactNode;
  scope: string;
  mutation?: { label: string; description: string; disabled: boolean; run: () => void } | undefined;
}) {
  const [open, setOpen] = useState<'edit' | 'confirm' | null>(null);
  const [copy, setCopy] = useState('');
  async function copyId() {
    flushSync(() => setCopy(''));
    try {
      await navigator.clipboard.writeText(id);
      setCopy('ID copied.');
    } catch {
      setCopy('Could not copy ID.');
    }
  }
  return (
    <>
      <RowActions
        touchTargets
        entityLabel={name}
        actions={
          primary
            ? [{ ...primary, onSelect: children ? () => setOpen('edit') : primary.onSelect }]
            : []
        }
        overflow={[
          { id: 'copy', label: 'Copy ID', onSelect: () => void copyId() },
          ...(mutation
            ? [
                {
                  id: 'mutation',
                  label: mutation.label,
                  variant: 'destructive' as const,
                  disabled: mutation.disabled,
                  onSelect: () => setOpen('confirm'),
                },
              ]
            : []),
        ]}
      />
      <span role="status" className="text-sm">
        {copy}
      </span>
      {copy === 'Could not copy ID.' ? (
        <label className="grid gap-1 text-sm">
          Copy ID manually
          <input
            className="min-h-11 w-full rounded border p-2"
            readOnly
            value={id}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}
      {open === 'edit' ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
        >
          <DialogContent className="list-role-dialog [&_button]:min-h-11 [&_button]:min-w-11">
            <DialogHeader className="pr-12">
              <DialogTitle>Change role</DialogTitle>
              <DialogDescription>
                {name} · {scope}
              </DialogDescription>
            </DialogHeader>
            {children}
          </DialogContent>
        </Dialog>
      ) : null}
      {mutation ? (
        <ConfirmAction
          hideTrigger
          touchTargets
          title={
            mutation.label === 'Revoke grant'
              ? `Revoke access for ${name}?`
              : `${mutation.label}: ${name}?`
          }
          open={open === 'confirm'}
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
          action={mutation.label}
          target={name}
          scope={scope}
          description={mutation.description}
          disabled={mutation.disabled}
          onConfirm={mutation.run}
        />
      ) : null}
    </>
  );
}
