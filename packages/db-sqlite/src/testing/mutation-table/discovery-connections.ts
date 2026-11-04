import { expect } from 'vitest';
import { createDiscoveryConnections } from '../../repositories/discovery-connections.js';
import { executing } from './factory-cases.js';
import { orgOf, seeder, type MutationEntry } from './harness.js';

const aliases = ['s', 'c'] as const;
const guards = [
  {
    name: 'source owner',
    pattern: /s\.project_id IS NULL/,
    change: "UPDATE source SET project_id='P' WHERE id='DS'",
  },
  {
    name: 'credential owner',
    pattern: /c\.project_id IS NULL/,
    change: "UPDATE credential SET project_id='P' WHERE id='APP'",
  },
  {
    name: 'credential kind',
    pattern: /c\.kind = 'github_app'/,
    change: "UPDATE credential SET kind='bearer' WHERE id='APP'",
  },
  {
    name: 'source type',
    pattern: /s\.type = 'vcs'/,
    change: "UPDATE source SET type='composer_repository' WHERE id='DS'",
  },
  {
    name: 'GitHub provider',
    pattern: /json_extract\(s\.config_json, '\$\.provider'\) = 'github'/,
    config: { provider: 'git', installationId: 42 },
  },
  {
    name: 'integer installation',
    pattern: /json_type\(s\.config_json, '\$\.installationId'\) = 'integer'/,
    config: { provider: 'github', installationId: 42.5 },
  },
  {
    name: 'positive installation',
    pattern: /json_extract\(s\.config_json, '\$\.installationId'\) >= 1/,
    config: { provider: 'github', installationId: 0 },
  },
  {
    name: 'safe installation',
    pattern: /json_extract\(s\.config_json, '\$\.installationId'\) <= 9007199254740991/,
    config: { provider: 'github', installationId: 9007199254740992 },
  },
];
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/discovery-connections.ts',
    builder: 'createDiscoveryConnections',
    cases: aliases.map((alias) => ({
      name: `connections excludes foreign ${alias}`,
      async run(context) {
        const { own, foreign } = orgOf(context);
        const seed = seeder(context.executor);
        await seed(
          "INSERT INTO credential(id,org_id,kind,ciphertext,nonce,key_version,aad) VALUES ('APP',?,'github_app',X'00',zeroblob(12),1,'unused')",
          alias === 'c' ? foreign.orgId : own.orgId,
        );
        await seed.forged(
          "INSERT INTO source(id,org_id,name,type,ecosystem,credential_id,config_json) VALUES ('DS',?,'Acme','vcs','npm','APP',?)",
          alias === 's' ? foreign.orgId : own.orgId,
          JSON.stringify({ provider: 'github', installationId: 42 }),
        );
        await expect(createDiscoveryConnections(executing(context)).list(own)).resolves.toEqual([]);
      },
    })),
    sqlDecisions: guards.map((guard) => ({
      name: guard.name,
      pattern: guard.pattern,
      replacement: '1=1',
      expected: 1,
      case: {
        name: `connections require ${guard.name}`,
        async run(context) {
          const { own } = orgOf(context);
          const seed = seeder(context.executor);
          await seed(
            "INSERT INTO project(id,org_id,name,slug) VALUES ('P',?,'Project','project')",
            own.orgId,
          );
          await seed(
            "INSERT INTO credential(id,org_id,kind,ciphertext,nonce,key_version,aad) VALUES ('APP',?,'github_app',X'00',zeroblob(12),1,'unused')",
            own.orgId,
          );
          await seed(
            "INSERT INTO source(id,org_id,name,type,ecosystem,credential_id,config_json) VALUES ('DS',?,'Acme','vcs','npm','APP',?)",
            own.orgId,
            JSON.stringify(guard.config ?? { provider: 'github', installationId: 42 }),
          );
          if (guard.change) await seed(guard.change);
          await expect(createDiscoveryConnections(executing(context)).list(own)).resolves.toEqual(
            [],
          );
        },
      },
    })),
    predicates: aliases.map((alias) => ({
      name: `${alias} organization`,
      caseName: `connections excludes foreign ${alias}`,
      locate: new RegExp(`${alias}\\.org_id = \\?`),
      neutral: '(? is not null)',
    })),
  },
];
