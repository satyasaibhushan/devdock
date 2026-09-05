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
  /** A scalar WORKLOAD_TYPE on a single-config repo. */
  workloadType?: string
  /** Set on replicas: the repo this one was cloned from. */
  parentId?: string
  /** The branch a replica was created from (detached at its creation-time tip). */
  branch?: string
  session: string
}

/** One workload's reconciled view inside a (possibly multi-workload) repo. */
export interface WorkloadState {
  ownerInstanceId?: string
  ownershipKnown?: boolean
  instanceId?: string
  unavailable?: boolean
  type: string
  status: RepoStatus
  pods: PodInfo[]
  deployments: DeploymentInfo[]
  hasSession: boolean
  actions: Verb[]
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
  actions: Verb[]
  updatedAt: number
  /** Command auto-run in the `devspace dev` session once the pod is up. */
  startupCommand?: string
  /** Startup commands keyed by pod type (api/worker/cron/ui/etc.). */
  startupCommands?: Record<string, string>
}

export type Verb = 'start' | 'build' | 'build_start' | 'restart' | 'destroy'
export interface Operation {
  id: string
  repo: string
  workload: string
  namespace: string
  action: Verb | 'verify'
  state: 'active' | 'succeeded' | 'failed' | 'interrupted'
  stage: 'checking' | 'deploying' | 'starting' | 'stopping' | 'waiting' | 'verifying'
  createdAt: number
  updatedAt: number
  checks: CheckResult[]
  logs: { at: number; message: string }[]
}
export interface CheckResult {
  id: string
  label: string
  status: 'passed' | 'failed' | 'unknown'
  detail: string
}
export interface Checkout {
  machine: string
  path: string
  branch: string | null
  commit: string | null
  dirty: boolean | null
  checkedAt: number
}
async function workflowRequest<T>(path: string, instance: string, body?: object): Promise<T> {
  const response = await fetch(
    path,
    body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
    instance,
  )
  if (!response.ok) {
    const error = (await response.json()) as { error?: string }
    throw new Error(error.error ?? 'Workflow request failed')
  }
  return response.json()
}
export const beginOperation = (
  repo: string,
  action: Verb | 'verify',
  workload: string | undefined,
  instance: string,
) =>
  workflowRequest<Operation>(`/repos/${encodeURIComponent(repo)}/operations`, instance, {
    action,
    workload,
  })
export const fetchOperations = (repo: string, instance: string) =>
  workflowRequest<Operation[]>(`/operations?repo=${encodeURIComponent(repo)}`, instance)
export const fetchCheckout = (repo: string, workload: string | undefined, instance: string) =>
  workflowRequest<Checkout>(
    `/repos/${encodeURIComponent(repo)}/checkout${workload ? `?workload=${encodeURIComponent(workload)}` : ''}`,
    instance,
  )
export const runPrerequisites = (repo: string, workload: string | undefined, instance: string) =>
  workflowRequest<CheckResult[]>(`/repos/${encodeURIComponent(repo)}/prerequisites`, instance, {
    action: 'verify',
    workload,
  })

/** The global namespace view — the kube context's current namespace plus every
 *  namespace devdock has learned (cluster-wide listing is RBAC-forbidden). */
export interface NamespaceInfo {
  current: string
  known: string[]
}

export const selectedInstance =
  new URLSearchParams(globalThis.location?.search ?? '').get('instance') ?? ''

export function instancePath(path: string, instance = selectedInstance): string {
  return instance ? `/instances/${encodeURIComponent(instance)}/api${path}` : path
}

function fetch(path: string, init?: RequestInit, instance = selectedInstance): Promise<Response> {
  return globalThis.fetch(instancePath(path, instance), init)
}

export interface InstanceView {
  id: string
  name: string
  local: boolean
  online: boolean
  terminals?: boolean
  auth?: AuthState
  aws?: { configured: boolean; fresh: boolean }
  repos: RepoState[]
}

export async function fetchInstances(): Promise<InstanceView[]> {
  const response = await globalThis.fetch('/instances')
  if (!response.ok) throw new Error('Cannot load instances')
  return response.json()
}

export async function stopSession(
  id: string,
  workload: string | undefined,
  instance: string,
): Promise<void> {
  const q = workload ? `?workload=${encodeURIComponent(workload)}` : ''
  const response = await fetch(
    `/repos/${encodeURIComponent(id)}/stop-session${q}`,
    { method: 'POST' },
    instance,
  )
  const result = (await response.json()) as { ok?: boolean; error?: string; stderr?: string }
  if (!response.ok || !result.ok)
    throw new Error(result.error ?? result.stderr ?? 'Could not stop session')
}

