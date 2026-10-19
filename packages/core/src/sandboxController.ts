import type { RunResult } from './exec.js'
import type { Operations } from './operations.js'
import { type Sandboxes, isExpired, sandboxTtl } from './sandboxes.js'

type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>
export interface SandboxControllerStatus {
  holder: string | null
  isLeader: boolean
  /** When the leader last swept sandboxes for idle sleep and expiry. */
  lastPollAt: number | null
  lastError: string | null
}
interface ControllerDeps {
  sandboxes: Pick<Sandboxes, 'list' | 'sleep' | 'expire'>
  operations: Pick<Operations, 'active'>
  kubectl: Runner
  instanceId: string
  namespace: () => Promise<string>
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
const hour = 60 * 60_000
const idleMs = 30 * 60_000

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
  private async checked(cmd: string, args: string[]): Promise<string> {
    const result = await this.deps.kubectl(cmd, args)
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
  /** Every tick: sleep sandboxes idle for 30 minutes. Hourly: expire those past their TTL. */
  private async run(): Promise<void> {
    if (!this.leader()) return
    const sandboxes = await this.deps.sandboxes.list()
    const now = this.now()
    const sweep = this.lastSweepAt === undefined || now - this.lastSweepAt >= hour
    for (const sandbox of sandboxes) {
      if (!this.leader()) return
      if (sandbox.personal || !sandbox.slot) continue
      if (this.deps.operations.active(`sandbox:${sandbox.key}`, '')) continue
      try {
        if (sweep && isExpired(sandbox, now, sandboxTtl()))
          this.deps.sandboxes.expire(sandbox.key, 'controller')
        else if (sandbox.power === 'awake' && now - sandbox.lastUsedAt > idleMs)
          this.deps.sandboxes.sleep(sandbox.key, 'controller')
      } catch (error) {
        this.error(error)
      }
    }
    this.state.lastPollAt = now
    if (sweep) this.lastSweepAt = now
  }
}
