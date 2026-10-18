import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Package Broker</h1>
    </main>
  </StrictMode>,
);
