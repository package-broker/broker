import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { createApiClient } from './api.js';
import type { paths } from './api-types.js';
import {
  LoginScreen,
  ReauthConfirm,
  ReauthScreen,
  ServicesContext,
  SetupScreen,
  createReauthFlow,
  safePageHash,
  reauthReturnHash,
  type AuthClient,
  type ShellServices,
} from './auth.js';
import { Alert, AlertDescription } from './components/ui/alert.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.js';
import { Label } from './components/ui/label.js';
import { Select } from './components/ui/select.js';
import { cn } from './lib/utils.js';
import { AccessPage } from './pages/access.js';
import { AuditPage } from './pages/audit.js';
import { ImportPage } from './pages/import.js';
import { PackagesPage } from './pages/packages.js';
import { ProjectsPage } from './pages/projects.js';
import { SourcesPage } from './pages/sources.js';
import { TokensPage } from './pages/tokens.js';

export const PAGES = {
  projects: ProjectsPage,
  access: AccessPage,
  sources: SourcesPage,
  packages: PackagesPage,
  tokens: TokensPage,
  audit: AuditPage,
  import: ImportPage,
} as const satisfies Record<string, ComponentType>;

export type PageRoute = keyof typeof PAGES;
export type Route = PageRoute | 'login' | 'setup' | 'reauth';

export const ROUTES: readonly Route[] = [
  ...(Object.keys(PAGES) as PageRoute[]),
  'login',
  'setup',
  'reauth',
];

const ORGANIZATION_SCOPE = '__organization__';
const SLUG = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_SHOWN = 80;

export interface ParsedHash {
  readonly route: Route | null;
  readonly raw: string | null;
  readonly project: string | null;
  readonly query: URLSearchParams;
}

export function parseHash(hash: string): ParsedHash {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const split = body.indexOf('?');
  const path = split < 0 ? body : body.slice(0, split);
  const query = new URLSearchParams(split < 0 ? '' : body.slice(split + 1));
  const candidate = query.get('project');
  const project = candidate !== null && SLUG.test(candidate) ? candidate : null;
  const name = path.startsWith('/') ? path.slice(1) : path;
  const route = ROUTES.find((known) => known === name) ?? null;
  const raw = route !== null || path === '' || path === '/' ? null : path.slice(0, MAX_SHOWN);
  return { route, raw, project, query };
}

export function buildHash(route: Route, project: string | null): string {
  return project === null ? `#/${route}` : `#/${route}?project=${encodeURIComponent(project)}`;
}

export function resolveRoute(
  hash: string,
  signedIn: boolean,
): { route: Route; project: string | null; unknown: string | null; query: URLSearchParams } {
  const parsed = parseHash(hash);
  const base = { project: parsed.project, unknown: parsed.raw, query: parsed.query };
  if (!signedIn) {
    return { ...base, route: parsed.route === 'setup' ? 'setup' : 'login' };
  }
  if (parsed.route === null || parsed.route === 'login' || parsed.route === 'setup') {
    return { ...base, route: 'projects' };
  }
  return { ...base, route: parsed.route };
}

type ProjectSummary = { id: string; name: string; slug: string; status: 'active' | 'archived' };

export function scopeOptions(projects: readonly ProjectSummary[]) {
  return [
    { value: ORGANIZATION_SCOPE, label: 'Organization' },
    ...projects
      .filter((project) => project.status === 'active')
      .map((project) => ({ value: project.slug, label: project.name })),
  ];
}

export async function loadProjects(client: AuthClient): Promise<ProjectSummary[]> {
  const projects: ProjectSummary[] = [];
  let after: string | undefined;
  do {
    const result =
      after === undefined
        ? await client.request('get', '/_pb/projects')
        : await client.request('get', '/_pb/projects', { query: { after } });
    if (!result.ok) return projects;
    projects.push(...result.data.items);
    after = result.data.next ?? undefined;
  } while (after !== undefined);
  return projects;
}

export async function signOut(deps: {
  client: AuthClient;
  clearPending: () => void;
  onSignedOut: () => void;
}): Promise<boolean> {
  const result = await deps.client.request('post', '/_pb/auth/logout');
  if (!result.ok) return false;
  deps.clearPending();
  deps.onSignedOut();
  return true;
}

const NAV: readonly { route: PageRoute; label: string }[] = [
  { route: 'projects', label: 'Projects' },
  { route: 'access', label: 'Access' },
  { route: 'sources', label: 'Sources' },
  { route: 'packages', label: 'Packages' },
  { route: 'tokens', label: 'Tokens' },
  { route: 'audit', label: 'Audit' },
  { route: 'import', label: 'Import' },
];

