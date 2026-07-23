// reconciler — state comes from the cluster, never from memory (spec §6).
// Queries kubectl for pod + deployment reality, checks the tmux session,
// derives status.
import { type RunResult, run } from './exec.js'
import type {
  DeploymentInfo,
  PodInfo,
  Repo,
  RepoState,
  RepoStatus,
  WorkloadState,
} from './types.js'
import { assembleState } from './workloads.js'

type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>

/** Derive a repo's lifecycle status from observed pods + session (spec §6 table). */
export function deriveStatus(
  pods: PodInfo[],
  hasSession: boolean,
  hasDeployment = false,
  sessionDead = false,
  opts: { deployedWhenRunning?: boolean } = {},
): RepoStatus {
  // A managed dev session whose process exited (pane held open by
  // remain-on-exit) is a crash to surface — not a silent demotion to
  // RUNNING_EXTERNAL just because `devspace dev` is no longer running.
  if (sessionDead) return 'CRASHED'

  const crashed = pods.some((p) => p.restartCount > 0 || p.phase === 'Failed')
  if (crashed) return 'CRASHED'

  const anyReady = pods.some((p) => p.ready)
  const hasDevspacePod = pods.some((p) => p.name.includes('-devspace'))
  if (opts.deployedWhenRunning && hasDeployment && !hasSession && !hasDevspacePod) {
    return 'DEPLOYED'
  }
  if (anyReady) return hasSession ? 'RUNNING_MANAGED' : 'RUNNING_EXTERNAL'

  // Pods exist but none ready yet → still coming up.
  if (pods.length > 0) return 'BUILDING'

  // No pods. A live session means devspace dev is mid-build/deploy.
  if (hasSession) return 'BUILDING'

  // No pods, no session — but deployment objects in the cluster mean the repo
  // was deployed and is merely scaled down, not absent.
  return hasDeployment ? 'DEPLOYED' : 'STOPPED'
}

/** Name-prefix attribution shared by pods and deployments: devspace names both
 *  `<project>-...` / `<project>-devspace-...`. An empty/whitespace name matches
 *  nothing (can't attribute). Longest known name wins: an item claimed by a
 *  longer sibling name (e.g. replica `svc-r1` under parent `svc`) is not also
 *  attributed to the shorter prefix. */
function matchByName<T extends { name: string }>(
  items: T[],
  name: string,
  knownNames: string[] = [],
): T[] {
  const n = name.trim()
  if (!n) return []
  const shadows = knownNames.filter((o) => o !== n && o.startsWith(`${n}-`))
  return items.filter(
    (i) =>
      (i.name === n || i.name.startsWith(`${n}-`)) &&
      !shadows.some((s) => i.name === s || i.name.startsWith(`${s}-`)),
  )
}

/** Keep only pods that belong to this repo by devspace's naming convention.
 *  Without this, an unscoped namespace query attributes every pod (e.g. a
 *  crashed `registry`) to every repo. */
export function matchPods(pods: PodInfo[], name: string, knownNames: string[] = []): PodInfo[] {
  return matchByName(pods, name, knownNames)
}

/** Keep only deployment objects that belong to this repo, same convention. */
export function matchDeployments(
  deployments: DeploymentInfo[],
  name: string,
  knownNames: string[] = [],
): DeploymentInfo[] {
  return matchByName(deployments, name, knownNames)
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

/** Parse `kubectl get deployments -o json` into DeploymentInfo[]. Defensive against junk. */
export function parseDeployments(json: string): DeploymentInfo[] {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return []
  }
  const items = (doc as { items?: unknown })?.items
  if (!Array.isArray(items)) return []

  const out: DeploymentInfo[] = []
  for (const item of items) {
    const meta = (item as { metadata?: { name?: string } }).metadata
    const spec = (item as { spec?: { replicas?: unknown } }).spec
    const status = (item as { status?: { readyReplicas?: unknown } }).status
    out.push({
      name: meta?.name ?? '<unknown>',
      replicas: typeof spec?.replicas === 'number' ? spec.replicas : 0,
      readyReplicas: typeof status?.readyReplicas === 'number' ? status.readyReplicas : 0,
    })
  }
  return out
}

