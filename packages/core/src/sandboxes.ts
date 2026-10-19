import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse, parseDocument } from 'yaml'
import type { RunResult } from './exec.js'
import type { Operations } from './operations.js'
import { replicaCheckoutPath } from './replicas.js'
import {
  type SandboxImage,
  SandboxImageBuilds,
  ecrQuery,
  imageDigest,
  parallelMembers,
  pinSandboxBases,
  sandboxArchitecture,
  sandboxCacheTag,
  sandboxImageKey,
  sandboxImagePipeline,
  sandboxRestart,
} from './sandboxImages.js'
import {
  type SandboxIngress,
  guardSandboxName,
  rewriteSandboxEnv,
  sandboxRouting,
  sandboxSlot,
  sandboxWorkloadName,
} from './sandboxRouting.js'
import type { StateStore } from './stateStore.js'
import type { Supervisor } from './supervisor.js'
import type { Repo } from './types.js'
import { scopeRepo, startupPodTypes } from './workloads.js'

export interface SandboxMemberInput {
  repo: string
  workload: string
  /** Absolute path to an agent worktree of the repo; omitted builds the registered checkout. */
  path?: string
}
/** The PR open for a build's branch when it ran. Display only: nothing compares or acts on it. */
export interface SandboxPr {
  number: number
  url: string
}
export interface SandboxMember extends SandboxMemberInput {
  mode: 'built' | 'dev'
  /** Checkout branch at the last build; absent when HEAD was detached. */
  branch?: string
  pr?: SandboxPr
  deployedSha?: string
  dirtyFiles?: string[]
  image?: string
  build: {
    state: 'idle' | 'queued' | 'building' | 'failed'
    instanceId?: string
    startedAt?: number
    error?: string
  }
}
export interface ActivityEntry {
  at: number
  actor: string
  action: string
  detail?: string
}
export interface SandboxSnapshotMember {
  repo: string
  workload: string
  sha: string
  dirtyFiles: string[]
  image: string
  branch?: string
  pr?: SandboxPr
}
export interface SandboxSnapshot {
  slot?: string
  at: number
  actor: string
  members: SandboxSnapshotMember[]
}
export interface Sandbox {
  key: string
  title?: string
  slot?: string
  retainedSlot?: string
  state: 'creating' | 'active' | 'expired' | 'failed'
  createdAt: number
  lastUsedAt: number
  members: SandboxMember[]
  activity: ActivityEntry[]
  snapshot?: SandboxSnapshot
  expiredAt?: number
  error?: string
}
export type SandboxPower = 'awake' | 'asleep' | 'partial' | 'unknown'
/** The one word a card leads with; power when the record itself says nothing more. */
export type SandboxRibbon = SandboxPower | 'building' | 'failed' | 'expired' | 'expired restorable'
export interface SandboxView extends Sandbox {
  power: SandboxPower
  /** Every member deployment awake with its replicas ready and on the latest template. */
  healthy: boolean
  ribbon: SandboxRibbon
  urls: string[]
  /** The stable per-ticket link served by the daemon; wakes or restores on visit. */
  link: string
  /** Short PR-body block: ribbon, link, live URL, and what each member shows. */
  markdown: string
  expiresAt: number
  personal?: boolean
  /** Personal namespace suffixes with the key holding each slot. */
  pool: { slot: string; key?: string }[]
  /** Least-recently-used asleep sandbox, offered only while the pool is full. */
  evictionCandidate?: string
}
export interface SandboxCreate {
  key: string
  title?: string
  members?: SandboxMemberInput[]
  wake?: boolean
  actor: string
}
export interface SandboxUpdate {
  add?: SandboxMemberInput[]
  remove?: { repo: string; workload: string }[]
  actor: string
}
export interface SandboxBuild {
  repo?: string
  actor: string
}
export const snapshotTtl = (): number => {
  const days = Number(process.env.DEVDOCK_SNAPSHOT_TTL_DAYS ?? 30)
  if (!Number.isFinite(days) || days <= 0) throw new Error('Invalid snapshot TTL')
  return days * 86400000
}
export const sandboxTtl = (): number => {
  const hours = Number(process.env.DEVDOCK_SANDBOX_TTL_HOURS ?? 24)
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('Invalid sandbox TTL')
  return hours * 60 * 60 * 1000
}
export function isExpired(sandbox: Sandbox, now: number, ttl: number): boolean {
  return sandbox.slot !== undefined && now - sandbox.lastUsedAt >= ttl
}
/** A snapshot outlives expiry for this long, so a stable link can restore it. */
export function snapshotRetained(sandbox: Sandbox, now: number): boolean {
  if (!sandbox.snapshot) return false
  if (sandbox.slot) return true
  return now - (sandbox.expiredAt ?? sandbox.snapshot.at) < snapshotTtl()
}
export function sandboxRibbon(sandbox: Sandbox, power: SandboxPower, now: number): SandboxRibbon {
  if (sandbox.state === 'expired')
    return snapshotRetained(sandbox, now) ? 'expired restorable' : 'expired'
  if (sandbox.state === 'failed') return 'failed'
  if (sandbox.members.some((m) => m.build.state === 'building')) return 'building'
  return power
}
/** PR-body block: the stable link, the live URL and the branch and commit each member shows. */
export function sandboxMarkdown(
  sandbox: Sandbox,
  ribbon: SandboxRibbon,
  link: string,
  urls: string[],
): string {
  const lines = (sandbox.snapshot?.members ?? []).map((m) => {
    const branch = m.branch ? `${m.branch} @ ` : ''
    const dirty = m.dirtyFiles.length ? ` (+${m.dirtyFiles.length} uncommitted files)` : ''
    const pr = m.pr ? ` PR #${m.pr.number}` : ''
    return `${m.repo} ${m.workload} ${branch}${m.sha}${dirty}${pr}`
  })
  return [
    `Sandbox ${sandbox.key}: ${ribbon}`,
    `Stable link: ${link}`,
    `Live URL: ${urls.join(', ') || 'unavailable'}`,
    '',
    '```',
    ...(lines.length ? lines : ['no snapshot yet']),
    '```',
  ].join('\n')
}
export function requireActor(actor: string): void {
  if (typeof actor !== 'string' || !actor.trim()) throw new Error('actor required')
}
const identity = (m: { repo: string; workload: string }) => `${m.repo}:${m.workload}`
/** Members saved before checkout-only builds carried a `source`. A worktree one keeps its path;
 *  a PR or branch one has none and builds from the registered checkout. */
function legacyPath(m: SandboxMember): string | undefined {
  const source = (m as { source?: { kind?: unknown; path?: unknown } }).source
  return source?.kind === 'worktree' && typeof source.path === 'string' ? source.path : undefined
}
const namespacePattern = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<RunResult>
interface Lease {
  metadata: { resourceVersion: string }
  data: { key: string; instanceId?: string; members: string; sandbox?: string; operation?: string }
}
interface SandboxDeps {
  store: StateStore
  operations: Operations
  runner: Runner
  kubectl: Runner
  supervisor: Supervisor
  instanceId: string
  repos: () => Repo[]
  namespace: () => Promise<string>
  assertAvailable: (repo: Repo, namespace: string) => Promise<void>
  authorize: (repo: string, build?: boolean) => Promise<void>
  emit: (sandbox: Sandbox | { key: string; deleted: true }) => void
}

