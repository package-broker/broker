import { expect } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createDistTagStore } from '../../repositories/npm-dist-tags.js';
import { createUnpublishStore } from '../../repositories/npm-unpublish.js';
import { createPublishWriteGuard } from '../../repositories/catalogue-publish-guard.js';
import { seedSource, seedPackage, seedVersion, NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type MutationEntry, type ContractCase } from './harness.js';

export function managementEntry(kind: 'tags' | 'unpublish'): MutationEntry {
  const builder = kind === 'tags' ? 'createDistTagStore' : 'createUnpublishStore';
  const writeCases: ContractCase[] = ['p', 's', 'v', ...(kind === 'unpublish' ? ['time'] : [])].map(
    (alias) => ({
      name: `${builder} refuses a foreign ${alias}`,
      async run(context) {
        const { own, foreign } = orgOf(context);
        const seed = seeder(context.executor);
        const org = (table: string) => (table === alias ? foreign.orgId : own.orgId);
        await seedSource(seed.forged, 'MS', org('s'), 'hosted', 'npm');
        await seedPackage(seed.forged, 'MP', org('p'), 'MS', 'widget', 'npm');
        await seedVersion(seed.forged, 'MV', org('v'), 'MP', '1.0.0');
        if (alias !== 'time')
          await seed(
            "UPDATE version SET published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='MV'",
          );
        const binding = {
          tokenId: 'token',
          selector: 'abcdefghijkl',
          projectSlug: 'project',
          routeProjectId: 'project',
          sourceId: 'MS',
          key: 'widget',
          permission: 'project:packages:manage' as const,
        };
        const guard = createPublishWriteGuard(own, binding, []);
        // Isolate this builder's predicates; the delegated authorization guard has its own contracts.
        const executor: SqlExecutor = {
          driver: context.executor.driver,
          all: (statement) => context.executor.all(context.mutate(statement)),
          batch: (statements) =>
            context.executor.batch(context.mutateBatch(statements.slice(guard.length))),
        };
        const snapshot = {
          packageId: 'MP',
          rev: 1,
          createdAt: '',
          modifiedAt: '',
          tags: {},
          inactive: 0,
          versions: [
            {
              id: 'MV',
              revision: 1,
              version: '1.0.0',
              publishedAt: '',
              metadataJson: '{}',
              npmIntegrity: null,
              deprecatedMessage: null,
            },
          ],
        };
        const event = {
          id: ulid(),
          occurredAt: new Date().toISOString(),
          actor: { type: 'service_principal' as const, id: 'principal' },
          action: 'package.dist_tag' as const,
          target: { type: 'package' as const, id: 'MP' },
          projectId: null,
          tokenSelector: null,
          sourceIp: null,
          payloadJson: '{}',
        };
        const input = { ...binding, snapshot, event };
        const result =
          kind === 'tags'
            ? createDistTagStore(executor).update(own, guard, {
                ...input,
                tag: 'beta',
                version: '1.0.0',
              })
            : createUnpublishStore(executor).remove(own, guard, {
                ...input,
                versions: ['1.0.0'],
                whole: false,
              });
        await expect(result).rejects.toThrow();
      },
    }),
  );
  const readCases: ContractCase[] =
    kind === 'unpublish'
      ? ['p', 's', 'v'].map((alias) => ({
          name: `tarball confirmation refuses a foreign ${alias}`,
          async run(context) {
            const { own, foreign } = orgOf(context);
            const seed = seeder(context.executor);
            const org = (table: string) => (table === alias ? foreign.orgId : own.orgId);
            await seedSource(seed.forged, 'RS', org('s'), 'hosted', 'npm');
            await seedPackage(seed.forged, 'RP', org('p'), 'RS', 'widget', 'npm');
            await seedVersion(seed.forged, 'RV', org('v'), 'RP', '1.0.0');
            await seed(
              "UPDATE version SET status='tombstoned',tombstoned_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),tombstone_reason='npm_unpublish' WHERE id='RV'",
            );
            const executor: SqlExecutor = {
              driver: context.executor.driver,
              all: (statement) => context.executor.all(context.mutate(statement)),
              batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
            };
            expect(
              await createUnpublishStore(executor).tarballRemoved(
                own,
                'RS',
                'widget',
                'widget-1.0.0.tgz',
                1,
              ),
            ).toBe(false);
          },
        }))
      : [];
  return {
    builder,
    file: `repositories/npm-${kind === 'tags' ? 'dist-tags' : 'unpublish'}.ts`,
    cases: [...writeCases, ...readCases],
    ...(kind === 'unpublish'
      ? {
          sqlDecisions: [
            {
              name: '72 hour window is enforced by the database',
              pattern:
                /unixepoch\(v\.published_at,'subsec'\) between unixepoch\('now','subsec'\)-259200 and unixepoch\('now','subsec'\)/,
              replacement: '1',
              expected: 1,
              case: writeCases[3]!,
            },
          ],
        }
      : {}),
    predicates: [
      ...['p', 's', 'v'].map((alias, index) => ({
        name: `${alias} organization`,
        caseName: writeCases[index]!.name,
        locate: new RegExp(`(?<![\\w.])${alias}\\.org_id\\s*=\\s*\\?`),
        neutral: NOT_NULL,
        copies: kind === 'unpublish' && alias === 'v' ? 4 : 1,
        ...(kind === 'unpublish' && alias === 'v'
          ? {
              waivedCopies: {
                1: 'The initial version existence assertion checks this same organization and revision before the before-image insert in the atomic batch.',
                2: 'The initial version existence assertion checks this same organization and revision before the version update in the atomic batch.',
                3: 'The update repeats the scoped version eligibility guard already checked at the head of the atomic batch.',
              },
            }
          : {}),
      })),
      ...readCases.map((contractCase, index) => ({
        name: contractCase.name,
        caseName: contractCase.name,
        locate: new RegExp(`(?<![\\w.])${['p', 's', 'v'][index]}\\.org_id\\s*=\\s*\\?`),
        neutral: NOT_NULL,
        copies: 1,
      })),
    ],
    waivers: [
      ...(kind === 'tags'
        ? [
            {
              locate: /(?<=from dist_tag where )org_id=\?(?= and package_id=\? and tag=\?)/,
              reason:
                'Tag history and the tag delete address the package id the scoped package assertion at the head of the same atomic batch already checked.',
            },
          ]
        : [
            {
              locate:
                /(?<=delete from dist_tag where |update dist_tag set version_id=\? where )org_id=\?(?=\s+and package_id=\?\s+and version_id in)/,
              reason:
                'Affected tags are addressed by the package id the scoped package assertion at the head of the same atomic batch already checked.',
            },
          ]),
      {
        locate:
          /(?<=update package set rev=rev\+1,\s?modified_at=[\s\S]{1,300}?where )org_id=\?(?= and id=\? and rev=\?)/,
        reason:
          'The package revision bump repeats the package id and revision the scoped package assertion at the head of the same atomic batch already checked.',
      },
      {
        locate: /(?<=update cache_epoch set version=hex\(randomblob\(16\)\) where )org_id=\?/,
        reason:
          'The cache epoch bump is keyed by the request organization; the cache epoch registrations prove epoch isolation.',
      },
      {
        locate: /s\.org_id=o\.id/,
        reason:
          'The retention settings join is bounded by organization.id from the request and the source id whose organization was already checked by the snapshot guard in this transaction.',
      },
      {
        locate: /pa\.org_id\s*=\s*\?/,
        reason:
          'The publish gate is a deny-only check correlated to the already-scoped version id; publish approval contracts cover organization isolation.',
      },
    ],
  };
}
