import type { PluginDefinition } from '@package-broker/core/plugin';

export function auditTrail(): PluginDefinition {
  return {
    id: 'audit-trail',
    package: '@test/audit-trail',
    apiVersion: 4,
    platforms: ['node', 'cloudflare'],
    binds: ['audit-trail'],
    auditTrail: {
      toggleEnv: 'PB_AUDIT_TRAIL',
      create: (ctx) => ({
        async handle(operation, request) {
          if (operation === 'auditHead') {
            const head = await ctx.journal.head();
            return {
              seq: head.headSeq,
              hash: head.headHash,
              pendingCount: head.pendingCount,
              lastVerifiedAt: null,
            };
          }
          const page = await ctx.journal.list({
            projectId: request.projectId,
            limit: Number(request.query.limit ?? 50),
            ...(request.query.after === undefined ? {} : { afterSeq: Number(request.query.after) }),
          });
          return {
            items: page.items.map((item) =>
              item.kind === 'withheld'
                ? {
                    kind: 'withheld' as const,
                    id: 'id' in item ? item.id : item.markerId,
                    seq: item.seq,
                    reason:
                      item.reasonCode === 'unreadable'
                        ? ('unreadable' as const)
                        : ('content' as const),
                  }
                : {
                    id: item.id,
                    seq: item.seq,
                    action: item.action,
                    actor: { type: item.actorType, id: item.actorId },
                    targetType: item.targetType,
                    targetId: item.targetId,
                    projectId: item.projectId,
                    createdAt: item.createdAt,
                    payload: {},
                  },
            ),
            next: page.next === null ? null : String(page.next),
          };
        },
      }),
    },
  };
}
