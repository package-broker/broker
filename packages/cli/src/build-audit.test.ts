import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { build } from './build.js';

let cwd: string;
let configPath: string;
let runtimeEntry: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'pb-audit-build-'));
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(cwd, 'node_modules'),
    'dir',
  );
  configPath = path.join(cwd, 'config.ts');
  runtimeEntry = path.join(cwd, 'runtime.ts');
  await writeFile(runtimeEntry, "export { plugins, audit } from '#pb-manifest';\n");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});

const capacity = { maxJournalBytes: 67108864 };
const sink = (custody = 'durable') => `{
  id: 'archive', package: '@package-broker/core', apiVersion: 4, platforms: ['node', 'cloudflare'],
  auditSinks: [{ id: 'archive', kind: 'webhook', activation: 'env', custody: '${custody}',
    sourceIp: 'omit', envNames: ['ARCHIVE_REGION'],
    destination: { protocol: 'https-json', urlEnv: 'ARCHIVE_URL', headersEnv: 'ARCHIVE_HEADERS' },
    create: () => ({ deliver: async () => ({ outcome: 'retry', code: 'network' }) }) }]
}`;
async function config(audit?: unknown, plugins = '[]', platform = 'cloudflare') {
  await writeFile(
    configPath,
    `export default { platform: '${platform}', plugins: ${plugins}, audit: ${JSON.stringify(audit)} };\n`,
  );
}
async function run() {
  return build({ cwd, configPath, runtimeEntry });
}
async function manifest(result: Awaited<ReturnType<typeof run>>) {
  return JSON.parse(await readFile(result.manifestJson, 'utf8')) as {
    plugins: { id: string }[];
    audit: {
      trail: unknown;
      sinks: unknown[];
      build_generation: number;
      maxJournalBytes: number | null;
      acceptNoDurableAudit: boolean;
    };
  };
}

