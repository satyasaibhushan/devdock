// service — the one brain (spec §19.1). Composes the core modules and exposes
// transport-free verbs that the daemon (HTTP/WS) and MCP both call.
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { AuthManager, type AuthState } from './auth.js'
import { type AwsCredential, AwsCreds } from './awsCreds.js'
import { CrashWatch } from './crashWatch.js'
import { type RunResult, run, runStream, spawnStream } from './exec.js'
import { type LifecycleAction, lifecyclePlan } from './lifecycle.js'
import { decodeCursor, encodeCursor, readFileSlice } from './logQuery.js'
import { LogHub, LogTailer, type SpawnFn, cleanLine } from './logTailer.js'
import { DeploymentOwnership } from './ownership.js'
import { PtyBroker } from './ptyBroker.js'
import { type ClusterCache, Reconciler, newClusterCache } from './reconciler.js'
import { parseDevspaceConfig, scanRepos, sessionName } from './registry.js'
import {
  aliasIngressManifest,
  generateReplicaConfig,
  ingressPathOf,
  nextReplicaId,
} from './replicas.js'
import { type ReplicaRecord, StateStore } from './stateStore.js'
import { type SessionState, type StreamRunner, Supervisor, verbLabel } from './supervisor.js'
import { type RunOutcome, type TermInfo, type TermKind, TermRegistry } from './termRegistry.js'
import type { Repo, RepoState, RepoStatus, TermMode } from './types.js'
import {
  assembleState,
  resolveWorkload,
  scopeRepo,
  startupPodType,
  startupPodTypes,
  workloadTypes,
} from './workloads.js'

export interface ServiceOptions {
  roots?: string[]
  stateFile?: string
  reconcileMs?: number
  instanceId?: string
}

/** Grace after the dev pod reports ready before sending the startup command —
 *  `devspace dev` opens its in-container terminal a beat after the pod is up, so
 *  the keystrokes land at the shell prompt rather than mid-deploy output. */
const STARTUP_RUN_DELAY_MS = 2500
/** How long the "live session but no attributed pods" condition must hold —
 *  continuously, across reconcile passes that could actually see the cluster —
 *  before the session is retired as stale. A single empty/failed kubectl read
 *  must never retire a healthy session. */
const STALE_NO_POD_SESSION_MS = 30 * 60 * 1000
/** Auto-reconnect pacing for a dead dev session whose pod still runs: at most
 *  one attempt per cooldown, giving up after the cap until the workload holds
 *  RUNNING_MANAGED for RECONNECT_RESET_MS (or a manual stop/clear intervenes),
 *  so a genuinely crash-looping `devspace dev` degrades to CRASHED instead of
 *  thrashing forever. */
const RECONNECT_COOLDOWN_MS = 60 * 1000
const RECONNECT_RESET_MS = 5 * 60 * 1000
const MAX_RECONNECT_ATTEMPTS = 3
/** Background auth maintenance cadence. Each pass silently force-refreshes the
 *  OIDC token when it has < 20 min left (see AuthManager.maintain), so kubectl
 *  and devspace essentially never see a stale token — and never each spawn
 *  their own kubelogin browser flow. */
const AUTH_MAINTAIN_MS = 5 * 60 * 1000
/** Replicas are ephemeral test deployments: anything older than this is
 *  deleted by the hourly GC pass. */
const REPLICA_TTL_MS = 2 * 24 * 60 * 60 * 1000
const REPLICA_GC_MS = 60 * 60 * 1000

/** RFC 1123 label — what Kubernetes accepts as a namespace name. */
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

/** Where devdock_logs reads from. `application` = the tmux pipe-pane mirror of
 *  the `devspace dev` pane (the app's real stdout). `container` = kubectl logs.
 *  `devdock` = the verb-activity hub. `auto` picks application when a dev
 *  session's pipe file exists, else container, else devdock. */
export type LogSource = 'auto' | 'application' | 'container' | 'devdock'

export interface LogQueryOptions {
  workload?: string
  source?: LogSource
  /** Opaque cursor from a previous query — returns only what happened since. */
  cursor?: string
  /** Lines to return on a fresh (cursorless) read. */
  tail?: number
  /** Only lines containing this substring. */
  contains?: string
}

export interface LogQueryResult {
  source: Exclude<LogSource, 'auto'>
  pod?: string
  lines: string[]
  /** Pass back as `cursor` to resume exactly here. */
  cursor: string
  /** The given cursor was stale/invalid — this read restarted from the tail. */
  resync?: boolean
  /** Lines between the cursor and this read were lost (buffer/size limits). */
  dropped?: boolean
}

export interface WorkloadRunResult {
  /** True iff the command ran to completion in the pod and exited 0. */
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  pod?: string
  timedOut: boolean
  truncated: boolean
  /** Set when the failure was devdock/cluster plumbing (no pod, auth, kubectl
   *  connectivity) rather than the command itself. */
  infraError?: string
}

export interface WaitOptions {
  workload?: string
  /** Match: a log line containing this substring appears. */
  contains?: string
  /** Which logs `contains` watches (default auto). */
  source?: LogSource
  /** Resume watching from a prior cursor; without one, watching starts NOW —
   *  pre-existing lines never match. */
  cursor?: string
  /** Match: the workload reaches this status (e.g. RUNNING_MANAGED). */
  status?: string
  /** Match: at least one pod is ready. */
  ready?: boolean
  timeoutMs?: number
  /** Internal poll cadence — exposed for tests. */
  pollMs?: number
}

export interface WaitResult {
  matched: boolean
  reason: 'contains' | 'status' | 'ready' | 'timeout'
  /** The log line that matched (reason=contains). */
  line?: string
  /** The workload's status at resolution time. */
  status?: RepoStatus
  elapsedMs: number
  /** Where log-watching stopped — pass to the next wait/logs call. */
  cursor?: string
}

const WAIT_TIMEOUT_DEFAULT_MS = 30_000
const WAIT_TIMEOUT_MAX_MS = 300_000
const WAIT_POLL_MS = 250
const RUN_TIMEOUT_DEFAULT_MS = 120_000
const RUN_TIMEOUT_MAX_MS = 600_000
const RUN_MAX_OUTPUT_BYTES = 1024 * 1024
/** kubectl-side failure signatures — distinguish "the cluster/exec plumbing
 *  broke" from "the command ran and failed". */
const KUBECTL_INFRA_RE =
  /error from server|unable to upgrade connection|error dialing backend|connection refused|error: unknown command|kubernetes login required/i

/** The global namespace view: what the kube context points at now, plus every
 *  namespace devdock can offer in the selector. */
export interface NamespaceInfo {
  /** The kube context's current namespace (the thing `kn <ns>` sets). */
  current: string
  /** Selectable namespaces: remembered ones + repo-declared ones + current.
   *  Listing cluster namespaces needs RBAC most users lack, so this is learned,
   *  not queried. */
  known: string[]
}

/** Injectable collaborators (defaults are the real implementations). */
export interface ServiceDeps {
  supervisor?: Supervisor
  reconciler?: Reconciler
  broker?: PtyBroker
  runner?: (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number },
  ) => Promise<RunResult>
  /** Spawner for streaming children (kubectl logs -f, tail -F). Tests inject a fake. */
  streamSpawner?: SpawnFn
  /** Kubernetes OIDC login owner — injectable so tests can pin auth phases. */
  auth?: AuthManager
  /** AWS/ECR credential warmer — injectable so tests can pin warm outcomes. */
  awsCreds?: AwsCreds
}

export class Service {
  readonly events = new EventEmitter()
  private readonly opts: Required<Omit<ServiceOptions, 'instanceId'>>
  private readonly ownership?: DeploymentOwnership
  private readonly replicaInstanceSuffix: string
  private readonly supervisor: Supervisor
  private readonly reconciler: Reconciler
  private readonly broker: PtyBroker
  private readonly runner: NonNullable<ServiceDeps['runner']>
  private readonly streamSpawner: SpawnFn
  private readonly store: StateStore
  private readonly repos = new Map<string, Repo>()
  private readonly states = new Map<string, RepoState>()
  /** One log stream per workload: pod logs + verb activity. The `devspace dev`
   *  pane itself is deliberately NOT fed in here — the Terminal panel already
   *  shows that pane live; mirroring it into Logs made the two panels
   *  near-duplicates. It is still mirrored to disk (see devLogPath). */
  private readonly hubs = new Map<string, LogHub>()
  private readonly tailers = new Map<string, LogTailer>()
  /** Pipe-file generation per workload key, bumped each time start() truncates
   *  the file — an `f:` cursor from before the truncation is detected by its
   *  stale gen and resyncs instead of reading garbage offsets. */
  private readonly logGens = new Map<string, number>()
  /** Workload keys whose live session already got its once-per-sighting setup
   *  (keepalive + mouse backfill) this daemon run. */
  private readonly piped = new Set<string>()
  private readonly watchers = new Map<string, CrashWatch>()
  /** Per-workload status override held during a multi-step verb (restart) so the
   *  reconcile loop can't surface the STOPPED/DEPLOYED states it passes through. */
  private readonly transitions = new Map<string, RepoStatus>()
  /** When a dev session was first seen with no attributed pods — the stale
   *  timer counts the *condition's* duration, not the session's age. Reset by
   *  any pass that sees pods or couldn't see the cluster at all. */
  private readonly noPodsSince = new Map<string, number>()
  /** Auto-reconnect bookkeeping for dead sessions whose pod still runs. */
  private readonly reconnects = new Map<string, { attempts: number; lastAt: number }>()
  private timer?: NodeJS.Timeout
  private authTimer?: NodeJS.Timeout
  private gcTimer?: NodeJS.Timeout
  /** kubectl calls that hit the API server, behind the auth gate. */
  private readonly kubectl: NonNullable<ServiceDeps['runner']>
  private readonly auth: AuthManager
  private readonly awsCreds: AwsCreds
  /** All terminals: id → live PTY session + scrollback (spec §8). */
  private readonly terms = new TermRegistry()
  /** In-flight `auto` terminal opens by workload key — concurrent requests
   *  (two browser tabs, an agent and the UI) share one open instead of racing
   *  the tmux write-lock. */
  private readonly pendingTermOpens = new Map<string, Promise<TermInfo>>()

