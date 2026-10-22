import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capability, Layer } from './capabilities.js';

// The native Node source CLI and compiled CLI use different module extensions.
const contractUrl = new URL(
  import.meta.url.endsWith('.ts') ? './capabilities.ts' : './capabilities.js',
  import.meta.url,
);
const { capabilities, layers, requiredScenarioIds } = (await import(
  contractUrl.href
)) as typeof import('./capabilities.js');

export { layers };
export type { Layer } from './capabilities.js';

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
export type CapabilityCatalogue = readonly {
  readonly id: string;
  readonly layers?: readonly Layer[];
  readonly gate?: Capability['gate'];
  readonly deferral?: Capability['deferral'];
  readonly hostnameMove?: Capability['hostnameMove'];
}[];

export const releaseCatalogue: CapabilityCatalogue = capabilities;

export interface ScenarioReport extends ScenarioResult {
  id: string;
  layer: Layer;
  required: boolean;
}

export type HostnameException = { readonly id: string; readonly layer: Layer } & (
  | ({ readonly kind: 'deferred' } & NonNullable<Capability['deferral']>)
  | ({ readonly kind: 'moved' } & NonNullable<Capability['hostnameMove']>)
);

export interface RunReport {
  results: ScenarioReport[];
  hostnameExceptions: HostnameException[];
  exitCode: 0 | 1;
}

export async function runScenarios(
  layer: Layer,
  scenarios: readonly Scenario[],
  requirements: Requirements = releaseRequirements,
  catalogue: CapabilityCatalogue = releaseCatalogue,
): Promise<RunReport> {
  const byId = new Map(catalogue.map((entry) => [entry.id, entry]));
  if (
    scenarios.some(({ id, layer: registeredLayer }) => {
      const entry = byId.get(id);
      return !id.trim() || !entry || (entry.layers && !entry.layers.includes(registeredLayer));
    }) ||
    Object.entries(requirements).some(([requiredLayer, ids]) =>
      ids.some((id) => {
        const entry = byId.get(id);
        return (
          !entry ||
          (entry.layers && !entry.layers.includes(requiredLayer as Layer)) ||
          entry.gate?.D?.includes(requiredLayer as Layer)
        );
      }),
    )
  ) {
    throw new Error('InvalidScenarioRegistration');
  }
  const selected = scenarios.filter((scenario) => scenario.layer === layer);
  const required = new Set([
    ...(catalogue === releaseCatalogue ? requiredScenarioIds(layer) : []),
    ...(requirements[layer] ?? []),
  ]);
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
        if (reported.status === 'PASS' && byId.get(scenario.id)?.gate?.D?.includes(layer)) {
          result = { status: 'FAIL', reason: 'Deferred evidence cannot pass.' };
        }
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
      (result) =>
        result.status === 'FAIL' ||
        (result.required && result.status !== 'PASS') ||
        byId.get(result.id)?.gate?.D?.includes(layer),
    );
  const hostnameExceptions: HostnameException[] = [];
  for (const entry of catalogue) {
    if (entry.deferral?.reason === 'needs-custom-hostname' && entry.gate?.D?.includes(layer)) {
      hostnameExceptions.push({ id: entry.id, layer, kind: 'deferred', ...entry.deferral });
    }
    if (
      entry.hostnameMove &&
      (entry.hostnameMove.from === layer || entry.hostnameMove.to === layer)
    ) {
      hostnameExceptions.push({ id: entry.id, layer, kind: 'moved', ...entry.hostnameMove });
    }
  }
  return { results, hostnameExceptions, exitCode: failed ? 1 : 0 };
}

export const releaseScenarios: readonly Scenario[] = [
  {
    id: 'mirror-proxy-assembly',
    layer: 'L',
    async run() {
      const url = new URL(
        import.meta.url.endsWith('.ts') ? '../dist/registry.spec.js' : './registry.spec.js',
        import.meta.url,
      );
      const { runRegistryAssembly } = (await import(
        url.href
      )) as typeof import('./registry.spec.js');
      return runRegistryAssembly();
    },
  },
];
export const releaseRequirements: Requirements = Object.fromEntries(
  layers.map((layer) => [layer, requiredScenarioIds(layer)]),
);

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
    if (scenarios.every((scenario) => scenario.layer !== layer)) {
      write(`NOT RUN [${layer}]: No scenarios registered for the selected layer.`);
    }
    for (const result of report.results) {
      write(`${result.status} [${result.layer}] ${result.id}: ${result.reason}`);
    }
    for (const exception of report.hostnameExceptions) {
      const detail =
        exception.kind === 'deferred'
          ? `Deferred (${exception.reason}; ${exception.backlogId}). ${exception.claim}`
          : `Moved ${exception.from} -> ${exception.to}. ${exception.reason}`;
      write(`INFO [${exception.layer}] ${exception.id}: ${detail}`);
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