it.each(['node', 'cloudflare'])(
  'adds the trail to an old %s config and both manifests',
  async (platform) => {
    await config(platform === 'node' ? { capacity } : undefined, '[]', platform);
    const result = await run();
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs).toContainEqual(expect.stringMatching(/packages\/core\/dist\//));
    expect(inputs).toContainEqual(expect.stringMatching(/packages\/plugin-audit-trail\/dist\//));
    expect(inputs.some((input) => input.startsWith('pb-dependency:'))).toBe(false);
    const json = await manifest(result);
    const loaded = (await import(pathToFileURL(result.bundle).href)) as {
      plugins: { id: string }[];
      audit: { build_generation: number };
    };
    expect(json.plugins.map(({ id }) => id)).toEqual(['audit-trail']);
    expect(loaded.plugins.map(({ id }) => id)).toEqual(['audit-trail']);
    expect(json.audit.trail).toEqual({ plugin: 'audit-trail', toggleEnv: 'PB_AUDIT_TRAIL' });
    expect(json.audit.maxJournalBytes).toBe(
      platform === 'node' ? capacity.maxJournalBytes : 4 * 1024 ** 3,
    );
    expect(Number.isSafeInteger(json.audit.build_generation)).toBe(true);
    expect(loaded.audit.build_generation).toBe(json.audit.build_generation);
    expect(json.audit).not.toHaveProperty('mode_generation');
    expect((await manifest(await run())).audit.build_generation).toBeGreaterThan(
      json.audit.build_generation,
    );
    await config({ capacity: { maxJournalBytes: 134217728 } }, '[]', platform);
    expect((await manifest(await run())).audit.build_generation).not.toBe(
      json.audit.build_generation,
    );
  },
);

it('keeps explicit mode none builds without adding the trail', async () => {
  await config({ acceptNoDurableAudit: true });
  const json = await manifest(await run());
  expect(json.plugins).toEqual([]);
  expect(json.audit).toMatchObject({ trail: null, sinks: [], acceptNoDurableAudit: true });
});

it('resolves the default trail from a manifest beneath a symlinked output directory', async () => {
  await config();
  const output = path.join(cwd, 'output');
  const linkedOutput = path.join(cwd, 'linked-output');
  await mkdir(output);
  await symlink(output, linkedOutput, 'dir');
  const result = await build({ configPath, runtimeEntry, outDir: linkedOutput });
  const loaded = await import(pathToFileURL(result.bundle).href);
  expect(loaded.plugins.map(({ id }: { id: string }) => id)).toEqual(['audit-trail']);
});

it('drops an unused core module with top-level schema construction from a real bundle', async () => {
  await config({ acceptNoDurableAudit: true });
  runtimeEntry = path.join(cwd, 'runtime.js');
  await writeFile(
    runtimeEntry,
    "import { generateOpenApi } from '@package-broker/core/api/openapi';\nexport const kept = 'runtime';\n",
  );
  const result = await run();
  const emittedInputs = Object.values(result.metafile.outputs).flatMap((output) =>
    Object.keys(output.inputs),
  );
  expect(Object.keys(result.metafile.inputs)).toContainEqual(
    expect.stringMatching(/packages\/core\/dist\/api\/openapi\.js$/),
  );
  expect(emittedInputs).not.toContainEqual(
    expect.stringMatching(/packages\/core\/dist\/api\/openapi\.js$/),
  );
  expect(await readFile(result.bundle, 'utf8')).not.toContain('ERROR_ENVELOPE');
  expect(await import(pathToFileURL(result.bundle).href)).toMatchObject({ kept: 'runtime' });
});

it('keeps exporter-only composition and describes its declared variables', async () => {
  await config(undefined, `[${sink()}]`);
  const json = await manifest(await run());
  expect(json.plugins.map(({ id }) => id)).toEqual(['archive']);
  expect(json.audit.trail).toBeNull();
  expect(json.audit.sinks).toEqual([
    {
      id: 'archive',
      plugin: 'archive',
      kind: 'webhook',
      activation: 'env',
      custody: 'durable',
      envNames: ['ARCHIVE_REGION'],
      destination: { protocol: 'https-json', urlEnv: 'ARCHIVE_URL', headersEnv: 'ARCHIVE_HEADERS' },
    },
  ]);
});

it('does not duplicate an explicit trail and prints required-policy warnings', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await config(
    { policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } },
    `[{ id: 'custom-trail', package: '@package-broker/core', apiVersion: 4,
    platforms: ['cloudflare'], binds: ['audit-trail'], auditTrail: { toggleEnv: 'TRAIL_SWITCH',
    create: () => ({ handle: async () => ({ error: 'audit_trail_unavailable' }) }) } }]`,
  );
  expect((await manifest(await run())).plugins.map(({ id }) => id)).toEqual(['custom-trail']);
  expect(warn).toHaveBeenCalledWith(
    'warning: audit: trail toggleEnv is ignored under required policy',
  );
});

it.each([
  [
    'required without durable custody',
    { policy: 'required', alerts: { webhookEnv: 'ALERT_URL' } },
    `[${sink('delivery')}]`,
    'cloudflare',
    'audit: required policy needs a durable path',
  ],
  [
    'required with acceptance',
    { policy: 'required', acceptNoDurableAudit: true },
    '[]',
    'cloudflare',
    'required policy forbids acceptNoDurableAudit',
  ],
  [
    'required without alerts',
    { policy: 'required' },
    '[]',
    'cloudflare',
    'required policy needs a telemetry OTLP endpoint',
  ],
  ['undersized budget', { capacity: { maxJournalBytes: 1 } }, '[]', 'node', 'at least 64 MiB'],
  ['duplicate sinks', undefined, `[${sink()}, ${sink()}]`, 'cloudflare', 'duplicate sink id'],
] as const)(
  'refuses %s before writing a manifest',
  async (_label, audit, plugins, platform, message) => {
    await config(audit, plugins, platform);
    await expect(run()).rejects.toThrow(message);
    await expect(
      readFile(path.join(cwd, '.pb', platform, 'generated', 'manifest.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('uses SOURCE_DATE_EPOCH in both manifests', async () => {
  vi.stubEnv('SOURCE_DATE_EPOCH', '1793404800');
  await config();
  const result = await run();
  const json = await manifest(result);
  const loaded = await import(pathToFileURL(result.bundle).href);
  expect(json.audit.build_generation).toBe(1793404800000);
  expect(Number.isSafeInteger(json.audit.build_generation)).toBe(true);
  expect(loaded.audit.build_generation).toBe(json.audit.build_generation);
});

it.each(['invalid', '-1', '9007199254740991'])(
  'refuses unsafe SOURCE_DATE_EPOCH %s',
  async (epoch) => {
    vi.stubEnv('SOURCE_DATE_EPOCH', epoch);
    await config();
    await expect(run()).rejects.toThrow('Invalid audit build generation');
  },
);

it('warns and builds the default Node trail without a budget', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await config(undefined, '[]', 'node');
  const result = await run();
  expect((await manifest(result)).audit.maxJournalBytes).toBeNull();
  expect(warn).toHaveBeenCalledWith(
    'warning: audit.capacity.maxJournalBytes: unset; Node audit capacity enforcement is disabled',
  );
  expect(
    Object.keys(result.metafile.inputs).some((input) =>
      /plugin-audit-trail\/(?:src|dist)\//.test(input),
    ),
  ).toBe(true);
  expect(Object.keys(result.metafile.inputs)).not.toContain(
    expect.stringContaining('generated/audit-trail.js'),
  );
  const coreFiles = Object.keys(result.metafile.inputs).flatMap((input) => {
    const match = /(?:packages\/core|@package-broker\/core)\/(?:src|dist)\/(.+)/.exec(input);
    return match ? [match[1]] : [];
  });
  expect(coreFiles.length).toBeGreaterThan(0);
  expect(new Set(coreFiles).size).toBe(coreFiles.length);
});

it('warns and builds an explicit Node trail without a budget', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await writeFile(
    configPath,
    `import { auditTrail } from '@package-broker/plugin-audit-trail';
export default { platform: 'node', plugins: [auditTrail()] };\n`,
  );
  const result = await run();
  expect((await manifest(result)).plugins).toMatchObject([{ id: 'audit-trail' }]);
  expect((await manifest(result)).audit.maxJournalBytes).toBeNull();
  expect(warn).toHaveBeenCalledWith(
    'warning: audit.capacity.maxJournalBytes: unset; Node audit capacity enforcement is disabled',
  );
});

it('refuses the reserved trail id without a trail definition with a fixed error', async () => {
  await config(
    undefined,
    `[{ id: 'audit-trail', package: '@package-broker/core', apiVersion: 4, platforms: ['cloudflare'] }]`,
  );
  await expect(run()).rejects.toThrow(
    'invalid broker config: audit-trail id requires a trail definition',
  );
});
