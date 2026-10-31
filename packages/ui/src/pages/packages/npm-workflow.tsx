import { DataTable } from '../../components/ui/table.js';
import { OverlayHost } from '../../components/ui/overlay-host.js';
import { Textarea } from '../../components/ui/textarea.js';
import { RowActions, type RowActionsProps } from '../../components/ui/row-actions.js';
import { useEffect, useRef, useState } from 'react';
import type { operations } from '../../api-types.js';
import type { ShellServices } from '../../auth.js';
import { Button } from '../../components/ui/button.js';
import { Label } from '../../components/ui/label.js';
import { ListState } from '../../components/ui/list-state.js';
import { Time } from '../../components/ui/time.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../components/ui/dialog.js';

type Result<K extends keyof operations> = operations[K] extends {
  responses: { 200: { content: { 'application/json': infer T } } };
}
  ? T
  : never;
type Publish = Result<'listPublishes'>['items'][number];
type Access = Result<'listPackageAccessRequests'>['items'][number];
type Requestable = Result<'listRequestablePackages'>['items'][number];
export type AccessChoice = 'available' | 'request' | 'unavailable';
export function accessSetting(choice: AccessChoice) {
  return {
    visibleToNewProjects: choice === 'available',
    newProjectAccessMode: choice === 'request' ? ('request' as const) : ('none' as const),
  };
}
export function canEditAccess(
  owner: string | null,
  organization: readonly string[],
  permissions: readonly string[],
  projectId: string | null,
) {
  return owner === null
    ? organization.includes('org:sources:write')
    : owner === projectId && permissions.includes('project:sources:write');
}
export function decisionHeaders(revision: number) {
  return { 'If-Match': `"r${revision}"` };
}
export function decisionAllowed(authorized: boolean, busy: boolean, stale: boolean, state: string) {
  return authorized && !busy && !stale && state === 'pending';
}
export function validReason(reason: string, required: boolean) {
  return (
    (!required || reason.trim().length > 0) &&
    new TextEncoder().encode(reason).length <= 1000 &&
    Array.from(reason).every((char) => {
      const code = char.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
  );
}
const SCANS: Record<Publish['scanState'], string> = {
  queued: 'Security scan queued',
  running: 'Security scan running',
  allowed: 'Security scan passed',
  denied: 'Security scan refused',
  failed: 'Security scan failed',
  not_required: 'Security scan not required',
};
type Decision =
  | { kind: 'publish'; item: Publish; action: 'approve' | 'reject' }
  | { kind: 'access'; item: Access; action: 'approve' | 'reject' }
  | { kind: 'request'; item: Requestable };

function WorkflowActions(props: RowActionsProps) {
  return (
    <div className="[&_button]:min-h-11">
      <OverlayHost>
        <RowActions {...props} />
      </OverlayHost>
    </div>
  );
}

export function PackageWorkflow({
  services,
  project,
}: {
  services: ShellServices;
  project: string | null;
}) {
  const [publishes, setPublishes] = useState<Publish[]>([]);
  const [requests, setRequests] = useState<Access[]>([]);
  const [requestable, setRequestable] = useState<Requestable[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [scope, setScope] = useState(project ? 'Project' : 'Organization');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [next, setNext] = useState<{ publishes: string | null; requests: string | null }>({
    publishes: null,
    requests: null,
  });
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [cursors, setCursors] = useState<{ publishes?: string; requests?: string }>({});
  const lock = useRef(false);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setFailed(false);
    setPermissions([]);
    setDecision(null);
    setStale(false);
    lock.current = false;
    setBusy(false);
    void (async () => {
      const permission =
        project === null
          ? await services.client.request('get', '/_pb/me/permissions')
          : await services.client.request('get', '/_pb/projects/{project}/permissions', {
              params: { project },
            });
      if (current !== generation.current) return;
      const allowed = permission.ok
        ? 'organization' in permission.data && project === null
          ? permission.data.organization
          : 'project' in permission.data
            ? permission.data.project
            : []
        : [];
      setPermissions(allowed);
      if (project !== null) {
        const [info, list] = await Promise.all([
          services.client.request('get', '/_pb/projects/{project}', { params: { project } }),
          allowed.includes('project:packages:manage')
            ? services.client.request('get', '/_pb/projects/{project}/requestable-packages', {
                params: { project },
                query: { cursor: cursors.requests },
              })
            : null,
        ]);
        if (current !== generation.current) return;
        setScope(info.ok ? `Project ${info.data.name}` : 'Project');
        setRequestable(list?.ok ? list.data.items : []);
        setNext({ publishes: null, requests: list?.ok ? list.data.next : null });
        setFailed(!permission.ok || (list !== null && !list.ok));
      } else if (allowed.includes('org:packages:read')) {
        const [pub, req] = await Promise.all([
          services.client.request('get', '/_pb/publishes', {
            query: { state: 'pending', cursor: cursors.publishes },
          }),
          services.client.request('get', '/_pb/package-access-requests', {
            query: { state: 'pending', cursor: cursors.requests },
          }),
        ]);
        if (current !== generation.current) return;
        setPublishes(pub.ok ? pub.data.items : []);
        setRequests(req.ok ? req.data.items : []);
        setNext({
          publishes: pub.ok ? pub.data.next : null,
          requests: req.ok ? req.data.next : null,
        });
        setFailed(!pub.ok || !req.ok);
      } else setFailed(!permission.ok);
      setLoading(false);
    })();
    return () => {
      ++generation.current;
    };
  }, [services, project, refresh, cursors]);
  useEffect(
    () =>
      services.subscribeReplay?.((result) => {
        if (
          result.path.startsWith('/_pb/publishes/') ||
          result.path.startsWith('/_pb/package-access-requests/') ||
          (project &&
            result.path === `/_pb/projects/${encodeURIComponent(project)}/package-access-requests`)
        ) {
          setNotice(
            result.ok
              ? 'Decision saved.'
              : 'Decision could not be saved. Reload and review the latest request.',
          );
          setRefresh((value) => value + 1);
        }
      }),
    [services, project],
  );
  const open = (value: Decision) => {
    setDecision(value);
    setReason('');
    setError('');
    setStale(false);
  };
  const authorized =
    decision?.kind === 'publish'
      ? permissions.includes('org:packages:approve')
      : decision?.kind === 'access'
        ? permissions.includes('org:packages:manage')
        : permissions.includes('project:packages:manage');
  const required = decision?.kind !== 'request' && decision?.action === 'reject';
  async function submit() {
    if (
      !decision ||
      lock.current ||
      !decisionAllowed(
        authorized,
        busy,
        stale,
        decision.kind === 'publish'
          ? decision.item.approvalState
          : decision.kind === 'access'
            ? decision.item.state
            : 'pending',
      )
    )
      return;
    if (!validReason(reason, required)) {
      setError('Enter a reason of at most 1000 UTF-8 bytes.');
      reasonField.current?.focus();
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    const current = generation.current;
    const body = reason ? { reason } : {};
    const result =
      decision.kind === 'request'
        ? await services.client.request('post', '/_pb/projects/{project}/package-access-requests', {
            params: { project: project! },
            body: { packageId: decision.item.id, ...body },
          })
        : decision.kind === 'publish'
          ? await services.client.request('post', `/_pb/publishes/{id}/${decision.action}`, {
              params: { id: decision.item.id },
              headers: decisionHeaders(decision.item.revision),
              body,
            })
          : await services.client.request(
              'post',
              `/_pb/package-access-requests/{id}/${decision.action}`,
              {
                params: { id: decision.item.id },
                headers: decisionHeaders(decision.item.revision),
                body,
              },
            );
    if (current !== generation.current) return;
    lock.current = false;
    setBusy(false);
    if (!result.ok) {
      if (result.code === 'reauth_required')
        services.requireReauth(result.request, {
          credential: false,
          secretFields: [],
          display: {
            version: decision.kind === 'publish' ? decision.item.version : '',
            packageName:
              decision.kind === 'request' ? decision.item.name : decision.item.packageName,
            scope,
          },
        });
      if (result.status === 409 || result.status === 412) {
        setStale(true);
        setError('This request changed. Reload the latest requests before reviewing again.');
      } else
        setError(
          result.code === 'reauth_required'
            ? 'Sign in again, then reload and review this decision before submitting.'
            : 'The decision could not be saved. Try again.',
        );
      return;
    }
    setNotice(
      decision.kind === 'request'
        ? 'Package access requested. An organization administrator must approve it.'
        : `${decision.kind === 'publish' ? 'Publish' : 'Package access'} ${decision.action === 'approve' ? 'approved' : 'rejected'}.${decision.kind === 'publish' && decision.action === 'approve' && decision.item.holdScan ? ' The package remains held until the security scan passes.' : ''}`,
    );
    setDecision(null);
    setRefresh((value) => value + 1);
  }
  const reload = () => {
    setDecision(null);
    setRefresh((value) => value + 1);
  };
  if (loading) return <ListState kind="loading" title="Loading package requests…" />;
  if (failed)
    return (
      <ListState
        kind="error"
        title="Package requests could not be loaded."
        children={
          <Button type="button" className="min-h-11" onClick={reload}>
            Try again
          </Button>
        }
      />
    );
  if (!permissions.includes(project ? 'project:packages:manage' : 'org:packages:read')) return null;
  return (
    <div className="my-6 space-y-6 break-words">
      <p role="status">{notice}</p>
      {project ? (
        <section aria-label="Request package access">
          <h2 className="text-lg font-semibold">Request package access</h2>
          <p>
            {scope}. Attach the hosted source to this project first. Only packages that allow
            requests and have an active attached source appear here.
          </p>
          <p>
            {requestable.length}{' '}
            {requestable.length === 1 ? 'requestable package' : 'requestable packages'} on this page
          </p>
          <DataTable
            label="Requestable packages"
            items={requestable}
            columns={[
              { key: 'name', label: 'Package', value: (item) => item.name },
              {
                key: 'action',
                label: 'Actions',
                value: () => '',
                render: (item) => (
                  <WorkflowActions
                    entityLabel={item.name}
                    actions={[
                      {
                        id: 'request',
                        label: 'Request access',
                        onSelect: () => open({ kind: 'request', item }),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
          {!requestable.length && <p>No packages available to request on this page.</p>}
          {next.requests && (
            <Button
              type="button"
              className="min-h-11"
              onClick={() => setCursors((value) => ({ ...value, requests: next.requests! }))}
            >
              Next requestable packages
            </Button>
          )}
        </section>
      ) : (
        <>
          <section aria-label="Pending publishes">
            <h2 className="text-lg font-semibold">Pending publishes</h2>
            <p>
              {scope}. Approval releases a version only after all required security scans pass.
              Rejection is permanent for this version.
            </p>
            <p>
              {publishes.length} {publishes.length === 1 ? 'pending publish' : 'pending publishes'}{' '}
              on this page
            </p>
            <DataTable
              label="Pending publishes"
              items={publishes}
              columns={[
                {
                  key: 'package',
                  label: 'Package',
                  value: (item) => item.packageName,
                  render: (item) => (
                    <>
                      {item.packageName}
                      <span className="block font-mono">{item.version}</span>
                    </>
                  ),
                },
                {
                  key: 'context',
                  label: 'Source and requester',
                  value: (item) => item.sourceName,
                  render: (item) => (
                    <>
                      {item.sourceName}
                      <span className="block">
                        {item.requestedBy.name} · {item.project?.name ?? 'Organization'}
                      </span>
                    </>
                  ),
                },
                { key: 'scan', label: 'Security review', value: (item) => SCANS[item.scanState] },
                {
                  key: 'expires',
                  label: 'Expires',
                  value: (item) => item.expiresAt,
                  render: (item) => <Time value={item.expiresAt} />,
                },
                {
                  key: 'actions',
                  label: 'Actions',
                  value: () => '',
                  render: (item) =>
                    permissions.includes('org:packages:approve') ? (
                      <WorkflowActions
                        entityLabel={`${item.packageName} ${item.version}`}
                        actions={[
                          {
                            id: 'approve',
                            label: 'Approve publish',
                            onSelect: () => open({ kind: 'publish', item, action: 'approve' }),
                          },
                        ]}
                        overflow={[
                          {
                            id: 'reject',
                            label: 'Reject publish',
                            variant: 'destructive',
                            onSelect: () => open({ kind: 'publish', item, action: 'reject' }),
                          },
                        ]}
                      />
                    ) : null,
                },
              ]}
            />
            {!publishes.length && <p>No pending publishes on this page.</p>}
            {next.publishes && (
              <Button
                type="button"
                className="min-h-11"
                onClick={() => setCursors((value) => ({ ...value, publishes: next.publishes! }))}
              >
                Next publishes
              </Button>
            )}
          </section>
          <section aria-label="Access requests">
            <h2 className="text-lg font-semibold">Access requests</h2>
            <p>
              {scope}. Approval gives the named project access to this package. Other project access
              remains unchanged.
            </p>
            <p>
              {requests.length} {requests.length === 1 ? 'access request' : 'access requests'} on
              this page
            </p>
            <DataTable
              label="Access requests"
              items={requests}
              columns={[
                { key: 'package', label: 'Package', value: (item) => item.packageName },
                { key: 'project', label: 'Project', value: (item) => item.project.name },
                {
                  key: 'reason',
                  label: 'Requester and reason',
                  value: (item) => item.requestedBy.name,
                  render: (item) => (
                    <>
                      {item.requestedBy.name}
                      <p className="whitespace-pre-wrap">{item.reason || 'No reason provided'}</p>
                    </>
                  ),
                },
                {
                  key: 'expires',
                  label: 'Expires',
                  value: (item) => item.expiresAt,
                  render: (item) => <Time value={item.expiresAt} />,
                },
                {
                  key: 'actions',
                  label: 'Actions',
                  value: () => '',
                  render: (item) =>
                    permissions.includes('org:packages:manage') ? (
                      <WorkflowActions
                        entityLabel={`${item.packageName} for ${item.project.name}`}
                        actions={[
                          {
                            id: 'approve',
                            label: 'Approve access',
                            onSelect: () => open({ kind: 'access', item, action: 'approve' }),
                          },
                        ]}
                        overflow={[
                          {
                            id: 'reject',
                            label: 'Reject access',
                            variant: 'destructive',
                            onSelect: () => open({ kind: 'access', item, action: 'reject' }),
                          },
                        ]}
                      />
                    ) : null,
                },
              ]}
            />
            {!requests.length && <p>No pending access requests on this page.</p>}
            {next.requests && (
              <Button
                type="button"
                className="min-h-11"
                onClick={() => setCursors((value) => ({ ...value, requests: next.requests! }))}
              >
                Next access requests
              </Button>
            )}
          </section>
        </>
      )}
      <Button type="button" className="min-h-11" variant="outline" onClick={reload}>
        Refresh requests
      </Button>
      <Dialog
        open={decision !== null}
        onOpenChange={(value) => {
          if (!value && !busy) setDecision(null);
        }}
      >
        <DialogContent className="[&_button]:min-h-11 [&_button]:min-w-11">
          <DialogHeader>
            <DialogTitle>
              {decision?.kind === 'request'
                ? 'Request package access'
                : decision?.action === 'reject'
                  ? 'Reject request'
                  : 'Approve request'}
            </DialogTitle>
            <DialogDescription>
              {decision
                ? `${decision.kind === 'request' ? decision.item.name : decision.item.packageName} · ${decision.kind === 'access' ? decision.item.project.name : scope}. ${decision.kind === 'publish' ? 'Rejection permanently removes this version. Approval still requires all security scans to pass.' : 'An approved request gives this project access to the package.'}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="space-y-4"
            aria-busy={busy}
          >
            <Label htmlFor="package-decision-reason">
              Reason ({required ? 'required' : 'optional'})
            </Label>
            <Textarea
              id="package-decision-reason"
              ref={reasonField}
              className="min-h-24 w-full rounded border p-2"
              required={required}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              aria-describedby="package-reason-help package-decision-error"
              aria-invalid={!!error}
            />
            <p id="package-reason-help">
              At most 1000 UTF-8 bytes. The reason is recorded with the decision.
            </p>
            <p id="package-decision-error" role="alert">
              {error}
            </p>
            {stale && (
              <Button type="button" className="min-h-11" onClick={reload}>
                Reload latest requests
              </Button>
            )}
            <DialogFooter>
              <Button
                type="button"
                className="min-h-11"
                variant="outline"
                disabled={busy}
                onClick={() => setDecision(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={busy || stale}
                variant={required ? 'destructive' : 'default'}
              >
                {busy
                  ? 'Saving decision…'
                  : decision?.kind === 'request'
                    ? 'Send request'
                    : required
                      ? 'Confirm rejection'
                      : 'Confirm approval'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
