import { useEffect, useState, type FormEvent } from 'react';
import { useServices } from '../auth.js';
import { Button } from '../components/ui/button.js';
import { Label } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Time } from '../components/ui/time.js';
import type { operations } from '../api-types.js';
type Confirmation = operations['getNpmLogin']['responses'][200]['content']['application/json'];
export function NpmLoginPage() {
  const selector = /^#\/npm-login\/([A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1] ?? '';
  return <NpmLoginConfirmation key={selector} selector={selector} />;
}
function NpmLoginConfirmation({ selector }: { selector: string }) {
  const { client } = useServices();
  const [request, setRequest] = useState<Confirmation | null>(null);
  const [write, setWrite] = useState(false);
  const [scope, setScope] = useState('read');
  const [state, setState] = useState('loading');
  useEffect(() => {
    let active = true;
    void client
      .request('get', '/_pb/me/npm-login/{selector}', { params: { selector } })
      .then(async (result) => {
        if (!active) return;
        if (!result.ok) {
          setState(result.code === 'reauth_required' ? 'reauth' : 'error');
          return;
        }
        setRequest(result.data);
        setState('ready');
        const permissions = await client.request('get', '/_pb/projects/{project}/permissions', {
          params: { project: result.data.project.slug },
        });
        if (active)
          setWrite(permissions.ok && permissions.data.project.includes('project:packages:write'));
      });
    return () => {
      active = false;
    };
  }, [client, selector]);
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if ((state !== 'ready' && state !== 'failed') || request === null) return;
    setState('busy');
    const result = await client.request('post', '/_pb/me/npm-login/{selector}', {
      params: { selector },
      body: { scope: scope === 'write' ? 'write' : 'read' },
    });
    setState(
      result.ok
        ? 'done'
        : result.code === 'reauth_required'
          ? 'reauth'
          : result.code === 'conflict'
            ? 'conflict'
            : 'failed',
    );
  }
  return (
    <section className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Confirm npm login</h1>
      <Alert>
        <AlertDescription>
          Only continue if you ran npm login yourself a moment ago. Someone else may have sent you
          this link to gain access through your account.
        </AlertDescription>
      </Alert>
      {state === 'loading' && <p role="status">Loading login request…</p>}
      {state === 'reauth' && (
        <p>
          Confirm your identity before reviewing this request.{' '}
          <a
            className="underline"
            href={`#/reauth?return=${encodeURIComponent(`/npm-login/${selector}`)}`}
          >
            Reauthenticate
          </a>
        </p>
      )}
      {['error', 'conflict'].includes(state) && (
        <p role="alert">
          This login request is unavailable or has already been confirmed. Run npm login again.
        </p>
      )}
      {state === 'done' ? (
        <p role="status">Login approved. Return to your terminal to collect the token.</p>
      ) : (
        request !== null &&
        state !== 'reauth' && (
          <form onSubmit={(event) => void confirm(event)} className="space-y-4">
            <dl className="space-y-2 break-words">
              <dt>Project</dt>
              <dd>
                {request.project.name} ({request.project.slug})
              </dd>
              <dt>CLI hostname</dt>
              <dd>{request.cliHostname ?? 'Unavailable'}</dd>
              <dt>Source IP</dt>
              <dd>{request.sourceIp ?? 'Unavailable'}</dd>
              <dt>Requested</dt>
              <dd>
                <Time value={request.createdAt} />
              </dd>
              <dt>Request expires</dt>
              <dd>
                <Time value={request.expiresAt} />
              </dd>
            </dl>
            <div>
              <Label htmlFor="npm-login-scope">Token access</Label>
              <Select
                id="npm-login-scope"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
                disabled={state === 'busy'}
              >
                <option value="read">Install and download</option>
                {write && <option value="write">Install, download and publish</option>}
              </Select>
            </div>
            <p>
              This creates a personal token for this project with the organization’s default
              lifetime. It carries only permissions you currently hold.
            </p>
            {state === 'failed' && (
              <p role="alert">
                Login could not be approved. Review the request before trying again.
              </p>
            )}
            <Button
              type="submit"
              disabled={state !== 'ready' && state !== 'failed'}
              className="min-h-11 w-full sm:w-auto"
            >
              {state === 'busy' ? 'Approving login…' : 'Approve login'}
            </Button>
            {state === 'failed' && (
              <Button type="button" onClick={() => setState('ready')}>
                Review again
              </Button>
            )}
          </form>
        )
      )}
    </section>
  );
}
