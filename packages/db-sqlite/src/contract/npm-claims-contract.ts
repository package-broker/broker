import { createSourceService } from '@package-broker/core/sources/source-service';
import { createSourceRepository } from '../repositories/source.js';
import { ulid } from '@package-broker/core/ids';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { AuditEvent } from '@package-broker/core/audit/actions';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { compile, db } from '../kysely.js';
import { coveredByRegisteredNames, isRegistrablePattern } from '../repositories/registered-name.js';
import { proxyEligibleCondition } from '../repositories/catalogue-predicates.js';
import { createRegisteredNameRepository } from '../repositories/registered-name.js';
import { seedTwoOrganizations } from './two-organizations.js';

const st = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });

export function describeNpmClaimsContract(
  backend: string,
  open: () => Promise<{ executor: SqlExecutor; close(): Promise<void> }>,
) {
  describe(`npm claim admission: ${backend}`, () => {
    async function setup(ownerType = 'hosted') {
      const database = await open();
      const { executor } = database;
      const { a, b } = await seedTwoOrganizations(executor);
      await executor.batch([
        st(
          "INSERT INTO user_account (id, org_id, email) VALUES ('U', ?, 'actor@example.test')",
          a.orgId,
        ),
        st(
          "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES ('S', ?, 'U', ?, ?, '2999-01-01T00:00:00Z')",
          a.orgId,
          'a'.repeat(64),
          'b'.repeat(64),
        ),
        st(
          "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
          a.orgId,
        ),
        st(
          "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('I', ?, 'U', 'oidc', 'sub', 'actor@example.test', 1, ?)",
          a.orgId,
          new Date(Date.now() - 60000).toISOString(),
        ),
        st(
          "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R', ?, 'writer', 'Writer', 'organization')",
          a.orgId,
        ),
        st(
          "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R', 'org:sources:write')",
          a.orgId,
        ),
        st(
          "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('G', ?, 'email', 'actor@example.test', 'organization', 'R')",
          a.orgId,
        ),
        st(
          "INSERT INTO source (id, org_id, name, type, ecosystem, status) VALUES ('H', ?, 'hosted', 'hosted', 'npm', 'paused')",
          a.orgId,
        ),
        st(
          "INSERT INTO source (id, org_id, name, type, ecosystem, status) VALUES ('N', ?, 'registry', 'npm_registry', 'npm', 'paused')",
          a.orgId,
        ),
        st(
          "INSERT INTO source (id, org_id, name, type, ecosystem) VALUES ('P', ?, 'proxy', 'npmjs_proxy', 'npm')",
          a.orgId,
        ),
        st(
          "INSERT INTO source (id, org_id, name, type, ecosystem) VALUES ('F', ?, 'foreign', 'hosted', 'npm')",
          b.orgId,
        ),
      ]);
      await executor.batch([
        st("UPDATE source SET type = ? WHERE org_id = ? AND id = 'H'", ownerType, a.orgId),
      ]);
      const names = createRegisteredNameRepository(executor);
      const fence = mutationFence({ userId: 'U', sessionId: 'S' } as AuthenticatedActor, {});

      const anchors = [
        {
          provider: 'oidc',
          anchor: 'oidc:https://idp.example.test',
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test'],
        },
      ];
      function audit(id: string): AuditEvent {
        return {
          id: ulid(),
          action: 'registered_name.add',
          actor: { type: 'user', id: 'U' },
          target: { type: 'registered_name', id },
          occurredAt: new Date().toISOString(),
          projectId: null,
          tokenSelector: null,
          sourceIp: null,
          payloadJson: '{}',
        };
      }
      const add = (
        id: string,
        sourceId: string,
        pattern: string,
        claimProbe: { proxyId: string } = { proxyId: 'P' },
      ) =>
        names.add(a, fence, {
          id,
          sourceId,
          pattern,
          providerAnchors: anchors,
          audit: audit(id),
          ...(claimProbe ? { claimProbe } : {}),
        });
      const snapshot = async () =>
        JSON.stringify(await executor.all(st('SELECT * FROM registered_name ORDER BY id'))) +
        JSON.stringify(await executor.all(st('SELECT * FROM audit_pending ORDER BY id'))) +
        JSON.stringify(await executor.all(st('SELECT * FROM cache_epoch ORDER BY org_id')));
      return { ...database, a, b, names, fence, anchors, audit, add, snapshot };
    }

    it.each(['npm_registry', 'vcs'])(
      'uses the appropriate npm claim grammar for %s',
      async (type) => {
        const f = await setup();
        try {
          await f.executor.batch([
            st("UPDATE source SET type = ? WHERE id = 'N' AND org_id = ?", type, f.a.orgId),
          ]);
          expect(await f.add('C1', 'N', '@sc*/foo')).toBe(
            type === 'vcs' ? 'invalid_pattern' : 'added',
          );
          expect(await f.add('C2', 'N', 'a'.repeat(51))).toBe(
            type === 'vcs' ? 'added' : 'invalid_pattern',
          );
        } finally {
          await f.close();
        }
      },
    );
    it.each(['lod*', '@sc*/foo', '@scope/pre*'])(
      'refuses npm VCS legacy wildcard %s without writes',
      async (pattern) => {
        const f = await setup('vcs');
        try {
          const before = await f.snapshot();
          expect(await f.add('C1', 'H', pattern)).toBe('invalid_pattern');
          expect(await f.snapshot()).toBe(before);
        } finally {
          await f.close();
        }
      },
    );
    it('refuses registry and VCS overlap in either direction', async () => {
      const f = await setup();
      try {
        await f.executor.batch([
          st(
            "INSERT INTO source (id, org_id, name, type, ecosystem) VALUES ('V', ?, 'legacy', 'vcs', 'npm')",
            f.a.orgId,
          ),
        ]);
        expect(await f.add('C1', 'N', '@scope/*')).toBe('added');
        expect(await f.add('C2', 'V', '@scope/foo')).toBe('claim_overlap');
        expect(await f.add('C3', 'V', '@private/*')).toBe('added');
        expect(await f.add('C4', 'N', '@private/foo')).toBe('claim_overlap');
      } finally {
        await f.close();
      }
    });
    it('gets one registered name directly within its organization', async () => {
      const f = await setup();
      try {
        expect(await f.add('C1', 'H', '@scope/*')).toBe('added');
        expect(await f.names.get(f.a, 'C1')).toEqual({
          id: 'C1',
          sourceId: 'H',
          ecosystem: 'npm',
          pattern: '@scope/*',
        });
        expect(await f.names.get(f.b, 'C1')).toBeNull();
        expect(await f.names.get(f.a, 'missing')).toBeNull();
      } finally {
        await f.close();
      }
    });
    it('pins exact duplicates to pattern_taken and hosted intersections to claim_overlap', async () => {
      const f = await setup();
      try {
        await f.executor.batch([
          st(
            "INSERT INTO source (id, org_id, name, type, ecosystem) VALUES ('V', ?, 'legacy', 'vcs', 'npm')",
            f.a.orgId,
          ),
        ]);
        expect(await f.add('C1', 'N', '@scope/*')).toBe('added');
        expect(await f.add('C2', 'V', '@scope/*')).toBe('pattern_taken');
        expect(await f.add('C3', 'H', '@scope/*')).toBe('pattern_taken');
        expect(await f.add('C4', 'H', '@scope/widget')).toBe('claim_overlap');
      } finally {
        await f.close();
      }
    });
    it.each(['hosted', 'vcs', 'npm_registry'])(
      'refuses claims over packages retained by a paused %s source without registrations',
      async (type) => {
        const f = await setup();
        try {
          await f.executor.batch([
            st("UPDATE source SET type = ? WHERE id = 'N' AND org_id = ?", type, f.a.orgId),
          ]);
          expect(await f.add('C1', 'N', '@scope/*')).toBe('added');
          await f.executor.batch([
            st(
              "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('PK', ?, 'N', 'npm', '@scope/widget')",
              f.a.orgId,
            ),
          ]);
          expect(
            await f.names.remove(f.a, f.fence, {
              id: 'C1',
              providerAnchors: f.anchors,
              audit: f.audit('C1'),
              pauseAudit: {
                ...f.audit('N'),
                action: 'source.pause',
                target: { type: 'source', id: 'N' },
              },
            }),
          ).toMatch(/^removed/);
          const before = await f.snapshot();
          expect(await f.add('C2', 'H', '@scope/widget')).toBe('claim_overlap');
          expect(await f.add('C3', 'H', '@scope/*')).toBe('claim_overlap');
          expect(await f.snapshot()).toBe(before);
        } finally {
          await f.close();
        }
      },
    );
    it('re-adds a registry scope over its own cached packages', async () => {
      const f = await setup();
      try {
        expect(await f.add('C1', 'N', '@scope/*')).toBe('added');
        await f.executor.batch([
          st(
            "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('OWN', ?, 'N', 'npm', '@scope/foo')",
            f.a.orgId,
          ),
          st("UPDATE source SET status = 'active' WHERE org_id = ? AND id = 'N'", f.a.orgId),
        ]);
        expect(
          await f.names.remove(f.a, f.fence, {
            id: 'C1',
            providerAnchors: f.anchors,
            audit: f.audit('C1'),
            pauseAudit: {
              ...f.audit('N'),
              action: 'source.pause',
              target: { type: 'source', id: 'N' },
            },
          }),
        ).toBe('removed_and_paused');
        expect(await f.add('C2', 'N', '@scope/*')).toBe('added');
      } finally {
        await f.close();
      }
    });
    it.each([false, true])('refuses legacy intersection in reverse order %s', async (reverse) => {
      const f = await setup();
      try {
        expect(await f.add('C1', reverse ? 'H' : 'N', reverse ? '@scope/*' : '@sc*/foo')).toBe(
          'added',
        );
        const before = await f.snapshot();
        expect(await f.add('C2', reverse ? 'N' : 'H', reverse ? '@sc*/foo' : '@scope/*')).toBe(
          'claim_overlap',
        );
        expect(await f.snapshot()).toBe(before);
      } finally {
        await f.close();
      }
    });
    it.each([false, true])(
      'refuses an exact hosted claim intersecting a legacy glob in reverse order %s',
      async (reverse) => {
        const f = await setup();
        try {
          expect(await f.add('C1', reverse ? 'H' : 'N', reverse ? '@scope/foo' : '@sc*/foo')).toBe(
            'added',
          );
          const before = await f.snapshot();
          expect(await f.add('C2', reverse ? 'N' : 'H', reverse ? '@sc*/foo' : '@scope/foo')).toBe(
            'claim_overlap',
          );
          expect(await f.snapshot()).toBe(before);
        } finally {
          await f.close();
        }
      },
    );
    it.each(['hosted', 'vcs'])(
      'requires proof for an unattached organization proxy (%s)',
      async (owner) => {
        const f = await setup(owner);
        try {
          expect(await f.names.claimProxy(f.a)).toBe('P');
          expect(
            await f.names.add(f.a, f.fence, {
              id: 'C1',
              sourceId: 'H',
              pattern: 'widget',
              providerAnchors: f.anchors,
              audit: f.audit('C1'),
            }),
          ).toBe('name_public_unverified');
        } finally {
          await f.close();
        }
      },
    );
    it('refuses a replacement whose audited pattern changed', async () => {
      const f = await setup();
      try {
        expect(await f.add('C1', 'H', '@scope/*')).toBe('added');
        const before = await f.snapshot();
        expect(
          await f.names.add(f.a, f.fence, {
            id: 'C1',
            sourceId: 'H',
            pattern: '@new/*',
            previousPattern: '@stale/*',
            replace: true,
            providerAnchors: f.anchors,
            audit: f.audit('C1'),
          }),
        ).toBe('conflict');
        expect(await f.snapshot()).toBe(before);
      } finally {
        await f.close();
      }
    });
    it('rechecks hosted package coverage inside the replacement batch', async () => {
      const f = await setup();
      try {
        expect(await f.add('C1', 'H', '@scope/*')).toBe('added');
        const names = createRegisteredNameRepository({
          driver: f.executor.driver,
          all: (statement) => f.executor.all(statement),
          async batch(statements) {
            await f.executor.batch([
              st(
                "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('RACE-PACKAGE', ?, 'H', 'npm', '@scope/foo')",
                f.a.orgId,
              ),
            ]);
            return f.executor.batch(statements);
          },
        });
        const before = await f.snapshot();
        expect(
          await names.add(f.a, f.fence, {
            id: 'C1',
            sourceId: 'H',
            pattern: '@new/*',
            replace: true,
            providerAnchors: f.anchors,
            audit: f.audit('C1'),
          }),
        ).toBe('claim_in_use');
        expect(await f.snapshot()).toBe(before);
      } finally {
        await f.close();
      }
    });
    it('refuses replacement that uncovers a hosted package', async () => {
      const f = await setup();
      try {
        expect(await f.add('C1', 'H', '@scope/*')).toBe('added');
        await f.executor.batch([
          st(
            "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('OWN', ?, 'H', 'npm', '@scope/foo')",
            f.a.orgId,
          ),
        ]);
        const before = await f.snapshot();
        expect(
          await f.names.add(f.a, f.fence, {
            id: 'C1',
            sourceId: 'H',
            pattern: '@other/*',
            replace: true,
            providerAnchors: f.anchors,
            audit: f.audit('C1'),
          }),
        ).toBe('claim_in_use');
        expect(await f.snapshot()).toBe(before);
      } finally {
        await f.close();
      }
    });
    it.each([
      ['@scope/*', '@scope/widget'],
      ['@scope/widget', '@scope/*'],
      ['widget', 'widget'],
      ['@scope/*', '@scope/*'],
    ])(
      'refuses cross-source overlap %s then %s in either source direction',
      async (first, second) => {
        const f = await setup();
        try {
          expect(await f.add('C1', 'N', first)).toBe('added');
          const before = await f.snapshot();
          expect(await f.add('C2', 'H', second)).toBe(
            first === second ? 'pattern_taken' : 'claim_overlap',
          );
          expect(await f.snapshot()).toBe(before);
        } finally {
          await f.close();
        }
      },
    );
    it('refuses registry registration that would overlap an existing hosted claim', async () => {
      const f = await setup();
      try {
        expect(await f.add('C1', 'H', '@scope/*')).toBe('added');
        const before = await f.snapshot();
        expect(await f.add('C2', 'N', '@scope/widget')).toBe('claim_overlap');
        expect(await f.snapshot()).toBe(before);
      } finally {
        await f.close();
      }
    });
    it.each(['P', 'N'])('refuses cached public names from %s without writes', async (source) => {
      const f = await setup();
      try {
        await f.executor.batch([
          st(
            "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('PK', ?, ?, 'npm', '@scope/widget')",
            f.a.orgId,
            source,
          ),
        ]);
        const before = await f.snapshot();
        expect(await f.add('C1', 'H', '@scope/*')).toBe(
          source === 'N' ? 'claim_overlap' : 'name_public',
        );
        expect(await f.add('C2', 'H', '@scope/widget')).toBe(
          source === 'N' ? 'claim_overlap' : 'name_public',
        );
        expect(await f.snapshot()).toBe(before);
      } finally {
        await f.close();
      }
    });
    it.each(['hosted', 'vcs'])(
      'ignores foreign claims and cached packages and allows same-source coverage (%s)',
      async (owner) => {
        const f = await setup(owner);
        try {
          await f.executor.batch([
            st("UPDATE source SET type = 'npm_registry' WHERE org_id = ? AND id = 'F'", f.b.orgId),
            st(
              "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('FC', ?, 'F', 'npm', '@scope/*')",
              f.b.orgId,
            ),
            st(
              "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('FP', ?, 'F', 'npm', '@scope/widget')",
              f.b.orgId,
            ),
          ]);
          expect(await f.add('C1', 'H', '@scope/*')).toBe('added');
          expect(await f.add('C2', 'H', '@scope/widget')).toBe('added');
          expect((await f.names.list(f.a, { sourceId: 'H', limit: 100 })).items).toHaveLength(2);
        } finally {
          await f.close();
        }
      },
    );
    it('requires proof for an attached proxy and reads it within the organization', async () => {
      const f = await setup();
      try {
        await f.executor.batch([
          st(
            "INSERT INTO project (id, org_id, slug, name) VALUES ('PR', ?, 'project', 'Project')",
            f.a.orgId,
          ),
          st(
            "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'PR', 'P')",
            f.a.orgId,
          ),
        ]);
        expect(await f.names.claimProxy(f.a)).toBe('P');
        expect(await f.names.claimProxy(f.b)).toBeNull();
        const before = await f.snapshot();
        expect(
          await f.names.add(f.a, f.fence, {
            id: 'C1',
            sourceId: 'H',
            pattern: 'widget',
            providerAnchors: f.anchors,
            audit: f.audit('C1'),
          }),
        ).toBe('name_public_unverified');
        expect(await f.snapshot()).toBe(before);
        expect(await f.add('C2', 'H', 'widget', { proxyId: 'P' })).toBe('added');
        expect(await f.add('C3', 'H', '@scope/*')).toBe('added');
      } finally {
        await f.close();
      }
    });

    it.each(['exact', 'scope'] as const)(
      'supports full length npm %s claims without hiding unrelated proxies',
      async (kind) => {
        const f = await setup();
        try {
          const claim = kind === 'exact' ? 'a'.repeat(214) : `@${'a'.repeat(211)}/*`;
          const key = kind === 'exact' ? claim : `${claim.slice(0, -1)}a`;
          expect(isRegistrablePattern(claim, 'npm')).toBe(true);
          expect(await f.add('C1', 'H', claim)).toBe('added');
          const covered = await f.executor.all(
            compile(
              db.selectNoFrom(
                sql<number>`(${coveredByRegisteredNames(f.a, 'H', 'npm', key)})`.as('held'),
              ),
            ),
          );
          expect(covered[0]?.held).toBe(1);
          await f.executor.batch([
            st(
              "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('PUB', ?, 'P', 'npm', 'unrelated')",
              f.a.orgId,
            ),
            st(
              "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('SHADOW', ?, 'P', 'npm', ?)",
              f.a.orgId,
              key,
            ),
          ]);
          const eligible = await f.executor.all(
            compile(
              db
                .selectFrom('package as p')
                .innerJoin('source as s', 's.id', 'p.source_id')
                .select('p.name')
                .where('p.org_id', '=', f.a.orgId)
                .where(proxyEligibleCondition({ package: 'p', source: 's' })),
            ),
          );
          expect(eligible).toEqual([{ name: 'unrelated' }]);
        } finally {
          await f.close();
        }
      },
    );

    it('does not evaluate a long stored name as a GLOB pattern', async () => {
      const f = await setup();
      try {
        expect(await f.add('C1', 'H', 'a'.repeat(214))).toBe('added');
        expect(await f.add('C2', 'N', 'unrelated')).toBe('added');
        const covered = await f.executor.all(
          compile(
            db.selectNoFrom(
              sql<number>`(${coveredByRegisteredNames(f.a, 'H', 'npm', 'unrelated')})`.as('held'),
            ),
          ),
        );
        expect(covered[0]?.held).toBe(0);
      } finally {
        await f.close();
      }
    });

    it('preserves npm registry activation coverage by limiting replacement to hosted claims', async () => {
      const f = await setup();
      try {
        expect(await f.add('C1', 'N', '@scope/*')).toBe('added');
        await f.executor.batch([
          st(
            "UPDATE source SET status = 'active', config_json = ? WHERE org_id = ? AND id = 'N'",
            '{"scopes":["@scope"]}',
            f.a.orgId,
          ),
        ]);
        const before = await f.snapshot();
        expect(
          await f.names.add(f.a, f.fence, {
            id: 'C1',
            sourceId: 'N',
            pattern: '@other/*',
            replace: true,
            claimProbe: { proxyId: 'P' },
            providerAnchors: f.anchors,
            audit: f.audit('C1'),
          }),
        ).toBe('conflict');
        expect(await f.snapshot()).toBe(before);
        expect((await createSourceRepository(f.executor).get(f.a, 'N'))?.status).toBe('active');
      } finally {
        await f.close();
      }
    });

    it('updates claims atomically and preserves the old name on refused replacement', async () => {
      const f = await setup();
      try {
        expect(await f.add('C1', 'H', '@private/one')).toBe('added');
        expect(await f.add('C2', 'N', '@public/*')).toBe('added');
        const before = await f.snapshot();
        const replace = (pattern: string, sourceId = 'H') =>
          f.names.add(f.a, f.fence, {
            id: 'C1',
            sourceId,
            pattern,
            replace: true,
            claimProbe: { proxyId: 'P' },
            providerAnchors: f.anchors,
            audit: f.audit('C1'),
          });
        expect(await replace('@public/two')).toBe('claim_overlap');
        expect(await f.snapshot()).toBe(before);
        expect(await replace('@private/two', 'N')).toBe('not_found');
        expect(await replace('@private/two')).toBe('added');
        expect(
          (await f.names.list(f.a, { sourceId: 'H', limit: 100 })).items.map((row) => row.pattern),
        ).toEqual(['@private/two']);
        await f.executor.batch([
          st(
            "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('PK', ?, 'P', 'npm', '@private/public')",
            f.a.orgId,
          ),
        ]);
        const after = await f.snapshot();
        expect(await replace('@private/*')).toBe('name_public');
        expect(await f.snapshot()).toBe(after);
      } finally {
        await f.close();
      }
    });
    it.each(
      ['hosted', 'vcs'].flatMap((owner) =>
        ['overlap', 'stored', 'cached', 'proxy', 'authority'].map((race) => [owner, race] as const),
      ),
    )('rechecks %s %s inside the mutation batch', async (owner, race) => {
      const f = await setup(owner);
      try {
        if (race === 'proxy')
          await f.executor.batch([
            st("DELETE FROM source WHERE org_id = ? AND id = 'P'", f.a.orgId),
          ]);
        let raced = false;
        const repository = createRegisteredNameRepository({
          driver: f.executor.driver,
          all: (statement) => f.executor.all(statement),
          async batch(statements) {
            if (!raced) {
              raced = true;
              if (race === 'overlap')
                await f.executor.batch([
                  st(
                    "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('RACE', ?, 'N', 'npm', '@scope/*')",
                    f.a.orgId,
                  ),
                ]);
              if (race === 'stored')
                await f.executor.batch([
                  st("UPDATE source SET type = 'vcs' WHERE org_id = ? AND id = 'N'", f.a.orgId),
                  st(
                    "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('PK', ?, 'N', 'npm', '@scope/widget')",
                    f.a.orgId,
                  ),
                ]);
              if (race === 'cached')
                await f.executor.batch([
                  st(
                    "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('PK', ?, 'P', 'npm', '@scope/widget')",
                    f.a.orgId,
                  ),
                ]);
              if (race === 'proxy')
                await f.executor.batch([
                  st(
                    "INSERT INTO source (id, org_id, name, type, ecosystem) VALUES ('P', ?, 'proxy', 'npmjs_proxy', 'npm')",
                    f.a.orgId,
                  ),
                  st(
                    "INSERT INTO project (id, org_id, slug, name) VALUES ('PR', ?, 'project', 'Project')",
                    f.a.orgId,
                  ),
                  st(
                    "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'PR', 'P')",
                    f.a.orgId,
                  ),
                ]);
              if (race === 'authority')
                await f.executor.batch([
                  st("DELETE FROM access_grant WHERE org_id = ? AND id = 'G'", f.a.orgId),
                ]);
            }
            return f.executor.batch(statements);
          },
        });
        const result = await repository.add(f.a, f.fence, {
          id: 'C1',
          sourceId: 'H',
          pattern: '@scope/widget',
          ...(race === 'proxy' ? {} : { claimProbe: { proxyId: 'P' } }),
          providerAnchors: f.anchors,
          audit: f.audit('C1'),
        });
        expect(result).toBe(
          race === 'overlap' || race === 'stored'
            ? 'claim_overlap'
            : race === 'cached'
              ? 'name_public'
              : race === 'proxy'
                ? 'name_public_unverified'
                : 'forbidden',
        );
        expect(await f.executor.all(st("SELECT id FROM registered_name WHERE id = 'C1'"))).toEqual(
          [],
        );
        expect(await f.executor.all(st('SELECT id FROM audit_pending'))).toEqual([]);
      } finally {
        await f.close();
      }
    });

    it('creates multiple organization hosted sources, enables a claim and never schedules upstream polling', async () => {
      const f = await setup();
      try {
        const sources = createSourceRepository(f.executor);
        const service = createSourceService({
          sources,
          registeredNames: f.names,
          providerAnchors: f.anchors,
          ids: { ulid },
          organizations: { get: async () => null },
          credentials: {
            prepare: async () => {
              throw new Error('unused');
            },
          },
          credentialRepository: { get: async () => null },
          catalogue: { previewWinners: async () => [] },
          policy: {
            runtime: backend === 'D1' ? 'cloudflare' : 'node',
            allowPrivateHosts: [],
            selfOrigins: [],
          },
          log: () => {},
        });
        const actor = {
          kind: 'org' as const,
          actor: {
            kind: 'organization' as const,
            userId: 'U',
            isOrganizationAdmin: false,
            permissions: new Set(['org:sources:write']),
          },
        };
        const call = {
          audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
        };
        const input = {
          projectId: null,
          name: 'Private packages',
          ecosystem: 'npm' as const,
          type: 'hosted' as const,
          url: null,
          configJson: '{}',
        };
        const created = await service.create(f.a, actor, f.fence, input, call);
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error('expected a hosted source');
        expect(await sources.get(f.a, created.value.id)).toMatchObject({
          type: 'hosted',
          ecosystem: 'npm',
          projectId: null,
          status: 'paused',
          configJson: '{}',
        });
        expect(
          (
            await service.create(
              f.a,
              actor,
              f.fence,
              { ...input, name: 'Other private packages' },
              call,
            )
          ).ok,
        ).toBe(true);
        expect(
          (
            await service.addRegisteredName(
              f.a,
              actor,
              f.fence,
              { sourceId: created.value.id, pattern: '@private/*' },
              call,
            )
          ).ok,
        ).toBe(true);
        expect((await service.enable(f.a, actor, f.fence, created.value.id, call)).ok).toBe(true);
        expect((await sources.get(f.a, created.value.id))?.status).toBe('active');
        expect((await sources.listDue(f.a, 50)).map((row) => row.id)).not.toContain(
          created.value.id,
        );
      } finally {
        await f.close();
      }
    });
    it.each(['hosted', 'vcs', 'npm_registry'])(
      'refuses overlaps held by a %s source',
      async (type) => {
        const f = await setup();
        try {
          await f.executor.batch([
            st("UPDATE source SET type = ? WHERE org_id = ? AND id = 'N'", type, f.a.orgId),
          ]);
          expect(await f.add('C1', 'N', '@scope/*')).toBe('added');
          expect(await f.add('C2', 'H', '@scope/widget')).toBe('claim_overlap');
        } finally {
          await f.close();
        }
      },
    );
    it.each(['hosted', 'vcs'])(
      'serializes concurrent claims with one audit row for the winner (%s)',
      async (owner) => {
        const f = await setup(owner);
        try {
          const outcomes = await Promise.all([
            f.add('C1', 'H', '@scope/*'),
            f.add('C2', 'N', '@scope/widget'),
          ]);
          expect(outcomes.sort()).toEqual(['added', 'claim_overlap']);
          expect(await f.executor.all(st('SELECT id FROM registered_name'))).toHaveLength(1);
          expect(await f.executor.all(st('SELECT id FROM audit_pending'))).toHaveLength(1);
        } finally {
          await f.close();
        }
      },
    );
    it('project-owned npm vcs source acquires a claim, and admission still refuses an overlapping or public name', async () => {
      const f = await setup('vcs');
      try {
        await f.executor.batch([
          st(
            "INSERT INTO project (id, org_id, slug, name) VALUES ('PR', ?, 'project', 'Project')",
            f.a.orgId,
          ),
          st("UPDATE source SET project_id = 'PR' WHERE org_id = ? AND id = 'H'", f.a.orgId),
        ]);
        expect(await f.add('C1', 'H', '@private/widget')).toBe('added');
        expect(await f.add('C2', 'N', '@taken/*')).toBe('added');
        await f.executor.batch([
          st(
            "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('PK', ?, 'P', 'npm', '@public/widget')",
            f.a.orgId,
          ),
        ]);
        const before = await f.snapshot();
        expect(await f.add('C3', 'H', '@taken/widget')).toBe('claim_overlap');
        expect(await f.add('C4', 'H', '@public/widget')).toBe('name_public');
        expect(await f.snapshot()).toBe(before);
      } finally {
        await f.close();
      }
    });
    it('does not let a project-owned hosted source acquire claims', async () => {
      const f = await setup();
      try {
        await f.executor.batch([
          st(
            "INSERT INTO project (id, org_id, slug, name) VALUES ('PR', ?, 'project', 'Project')",
            f.a.orgId,
          ),
          st("UPDATE source SET project_id = 'PR' WHERE org_id = ? AND id = 'H'", f.a.orgId),
        ]);
        const before = await f.snapshot();
        expect(await f.add('C1', 'H', 'widget')).toBe('conflict');
        expect(await f.snapshot()).toBe(before);
      } finally {
        await f.close();
      }
    });
    it('does not audit a replacement whose name is deleted before the batch', async () => {
      const f = await setup();
      try {
        expect(await f.add('C1', 'H', 'widget')).toBe('added');
        const pending = await f.executor.all(st('SELECT id FROM audit_pending ORDER BY id'));
        const repository = createRegisteredNameRepository({
          driver: f.executor.driver,
          all: (statement) => f.executor.all(statement),
          async batch(statements) {
            await f.executor.batch([
              st("DELETE FROM registered_name WHERE org_id = ? AND id = 'C1'", f.a.orgId),
            ]);
            return f.executor.batch(statements);
          },
        });
        expect(
          await repository.add(f.a, f.fence, {
            id: 'C1',
            sourceId: 'H',
            pattern: 'other',
            replace: true,
            claimProbe: { proxyId: 'P' },
            providerAnchors: f.anchors,
            audit: f.audit('C1'),
          }),
        ).toBe('conflict');
        expect(await f.executor.all(st('SELECT id FROM audit_pending ORDER BY id'))).toEqual(
          pending,
        );
      } finally {
        await f.close();
      }
    });
    it.each(['widget*', '@scope/pre*', '@*/widget', 'Widget'])(
      'refuses invalid hosted claim %s',
      async (pattern) => {
        const f = await setup();
        try {
          const before = await f.snapshot();
          expect(await f.add('C1', 'H', pattern)).toBe('invalid_pattern');
          expect(await f.snapshot()).toBe(before);
        } finally {
          await f.close();
        }
      },
    );
  });
}
