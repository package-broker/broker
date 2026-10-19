import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const layers = ['U', 'L', 'B', 'C', 'H', 'X', 'R'] as const;
export type Layer = (typeof layers)[number];

export interface ScenarioResult {
  status: 'PASS' | 'FAIL' | 'NOT RUN';
  reason: string;
}

export interface Scenario {
  id: string;
  layer: Layer;
  run: () => ScenarioResult | Promise<ScenarioResult>;
}

export type Requirements = Partial<Record<Layer, readonly string[]>>;
export type CapabilityCatalogue = readonly { readonly id: string }[];

export const releaseCatalogue: CapabilityCatalogue = [];

export interface ScenarioReport extends ScenarioResult {
  id: string;
  layer: Layer;
  required: boolean;
}

export interface RunReport {
  results: ScenarioReport[];
  exitCode: 0 | 1;
}

export async function runScenarios(
  layer: Layer,
  scenarios: readonly Scenario[],
  requirements: Requirements,
  catalogue: CapabilityCatalogue = releaseCatalogue,
): Promise<RunReport> {
  const capabilityIds = new Set(catalogue.map(({ id }) => id));
  if (scenarios.some(({ id }) => !id.trim() || !capabilityIds.has(id))) {
    throw new Error('InvalidScenarioRegistration');
  }
  const selected = scenarios.filter((scenario) => scenario.layer === layer);
  const required = new Set(requirements[layer] ?? []);
  const registered = new Set<string>();
  for (const scenario of selected) {
    if (registered.has(scenario.id)) {
      throw new Error('InvalidScenarioRegistration');
    }
    registered.add(scenario.id);
  }

  const results: ScenarioReport[] = [];
  for (const scenario of selected) {
    let result: ScenarioResult;
    try {
      const reported = await scenario.run();
      if (
        !reported ||
        !['PASS', 'FAIL', 'NOT RUN'].includes(reported.status) ||
        typeof reported.reason !== 'string' ||
        !reported.reason.trim()
      ) {
        result = { status: 'FAIL', reason: 'Scenario returned an invalid result.' };
      } else {
        result = { status: reported.status, reason: reported.reason };
      }
    } catch {
      result = { status: 'FAIL', reason: 'Scenario execution failed.' };
    }
    results.push({ ...result, id: scenario.id, layer, required: required.has(scenario.id) });
  }
  for (const id of required) {
    if (!registered.has(id)) {
      results.push({
        id,
        layer,
        required: true,
        status: 'NOT RUN',
        reason: 'Required scenario is not registered for the selected layer.',
      });
    }
  }

  const failed =
    results.length === 0 ||
    results.some(
      (result) => result.status === 'FAIL' || (result.required && result.status !== 'PASS'),
    );
  return { results, exitCode: failed ? 1 : 0 };
}

export const releaseScenarios: readonly Scenario[] = [];
export const releaseRequirements: Requirements = {};

export async function runRelease(
  args: readonly string[],
  scenarios: readonly Scenario[] = releaseScenarios,
  requirements: Requirements = releaseRequirements,
  write: (line: string) => void = console.log,
  catalogue: CapabilityCatalogue = releaseCatalogue,
): Promise<0 | 1> {
  const options = args[0] === '--' ? args.slice(1) : args;
  const layer = layers.find((candidate) => candidate === options[1]);
  if (options.length !== 2 || options[0] !== '--layer' || !layer) {
    write('FAIL: Usage: release -- --layer <U|L|B|C|H|X|R>');
    return 1;
  }

  try {
    const report = await runScenarios(layer, scenarios, requirements, catalogue);
    if (report.results.length === 0) {
      write(`NOT RUN [${layer}]: No scenarios registered for the selected layer.`);
    }
    for (const result of report.results) {
      write(`${result.status} [${result.layer}] ${result.id}: ${result.reason}`);
    }
    return report.exitCode;
  } catch {
    write('FAIL: Invalid scenario registration.');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRelease(process.argv.slice(2));
}
