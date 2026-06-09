// The MCP server is a thin client of the one brain — the daemon's HTTP API
// (spec §19.1). It never spins its own Service, so it can never diverge.
import type { RepoState } from '@devdock/core'

export interface VerbResult {
  ok: boolean
  code: number
  stderr: string
}

/** The subset of the daemon HTTP contract the MCP tools call. */
export interface DaemonClient {
  list(): Promise<RepoState[]>
  status(id: string): Promise<RepoState>
  start(id: string): Promise<VerbResult>
  build(id: string): Promise<VerbResult>
  stop(id: string): Promise<VerbResult>
  logs(id: string, tail?: number): Promise<string[]>
  exec(id: string, command: string): Promise<VerbResult>
}

/** A DaemonClient backed by the running daemon's HTTP endpoints. */
export function httpClient(baseUrl: string): DaemonClient {
  const url = (path: string) => `${baseUrl.replace(/\/$/, '')}${path}`
  const id = (s: string) => encodeURIComponent(s)

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(url(path))
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
    return res.json() as Promise<T>
  }

  async function post(path: string, body?: unknown): Promise<VerbResult> {
    const res = await fetch(url(path), {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = (await res.json().catch(() => ({}))) as Partial<VerbResult> & { error?: string }
    if (!res.ok) throw new Error(data.error ?? `POST ${path} → ${res.status}`)
    return { ok: data.ok ?? false, code: data.code ?? 0, stderr: data.stderr ?? '' }
  }

  return {
    list: () => getJson<RepoState[]>('/repos'),
    status: (i) => getJson<RepoState>(`/repos/${id(i)}`),
    start: (i) => post(`/repos/${id(i)}/start`),
    build: (i) => post(`/repos/${id(i)}/build`),
    stop: (i) => post(`/repos/${id(i)}/stop`),
    logs: (i, tail = 200) => getJson<string[]>(`/repos/${id(i)}/logs?tail=${tail}`),
    exec: (i, command) => post(`/repos/${id(i)}/exec`, { command }),
  }
}
