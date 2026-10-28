import { useEffect, useState, type ComponentType } from 'react';
import { Button } from './components/ui/button.js';

const resolvedPages = new Map<() => Promise<ComponentType>, ComponentType>();

type PageState = { Page: ComponentType } | 'loading' | 'error';

export function PageLoader({ load }: { load: () => Promise<ComponentType> }) {
  const [state, setState] = useState<PageState>(() => {
    const Page = resolvedPages.get(load);
    return Page ? { Page } : 'loading';
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const cached = resolvedPages.get(load);
    if (cached) {
      setState({ Page: cached });
      return;
    }
    void load().then(
      (Page) => {
        resolvedPages.set(load, Page);
        if (live) setState({ Page });
      },
      () => {
        if (live) setState('error');
      },
    );
    return () => {
      live = false;
    };
  }, [load, attempt]);
  if (state === 'loading')
    return (
      <p role="status" aria-busy="true">
        Loading page…
      </p>
    );
  if (state === 'error')
    return (
      <div role="alert">
        <p>This page could not be loaded.</p>
        <Button
          onClick={() => {
            setState('loading');
            setAttempt((value) => value + 1);
          }}
        >
          Try again
        </Button>
        <Button onClick={() => location.reload()}>Reload page</Button>
      </div>
    );
  return <state.Page />;
}