export async function linkInstance(
  host: string,
  endpoint: string,
  terminals: boolean,
): Promise<void> {
  const response = await globalThis.fetch('/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host, endpoint, terminals }),
  })
  if (!response.ok) throw new Error(((await response.json()) as { error: string }).error)
}

export async function unlinkInstance(id: string): Promise<void> {
  const response = await globalThis.fetch(`/instances/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!response.ok) throw new Error('Cannot unlink instance')
}

export function selectInstance(id: string, repo?: string): void {
  const url = new URL(location.href)
  if (id) url.searchParams.set('instance', id)
  else url.searchParams.delete('instance')
  if (repo) url.searchParams.set('repo', repo)
  else url.searchParams.delete('repo')
  // A full navigation disposes every old terminal and pending request together.
  location.assign(url.toString())
}

export async function fetchNamespace(instance = selectedInstance): Promise<NamespaceInfo> {
  const res = await fetch('/namespace', undefined, instance)
  if (!res.ok) throw new Error(`GET /namespace → ${res.status}`)
  return res.json()
}

/** Switch the kube context's namespace (the UI face of the user's `kn` alias). */
export async function switchNamespace(
  namespace: string,
  instance = selectedInstance,
): Promise<NamespaceInfo> {
  const res = await fetch(
    '/namespace',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace }),
    },
    instance,
  )
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
  loginUrl?: string
  checkedAt: number
}

export async function fetchAuth(instance = selectedInstance): Promise<AuthState> {
  const res = await fetch('/auth', undefined, instance)
  if (!res.ok) throw new Error(`GET /auth → ${res.status}`)
  return res.json()
}

/** Kick off the (single-flight) interactive login; poll /auth for the outcome. */
export async function startAuthLogin(instance = selectedInstance): Promise<AuthState> {
  const res = await fetch('/auth/login', { method: 'POST' }, instance)
  if (!res.ok) throw new Error(`POST /auth/login → ${res.status}`)
  return res.json()
}

/** The UI face of `rm -r ~/.kube/cache/oidc-login`. */
export async function clearAuthCache(instance = selectedInstance): Promise<AuthState> {
  const res = await fetch('/auth/clear', { method: 'POST' }, instance)
  if (!res.ok) throw new Error(`POST /auth/clear → ${res.status}`)
  return res.json()
}

export async function fetchRepos(): Promise<RepoState[]> {
  const res = await fetch('/repos')
  if (!res.ok) throw new Error(`GET /repos → ${res.status}`)
  return res.json()
}

export async function runVerb(
  id: string,
  verb: Verb,
  workload?: string,
  instance = selectedInstance,
): Promise<void> {
  const q = workload ? `?workload=${encodeURIComponent(workload)}` : ''
  const path = verb === 'build_start' ? 'build-start' : verb
  const res = await fetch(
    `/repos/${encodeURIComponent(id)}/${path}${q}`,
    { method: 'POST' },
    instance,
  )
  const body = (await res.json()) as { ok?: boolean; stderr?: string; error?: string }
  if (!res.ok) throw new Error(body.error ?? body.stderr ?? `${verb} ${id} → ${res.status}`)
  if (!body.ok) throw new Error(body.stderr ?? `${verb} failed`)
}

/** Adopt an externally-managed workload: purge it, then start a managed
 *  `devspace dev` session in its place. */
export async function adoptRepo(
  id: string,
  workload?: string,
  instance = selectedInstance,
): Promise<void> {
  const q = workload ? `?workload=${encodeURIComponent(workload)}` : ''
  const res = await fetch(
    `/repos/${encodeURIComponent(id)}/adopt${q}`,
    { method: 'POST' },
    instance,
  )
  if (!res.ok) throw new Error(`adopt ${id} → ${res.status}`)
}

/** Save (or clear, with an empty string) one pod type's startup command. */
export async function saveStartup(
  id: string,
  podType: string,
  command: string,
  instance = selectedInstance,
): Promise<void> {
  const res = await fetch(
    `/repos/${encodeURIComponent(id)}/startup`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, workload: podType }),
    },
    instance,
  )
  if (!res.ok) throw new Error(`save startup ${id} → ${res.status}`)
}

// ---- replicas ----
// Ephemeral branch-pinned parallel deployments of a repo (worktree + renamed
// devspace configs + alias ingress). A replica's id behaves as a normal repo
// id everywhere else in this API.

export interface BranchInfo {
  name: string
  lastCommitAt: number
}

export interface ReplicaRecord {
  id: string
  parentId: string
  branch: string
  path: string
  createdAt: number
  namespace?: string
  ingressApplied?: boolean
  ownImage?: boolean
}

export async function fetchBranches(
  id: string,
  instance = selectedInstance,
): Promise<BranchInfo[]> {
  const res = await fetch(`/repos/${encodeURIComponent(id)}/branches`, undefined, instance)
  if (!res.ok) throw new Error(`GET branches ${id} → ${res.status}`)
  return res.json()
}

export async function createReplica(
  id: string,
  branch: string,
  ownImage = false,
  instance = selectedInstance,
): Promise<ReplicaRecord> {
  const res = await fetch(
    `/repos/${encodeURIComponent(id)}/replicas`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch, ownImage }),
    },
    instance,
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `create replica → ${res.status}`)
  }
  return res.json()
}

export async function deleteReplica(id: string, instance = selectedInstance): Promise<void> {
  const res = await fetch(`/replicas/${encodeURIComponent(id)}`, { method: 'DELETE' }, instance)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `delete replica → ${res.status}`)
  }
}

function wsUrl(path: string, instance = selectedInstance): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${instancePath(path, instance)}`
}

export function openEvents(): WebSocket {
  // Directory refreshes belong to the serving daemon, not the default work target.
  return new WebSocket(wsUrl('/events', ''))
}

export function openLogs(id: string, workload?: string, instance = selectedInstance): WebSocket {
  const q = workload ? `?workload=${encodeURIComponent(workload)}` : ''
  return new WebSocket(wsUrl(`/repos/${encodeURIComponent(id)}/logs${q}`, instance))
}

// ---- terminals ----
// Terminals are daemon-owned, registered sessions (t1, t2, …) shared by every
// client — the UI, other browser windows, agents over MCP. The UI lists them,
// opens new ones over HTTP, and attaches to them as a live viewer over WS.

export interface TermInfo {
  id: string
  repo?: string
  workload?: string
  kind: 'auto' | 'shell' | 'local'
  /** What the PTY is connected to: tmux dev session, pod shell, host shell. */
  attach: 'tmux' | 'pod' | 'host'
  createdAt: number
  lastUsedAt: number
  alive: boolean
  /** Live viewers currently attached. */
  attached: number
}

export async function fetchTerminals(instance = selectedInstance): Promise<TermInfo[]> {
  const res = await fetch('/terminals', undefined, instance)
  if (!res.ok) throw new Error(`GET /terminals → ${res.status}`)
  return res.json()
}

/** Open (or, for kind 'auto', reuse) a registered terminal. */
export async function createTerminal(
  opts: {
    repo?: string
    workload?: string
    kind?: 'auto' | 'shell' | 'local'
  },
  instance = selectedInstance,
): Promise<TermInfo> {
  const res = await fetch(
    '/terminals',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    },
    instance,
  )
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `POST /terminals → ${res.status}`)
  }
  return res.json()
}

