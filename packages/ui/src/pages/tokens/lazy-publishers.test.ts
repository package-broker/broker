import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('includes the trusted publishers section and form in the Tokens static dependency graph', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../tokens.tsx', import.meta.url))],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    outdir: 'out',
    write: false,
    metafile: true,
  });
  const outputs = result.metafile.outputs;
  const entry = Object.keys(outputs).find((key) =>
    outputs[key]!.entryPoint?.endsWith('/tokens.tsx'),
  )!;
  const initial = new Set<string>();
  const visit = (key: string) => {
    if (initial.has(key)) return;
    initial.add(key);
    for (const dependency of outputs[key]!.imports) {
      if (dependency.kind !== 'dynamic-import') visit(dependency.path);
    }
  };
  visit(entry);
  const publisherOutputs = Object.entries(outputs).filter(([, output]) =>
    Object.keys(output.inputs).some((key) => key.endsWith('/tokens/trusted-publishers.tsx')),
  );
  expect(publisherOutputs).toHaveLength(1);
  expect(initial.has(publisherOutputs[0]![0])).toBe(true);
  expect(
    result.outputFiles.find((file) => file.path.endsWith(publisherOutputs[0]![0]))?.text,
  ).toContain('Save trusted publisher');
});
