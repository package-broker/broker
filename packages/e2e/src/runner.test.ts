import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { capabilities, requiredScenarioIds } from './capabilities.js';
import {
  layers,
  releaseCatalogue,
  releaseRequirements,
  runRelease,
  runScenarios,
} from './runner.js';
import type { Scenario, ScenarioResult } from './runner.js';

const scenario = (status: ScenarioResult['status'], options: Partial<Scenario> = {}): Scenario => ({
  id: 'fake-capability',
  layer: 'L',
  run: () => ({ status, reason: 'Fake scenario result.' }),
  ...options,
});

const required = { L: ['fake-capability'] } as const;
const catalogue = [{ id: 'fake-capability' }, { id: 'another-capability' }] as const;

describe('release runner', () => {
  it('passes a required scenario with its reason', async () => {
    expect(await runScenarios('L', [scenario('PASS')], required, catalogue)).toEqual({
      exitCode: 0,
      hostnameExceptions: [],
      results: [
        {
          id: 'fake-capability',
          layer: 'L',
          status: 'PASS',
          reason: 'Fake scenario result.',
          required: true,
        },
      ],
    });
  });

  it.each(['FAIL', 'NOT RUN'] as const)('fails a required %s scenario', async (status) => {
    const write = vi.fn();
    expect(
      await runRelease(['--', '--layer', 'L'], [scenario(status)], required, write, catalogue),
    ).toBe(1);
    expect(write).toHaveBeenCalledWith(`${status} [L] fake-capability: Fake scenario result.`);
  });

  it('fails an optional FAIL and permits an optional NOT RUN without calling it PASS', async () => {
    expect((await runScenarios('L', [scenario('FAIL')], {}, catalogue)).exitCode).toBe(1);
    const report = await runScenarios('L', [scenario('NOT RUN')], {}, catalogue);
    expect(report.exitCode).toBe(0);
    expect(report.results[0]?.status).toBe('NOT RUN');
  });

  it('reports every unregistered required id and fails the command', async () => {
    const write = vi.fn();
    expect(await runRelease(['--layer', 'L'], [], required, write, catalogue)).toBe(1);
    expect(write).toHaveBeenCalledWith(
      'NOT RUN [L] fake-capability: Required scenario is not registered for the selected layer.',
    );
  });

  it('executes only the selected layer and does not use another layer to satisfy a requirement', async () => {
    const run = vi.fn(() => ({ status: 'PASS' as const, reason: 'Executed.' }));
    const report = await runScenarios(
      'L',
      [scenario('PASS', { layer: 'X', run })],
      required,
      catalogue,
    );
    expect(run).not.toHaveBeenCalled();
    expect(report.exitCode).toBe(1);
    expect(report.results[0]?.status).toBe('NOT RUN');
  });

  it('awaits scenarios and continues after exceptions without exposing exception text', async () => {
    const report = await runScenarios(
      'L',
      [
        scenario('PASS', {
          run: () => {
            throw new Error('private exception detail');
          },
        }),
        scenario('PASS', {
          id: 'another-capability',
          run: async () => ({ status: 'PASS', reason: 'Async scenario completed.' }),
        }),
      ],
      required,
      catalogue,
    );
    expect(report.exitCode).toBe(1);
    expect(report.results.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: 'FAIL', reason: 'Scenario execution failed.' },
      { status: 'PASS', reason: 'Async scenario completed.' },
    ]);
  });

  it.each([
    undefined,
    { status: 'SKIP', reason: 'Unsupported status.' },
    { status: 'PASS', reason: '' },
    { status: 'NOT RUN', reason: '  ' },
  ])('fails malformed scenario results: %j', async (result) => {
    const report = await runScenarios(
      'L',
      [scenario('PASS', { run: () => result as ScenarioResult })],
      required,
      catalogue,
    );
    expect(report.exitCode).toBe(1);
    expect(report.results[0]?.reason).toBe('Scenario returned an invalid result.');
  });

  it('refuses duplicate registrations before executing them', async () => {
    const run = vi.fn(() => ({ status: 'PASS' as const, reason: 'Executed.' }));
    const write = vi.fn();
    expect(
      await runRelease(
        ['--layer', 'L'],
        [scenario('PASS', { run }), scenario('PASS', { run })],
        required,
        write,
        catalogue,
      ),
    ).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('FAIL: Invalid scenario registration.');
  });

  it.each(layers)(
    'rejects an unknown capability in layer %s before running scenarios',
    async (layer) => {
      const run = vi.fn(() => ({ status: 'PASS' as const, reason: 'Executed.' }));
      const scenarios = [
        scenario('PASS', { run }),
        scenario('PASS', { id: 'unknown', layer, run }),
      ];
      const write = vi.fn();
      await expect(runScenarios('L', scenarios, {}, catalogue)).rejects.toThrow(
        'InvalidScenarioRegistration',
      );
      expect(await runRelease(['--layer', 'L'], scenarios, {}, write, catalogue)).toBe(1);
      expect(run).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledExactlyOnceWith('FAIL: Invalid scenario registration.');
    },
  );

  it('rejects invented registrations against the default catalogue', async () => {
    const run = vi.fn(() => ({ status: 'PASS' as const, reason: 'Executed.' }));
    const write = vi.fn();
    expect(await runRelease(['--layer', 'L'], [scenario('PASS', { run })], {}, write)).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledExactlyOnceWith('FAIL: Invalid scenario registration.');
  });

  it.each(layers)('accepts layer %s', async (layer) => {
    expect(
      await runRelease(['--layer', layer], [scenario('PASS', { layer })], {}, vi.fn(), catalogue),
    ).toBe(0);
  });

  it.each([[], ['--layer'], ['--layer', 'D'], ['--layer', 'L', 'extra'], ['--other', 'L']])(
    'rejects invalid arguments: %j',
    async (...args) => {
      const write = vi.fn();
      expect(await runRelease(args, [], {}, write)).toBe(1);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    },
  );

  it('does not certify an empty selected layer', async () => {
    const write = vi.fn();
    expect(await runRelease(['--layer', 'L'], [], {}, write)).toBe(1);
    expect(write).toHaveBeenCalledWith(
      'NOT RUN [L]: No scenarios registered for the selected layer.',
    );
  });

  it('runs the source CLI with Node and returns a nonzero process status for an empty suite', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        fileURLToPath(new URL('./runner.ts', import.meta.url)),
        '--',
        '--layer',
        'L',
      ],
      { encoding: 'utf8' },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toBe('');
    expect(child.stdout).toContain('NOT RUN [L]: No scenarios registered');
  });

  it('recognizes a relative entry path without relying on import.meta.main', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--input-type=module',
        '--eval',
        "process.argv = [process.execPath, './runner.ts', '--layer', 'L']; await import('./runner.ts');",
      ],
      { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' },
    );
    expect(child.status).toBe(1);
    expect(child.stderr).toBe('');
    expect(child.stdout).toContain('NOT RUN [L]: No scenarios registered');
  });

  it('does not run the CLI when imported without an entry path', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--input-type=module',
        '--eval',
        "await import('./runner.ts');",
      ],
      { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('');
  });
});