  constructor(opts: ServiceOptions = {}, deps: ServiceDeps = {}) {
    this.replicaInstanceSuffix = opts.instanceId ? `-${opts.instanceId.slice(0, 8)}` : ''
    this.opts = {
      roots: opts.roots ?? [],
      stateFile: opts.stateFile ?? join(process.cwd(), '.devdock', 'state.json'),
      reconcileMs: opts.reconcileMs ?? 5000,
    }
    const baseRunner = deps.runner ?? run
    // Injected runners are test doubles and generally do not model kubeconfig.
    // Keep auth disabled unless the test supplies its own AuthManager.
    this.auth =
      deps.auth ??
      new AuthManager(
        deps.runner
          ? {
              runner: async (cmd, args, options) =>
                cmd === 'kubectl' && args[0] === 'config'
                  ? { code: 0, stdout: '{"users":[]}', stderr: '' }
                  : baseRunner(cmd, args, options),
            }
          : {},
      )
    // With an injected (test) runner, default to a disabled warmer — unit tests
    // must never read the machine's ~/.aws-cli-oidc config or mint credentials.
    this.awsCreds =
      deps.awsCreds ?? (deps.runner ? new AwsCreds({ oidcConfigPath: null }) : new AwsCreds())
    // Every kubectl that talks to the API server goes through the auth gate:
    // with a stale OIDC token, each such call would spawn its own kubelogin —
    // all racing to bind localhost:8040 and each opening a browser tab. Gated,
    // the call is refused (read as a transient kubectl failure by the callers,
    // which hold last-known status) while ONE silent refresh runs instead.
    const gatedRunner: NonNullable<ServiceDeps['runner']> = (cmd, args, o) => {
      if (cmd === 'kubectl' && !this.auth.kubectlAllowed(args)) {
        return Promise.resolve({
          code: 1,
          stdout: '',
          stderr: 'devdock: kubectl deferred — kubernetes login required',
        })
      }
      // preserve the caller's arity — injected test runners assert exact calls
      return o === undefined ? baseRunner(cmd, args) : baseRunner(cmd, args, o)
    }
    // Streaming (devspace deploy/purge output) bypasses the gate — those verbs
    // run through the login shell, not kubectl, and are gated at the verb level
    // by ensureAuth. Injected runners keep their old double-duty behaviour.
    const streamRunner: StreamRunner = deps.runner
      ? (c, a, o) => baseRunner(c, a, o)
      : (c, a, o, onLine) => runStream(c, a, o, onLine)
    this.kubectl = gatedRunner
    if (opts.instanceId) this.ownership = new DeploymentOwnership(opts.instanceId, gatedRunner)
    this.supervisor = deps.supervisor ?? new Supervisor(gatedRunner, streamRunner)
    this.reconciler = deps.reconciler ?? new Reconciler(gatedRunner)
    this.broker = deps.broker ?? new PtyBroker()
    // The service's own kubectl uses are `kubectl config …` (local, no API
    // server, no token) — safe ungated.
    this.runner = baseRunner
    this.streamSpawner = deps.streamSpawner ?? spawnStream
    this.store = new StateStore(this.opts.stateFile)
  }

  /** (Re)discover repos from the filesystem, then materialize replicas from
   *  their persisted records — never from the scanner, which would re-register
   *  the parent's own configs found inside each worktree. */
  rescan(): Repo[] {
    const found = scanRepos(this.opts.roots.length ? { roots: this.opts.roots } : {})
    const next = new Map<string, Repo>()
    for (const r of found) next.set(r.id, r)
    for (const rec of this.store.listReplicas()) {
      const repo = this.materializeReplica(rec)
      if (!repo) continue
      const existing = next.get(repo.id)
      if (existing && existing.path !== repo.path) {
        throw new Error(`duplicate repo id "${repo.id}": ${existing.path} and ${repo.path}`)
      }
      next.set(repo.id, repo)
    }
    this.repos.clear()
    for (const [id, repo] of next) this.repos.set(id, repo)
    return this.listRepos()
  }

  listRepos(): Repo[] {
    return [...this.repos.values()]
  }

  list(): RepoState[] {
    return [...this.states.values()]
  }

  get(id: string): RepoState | undefined {
    return this.states.get(id)
  }

  health(): { ok: boolean; state: { ok: boolean; error?: string } } {
    const state = this.store.health()
    return { ok: state.ok, state }
  }

  private repoOrThrow(id: string): Repo {
    const repo = this.repos.get(id)
    if (!repo) throw new Error(`unknown repo: ${id}`)
    return repo
  }

  /** Resolve a (repo, workload) request into the scoped repo to act on and the
   *  per-workload key its logs/session/state live under. For single-workload
   *  repos `type` is undefined and the key is just the id — behaviour and keys
   *  are unchanged. For multi-workload repos the repo is cloned to the chosen
   *  workload and everything is keyed `<id>::<type>`. */
  private scoped(
    id: string,
    workload?: string,
  ): {
    base: Repo
    repo: Repo
    type?: string
    key: string
  } {
    const base = this.repoOrThrow(id)
    const type = resolveWorkload(base, workload)
    const key = workloadKey(id, type)
    return { base, repo: this.pinned(scopeRepo(base, type), key), type, key }
  }

  /** Apply the session-namespace pin: a repo with no config-declared namespace
   *  acts in the namespace its dev session was started in — not whatever the
   *  kube context points at now — so the global selector can move without
   *  orphaning running sessions. */
  private pinned(repo: Repo, key: string): Repo {
    if (repo.namespace) return repo
    const ns = this.store.getSessionNamespace(key)
    return ns ? { ...repo, namespace: ns } : repo
  }

  // ---- lifecycle verbs (spec §7) ----
  // Every verb narrates into the repo's log hub — the same output you'd see
  // running the devspace command in a terminal streams to the Logs panel live.

  /** Execute one state-checked lifecycle action. Every transport uses this
   *  interface so invalid actions cannot bypass the UI's buttons. */
  async lifecycle(id: string, action: LifecycleAction, workload?: string): Promise<RunResult> {
    const { type } = this.scoped(id, workload)
    const state = this.states.get(id) ?? (await this.reconcileOne(id))
    const selected = state.workloads.find((candidate) => candidate.type === (type ?? ''))
    if (selected?.unreachable) {
      return {
        code: 2,
        stdout: '',
        stderr: 'cannot determine workload state while the cluster is unreachable',
      }
    }
    const status = selected?.status ?? state.status
    try {
      lifecyclePlan(status, action)
    } catch (error) {
      return {
        code: 2,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      }
    }

    if (action === 'build') return this.build(id, workload)
    if (action === 'start') return this.start(id, workload)
    if (action === 'destroy') return this.stop(id, workload)
    if (action === 'restart') return this.restart(id, workload)

    const built = await this.build(id, workload)
    if (built.code !== 0) return built
    return this.start(id, workload)
  }

  /** Lifecycle calls never trigger auth. A failed probe stays failed until an
   *  explicit UI/MCP login, preventing retries from background activity. */
  private ensureAuth(key: string): RunResult | null {
    const hub = this.hubFor(key)
    const before = this.auth.snapshot()
    const quiet =
      !before.oidc ||
      (before.tokenExpiresAt !== undefined && before.tokenExpiresAt > Date.now() + 60_000)
    if (quiet) return null

    const detail = before.message ?? 'Kubernetes login required'
    hub.push(`✗ ${detail} — use the login button or devdock_auth_login`)
    return { code: 1, stdout: '', stderr: `kubernetes auth: ${detail}` }
  }

  /** Verb gate #2, for the verbs that spawn devspace deploys: repos' devspace
   *  config shells out to `aws ecr get-login-password`, whose profile reads
   *  the daemon-minted credential (via the devdock-aws-cred shim). The daemon
   *  refreshes it silently through the OIDC refresh token — a browser sign-in
   *  happens only when that token is gone/expired, and single-flight even then. */
  private async ensureAwsCreds(key: string): Promise<RunResult | null> {
    const quiet = !this.awsCreds.configured() || this.awsCreds.fresh()
    const hub = this.hubFor(key)
    if (!quiet) hub.push('! AWS credential being refreshed')
    const r = await this.awsCreds.warm()
    if (r.ok) {
      if (!quiet) hub.push('✓ aws auth ok')
      return null
    }
    const detail = r.message ?? 'aws login required'
    hub.push(`✗ ${detail}`)
    return { code: 1, stdout: '', stderr: `aws auth: ${detail}` }
  }

