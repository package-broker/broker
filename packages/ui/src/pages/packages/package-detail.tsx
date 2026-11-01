import { useEffect, useRef, useState } from 'react';
import type { operations } from '../../api-types.js';
import type { ShellServices } from '../../auth.js';
import type { PackageItem, VersionItem } from '../packages.js';
import { PackageVersions } from '../packages.js';
import { SOURCE_TYPE_LABELS } from '../sources/source-form.js';
import { Button } from '../../components/ui/button.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { ListState } from '../../components/ui/list-state.js';
import { Time } from '../../components/ui/time.js';
import {
  accessSetting,
  canEditAccess,
  decisionAllowed,
  type AccessChoice,
} from './npm-workflow.js';

export function installSnippet(ecosystem: string, name: string, origin: string, project: string) {
  const repository = `${origin}/${encodeURIComponent(project)}`;
  return ecosystem === 'npm'
    ? `registry=${repository}/npm/`
    : `composer config repositories.${project} composer ${repository}\ncomposer require ${name}`;
}

type PackageDetailItem = operations['getPackage']['responses'][200]['content']['application/json'];
type ResultReadme =
  operations['getProjectPackageReadme']['responses'][200]['content']['application/json'];
type Project = { id: string; name: string; slug: string };
export function PackageDetail({
  services,
  id,
  project,
  back = '#/packages',
}: {
  services: ShellServices;
  id: string;
  project: string | null;
  back?: string;
}) {
  const [item, setItem] = useState<PackageItem | null>(null);
  const [settings, setSettings] = useState<PackageDetailItem | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState(project ?? '');
  const [projectName, setProjectName] = useState('');
  const [organization, setOrganization] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [after, setAfter] = useState<string | undefined>();
  const [next, setNext] = useState<string | null>(null);
  const [versionError, setVersionError] = useState(false);
  const [readme, setReadme] = useState<ResultReadme | null>(null);
  const [readmeAttempt, setReadmeAttempt] = useState(0);
  const readmeStatus = useRef<HTMLParagraphElement>(null);
  const [readmeRetry, setReadmeRetry] = useState(false);
  const [readmeState, setReadmeState] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [choice, setChoice] = useState<AccessChoice>('unavailable');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    ++generation.current;
    setLoading(true);
    setFailed(false);
    setItem(null);
    setSettings(null);
    setOrganization([]);
    setPermissions([]);
    setBusy(false);
    lock.current = false;
    void (async () => {
      const [org, proj, info] = await Promise.all([
        services.client.request('get', '/_pb/me/permissions'),
        project
          ? services.client.request('get', '/_pb/projects/{project}/permissions', {
              params: { project },
            })
          : null,
        project
          ? services.client.request('get', '/_pb/projects/{project}', { params: { project } })
          : null,
      ]);
      const result = project
        ? await services.client.request('get', '/_pb/projects/{project}/packages/{package}', {
            params: { project, package: id },
          })
        : await services.client.request('get', '/_pb/packages/{package}', {
            params: { package: id },
          });
      const found = result.ok ? result.data : null;
      const orgItem = found;
      if (!active) return;
      if (!result.ok) setFailed(true);
      setItem(found);
      setSettings(orgItem);
      setChoice(
        orgItem?.visibleToNewProjects
          ? 'available'
          : orgItem?.newProjectAccessMode === 'request'
            ? 'request'
            : 'unavailable',
      );
      setStale(false);
      setOrganization(org.ok ? org.data.organization : []);
      setPermissions(proj?.ok ? proj.data.project : []);
      setProjectId(info?.ok ? info.data.id : null);
      setProjectName(info?.ok ? info.data.name : '');
      if (!project && org.ok && org.data.organization.includes('org:projects:read')) {
        const all: Project[] = [];
        let projectCursor: string | undefined;
        do {
          const list = await services.client.request('get', '/_pb/projects', {
            query: { after: projectCursor },
          });
          if (!active) return;
          if (!list.ok) break;
          all.push(...list.data.items);
          projectCursor = list.data.next ?? undefined;
        } while (projectCursor);
        setProjects(all);
        if (found?.source.projectId) {
          const owner = all.find((entry) => entry.id === found.source.projectId);
          if (owner) {
            const authority = await services.client.request(
              'get',
              '/_pb/projects/{project}/permissions',
              { params: { project: owner.slug } },
            );
            if (!active) return;
            setPermissions(authority.ok ? authority.data.project : []);
            setProjectId(owner.id);
          }
        }
      }
      setLoading(false);
    })();
    return () => {
      active = false;
      ++generation.current;
    };
  }, [services, id, project, refresh]);
  useEffect(() => {
    if (!item) return;
    let active = true;
    setVersions([]);
    setVersionError(false);
    void (async () => {
      const result = project
        ? await services.client.request(
            'get',
            '/_pb/projects/{project}/packages/{package}/versions',
            { params: { project, package: id }, query: { after } },
          )
        : await services.client.request('get', '/_pb/packages/{package}/versions', {
            params: { package: id },
            query: { after },
          });
      if (!active) return;
      setVersions(result.ok ? result.data.items : []);
      setNext(result.ok ? result.data.next : null);
      setVersionError(!result.ok);
    })();
    return () => {
      active = false;
    };
  }, [services, item, id, project, after, refresh]);
  useEffect(() => {
    let active = true;
    setReadme(null);
    setReadmeRetry(false);
    if (!selected) {
      setReadmeState('Choose a project to read the README within its package access.');
      return;
    }
    setReadmeState('Loading README…');
    void services.client
      .request('get', '/_pb/projects/{project}/packages/{package}/readme', {
        params: { project: selected, package: id },
      })
      .then((result) => {
        if (!active) return;
        setReadme(result.ok ? result.data : null);
        setReadmeRetry(!result.ok && (result.status === 0 || result.status >= 500));
        setReadmeState(
          result.ok
            ? 'README loaded.'
            : result.status === 403
              ? 'This project cannot read this package.'
              : result.status === 404
                ? 'No README is available for the active latest version in this project.'
                : result.status === 0 || result.status >= 500
                  ? 'README could not be loaded. Try again.'
                  : 'README is unavailable.',
        );
      });
    return () => {
      active = false;
    };
  }, [services, id, selected, refresh, readmeAttempt]);
  useEffect(
    () =>
      services.subscribeReplay?.((result) => {
        if (result.path !== `/_pb/packages/${encodeURIComponent(id)}/access`) return;
        if (result.ok) {
          setNotice('Access policy saved. Existing project access is unchanged.');
          setRefresh((value) => value + 1);
        } else {
          setStale(true);
          setNotice('The policy could not be saved. Reload the latest settings before saving.');
        }
      }),
    [services, id],
  );
  const editable =
    item && canEditAccess(item.source.projectId, organization, permissions, projectId);
  async function save() {
    if (!settings || lock.current || !decisionAllowed(!!editable, busy, stale, 'pending')) return;
    lock.current = true;
    setBusy(true);
    setNotice('');
    const current = generation.current;
    const result = await services.client.request('patch', '/_pb/packages/{package}/access', {
      params: { package: id },
      body: { ...accessSetting(choice), revision: settings.revision },
    });
    if (current !== generation.current) return;
    lock.current = false;
    setBusy(false);
    if (!result.ok) {
      if (result.code === 'reauth_required')
        services.requireReauth(result.request, {
          credential: false,
          secretFields: [],
          display: {
            version: '',
            packageName: settings.name,
            scope: project ? `Project ${projectName}` : 'Organization',
          },
        });
      if (result.status === 409) {
        setStale(true);
        setNotice(
          'This package changed while you were editing. Reload the latest settings before saving. Your selection is retained for comparison.',
        );
      } else
        setNotice(
          result.code === 'reauth_required'
            ? 'Sign in again, then reload and review the access policy before saving.'
            : 'Access policy could not be saved. Try again.',
        );
      return;
    }
    setSettings({ ...settings, ...result.data });
    setNotice('Access policy saved. Existing project access is unchanged.');
  }
  return (
    <section aria-labelledby="package-detail-heading" className="min-w-0 space-y-6 break-words">
      <a href={back} className="inline-flex min-h-11 items-center text-blue-700 underline">
        Back to packages
      </a>
      <div className="flex flex-wrap items-center gap-4">
        <h1 id="package-detail-heading" tabIndex={-1} className="text-2xl font-semibold">
          {item?.name ?? 'Package details'}
        </h1>
        <Button
          type="button"
          className="min-h-11"
          variant="outline"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Reload package
        </Button>
      </div>
      {loading ? (
        <ListState kind="loading" title="Loading package…" />
      ) : failed ? (
        <ListState
          kind="error"
          title="Package could not be loaded."
          children={
            <Button
              type="button"
              className="min-h-11"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Try again
            </Button>
          }
        />
      ) : !item ? (
        <p>Package unavailable in this scope.</p>
      ) : (
        <>
          <p>
            {project ? `Project ${projectName}` : 'Organization'} · Source: {item.source.name} ·{' '}
            {SOURCE_TYPE_LABELS[item.source.type]}
          </p>
          <p role="status">{notice}</p>
          <a
            className="inline-flex min-h-11 items-center text-blue-700 underline"
            href={`${back}${back.includes('?') ? '&' : '?'}package=${id}`}
          >
            Manage version status
          </a>
          {settings && editable && (
            <form
              className="max-w-5xl space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Label htmlFor="package-new-access">Access for new projects</Label>
              <Select
                className="min-h-11"
                id="package-new-access"
                value={choice}
                onChange={(event) => setChoice(event.target.value as AccessChoice)}
                disabled={busy}
                aria-describedby="package-access-help"
              >
                <option value="available">Available</option>
                <option value="request">Require approval</option>
                <option value="unavailable">Not available</option>
              </Select>
              <p id="package-access-help">
                {item.source.projectId
                  ? `Project ${projectName || projects.find((entry) => entry.id === item.source.projectId)?.name || 'Name unavailable'}`
                  : 'Organization'}{' '}
                · {item.name}. Available allows new projects to use this package. Require approval
                lets project managers request access. Not available prevents new project access.
                Existing project access is unchanged.
              </p>
              <Button className="min-h-11" type="submit" disabled={busy || stale}>
                {busy ? 'Saving access policy…' : 'Save access policy'}
              </Button>
              {stale && (
                <Button
                  type="button"
                  className="min-h-11"
                  variant="outline"
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  Reload latest settings
                </Button>
              )}
            </form>
          )}
          <div>
            {!project && (
              <>
                <Label htmlFor="readme-project">Project for README and install instructions</Label>
                <Select
                  className="min-h-11"
                  id="readme-project"
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  <option value="">Choose a project</option>
                  {projects.map((entry) => (
                    <option key={entry.id} value={entry.slug}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
              </>
            )}
          </div>
          <section>
            <h2 className="text-lg font-semibold">Install</h2>
            {item.ecosystem === 'npm' && selected && (
              <p>Add this line to .npmrc, then run npm install {item.name}.</p>
            )}
            {selected ? (
              <pre className="whitespace-pre-wrap break-all rounded border p-4">
                {installSnippet(item.ecosystem, item.name, window.location.origin, selected)}
              </pre>
            ) : (
              <p>
                Choose a project to see its registry address. Configure project credentials in your
                package manager.
              </p>
            )}
          </section>
          <section>
            <h2 className="text-lg font-semibold">README</h2>
            <p ref={readmeStatus} tabIndex={-1} role="status">
              {readmeState}
            </p>
            {readme && (
              <>
                <p>
                  {readme.filename} · {readme.sizeBytes} bytes
                </p>
                <pre className="max-w-full whitespace-pre-wrap break-all rounded border p-4 font-mono text-sm">
                  {readme.body}
                </pre>
              </>
            )}
            {readmeRetry && (
              <Button
                type="button"
                className="min-h-11"
                variant="outline"
                onClick={() => {
                  readmeStatus.current?.focus();
                  setReadmeAttempt((value) => value + 1);
                }}
              >
                Try again
              </Button>
            )}
          </section>
          <section>
            <h2 className="text-lg font-semibold">Versions</h2>
            {versionError ? (
              <p role="alert">Versions could not be loaded. Reload the package to try again.</p>
            ) : (
              <>
                <PackageVersions
                  item={item}
                  versions={versions}
                  access={{ organization: [], project: [], projectId: null, projectSlug: project }}
                  busy={false}
                  onAction={() => {}}
                />
                {versions.map((version) => (
                  <details key={version.id} className="my-4 rounded border p-4">
                    <summary className="min-h-11 cursor-pointer">
                      Publication details for {version.version}
                    </summary>
                    <dl>
                      <dt>Integrity</dt>
                      <dd className="break-all font-mono">{version.integrity ?? 'Unavailable'}</dd>
                      <dt>Distribution tags</dt>
                      <dd>{version.distTags.join(', ') || 'No tags'}</dd>
                      <dt>Published through the broker</dt>
                      <dd>{version.publishedBy?.displayName ?? 'Attribution unavailable'}</dd>
                      <dt>Approved by</dt>
                      <dd>
                        {version.approvedBy ? (
                          <>
                            {version.approvedBy.displayName} ·{' '}
                            <Time value={version.approvedBy.decidedAt} />
                          </>
                        ) : (
                          'Not approved'
                        )}
                      </dd>
                    </dl>
                  </details>
                ))}
                {next && (
                  <Button type="button" className="min-h-11" onClick={() => setAfter(next)}>
                    Next versions
                  </Button>
                )}
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
