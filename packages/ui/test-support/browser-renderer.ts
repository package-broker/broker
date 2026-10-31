import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { browserRequired, createBrowserFixture } from './browser-fixture.js';

export async function browserRenderer(contents: string) {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; ${contents}`,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const fixture = await createBrowserFixture({ required: browserRequired() });
  return { fixture, script: bundle.outputFiles[0]!.text };
}
