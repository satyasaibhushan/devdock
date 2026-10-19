import type { RunResult } from './exec.js'
import type { Operations } from './operations.js'
import {
  type SandboxView,
  type Sandboxes,
  isExpired,
  sandboxTtl,
  staleMembers,
} from './sandboxes.js'
import type { Repo } from './types.js'

type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>
export interface SandboxControllerStatus {
  holder: string | null
  isLeader: boolean
  lastPollAt: number | null
  lastError: string | null
}
interface ControllerDeps {
  sandboxes: Pick<Sandboxes, 'list' | 'recordHead' | 'build' | 'sleep' | 'expire'>
  operations: Pick<Operations, 'active'>
  runner: Runner
  kubectl: Runner
  instanceId: string
  namespace: () => Promise<string>
  repos: () => Repo[]
  now?: () => number
  timers?: {
    setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
    clearInterval: (timer: ReturnType<typeof setInterval>) => void
  }
}
interface Lock {
  metadata: { resourceVersion: string }
  data: { holder: string; renewedAt: string }
}
const renewalMs = 30_000
const leaseMs = 90_000
const pollMs = 60_000
const hour = 60 * 60_000

export class SandboxController {
  private readonly now: () => number
  private readonly timers: NonNullable<ControllerDeps['timers']>
  private timer?: ReturnType<typeof setInterval>
  private running = false
  private pending?: Promise<void>
  private renewal?: Promise<void>
  private namespace = ''
  private renewedAt = Number.NEGATIVE_INFINITY
  private lastSweepAt?: number
  private readonly observed = new Map<
    string,
    { heads: string; changedAt: number; attempted?: string }
  >()
  private readonly state: SandboxControllerStatus = {
    holder: null,
    isLeader: false,
    lastPollAt: null,
    lastError: null,
  }

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? { setInterval, clearInterval }
  }
  status(): SandboxControllerStatus {
    return { ...this.state, isLeader: this.leader() }
  }
  start(): Promise<void> {
    if (this.running) return this.pending ?? Promise.resolve()
    this.running = true
    if (process.env.DEVDOCK_CONTROLLER === 'off') return Promise.resolve()
    this.timer = this.timers.setInterval(() => void this.tick(), renewalMs)
    return this.tick()
  }
  stop(): void {
    this.running = false
    this.state.isLeader = false
    if (this.timer !== undefined) this.timers.clearInterval(this.timer)
    this.timer = undefined
  }
  private leader(): boolean {
    return this.running && this.state.isLeader && this.now() - this.renewedAt < leaseMs
  }
  private async tick(): Promise<void> {
    if (!this.running || process.env.DEVDOCK_CONTROLLER === 'off') return
    if (!this.renewal) {
      this.state.lastError = null
      this.renewal = this.renew()
        .catch((error: unknown) => {
          this.state.isLeader = false
          this.error(error)
        })
        .finally(() => {
          this.renewal = undefined
        })
    }
    await this.renewal
    if (!this.leader() || this.pending) return
    this.pending = this.run()
      .catch((error: unknown) => this.error(error))
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
  private error(error: unknown): void {
    this.state.lastError = error instanceof Error ? error.message : String(error)
  }
  private async checked(cmd: string, args: string[], cwd?: string): Promise<string> {
    const result = await (cmd === 'kubectl' ? this.deps.kubectl : this.deps.runner)(cmd, args, {
      cwd,
    })
    if (result.code !== 0) throw new Error(result.stderr.trim() || `${cmd} exited ${result.code}`)
    return result.stdout
  }
  private async renew(): Promise<void> {
    const namespace = await this.deps.namespace()
    if (!this.running) return
    if (namespace !== this.namespace) {
      this.namespace = namespace
      this.state.isLeader = false
      this.state.holder = null
      this.state.lastPollAt = null
      this.lastSweepAt = undefined
      this.observed.clear()
    }
    if (!namespace) throw new Error('Controller requires a personal namespace')
    if (!this.deps.instanceId) throw new Error('Controller requires an instance ID')
    const raw = await this.checked('kubectl', [
      'get',
      'configmap',
      'devdock-controller',
      '-n',
      namespace,
      '--ignore-not-found',
      '-o',
      'json',
    ])
    if (!this.running) return
    const now = this.now()
    if (!raw.trim()) {
      await this.checked('kubectl', [
        'create',
        'configmap',
        'devdock-controller',
        '-n',
        namespace,
        `--from-literal=holder=${this.deps.instanceId}`,
        `--from-literal=renewedAt=${now}`,
      ])
    } else {
      const lock = JSON.parse(raw) as Lock
      const renewedAt = Number(lock.data?.renewedAt)
      if (
        !lock.metadata?.resourceVersion ||
        !lock.data?.holder ||
        !lock.data.renewedAt ||
        !Number.isFinite(renewedAt)
      )
        throw new Error('Invalid controller lock')
      this.state.holder = lock.data.holder
      if (lock.data.holder !== this.deps.instanceId && now - renewedAt <= leaseMs) {
        this.state.isLeader = false
        return
      }
      await this.checked('kubectl', [
        'patch',
        'configmap',
        'devdock-controller',
        '-n',
        namespace,
        '--type=json',
        '-p',
        JSON.stringify([
          { op: 'test', path: '/metadata/resourceVersion', value: lock.metadata.resourceVersion },
          { op: 'add', path: '/data/holder', value: this.deps.instanceId },
          { op: 'add', path: '/data/renewedAt', value: String(now) },
        ]),
      ])
    }
    this.state.holder = this.deps.instanceId
    this.renewedAt = now
    this.state.isLeader = this.running
  }
  private async run(): Promise<void> {
    if (!this.leader()) return
    const sandboxes = await this.deps.sandboxes.list()
    const now = this.now()
    const poll = this.state.lastPollAt === null || now - this.state.lastPollAt >= pollMs
    const sweep = this.lastSweepAt === undefined || now - this.lastSweepAt >= hour
    for (const sandbox of sandboxes) {
      if (!this.leader()) return
      if (sandbox.personal || !sandbox.slot) continue
      try {
        let pollFailed = false
        if (poll) {
          try {
            await this.poll(sandbox)
          } catch (error) {
            this.error(error)
            pollFailed = true
          }
        }
        if (!this.leader()) return
        this.schedule(sandbox, sweep, pollFailed)
      } catch (error) {
        this.error(error)
      }
    }
    if (poll) this.state.lastPollAt = now
    if (sweep) this.lastSweepAt = now
  }
  private async poll(sandbox: SandboxView): Promise<void> {
    for (const member of sandbox.members) {
      if (!this.leader()) return
      if (member.merged || member.source.kind === 'worktree') continue
      let sha: string
      let merged = false
      if (member.source.kind === 'pr') {
        const pr = JSON.parse(
          await this.checked('gh', [
            'pr',
            'view',
            String(member.source.number),
            '--repo',
            member.source.repoSlug,
            '--json',
            'headRefOid,state',
          ]),
        ) as { headRefOid: string; state: string }
        if (!['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)) throw new Error('Invalid PR state')
        sha = pr.headRefOid
        merged = pr.state === 'MERGED'
      } else {
        const repo = this.deps.repos().find((r) => r.id === member.repo && !r.parentId)
        if (!repo) throw new Error(`unknown repo: ${member.repo}`)
        const raw = await this.checked(
          'git',
          ['ls-remote', 'origin', member.source.ref],
          repo.root ?? repo.path,
        )
        const shas = [
          ...new Set(
            raw
              .trim()
              .split('\n')
              .map((line) => line.split(/\s+/)[0]),
          ),
        ]
        if (shas.length !== 1) throw new Error('Ambiguous sandbox branch head')
        sha = shas[0] ?? ''
      }
      if (typeof sha !== 'string' || !/^[a-f0-9]{7,64}$/i.test(sha))
        throw new Error('Invalid sandbox head SHA')
      if (!this.leader()) return
      if (sha === member.headSha && merged === (member.merged ?? false)) continue
      await this.deps.sandboxes.recordHead(sandbox.key, member, sha, 'controller', merged, {
        touch: false,
      })
      member.headSha = sha
      member.merged = merged
      if (member.deployedSha !== sha && !merged && member.build.state !== 'building')
        member.build = { state: 'queued' }
      this.observed.delete(sandbox.key)
    }
  }
  private schedule(sandbox: SandboxView, sweep: boolean, pollFailed: boolean): void {
    const now = this.now()
    const heads = JSON.stringify(
      sandbox.members.map((m) => [m.repo, m.workload, m.headSha, m.merged ?? false]),
    )
    let observed = this.observed.get(sandbox.key)
    if (!observed || observed.heads !== heads) {
      observed = { heads, changedAt: now }
      this.observed.set(sandbox.key, observed)
    }
    if (this.deps.operations.active(`sandbox:${sandbox.key}`, '')) return
    if (sweep && isExpired(sandbox, now, sandboxTtl())) {
      this.deps.sandboxes.expire(sandbox.key, 'controller')
      return
    }
    if (sandbox.power === 'awake' && now - sandbox.lastUsedAt > 30 * 60_000) {
      this.deps.sandboxes.sleep(sandbox.key, 'controller')
      return
    }
    if (pollFailed) return
    const stale = staleMembers(sandbox)
    if (!stale.length || stale.some((m) => !m.headSha || m.build.state === 'failed')) return
    if (sandbox.power !== 'awake' && sandbox.power !== 'asleep') return
    const quiet = sandbox.power === 'awake' ? 30_000 : 5 * 60_000
    if (now - observed.changedAt < quiet || observed.attempted === heads) return
    observed.attempted = heads
    this.deps.sandboxes.build(sandbox.key, { actor: 'controller' })
  }
}