  async start(id: string, workload?: string): Promise<RunResult> {
    const { base, repo: scopedRepo, type, key } = this.scoped(id, workload)
    const denied = (await this.ensureAuth(key)) ?? (await this.ensureAwsCreds(key))
    if (denied) return denied
    let repo = scopedRepo
    // First start of an un-namespaced repo: run it against the kube context's
    // current namespace explicitly, and pin the session there (below, once the
    // start succeeds) so devspace/kubectl keep targeting it even after the
    // global namespace selector moves elsewhere.
    let pin: string | undefined
    if (!repo.namespace) {
      pin = (await this.contextNamespace()) || undefined
      if (pin) repo = { ...repo, namespace: pin }
    }
    if (this.ownership)
      await this.ownership.claim({ ...repo, namespace: repo.namespace || 'default' })
    const hub = this.hubFor(key)
    const pipeFile = this.devLogPath(key)
    mkdirSync(dirname(pipeFile), { recursive: true })
    writeFileSync(pipeFile, '') // fresh run, fresh file — old output doesn't linger
    this.logGens.set(key, (this.logGens.get(key) ?? 0) + 1) // invalidate old f: cursors
    hub.push(`$ ${verbLabel(repo, 'dev')}`)
    const r = await this.supervisor.start(repo, pipeFile)
    if (r.code === 0) {
      if (pin) {
        this.store.setSessionNamespace(key, pin)
        this.store.rememberNamespace(pin)
      }
      this.piped.add(key) // supervisor.start piped + keepalive'd the fresh session
      // Queue the configured startup command to run in the dev session once its
      // pod is ready (handled in reconcile). Only the tmux dev session gets it;
      // `devspace enter` shells are separate PTYs, so they never receive it.
      // Queued in the store: the ready-wait spans the whole deploy (minutes),
      // and a daemon restart in that window must not eat the command.
      const startup = this.store.getStartup(id, startupPodType(base, type))
      if (startup) this.store.setPendingStartup(key, startup)
    } else {
      for (const line of nonEmptyLines(r.stderr)) hub.push(line)
      hub.push(`✗ devspace dev failed to start (exit ${r.code})`)
    }
    await this.reconcileOne(id)
    return r
  }

  async build(id: string, workload?: string): Promise<RunResult> {
    const { repo, key } = this.scoped(id, workload)
    const denied = (await this.ensureAuth(key)) ?? (await this.ensureAwsCreds(key))
    if (denied) return denied
    await this.claimOwnership(repo)
    const r = await this.narrate(key, verbLabel(repo, 'deploy'), (onLine) =>
      this.supervisor.build(repo, onLine),
    )
    await this.reconcileOne(id)
    return r
  }

  async stop(id: string, workload?: string): Promise<RunResult> {
    const { repo, key } = this.scoped(id, workload)
    const denied = await this.ensureAuth(key)
    if (denied) return denied
    await this.claimOwnership(repo)
    this.noPodsSince.delete(key)
    this.reconnects.delete(key)
    this.tailers.get(key)?.stop()
    this.tailers.delete(key)
    const r = await this.narrate(key, verbLabel(repo, 'purge'), (onLine) =>
      this.supervisor.kill(repo, onLine),
    )
    this.piped.delete(key)
    this.store.setSessionNamespace(key, undefined) // session gone → pin released
    this.store.setPendingStartup(key, undefined) // canceled start must not fire later
    await this.reconcileOne(id)
    return r
  }

  /** Clear a crashed dev session: drop the replaced dev pod and release the
   *  session lock without purge or rebuild (image/deployment stay as deployed). */
  async clear(id: string, workload?: string): Promise<RunResult> {
    const { repo, key } = this.scoped(id, workload)
    const denied = await this.ensureAuth(key)
    if (denied) return denied
    await this.claimOwnership(repo)
    this.noPodsSince.delete(key)
    this.reconnects.delete(key)
    this.tailers.get(key)?.stop()
    this.tailers.delete(key)
    const r = await this.narrate(key, verbLabel(repo, 'reset pods'), (onLine) =>
      this.supervisor.clear(repo, onLine),
    )
    this.piped.delete(key)
    this.store.setSessionNamespace(key, undefined) // session gone → pin released
    this.store.setPendingStartup(key, undefined) // canceled start must not fire later
    await this.reconcileOne(id)
    return r
  }

  /** Recycle the workload from any state: kill → build → start (purge, then
   *  deploy, then dev). Available in every state as a one-click "start fresh".
   *  Stops early if a step fails so a broken purge/deploy doesn't cascade.
   *
   *  The whole sequence is held under a RESTARTING status override so the row
   *  shows one stable "restarting" state instead of flickering STOPPED → DEPLOYED
   *  → RUNNING as each sub-step reconciles. */
  async restart(id: string, workload?: string): Promise<RunResult> {
    const { key } = this.scoped(id, workload)
    this.transitions.set(key, 'RESTARTING')
    await this.reconcileOne(id) // reflect RESTARTING immediately
    try {
      const killed = await this.stop(id, workload)
      if (killed.code !== 0) return killed
      const built = await this.build(id, workload)
      if (built.code !== 0) return built
      return await this.start(id, workload)
    } finally {
      this.transitions.delete(key)
      await this.reconcileOne(id) // settle to the real, reconciled status
    }
  }

  /** Take over an externally-run dev session ("move here"). `devspace dev`
   *  replaces the target pod and then holds the session (port-forward/sync/
   *  terminal) from whatever process started it; RUNNING_EXTERNAL means that
   *  process is running outside devdock. We stop that process — which releases
   *  devspace's namespace session lock and leaves the replaced dev pod running —
   *  then run `devspace dev` here, which reconnects to that same pod. No purge or
   *  deploy is involved, so the deployment/image and other workloads sharing the
   *  namespace are never disturbed.
   *
   *  Held under the RESTARTING override so the row shows one stable state instead
   *  of flickering as the sub-steps reconcile. */
  async adopt(id: string, workload?: string): Promise<RunResult> {
    const { repo, key } = this.scoped(id, workload)
    const denied = await this.ensureAuth(key)
    if (denied) return denied
    await this.claimOwnership(repo)
    this.transitions.set(key, 'RESTARTING')
    await this.reconcileOne(id) // reflect RESTARTING immediately
    const hub = this.hubFor(key)
    try {
      hub.push('$ move here — releasing the external devspace dev session')
      const { pids } = await this.supervisor.stopExternalDev(repo, (l) => hub.push(l))
      if (pids.length === 0) {
        hub.push(
          '! no live external session holds the lock (stale or owned elsewhere) — reconnecting to the existing dev pod',
        )
      } else {
        hub.push(`✓ external session stopped (pid ${pids.join(', ')}); the dev pod is kept`)
      }
      // Reconnect: `devspace dev` takes over the freed lock and reuses the
      // existing replaced pod — no rebuild, no redeploy, no purge.
      return await this.start(id, workload)
    } finally {
      this.transitions.delete(key)
      await this.reconcileOne(id) // settle to the real, reconciled status
    }
  }

  /** Run a verb with a `$ cmd` header and ✓/✗ footer, streaming lines into the repo's hub. */
  private async narrate(
    id: string,
    label: string,
    fn: (onLine: (line: string) => void) => Promise<RunResult>,
  ): Promise<RunResult> {
    const hub = this.hubFor(id)
    hub.push(`$ ${label}`)
    const r = await fn((line) => hub.push(line))
    hub.push(r.code === 0 ? `✓ ${label}` : `✗ ${label} exited ${r.code}`)
    return r
  }

  private async claimOwnership(repo: Repo): Promise<void> {
    if (!this.ownership) return
    await this.ownership.claim({
      ...repo,
      namespace: repo.namespace || (await this.contextNamespace()) || 'default',
    })
  }

  awsAuthState(): { configured: boolean; fresh: boolean } {
    return { configured: this.awsCreds.configured(), fresh: this.awsCreds.fresh() }
  }

  /** Send a one-off command into the workload's dev session (spec §8).
   *  `tmux send-keys` under the hood: keystrokes only, no output capture —
   *  callers that need the output should use a registered terminal instead. */
  async exec(id: string, command: string, workload?: string): Promise<RunResult> {
    await this.claimOwnership(this.scoped(id, workload).repo)
    return this.supervisor.exec(this.scoped(id, workload).repo, command)
  }

  /** The configured startup command for a repo's selected/default pod type. */
  getStartupCommand(id: string, workload?: string): string | undefined {
    const repo = this.repoOrThrow(id)
    return this.store.getStartup(id, startupPodType(repo, workload))
  }

  /** All startup commands keyed by the pod types offered by the repo. */
  getStartupCommands(id: string): Record<string, string> {
    const repo = this.repoOrThrow(id)
    return this.store.getStartupCommands(id, startupPodTypes(repo))
  }

  /** Persist (or, for an empty command, clear) one pod type's startup command.
   *  The cached state is updated so `/repos` reflects it immediately. */
  setStartupCommand(id: string, command: string, workload?: string): void {
    const repo = this.repoOrThrow(id)
    const podTypes = startupPodTypes(repo)
    this.store.setStartup(id, startupPodType(repo, workload), command, podTypes)
    const state = this.states.get(id)
    if (state) this.applyStartupCommands(state)
  }

  private applyStartupCommands(state: RepoState): void {
    const types = startupPodTypes(state.repo)
    state.startupCommands = this.store.getStartupCommands(state.repo.id, types)
    state.startupCommand = this.store.getStartup(
      state.repo.id,
      startupPodType(state.repo, state.repo.defaultWorkload),
    )
  }

  // ---- replicas: ephemeral branch-pinned parallel deployments (spec: replicas) ----

  listReplicas(): ReplicaRecord[] {
    return this.store.listReplicas()
  }

