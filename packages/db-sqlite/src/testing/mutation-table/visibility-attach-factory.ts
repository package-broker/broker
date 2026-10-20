import { expect } from 'vitest';
import { createVisibilityAttachRepository } from '../../repositories/visibility-attach.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ANCHORS, fenceOf, seedProject, seedSource } from './fixtures.js';
import { visibilityAudit } from '../visibility-audit.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignAttachment: ContractCase = {
  name: 'precedence updates reject a foreign attachment child of an own project and source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', own.orgId, 'vcs');
    await seed.forged(
      "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'S')",
      foreign.orgId,
    );
    expect(
      await createVisibilityAttachRepository(executing(context), {
        providerAnchors: ANCHORS,
      }).setPrecedence(own, fenceOf({ userId: 'U', sessionId: 'S' }), {
        audit: visibilityAudit(),
        projectId: 'P',
        sourceId: 'S',
        precedence: 2,
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry(
    'visibility-attach',
    'createVisibilityAttachRepository',
    foreignAttachment,
    /(?<=from "project_source" where )"org_id" = \?/,
    [
      {
        locate: /(?<=from "(?:source|project)" where )"org_id" = \?/,
        reason:
          'The source and project are own controls; the mismatched attachment read is the independent target of this case.',
      },
    ],
  ),
];