export function ScopeSwitcher(props: {
  project: string | null;
  projects: readonly ProjectSummary[];
  onScope: (project: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label id="scope-label">Scope</Label>
      <Select
        value={props.project ?? ORGANIZATION_SCOPE}
        aria-labelledby="scope-label"
        className="w-48"
        onChange={(event) =>
          props.onScope(event.target.value === ORGANIZATION_SCOPE ? null : event.target.value)
        }
      >
        {scopeOptions(props.projects).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function Shell(props: {
  route: Route;
  project: string | null;
  projects: readonly ProjectSummary[];
  unknown: string | null;
  onScope: (project: string | null) => void;
  onSignOut: () => void;
  signOutError?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="flex flex-wrap items-center gap-4 border-b border-neutral-200 bg-white px-6 py-3">
        <span className="font-semibold">Package Broker</span>
        <nav aria-label="Main" className="flex flex-wrap gap-1">
          {NAV.map((item) => (
            <a
              key={item.route}
              href={buildHash(item.route, props.project)}
              aria-current={props.route === item.route ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100',
                props.route === item.route && 'bg-neutral-100 font-medium',
              )}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <ScopeSwitcher
            project={props.project}
            projects={props.projects}
            onScope={props.onScope}
          />
          <DropdownMenu>
            <DropdownMenuTrigger>Account</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={props.onSignOut}>Sign out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-6">
        {props.unknown === null ? null : (
          <Alert className="mb-4">
            <AlertDescription>Unknown page: {props.unknown}</AlertDescription>
          </Alert>
        )}
        {props.signOutError ? (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>Sign-out failed. Try signing out again.</AlertDescription>
          </Alert>
        ) : null}
        {props.children}
      </main>
    </div>
  );
}

function useHash(): [string, (hash: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go = useCallback((next: string) => {
    window.location.hash = next;
  }, []);
  return [hash, go];
}

type Session = 'in' | 'out';

export async function checkSession(
  client: AuthClient,
  flow: Pick<ReturnType<typeof createReauthFlow>, 'restore'>,
  hash: string,
  onReauthenticated?: (hash: string) => void,
  isCurrent: () => boolean = () => true,
): Promise<Session | null> {
  const result = await client.request('get', '/_pb/session');
  if (!isCurrent()) return null;
  const parsed = parseHash(hash);
  if (
    result.ok &&
    result.data.reauthFresh &&
    parsed.route === 'reauth' &&
    parsed.query.get('sso') === 'complete'
  ) {
    flow.restore();
    onReauthenticated?.(reauthReturnHash(hash));
  }
  return result.ok ? 'in' : 'out';
}

export function App(props: { client?: AuthClient }) {
  const client = useMemo<AuthClient>(
    () =>
      props.client ??
      createApiClient<paths>({
        fetch: (url, init) => fetch(url, init),
        readCookie: (name) => {
          for (const part of document.cookie.split('; ')) {
            const eq = part.indexOf('=');
            if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
          }
          return undefined;
        },
      }),
    [props.client],
  );
  const [hash, go] = useHash();
  const [session, setSession] = useState<Session>('out');
  const initialProbe = useRef(true);
  const [signOutError, setSignOutError] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const flow = useMemo(
    () =>
      createReauthFlow({
        client,
        storage: {
          getItem: (key) => window.sessionStorage.getItem(key),
          setItem: (key, value) => window.sessionStorage.setItem(key, value),
          removeItem: (key) => window.sessionStorage.removeItem(key),
        },
        now: Date.now,
        navigate: go,
      }),
    [client, go],
  );

  useEffect(() => {
    let live = true;
    const initialHash = window.location.hash;
    void checkSession(client, flow, initialHash, go, () => live && initialProbe.current).then(
      (next) => {
        if (next === null) return;
        setSession(next);
      },
    );
    return () => {
      live = false;
    };
  }, [client, flow, go]);

  useEffect(() => {
    if (session !== 'in') return;
    let live = true;
    void loadProjects(client).then((items) => {
      if (live) setProjects(items);
    });
    return () => {
      live = false;
    };
  }, [client, session]);

  const services = useMemo<ShellServices>(
    () => ({
      client,
      subscribeReplay: flow.subscribeReplay,
      requireReauth: (request, options) =>
        flow.requireReauth(request, options, window.location.hash),
    }),
    [client, flow],
  );

  const onSignedIn = useCallback(() => {
    initialProbe.current = false;
    void client.request('get', '/_pb/session').then((result) => {
      setSession(result.ok ? 'in' : 'out');
      if (result.ok) {
        flow.clear();
        go(safePageHash(window.location.hash));
      }
    });
  }, [client, flow, go]);

  const resolved = resolveRoute(hash, session === 'in');
  if (session === 'out') {
    return resolved.route === 'setup' ? (
      <SetupScreen client={client} onSignedIn={onSignedIn} />
    ) : (
      <LoginScreen client={client} onSignedIn={onSignedIn} />
    );
  }

  const returnHash = reauthReturnHash(hash);
  const Page = resolved.route === 'reauth' ? null : PAGES[resolved.route as PageRoute];
  return (
    <ServicesContext.Provider value={services}>
      <Shell
        route={resolved.route}
        project={resolved.project}
        projects={projects}
        unknown={resolved.unknown}
        onScope={(project) =>
          go(buildHash(resolved.route === 'reauth' ? 'projects' : resolved.route, project))
        }
        signOutError={signOutError}
        onSignOut={() => {
          initialProbe.current = false;
          setSignOutError(false);
          void signOut({
            client,
            clearPending: () => flow.clear(),
            onSignedOut: () => {
              setProjects([]);
              setSession('out');
              go('#/login');
            },
          }).then((ok) => setSignOutError(!ok));
        }}
      >
        {Page === null ? (
          <ReauthScreen client={client} flow={flow} onDone={() => go(returnHash)} />
        ) : (
          <Page />
        )}
      </Shell>
      <ReauthConfirm flow={flow} />
    </ServicesContext.Provider>
  );
}