  /** Local branches of a repo's checkout, most recently committed first — the
   *  create-replica picker's data. Worktree branches are local heads too, so
   *  agents' in-flight branches show up. */
  async listBranches(id: string): Promise<{ name: string; lastCommitAt: number }[]> {
    const repo = this.repoOrThrow(id)
    const r = await this.runner('git', [
      '-C',
      repo.path,
      'for-each-ref',
      '--sort=-committerdate',
      '--format',
      '%(refname:short)\t%(committerdate:unix)',
      'refs/heads/',
    ])
    if (r.code !== 0) throw new Error(r.stderr.trim() || `git for-each-ref exited ${r.code}`)
    const out: { name: string; lastCommitAt: number }[] = []
    for (const line of r.stdout.split('\n')) {
      const [name, ts] = line.trim().split('\t')
      if (name) out.push({ name, lastCommitAt: Number(ts) * 1000 || 0 })
    }
    return out
  }

  /** Create a replica of `parentId` pinned to `branch`: a detached git
   *  worktree under `.agents/replicas/` plus generated configs (per-member for
   *  the `.devspace/<service>/` layout, the root devspace.yaml otherwise), so
   *  that branch's code deploys beside the parent in the same namespace with
   *  zero changes to tracked files anywhere. By default the replica reuses the
   *  parent's deployed image (fast; code arrives via sync); `ownImage` builds
   *  its own image from the branch first, so Dockerfile / system-dep changes
   *  take effect. Returns once the record is persisted; the deploy itself runs
   *  in the background (poll status / `wait`). */
  async createReplica(
    parentId: string,
    branch: string,
    opts: { ownImage?: boolean } = {},
  ): Promise<ReplicaRecord> {
    const parent = this.repoOrThrow(parentId)
    if (parent.parentId) throw new Error('cannot create a replica of a replica')
    const trimmedBranch = branch.trim()
    if (!trimmedBranch) throw new Error('branch required')
    const denied = (await this.ensureAuth(parentId)) ?? (await this.ensureAwsCreds(parentId))
    if (denied) throw new Error(denied.stderr || 'auth required')

    // Orphan dirs from a crashed create still occupy their id (existsSync), so
    // a new replica can never collide with leftovers GC hasn't swept yet.
    const replicasDir = join(parent.path, '.agents', 'replicas')
    const id = nextReplicaId(
      `${parentId}${this.replicaInstanceSuffix}`,
      (cand) =>
        this.repos.has(cand) ||
        !!this.store.getReplica(cand) ||
        existsSync(join(replicasDir, cand)),
    )
    const wt = join(replicasDir, id)
    mkdirSync(replicasDir, { recursive: true })
    // --detach: no branch is checked out twice (git forbids that) and the
    // worktree can't accumulate commits — replicas are strictly read-only
    // snapshots of the branch's tip at creation time.
    const added = await this.runner('git', [
      '-C',
      parent.path,
      'worktree',
      'add',
      '--detach',
      wt,
      trimmedBranch,
    ])
    if (added.code !== 0) {
      throw new Error(added.stderr.trim() || `git worktree add exited ${added.code}`)
    }
    try {
      let namespace = parent.namespace
      if (!namespace) namespace = (await this.contextNamespace()) || undefined
      // Own image: pin `<ns>-${WORKLOAD_NAME}` — the guidelines' default tag
      // with the namespace frozen at create time. WORKLOAD_NAME flows from the
      // renamed project, so the tag never collides with the parent's, and
      // `deploy` builds it before `dev` runs (the dev pipeline never builds).
      const ownTag = opts.ownImage ? `${namespace ?? ''}-\${WORKLOAD_NAME}` : undefined
      const configPaths: string[] = []
      if (parent.members?.length) {
        for (const member of parent.members) {
          const type = member.workloadType ?? member.id
          const generated = generateReplicaConfig(readFileSync(member.configPath, 'utf8'), {
            replicaId: id,
            workloadType: type,
            // Default: the parent's tag — code arrives via sync, so the
            // replica runs on the parent's base image.
            imageTag: ownTag ?? `${namespace ?? ''}-${member.name}`,
          })
          const dir = join(wt, '.devspace', `${id}-${type}`)
          mkdirSync(dir, { recursive: true })
          const configPath = join(dir, 'devspace.yaml')
          writeFileSync(configPath, generated)
          configPaths.push(configPath)
        }
      } else {
        // Single root config: overwrite the worktree's own devspace.yaml so
        // relative paths and imports resolve exactly as they do for the
        // parent. The worktree is force-removed on delete, so the dirty file
        // never matters. The parent's tag mirrors the guidelines' convention:
        // `<ns>-<name>` for ui charts, `<ns>-<name>-<type>` otherwise (the
        // type is left for devspace to interpolate per workload).
        const parentTag =
          parent.codeArea === 'frontend'
            ? `${namespace ?? ''}-${parent.name}`
            : `${namespace ?? ''}-${parent.name}-\${WORKLOAD_TYPE}`
        const generated = generateReplicaConfig(readFileSync(parent.configPath, 'utf8'), {
          replicaId: id,
          imageTag: ownTag ?? parentTag,
        })
        mkdirSync(wt, { recursive: true })
        const configPath = join(wt, 'devspace.yaml')
        writeFileSync(configPath, generated)
        configPaths.push(configPath)
      }
      this.store.copyStartup(parentId, id) // inherit `python main.py` etc.
      const record: ReplicaRecord = {
        id,
        parentId,
        branch: trimmedBranch,
        path: wt,
        createdAt: Date.now(),
        configPaths,
        namespace,
      }
      if (opts.ownImage) record.ownImage = true
      const repo = this.materializeReplica(record)
      if (!repo) throw new Error('generated replica configs failed to parse')
      // Every helm release the deploy can create, remembered for uninstall on
      // delete (uninstall is best-effort, so a superset is harmless).
      record.releases = [
        ...new Set([
          ...workloadTypes(repo).map((t) => scopeRepo(repo, t).name),
          ...startupPodTypes(repo).map((t) => `${id}-${t}`),
        ]),
      ]
      this.store.addReplica(record) // persisted before start — restart-safe
      this.repos.set(id, repo)
      if (opts.ownImage) {
        this.hubFor(id).push(
          `✓ replica ${id} created from ${trimmedBranch} — building image, then deploying`,
        )
        void this.build(id)
          .then((r) => (r.code === 0 ? this.start(id) : undefined))
          .catch(() => undefined)
      } else {
        this.hubFor(id).push(`✓ replica ${id} created from ${trimmedBranch} — deploying`)
        void this.start(id).catch(() => undefined)
      }
      return record
    } catch (err) {
      await this.runner('git', ['-C', parent.path, 'worktree', 'remove', '--force', wt]).catch(
        () => undefined,
      )
      this.store.removeReplica(id)
      this.store.clearStartup(id)
      this.repos.delete(id)
      throw err
    }
  }

  /** Delete a replica: stop its workloads, remove its alias ingress and its
   *  worktree, and purge every trace from the store. Works from stored paths
   *  even when the worktree or parent checkout has already gone. */
  async deleteReplica(id: string): Promise<void> {
    const rec = this.store.getReplica(id)
    if (!rec) throw new Error(`unknown replica: ${id}`)
    const repo = this.repos.get(id)
    if (repo) {
      for (const type of workloadTypes(repo)) await this.claimOwnership(scopeRepo(repo, type))
    } else if (this.ownership) {
      throw new Error('Cannot verify ownership of a missing replica checkout')
    }
    if (repo) {
      for (const type of workloadTypes(repo)) {
        await this.stop(id, type).catch(() => undefined)
      }
    }
    if (rec.namespace) {
      await this.kubectl('kubectl', [
        'delete',
        'ingress',
        rec.ingressName ?? `${id}-alias`,
        '-n',
        rec.namespace,
        '--ignore-not-found',
      ]).catch(() => undefined)
      // purge leaves the chart's stopped-state release behind (ExternalName
      // service + base ingress routing to uat); a deleted replica must not.
      // Older records lack `releases`; their config dirs carry the names.
      const releases = rec.releases ?? rec.configPaths.map((cfg) => basename(dirname(cfg)))
      for (const release of releases) {
        await this.kubectl('helm', ['uninstall', release, '-n', rec.namespace]).catch(
          () => undefined,
        )
      }
    }
    const parentPath = this.repos.get(rec.parentId)?.path ?? dirname(dirname(dirname(rec.path)))
    const removed = await this.runner('git', [
      '-C',
      parentPath,
      'worktree',
      'remove',
      '--force',
      rec.path,
    ]).catch(() => undefined)
    if (!removed || removed.code !== 0) {
      await this.runner('rm', ['-rf', rec.path]).catch(() => undefined)
      await this.runner('git', ['-C', parentPath, 'worktree', 'prune']).catch(() => undefined)
    }
    this.store.removeReplica(id)
    this.store.clearStartup(id)
    this.repos.delete(id)
    this.states.delete(id)
    this.purgeWorkloadState(id)
  }

