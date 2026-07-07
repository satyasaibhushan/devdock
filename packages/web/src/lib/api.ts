// Thin client of the daemon's HTTP/WS API (spec §13). The web UI is a thin
// client of the same contract the MCP server and tray speak.

export type RepoStatus =
  | 'RUNNING_MANAGED'
  | 'RUNNING_EXTERNAL'
  | 'CRASHED'
  | 'STOPPED'
  | 'BUILDING'
  | 'DEPLOYED'
  | 'RESTARTING'

export interface PodInfo {
  name: string
  phase: string
  ready: boolean
  restartCount: number
}

export interface DeploymentInfo {
  name: string
  replicas: number
  readyReplicas: number
}

export interface Repo {
  id: string
  name: string
  path: string
  codeArea?: 'backend' | 'frontend'
  namespace?: string
  workload?: string
  ports: number[]
  /** Deployable workload types (`api`/`cron`/`worker`) when one config deploys
   *  several off a WORKLOAD_TYPE var. Absent for single-workload repos. */
  workloads?: string[]
  /** The workload acted on when none is chosen (the WORKLOAD_TYPE default). */
  defaultWorkload?: string
  session: string
}

/** One workload's reconciled view inside a (possibly multi-workload) repo. */
export interface WorkloadState {
  type: string
  status: RepoStatus
  pods: PodInfo[]
  deployments: DeploymentInfo[]
  hasSession: boolean
}

export interface RepoState {
  repo: Repo
  /** Aggregate status across workloads (the most attention-worthy). */
  status: RepoStatus
  /** Per-workload breakdown; always at least one entry. */
  workloads: WorkloadState[]
  pods: PodInfo[]
  deployments?: DeploymentInfo[]
  hasSession: boolean
  updatedAt: number
  /** Command auto-run in the `devspace dev` session once the pod is up. */
  startupCommand?: string
}

export type Verb = 'start' | 'build' | 'stop' | 'restart' | 'clear'

// The verbs that make sense for a workload's current state — the single source
// of truth shared by the detail pane and the list rows. `restart`
// (kill → build → start) is offered in every state as a one-click recycle.
//  - killed (STOPPED): build it first.
//  - built (DEPLOYED): start it, or kill it.
//  - running/building: kill it (start would just collide).
//  - crashed: clear pod (reset dev pod, no image change), restart, or kill.
export const STATUS_VERBS: Record<RepoStatus, Verb[]> = {
  STOPPED: ['build', 'restart'],
  DEPLOYED: ['start', 'restart', 'stop'],
  BUILDING: ['restart', 'stop'],
  RUNNING_MANAGED: ['restart', 'stop'],
  RUNNING_EXTERNAL: ['restart', 'stop'],
  CRASHED: ['clear', 'restart', 'stop'],
  RESTARTING: ['restart', 'stop'],
}

/** The global namespace view — the kube context's current namespace plus every
 *  namespace devdock has learned (cluster-wide listing is RBAC-forbidden). */
export interface NamespaceInfo {
  current: string
  known: string[]
}

export async function fetchNamespace(): Promise<NamespaceInfo> {
  const res = await fetch('/namespace')
  if (!res.ok) throw new Error(`GET /namespace → ${res.status}`)
  return res.json()
}

/** Switch the kube context's namespace (the UI face of the user's `kn` alias). */
export async function switchNamespace(namespace: string): Promise<NamespaceInfo> {
  const res = await fetch('/namespace', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ namespace }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `PUT /namespace → ${res.status}`)
  }
  return res.json()
}

/** Kubernetes OIDC auth, owned by the daemon (one shared login for everything). */
export interface AuthState {
  /** false = this cluster doesn't use oidc-login; the banner never shows. */
  oidc: boolean
  phase: 'unknown' | 'ok' | 'login_required' | 'logging_in' | 'error'
  message?: string
  tokenExpiresAt?: number
  checkedAt: number
}

export async function fetchAuth(): Promise<AuthState> {
  const res = await fetch('/auth')
  if (!res.ok) throw new Error(`GET /auth → ${res.status}`)
  return res.json()
}

/** Kick off the (single-flight) interactive login; poll /auth for the outcome. */
export async function startAuthLogin(): Promise<AuthState> {
  const res = await fetch('/auth/login', { method: 'POST' })
  if (!res.ok) throw new Error(`POST /auth/login → ${res.status}`)
  return res.json()
}

/** The UI face of `rm -r ~/.kube/cache/oidc-login`. */
export async function clearAuthCache(): Promise<AuthState> {
  const res = await fetch('/auth/clear', { method: 'POST' })
  if (!res.ok) throw new Error(`POST /auth/clear → ${res.status}`)
  return res.json()
}

export async function fetchRepos(): Promise<RepoState[]> {
  const res = await fetch('/repos')
  if (!res.ok) throw new Error(`GET /repos → ${res.status}`)
  return res.json()
}

export async function runVerb(id: string, verb: Verb, workload?: string): Promise<void> {
  const q = workload ? `?workload=${encodeURIComponent(workload)}` : ''
  const res = await fetch(`/repos/${encodeURIComponent(id)}/${verb}${q}`, { method: 'POST' })
  if (!res.ok) throw new Error(`${verb} ${id} → ${res.status}`)
}

/** Adopt an externally-managed workload: purge it, then start a managed
 *  `devspace dev` session in its place. */
export async function adoptRepo(id: string, workload?: string): Promise<void> {
  const q = workload ? `?workload=${encodeURIComponent(workload)}` : ''
  const res = await fetch(`/repos/${encodeURIComponent(id)}/adopt${q}`, { method: 'POST' })
  if (!res.ok) throw new Error(`adopt ${id} → ${res.status}`)
}

/** Save (or clear, with an empty string) the repo's startup command. */
export async function saveStartup(id: string, command: string): Promise<void> {
  const res = await fetch(`/repos/${encodeURIComponent(id)}/startup`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command }),
  })
  if (!res.ok) throw new Error(`save startup ${id} → ${res.status}`)
}

function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}

export function openEvents(): WebSocket {
  return new WebSocket(wsUrl('/events'))
}

export function openLogs(id: string, workload?: string): WebSocket {
  const q = workload ? `?workload=${encodeURIComponent(workload)}` : ''
  return new WebSocket(wsUrl(`/repos/${encodeURIComponent(id)}/logs${q}`))
}

export function openTerminal(
  id: string,
  mode: 'ro' | 'rw',
  cols?: number,
  rows?: number,
  workload?: string,
  kind: 'auto' | 'shell' = 'auto',
): WebSocket {
  const size = cols && rows ? `&cols=${cols}&rows=${rows}` : ''
  const wl = workload ? `&workload=${encodeURIComponent(workload)}` : ''
  const k = kind === 'shell' ? '&kind=shell' : ''
  return new WebSocket(
    wsUrl(`/repos/${encodeURIComponent(id)}/terminal?mode=${mode}${size}${wl}${k}`),
  )
}

/** Control-frame prefix on the terminal socket: anything else is raw keystrokes. */
export const TERM_CTL = '\x01'

/** Tell the daemon-side PTY the terminal's new size so tmux redraws to fit. */
export function sendResize(ws: WebSocket, cols: number, rows: number): void {
  ws.send(`${TERM_CTL}${JSON.stringify({ type: 'resize', cols, rows })}`)
}
