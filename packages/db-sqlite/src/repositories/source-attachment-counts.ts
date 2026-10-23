import { sql } from 'kysely';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type { SourceAttachmentCountQuery } from '@package-broker/core/db/source';
import { compile, db } from '../kysely.js';
import { holdsPermission } from './access.js';

export function sourceAttachmentCountsStatement(
  ctx: OrgContext,
  input: SourceAttachmentCountQuery,
): Statement {
  let query = db
    .selectFrom('project_source as attachment')
    .innerJoin('source as attached_source', 'attached_source.id', 'attachment.source_id')
    .innerJoin('project as attached_project', 'attached_project.id', 'attachment.project_id')
    .select('attachment.source_id as sourceId')
    .select(sql<number>`count(*)`.as('count'))
    .where('attachment.org_id', '=', ctx.orgId)
    .where('attached_source.org_id', '=', ctx.orgId)
    .where('attached_source.project_id', 'is', null)
    .where('attached_project.org_id', '=', ctx.orgId)
    .where(
      sql<boolean>`attachment.source_id in (select value from json_each(${JSON.stringify(input.sourceIds)}))`,
    );
  if (!input.includeArchived) query = query.where('attached_project.status', '=', 'active');
  const servicePrincipalId = input.servicePrincipalId;
  if (servicePrincipalId !== undefined) {
    query = query.where((eb) =>
      eb.exists(
        db
          .selectFrom('service_principal as count_service')
          .innerJoin(
            'service_principal_permission as count_service_permission',
            'count_service_permission.service_principal_id',
            'count_service.id',
          )
          .select('count_service.id')
          .where('count_service.org_id', '=', ctx.orgId)
          .where('count_service_permission.org_id', '=', ctx.orgId)
          .where('count_service.id', '=', servicePrincipalId)
          .where('count_service.status', '=', 'active')
          .where('count_service_permission.permission', '=', 'project:read')
          .where((service) =>
            service.or([
              service('count_service.project_id', 'is', null),
              service('count_service.project_id', '=', sql.ref<string>('attached_project.id')),
            ]),
          ),
      ),
    );
  } else if (!input.allProjects) {
    query = query.where(
      holdsPermission(ctx, {
        userId: input.userId,
        projectId: sql.ref('attached_project.id'),
        permission: 'project:read',
        projectState: 'any',
        providerAnchors: input.providerAnchors,
      }),
    );
  }
  return compile(query.groupBy('attachment.source_id'));
}
