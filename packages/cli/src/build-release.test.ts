import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrokerConfig } from '@package-broker/core';
import { validateAuditBuild, resolveOrgAudit } from '@package-broker/core/audit/effective';
import { resolveAuditDestination } from '@package-broker/core/audit/sinks/transport';
import { afterEach, expect, it, vi } from 'vitest';
import { build } from './build.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it.each(['node', 'cloudflare'] as const)(
  'compiles the release audit plugins for %s and resolves their runtime environment',
  async (target) => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'pb-release-audit-')));
    directories.push(directory);
    const runtimeEntry = path.join(directory, 'runtime.ts');
    await writeFile(
      runtimeEntry,
      "export { plugins, audit, platformPorts } from '#pb-manifest';\n",
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await build({
      cwd: root,
      configPath: 'broker.config.ts',
      target,
      outDir: path.join(directory, target),
      runtimeEntry,
    });
    const manifest = JSON.parse(await readFile(result.manifestJson, 'utf8'));
    expect(manifest.audit).toMatchObject({
      policy: 'availability',
      trail: { plugin: 'audit-trail', toggleEnv: 'PB_AUDIT_TRAIL' },
      sinks: [
        { id: 'otlp', activation: 'env', custody: 'delivery' },
        { id: 'webhook', activation: 'env', custody: 'delivery' },
      ],
      acceptNoDurableAudit: false,
      maxJournalBytes: target === 'node' ? null : 4 * 1024 ** 3,
    });
    for (const kind of ['trail', 'otlp', 'webhook'])
      expect(Object.keys(result.metafile.inputs)).toContainEqual(
        expect.stringMatching(new RegExp(`plugin-audit-${kind}/dist/`)),
      );
    if (target === 'node')
      expect(warning).toHaveBeenCalledWith(
        'warning: audit.capacity.maxJournalBytes: unset; Node audit capacity enforcement is disabled',
      );
    else
      expect(warning).not.toHaveBeenCalledWith(
        'warning: audit.capacity.maxJournalBytes: unset; Node audit capacity enforcement is disabled',
      );
    const loaded = await import(pathToFileURL(result.bundle).href);
    const audit = { ...loaded.audit };
    delete audit.build_generation;
    const config: BrokerConfig = {
      platform: target,
      plugins: loaded.plugins,
      audit,
      platformPorts: { [target]: loaded.platformPorts },
    };
    const fetchImpl = vi.fn<typeof fetch>();
    const resolve = async (variables: Record<string, string>) => {
      const env = (name: string) => variables[name];
      const sinks = await Promise.all(
        config.plugins.flatMap((plugin) =>
          (plugin.auditSinks ?? []).map(async (sink) => {
            const destination = await resolveAuditDestination({
              ...sink,
              env,
              runtime: target === 'node' ? 'docker' : 'cloudflare',
              fetchImpl,
            });
            return {
              id: sink.id,
              state: destination === null ? ('inactive' as const) : ('active' as const),
              source: destination?.activationSource ?? null,
            };
          }),
        ),
      );
      return {
        sinks,
        resolved: resolveOrgAudit({
          build: validateAuditBuild(config, env, target),
          storedPolicy: null,
          sinks,
          alertPathActive: false,
        }),
      };
    };
    expect(await resolve({})).toMatchObject({
      sinks: [
        { id: 'otlp', state: 'inactive', source: null },
        { id: 'webhook', state: 'inactive', source: null },
      ],
      resolved: { ok: true, effective: { mode: 'trail', trailActive: true, activeSinkIds: [] } },
    });
    for (const [name, headers, id] of [
      ['PB_AUDIT_OTLP_ENDPOINT', 'PB_AUDIT_OTLP_HEADERS', 'otlp'],
      ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_HEADERS', 'otlp'],
      ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'otlp'],
      ['PB_AUDIT_WEBHOOK_URL', 'PB_AUDIT_WEBHOOK_HEADERS', 'webhook'],
    ] as const) {
      const activated = await resolve({
        [name]: 'https://receiver.example/audit',
        [headers]: 'x-audit-client=release-test',
      });
      expect(activated.sinks.find((sink) => sink.id === id)).toMatchObject({
        state: 'active',
        source: name,
      });
      expect(activated.resolved).toMatchObject({
        ok: true,
        effective: { mode: 'trail', activeSinkIds: [id] },
      });
    }
    expect((await resolve({ PB_AUDIT_TRAIL: 'off' })).resolved).toMatchObject({
      ok: false,
      code: 'none_not_accepted',
    });
    expect(
      (await resolve({ PB_AUDIT_TRAIL: 'off', PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT: 'true' })).resolved,
    ).toMatchObject({ ok: true, effective: { mode: 'none', trailActive: false } });
    expect(
      (
        await resolve({
          PB_AUDIT_TRAIL: 'off',
          PB_AUDIT_WEBHOOK_URL: 'https://receiver.example/audit',
          PB_AUDIT_WEBHOOK_HEADERS: 'x-audit-client=release-test',
        })
      ).resolved,
    ).toMatchObject({
      ok: true,
      effective: { mode: 'export', trailActive: false, activeSinkIds: ['webhook'] },
    });
    await expect(resolve({ PB_AUDIT_TRAIL: 'false' })).rejects.toMatchObject({
      code: 'invalid_trail_env',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);
