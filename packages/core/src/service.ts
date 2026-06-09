// service — the one brain (spec §19.1). Composes the core modules and exposes
// transport-free verbs that the daemon (HTTP/WS) and MCP both call.
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { CrashWatch } from './crashWatch.js'
import { type RunResult, run } from './exec.js'
import { LogTailer } from './logTailer.js'
import { PtyBroker } from './ptyBroker.js'
import { Reconciler } from './reconciler.js'
import { scanRepos } from './registry.js'
import { StateStore } from './stateStore.js'
import { Supervisor } from './supervisor.js'
import type { Repo, RepoState, TermMode } from './types.js'

export interface ServiceOptions {
  roots?: string[]
  stateFile?: string
  reconcileMs?: number
}

/** Injectable collaborators (defaults are the real implementations). */
export interface ServiceDeps {
  supervisor?: Supervisor
  reconciler?: Reconciler
  broker?: PtyBroker
  runner?: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>
}

export class Service {
  readonly events = new EventEmitter()
  private readonly opts: Required<ServiceOptions>
  private readonly supervisor: Supervisor
  private readonly reconciler: Reconciler
  private readonly broker: PtyBroker
  private readonly runner: NonNullable<ServiceDeps['runner']>
  private readonly store: StateStore
  private readonly repos = new Map<string, Repo>()
  private readonly states = new Map<string, RepoState>()
  private readonly tailers = new Map<string, LogTailer>()
  private readonly watchers = new Map<string, CrashWatch>()
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

  // ---- lifecycle verbs (spec §7) ----
  async start(id: string): Promise<RunResult> {
    const r = await this.supervisor.start(this.repoOrThrow(id))
    await this.reconcileOne(id)
    return r
  }

  async build(id: string): Promise<RunResult> {
    return this.supervisor.build(this.repoOrThrow(id))
  }

  async stop(id: string): Promise<RunResult> {
    const repo = this.repoOrThrow(id)
    this.tailers.get(id)?.stop()
    this.tailers.delete(id)
    const r = await this.supervisor.kill(repo)
    await this.reconcileOne(id)
    return r
  }

  /** Roll the workload: `kubectl rollout restart deployment/<workload>`. */
  async restart(id: string): Promise<RunResult> {
    const repo = this.repoOrThrow(id)
    if (!repo.workload) throw new Error(`no workload known for ${id}`)
    const args = ['rollout', 'restart', `deployment/${repo.workload}`]
    if (repo.namespace) args.push('-n', repo.namespace)
    return this.runner('kubectl', args)
  }

  /** Send a one-off command into the repo's dev session (spec §8). */
  async exec(id: string, command: string): Promise<RunResult> {
    return this.supervisor.exec(this.repoOrThrow(id), command)
  }

  // ---- reconciliation (spec §6) ----
  async reconcileOne(id: string): Promise<RepoState> {
    const repo = this.repoOrThrow(id)
    const hasSession = await this.supervisor.hasSession(repo)
    const state = await this.reconciler.reconcile(repo, hasSession)
    this.applyState(state)
    return state
  }

  async reconcileAll(): Promise<RepoState[]> {
    const out: RepoState[] = []
    for (const id of this.repos.keys()) out.push(await this.reconcileOne(id))
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
  /** Ensure a tailer is running for the repo's first pod and return recent lines. */
  logs(id: string, tail = 200): string[] {
    return this.ensureTailer(id)?.hub.recent(tail) ?? []
  }

  subscribeLogs(id: string, cb: (line: string) => void): () => void {
    const tailer = this.ensureTailer(id)
    if (!tailer) return () => {}
    return tailer.hub.subscribe(cb)
  }

  private ensureTailer(id: string): LogTailer | undefined {
    const existing = this.tailers.get(id)
    if (existing) return existing
    const repo = this.repos.get(id)
    const pod = this.states.get(id)?.pods[0]
    if (!repo || !pod) return undefined
    const tailer = new LogTailer()
    tailer.start(repo, pod)
    // feed crash detection from the log stream too.
    const watcher = this.watcherFor(id)
    tailer.hub.subscribe((line) => {
      const e = watcher.observeLog(pod.name, line)
      if (e) this.events.emit('crash', e)
    })
    this.tailers.set(id, tailer)
    return tailer
  }

  // ---- terminal (spec §8) ----
  openTerminal(id: string, mode: TermMode, cols?: number, rows?: number) {
    return this.broker.open(this.repoOrThrow(id), mode, cols, rows)
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
  }
}
