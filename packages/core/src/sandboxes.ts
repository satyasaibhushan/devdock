import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import type { RunResult } from './exec.js'
import type { Operations } from './operations.js'
import { replicaCheckoutPath } from './replicas.js'
import type { StateStore } from './stateStore.js'
import type { Supervisor } from './supervisor.js'
import type { Repo } from './types.js'
import { scopeRepo, startupPodTypes } from './workloads.js'

export interface SandboxMemberInput {
  repo: string
  workload: string
  source:
    | { kind: 'pr'; repoSlug: string; number: number; url: string }
    | { kind: 'branch'; ref: string }
}
export interface SandboxMember extends SandboxMemberInput {
  mode: 'built' | 'dev'
  headSha?: string
  deployedSha?: string
  build: {
    state: 'idle' | 'queued' | 'building' | 'failed'
    instanceId?: string
    startedAt?: number
    error?: string
  }
  merged?: boolean
}
export interface ActivityEntry {
  at: number
  actor: string
  action: string
  detail?: string
}
export interface Sandbox {
  key: string
  title?: string
  slot?: string
  state: 'creating' | 'active' | 'expired' | 'failed'
  createdAt: number
  lastUsedAt: number
  members: SandboxMember[]
  activity: ActivityEntry[]
}
export interface SandboxView extends Sandbox {
  power: 'awake' | 'asleep' | 'partial' | 'unknown'
  urls: string[]
  expiresAt: number
  allMerged: boolean
  personal?: boolean
}
export interface SandboxCreate {
  key: string
  title?: string
  members?: SandboxMemberInput[]
  discover?: boolean
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
  force?: boolean
  actor: string
}
export const sandboxTtl = (): number => {
  const hours = Number(process.env.DEVDOCK_SANDBOX_TTL_HOURS ?? 24)
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('Invalid sandbox TTL')
  return hours * 60 * 60 * 1000
}
export function isExpired(sandbox: Sandbox, now: number, ttl: number): boolean {
  return sandbox.slot !== undefined && now - sandbox.lastUsedAt >= ttl
}
export function staleMembers(sandbox: Sandbox): SandboxMember[] {
  return sandbox.members.filter((m) => !m.merged && (!m.deployedSha || m.deployedSha !== m.headSha))
}
export function requireActor(actor: string): void {
  if (typeof actor !== 'string' || !actor.trim()) throw new Error('actor required')
}
const identity = (m: { repo: string; workload: string }) => `${m.repo}:${m.workload}`
const namespacePattern = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>
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
  private active = new Map<string, string>()
  constructor(private readonly deps: SandboxDeps) {}

  private pool(): string[] {
    const slots = [
      ...new Set(
        (process.env.DEVDOCK_SANDBOX_NAMESPACES ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ]
    if (slots.some((s) => !namespacePattern.test(s))) throw new Error('Invalid sandbox namespace')
    return slots
  }
  private get(key: string): Sandbox {
    const record = this.deps.store.getSandbox(key)
    if (!record) throw new Error(`unknown sandbox: ${key}`)
    return record
  }
  private save(s: Sandbox): void {
    this.deps.store.setSandbox(s)
    if (!this.deps.store.health().ok) throw new Error('Cannot persist sandbox state')
    this.deps.emit(structuredClone(s))
  }
  private touch(s: Sandbox, actor: string, action: string, detail?: string): void {
    requireActor(actor)
    s.lastUsedAt = Date.now()
    s.activity = [...s.activity, { at: s.lastUsedAt, actor, action, detail }].slice(-200)
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
      if (!m || typeof m.repo !== 'string' || typeof m.workload !== 'string' || !m.source)
        throw new Error('Invalid sandbox member')
      if (local) this.repo(m)
      if (seen.has(identity(m))) throw new Error('Duplicate sandbox member')
      seen.add(identity(m))
      if (m.source.kind === 'pr') {
        if (
          !/^[\w.-]+\/[\w.-]+$/.test(m.source.repoSlug) ||
          !Number.isSafeInteger(m.source.number) ||
          m.source.number <= 0 ||
          typeof m.source.url !== 'string'
        )
          throw new Error('Invalid PR source')
      } else if (
        m.source.kind !== 'branch' ||
        typeof m.source.ref !== 'string' ||
        !m.source.ref.trim() ||
        m.source.ref.startsWith('-')
      )
        throw new Error('Invalid branch source')
      return { ...structuredClone(m), mode: 'built', build: { state: 'idle' } }
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
      'devdock-sandbox',
      '-n',
      slot,
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
  private async mirror(s: Sandbox, expected?: Lease): Promise<void> {
    const lease = expected ?? (await this.owned(s))
    await this.checked('kubectl', [
      'patch',
      'configmap',
      'devdock-sandbox',
      '-n',
      s.slot as string,
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
    for (const member of s.members) await this.deps.assertAvailable(this.repo(member), slot)
  }
  private async lease(s: Sandbox): Promise<void> {
    const observed = await Promise.all(
      this.pool().map(async (slot) => ({ slot, lease: await this.readLease(slot) })),
    )
    if (observed.some(({ lease }) => lease?.data.key === s.key))
      throw new Error('Sandbox already leased on another instance; recover it first')
    for (const { slot, lease } of observed) {
      if (lease) continue
      await this.available(s, slot)
      const result = await this.deps.kubectl('kubectl', [
        'create',
        'configmap',
        'devdock-sandbox',
        '-n',
        slot,
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
    throw new Error('Sandbox namespace pool full')
  }
  private operation(
    s: Sandbox,
    action: 'create' | 'build' | 'rebuild' | 'expire' | 'update' | 'wake' | 'sleep' | 'delete',
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
            'devdock-sandbox',
            '-n',
            s.slot,
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
        s.state = 'failed'
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
      'devdock-sandbox',
      '-n',
      slot,
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
      for (const m of s.members)
        if (m.build.state === 'building' || m.build.state === 'queued')
          m.build = { state: 'failed', error: 'Build interrupted; retry explicitly' }
      this.save(s)
    }
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
      // Validate sources and local repo/workload identities before exposing a recovered record.
      this.members(members, false)
      this.save({
        key: lease.data.key,
        createdAt: saved?.createdAt ?? now,
        lastUsedAt: saved?.lastUsedAt ?? now,
        title: saved?.title,
        slot,
        state: 'active',
        members: members.map((m) => ({
          ...m,
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
        this.save(s)
      }
    }
  }
  async list(): Promise<SandboxView[]> {
    const views = await Promise.all(this.deps.store.listSandboxes().map((s) => this.view(s)))
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
            source: { kind: 'branch' as const, ref: 'HEAD' },
            mode: 'dev' as const,
            build: { state: 'idle' as const },
          })),
        ),
    }
    return [{ ...(await this.view(personal)), personal: true, expiresAt: 0 }, ...views]
  }
  async status(key: string): Promise<SandboxView> {
    if (!this.deps.store.getSandbox(key) && key === (await this.deps.namespace())) {
      const personal = (await this.list()).find((s) => s.personal)
      if (personal) return personal
    }
    return this.view(this.get(key))
  }
  private async view(s: Sandbox): Promise<SandboxView> {
    let power: SandboxView['power'] = 'asleep'
    let urls: string[] = []
    if (s.slot) {
      try {
        const deployments = JSON.parse(
          await this.checked('kubectl', ['get', 'deployments', '-n', s.slot, '-o', 'json']),
        ) as { items: { metadata: { name: string }; spec?: { replicas?: number } }[] }
        const names = s.members.map((m) => this.repo(m).name)
        const replicas = names.map(
          (name) => deployments.items.find((d) => d.metadata.name === name)?.spec?.replicas,
        )
        const awake = replicas.filter((n) => n !== undefined && n > 0).length
        power =
          awake === names.length && names.length > 0 ? 'awake' : awake > 0 ? 'partial' : 'asleep'
        const ingresses = JSON.parse(
          await this.checked('kubectl', ['get', 'ingresses', '-n', s.slot, '-o', 'json']),
        ) as {
          items: {
            spec?: { rules?: { host?: string; http?: { paths?: { path?: string }[] } }[] }
          }[]
        }
        urls = [
          ...new Set(
            ingresses.items.flatMap((i) =>
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
      } catch {
        power = 'unknown'
      }
    }
    return {
      ...structuredClone(s),
      activity: structuredClone(s.activity.slice(-50)),
      power,
      urls,
      expiresAt: s.lastUsedAt + sandboxTtl(),
      allMerged: s.members.length > 0 && s.members.every((m) => m.merged === true),
    }
  }
  async discover(key: string): Promise<SandboxMemberInput[]> {
    if (!key.trim()) throw new Error('key required')
    const out: SandboxMemberInput[] = []
    for (const repo of this.deps.repos().filter((r) => !r.parentId)) {
      const raw = await this.checked(
        'gh',
        ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,url,headRefName'],
        repo.root ?? repo.path,
      )
      const prs = JSON.parse(raw) as { number: number; url: string; headRefName: string }[]
      for (const pr of prs.filter((p) => p.headRefName.toLowerCase().includes(key.toLowerCase()))) {
        const slug = new URL(pr.url).pathname.split('/').slice(1, 3).join('/')
        out.push({
          repo: repo.id,
          workload: repo.defaultWorkload ?? startupPodTypes(repo)[0] ?? 'api',
          source: { kind: 'pr', repoSlug: slug, number: pr.number, url: pr.url },
        })
      }
    }
    return out
  }
  async create(input: SandboxCreate): Promise<{ operationId: string }> {
    requireActor(input.actor)
    if (typeof input.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.key))
      throw new Error('Invalid sandbox key')
    if (this.deps.store.getSandbox(input.key) || input.key === (await this.deps.namespace()))
      throw new Error('Sandbox already exists')
    const members = this.members([
      ...(input.members ?? []),
      ...(input.discover ? await this.discover(input.key) : []),
    ])
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
      await this.buildMembers(s, { actor: input.actor, force: true })
      if (input.wake) await this.power(s, 1)
    })
  }
  build(key: string, input: SandboxBuild): { operationId: string } {
    const s = this.get(key)
    if (input.repo && !s.members.some((m) => m.repo === input.repo))
      throw new Error('unknown sandbox member')
    return this.operation(s, s.slot ? 'build' : 'rebuild', input.actor, async () => {
      const rebuild = !s.slot
      if (rebuild) await this.lease(s)
      await this.buildMembers(s, {
        ...input,
        repo: rebuild ? undefined : input.repo,
        force: rebuild || input.force,
      })
    })
  }
  async recordHead(
    key: string,
    member: { repo: string; workload: string },
    sha: string,
    actor: string,
    merged?: boolean,
  ): Promise<void> {
    requireActor(actor)
    if (!/^[a-f0-9]{7,64}$/i.test(sha)) throw new Error('Invalid head SHA')
    const s = this.get(key)
    const m = s.members.find((m) => identity(m) === identity(member))
    if (!m) throw new Error('unknown sandbox member')
    m.headSha = sha
    if (merged !== undefined) m.merged = merged
    if (m.deployedSha !== sha && !m.merged && m.build.state !== 'building')
      m.build = { state: 'queued' }
    this.touch(s, actor, 'head', `${identity(m)} ${sha}`)
    if (s.slot) await this.mirror(s)
  }
  async recordExec(key: string, actor: string): Promise<void> {
    requireActor(actor)
    const s = this.get(key)
    this.touch(s, actor, 'exec')
    if (s.slot) await this.mirror(s)
  }
  wake(key: string, actor: string): { operationId: string } {
    const s = this.get(key)
    if (!s.slot) throw new Error('Sandbox expired; rebuild first')
    return this.operation(s, 'wake', actor, async () => {
      await this.buildMembers(s, { actor })
      await this.power(s, 1)
    })
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
      await this.expireRecord(s)
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
        await this.mirror(s)
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
        this.repo(member).name,
        '-n',
        s.slot as string,
        '-p',
        JSON.stringify({ spec: { replicas } }),
      ])
    await this.mirror(s)
  }
  private checkout(s: Sandbox, m: SandboxMemberInput): { root: string; path: string; repo: Repo } {
    const repo = this.repo(m)
    const root = repo.root ?? repo.path
    // Separate worktrees isolate two workloads of the same repo at different source heads.
    const suffix = createHash('sha256').update(`${m.repo}:${m.workload}`).digest('hex').slice(0, 12)
    const path = replicaCheckoutPath(root, `sb-${s.slot}-${suffix}`)
    return { root, path, repo }
  }
  private config(s: Sandbox, m: SandboxMember, path: string): Repo {
    const original = this.repo(m)
    const root = original.root ?? original.path
    const servicePath = resolve(path, relative(root, original.path))
    const sourcePath = resolve(path, relative(root, original.configPath))
    const doc = parseDocument(readFileSync(sourcePath, 'utf8'))
    const chart = m.workload === 'ui' ? 'web' : m.workload
    doc.setIn(
      ['pipelines', 'sandbox-reset', 'run'],
      m.workload === 'api' ? 'create_deployments default' : `purge_deployments ${chart}`,
    )
    const valuesPath = join(dirname(sourcePath), `.devdock-sandbox-${m.workload}-values.yaml`)
    writeFileSync(valuesPath, 'nodeSelector:\n  workload: development\n')
    const profiles = (doc.toJS() as { profiles?: unknown[] }).profiles
    doc.set('profiles', [
      ...(profiles ?? []),
      {
        name: 'sandbox',
        patches: [{ op: 'add', path: `deployments.${chart}.helm.valuesFiles`, value: valuesPath }],
      },
    ])
    const configPath = join(dirname(sourcePath), `.devdock-sandbox-${m.workload}.yaml`)
    writeFileSync(configPath, doc.toString())
    return {
      ...original,
      path: servicePath,
      root: path,
      configPath,
      namespace: s.slot,
      // Supervisor uses DEVSPACE_CONFIG for this generated config, preserving question defaults.
      devspaceTemplateName: original.devspaceTemplateName ?? original.name,
      varDefaults: {
        ...original.varDefaults,
        ENVIRONMENT_NAME: s.slot as string,
        WORKLOAD_TYPE: m.workload,
      },
    }
  }
  private async head(m: SandboxMember, root: string): Promise<string> {
    const remote = m.source.kind === 'pr' ? `https://github.com/${m.source.repoSlug}.git` : 'origin'
    const ref = m.source.kind === 'pr' ? `pull/${m.source.number}/head` : m.source.ref
    await this.checked('git', ['fetch', '--', remote, ref], root)
    const sha = (await this.checked('git', ['rev-parse', 'FETCH_HEAD'], root)).trim()
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error('Cannot resolve sandbox head')
    return sha
  }
  private async buildMembers(s: Sandbox, input: SandboxBuild): Promise<void> {
    await this.owned(s)
    await this.available(s, s.slot as string)
    const view = await this.view(s)
    const cluster = JSON.parse(
      await this.checked('kubectl', ['get', 'deployments', '-n', s.slot as string, '-o', 'json']),
    ) as { items: { metadata: { name: string }; spec?: { replicas?: number } }[] }
    if (view.power === 'unknown') throw new Error('Cannot determine sandbox power')
    for (const m of s.members.filter((m) => !input.repo || m.repo === input.repo)) {
      if (m.merged) continue
      await this.deps.authorize(m.repo)
      const awake =
        (cluster.items.find((d) => d.metadata.name === this.repo(m).name)?.spec?.replicas ?? 0) > 0
      const { root, path } = this.checkout(s, m)
      const observedHead = m.headSha
      const fetched = await this.head(m, root)
      if (m.headSha === observedHead) m.headSha = fetched
      if (!input.force && m.headSha === m.deployedSha) continue
      do {
        if (m.merged) break
        const sha = m.headSha as string
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
        await this.mirror(s, lease)
        try {
          if (existsSync(path))
            await this.checked('git', ['worktree', 'remove', '--force', path], root)
          await this.checked('git', ['worktree', 'add', '--detach', path, sha], root)
          const repo = this.config(s, m, path)
          const sync = await this.deps.supervisor.sandbox(repo, 'sync')
          if (sync.code !== 0) throw new Error(sync.stderr || 'Sandbox env sync failed')
          const deployed = await this.deps.supervisor.sandbox(repo, 'deploy', awake)
          if (deployed.code !== 0) throw new Error(deployed.stderr || 'Sandbox deploy failed')
          m.deployedSha = sha
          m.build = { state: 'idle' }
          if (awake)
            await this.checked('kubectl', [
              'rollout',
              'restart',
              `deployment/${this.repo(m).name}`,
              '-n',
              s.slot as string,
            ])
          const current = await this.owned(s)
          const observed = (JSON.parse(current.data.members) as SandboxMember[]).find(
            (r) => identity(r) === identity(m),
          )
          if (observed?.headSha && observed.headSha !== sha && m.headSha === sha)
            m.headSha = observed.headSha
          if (observed?.merged) m.merged = true
          this.touch(s, input.actor, 'built', `${identity(m)} ${sha}`)
          await this.mirror(s, current)
        } catch (error) {
          m.build = {
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }
          this.save(s)
          await this.mirror(s)
          throw error
        }
      } while (m.headSha !== m.deployedSha)
    }
    s.state = 'active'
    this.save(s)
    await this.mirror(s)
  }
  private async reset(s: Sandbox, m: SandboxMember): Promise<void> {
    await this.owned(s)
    await this.deps.assertAvailable(this.repo(m), s.slot as string)
    await this.deps.authorize(m.repo, false)
    const { root, path } = this.checkout(s, m)
    // Generated configs must never land in the main checkout; a worktree built elsewhere is
    // recreated at HEAD here, and callers remove it after the reset.
    if (!existsSync(path)) await this.checked('git', ['worktree', 'add', '--detach', path], root)
    const repo = this.config(s, m, path)
    const result = await this.deps.supervisor.sandbox(repo, 'reset')
    if (result.code !== 0) throw new Error(result.stderr || 'Sandbox release reset failed')
  }
  private async expireRecord(s: Sandbox): Promise<void> {
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
    await this.checked('kubectl', ['delete', 'configmap', 'devdock-sandbox', '-n', s.slot])
    s.slot = undefined
    s.state = 'expired'
    this.save(s)
  }
}
