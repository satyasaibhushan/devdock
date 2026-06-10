// Thin client of the daemon's HTTP/WS API (spec §13). The web UI is a thin
// client of the same contract the MCP server and tray speak.

export type RepoStatus =
  | 'RUNNING_MANAGED'
  | 'RUNNING_EXTERNAL'
  | 'CRASHED'
  | 'STOPPED'
  | 'BUILDING'
  | 'DEPLOYED'

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
  namespace?: string
  workload?: string
  ports: number[]
  session: string
}

export interface RepoState {
  repo: Repo
  status: RepoStatus
  pods: PodInfo[]
  deployments?: DeploymentInfo[]
  hasSession: boolean
  updatedAt: number
}

export type Verb = 'start' | 'build' | 'stop' | 'restart'

export async function fetchRepos(): Promise<RepoState[]> {
  const res = await fetch('/repos')
  if (!res.ok) throw new Error(`GET /repos → ${res.status}`)
  return res.json()
}

export async function runVerb(id: string, verb: Verb): Promise<void> {
  const res = await fetch(`/repos/${encodeURIComponent(id)}/${verb}`, { method: 'POST' })
  if (!res.ok) throw new Error(`${verb} ${id} → ${res.status}`)
}

function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}

export function openEvents(): WebSocket {
  return new WebSocket(wsUrl('/events'))
}

export function openLogs(id: string): WebSocket {
  return new WebSocket(wsUrl(`/repos/${encodeURIComponent(id)}/logs`))
}

export function openTerminal(id: string, mode: 'ro' | 'rw'): WebSocket {
  return new WebSocket(wsUrl(`/repos/${encodeURIComponent(id)}/terminal?mode=${mode}`))
}
