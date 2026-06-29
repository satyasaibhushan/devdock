// service — the one brain (spec §19.1). Composes the core modules and exposes
// transport-free verbs that the daemon (HTTP/WS) and MCP both call.
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CrashWatch } from './crashWatch.js'
import { type RunResult, run, spawnStream } from './exec.js'
import { FileTail, LogHub, LogTailer, type SpawnFn } from './logTailer.js'
import { PtyBroker } from './ptyBroker.js'
import { type ClusterCache, Reconciler, newClusterCache } from './reconciler.js'
import { scanRepos } from './registry.js'
import { StateStore } from './stateStore.js'
import { Supervisor, verbLabel } from './supervisor.js'
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

/** Injectable collaborators (defaults are the real implementations). */
export interface ServiceDeps {
  supervisor?: Supervisor
  reconciler?: Reconciler
  broker?: PtyBroker
  runner?: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>
  /** Spawner for streaming children (kubectl logs -f, tail -F). Tests inject a fake. */
  streamSpawner?: SpawnFn
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
  /** One log stream per repo: pod logs + dev-pane output + verb activity. */
  private readonly hubs = new Map<string, LogHub>()
  private readonly tailers = new Map<string, LogTailer>()
  private readonly devTails = new Map<string, FileTail>()
  private readonly watchers = new Map<string, CrashWatch>()
  /** Per-workload status override held during a multi-step verb (restart) so the
   *  reconcile loop can't surface the STOPPED/DEPLOYED states it passes through. */
  private readonly transitions = new Map<string, RepoStatus>()
  /** Workload keys whose configured startup command is queued to run once the
   *  dev session's pod is up. Cleared after it fires (once per start). */
  private readonly pendingStartup = new Map<string, string>()
  private timer?: NodeJS.Timeout

  constructor(opts: ServiceOptions = {}, deps: ServiceDeps = {}) {
    this.opts = {
      roots: opts.roots ?? [],
      stateFile: opts.stateFile ?? join(process.cwd(), '.devdock', 'state.json'),
      reconcileMs: opts.reconcileMs ?? 5000,
    }
    this.supervisor = deps.supervisor ?? new Supervisor(deps.runner)
    this.reconciler = deps.reconciler ?? new Reconciler(deps.runner)
    this.broker = deps.broker ?? new PtyBroker()
    this.runner = deps.runner ?? run
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
    return { base, repo: scopeRepo(base, type), type, key: workloadKey(id, type) }
  }

  // ---- lifecycle verbs (spec §7) ----
  // Every verb narrates into the repo's log hub — the same output you'd see
  // running the devspace command in a terminal streams to the Logs panel live.
  async start(id: string, workload?: string): Promise<RunResult> {
    const { repo, key } = this.scoped(id, workload)
    const hub = this.hubFor(key)
    const pipeFile = this.devLogPath(key)
    mkdirSync(dirname(pipeFile), { recursive: true })
    writeFileSync(pipeFile, '') // fresh run, fresh file — old output doesn't replay
    hub.push(`$ ${verbLabel(repo, 'dev')}`)
    const r = await this.supervisor.start(repo, pipeFile)
    if (r.code === 0) {
      this.tailDevLog(key, pipeFile)
      // Queue the configured startup command to run in the dev session once its
      // pod is ready (handled in reconcile). Only the tmux dev session gets it;
      // `devspace enter` shells are separate PTYs, so they never receive it.
      const startup = this.store.getStartup(id)
      if (startup) this.pendingStartup.set(key, startup)
    } else {
      for (const line of nonEmptyLines(r.stderr)) hub.push(line)
      hub.push(`✗ devspace dev failed to start (exit ${r.code})`)
    }
    await this.reconcileOne(id)
    return r
  }

  async build(id: string, workload?: string): Promise<RunResult> {
    const { repo, key } = this.scoped(id, workload)
    const r = await this.narrate(key, verbLabel(repo, 'deploy'), (onLine) =>
      this.supervisor.build(repo, onLine),
    )
    await this.reconcileOne(id)
    return r
  }

