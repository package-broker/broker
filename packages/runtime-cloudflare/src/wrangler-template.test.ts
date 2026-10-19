import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('parses the commented observability template with invocation logs under logs', async () => {
  const template = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const block = template.slice(
    template.indexOf('# [observability]'),
    template.indexOf('# [assets]'),
  );
  const sections: Record<string, Record<string, boolean>> = {};
  let section: Record<string, boolean> | undefined;
  for (const line of block.split('\n')) {
    const text = line.replace(/^#\s?/, '').trim();
    if (text === '') continue;
    const header = /^\[([a-z.]+)\]$/.exec(text);
    if (header?.[1] !== undefined) {
      section = {};
      sections[header[1]] = section;
      continue;
    }
    const setting = /^([a-z_]+) = (true|false)$/.exec(text);
    expect(setting, text).not.toBeNull();
    expect(section, text).toBeDefined();
    const key = setting?.[1];
    if (section !== undefined && key !== undefined) {
      expect(section).not.toHaveProperty(key);
      section[key] = setting?.[2] === 'true';
    }
  }
  expect(sections).toEqual({
    observability: { enabled: true },
    'observability.logs': { enabled: true, invocation_logs: false },
  });
});
