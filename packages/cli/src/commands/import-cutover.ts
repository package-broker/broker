import { runCutoverCheck, type CutoverOptions } from '../import/cutover.js';

export async function runImportCutover(
  options: CutoverOptions & { readonly json?: boolean },
): Promise<number> {
  const result = await runCutoverCheck(options);
  if (options.json) console.log(JSON.stringify(result));
  else {
    console.log(result.message);
    console.log(`Packages: old=${result.counts.old} new=${result.counts.new}`);
    for (const name of result.differences) console.log(`Resolution differs: ${name}`);
    for (const name of result.oldHostPackages) console.log(`Old download host: ${name}`);
    for (const check of result.historic) {
      console.log(`Historic lock ${check.index}: ${check.ok ? 'passed' : 'failed'}`);
      for (const name of check.missingPackages) console.log(`Missing package: ${name}`);
    }
  }
  return result.exitCode;
}