describe('runner with the release contract', () => {
  it.each(layers)(
    'reports hostname exceptions separately from evidence for layer %s',
    async (layer) => {
      const scenarios = requiredScenarioIds(layer).map((id) => scenario('PASS', { id, layer }));
      const report = await runScenarios(layer, scenarios);
      const expectedIds = {
        U: [],
        L: [],
        B: ['sso-access-edge'],
        C: ['sso-access-edge', 'authz-cache-revocation', 'authz-cache-revocation', 'tls-host'],
        H: ['authz-cache-revocation', 'tls-host'],
        X: ['sso-access-edge'],
        R: [],
      };
      expect(report.exitCode).toBe(0);
      expect(report.hostnameExceptions.map(({ id }) => id)).toEqual(expectedIds[layer]);
      expect(report.results).toHaveLength(scenarios.length);
      const write = vi.fn();
      expect(await runRelease(['--layer', layer], scenarios, undefined, write)).toBe(0);
      for (const exception of report.hostnameExceptions) {
        const entry = capabilities.find(({ id }) => id === exception.id)!;
        expect(exception).not.toHaveProperty('status');
        if (exception.kind === 'deferred') {
          expect(exception).toEqual({ id: entry.id, layer, kind: 'deferred', ...entry.deferral });
          expect(exception.reason).toBe('needs-custom-hostname');
          expect(exception.backlogId).toBe('PB-132');
          expect(write).toHaveBeenCalledWith(
            `INFO [${layer}] ${entry.id}: Deferred (${exception.reason}; ${exception.backlogId}). ${exception.claim}`,
          );
        } else {
          expect(exception).toEqual({ id: entry.id, layer, kind: 'moved', ...entry.hostnameMove });
          expect(write).toHaveBeenCalledWith(
            `INFO [${layer}] ${entry.id}: Moved ${exception.from} -> ${exception.to}. ${exception.reason}`,
          );
        }
      }
      expect(write.mock.calls.filter(([line]) => line.startsWith('INFO '))).toHaveLength(
        expectedIds[layer].length,
      );
    },
  );

  it('uses the real catalogue and its requirements by default', () => {
    expect(releaseCatalogue).toBe(capabilities);
    for (const layer of layers) {
      expect(releaseRequirements[layer]).toEqual(requiredScenarioIds(layer));
    }
  });

  it.each(layers)('requires complete real evidence for layer %s', async (layer) => {
    const scenarios: Scenario[] = requiredScenarioIds(layer).map((id) =>
      scenario('PASS', { id, layer }),
    );
    expect((await runScenarios(layer, scenarios)).exitCode).toBe(0);
    const missing = scenarios.slice(1);
    expect((await runScenarios(layer, missing)).exitCode).toBe(1);
    expect((await runScenarios(layer, missing, {})).exitCode).toBe(1);
    expect(
      (
        await runScenarios(layer, [
          ...missing,
          scenario('NOT RUN', { id: scenarios[0]!.id, layer }),
        ])
      ).exitCode,
    ).toBe(1);
  });

  it.each(layers)('refuses misspelled ids in layer %s before any execution', async (layer) => {
    const run = vi.fn(() => ({ status: 'PASS' as const, reason: 'Executed.' }));
    await expect(
      runScenarios('L', [
        scenario('PASS', { id: 'install-composer', run }),
        scenario('PASS', { id: 'install-composerr', layer, run }),
      ]),
    ).rejects.toThrow('InvalidScenarioRegistration');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses real ids registered for an unsupported layer', async () => {
    const run = vi.fn(() => ({ status: 'PASS' as const, reason: 'Executed.' }));
    await expect(
      runScenarios('L', [scenario('PASS', { id: 'workers-cpu', layer: 'L', run })]),
    ).rejects.toThrow('InvalidScenarioRegistration');
    expect(run).not.toHaveBeenCalled();
  });

  it('enforces cut-over requirements supplied from the real catalogue', async () => {
    const scenarios = requiredScenarioIds('R').map((id) => scenario('PASS', { id, layer: 'R' }));
    const requirements = { R: requiredScenarioIds('R', { beforeCutover: true }) };
    expect((await runScenarios('R', scenarios, requirements)).exitCode).toBe(1);
    expect(
      (
        await runScenarios(
          'R',
          [...scenarios, scenario('PASS', { id: 'restore-rehearsal', layer: 'R' })],
          requirements,
        )
      ).exitCode,
    ).toBe(0);
  });

  it('never reports PASS for a deferred capability or hostname-dependent leg', async () => {
    for (const entry of capabilities) {
      for (const layer of entry.gate.D ?? []) {
        const scenarios = [
          ...requiredScenarioIds(layer).map((id) => scenario('PASS', { id, layer })),
          scenario('PASS', { id: entry.id, layer }),
        ];
        const report = await runScenarios(layer, scenarios);
        expect(report.exitCode).toBe(1);
        expect(report.results.find(({ id }) => id === entry.id)).toMatchObject({
          status: 'FAIL',
          reason: 'Deferred evidence cannot pass.',
        });
        const skipped = await runScenarios(layer, [
          ...scenarios.slice(0, -1),
          scenario('NOT RUN', { id: entry.id, layer }),
        ]);
        expect(skipped.exitCode).toBe(1);
        expect(skipped.results.find(({ id }) => id === entry.id)?.status).toBe('NOT RUN');
      }
    }
  });
});
