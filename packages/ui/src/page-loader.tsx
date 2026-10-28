import { useEffect, useState, type ComponentType } from 'react';
import { Button } from './components/ui/button.js';

type PageState = { Page: ComponentType } | 'loading' | 'error';

export function PageLoader({ load }: { load: () => Promise<ComponentType> }) {
  const [state, setState] = useState<PageState>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void load().then(
      (Page) => {
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
        <p>This page could not be loaded. Try again.</p>
        <Button
          onClick={() => {
            setState('loading');
            setAttempt((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  return <state.Page />;
}
