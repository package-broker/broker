import type { ComponentProps } from 'react';

export function Textarea({ onKeyDown, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          event.key === 'Enter' &&
          (event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
    />
  );
}
