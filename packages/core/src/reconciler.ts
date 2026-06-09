// reconciler — state comes from the cluster, never from memory (spec §6).
// Queries kubectl for pod reality, checks the tmux session, derives status.
import { type RunResult, run } from './exec.js'
import type { PodInfo, Repo, RepoState, RepoStatus } from './types.js'

type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>

/** Derive a repo's lifecycle status from observed pods + session (spec §6 table). */
export function deriveStatus(pods: PodInfo[], hasSession: boolean): RepoStatus {
  const crashed = pods.some((p) => p.restartCount > 0 || p.phase === 'Failed')
  if (crashed) return 'CRASHED'

  const anyReady = pods.some((p) => p.ready)
  if (anyReady) return hasSession ? 'RUNNING_MANAGED' : 'RUNNING_EXTERNAL'

  // Pods exist but none ready yet → still coming up.
  if (pods.length > 0) return hasSession ? 'RUNNING_MANAGED' : 'RUNNING_EXTERNAL'

  // No pods. A live session means devspace dev is mid-build/deploy.
  if (hasSession) return 'BUILDING'
  return 'STOPPED'
}

/** Parse `kubectl get pods -o json` into PodInfo[]. Defensive against junk. */
export function parsePods(json: string): PodInfo[] {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return []
  }
  const items = (doc as { items?: unknown })?.items
  if (!Array.isArray(items)) return []

  const pods: PodInfo[] = []
  for (const item of items) {
    const meta = (item as { metadata?: { name?: string } }).metadata
    const status = (item as { status?: Record<string, unknown> }).status ?? {}
    const containers =
      (status.containerStatuses as { ready?: boolean; restartCount?: number }[] | undefined) ?? []
    const restartCount = containers.reduce((sum, c) => sum + (c.restartCount ?? 0), 0)
    const ready = containers.length > 0 && containers.every((c) => c.ready === true)
    pods.push({
      name: meta?.name ?? '<unknown>',
      phase: typeof status.phase === 'string' ? status.phase : 'Unknown',
      ready,
      restartCount,
    })
  }
  return pods
}

export class Reconciler {
  constructor(private readonly runner: Runner = run) {}

  /** Reconcile one repo against the cluster + its tmux session. */
  async reconcile(repo: Repo, hasSession: boolean): Promise<RepoState> {
    const pods = await this.fetchPods(repo)
    return {
      repo,
      status: deriveStatus(pods, hasSession),
      pods,
      hasSession,
      updatedAt: nowMs(),
    }
  }

  private async fetchPods(repo: Repo): Promise<PodInfo[]> {
    const args = ['get', 'pods', '-o', 'json']
    if (repo.namespace) args.push('-n', repo.namespace)
    if (repo.selector) args.push('-l', repo.selector)
    const r = await this.runner('kubectl', args).catch(() => undefined)
    if (!r || r.code !== 0) return []
    return parsePods(r.stdout)
  }
}

function nowMs(): number {
  return Date.now()
}
