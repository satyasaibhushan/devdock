// Shared domain types for @devdock/core.

/** Reconciled lifecycle state of a repo's workload (see spec §6).
 *  STOPPED = nothing in the cluster; DEPLOYED = deployment objects exist but
 *  no pods run (built then scaled to zero); the rest are pod/session-derived. */
export type RepoStatus =
  | 'RUNNING_MANAGED'
  | 'RUNNING_EXTERNAL'
  | 'CRASHED'
  | 'STOPPED'
  | 'BUILDING'
  | 'DEPLOYED'

/** A DevSpace-enabled repo discovered by the registry (spec §12). */
export interface Repo {
  /** Stable id derived from the repo directory name, e.g. `career-service-agents`. */
  id: string
  /** Display name (same as id for now). */
  name: string
  /** Absolute path to the repo root. */
  path: string
  /** Path to the discovered devspace.yaml. */
  configPath: string
  /** Kubernetes namespace, if declared in the config. */
  namespace?: string
  /** Primary workload / deployment name, if declared. */
  workload?: string
  /** Optional label selector used to find this repo's pods (e.g. `svc=app`). */
  selector?: string
  /** Forwarded ports declared in the config. */
  ports: number[]
  /** Answers for the config's `question:` vars, taken from their declared
   *  defaults — passed as `--var` so devspace never prompts for input. */
  varDefaults?: Record<string, string>
  /** The tmux session name devdock uses for this repo. */
  session: string
}

/** A pod observed in the cluster during reconciliation. */
export interface PodInfo {
  name: string
  phase: string
  ready: boolean
  restartCount: number
}

/** A deployment object observed in the cluster — exists even when scaled to zero. */
export interface DeploymentInfo {
  name: string
  /** Desired replicas (spec.replicas). */
  replicas: number
  /** Ready replicas (status.readyReplicas). */
  readyReplicas: number
}

/** The reconciled view of a single repo (spec §6). */
export interface RepoState {
  repo: Repo
  status: RepoStatus
  pods: PodInfo[]
  deployments: DeploymentInfo[]
  hasSession: boolean
  /** epoch ms of last reconcile. */
  updatedAt: number
}

/** Terminal access mode (spec §8). */
export type TermMode = 'ro' | 'rw'