  /** Delete replicas past their TTL, plus worktree dirs recorded nowhere
   *  (a crashed create) that are old enough that nothing can still be
   *  materializing them. Returns the deleted replica ids. */
  async gcReplicas(now = Date.now()): Promise<string[]> {
    const deleted: string[] = []
    for (const rec of this.store.listReplicas()) {
      if (now - rec.createdAt < REPLICA_TTL_MS) continue
      await this.deleteReplica(rec.id).catch(() => undefined)
      deleted.push(rec.id)
    }
    for (const repo of this.repos.values()) {
      if (repo.parentId) continue
      const dir = join(repo.path, '.agents', 'replicas')
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (this.store.getReplica(name)) continue
        const orphan = join(dir, name)
        try {
          const st = statSync(orphan)
          if (!st.isDirectory() || now - st.mtimeMs < REPLICA_TTL_MS) continue
        } catch {
          continue
        }
        await this.runner('git', ['-C', repo.path, 'worktree', 'remove', '--force', orphan]).catch(
          () => undefined,
        )
        await this.runner('rm', ['-rf', orphan]).catch(() => undefined)
        await this.runner('git', ['-C', repo.path, 'worktree', 'prune']).catch(() => undefined)
      }
    }
    return deleted
  }

  /** Build a replica's Repo from its stored record, parsing only the
   *  generated configs — base + members for the `.devspace/<service>/` layout,
   *  a plain single-config repo when the generated config sits at the worktree
   *  root. A missing worktree materializes nothing; the record is kept so
   *  delete/GC can still clean up from stored paths. */
  private materializeReplica(rec: ReplicaRecord): Repo | undefined {
    const rootConfig = rec.configPaths.length === 1 ? rec.configPaths[0] : undefined
    if (rootConfig && dirname(rootConfig) === rec.path) {
      let text: string
      try {
        text = readFileSync(rootConfig, 'utf8')
      } catch {
        return undefined
      }
      const cfg = parseDevspaceConfig(text)
      // No `root`: like any single-config repo, devspace runs in the worktree
      // root directly (no DEVSPACE_BINARY_DIR wrapper).
      return {
        id: rec.id,
        name: cfg.name ?? rec.id,
        path: rec.path,
        codeArea: this.repos.get(rec.parentId)?.codeArea,
        configPath: rootConfig,
        namespace: cfg.namespace ?? rec.namespace,
        workload: cfg.workload,
        ports: cfg.ports,
        varDefaults: Object.keys(cfg.varDefaults).length ? cfg.varDefaults : undefined,
        workloads: cfg.workloads,
        defaultWorkload: cfg.defaultWorkload,
        workloadType: cfg.workloadType,
        session: sessionName(rec.id),
        parentId: rec.parentId,
        branch: rec.branch,
        replicaCreatedAt: rec.createdAt,
      }
    }
    const members: Repo[] = []
    for (const configPath of rec.configPaths) {
      let text: string
      try {
        text = readFileSync(configPath, 'utf8')
      } catch {
        continue
      }
      const cfg = parseDevspaceConfig(text)
      const memberPath = dirname(configPath)
      const memberId = basename(memberPath)
      const type =
        cfg.workloadType ??
        (memberId.startsWith(`${rec.id}-`) ? memberId.slice(rec.id.length + 1) : memberId)
      members.push({
        id: memberId,
        name: cfg.name ?? memberId,
        path: memberPath,
        codeArea: this.repos.get(rec.parentId)?.codeArea,
        root: rec.path,
        configPath,
        namespace: cfg.namespace ?? rec.namespace,
        workload: cfg.workload,
        ports: cfg.ports,
        varDefaults: Object.keys(cfg.varDefaults).length ? cfg.varDefaults : undefined,
        workloadType: type,
        session: sessionName(memberId),
      })
    }
    if (!members.length) return undefined
    members.sort(
      (a, b) =>
        Number(a.workloadType !== 'api') - Number(b.workloadType !== 'api') ||
        (a.workloadType ?? '').localeCompare(b.workloadType ?? ''),
    )
    const types = members.map((m) => m.workloadType ?? m.id)
    const first = members[0] as Repo
    return {
      id: rec.id,
      name: rec.id,
      path: rec.path,
      codeArea: this.repos.get(rec.parentId)?.codeArea,
      root: rec.path,
      configPath: first.configPath,
      namespace: first.namespace,
      workload: first.workload,
      ports: [...new Set(members.flatMap((m) => m.ports))].sort((a, b) => a - b),
      workloads: types,
      defaultWorkload: types.includes('api') ? 'api' : types[0],
      members,
      session: sessionName(rec.id),
      parentId: rec.parentId,
      branch: rec.branch,
      replicaCreatedAt: rec.createdAt,
    }
  }

  /** Apply the replica's URL-alias Ingress once its pods exist. Failures stay
   *  silent — the next reconcile pass retries, so a stale AWS token or a slow
   *  chart ingress only delays the URL, never wedges it. */
  private async applyReplicaIngress(repo: Repo, rec: ReplicaRecord): Promise<void> {
    const ns = rec.namespace ?? repo.namespace
    if (!ns) return
    // The default workload's chart service (its name flows from the scoped
    // project name; a scalar WORKLOAD_TYPE suffixes it the same way).
    const member = scopeRepo(repo, repo.defaultWorkload ?? repo.workloadType)
    const parent = this.repos.get(rec.parentId)
    const parentMember = parent ? scopeRepo(parent, parent.defaultWorkload) : undefined
    // The shared hostname comes from an existing chart-created ingress —
    // the replica's own, else the parent's (they serve the same host).
    const host = await this.ingressHost(ns, [member.name, parentMember?.name])
    if (!host) return
    let parentPath = rec.parentId
    if (parentMember) {
      try {
        parentPath = ingressPathOf(readFileSync(parentMember.configPath, 'utf8')) || rec.parentId
      } catch {
        /* fall back to the parent id */
      }
    }
    const manifest = aliasIngressManifest({
      replicaId: rec.id,
      namespace: ns,
      host,
      parentIngressPath: parentPath,
      serviceName: member.name,
    })
    // exec has no stdin, so apply goes through a manifest file.
    const file = join(dirname(this.opts.stateFile), 'ingress', `${rec.id}.yaml`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, manifest)
    const r = await this.kubectl('kubectl', ['apply', '-f', file]).catch(() => undefined)
    if (!r || r.code !== 0) return
    this.store.updateReplica(rec.id, { ingressApplied: true, ingressName: `${rec.id}-alias` })
    this.hubFor(rec.id).push(`✓ url alias ready: https://${host}/${rec.id}/`)
  }

  /** A hostname served by an ingress in the namespace, preferring ingresses
   *  named after the given workloads (exact or `<name>-…`). */
  private async ingressHost(
    ns: string,
    preferredNames: (string | undefined)[],
  ): Promise<string | undefined> {
    const r = await this.kubectl('kubectl', ['get', 'ingress', '-o', 'json', '-n', ns]).catch(
      () => undefined,
    )
    if (!r || r.code !== 0) return undefined
    let items: { metadata?: { name?: string }; spec?: { rules?: { host?: string }[] } }[]
    try {
      items = (JSON.parse(r.stdout)?.items ?? []) as typeof items
    } catch {
      return undefined
    }
    for (const want of preferredNames) {
      if (!want) continue
      const hit = items.find(
        (i) => i.metadata?.name === want || i.metadata?.name?.startsWith(`${want}-`),
      )
      const host = hit?.spec?.rules?.find((rule) => rule.host)?.host
      if (host) return host
    }
    return undefined
  }

  /** Drop every per-workload artifact for a repo id — keys are the bare id or
   *  `<id>::<type>`. */
  private purgeWorkloadState(id: string): void {
    const match = (key: string) => key === id || key.startsWith(`${id}::`)
    for (const [key, t] of [...this.tailers]) {
      if (!match(key)) continue
      t.stop()
      this.tailers.delete(key)
    }
    for (const m of [
      this.hubs,
      this.logGens,
      this.watchers,
      this.transitions,
      this.noPodsSince,
      this.reconnects,
      this.pendingTermOpens,
    ] as Map<string, unknown>[]) {
      for (const key of [...m.keys()]) if (match(key)) m.delete(key)
    }
    for (const key of [...this.piped]) if (match(key)) this.piped.delete(key)
  }

  // ---- namespace (the UI face of the user's `kn` alias) ----
  /** The kube context's current namespace ('' when unset or unreadable). */
  private async contextNamespace(): Promise<string> {
    const r = await this.runner('kubectl', [
      'config',
      'view',
      '--minify',
      '--output',
      'jsonpath={..namespace}',
    ]).catch(() => undefined)
    return r && r.code === 0 ? r.stdout.trim() : ''
  }

  /** Current namespace + the selectable list. Learns the current one, so a
   *  `kn` switch done in a terminal shows up as an option here too. */
  async namespaceInfo(): Promise<NamespaceInfo> {
    const current = await this.contextNamespace()
    if (current) this.store.rememberNamespace(current)
    const known = new Set(this.store.getNamespaces())
    for (const r of this.repos.values()) {
      if (r.namespace) known.add(r.namespace)
    }
    if (current) known.add(current)
    return { current: current || 'default', known: [...known].sort() }
  }

  /** Switch the kube context's namespace — exactly what the user's `kn <ns>`
   *  alias runs, so the UI selector and terminal `kn` stay in sync. Pinned dev
   *  sessions keep their own namespace; everything else (queries, verbs, new
   *  sessions) follows the context from the next reconcile pass on. */
  async setNamespace(ns: string): Promise<NamespaceInfo> {
    const trimmed = ns.trim()
    if (!NAMESPACE_RE.test(trimmed)) throw new Error(`invalid namespace: ${ns}`)
    const r = await this.runner('kubectl', [
      'config',
      'set-context',
      '--current',
      `--namespace=${trimmed}`,
    ])
    if (r.code !== 0) {
      throw new Error(`kubectl set-context failed: ${r.stderr.trim() || `exit ${r.code}`}`)
    }
    this.store.rememberNamespace(trimmed)
    void this.reconcileAll().catch(() => undefined) // reflect the new view promptly
    return this.namespaceInfo()
  }

  /** Run the queued startup command in the dev session after a short grace, so
   *  the keystrokes land at the in-container shell `devspace dev` opens. */
  private scheduleStartup(scoped: Repo, key: string, command: string): void {
    setTimeout(() => {
      const hub = this.hubFor(key)
      hub.push(`$ ${command}  (startup)`)
      void this.supervisor.exec(scoped, command).then((r) => {
        if (r.code !== 0) hub.push(`✗ startup command exited ${r.code}`)
      })
    }, STARTUP_RUN_DELAY_MS)
  }

  // ---- reconciliation (spec §6) ----
  async reconcileOne(
    id: string,
    cache?: ClusterCache,
    sessions?: Map<string, SessionState>,
  ): Promise<RepoState> {
    const repo = this.repoOrThrow(id)
    // One `tmux list-panes -a` answers "is each workload's session live/dead?" —
    // the pass shares the map so a 47-repo reconcile is a single tmux call.
    const states = sessions ?? (await this.supervisor.sessionStates())
    const cc = cache ?? newClusterCache()
    cc.knownNames ??= this.knownClusterNames()

    const workloads = []
    for (const type of workloadTypes(repo)) {
      const key = workloadKey(id, type)
      // The pin routes this workload's kubectl queries (and any retire) to the
      // namespace its session actually runs in, not the context's current one.
      const scoped = this.pinned(scopeRepo(repo, type), key)
      const session = states.get(scoped.session)
      let exists = !!session
      let sessionDead = session?.dead === true
      let hasSession = exists && !sessionDead
      const ws = await this.reconciler.reconcileWorkload(
        scoped,
        hasSession,
        cc,
        type ?? repo.defaultWorkload ?? '',
        sessionDead,
      )

      // While a multi-step verb (restart) is in flight, force the transient
      // status so the loop doesn't surface the intermediate STOPPED/DEPLOYED.
      const transition = this.transitions.get(key)

      // Stale timer: starts when a session is first seen with no pods, resets
      // on any pass that sees pods — or that couldn't see the cluster at all.
      if (!session || ws.unreachable || ws.pods.length > 0) this.noPodsSince.delete(key)
      else if (!this.noPodsSince.has(key)) this.noPodsSince.set(key, Date.now())

      if (!transition && ws.unreachable && !sessionDead) {
        // kubectl failed: pods/deployments are unknown, not gone. Hold the last
        // known status instead of fabricating STOPPED/BUILDING for one pass.
        const prev = this.states.get(id)?.workloads.find((w) => w.type === ws.type)
        if (prev && prev.status !== 'RESTARTING') ws.status = prev.status
      }

      if (!transition && this.shouldRetireNoPodSession(ws, session, key)) {
        const target = ws.deployments.length > 0 ? 'DEPLOYED' : 'STOPPED'
        this.hubFor(key).push(
          `! stale dev session retired: no matching pods; reconciled to ${target.toLowerCase()}`,
        )
        await this.supervisor.retireSession(scoped)
        this.piped.delete(key)
        this.noPodsSince.delete(key)
        this.reconnects.delete(key)
        this.store.setSessionNamespace(key, undefined)
        this.store.setPendingStartup(key, undefined) // its target session is gone
        exists = false
        sessionDead = false
        hasSession = false
        ws.hasSession = false
        ws.status = target
      } else if (!transition && sessionDead && !ws.unreachable && ws.pods.length > 0) {
        // `devspace dev` died but its pod is still running (laptop sleep, a
        // dropped port-forward/sync connection). Reconnect instead of sitting
        // in CRASHED — devspace reattaches to the existing dev pod.
        if (this.scheduleReconnect(id, type, key)) ws.status = 'RESTARTING'
      }
      if (transition) ws.status = transition

      // A workload that has run managed for a while proved the reconnect took —
      // re-arm the attempt budget for the next disconnect.
      if (ws.status === 'RUNNING_MANAGED') {
        const r = this.reconnects.get(key)
        if (r && Date.now() - r.lastAt >= RECONNECT_RESET_MS) this.reconnects.delete(key)
      }
      workloads.push(ws)

      // Once the dev session's pod is up, fire any queued startup command into
      // the session (the initial dev pod) — one shot per start.
      const pending = this.store.getPendingStartup(key)
      if (ws.status === 'RUNNING_MANAGED' && ws.pods.some((pod) => pod.ready) && pending) {
        this.store.setPendingStartup(key, undefined)
        this.scheduleStartup(scoped, key, pending)
      }
      if (exists) {
        // The session is present (alive or a dead/crashed shell). Keep its pane
        // mirrored to the on-disk dev log — a forensic record of the session
        // (including its last lines before a crash). It is not fed into the
        // Logs hub: the Terminal panel shows this pane live.
        const file = this.devLogPath(key)
        mkdirSync(dirname(file), { recursive: true })
        if (!sessionDead) {
          // pipe-pane -o is a no-op if already piped; re-asserting it recovers a
          // pipe dropped by a tmux server restart. keepalive/mouse backfill
          // sessions started before those options were set.
          await this.supervisor.pipe(scoped, file)
          if (!this.piped.has(key)) {
            await this.supervisor.keepalive(scoped)
            await this.supervisor.mouse(scoped)
            this.piped.add(key)
          }
        }
      } else {
        this.piped.delete(key)
      }
    }
    const state = assembleState(repo, workloads, Date.now())
    this.applyStartupCommands(state)
    this.applyState(state)
    if (repo.parentId && state.pods.length > 0) {
      const rec = this.store.getReplica(id)
      if (rec && !rec.ingressApplied)
        await this.applyReplicaIngress(repo, rec).catch(() => undefined)
    }
    return state
  }

  /** Every name that can claim pods this pass — repo names plus their
   *  workload-scoped variants — so attribution lets the longest name win
   *  (a replica's pods must not also count as its parent's). */
  private knownClusterNames(): string[] {
    const names = new Set<string>()
    for (const repo of this.repos.values()) {
      names.add(repo.name)
      for (const type of workloadTypes(repo)) names.add(scopeRepo(repo, type).name)
    }
    return [...names]
  }

  async reconcileAll(): Promise<RepoState[]> {
    const authSync = this.auth.syncContext?.()
    if (authSync) await authSync.catch(() => undefined)
    // Share one cluster snapshot + one session map across the pass — repos in
    // the same namespace reuse a single kubectl query instead of one each.
    const cache = newClusterCache()
    const sessions = await this.supervisor.sessionStates()
    const out: RepoState[] = []
    for (const id of this.repos.keys()) out.push(await this.reconcileOne(id, cache, sessions))
    return out
  }

  private applyState(state: RepoState): void {
    const prev = this.states.get(state.repo.id)
    this.states.set(state.repo.id, state)
    this.store.setStatus(state.repo.id, state.status)

    const watcher = this.watcherFor(state.repo.id)
    for (const e of watcher.observePods(state.pods, state.updatedAt)) {
      this.events.emit('crash', e)
    }
    if (!prev || prev.status !== state.status) {
      this.events.emit('status', state)
    }
  }

  /** Retire a no-pod session only on proof, never on a blip: the cluster must
   *  have been reachable this pass, the no-pods condition must have held
   *  continuously for STALE_NO_POD_SESSION_MS, and the session must be old
   *  enough that this can't be a slow first build. A dead session with
   *  deployment objects but no pods retires immediately — its dev process
   *  already exited and the cluster is authoritative. */
  private shouldRetireNoPodSession(
    ws: { pods: unknown[]; deployments: unknown[]; unreachable?: boolean },
    session: SessionState | undefined,
    key: string,
  ): boolean {
    if (!session || ws.unreachable || ws.pods.length > 0) return false
    if (session.dead && ws.deployments.length > 0) return true
    const since = this.noPodsSince.get(key)
    if (since === undefined || Date.now() - since < STALE_NO_POD_SESSION_MS) return false
    return (
      session.createdAt !== undefined && Date.now() - session.createdAt >= STALE_NO_POD_SESSION_MS
    )
  }

  /** Kick off an auto-reconnect for a dead dev session whose pod still runs.
   *  Returns true when one was started (the caller shows RESTARTING); paced by
   *  a cooldown and capped so a crash-looping dev settles into CRASHED. */
  private scheduleReconnect(id: string, workload: string | undefined, key: string): boolean {
    const now = Date.now()
    const prior = this.reconnects.get(key) ?? { attempts: 0, lastAt: 0 }
    if (prior.attempts >= MAX_RECONNECT_ATTEMPTS || now - prior.lastAt < RECONNECT_COOLDOWN_MS) {
      return false
    }
    const attempts = prior.attempts + 1
    this.reconnects.set(key, { attempts, lastAt: now })
    this.transitions.set(key, 'RESTARTING')
    this.hubFor(key).push(
      `! dev session died but its pod is still running — reconnecting (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})`,
    )
    void this.reconnect(id, workload, key)
    return true
  }

  /** Reconnect = retire the dead tmux shell (and its stale namespace lock),
   *  then `devspace dev` again — it reattaches to the existing dev pod, no
   *  purge or rebuild, and the startup command re-fires once the session is
   *  up. Held under RESTARTING like adopt/restart so the row doesn't flicker. */
  private async reconnect(id: string, workload: string | undefined, key: string): Promise<void> {
    const hub = this.hubFor(key)
    try {
      const { repo } = this.scoped(id, workload)
      await this.supervisor.retireSession(repo)
      this.piped.delete(key)
      const r = await this.start(id, workload)
      hub.push(r.code === 0 ? '✓ dev session reconnected' : `✗ reconnect failed (exit ${r.code})`)
    } catch (err) {
      hub.push(`✗ reconnect failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.transitions.delete(key)
      await this.reconcileOne(id).catch(() => undefined)
    }
  }

  private watcherFor(id: string): CrashWatch {
    let w = this.watchers.get(id)
    if (!w) {
      w = new CrashWatch(id)
      this.watchers.set(id, w)
    }
    return w
  }

  // ---- logs (spec §12) ----
  /** Recent lines from a workload's hub (pod logs + verb activity). */
  logs(id: string, tail = 200, workload?: string): string[] {
    const { key } = this.scoped(id, workload)
    this.ensureTailer(id, workload)
    return this.hubFor(key).recent(tail)
  }

  subscribeLogs(id: string, cb: (line: string) => void, workload?: string): () => void {
    const { key } = this.scoped(id, workload)
    this.ensureTailer(id, workload)
    return this.hubFor(key).subscribe(cb)
  }

  private hubFor(id: string): LogHub {
    let hub = this.hubs.get(id)
    if (!hub) {
      hub = new LogHub()
      this.hubs.set(id, hub)
    }
    return hub
  }

  /** Where `tmux pipe-pane` mirrors a workload's `devspace dev` pane — an
   *  on-disk record for debugging/forensics, not shown in the Logs panel.
   *  `key` is the per-workload key (`<id>` or `<id>::<type>`); `::` is
   *  unfilesystemy so it becomes `.`. */
  private devLogPath(key: string): string {
    return join(dirname(this.opts.stateFile), 'logs', `${key.replace('::', '.')}.dev.log`)
  }

  // ---- agent loop primitives: run / query / wait ----

  /** The pod to exec into / read container logs from: prefer a ready dev pod
   *  (the `-devspace` replacement `devspace dev` creates), then any ready pod,
   *  then whatever exists. */
  private pickPod(id: string, type?: string): { name: string } | undefined {
    const state = this.states.get(id)
    const pods = (type ? state?.workloads.find((w) => w.type === type)?.pods : state?.pods) ?? []
    return (
      pods.find((p) => p.ready && p.name.includes('-devspace')) ??
      pods.find((p) => p.ready) ??
      pods[0]
    )
  }

  /** Run a one-shot command inside the workload's pod and return its REAL exit
   *  code and output (kubectl exec propagates the remote exit status) — unlike
   *  exec(), which types into the dev session and captures nothing. Infra
   *  failures (no pod, auth, connectivity) are reported via infraError so an
   *  agent never mistakes a broken cluster for a failing test. */
  async runInWorkload(
    id: string,
    command: string,
    opts: { workload?: string; timeoutMs?: number } = {},
  ): Promise<WorkloadRunResult> {
    const { repo, type, key } = this.scoped(id, opts.workload)
    await this.claimOwnership(repo)
    const fail = (infraError: string, pod?: string): WorkloadRunResult => ({
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: '',
      pod,
      timedOut: false,
      truncated: false,
      infraError,
    })
    if (!this.auth.kubectlAllowed(['exec'])) {
      return fail('kubernetes login required — run devdock_auth_login and retry')
    }
    const pod = this.pickPod(id, type)
    if (!pod) return fail(`no running pod for ${key} — start it first`)
    const ns = repo.namespace ? ['-n', repo.namespace] : []
    const timeoutMs = Math.min(opts.timeoutMs ?? RUN_TIMEOUT_DEFAULT_MS, RUN_TIMEOUT_MAX_MS)
    const r = await this.runner('kubectl', ['exec', pod.name, ...ns, '--', 'sh', '-c', command], {
      timeoutMs,
      maxOutputBytes: RUN_MAX_OUTPUT_BYTES,
    })
    const timedOut = r.timedOut === true
    const infra = r.code !== 0 && !timedOut && KUBECTL_INFRA_RE.test(r.stderr)
    return {
      ok: r.code === 0 && !timedOut,
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      pod: pod.name,
      timedOut,
      truncated: r.truncated === true,
      ...(infra ? { infraError: `kubectl exec failed: ${r.stderr.trim().slice(0, 500)}` } : {}),
    }
  }

  /** Read a workload's logs by source with cursor-based resume. A stale or
   *  unparseable cursor resyncs from the tail (flagged via `resync`) instead
   *  of erroring — mirrors the Kubernetes watch 410 Gone pattern. */
  async queryLogs(id: string, opts: LogQueryOptions = {}): Promise<LogQueryResult> {
    const { type, key } = this.scoped(id, opts.workload)
    const tail = Math.min(Math.max(opts.tail ?? 200, 0), 2000)
    const cursor = decodeCursor(opts.cursor)
    const badCursor = opts.cursor !== undefined && cursor === undefined

    let source = opts.source ?? 'auto'
    if (source === 'auto') {
      const state = this.states.get(id)
      const workloadState = type ? state?.workloads.find((w) => w.type === type) : state
      const applicationLogExists = readFileSlice(this.devLogPath(key), 0, 1) !== undefined
      if (workloadState?.hasSession && applicationLogExists) source = 'application'
      else if (this.pickPod(id, type)) source = 'container'
      else if (applicationLogExists) source = 'application'
      else source = 'devdock'
    }

    const filter = (lines: string[]) =>
      opts.contains ? lines.filter((l) => l.includes(opts.contains as string)) : lines

    if (source === 'application') {
      const gen = this.logGens.get(key) ?? 0
      const live = cursor?.kind === 'file' && cursor.gen === gen ? cursor : undefined
      const stale = !live
      const slice = readFileSlice(this.devLogPath(key), live?.offset ?? 0)
      if (!slice) {
        // No pipe file (never started / logs dir gone) — empty read, cursor at 0.
        return {
          source,
          lines: [],
          cursor: encodeCursor({ kind: 'file', gen, offset: 0 }),
          resync: badCursor || (cursor !== undefined && stale),
        }
      }
      let lines = filter(slice.lines.map(cleanLine).filter((l) => l.trim() !== ''))
      if (stale) lines = tail > 0 ? lines.slice(-tail) : []
      return {
        source,
        lines,
        cursor: encodeCursor({ kind: 'file', gen, offset: slice.nextOffset }),
        resync: badCursor || (cursor !== undefined && stale),
        dropped: slice.truncated,
      }
    }

    if (source === 'container') {
      if (!this.auth.kubectlAllowed(['logs'])) {
        throw new Error('kubernetes login required — run devdock_auth_login and retry')
      }
      const { repo } = this.scoped(id, opts.workload)
      const pod = this.pickPod(id, type)
      if (!pod) throw new Error(`no running pod for ${key} — start it first`)
      const ns = repo.namespace ? ['-n', repo.namespace] : []
      // Mint the next cursor BEFORE reading so lines landing mid-read are
      // caught by the next call rather than skipped.
      const now = new Date().toISOString()
      const args = ['logs', pod.name, ...ns]
      if (cursor?.kind === 'container') args.push(`--since-time=${cursor.sinceTime}`)
      else args.push('--tail', String(tail))
      const r = await this.runner('kubectl', args, { timeoutMs: 30_000 })
      if (r.code !== 0) throw new Error(`kubectl logs failed: ${r.stderr.trim() || r.code}`)
      return {
        source,
        pod: pod.name,
        lines: filter(nonEmptyLines(r.stdout)),
        cursor: encodeCursor({ kind: 'container', sinceTime: now }),
        resync: badCursor || (opts.cursor !== undefined && cursor?.kind !== 'container'),
      }
    }

    // devdock: the verb-activity/pod-log hub
    this.ensureTailer(id, opts.workload)
    const hub = this.hubFor(key)
    if (cursor?.kind === 'hub') {
      const r = hub.since(cursor.seq)
      return {
        source,
        lines: filter(r.lines),
        cursor: encodeCursor({ kind: 'hub', seq: r.nextSeq }),
        dropped: r.dropped,
      }
    }
    return {
      source,
      lines: filter(tail > 0 ? hub.recent(tail) : []),
      cursor: encodeCursor({ kind: 'hub', seq: hub.currentSeq }),
      resync: opts.cursor !== undefined,
    }
  }

  /** Block until a condition holds or the timeout passes — the daemon does the
   *  polling internally so callers (agents) make ONE call instead of a poll
   *  loop. Conditions are OR'd: `contains` (a new log line with the substring),
   *  `status` (workload reaches it), `ready` (a pod is ready). Without a
   *  cursor, `contains` watches from NOW — old lines never match. */
  async wait(id: string, opts: WaitOptions): Promise<WaitResult> {
    if (!opts.contains && !opts.status && !opts.ready) {
      throw new Error('wait needs at least one condition: contains, status, or ready')
    }
    const started = Date.now()
    const timeoutMs = Math.min(opts.timeoutMs ?? WAIT_TIMEOUT_DEFAULT_MS, WAIT_TIMEOUT_MAX_MS)
    const pollMs = opts.pollMs ?? WAIT_POLL_MS
    const { type } = this.scoped(id, opts.workload)
    const wantStatus = opts.status?.toUpperCase()

    let cursor = opts.cursor
    if (opts.contains && !cursor) {
      // Capture the current end of the log first — matching starts from now.
      cursor = (await this.queryLogs(id, { workload: opts.workload, source: opts.source, tail: 0 }))
        .cursor
    }

    const currentStatus = (): RepoStatus | undefined => {
      const state = this.states.get(id)
      if (!state) return undefined
      return (type ? state.workloads.find((w) => w.type === type)?.status : state.status) as
        | RepoStatus
        | undefined
    }

    for (;;) {
      const state = this.states.get(id)
      const ws = type ? state?.workloads.find((w) => w.type === type) : state
      if (wantStatus && ws?.status === wantStatus) {
        return {
          matched: true,
          reason: 'status',
          status: ws.status as RepoStatus,
          elapsedMs: Date.now() - started,
          cursor,
        }
      }
      if (opts.ready && ws?.pods.some((p) => p.ready)) {
        return {
          matched: true,
          reason: 'ready',
          status: ws.status as RepoStatus,
          elapsedMs: Date.now() - started,
          cursor,
        }
      }
      if (opts.contains) {
        const q = await this.queryLogs(id, {
          workload: opts.workload,
          source: opts.source,
          cursor,
        })
        cursor = q.cursor
        const hit = q.lines.find((l) => l.includes(opts.contains as string))
        if (hit) {
          return {
            matched: true,
            reason: 'contains',
            line: hit,
            status: currentStatus(),
            elapsedMs: Date.now() - started,
            cursor,
          }
        }
      }
      if (Date.now() - started >= timeoutMs) {
        return {
          matched: false,
          reason: 'timeout',
          status: currentStatus(),
          elapsedMs: Date.now() - started,
          cursor,
        }
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  private ensureTailer(id: string, workload?: string): void {
    const { repo, type, key } = this.scoped(id, workload)
    if (this.tailers.has(key)) return
    // A stale token would make the streamed `kubectl logs -f` spawn its own
    // kubelogin (browser tab included) outside the gate — wait for reconcile
    // to retry once auth is fresh.
    if (!this.auth.kubectlAllowed(['logs'])) return
    const state = this.states.get(id)
    const pods = type ? (state?.workloads.find((w) => w.type === type)?.pods ?? []) : state?.pods
    const pod = pods?.find((candidate) => candidate.ready)
    if (!pod) return
    const tailer = new LogTailer(this.streamSpawner, this.hubFor(key))
    tailer.start(repo, pod)
    // feed crash detection from new log lines only — the hub's backlog may
    // hold old pod logs and verb output that must not re-trigger alerts.
    const watcher = this.watcherFor(key)
    tailer.hub.subscribe(
      (line) => {
        const e = watcher.observeLog(pod.name, line)
        if (e) this.events.emit('crash', e)
      },
      { replay: false },
    )
    this.tailers.set(key, tailer)
  }

  // ---- terminal (spec §8) ----
  /**
   * Open a terminal for a workload.
   *
   * `kind: 'auto'` (the primary terminal) attaches the devdock tmux dev session
   * when one exists, else falls back to a `devspace enter` pod shell — the right
   * default for "show me what's running". `kind: 'shell'` always opens an
   * independent pod shell, even when a managed session exists, so the UI can
   * spawn extra terminals into the same pod alongside the dev session.
   */
  async openTerminal(
    id: string,
    mode: TermMode,
    cols?: number,
    rows?: number,
    workload?: string,
    kind: 'auto' | 'shell' = 'auto',
  ) {
    const { repo, type } = this.scoped(id, workload)
    if (kind === 'auto' && (await this.supervisor.hasSession(repo))) {
      return this.broker.open(repo, mode, cols, rows)
    }
    const state = this.states.get(id)
    const pods = (type ? state?.workloads.find((w) => w.type === type)?.pods : state?.pods) ?? []
    if (pods.length > 0) {
      return this.broker.openShell(repo, mode, cols, rows, pods[0]?.name)
    }
    throw new Error(`${id} has no running pod to open a shell into — start it first`)
  }

  // ---- registered terminals (spec §8 — the ONLY terminal surface) ----
  // Every terminal lives in the registry under an id: agents drive them
  // request/response (run/read), the web UI attaches to the same sessions
  // live. Opened wide (200x50) — an attaching viewer resizes to fit.

  /** Open a terminal and register it. `local` spawns a login shell on the
   *  devdock host; `auto`/`shell` open the workload's dev session / pod shell.
   *  `auto` is the workload's ONE primary terminal: concurrent and repeated
   *  opens return the existing terminal instead of racing a second attach
   *  into the same tmux session (whose write-lock the first one holds). */
  async openRegisteredTerminal(opts: {
    repo?: string
    workload?: string
    kind?: TermKind
    cwd?: string
  }): Promise<TermInfo> {
    const kind = opts.kind ?? (opts.repo ? 'auto' : 'local')
    if (kind === 'local') {
      const session = await this.broker.openLocal('rw', 200, 50, opts.cwd)
      return this.terms.add({ kind, attach: 'host' }, session)
    }
    const repoId = opts.repo
    if (!repoId) throw new Error(`repo required for a ${kind} terminal`)
    await this.claimOwnership(this.scoped(repoId, opts.workload).repo)
    // Store the RESOLVED workload type so every client (UI picking 'api',
    // an agent omitting the default) lands on the same terminal identity.
    const { type, key } = this.scoped(repoId, opts.workload)
    if (kind !== 'auto') {
      return this.terms.add(
        { kind, repo: repoId, workload: type, attach: 'pod' },
        await this.openTerminal(repoId, 'rw', 200, 50, type, kind),
      )
    }
    const pending = this.pendingTermOpens.get(key)
    if (pending) return pending
    const p = this.openAutoTerminal(repoId, type, key).finally(() => {
      this.pendingTermOpens.delete(key)
    })
    this.pendingTermOpens.set(key, p)
    return p
  }

  /** The reuse-or-create path for a workload's primary terminal. A live auto
   *  terminal is reused only while it still points at the right target — a
   *  pod-shell fallback goes stale once a managed tmux session appears (and
   *  vice versa), in which case it's closed and replaced. */
  private async openAutoTerminal(repoId: string, type: string | undefined, key: string) {
    const { repo } = this.scoped(repoId, type)
    const attach = (await this.supervisor.hasSession(repo)) ? ('tmux' as const) : ('pod' as const)
    const existing = this.terms.findLive('auto', repoId, type)
    if (existing) {
      if (existing.attach === attach) return existing
      this.terms.close(existing.id)
    }
    const session = await this.openTerminal(repoId, 'rw', 200, 50, type, 'auto')
    return this.terms.add({ kind: 'auto', repo: repoId, workload: type, attach }, session)
  }

  /** Attach a live viewer (a web terminal socket) to a registered terminal:
   *  scrollback replay + live stream; per-viewer ro/rw. */
  attachTerminal(id: string, mode: TermMode, watcher: Parameters<TermRegistry['attach']>[2]) {
    return this.terms.attach(id, mode, watcher)
  }

  listTerminals(): TermInfo[] {
    return this.terms.list()
  }

  readTerminal(id: string, tail?: number): string {
    return this.terms.read(id, tail)
  }

  runInTerminal(id: string, command: string, timeoutMs?: number): Promise<RunOutcome> {
    return this.terms.run(id, command, timeoutMs)
  }

  closeTerminal(id: string): void {
    this.terms.close(id)
  }

  // ---- kubernetes auth (owned by AuthManager, surfaced over /auth) ----
  authState(): AuthState {
    return this.auth.snapshot()
  }

  /** Kick off one explicit login without holding the HTTP request open. The
   *  sign-in URL appears in later /auth polls; no browser is launched. */
  authLogin(): AuthState {
    void this.auth.login().catch(() => undefined)
    return this.auth.snapshot()
  }

  authClearCache(): AuthState {
    return this.auth.clearCache()
  }

  // ---- AWS credential (owned by AwsCreds, surfaced over /aws/credential) ----
  /** Mint/serve the credential_process payload. Blocks through one silent
   *  refresh — or one shared browser sign-in — because the caller is an
   *  `aws` process that cannot proceed without it. */
  awsCredential(): Promise<{ ok: true; cred: AwsCredential } | { ok: false; message: string }> {
    return this.awsCreds.credential()
  }

  // ---- reconcile loop ----
  async startLoop(): Promise<void> {
    // Probe auth before the first reconcile so a stale token gates kubectl
    // from tick one instead of racing kubelogins at boot.
    await this.auth.init().catch(() => undefined)
    this.rescan()
    await this.reconcileAll()
    // Record ownership for already-running managed sessions after discovery.
    for (const state of this.list()) {
      for (const workload of state.workloads) {
        if (workload.hasSession) {
          await this.claimOwnership(
            this.scoped(state.repo.id, workload.type || undefined).repo,
          ).catch((error: unknown) => {
            this.hubFor(state.repo.id).push(
              error instanceof Error ? error.message : 'Ownership verification unavailable',
            )
          })
        }
      }
    }
    this.timer = setInterval(() => {
      void this.reconcileAll().catch(() => undefined)
      this.terms.sweep() // reap idle/dead agent terminals alongside each pass
    }, this.opts.reconcileMs)
    this.authTimer = setInterval(() => {
      void this.auth.maintain().catch(() => undefined)
    }, AUTH_MAINTAIN_MS)
    void this.gcReplicas().catch(() => undefined)
    this.gcTimer = setInterval(() => {
      void this.gcReplicas().catch(() => undefined)
    }, REPLICA_GC_MS)
  }

  stopLoop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.authTimer) clearInterval(this.authTimer)
    this.authTimer = undefined
    if (this.gcTimer) clearInterval(this.gcTimer)
    this.gcTimer = undefined
    for (const t of this.tailers.values()) t.stop()
    this.terms.closeAll()
  }
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim() !== '')
}

/** Per-workload key for logs/sessions/tailers. Single-workload repos (no
 *  `type`) key on the bare id, so their behaviour and on-disk paths are
 *  unchanged; multi-workload repos get `<id>::<type>`. */
function workloadKey(id: string, type?: string): string {
  return type ? `${id}::${type}` : id
}
