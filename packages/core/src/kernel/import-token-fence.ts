import { authenticatedTokenActor } from '../authz/access-context.js';
import { tokenMutationFence, type TokenMutationFence } from '../authz/fence.js';
import type { RequestContext } from '../plugin.js';

export async function importWriteTokenFence(ctx: RequestContext): Promise<TokenMutationFence> {
  const actor = authenticatedTokenActor(ctx);
  if (actor === undefined) throw new TypeError('import write requires an authenticated token');
  return tokenMutationFence(actor, 'org:import:write', {});
}