  async stop(id: string, workload?: string): Promise<RunResult> {
    const { repo, key } = this.scoped(id, workload)
    this.tailers.get(key)?.stop()
    this.tailers.delete(key)
    const r = await this.narrate(key, verbLabel(repo, 'purge'), (onLine) =>
      this.supervisor.kill(repo, onLine),
    )
    this.devTails.get(key)?.stop()
    this.devTails.delete(key)
    await this.reconcileOne(id)
    return r
  }

  /** Clear a crashed dev session: drop the replaced dev pod and release the
   *  session lock without purge or rebuild (image/deployment stay as deployed). */
  async clear(id: string, workload?: string): Promise<RunResult> {
    const { repo, key } = this.scoped(id, workload)
    this.tailers.get(key)?.stop()
    this.tailers.delete(key)
    const r = await this.narrate(key, verbLabel(repo, 'reset pods'), (onLine) =>
      this.supervisor.clear(repo, onLine),
    )
    this.devTails.get(key)?.stop()
    this.devTails.delete(key)
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
    sessions?: Map<string, boolean>,
  ): Promise<RepoState> {
    const repo = this.repoOrThrow(id)
    // One `tmux list-panes -a` answers "is each workload's session live/dead?" —
    // the pass shares the map so a 47-repo reconcile is a single tmux call.
    const states = sessions ?? (await this.supervisor.sessionStates())

    const workloads = []
    for (const type of workloadTypes(repo)) {
      const scoped = scopeRepo(repo, type)
      const key = workloadKey(id, type)
      const exists = states.has(scoped.session)
      const sessionDead = states.get(scoped.session) === true
      const hasSession = exists && !sessionDead
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
      if (transition) ws.status = transition
      workloads.push(ws)

      // Once the dev session's pod is up, fire any queued startup command into
      // the session (the initial dev pod) — one shot per start.
      if (ws.status === 'RUNNING_MANAGED' && this.pendingStartup.has(key)) {
        const command = this.pendingStartup.get(key) as string
        this.pendingStartup.delete(key)
        this.scheduleStartup(scoped, key, command)
      }
      if (exists) {
        // The session is present (alive or a dead/crashed shell). Keep its pane
        // mirrored so its output — including the last lines before it died —
        // flows to the logs.
        const file = this.devLogPath(key)
        mkdirSync(dirname(file), { recursive: true })
        if (!sessionDead) {
          // pipe-pane -o is a no-op if already piped; re-asserting it recovers a
          // pipe dropped by a tmux server restart. keepalive backfills sessions
          // started before remain-on-exit was set.
          await this.supervisor.pipe(scoped, file)
          if (!this.devTails.has(key)) await this.supervisor.keepalive(scoped)
        }
        if (!this.devTails.has(key)) this.tailDevLog(key, file)
      } else if (this.devTails.has(key)) {
        this.devTails.get(key)?.stop()
        this.devTails.delete(key)
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

  private watcherFor(id: string): CrashWatch {
    let w = this.watchers.get(id)
    if (!w) {
      w = new CrashWatch(id)
      this.watchers.set(id, w)
    }
    return w
  }

  // ---- logs (spec §12) ----
  /** Recent lines from a workload's hub (pod logs, dev-pane output, verb activity). */
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

  /** Where `tmux pipe-pane` mirrors a workload's `devspace dev` pane. `key` is
   *  the per-workload key (`<id>` or `<id>::<type>`); `::` is unfilesystemy so
   *  it becomes `.`. */
  private devLogPath(key: string): string {
    return join(dirname(this.opts.stateFile), 'logs', `${key.replace('::', '.')}.dev.log`)
  }

  /** (Re)follow the dev-pane mirror file into the workload's hub. */
  private tailDevLog(key: string, file: string): void {
    this.devTails.get(key)?.stop()
    const tail = new FileTail(this.hubFor(key), this.streamSpawner)
    tail.start(file)
    this.devTails.set(key, tail)
  }

  private ensureTailer(id: string, workload?: string): void {
    const { repo, type, key } = this.scoped(id, workload)
    if (this.tailers.has(key)) return
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

  // ---- reconcile loop ----
  async startLoop(): Promise<void> {
    this.rescan()
    await this.reconcileAll()
    this.timer = setInterval(() => {
      void this.reconcileAll()
    }, this.opts.reconcileMs)
  }

  stopLoop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const t of this.tailers.values()) t.stop()
    for (const t of this.devTails.values()) t.stop()
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
