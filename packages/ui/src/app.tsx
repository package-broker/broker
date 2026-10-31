import { ProductFooter } from './components/product-footer.js';
import { CSPProvider } from '@base-ui/react/csp-provider';
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
  AuthLayout,
  LoginScreen,
  SigninFailedView,
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
import { buildListFilterHash } from './page-hash.js';
import { clearPendingTokenIssue } from './token-pending.js';
import type { PendingStorage } from './pending.js';
import { PageLoader } from './page-loader.js';

export const PAGES = {
  projects: () => import('./pages/projects.js').then((page) => page.ProjectsPage),
  access: () => import('./pages/access.js').then((page) => page.AccessPage),
  sources: () => import('./pages/sources.js').then((page) => page.SourcesPage),
  packages: () => import('./pages/packages.js').then((page) => page.PackagesPage),
  'npm-login': () => import('./pages/npm-login.js').then((page) => page.NpmLoginPage),
  tokens: () => import('./pages/tokens.js').then((page) => page.TokensPage),
  audit: () => import('./pages/audit.js').then((page) => page.AuditPage),
  import: () => import('./pages/import.js').then((page) => page.ImportPage),
} as const satisfies Record<string, () => Promise<ComponentType>>;

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
  const route = /^npm-login\/[A-Za-z0-9_-]{43}$/.test(name)
    ? 'npm-login'
    : /^packages\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(name)
      ? 'packages'
      : (ROUTES.find((known) => known === name) ?? null);
  const raw = route !== null || path === '' || path === '/' ? null : path.slice(0, MAX_SHOWN);
  return { route, raw, project, query };
}

export function buildHash(route: Route, project: string | null): string {
  return buildListFilterHash(route, { project });
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
  storage?: PendingStorage;
  onSignedOut: () => void;
}): Promise<boolean> {
  const result = await deps.client.request('post', '/_pb/auth/logout');
  if (!result.ok) return false;
  deps.clearPending();
  if (deps.storage) clearPendingTokenIssue(deps.storage);
  deps.onSignedOut();
  return true;
}

export function bindProjectReplay(
  flow: Pick<ReturnType<typeof createReauthFlow>, 'subscribeReplay'>,
  onProjectsChanged: () => void,
) {
  return flow.subscribeReplay((result) => {
    if (result.ok && /^\/_pb\/projects(?:\/[^/]+(?:\/(?:archive|restore))?)?$/.test(result.path))
      onProjectsChanged();
  });
}

const PRIMARY_NAV: readonly { route: PageRoute; label: string }[] = [
  { route: 'projects', label: 'Projects' },
  { route: 'access', label: 'Access' },
  { route: 'sources', label: 'Sources' },
  { route: 'packages', label: 'Packages' },
  { route: 'tokens', label: 'Tokens' },
];

const ADMINISTRATION_NAV: readonly { route: PageRoute; label: string }[] = [
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
      <Label id="scope-label" className="sr-only lg:not-sr-only">
        Scope
      </Label>
      <Select
        value={props.project ?? ORGANIZATION_SCOPE}
        aria-labelledby="scope-label"
        className="w-36 max-w-full lg:w-48"
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
  visibleRoutes?: readonly PageRoute[];
  children?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isVisible = (item: { route: PageRoute }) =>
    props.visibleRoutes === undefined || props.visibleRoutes.includes(item.route);
  const primary = PRIMARY_NAV.filter(isVisible);
  const administration = ADMINISTRATION_NAV.filter(isVisible);
  const renderItem = (item: { route: PageRoute; label: string }, secondary = false) => (
    <li key={item.route}>
      <a
        href={buildHash(item.route, props.project)}
        onClick={() => setMenuOpen(false)}
        aria-current={props.route === item.route ? 'page' : undefined}
        className={cn(
          'block rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100',
          secondary && props.route !== item.route && 'text-neutral-500',
          props.route === item.route && 'bg-neutral-100 font-medium',
        )}
      >
        {item.label}
      </a>
    </li>
  );
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="shell-header">
        <span className="shell-brand font-semibold">Package Broker</span>
        <nav aria-label="Main" id="main-nav" className={`shell-nav ${menuOpen ? 'is-open' : ''}`}>
          <ul className="shell-nav-group">{primary.map((item) => renderItem(item))}</ul>
          {administration.length > 0 && (
            <>
              <hr className="shell-nav-divider" />
              <ul className="shell-nav-group shell-nav-administration" aria-label="Administration">
                {administration.map((item) => renderItem(item, true))}
              </ul>
            </>
          )}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-2">
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
          <button
            type="button"
            className="rounded-md border border-neutral-300 px-2 py-1.5 lg:hidden"
            aria-label="Main menu"
            aria-controls="main-nav"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            ☰
          </button>
        </div>
      </header>
      <main className="mx-auto w-full min-w-0 max-w-7xl flex-1 p-4 sm:p-6">
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
      <ProductFooter />
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
  return (
    <CSPProvider disableStyleElements>
      <AppContent {...props} />
    </CSPProvider>
  );
}

function AppContent(props: { client?: AuthClient }) {
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
  const [projectsVersion, setProjectsVersion] = useState(0);
  const onProjectsChanged = useCallback(() => setProjectsVersion((version) => version + 1), []);
  const storage = useMemo<PendingStorage>(
    () => ({
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
    }),
    [],
  );
  const flow = useMemo(
    () =>
      createReauthFlow({
        client,
        storage,
        now: Date.now,
        navigate: go,
      }),
    [client, go, storage],
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
  }, [client, session, projectsVersion]);

  useEffect(() => bindProjectReplay(flow, onProjectsChanged), [flow, onProjectsChanged]);

  const services = useMemo<ShellServices>(
    () => ({
      client,
      subscribeReplay: flow.subscribeReplay,
      onProjectsChanged,
      requireReauth: (request, options) =>
        flow.requireReauth(request, options, window.location.hash),
    }),
    [client, flow, onProjectsChanged],
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

  if (hash.split('?')[0] === '#/signin-failed') {
    return (
      <AuthLayout>
        <SigninFailedView
          hash={hash}
          reason={parseHash(hash).query.get('reason')}
          signedIn={session === 'in'}
        />
      </AuthLayout>
    );
  }

  const resolved = resolveRoute(hash, session === 'in');
  if (session === 'out') {
    return (
      <AuthLayout>
        {resolved.route === 'setup' ? (
          <SetupScreen client={client} onSignedIn={onSignedIn} />
        ) : (
          <LoginScreen client={client} onSignedIn={onSignedIn} />
        )}
      </AuthLayout>
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
            storage,
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
          <PageLoader key={resolved.route} load={Page} />
        )}
      </Shell>
      <ReauthConfirm flow={flow} />
    </ServicesContext.Provider>
  );
}
