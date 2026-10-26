import type { Source } from '../sources.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';

export function AddPackageDialog({
  source,
  busy,
  fieldError,
  alert,
  onSubmit,
  onClose,
}: {
  source: Source;
  busy: boolean;
  fieldError: string | null;
  alert: string | null;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Add package</DialogTitle>
          <DialogDescription>
            Request a package from {source.name} for this project.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) onSubmit(new FormData(event.currentTarget).get('name')?.toString() ?? '');
          }}
        >
          <Label htmlFor="add-package-name">Package name</Label>
          <Input
            id="add-package-name"
            name="name"
            required
            maxLength={428}
            placeholder={source.ecosystem === 'composer' ? 'vendor/package' : '@scope/package'}
            disabled={busy}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'add-package-error' : undefined}
          />
          {fieldError ? (
            <p id="add-package-error" role="alert">
              {fieldError}
            </p>
          ) : null}
          {alert ? <p role="alert">{alert}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Requesting…' : 'Add package'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
