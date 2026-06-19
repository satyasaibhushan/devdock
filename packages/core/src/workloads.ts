// workloads — one repo, several deployable workloads (spec §6.1).
// Some configs deploy more than one thing off a single `WORKLOAD_TYPE` question
// var: `devspace deploy --var WORKLOAD_TYPE=worker` names the deployment
// `<base>-worker`, `=api` names `<base>-api`, and so on. devdock keeps these as
// ONE repo row and reuses the existing reconciler/supervisor per workload by
// cloning the Repo with a suffixed name/session and the var pre-answered.
import type { Repo, RepoState, RepoStatus, WorkloadState } from './types.js'

/** Status priority for the aggregate a multi-workload row shows: the most
 *  attention-worthy workload wins. CRASHED first (needs a look), STOPPED last
 *  (nothing to see). */
const STATUS_PRIORITY: RepoStatus[] = [
  'CRASHED',
  'RUNNING_MANAGED',
  'RUNNING_EXTERNAL',
  'BUILDING',
  'DEPLOYED',
  'STOPPED',
]

/** Collapse per-workload statuses into the single status the repo row shows. */
export function aggregateStatus(statuses: RepoStatus[]): RepoStatus {
  for (const s of STATUS_PRIORITY) {
    if (statuses.includes(s)) return s
  }
  return 'STOPPED'
}

/** The workload types a repo can deploy, or `[undefined]` for a single-workload
 *  repo — the one element that means "act on the repo as-is, no scoping". */
export function workloadTypes(repo: Repo): (string | undefined)[] {
  return repo.workloads?.length ? repo.workloads : [undefined]
}

/** Resolve the workload to act on: the requested one if the repo offers it,
 *  else its default, else the first. `undefined` for single-workload repos. */
export function resolveWorkload(repo: Repo, requested?: string): string | undefined {
  if (!repo.workloads?.length) return undefined
  if (requested && repo.workloads.includes(requested)) return requested
  if (repo.defaultWorkload && repo.workloads.includes(repo.defaultWorkload)) {
    return repo.defaultWorkload
  }
  return repo.workloads[0]
}

/** Clone a repo scoped to one workload: deployment/pods named `<name>-<type>`,
 *  its own tmux session, and `WORKLOAD_TYPE` pre-answered so devspace deploys
 *  exactly that workload. Returns the repo unchanged when `type` is undefined
 *  (single-workload repos), so callers can treat both paths uniformly. */
export function scopeRepo(repo: Repo, type?: string): Repo {
  if (!type) return repo
  return {
    ...repo,
    name: `${repo.name}-${type}`,
    session: `${repo.session}-${type}`,
    varDefaults: { ...repo.varDefaults, WORKLOAD_TYPE: type },
    // The clone represents a single workload — it must not recurse into itself.
    workloads: undefined,
    defaultWorkload: undefined,
  }
}

/** Build a repo's reconciled view from its per-workload states: aggregate
 *  status, the union of pods/deployments, and "any session live". */
export function assembleState(
  repo: Repo,
  workloads: WorkloadState[],
  updatedAt: number,
): RepoState {
  return {
    repo,
    status: aggregateStatus(workloads.map((w) => w.status)),
    workloads,
    pods: workloads.flatMap((w) => w.pods),
    deployments: workloads.flatMap((w) => w.deployments),
    hasSession: workloads.some((w) => w.hasSession),
    updatedAt,
  }
}
