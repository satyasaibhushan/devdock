// service — the one brain (spec §19.1). Composes the core modules and exposes
// transport-free verbs that the daemon (HTTP/WS) and MCP both call.
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AuthManager, type AuthState } from './auth.js'
import { CrashWatch } from './crashWatch.js'
import { type RunResult, run, runStream, spawnStream } from './exec.js'
import { LogHub, LogTailer, type SpawnFn } from './logTailer.js'
import { PtyBroker } from './ptyBroker.js'
import { type ClusterCache, Reconciler, newClusterCache } from './reconciler.js'
import { scanRepos } from './registry.js'
import { StateStore } from './stateStore.js'
import { type SessionState, type StreamRunner, Supervisor, verbLabel } from './supervisor.js'
import type { Repo, RepoState, RepoStatus, TermMode } from './types.js'
import { assembleState, resolveWorkload, scopeRepo, workloadTypes } from './workloads.js'

export interface ServiceOptions {
  roots?: string[]
  stateFile?: string
  reconcileMs?: number
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

/** RFC 1123 label — what Kubernetes accepts as a namespace name. */
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

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
  runner?: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>
  /** Spawner for streaming children (kubectl logs -f, tail -F). Tests inject a fake. */
  streamSpawner?: SpawnFn
  /** Kubernetes OIDC login owner — injectable so tests can pin auth phases. */
  auth?: AuthManager
}

export class Service {
  readonly events = new EventEmitter()
  private readonly opts: Required<ServiceOptions>
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
  private readonly auth: AuthManager

  constructor(opts: ServiceOptions = {}, deps: ServiceDeps = {}) {
    this.opts = {
      roots: opts.roots ?? [],
      stateFile: opts.stateFile ?? join(process.cwd(), '.devdock', 'state.json'),
      reconcileMs: opts.reconcileMs ?? 5000,
    }
    const baseRunner = deps.runner ?? run
    this.auth = deps.auth ?? new AuthManager({ runner: baseRunner })
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
    this.supervisor = deps.supervisor ?? new Supervisor(gatedRunner, streamRunner)
    this.reconciler = deps.reconciler ?? new Reconciler(gatedRunner)
    this.broker = deps.broker ?? new PtyBroker()
    // The service's own kubectl uses are `kubectl config …` (local, no API
    // server, no token) — safe ungated.
    this.runner = baseRunner
    this.streamSpawner = deps.streamSpawner ?? spawnStream
    this.store = new StateStore(this.opts.stateFile)
  }

  /** (Re)discover repos from the filesystem. */
  rescan(): Repo[] {
    const found = scanRepos(this.opts.roots.length ? { roots: this.opts.roots } : {})
    this.repos.clear()
    for (const r of found) this.repos.set(r.id, r)
    return found
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

  /** Verb gate: make sure the kubernetes OIDC token is fresh before devspace
   *  runs. All concurrent verbs share ONE silent refresh / ONE interactive
   *  login (AuthManager single-flights them), so starting five apps while
   *  logged out yields one browser tab and five verbs that proceed once the
   *  sign-in completes — instead of five racing kubelogins on port 8040.
   *  Returns null when auth is fine, or the RunResult the verb should
   *  early-return when login can't be completed. */
  private async ensureAuth(key: string): Promise<RunResult | null> {
    const hub = this.hubFor(key)
    const before = this.auth.snapshot()
    const quiet =
      !before.oidc ||
      (before.tokenExpiresAt !== undefined && before.tokenExpiresAt > Date.now() + 60_000)
    if (!quiet)
      hub.push('! kubernetes login being verified — a Google sign-in may open in your browser')
    const s = await this.auth.ensure(true)
    if (s.phase === 'ok') {
      if (!quiet) hub.push('✓ kubernetes auth ok')
      return null
    }
    const detail = s.message ?? 'kubernetes login required'
    hub.push(`✗ ${detail}`)
    return { code: 1, stdout: '', stderr: `kubernetes auth: ${detail}` }
  }

  async start(id: string, workload?: string): Promise<RunResult> {
    const { repo: scopedRepo, key } = this.scoped(id, workload)
    const denied = await this.ensureAuth(key)
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
    const hub = this.hubFor(key)
    const pipeFile = this.devLogPath(key)
    mkdirSync(dirname(pipeFile), { recursive: true })
    writeFileSync(pipeFile, '') // fresh run, fresh file — old output doesn't linger
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
      const startup = this.store.getStartup(id)
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
    const denied = await this.ensureAuth(key)
    if (denied) return denied
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

  /** Send a one-off command into the repo's dev session (spec §8). */
  async exec(id: string, command: string): Promise<RunResult> {
    return this.supervisor.exec(this.repoOrThrow(id), command)
  }

  /** The configured startup command for a repo, if any. */
  getStartupCommand(id: string): string | undefined {
    this.repoOrThrow(id)
    return this.store.getStartup(id)
  }

  /** Persist (or, for an empty command, clear) the repo's startup command. The
   *  cached state is updated so `/repos` reflects it before the next reconcile. */
  setStartupCommand(id: string, command: string): void {
    this.repoOrThrow(id)
    this.store.setStartup(id, command)
    const state = this.states.get(id)
    if (state) state.startupCommand = this.store.getStartup(id)
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
        cache ?? newClusterCache(),
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
      if (ws.status === 'RUNNING_MANAGED' && pending) {
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
    state.startupCommand = this.store.getStartup(id)
    this.applyState(state)
    return state
  }

  async reconcileAll(): Promise<RepoState[]> {
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

  private ensureTailer(id: string, workload?: string): void {
    const { repo, type, key } = this.scoped(id, workload)
    if (this.tailers.has(key)) return
    // A stale token would make the streamed `kubectl logs -f` spawn its own
    // kubelogin (browser tab included) outside the gate — wait for reconcile
    // to retry once auth is fresh.
    if (!this.auth.kubectlAllowed(['logs'])) return
    const state = this.states.get(id)
    const pods = type ? (state?.workloads.find((w) => w.type === type)?.pods ?? []) : state?.pods
    const pod = pods?.[0]
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

  // ---- kubernetes auth (owned by AuthManager, surfaced over /auth) ----
  authState(): AuthState {
    return this.auth.snapshot()
  }

  /** Kick off an interactive login (the UI button) without holding the HTTP
   *  request open for the whole browser flow — poll /auth for the outcome. */
  authLogin(): AuthState {
    void this.auth.login().catch(() => undefined)
    return this.auth.snapshot()
  }

  authClearCache(): AuthState {
    return this.auth.clearCache()
  }

  // ---- reconcile loop ----
  async startLoop(): Promise<void> {
    // Probe auth before the first reconcile so a stale token gates kubectl
    // from tick one instead of racing kubelogins at boot.
    await this.auth.init().catch(() => undefined)
    this.rescan()
    await this.reconcileAll()
    this.timer = setInterval(() => {
      void this.reconcileAll()
    }, this.opts.reconcileMs)
    this.authTimer = setInterval(() => {
      void this.auth.maintain().catch(() => undefined)
    }, AUTH_MAINTAIN_MS)
  }

  stopLoop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.authTimer) clearInterval(this.authTimer)
    this.authTimer = undefined
    for (const t of this.tailers.values()) t.stop()
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
