import { readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  CloudflareError,
  cloudflareCredentials,
  commandEnvelope,
  failCommand,
  type CommandResult,
} from './api.js';
import {
  cleanupFailure,
  cleanupInventory,
  cleanupPath,
  expiredRun,
  teardown,
  type TeardownOptions,
} from './teardown.js';

export interface JanitorOptions extends Omit<
  TeardownOptions,
  'inventory' | 'inventoryId' | 'iUnderstandThisDeletes' | 'repositoryId'
> {
  inventory?: string;
  inventoryDirectory?: string;
  repositoryId: string;
}

export async function janitor(o: JanitorOptions): Promise<CommandResult> {
  const output = commandEnvelope('janitor', o.dryRun);
  let exitCode = 0;
  try {
    cloudflareCredentials(o.env);
    if (!/^[1-9][0-9]{0,19}$/.test(o.repositoryId)) throw new CloudflareError('invalid_input', 2);
    const project = await realpath(
      resolve(o.project ?? dirname(resolve(o.configPath ?? 'broker.config.ts'))),
    );
    const paths: string[] = [];
    if (o.inventory !== undefined) paths.push(resolve(project, o.inventory));
    else {
      const directory = resolve(project, o.inventoryDirectory ?? '.pb/state/cloudflare');
      const scan = async (path: string, depth: number): Promise<void> => {
        if (depth > 32 || paths.length > 10_000) throw new CloudflareError('unsafe_path', 2);
        await cleanupPath(project, path);
        let entries;
        try {
          entries = await readdir(path, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isSymbolicLink()) throw new CloudflareError('unsafe_path', 2);
          if (entry.isDirectory()) await scan(join(path, entry.name), depth + 1);
          else if (entry.name.endsWith('.json') && !entry.name.startsWith('lock.'))
            paths.push(join(path, entry.name));
        }
      };
      await scan(directory, 0);
    }
    for (const inventory of paths) {
      const options = { ...o, project, inventory };
      let result: CommandResult;
      try {
        const { journal } = await cleanupInventory(options);
        if (!expiredRun(journal, o.repositoryId, (o.now ?? Date.now)())) {
          output.checks.push({ name: 'inventory', status: 'skipped' });
          continue;
        }
        result = await teardown(options);
      } catch (error) {
        result = failCommand(
          commandEnvelope('teardown', o.dryRun),
          cleanupFailure(error, 'janitor'),
        );
      }
      output.checks.push(...result.output.checks);
      output.plan.push(...result.output.plan.map((entry) => ({ ...entry, stage: 'janitor' })));
      if (result.exitCode !== 0) {
        exitCode ||= result.exitCode;
        if (!output.error && result.output.error)
          output.error = { ...result.output.error, stage: 'janitor' };
      }
    }
    output.status = exitCode ? 'error' : o.dryRun ? 'planned' : 'ok';
    return { exitCode, output };
  } catch (error) {
    return failCommand(output, cleanupFailure(error, 'janitor'));
  }
}

export async function runCloudflareJanitor(o: JanitorOptions): Promise<number> {
  const result = await janitor(o);
  if (o.json || !result.output.error) console.log(JSON.stringify(result.output));
  else console.error(`${result.output.error.code}: ${result.output.error.message}`);
  return result.exitCode;
}