/** One reconcile pass's worth of kubectl list results, keyed by query shape.
 *  Repos sharing a namespace share the answer — a 47-repo pass costs one
 *  `get pods` + one `get deployments` per namespace, not one pair per repo.
 *  Make a fresh cache per pass; a single-repo reconcile after a verb uses its
 *  own so it never sees pre-verb data. `null` records a query that FAILED —
 *  "couldn't ask" is cached too (don't re-ask a broken kubectl 47 times) but
 *  stays distinguishable from a genuine empty result. */
export interface ClusterCache {
  pods: Map<string, PodInfo[] | null>
  deployments: Map<string, DeploymentInfo[] | null>
  /** Every name that can claim pods/deployments this pass (repo, member, and
   *  workload-scoped names) — lets attribution give the longest name priority. */
  knownNames?: string[]
}

export function newClusterCache(): ClusterCache {
  return { pods: new Map(), deployments: new Map() }
}

export class Reconciler {
  constructor(private readonly runner: Runner = run) {}

  /** Reconcile one repo against the cluster + its tmux session. A single-workload
   *  view; multi-workload repos reconcile each workload's scoped clone and
   *  assemble the parts themselves (see Service.reconcileOne). */
  async reconcile(
    repo: Repo,
    hasSession: boolean,
    cache: ClusterCache = newClusterCache(),
  ): Promise<RepoState> {
    const ws = await this.reconcileWorkload(repo, hasSession, cache, repo.defaultWorkload ?? '')
    return assembleState(repo, [ws], nowMs())
  }

  /** Reconcile a single (already workload-scoped) repo into one WorkloadState.
   *  `repo.name` carries the workload suffix for a scoped clone, so the same
   *  name-prefix matching isolates that workload's pods and deployments. */
  async reconcileWorkload(
    repo: Repo,
    hasSession: boolean,
    cache: ClusterCache,
    type: string,
    sessionDead = false,
  ): Promise<WorkloadState> {
    const rawPods = await this.fetchPods(repo, cache)
    const rawDeployments = await this.fetchDeployments(repo, cache)
    const pods = rawPods ?? []
    const deployments = matchDeployments(rawDeployments ?? [], repo.name, cache.knownNames)
    const ws: WorkloadState = {
      type,
      status: deriveStatus(pods, hasSession, deployments.length > 0, sessionDead, {
        deployedWhenRunning: repo.codeArea === 'frontend',
      }),
      pods,
      deployments,
      hasSession,
    }
    // A failed query means the cluster view is unknown, not empty — flag it so
    // the service can hold the last known status and skip retire decisions.
    if (rawPods === null || rawDeployments === null) ws.unreachable = true
    return ws
  }

  /** `null` = the query failed (cluster unreachable / bad credentials), which
   *  is NOT the same as an empty pod list. */
  private async fetchPods(repo: Repo, cache: ClusterCache): Promise<PodInfo[] | null> {
    const key = `${repo.namespace ?? ''}|${repo.selector ?? ''}`
    let pods = cache.pods.get(key)
    if (pods === undefined) {
      const args = ['get', 'pods', '-o', 'json']
      if (repo.namespace) args.push('-n', repo.namespace)
      if (repo.selector) args.push('-l', repo.selector)
      const r = await this.runner('kubectl', args).catch(() => undefined)
      pods = !r || r.code !== 0 ? null : parsePods(r.stdout)
      cache.pods.set(key, pods)
    }
    if (pods === null) return null
    // Attribute pods to this repo by name (devspace names pods after the
    // project) unless an explicit label selector already scoped the query.
    return repo.selector ? pods : matchPods(pods, repo.name, cache.knownNames)
  }

  /** Namespace-wide deployment objects; the caller attributes by name. No label
   *  selector here — deployments follow the same naming convention as pods.
   *  `null` = the query failed, distinguishable from "no deployments". */
  private async fetchDeployments(
    repo: Repo,
    cache: ClusterCache,
  ): Promise<DeploymentInfo[] | null> {
    const key = repo.namespace ?? ''
    let deployments = cache.deployments.get(key)
    if (deployments === undefined) {
      const args = ['get', 'deployments', '-o', 'json']
      if (repo.namespace) args.push('-n', repo.namespace)
      const r = await this.runner('kubectl', args).catch(() => undefined)
      deployments = !r || r.code !== 0 ? null : parseDeployments(r.stdout)
      cache.deployments.set(key, deployments)
    }
    return deployments
  }
}

function nowMs(): number {
  return Date.now()
}
