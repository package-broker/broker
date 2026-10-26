import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const OverlayContext = createContext<HTMLElement | null | undefined>(undefined);
const documentHosts = new WeakMap<Document, { element: HTMLDivElement; users: number }>();

export function OverlayHost({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <OverlayContext.Provider value={host}>
      {children}
      <div data-overlay-host ref={setHost} />
    </OverlayContext.Provider>
  );
}

export function useOverlayHost() {
  const inherited = useContext(OverlayContext);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (inherited !== undefined) return;
    let shared = documentHosts.get(document);
    if (!shared) {
      const element = document.createElement('div');
      element.setAttribute('data-overlay-host', '');
      document.body.append(element);
      shared = { element, users: 0 };
      documentHosts.set(document, shared);
    }
    const owner = document;
    const acquired = shared;
    acquired.users++;
    setHost(acquired.element);
    return () => {
      if (--acquired.users === 0) {
        acquired.element.remove();
        documentHosts.delete(owner);
      }
    };
  }, [inherited]);
  return inherited === undefined ? host : inherited;
}