/** Sandbox lifecycle owns slot claims and serializes mutations. The controller only schedules it. */
export class Sandboxes {
  private tasks = new Map<string, Promise<void>>()
  private gitTasks = new Map<string, Promise<void>>()
  private mirrors = new Map<string, Promise<void>>()
  private imageBuilds = new SandboxImageBuilds()
  private active = new Map<string, string>()
  constructor(private readonly deps: SandboxDeps) {}

  private pool(): string[] {
    const max = Number(process.env.DEVDOCK_SANDBOX_MAX ?? 5)
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('Invalid sandbox maximum')
    return Array.from({ length: max }, (_, i) => `sb${i + 1}`)
  }
  private async namespace(): Promise<string> {
    const namespace = await this.deps.namespace()
    if (!namespacePattern.test(namespace)) throw new Error('Sandbox requires a personal namespace')
    return namespace
  }
  private name(s: Sandbox, member: SandboxMemberInput): string {
    return sandboxWorkloadName(this.repo(member), member.workload, s.slot as string)
  }

  private get(key: string): Sandbox {
    const record = this.deps.store.getSandbox(key)
    if (!record) throw new Error(`unknown sandbox: ${key}`)
    if (record.slot && !sandboxSlot(record.slot)) {
      record.slot = undefined
      record.state = 'expired'
      record.expiredAt ??= Date.now()
      this.save(record)
    }
    return record
  }
  private save(s: Sandbox): void {
    this.deps.store.setSandbox(s)
    if (!this.deps.store.health().ok) throw new Error('Cannot persist sandbox state')
    this.deps.emit(structuredClone(s))
  }
  private touch(s: Sandbox, actor: string, action: string, detail?: string, touch = true): void {
    requireActor(actor)
    const now = Date.now()
    if (touch) s.lastUsedAt = now
    s.activity = [...s.activity, { at: now, actor, action, detail }].slice(-200)
    this.save(s)
  }
  private repo(m: SandboxMemberInput): Repo {
    const parent = this.deps.repos().find((r) => r.id === m.repo && !r.parentId)
    if (!parent) throw new Error(`unknown repo: ${m.repo}`)
    if (!startupPodTypes(parent).includes(m.workload))
      throw new Error(`unknown workload: ${m.workload}`)
    return parent.members?.length || parent.workloads?.length
      ? scopeRepo(parent, m.workload)
      : parent
  }
  private members(inputs: SandboxMemberInput[], local = true): SandboxMember[] {
    const seen = new Set<string>()
    return inputs.map((m) => {
      if (!m || typeof m.repo !== 'string' || typeof m.workload !== 'string')
        throw new Error('Invalid sandbox member')
      if (m.path !== undefined && (typeof m.path !== 'string' || !isAbsolute(m.path)))
        throw new Error('Worktree path must be absolute')
      if (local) this.repo(m)
      if (seen.has(identity(m))) throw new Error('Duplicate sandbox member')
      seen.add(identity(m))
      return {
        repo: m.repo,
        workload: m.workload,
        ...(m.path === undefined ? {} : { path: m.path }),
        mode: 'built',
        build: { state: 'idle' },
      }
    })
  }
  private async checked(cmd: string, args: string[], cwd?: string): Promise<string> {
    const result = await (cmd === 'kubectl' ? this.deps.kubectl : this.deps.runner)(cmd, args, {
      cwd,
    })
    if (result.code !== 0) throw new Error(result.stderr.trim() || `${cmd} exited ${result.code}`)
    return result.stdout
  }
  private async readLease(slot: string): Promise<Lease | undefined> {
    const raw = await this.checked('kubectl', [
      'get',
      'configmap',
      guardSandboxName(`devdock-sandbox-${slot}`, slot),
      '-n',
      await this.namespace(),
      '--ignore-not-found',
      '-o',
      'json',
    ])
    if (!raw.trim()) return undefined
    const lease = JSON.parse(raw) as Lease
    if (!lease.metadata?.resourceVersion || !lease.data?.key || !lease.data.members)
      throw new Error(`Invalid sandbox lease in ${slot}`)
    return lease
  }
  private async owned(s: Sandbox): Promise<Lease> {
    if (!s.slot) throw new Error('Sandbox has no slot; rebuild first')
    const lease = await this.readLease(s.slot)
    if (!lease || lease.data.key !== s.key) throw new Error('Sandbox slot ownership changed')
    const lock = this.active.get(s.key)
    if (lock && lease.data.operation !== lock)
      throw new Error('Sandbox operation ownership changed')
    return lease
  }
  private async mirror(s: Sandbox): Promise<void> {
    // Saves are synchronous on the shared record. Queue the read/patch pair so
    // parallel members and controller updates cannot race resourceVersion.
    const previous = this.mirrors.get(s.key) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(() => this.writeMirror(s))
    this.mirrors.set(s.key, task)
    try {
      await task
    } finally {
      if (this.mirrors.get(s.key) === task) this.mirrors.delete(s.key)
    }
  }
  private async writeMirror(s: Sandbox): Promise<void> {
    const lease = await this.owned(s)
    await this.checked('kubectl', [
      'patch',
      'configmap',
      guardSandboxName(`devdock-sandbox-${s.slot}`, s.slot as string),
      '-n',
      await this.namespace(),
      '--type=json',
      '-p',
      JSON.stringify([
        { op: 'test', path: '/metadata/resourceVersion', value: lease.metadata.resourceVersion },
        { op: 'test', path: '/data/key', value: s.key },
        { op: 'add', path: '/data/members', value: JSON.stringify(s.members) },
        { op: 'add', path: '/data/sandbox', value: JSON.stringify(s) },
      ]),
    ])
  }
  private async available(s: Sandbox, slot: string): Promise<void> {
    for (const member of s.members)
      await this.deps.assertAvailable(
        {
          ...this.repo(member),
          name: this.name({ ...s, slot }, member),
          session: `devdock-${slot}-${member.repo}-${member.workload}`,
        },
        await this.namespace(),
      )
  }
  private async lease(s: Sandbox, preferred?: string): Promise<void> {
    const observed = await Promise.all(
      this.pool().map(async (slot) => ({ slot, lease: await this.readLease(slot) })),
    )
    if (observed.some(({ lease }) => lease?.data.key === s.key))
      throw new Error('Sandbox already leased on another instance; recover it first')
    for (const { slot, lease } of observed) {
      if (lease || (preferred && slot !== preferred)) continue
      await this.available(s, slot)
      const result = await this.deps.kubectl('kubectl', [
        'create',
        'configmap',
        guardSandboxName(`devdock-sandbox-${slot}`, slot),
        '-n',
        await this.namespace(),
        `--from-literal=key=${s.key}`,
        `--from-literal=instanceId=${this.deps.instanceId}`,
        `--from-literal=operation=${this.active.get(s.key) ?? ''}`,
        `--from-literal=members=${JSON.stringify(s.members)}`,
        `--from-literal=sandbox=${JSON.stringify({ ...s, slot })}`,
      ])
      if (result.code !== 0) {
        if (await this.readLease(slot)) continue
        throw new Error(result.stderr || 'Cannot lease sandbox slot')
      }
      s.slot = slot
      this.save(s)
      return
    }
    if (preferred)
      throw new Error(
        `Snapshot needs slot ${preferred}; it is in use or outside the slot limit. Rebuild to use another slot`,
      )
    throw new Error(`All ${this.pool().length} sandbox slots are in use`)
  }
  private operation(
    s: Sandbox,
    action:
      | 'create'
      | 'build'
      | 'rebuild'
      | 'snapshot'
      | 'expire'
      | 'update'
      | 'wake'
      | 'restore'
      | 'sleep'
      | 'delete',
    actor: string,
    work: () => Promise<void>,
  ): { operationId: string } {
    requireActor(actor)
    if (this.tasks.has(s.key) || this.deps.operations.active(`sandbox:${s.key}`, ''))
      throw new Error('Sandbox operation already active')
    const op = this.deps.operations.create(
      `sandbox:${s.key}`,
      '',
      s.slot ?? '',
      action === 'expire' || action === 'delete' ? 'destroy' : 'build',
    )
    s.error = undefined
    this.touch(s, actor, action)
    const lock = JSON.stringify({ instanceId: this.deps.instanceId, operationId: op.id })
    this.active.set(s.key, lock)
    const task = Promise.resolve()
      .then(async () => {
        if (s.slot) {
          const lease = await this.readLease(s.slot)
          if (!lease || lease.data.key !== s.key) throw new Error('Sandbox slot ownership changed')
          if (lease.data.operation) throw new Error('Sandbox operation active on another instance')
          await this.checked('kubectl', [
            'patch',
            'configmap',
            guardSandboxName(`devdock-sandbox-${s.slot}`, s.slot),
            '-n',
            await this.namespace(),
            '--type=json',
            '-p',
            JSON.stringify([
              {
                op: 'test',
                path: '/metadata/resourceVersion',
                value: lease.metadata.resourceVersion,
              },
              { op: 'add', path: '/data/operation', value: lock },
            ]),
          ])
        }
        await work()
        if (s.slot) {
          const lease = await this.owned(s)
          await this.unlock(s.slot, lease, lock)
        }
      })
      .then(() => {
        this.deps.operations.update(op.id, { state: 'succeeded' }, 'Completed')
      })
      .catch(async (error: unknown) => {
        if (s.slot) {
          const lease = await this.readLease(s.slot).catch(() => undefined)
          if (lease?.data.key === s.key && lease.data.operation === lock)
            await this.unlock(s.slot, lease, lock).catch(() => undefined)
        }
        s.error = error instanceof Error ? error.message : String(error)
        if (s.slot || s.state === 'creating') s.state = 'failed'
        this.save(s)
        this.deps.operations.update(
          op.id,
          { state: 'failed' },
          error instanceof Error ? error.message : String(error),
        )
      })
      .finally(() => {
        this.tasks.delete(s.key)
        this.active.delete(s.key)
      })
    this.tasks.set(s.key, task)
    return { operationId: op.id }
  }
  private async unlock(slot: string, lease: Lease, lock: string): Promise<void> {
    await this.checked('kubectl', [
      'patch',
      'configmap',
      guardSandboxName(`devdock-sandbox-${slot}`, slot),
      '-n',
      await this.namespace(),
      '--type=json',
      '-p',
      JSON.stringify([
        { op: 'test', path: '/metadata/resourceVersion', value: lease.metadata.resourceVersion },
        { op: 'test', path: '/data/operation', value: lock },
        { op: 'add', path: '/data/operation', value: '' },
      ]),
    ])
  }
  async recover(): Promise<void> {
    for (const op of this.deps.operations
      .list()
      .filter((o) => o.repo.startsWith('sandbox:') && o.state === 'active'))
      this.deps.operations.update(op.id, { state: 'interrupted' }, 'Daemon restarted; not replayed')
    for (const s of this.deps.store.listSandboxes()) {
      if (s.slot && !sandboxSlot(s.slot)) {
        s.slot = undefined
        s.state = 'expired'
        s.expiredAt ??= Date.now()
      }
      for (const m of s.members) {
        m.path ??= legacyPath(m)
        if (m.build.state === 'building' || m.build.state === 'queued')
          m.build = { state: 'failed', error: 'Build interrupted; retry explicitly' }
      }
      this.save(s)
    }
    if (!(await this.deps.namespace())) return
    const observed = new Map<string, Lease>()
    for (const slot of this.pool()) {
      const lease = await this.readLease(slot)
      if (lease) observed.set(slot, lease)
      if (!lease) continue
      if (lease.data.operation) {
        const lock = JSON.parse(lease.data.operation) as { instanceId: string }
        if (lock.instanceId === this.deps.instanceId)
          await this.unlock(slot, lease, lease.data.operation)
      }
      if (lease.data.instanceId && lease.data.instanceId !== this.deps.instanceId) continue
      const now = Date.now()
      const saved = lease.data.sandbox ? (JSON.parse(lease.data.sandbox) as Sandbox) : undefined
      const members = JSON.parse(lease.data.members) as SandboxMember[]
      // Validate paths and local repo/workload identities before exposing a recovered record.
      this.members(members, false)
      this.save({
        key: lease.data.key,
        createdAt: saved?.createdAt ?? now,
        lastUsedAt: saved?.lastUsedAt ?? now,
        title: saved?.title,
        snapshot: saved?.snapshot,
        slot,
        state: saved?.state === 'failed' || saved?.state === 'creating' ? 'failed' : 'active',
        members: members.map((m) => ({
          ...m,
          path: m.path ?? legacyPath(m),
          mode: 'built',
          build:
            m.build?.state === 'building' || m.build?.state === 'queued'
              ? { state: 'failed', error: 'Build interrupted' }
              : (m.build ?? { state: 'idle' }),
        })),
        activity: saved?.activity?.slice(-200) ?? [],
      })
    }
    for (const s of this.deps.store.listSandboxes()) {
      if (s.slot && this.pool().includes(s.slot) && observed.get(s.slot)?.data.key !== s.key) {
        s.slot = undefined
        s.state = 'expired'
        s.expiredAt ??= Date.now()
        this.save(s)
      }
    }
  }
  async list(): Promise<SandboxView[]> {
    const pool = await this.poolState()
    const views = await Promise.all(
      this.deps.store.listSandboxes().map((s) => this.view(this.get(s.key), pool)),
    )
    const ns = await this.deps.namespace()
    if (!ns) return views
    const now = Date.now()
    const personal: Sandbox = {
      key: ns,
      slot: ns,
      state: 'active',
      createdAt: now,
      lastUsedAt: now,
      activity: [],
      members: this.deps
        .repos()
        .filter((r) => !r.parentId)
        .flatMap((r) =>
          startupPodTypes(r).map((workload) => ({
            repo: r.id,
            workload,
            mode: 'dev' as const,
            build: { state: 'idle' as const },
          })),
        ),
    }
    return [{ ...(await this.view(personal, pool, true)), personal: true, expiresAt: 0 }, ...views]
  }
  async status(key: string): Promise<SandboxView> {
    if (!this.deps.store.getSandbox(key) && key === (await this.deps.namespace())) {
      const personal = (await this.list()).find((s) => s.personal)
      if (personal) return personal
    }
    return this.view(this.get(key))
  }
  /** One pool read per list, not per sandbox: slot holders and the eviction candidate. */
  private async poolState(): Promise<Pick<SandboxView, 'pool' | 'evictionCandidate'>> {
    const pool = await Promise.all(
      this.pool().map(async (slot) => ({ slot, key: (await this.readLease(slot))?.data.key })),
    )
    const full = pool.length > 0 && pool.every((entry) => entry.key)
    return { pool, evictionCandidate: full ? (await this.evictionCandidate())?.key : undefined }
  }
  private async cluster(
    s: Sandbox,
    personal = false,
  ): Promise<Pick<SandboxView, 'power' | 'healthy' | 'urls'>> {
    if (!s.slot) return { power: 'asleep', healthy: false, urls: [] }
    try {
      const deployments = JSON.parse(
        await this.checked('kubectl', [
          'get',
          'deployments',
          '-n',
          await this.namespace(),
          '-o',
          'json',
        ]),
      ) as {
        items: {
          metadata: { name: string; generation?: number }
          spec?: { replicas?: number }
          status?: { readyReplicas?: number; updatedReplicas?: number; observedGeneration?: number }
        }[]
      }
      const named = s.members.map((m) =>
        deployments.items.find(
          (d) => d.metadata.name === (personal ? this.repo(m).name : this.name(s, m)),
        ),
      )
      const awake = named.filter((d) => (d?.spec?.replicas ?? 0) > 0).length
      const power =
        awake === named.length && named.length > 0 ? 'awake' : awake > 0 ? 'partial' : 'asleep'
      const healthy =
        power === 'awake' &&
        named.every((d) => {
          const want = d?.spec?.replicas ?? 1
          return (
            (d?.status?.readyReplicas ?? 0) >= want &&
            (d?.status?.updatedReplicas ?? 0) >= want &&
            (d?.status?.observedGeneration ?? 0) >= (d?.metadata.generation ?? 0)
          )
        })
      const ingresses = JSON.parse(
        await this.checked('kubectl', [
          'get',
          'ingresses',
          '-n',
          await this.namespace(),
          '-o',
          'json',
        ]),
      ) as {
        items: {
          metadata?: { name?: string }
          spec?: { rules?: { host?: string; http?: { paths?: { path?: string }[] } }[] }
        }[]
      }
      const urls = [
        ...new Set(
          ingresses.items
            .filter((i) =>
              personal
                ? !i.metadata?.name?.split('-').some(sandboxSlot)
                : i.metadata?.name?.split('-').includes(s.slot as string) &&
                  !i.metadata.name.startsWith('devdock-'),
            )
            .flatMap((i) =>
              (i.spec?.rules ?? []).flatMap((r) =>
                r.host
                  ? (r.http?.paths ?? [{ path: '/' }]).map(
                      (p) => `https://${r.host}${p.path ?? '/'}`,
                    )
                  : [],
              ),
            ),
        ),
      ]
      return { power, healthy, urls }
    } catch {
      return { power: 'unknown', healthy: false, urls: [] }
    }
  }
  private async view(
    s: Sandbox,
    pool?: Pick<SandboxView, 'pool' | 'evictionCandidate'>,
    personal = false,
  ): Promise<SandboxView> {
    const now = Date.now()
    if (s.snapshot && !snapshotRetained(s, now)) {
      s.snapshot = undefined
      this.save(s)
    }
    const { power, healthy, urls } = await this.cluster(s, personal)
    const link = `http://127.0.0.1:${process.env.DEVDOCK_PORT ?? 7717}/s/${encodeURIComponent(s.key)}`
    const ribbon = sandboxRibbon(s, power, now)
    return {
      ...structuredClone(s),
      ...(pool ?? (await this.poolState())),
      activity: structuredClone(s.activity.slice(-50)),
      power,
      healthy,
      ribbon,
      urls,
      link,
      markdown: sandboxMarkdown(s, ribbon, link, urls),
      expiresAt: s.lastUsedAt + sandboxTtl(),
    }
  }
  async create(input: SandboxCreate): Promise<{ operationId: string }> {
    requireActor(input.actor)
    if (typeof input.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.key))
      throw new Error('Invalid sandbox key')
    if (this.deps.store.getSandbox(input.key) || input.key === (await this.deps.namespace()))
      throw new Error('Sandbox already exists')
    const members = this.members(input.members ?? [])
    if (!members.length) throw new Error('Sandbox members required')
    const now = Date.now()
    const s: Sandbox = {
      key: input.key,
      title: input.title,
      state: 'creating',
      createdAt: now,
      lastUsedAt: now,
      members,
      activity: [],
    }
    return this.operation(s, 'create', input.actor, async () => {
      await this.lease(s)
      await this.buildMembers(s, { actor: input.actor })
      if (input.wake) await this.power(s, 1)
    })
  }
  build(
    key: string,
    input: SandboxBuild,
    action: 'build' | 'snapshot' = 'build',
  ): { operationId: string } {
    const s = this.get(key)
    if (input.repo && !s.members.some((m) => m.repo === input.repo))
      throw new Error('unknown sandbox member')
    return this.operation(s, s.slot ? action : 'rebuild', input.actor, async () => {
      const rebuild = !s.slot
      if (rebuild) await this.lease(s)
      await this.buildMembers(s, { ...input, repo: rebuild ? undefined : input.repo })
    })
  }
  async recordExec(key: string, actor: string): Promise<void> {
    requireActor(actor)
    const s = this.get(key)
    this.touch(s, actor, 'exec')
    if (s.slot) await this.mirror(s)
  }
  /** Rebuild from the checkouts' current files, uncommitted edits included, and record. */
  snapshot(key: string, input: SandboxBuild): { operationId: string } {
    return this.build(key, input, 'snapshot')
  }
  /** Least-recently-used sandbox that is active, idle, unlocked and fully scaled to zero. */
  private async evictionCandidate(slot?: string): Promise<Sandbox | undefined> {
    const candidates = this.deps.store
      .listSandboxes()
      .filter(
        (s) =>
          s.slot &&
          (!slot || s.slot === slot) &&
          s.state === 'active' &&
          !this.tasks.has(s.key) &&
          !s.members.some((m) => m.build.state !== 'idle'),
      )
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    for (const candidate of candidates) {
      const slot = candidate.slot as string
      const lease = await this.readLease(slot)
      if (lease?.data.key !== candidate.key || lease.data.operation) continue
      const raw = JSON.parse(
        await this.checked('kubectl', [
          'get',
          'deployments',
          '-n',
          await this.namespace(),
          '-o',
          'json',
        ]),
      ) as { items: { metadata: { name: string }; spec?: { replicas?: number } }[] }
      const members = candidate.members.map((m) =>
        raw.items.find((d) => d.metadata.name === this.name(candidate, m)),
      )
      if (members.length && members.every((d) => d?.spec?.replicas === 0)) return candidate
    }
    return undefined
  }
  /** Scale up; an expired sandbox with a retained snapshot is restored into a free slot first.
   *  `evict` lets a full pool expire its eviction candidate; awake or busy sandboxes are never
   *  evicted. */
  wake(key: string, actor: string, options: { evict?: boolean } = {}): { operationId: string } {
    const s = this.get(key)
    if (!s.slot && !snapshotRetained(s, Date.now()))
      throw new Error('Sandbox expired without a snapshot; rebuild first')
    return this.operation(s, s.slot ? 'wake' : 'restore', actor, async () => {
      if (!s.slot) {
        const leases = await Promise.all(this.pool().map((slot) => this.readLease(slot)))
        if (leases.length && leases.every(Boolean)) {
          const candidate = await this.evictionCandidate(s.snapshot?.slot)
          if (!candidate)
            throw new Error(
              `All ${this.pool().length} sandbox slots are in use; no asleep sandbox to evict`,
            )
          if (!options.evict)
            throw new Error(
              `All ${this.pool().length} sandbox slots are in use; evict asleep sandbox ${candidate.key} to restore`,
            )
          const receipt = this.expire(candidate.key, actor)
          await this.tasks.get(candidate.key)
          if (this.deps.operations.get(receipt.operationId).state !== 'succeeded')
            throw new Error(`Cannot evict ${candidate.key}`)
        }
        await this.lease(s, s.snapshot?.slot)
        try {
          await this.restoreImages(s)
        } catch (err) {
          // A half-restored slot would read as wakeable with nothing deployed; hand it back and
          // keep the original expiry so the failed attempt does not extend snapshot retention.
          const expiredAt = s.expiredAt
          await this.expireRecord(s).catch(() => undefined)
          s.expiredAt = expiredAt
          this.save(s)
          throw err
        }
      }
      await this.power(s, 1)
      s.state = 'active'
      this.save(s)
      await this.mirror(s)
    })
  }
  private async restoreImages(s: Sandbox): Promise<void> {
    const snapshot = s.snapshot
    if (!snapshot) throw new Error('Sandbox has no retained snapshot')
    const same =
      s.members.length === snapshot.members.length &&
      s.members.every((m) => snapshot.members.some((saved) => identity(saved) === identity(m)))
    if (!same) throw new Error('Snapshot membership changed; build a new snapshot')
    for (const saved of snapshot.members) {
      const m = s.members.find((m) => identity(m) === identity(saved))
      if (!m) throw new Error('Snapshot member missing')
      await this.deps.authorize(m.repo)
      await this.owned(s)
      await this.available(s, s.slot as string)
      // The config only needs to exist to deploy; HEAD is fine since nothing is built.
      const { root, path } = this.checkout(s, m)
      await this.gitTask(root, async () => {
        if (existsSync(path))
          await this.checked('git', ['worktree', 'remove', '--force', path], root)
        await this.checked('git', ['worktree', 'add', '--detach', path], root)
      })
      const repo = await this.config(s, m, path)
      const sync = await this.deps.supervisor.sandbox(repo, 'sync')
      if (sync.code !== 0) throw new Error(sync.stderr || 'Sandbox env sync failed')
      await this.rewriteEnv(s, repo)
      // ECR lifecycle rules can prune a tag inside the snapshot TTL; deploying it would only
      // leave pods in ImagePullBackOff.
      const at = saved.image.lastIndexOf(':')
      if (
        (await this.queryImage(repo, saved.image.slice(0, at), saved.image.slice(at + 1))) ===
        undefined
      )
        throw new Error(`Snapshot image ${saved.image} is gone; rebuild the sandbox`)
      this.recordedImage(repo, m, saved.image)
      // Recorded images are content-addressed in ECR, so skip-build redeploys exactly what was seen.
      const deployed = await this.deps.supervisor.sandbox(repo, 'deploy', true, true)
      if (deployed.code !== 0) throw new Error(deployed.stderr || 'Sandbox restore failed')
      m.deployedSha = saved.sha
      m.dirtyFiles = [...saved.dirtyFiles]
      m.branch = saved.branch
      m.pr = saved.pr
      m.image = saved.image
      m.build = { state: 'idle' }
    }
    s.expiredAt = undefined
    await this.applyRouting(s)
    await this.mirror(s)
  }
  private recordedImage(repo: Repo, member: SandboxMember, image: string): void {
    const doc = parseDocument(readFileSync(repo.configPath, 'utf8'))
    const profiles = (doc.toJS() as { profiles: { name: string; patches?: unknown[] }[] }).profiles
    const profile = profiles.find((p) => p.name === 'sandbox')
    if (!profile) throw new Error('Missing sandbox profile')
    profile.patches = [
      ...(profile.patches ?? []),
      {
        op: 'replace',
        path: `deployments.${member.workload === 'ui' ? 'web' : member.workload}.helm.values.container.image`,
        value: image,
      },
    ]
    doc.set('profiles', profiles)
    writeFileSync(repo.configPath, doc.toString())
  }
  sleep(key: string, actor: string): { operationId: string } {
    const s = this.get(key)
    return this.operation(s, 'sleep', actor, () => this.power(s, 0))
  }
  expire(key: string, actor: string): { operationId: string } {
    const s = this.get(key)
    return this.operation(s, 'expire', actor, () => this.expireRecord(s))
  }
  delete(key: string, actor: string): { operationId: string } {
    const s = this.get(key)
    return this.operation(s, 'delete', actor, async () => {
      if (
        !s.slot &&
        s.retainedSlot &&
        sandboxSlot(s.retainedSlot) &&
        !(await this.readLease(s.retainedSlot))
      )
        await this.lease(s, s.retainedSlot)
      await this.expireRecord(s, true)
      this.deps.store.removeSandbox(key)
      this.deps.emit({ key, deleted: true })
    })
  }
  update(key: string, input: SandboxUpdate): { operationId: string } {
    requireActor(input.actor)
    const s = this.get(key)
    const added = this.members(input.add ?? [])
    const removed = input.remove ?? []
    if (removed.some((r) => !s.members.some((m) => identity(m) === identity(r))))
      throw new Error('unknown sandbox member')
    const retained = s.members.filter((m) => !removed.some((r) => identity(m) === identity(r)))
    if (added.some((m) => retained.some((r) => identity(m) === identity(r))))
      throw new Error('Duplicate sandbox member')
    return this.operation(s, 'update', input.actor, async () => {
      if (s.slot) {
        await this.owned(s)
        await this.available({ ...s, members: added }, s.slot)
      }
      if (s.slot)
        for (const m of s.members.filter((m) => removed.some((r) => identity(m) === identity(r)))) {
          await this.reset(s, m)
          const { root, path } = this.checkout(s, m)
          if (existsSync(path))
            await this.checked('git', ['worktree', 'remove', '--force', path], root)
        }
      s.members = [...retained, ...added]
      this.save(s)
      if (s.slot) {
        await this.available(s, s.slot)
        await this.applyRouting(s)
        await this.mirror(s)
        // A member added to a leased slot has no release yet; build it so the add is usable.
        if (added.length > 0) await this.buildMembers(s, { actor: input.actor }, added)
      }
    })
  }
  private async power(s: Sandbox, replicas: number): Promise<void> {
    await this.owned(s)
    await this.available(s, s.slot as string)
    for (const member of s.members)
      await this.checked('kubectl', [
        'patch',
        'deployment',
        this.name(s, member),
        '-n',
        await this.namespace(),
        '-p',
        JSON.stringify({ spec: { replicas } }),
      ])
    await this.mirror(s)
  }
  private checkout(s: Sandbox, m: SandboxMemberInput): { root: string; path: string; repo: Repo } {
    const repo = this.repo(m)
    const root = repo.root ?? repo.path
    // Separate worktrees isolate two workloads of the same repo built from different checkouts.
    const suffix = createHash('sha256').update(`${m.repo}:${m.workload}`).digest('hex').slice(0, 12)
    const path = replicaCheckoutPath(root, `sb-${s.slot}-${suffix}`)
    return { root, path, repo }
  }
  private async config(s: Sandbox, m: SandboxMember, path: string): Promise<Repo> {
    const original = this.repo(m)
    const root = original.root ?? original.path
    const servicePath = resolve(path, relative(root, original.path))
    const sourcePath = resolve(path, relative(root, original.configPath))
    const doc = parseDocument(readFileSync(sourcePath, 'utf8'))
    const chart = m.workload === 'ui' ? 'web' : m.workload
    const namespace = await this.namespace()
    const routing = await this.routing(s)
    const personalHosts = this.memberHosts(await this.ingresses(), original.name)
    const host = personalHosts[0] ? routing.hosts.get(personalHosts[0]) : undefined
    if ((m.workload === 'api' || m.workload === 'ui') && !host)
      throw new Error(`No personal ingress for ${original.name}`)
    doc.setIn(['pipelines', 'sandbox-image', 'run'], sandboxImagePipeline)
    doc.setIn(
      ['pipelines', 'sandbox-architecture', 'run'],
      `architecture=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}') || exit 1
echo "SANDBOX_ARCH=$architecture"`,
    )
    for (const variable of ['SANDBOX_REGISTRY', 'SANDBOX_REPOSITORY', 'SANDBOX_TAG'])
      doc.setIn(['vars', variable], '')
    doc.setIn(['pipelines', 'sandbox-reset', 'run'], `purge_deployments ${chart}`)
    const valuesPath = join(dirname(sourcePath), `.devdock-sandbox-${m.workload}-values.yaml`)
    writeFileSync(valuesPath, 'nodeSelector:\n  workload: development\n')
    const profiles = (doc.toJS() as { profiles?: unknown[] }).profiles
    doc.set('profiles', [
      ...(profiles ?? []),
      {
        name: 'sandbox',
        patches: [
          { op: 'add', path: `deployments.${chart}.helm.valuesFiles`, value: valuesPath },
          { op: 'replace', path: `deployments.${chart}.helm.releaseName`, value: this.name(s, m) },
          { op: 'replace', path: `deployments.${chart}.helm.values.name`, value: this.name(s, m) },
          { op: 'replace', path: 'pullSecrets', value: {} },
          {
            op: 'replace',
            path: 'pipelines.deploy.run',
            value: `docker_login_to_ecr\nbuild_images --all\ncreate_deployments ${chart}`,
          },
        ],
      },
    ])
    const configPath = join(dirname(sourcePath), `.devdock-sandbox-${m.workload}.yaml`)
    writeFileSync(configPath, doc.toString())
    return {
      ...original,
      name: this.name(s, m),
      path: servicePath,
      root: path,
      configPath,
      namespace,
      // Supervisor uses DEVSPACE_CONFIG for this generated config, preserving question defaults.
      devspaceTemplateName: original.devspaceTemplateName ?? original.name,
      varDefaults: {
        ...original.varDefaults,
        ENVIRONMENT_NAME: namespace,
        WORKLOAD_NAME: this.name(s, m),
        ...(host ? { INGRESS_HOSTNAME: host } : {}),
        WORKLOAD_TYPE: m.workload,
      },
    }
  }
  /** The checkout a member builds from: its agent worktree, else the registered repo checkout. */
  private source(m: SandboxMember, root: string): string {
    if (m.path === undefined) return root
    const config = relative(root, this.repo(m).configPath)
    if (!existsSync(resolve(m.path, config))) throw new Error(`Worktree ${m.path} has no ${config}`)
    return m.path
  }
  private async sha(cwd: string): Promise<string> {
    const sha = (await this.checked('git', ['rev-parse', 'HEAD'], cwd)).trim()
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error(`Cannot resolve HEAD in ${cwd}`)
    return sha
  }
  /** Display only, so a detached HEAD or a git hiccup leaves the branch out instead of failing. */
  private async branch(cwd: string): Promise<string | undefined> {
    const result = await this.deps.runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    const branch = result.stdout.trim()
    return result.code === 0 && branch && branch !== 'HEAD' ? branch : undefined
  }
  /** The PR for the checkout's branch, if gh finds one. gh may be missing, signed out, slow or
   *  find nothing; all of that means no PR, never a failed or stalled build. */
  private async pr(cwd: string): Promise<SandboxPr | undefined> {
    try {
      const result = await this.deps.runner('gh', ['pr', 'view', '--json', 'number,url'], {
        cwd,
        timeoutMs: 15_000,
      })
      if (result.code !== 0) return undefined
      const pr = JSON.parse(result.stdout) as { number?: unknown; url?: unknown }
      if (typeof pr.number !== 'number' || !Number.isSafeInteger(pr.number) || pr.number <= 0)
        return undefined
      return typeof pr.url === 'string' ? { number: pr.number, url: pr.url } : undefined
    } catch {
      return undefined
    }
  }
  private async gitTask<T>(root: string, work: () => Promise<T>): Promise<T> {
    const previous = this.gitTasks.get(root) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(work)
    const settled = task.then(
      () => undefined,
      () => undefined,
    )
    this.gitTasks.set(root, settled)
    try {
      return await task
    } finally {
      if (this.gitTasks.get(root) === settled) this.gitTasks.delete(root)
    }
  }

  private async buildMembers(
    s: Sandbox,
    input: SandboxBuild,
    targets?: SandboxMember[],
  ): Promise<void> {
    await this.owned(s)
    await this.available(s, s.slot as string)
    const { power } = await this.cluster(s)
    const cluster = JSON.parse(
      await this.checked('kubectl', [
        'get',
        'deployments',
        '-n',
        await this.namespace(),
        '-o',
        'json',
      ]),
    ) as {
      items: {
        metadata: { name: string }
        spec?: { replicas?: number; template?: { spec?: { containers?: { image?: string }[] } } }
      }[]
    }
    if (power === 'unknown') throw new Error('Cannot determine sandbox power')
    await parallelMembers(
      targets ?? s.members.filter((m) => !input.repo || m.repo === input.repo),
      async (m) => {
        try {
          await this.deps.authorize(m.repo)
          const deployment = cluster.items.find((d) => d.metadata.name === this.name(s, m))
          const awake = (deployment?.spec?.replicas ?? 0) > 0
          const previous = deployment?.spec?.template?.spec?.containers?.[0]?.image
          const { root, path } = this.checkout(s, m)
          const source = this.source(m, root)
          const lease = await this.owned(s)
          const remoteMembers = JSON.parse(lease.data.members) as SandboxMember[]
          if (
            remoteMembers.some(
              (r) =>
                identity(r) === identity(m) &&
                r.build.state === 'building' &&
                r.build.instanceId !== this.deps.instanceId,
            )
          )
            throw new Error('Member is building on another instance')
          m.build = { state: 'building', instanceId: this.deps.instanceId, startedAt: Date.now() }
          this.save(s)
          await this.mirror(s)
          // Every build bakes the checkout's current files, uncommitted edits included, from a
          // devdock-owned copy: generated configs never land in the agent's or the user's tree.
          const buildPath = mkdtempSync(`${path}-build-`)
          try {
            const sha = await this.sha(source)
            const dirtyFiles = await this.copyWorktree(source, buildPath)
            const branch = await this.branch(source)
            const pr = branch ? await this.pr(source) : undefined
            const repo = await this.config(s, m, buildPath)
            const sync = await this.deps.supervisor.sandbox(repo, 'sync')
            if (sync.code !== 0) throw new Error(sync.stderr || 'Sandbox env sync failed')
            await this.rewriteEnv(s, repo)
            const image = await this.prepareImage(repo, m)
            await this.imageBuilds.deploy(
              image,
              async () =>
                (await this.queryImage(
                  repo,
                  image.slice(0, image.lastIndexOf(':')),
                  image.slice(image.lastIndexOf(':') + 1),
                )) !== undefined,
              async (skip) => {
                await this.owned(s)
                const deployed = await this.deps.supervisor.sandbox(repo, 'deploy', awake, skip)
                if (deployed.code !== 0) throw new Error(deployed.stderr || 'Sandbox deploy failed')
              },
            )
            m.image = image
            m.dirtyFiles = dirtyFiles
            m.deployedSha = sha
            m.branch = branch
            m.pr = pr
            m.build = { state: 'idle' }
            if (sandboxRestart(awake, previous, image))
              await this.checked('kubectl', [
                'rollout',
                'restart',
                `deployment/${this.name(s, m)}`,
                '-n',
                await this.namespace(),
              ])
            this.touch(s, input.actor, 'built', `${identity(m)} ${sha}`)
            await this.mirror(s)
          } finally {
            rmSync(buildPath, { recursive: true, force: true })
          }
        } catch (error) {
          m.build = {
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }
          this.save(s)
          await this.mirror(s)
          throw new Error(`${identity(m)}: ${m.build.error}`, { cause: error })
        }
      },
    )
    await this.applyRouting(s)
    s.state = 'active'
    // Every member deployed from a known image: that is the snapshot a stable link restores.
    const complete =
      s.members.length > 0 &&
      s.members.every((m) => m.image && m.deployedSha && m.build.state === 'idle')
    if (complete) {
      s.snapshot = {
        slot: s.slot,
        at: Date.now(),
        actor: input.actor,
        members: s.members.map((m) => ({
          repo: m.repo,
          workload: m.workload,
          sha: m.deployedSha as string,
          dirtyFiles: m.dirtyFiles ?? [],
          image: m.image as string,
          branch: m.branch,
          pr: m.pr,
        })),
      }
      s.expiredAt = undefined
    }
    this.save(s)
    await this.mirror(s)
  }
  /** Copy tracked and untracked non-ignored files (deleted ones excluded) into a build dir and
   *  return the paths that differ from HEAD. */
  private async copyWorktree(source: string, destination: string): Promise<string[]> {
    const listed = await this.checked(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z'],
      source,
    )
    for (const file of new Set(listed.split('\0').filter(Boolean))) {
      const target = resolve(destination, file)
      if (isAbsolute(file) || relative(destination, target).startsWith('..'))
        throw new Error('Invalid worktree file path')
      const from = join(source, file)
      if (!existsSync(from)) continue
      const stat = lstatSync(from)
      // ls-files lists a submodule as its directory; its files would be missing from the image.
      if (stat.isDirectory())
        throw new Error(`Submodules are not supported in sandbox builds: ${file}`)
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new Error(`Unsupported worktree entry: ${file}`)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(from, target, { dereference: false })
    }
    const changed = await this.checked('git', ['diff', 'HEAD', '--name-only', '-z'], source)
    const untracked = await this.checked(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      source,
    )
    return [...new Set(`${changed}${untracked}`.split('\0').filter(Boolean))].sort()
  }
  private async queryImage(repo: Repo, image: string, tag: string): Promise<string | undefined> {
    const result = await this.deps.supervisor.sandbox(
      {
        ...repo,
        varDefaults: { ...repo.varDefaults, ...ecrQuery(image, tag) },
      },
      'image',
    )
    if (result.code !== 0) throw new Error(`Sandbox ECR lookup failed for ${image}:${tag}`)
    try {
      return imageDigest(result.stdout)
    } catch {
      throw new Error(`Sandbox ECR lookup failed for ${image}:${tag}: invalid response`)
    }
  }
  private async prepareImage(repo: Repo, member: SandboxMember): Promise<string> {
    const printed = await this.deps.supervisor.sandbox(repo, 'print')
    if (printed.code !== 0) throw new Error(printed.stderr || 'Cannot resolve sandbox build config')
    const effective = parse(printed.stdout) as { images?: Record<string, SandboxImage> }
    if (!effective?.images?.app || Object.keys(effective.images).length !== 1)
      throw new Error('Sandbox requires exactly one app image')
    const image = effective.images.app
    if (typeof image.image !== 'string') throw new Error('Invalid sandbox image repository')
    let architecture: string | undefined
    // Preserve the printed builder. Registry cache exports require BuildKit.
    if (image.buildKit) {
      const cache = `${image.image}:${sandboxCacheTag(member.repo, member.workload)}`
      const buildArgs = image.buildKit.args ?? []
      image.buildKit = {
        ...image.buildKit,
        args: [
          ...(buildArgs.some((a) => a === '--platform' || a.startsWith('--platform='))
            ? []
            : ['--platform=linux/amd64']),
          ...buildArgs.map((arg, i) => {
            if (
              !/^--cache-(?:to|from)(?:=|$)/.test(arg) &&
              !/^--cache-(?:to|from)$/.test(buildArgs[i - 1] ?? '')
            )
              return arg
            return arg.replace(/\bref=[^,]+/, `ref=${cache}`)
          }),
        ],
      }
    } else {
      const result = await this.deps.supervisor.sandbox(repo, 'architecture')
      if (result.code !== 0) throw new Error('Cannot determine sandbox Docker builder architecture')
      architecture = sandboxArchitecture(result.stdout)
    }
    const dockerfile = resolve(repo.path, image.dockerfile ?? 'Dockerfile')
    const checkout = realpathSync(repo.root ?? repo.path)
    for (const path of [dockerfile, resolve(repo.path, image.context ?? '.')]) {
      const inside = relative(checkout, realpathSync(path))
      if (inside === '..' || inside.startsWith('../') || isAbsolute(inside))
        throw new Error('Sandbox build inputs must stay inside the detached checkout')
    }
    writeFileSync(
      dockerfile,
      await pinSandboxBases(readFileSync(dockerfile, 'utf8'), image.buildArgs ?? {}, (base, tag) =>
        this.queryImage(repo, base, tag),
      ),
    )
    const slot = repo.varDefaults?.WORKLOAD_NAME?.split('-').find(sandboxSlot)
    if (!slot) throw new Error('Missing sandbox image slot')
    const tag = `${await sandboxImageKey(image, repo.path, architecture)}-${slot}`
    image.tags = [`${tag}-persistent`]
    repo.varDefaults = { ...repo.varDefaults, IMAGE_TAG: tag }
    const doc = parseDocument(readFileSync(repo.configPath, 'utf8'))
    const list = doc.toJS() as { profiles: { name: string; patches?: unknown[] }[] }
    const profile = list.profiles.find((p) => p.name === 'sandbox')
    if (!profile) throw new Error('Missing sandbox profile')
    profile.patches = [
      ...(profile.patches ?? []),
      { op: 'replace', path: 'images.app', value: image },
      {
        op: 'replace',
        path: `deployments.${member.workload === 'ui' ? 'web' : member.workload}.helm.values.container.image`,
        value: `${image.image}:${tag}-persistent`,
      },
    ]
    doc.set('profiles', list.profiles)
    writeFileSync(repo.configPath, doc.toString())
    return `${image.image}:${tag}-persistent`
  }
  private async ingresses(): Promise<SandboxIngress[]> {
    return (
      JSON.parse(
        await this.checked('kubectl', [
          'get',
          'ingresses',
          '-n',
          await this.namespace(),
          '-o',
          'json',
        ]),
      ) as { items: SandboxIngress[] }
    ).items
  }
  private memberHosts(ingresses: SandboxIngress[], name: string): string[] {
    return ingresses
      .filter((i) => !i.metadata?.name?.split('-').some(sandboxSlot))
      .flatMap((i) =>
        (i.spec?.rules ?? []).flatMap((r) =>
          r.host && r.http?.paths.some((p) => p.backend.service?.name === name) ? [r.host] : [],
        ),
      )
  }
  private async routing(s: Sandbox) {
    const services = new Map(s.members.map((m) => [this.repo(m).name, this.name(s, m)]))
    return {
      ...sandboxRouting(
        (await this.ingresses()).filter((i) => !i.metadata?.name?.split('-').some(sandboxSlot)),
        await this.namespace(),
        s.slot as string,
        services,
      ),
      services,
    }
  }
  private async rewriteEnv(s: Sandbox, repo: Repo): Promise<void> {
    const { services, hosts } = await this.routing(s)
    const path = join(repo.path, '.env')
    if (!existsSync(path) || !lstatSync(path).isFile())
      throw new Error('Sandbox sync-env must produce a regular .env file')
    writeFileSync(
      path,
      rewriteSandboxEnv(readFileSync(path, 'utf8'), await this.namespace(), services, hosts),
    )
  }
  private async deleteRouting(slot: string): Promise<void> {
    for (const ingress of await this.ingresses()) {
      const name = ingress.metadata?.name
      if (name?.startsWith(`devdock-${slot}-route-`))
        await this.checked('kubectl', [
          'delete',
          'ingress',
          guardSandboxName(name, slot),
          '-n',
          await this.namespace(),
          '--ignore-not-found',
        ])
    }
  }
  private async applyRouting(s: Sandbox): Promise<void> {
    const slot = s.slot as string
    const routing = await this.routing(s)
    await this.deleteRouting(slot)
    if (!routing.hosts.size) return
    const dir = mkdtempSync(
      join(dirname(this.repo(s.members[0] as SandboxMember).path), '.devdock-routing-'),
    )
    try {
      for (const ingress of [routing.tls, ...routing.fallback]) {
        guardSandboxName(ingress.metadata.name, slot)
        const path = join(dir, `${ingress.metadata.name}.json`)
        writeFileSync(path, JSON.stringify(ingress))
        await this.checked('kubectl', ['apply', '-n', await this.namespace(), '-f', path])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  private async reset(s: Sandbox, m: SandboxMember): Promise<void> {
    await this.owned(s)
    await this.deps.authorize(m.repo, false)
    await this.checked('helm', [
      'uninstall',
      this.name(s, m),
      '-n',
      await this.namespace(),
      '--ignore-not-found',
    ])
    // DevSpace keeps a remote cache secret per config name; the slot name would otherwise outlive the sandbox.
    await this.checked('kubectl', [
      'delete',
      'secret',
      guardSandboxName(`devspace-cache-${this.name(s, m)}`, s.slot as string),
      '-n',
      await this.namespace(),
      '--ignore-not-found',
    ])
  }

  private async expireRecord(s: Sandbox, deleteTls = false): Promise<void> {
    if (!s.slot) {
      s.state = 'expired'
      this.save(s)
      return
    }
    for (const m of s.members) await this.reset(s, m)
    for (const m of s.members) {
      const { root, path } = this.checkout(s, m)
      if (existsSync(path)) await this.checked('git', ['worktree', 'remove', '--force', path], root)
    }
    await this.owned(s)
    await this.deleteRouting(s.slot)
    if (deleteTls)
      for (const kind of ['ingress', 'secret'])
        await this.checked('kubectl', [
          'delete',
          kind,
          guardSandboxName(`devdock-${s.slot}-tls`, s.slot),
          '-n',
          await this.namespace(),
          '--ignore-not-found',
        ])
    await this.checked('kubectl', [
      'delete',
      'configmap',
      guardSandboxName(`devdock-sandbox-${s.slot}`, s.slot),
      '-n',
      await this.namespace(),
    ])
    s.retainedSlot = s.slot
    s.slot = undefined
    s.state = 'expired'
    s.expiredAt = Date.now()
    this.save(s)
  }
}