/** Close a terminal for ALL clients (the PTY dies, scrollback is dropped). */
export async function deleteTerminal(tid: string, instance = selectedInstance): Promise<void> {
  const res = await fetch(`/terminals/${encodeURIComponent(tid)}`, { method: 'DELETE' }, instance)
  if (!res.ok) throw new Error(`DELETE /terminals/${tid} → ${res.status}`)
}

/** Attach as a live viewer: scrollback replays first, then bytes stream. */
export function attachTerminal(
  tid: string,
  mode: 'ro' | 'rw',
  cols?: number,
  rows?: number,
  replay = true,
  instance = selectedInstance,
): WebSocket {
  const size = cols && rows ? `&cols=${cols}&rows=${rows}` : ''
  const replayParam = replay ? '' : '&replay=0'
  return new WebSocket(
    wsUrl(
      `/terminals/${encodeURIComponent(tid)}/attach?mode=${mode}${size}${replayParam}`,
      instance,
    ),
  )
}

/** Control-frame prefix on the terminal socket: anything else is raw keystrokes. */
export const TERM_CTL = '\x01'

/** Tell the daemon-side PTY the terminal's new size so tmux redraws to fit. */
export function sendResize(ws: WebSocket, cols: number, rows: number): void {
  ws.send(`${TERM_CTL}${JSON.stringify({ type: 'resize', cols, rows })}`)
}
