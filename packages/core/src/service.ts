// service — the one brain (spec §19.1). Composes the core modules and exposes
// transport-free verbs that the daemon (HTTP/WS) and MCP both call.
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CrashWatch } from './crashWatch.js'
import { type RunResult, run, spawnStream } from './exec.js'
import { FileTail, LogHub, LogTailer, type SpawnFn } from './logTailer.js'
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

  // ---- lifecycle verbs (spec §7) ----
  // Every verb narrates into the repo's log hub — the same output you'd see
  // running the devspace command in a terminal streams to the Logs panel live.
  async start(id: string): Promise<RunResult> {
    const repo = this.repoOrThrow(id)
    const hub = this.hubFor(id)
    const pipeFile = this.devLogPath(id)
    mkdirSync(dirname(pipeFile), { recursive: true })
    writeFileSync(pipeFile, '') // fresh run, fresh file — old output doesn't replay
    hub.push('$ devspace dev')
    const r = await this.supervisor.start(repo, pipeFile)
    if (r.code === 0) {
      this.tailDevLog(id, pipeFile)
    } else {
      for (const line of nonEmptyLines(r.stderr)) hub.push(line)
      hub.push(`✗ devspace dev failed to start (exit ${r.code})`)
    }
    await this.reconcileOne(id)
    return r
  }

  async build(id: string): Promise<RunResult> {
    const repo = this.repoOrThrow(id)
    const r = await this.narrate(id, 'devspace deploy', (onLine) =>
      this.supervisor.build(repo, onLine),
    )
    await this.reconcileOne(id)
    return r
  }

  async stop(id: string): Promise<RunResult> {
    const repo = this.repoOrThrow(id)
    this.tailers.get(id)?.stop()
    this.tailers.delete(id)
    const r = await this.narrate(id, 'devspace purge', (onLine) =>
      this.supervisor.kill(repo, onLine),
    )
    this.devTails.get(id)?.stop()
    this.devTails.delete(id)
    await this.reconcileOne(id)
    return r
  }

  /** Roll the workload: `kubectl rollout restart deployment/<workload>`. */
  async restart(id: string): Promise<RunResult> {
    const repo = this.repoOrThrow(id)
    if (!repo.workload) throw new Error(`no workload known for ${id}`)
    const args = ['rollout', 'restart', `deployment/${repo.workload}`]
    if (repo.namespace) args.push('-n', repo.namespace)
    return this.narrate(id, `kubectl ${args.join(' ')}`, async (onLine) => {
      const r = await this.runner('kubectl', args)
      for (const line of nonEmptyLines(r.stdout + r.stderr)) onLine(line)
      return r
    })
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

  // ---- reconciliation (spec §6) ----
  async reconcileOne(id: string): Promise<RepoState> {
    const repo = this.repoOrThrow(id)
    const hasSession = await this.supervisor.hasSession(repo)
    const state = await this.reconciler.reconcile(repo, hasSession)
    if (hasSession && !this.devTails.has(id)) {
      // live dev session without a pane mirror (daemon restarted under it, or
      // the session was started outside devdock) — attach one so its output
      // flows to the logs. pipe-pane -o is a no-op if a pipe already exists.
      const file = this.devLogPath(id)
      mkdirSync(dirname(file), { recursive: true })
      await this.supervisor.pipe(repo, file)
      this.tailDevLog(id, file)
    } else if (!hasSession && this.devTails.has(id)) {
      this.devTails.get(id)?.stop()
      this.devTails.delete(id)
    }
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
  /** Recent lines from the repo's hub (pod logs, dev-pane output, verb activity). */
  logs(id: string, tail = 200): string[] {
    this.ensureTailer(id)
    return this.hubFor(id).recent(tail)
  }

  subscribeLogs(id: string, cb: (line: string) => void): () => void {
    this.ensureTailer(id)
    return this.hubFor(id).subscribe(cb)
  }

  private hubFor(id: string): LogHub {
    let hub = this.hubs.get(id)
    if (!hub) {
      hub = new LogHub()
      this.hubs.set(id, hub)
    }
    return hub
  }

  /** Where `tmux pipe-pane` mirrors a repo's `devspace dev` pane. */
  private devLogPath(id: string): string {
    return join(dirname(this.opts.stateFile), 'logs', `${id}.dev.log`)
  }

  /** (Re)follow the dev-pane mirror file into the repo's hub. */
  private tailDevLog(id: string, file: string): void {
    this.devTails.get(id)?.stop()
    const tail = new FileTail(this.hubFor(id), this.streamSpawner)
    tail.start(file)
    this.devTails.set(id, tail)
  }

  private ensureTailer(id: string): void {
    if (this.tailers.has(id)) return
    const repo = this.repos.get(id)
    const pod = this.states.get(id)?.pods[0]
    if (!repo || !pod) return
    const tailer = new LogTailer(this.streamSpawner, this.hubFor(id))
    tailer.start(repo, pod)
    // feed crash detection from new log lines only — the hub's backlog may
    // hold old pod logs and verb output that must not re-trigger alerts.
    const watcher = this.watcherFor(id)
    tailer.hub.subscribe(
      (line) => {
        const e = watcher.observeLog(pod.name, line)
        if (e) this.events.emit('crash', e)
      },
      { replay: false },
    )
    this.tailers.set(id, tailer)
  }

  // ---- terminal (spec §8) ----
  /**
   * Managed repos attach the devdock tmux session; externally-started
   * deployments (pods but no session) fall back to a `devspace enter` pod shell.
   */
  async openTerminal(id: string, mode: TermMode, cols?: number, rows?: number) {
    const repo = this.repoOrThrow(id)
    if (await this.supervisor.hasSession(repo)) {
      return this.broker.open(repo, mode, cols, rows)
    }
    const pods = this.states.get(id)?.pods ?? []
    if (pods.length > 0) {
      return this.broker.openShell(repo, mode, cols, rows, pods[0]?.name)
    }
    throw new Error(`${id} is not running — start it first`)
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
