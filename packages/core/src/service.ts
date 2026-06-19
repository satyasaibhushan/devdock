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
import { Supervisor, devspaceArgs } from './supervisor.js'
import type { Repo, RepoState, TermMode } from './types.js'
import { assembleState, resolveWorkload, scopeRepo, workloadTypes } from './workloads.js'

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
    hub.push(`$ ${['devspace dev', ...devspaceArgs(repo)].join(' ')}`)
    const r = await this.supervisor.start(repo, pipeFile)
    if (r.code === 0) {
      this.tailDevLog(key, pipeFile)
    } else {
      for (const line of nonEmptyLines(r.stderr)) hub.push(line)
      hub.push(`✗ devspace dev failed to start (exit ${r.code})`)
    }
    await this.reconcileOne(id)
    return r
  }

  async build(id: string, workload?: string): Promise<RunResult> {
    const { repo, key } = this.scoped(id, workload)
    const r = await this.narrate(
      key,
      ['devspace deploy', ...devspaceArgs(repo)].join(' '),
      (onLine) => this.supervisor.build(repo, onLine),
    )
    await this.reconcileOne(id)
    return r
  }

  async stop(id: string, workload?: string): Promise<RunResult> {
    const { repo, key } = this.scoped(id, workload)
    this.tailers.get(key)?.stop()
    this.tailers.delete(key)
    const r = await this.narrate(
      key,
      ['devspace purge', ...devspaceArgs(repo)].join(' '),
      (onLine) => this.supervisor.kill(repo, onLine),
    )
    this.devTails.get(key)?.stop()
    this.devTails.delete(key)
    await this.reconcileOne(id)
    return r
  }

  /** Roll the workload: `kubectl rollout restart deployment/<workload>`. */
  async restart(id: string, workload?: string): Promise<RunResult> {
    const { base, repo, type, key } = this.scoped(id, workload)
    // For a scoped workload the deployment is `<name>-<type>` (repo.name carries
    // the suffix); single-workload repos use the deployment name from the config.
    const deployment = type ? repo.name : base.workload
    if (!deployment) throw new Error(`no workload known for ${id}`)
    const args = ['rollout', 'restart', `deployment/${deployment}`]
    if (repo.namespace) args.push('-n', repo.namespace)
    return this.narrate(key, `kubectl ${args.join(' ')}`, async (onLine) => {
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
  async reconcileOne(id: string, cache?: ClusterCache, sessions?: Set<string>): Promise<RepoState> {
    const repo = this.repoOrThrow(id)
    // One `tmux list-sessions` answers "is each workload's session live?" — the
    // pass shares the set so a 47-repo reconcile isn't 47 has-session calls.
    const live = sessions ?? new Set(await this.supervisor.listSessions())

    const workloads = []
    for (const type of workloadTypes(repo)) {
      const scoped = scopeRepo(repo, type)
      const key = workloadKey(id, type)
      const hasSession = live.has(scoped.session)
      workloads.push(
        await this.reconciler.reconcileWorkload(
          scoped,
          hasSession,
          cache ?? newClusterCache(),
          type ?? repo.defaultWorkload ?? '',
        ),
      )
      if (hasSession && !this.devTails.has(key)) {
        // live dev session without a pane mirror (daemon restarted under it, or
        // started outside devdock) — attach one so its output flows to the logs.
        // pipe-pane -o is a no-op if a pipe already exists.
        const file = this.devLogPath(key)
        mkdirSync(dirname(file), { recursive: true })
        await this.supervisor.pipe(scoped, file)
        this.tailDevLog(key, file)
      } else if (!hasSession && this.devTails.has(key)) {
        this.devTails.get(key)?.stop()
        this.devTails.delete(key)
      }
    }
    const state = assembleState(repo, workloads, Date.now())
    this.applyState(state)
    return state
  }

  async reconcileAll(): Promise<RepoState[]> {
    // Share one cluster snapshot + one session list across the pass — repos in
    // the same namespace reuse a single kubectl query instead of one each.
    const cache = newClusterCache()
    const sessions = new Set(await this.supervisor.listSessions())
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
   * Managed repos attach the devdock tmux session; externally-started
   * deployments (pods but no session) fall back to a `devspace enter` pod shell.
   */
  async openTerminal(id: string, mode: TermMode, cols?: number, rows?: number, workload?: string) {
    const { repo, type } = this.scoped(id, workload)
    if (await this.supervisor.hasSession(repo)) {
      return this.broker.open(repo, mode, cols, rows)
    }
    const state = this.states.get(id)
    const pods = (type ? state?.workloads.find((w) => w.type === type)?.pods : state?.pods) ?? []
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

/** Per-workload key for logs/sessions/tailers. Single-workload repos (no
 *  `type`) key on the bare id, so their behaviour and on-disk paths are
 *  unchanged; multi-workload repos get `<id>::<type>`. */
function workloadKey(id: string, type?: string): string {
  return type ? `${id}::${type}` : id
}
