// Shared domain types for @devdock/core.

/** Reconciled lifecycle state of a repo's workload (see spec §6).
 *  STOPPED = nothing in the cluster; DEPLOYED = deployment objects exist in
 *  deploy-only mode; the rest are pod/session-derived. */
export type RepoStatus =
  | 'RUNNING_MANAGED'
  | 'RUNNING_EXTERNAL'
  | 'CRASHED'
  | 'STOPPED'
  | 'BUILDING'
  | 'DEPLOYED'
  // Transient, held by the service for the whole restart (purge → deploy → dev)
  // so the row never flickers through STOPPED/DEPLOYED mid-recycle.
  | 'RESTARTING'

/** A DevSpace-enabled repo discovered by the registry (spec §12). */
export interface Repo {
  /** Stable id derived from the repo directory name, e.g. `career-service-agents`. */
  id: string
  /** Display name (same as id for now). */
  name: string
  /** Absolute path to the repo root. */
  path: string
  /** Top-level ~/Code bucket the repo came from, when it follows the local
   *  backend/frontend layout. */
  codeArea?: 'backend' | 'frontend'
  /** For multi-service repos driven by a `./devspace` wrapper, the directory
   *  that wrapper runs from (the parent of `.devspace/`). devdock exports it as
   *  DEVSPACE_BINARY_DIR so the service config's relative Dockerfile/context
   *  paths resolve — exactly what the wrapper does. Unset for single-config
   *  repos, where `path` is the repo root and devspace runs there directly. */
  root?: string
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
  /** When one config deploys several workloads off a `WORKLOAD_TYPE` question
   *  var (e.g. `['api','cron','worker']` → deployments `<name>-api`,
   *  `<name>-worker`, …), the list of those workload types. Absent when the
   *  repo has a single workload. The repo is still one row; workloads are
   *  selected within it. */
  workloads?: string[]
  /** The workload acted on when none is specified — the `WORKLOAD_TYPE`
   *  default (typically `api`). Only meaningful alongside `workloads`. */
  defaultWorkload?: string
  /** This config's own workload type, from a scalar `WORKLOAD_TYPE` var (e.g.
   *  `api`). Set on the per-workload configs of a multi-config repo so the base
   *  can label and scope them; unset for ordinary repos. */
  workloadType?: string
  /** For a repo whose workloads live in separate `.devspace/<name>-<type>/`
   *  configs (one `devspace.yaml` each, not one config with a `WORKLOAD_TYPE`
   *  question var), the per-workload configs — each a complete Repo with its own
   *  service dir, name and session. The base groups them into one row and scopes
   *  verbs to the chosen member. Unset for single-config repos. */
  members?: Repo[]
  /** The tmux session name devdock uses for this repo. */
  session: string
}

/** Per-workload reconciled view for a multi-workload repo (one entry per
 *  `WORKLOAD_TYPE`). Single-workload repos have exactly one of these. */
export interface WorkloadState {
  /** Workload type, e.g. `api` | `cron` | `worker`. */
  type: string
  status: RepoStatus
  pods: PodInfo[]
  deployments: DeploymentInfo[]
  hasSession: boolean
  /** True when the kubectl queries behind this view failed (cluster
   *  unreachable, expired credentials, kube context switched away). pods and
   *  deployments are then unknown — not gone — and must not drive destructive
   *  decisions such as retiring a dev session. */
  unreachable?: boolean
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
  /** Aggregate status across workloads — the most attention-worthy one (see
   *  `aggregateStatus`). For single-workload repos this is just its status. */
  status: RepoStatus
  /** Per-workload breakdown; always at least one entry. The UI drives its
   *  selector and running-workload pills off this. */
  workloads: WorkloadState[]
  /** Union of every workload's pods — kept for crash watching and callers that
   *  treat the repo as a whole. */
  pods: PodInfo[]
  deployments: DeploymentInfo[]
  /** Whether any workload has a live dev session. */
  hasSession: boolean
  /** epoch ms of last reconcile. */
  updatedAt: number
  /** Command for the repo's default pod type. Kept for older clients. */
  startupCommand?: string
  /** Commands auto-run once each pod type's `devspace dev` session is ready. */
  startupCommands?: Record<string, string>
}

/** Terminal access mode (spec §8). */
export type TermMode = 'ro' | 'rw'
