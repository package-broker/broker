import { cn } from '../../lib/utils.js';
import { Button, buttonVariants, type ButtonProps } from './button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu.js';

export interface RowAction {
  id: string;
  label: string;
  onSelect: () => void;
  variant?: NonNullable<ButtonProps['variant']>;
  disabled?: boolean;
  pending?: boolean;
  describedBy?: string;
}

export interface RowActionsProps {
  entityLabel: string;
  actions: readonly RowAction[];
  overflow?: readonly RowAction[];
}

const controlClassName =
  'h-auto min-h-10 w-fit max-w-full shrink-0 whitespace-normal break-words py-2 sm:min-h-8 sm:py-1';

function RowActionsTrigger({ entityLabel }: { entityLabel: string }) {
  return (
    <DropdownMenuTrigger
      aria-label={`More actions for ${entityLabel}`}
      className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), controlClassName)}
    >
      More
    </DropdownMenuTrigger>
  );
}

export function RowActions({ entityLabel, actions, overflow = [] }: RowActionsProps) {
  return (
    <div
      role="group"
      aria-label={`Actions for ${entityLabel}`}
      className="flex flex-wrap items-center gap-2"
    >
      {actions.map((action) => (
        <Button
          key={action.id}
          size="sm"
          className={controlClassName}
          variant={action.variant ?? 'outline'}
          disabled={Boolean(action.disabled)}
          aria-disabled={action.pending || undefined}
          aria-busy={action.pending || undefined}
          aria-describedby={action.describedBy}
          aria-label={`${action.label} ${entityLabel}`}
          onClick={() => {
            if (!action.disabled && !action.pending) action.onSelect();
          }}
        >
          {action.label}
        </Button>
      ))}
      {overflow.length > 0 ? (
        <DropdownMenu className="max-w-full">
          <RowActionsTrigger entityLabel={entityLabel} />
          <DropdownMenuContent>
            {overflow.map((action) => (
              <DropdownMenuItem
                key={action.id}
                data-variant={action.variant ?? 'outline'}
                className={action.variant === 'destructive' ? 'text-red-700' : undefined}
                disabled={Boolean(action.disabled)}
                aria-disabled={action.pending || undefined}
                aria-busy={action.pending || undefined}
                aria-describedby={action.describedBy}
                aria-label={`${action.label} ${entityLabel}`}
                onClick={(event) => {
                  if (action.disabled || action.pending) {
                    event.preventDefault();
                    return;
                  }
                  action.onSelect();
                }}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
