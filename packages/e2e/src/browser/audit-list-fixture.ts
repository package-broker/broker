import { randomUUID } from 'node:crypto';

interface FixtureResponse {
  status: number;
  data: unknown;
}
export type AuditFixtureRequest = (
  path: string,
  init?: { method: 'POST'; body: { slug: string; name: string }; idempotencyKey: string },
) => Promise<FixtureResponse>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function seedAuditList(request: AuditFixtureRequest): Promise<void> {
  try {
    const slug = `browser-audit-${Date.now().toString(36)}`;
    const created = await request('/_pb/projects', {
      method: 'POST',
      body: { slug, name: 'Browser audit fixture' },
      idempotencyKey: randomUUID(),
    });
    if (created.status !== 201 || !object(created.data) || typeof created.data.id !== 'string')
      throw new Error();
    const projectId = created.data.id;
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      const status = await request('/_pb/audit/status');
      if (status.status !== 200 || !object(status.data) || status.data.trailActive !== true)
        throw new Error();
      if (status.data.pendingCount === 0 && Number(status.data.headSeq) > 0) {
        const list = await request(
          `/_pb/audit?action=project.create&project=${encodeURIComponent(projectId)}`,
        );
        if (list.status !== 200 || !object(list.data) || !Array.isArray(list.data.items))
          throw new Error();
        if (
          list.data.items.some(
            (item: unknown) =>
              object(item) &&
              item.kind !== 'withheld' &&
              item.action === 'project.create' &&
              item.targetId === projectId &&
              item.projectId === projectId,
          )
        )
          return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch {
    // Transport errors can include cookies, credentials or response bodies.
    throw new Error('Audit list fixture could not prepare a sealed project event');
  }
  throw new Error('Audit list fixture timed out waiting for a sealed project event');
}
