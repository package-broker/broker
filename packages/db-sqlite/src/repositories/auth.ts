import type { AuthRepositories } from '@package-broker/core/auth/module';
import type { SqlExecutor } from '@package-broker/core/db/port';
import type { AccessLossOptions } from './access-loss.js';
import { createCredentialRepository } from './credential.js';
import { createLocalLoginReader } from './local-login.js';
import { createLocalLoginSetupWriter } from './local-login-setup.js';
import { createLocalLoginSuccessWriter } from './local-login-success.js';
import { createLoginWriter } from './login.js';
import { readProviderBinding } from './provider-binding.js';
import { createSessionRepository } from './session.js';
import { createUserRepository } from './user.js';

export function createAuthRepositories(
  executor: SqlExecutor,
  options: AccessLossOptions = {},
): AuthRepositories {
  return {
    bindings: {
      anchor: async (ctx, provider) =>
        (await readProviderBinding(executor, ctx, provider))?.anchor ?? null,
    },
    sessions: createSessionRepository(executor),
    users: createUserRepository(executor),
    login: createLoginWriter(executor, options),
    localReader: createLocalLoginReader(executor),
    localSetup: createLocalLoginSetupWriter(executor),
    localSuccess: createLocalLoginSuccessWriter(executor),
    credentials: createCredentialRepository(executor),
  };
}
