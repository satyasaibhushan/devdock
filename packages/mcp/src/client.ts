// The MCP server is a thin client of the one brain — the daemon's HTTP API
// (spec §19.1). It never spins its own Service, so it can never diverge.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AuthState,
  LogQueryResult,
  LogSource,
  NamespaceInfo,
  ReplicaRecord,
  RepoState,
  RunOutcome,
  TermInfo,
  WaitResult,
  WorkloadRunResult,
} from '@devdock/core'

export interface BranchInfo {
  name: string
  lastCommitAt: number
}

export interface VerbResult {
  ok: boolean
  code: number
  stderr: string
}

/** exec additionally reports stdout (usually empty: tmux send-keys is
 *  fire-and-forget — the output lands in the dev session, not here). */
export interface ExecResult extends VerbResult {
  stdout: string
}

/** Lifecycle verbs the daemon exposes as POST /repos/:id/<verb>. */
export type RepoVerb = 'start' | 'build' | 'build-start' | 'restart' | 'destroy' | 'adopt' | 'clear'

export interface TermOpenOpts {
  repo?: string
  workload?: string
  kind?: 'auto' | 'shell' | 'local'
  cwd?: string
}

export interface LogQueryOpts {
  workload?: string
  source?: LogSource
  cursor?: string
  tail?: number
  contains?: string
}

export interface WaitOpts {
  workload?: string
  contains?: string
  source?: LogSource
  cursor?: string
  status?: string
  ready?: boolean
  timeoutMs?: number
}

/** The subset of the daemon HTTP contract the MCP tools call. */
export interface DaemonClient {
  list(): Promise<RepoState[]>
  status(id: string): Promise<RepoState>
  verb(verb: RepoVerb, id: string, workload?: string): Promise<VerbResult>
  logs(id: string, tail?: number, workload?: string): Promise<string[]>
  queryLogs(id: string, opts?: LogQueryOpts): Promise<LogQueryResult>
  runIn(
    id: string,
    command: string,
    opts?: { workload?: string; timeoutMs?: number },
  ): Promise<WorkloadRunResult>
  wait(id: string, opts: WaitOpts): Promise<WaitResult>
  exec(id: string, command: string, workload?: string): Promise<ExecResult>
  setStartup(id: string, command: string, workload?: string): Promise<void>
  namespace(): Promise<NamespaceInfo>
  setNamespace(ns: string): Promise<NamespaceInfo>
  auth(): Promise<AuthState>
  authLogin(): Promise<AuthState>
  authClear(): Promise<AuthState>
  branches(id: string): Promise<BranchInfo[]>
  replicaCreate(id: string, branch: string, ownImage?: boolean): Promise<ReplicaRecord>
  replicaList(): Promise<ReplicaRecord[]>
  replicaDelete(id: string): Promise<void>
  termList(): Promise<TermInfo[]>
  termOpen(opts: TermOpenOpts): Promise<TermInfo>
  termRun(tid: string, command: string, timeoutMs?: number): Promise<RunOutcome>
  termRead(tid: string, tail?: number): Promise<string>
  termClose(tid: string): Promise<void>
}

/** A DaemonClient backed by the running daemon's HTTP endpoints. */
export function httpClient(
  baseUrl: string,
  tokenFile = process.env.DEVDOCK_CONTROL_TOKEN_FILE ??
    join(homedir(), '.devdock', 'control-token'),
): DaemonClient {
  const url = (path: string) => `${baseUrl.replace(/\/$/, '')}${path}`
  const id = (s: string) => encodeURIComponent(s)
  const wl = (workload?: string) => (workload ? `?workload=${id(workload)}` : '')
  let token: string | undefined
  try {
    token = readFileSync(tokenFile, 'utf8').trim() || undefined
  } catch {
    // Loopback daemon access remains available. Remote ingress will reject it.
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    const res = await fetch(url(path), { ...init, headers })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; stderr?: string }
    if (!res.ok) {
      throw new Error(
        data.error ?? data.stderr ?? `${init?.method ?? 'GET'} ${path} → ${res.status}`,
      )
    }
    return data
  }

  const post = <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })

  const asVerb = (r: Partial<VerbResult>): VerbResult => ({
    ok: r.ok ?? false,
    code: r.code ?? 0,
    stderr: r.stderr ?? '',
  })

  return {
    list: () => request<RepoState[]>('/repos'),
    status: (i) => request<RepoState>(`/repos/${id(i)}`),
    verb: async (verb, i, workload) =>
      asVerb(await post<Partial<VerbResult>>(`/repos/${id(i)}/${verb}${wl(workload)}`)),
    logs: (i, tail, workload) =>
      request<string[]>(
        `/repos/${id(i)}/logs?tail=${tail ?? 200}${workload ? `&workload=${id(workload)}` : ''}`,
      ),
    queryLogs: (i, opts = {}) => {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined) qs.set(k, String(v))
      }
      const q = qs.toString()
      return request<LogQueryResult>(`/repos/${id(i)}/logs/query${q ? `?${q}` : ''}`)
    },
    runIn: (i, command, opts = {}) =>
      post<WorkloadRunResult>(`/repos/${id(i)}/run`, { command, ...opts }),
    wait: (i, opts) => post<WaitResult>(`/repos/${id(i)}/wait`, opts),
    exec: async (i, command, workload) => {
      const r = await post<Partial<ExecResult>>(`/repos/${id(i)}/exec${wl(workload)}`, { command })
      return { ...asVerb(r), stdout: r.stdout ?? '' }
    },
    setStartup: async (i, command, workload) => {
      await request(`/repos/${id(i)}/startup`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, workload }),
      })
    },
    namespace: () => request<NamespaceInfo>('/namespace'),
    setNamespace: (ns) =>
      request<NamespaceInfo>('/namespace', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ namespace: ns }),
      }),
    auth: () => request<AuthState>('/auth'),
    authLogin: () => post<AuthState>('/auth/login'),
    authClear: () => post<AuthState>('/auth/clear'),
    branches: (i) => request<BranchInfo[]>(`/repos/${id(i)}/branches`),
    replicaCreate: (i, branch, ownImage) =>
      post<ReplicaRecord>(`/repos/${id(i)}/replicas`, { branch, ownImage }),
    replicaList: () => request<ReplicaRecord[]>('/replicas'),
    replicaDelete: async (i) => {
      await request(`/replicas/${id(i)}`, { method: 'DELETE' })
    },
    termList: () => request<TermInfo[]>('/terminals'),
    termOpen: (opts) => post<TermInfo>('/terminals', opts),
    termRun: (tid, command, timeoutMs) =>
      post<RunOutcome>(`/terminals/${id(tid)}/run`, { command, timeoutMs }),
    termRead: async (tid, tail = 200) =>
      (await request<{ output: string }>(`/terminals/${id(tid)}/output?tail=${tail}`)).output,
    termClose: async (tid) => {
      await request(`/terminals/${id(tid)}`, { method: 'DELETE' })
    },
  }
}
