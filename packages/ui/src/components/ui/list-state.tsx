import type { ReactNode } from 'react';
export function ListState({
  kind,
  title,
  children,
}: {
  kind: 'placeholder' | 'loading' | 'empty' | 'filtered-empty' | 'error';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-list-state={kind}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-busy={kind === 'loading'}
      className={`list-state ${kind === 'error' ? 'list-state-error' : ''}`}
    >
      <strong>{title}</strong>
      {children}
    </div>
  );
}
