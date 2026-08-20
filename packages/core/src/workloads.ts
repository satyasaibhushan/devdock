import { lifecycleActions } from './lifecycle.js'
// workloads — one repo, several deployable workloads (spec §6.1).
// A repo deploys more than one workload in one of two ways, both kept as ONE
// row that scopes the reconciler/supervisor per workload:
//   1. One config with a `WORKLOAD_TYPE` question var — `devspace deploy --var
//      WORKLOAD_TYPE=worker` names the deployment `<base>-worker`, `=api` names
//      `<base>-api`. scopeRepo clones the Repo with a suffixed name/session and
//      the var pre-answered.
//   2. Separate `.devspace/<base>-<type>/` configs (the `./devspace` wrapper
//      pattern) — each is already a complete config; the base carries them as
//      `members` and scopeRepo returns the matching member directly.
import type { Repo, RepoState, RepoStatus, WorkloadState } from './types.js'

/** Status priority for the aggregate a multi-workload row shows: the most
 *  attention-worthy workload wins. CRASHED first (needs a look), STOPPED last
 *  (nothing to see). */
const STATUS_PRIORITY: RepoStatus[] = [
  'RESTARTING',
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
  if (repo.members?.length) return repo.members.map((m) => m.workloadType ?? m.id)
  return repo.workloads?.length ? repo.workloads : [undefined]
}

/** Resolve an explicit workload exactly. A stale/typoed target must never
 *  silently operate on the default workload. */
export function resolveWorkload(repo: Repo, requested?: string): string | undefined {
  if (!repo.workloads?.length) {
    if (requested) throw new Error(`unknown workload "${requested}" for repo "${repo.id}"`)
    return undefined
  }
  if (requested) {
    if (repo.workloads.includes(requested)) return requested
    throw new Error(
      `unknown workload "${requested}" for repo "${repo.id}"; expected one of: ${repo.workloads.join(', ')}`,
    )
  }
  if (repo.defaultWorkload && repo.workloads.includes(repo.defaultWorkload)) {
    return repo.defaultWorkload
  }
  return repo.workloads[0]
}

/** Pod types that can have distinct startup commands. Multi-workload repos use
 * their discovered types; a single config uses its declared WORKLOAD_TYPE, or
 * the conventional ui/api label for frontend/backend repos. */
export function startupPodTypes(repo: Repo): string[] {
  if (repo.workloads?.length) return [...repo.workloads]
  return [repo.workloadType ?? (repo.codeArea === 'frontend' ? 'ui' : 'api')]
}

/** Resolve a lifecycle workload selection to its startup-command pod type. */
export function startupPodType(repo: Repo, workload?: string): string {
  if (!repo.workloads?.length) {
    const types = startupPodTypes(repo)
    if (workload && !types.includes(workload)) {
      throw new Error(`unknown startup pod type "${workload}" for repo "${repo.id}"`)
    }
    return workload ?? types[0] ?? 'api'
  }
  return resolveWorkload(repo, workload) ?? startupPodTypes(repo)[0] ?? 'api'
}

/** Clone a repo scoped to one workload: deployment/pods named `<name>-<type>`,
 *  its own tmux session, and `WORKLOAD_TYPE` pre-answered so devspace deploys
 *  exactly that workload. Returns the repo unchanged when `type` is undefined
 *  (single-workload repos), so callers can treat both paths uniformly. */
export function scopeRepo(repo: Repo, type?: string): Repo {
  if (!type) return repo
  // Multi-config repos already have a complete, correctly-named config per
  // workload — return that member as-is rather than synthesizing a clone.
  if (repo.members?.length) {
    return repo.members.find((m) => (m.workloadType ?? m.id) === type) ?? repo
  }
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
  const hydrated = workloads.map((workload) => ({
    ...workload,
    actions: workload.unreachable ? [] : lifecycleActions(workload.status),
  }))
  const status = aggregateStatus(hydrated.map((w) => w.status))
  const defaultType = repo.defaultWorkload ?? repo.workloads?.[0] ?? ''
  const target = hydrated.find((workload) => workload.type === defaultType) ?? hydrated[0]
  return {
    repo,
    status,
    actions: target?.actions ?? [],
    workloads: hydrated,
    pods: hydrated.flatMap((w) => w.pods),
    deployments: hydrated.flatMap((w) => w.deployments),
    hasSession: hydrated.some((w) => w.hasSession),
    updatedAt,
  }
}
