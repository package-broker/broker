import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { layers, runRelease, runScenarios } from './runner.js';
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

  it('rejects registrations when no catalogue is available', async () => {
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
