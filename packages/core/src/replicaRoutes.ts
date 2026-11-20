import { randomUUID } from 'node:crypto'
import type { StateStore } from './stateStore.js'
import type { run as runCommand } from './exec.js'
import type { PodInfo, ReplicaRouteStatus } from './types.js'

const annotation = 'devdock.dev/replica-route'
const annotationPath = '/metadata/annotations/devdock.dev~1replica-route'

type Selector = Record<string, string>

interface Claim {
  owner: string
  token: string
  original: Selector
  selected?: Selector
}

interface ServiceResource {
  metadata: {
    resourceVersion: string
    annotations?: Record<string, string>
  }
  spec: { type?: string; selector?: Selector }
}

interface Patch {
  op: 'add' | 'replace' | 'remove' | 'test'
  path: string
  value?: unknown
}

export interface ReplicaRoute extends Omit<ReplicaRouteStatus, 'owner'> {
  context: string
  replicaService: string
  token: string
}

type Target = Pick<ReplicaRoute, 'context' | 'namespace' | 'service'>
type Reservation = Omit<ReplicaRoute, 'token' | 'state'>

export class RouteConflict extends Error {}

function selector(value: unknown): value is Selector {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((label) => typeof label === 'string')
  )
}

function sameSelector(a: Selector | undefined, b: Selector): boolean {
  return (
    !!a &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(b).every(([key, value]) => a[key] === value)
  )
}

function claimOf(service: ServiceResource): Claim | undefined {
  const raw = service.metadata.annotations?.[annotation]
  if (raw === undefined) return undefined
  const claim = JSON.parse(raw) as Claim | null
  if (
    !claim ||
    typeof claim.owner !== 'string' ||
    typeof claim.token !== 'string' ||
    !selector(claim.original) ||
    (claim.selected !== undefined && !selector(claim.selected))
  ) {
    throw new Error('Invalid replica route annotation on Kubernetes Service')
  }
  return claim
}

export function publicRoute(owner: string, route: ReplicaRoute): ReplicaRouteStatus {
  const { namespace, service, workload, state, error } = route
  return { owner, namespace, service, workload, state, ...(error ? { error } : {}) }
}

/** Cluster-side ownership and the selector change share a resourceVersion guard.
 * The local record locates the claim after a daemon restart, even before the
 * replica checkout can be materialized. */
export class ReplicaRoutes {
  private readonly running = new Map<string, Promise<void>>()
  private readonly live = new Set<string>()

  constructor(
    private readonly store: StateStore,
    private readonly run: typeof runCommand,
  ) {}

  async reserve(id: string, target: Reservation): Promise<void> {
    const route: ReplicaRoute = { ...target, token: randomUUID(), state: 'pending' }
    this.live.add(route.token)
    try {
      await this.serial(id, async () => {
        const service = await this.read(target)
        const claim = service && claimOf(service)
        if (claim) {
          throw new RouteConflict(
            `Route for ${target.namespace}/${target.service} is owned by replica ${claim.owner}`,
          )
        }
        if (!service || service.spec.type === 'ExternalName' || !selector(service.spec.selector)) {
          throw new Error(
            `Route requires a Service with a pod selector: ${target.namespace}/${target.service}`,
          )
        }
        this.store.updateReplica(id, { route })
        const health = this.store.health()
        if (!health.ok) throw new Error(`Cannot persist replica route: ${health.error}`)
        try {
          await this.patch(
            target,
            service,
            this.setClaim(service, {
              owner: id,
              token: route.token,
              original: service.spec.selector,
            }),
          )
        } catch (error) {
          const current = await this.read(target)
          const holder = current && claimOf(current)
          // A lost kubectl response can follow a successful write.
          if (holder?.token === route.token) return
          if (holder) {
            throw new RouteConflict(
              `Route for ${target.namespace}/${target.service} is owned by replica ${holder.owner}`,
            )
          }
          throw error
        }
      })
    } catch (error) {
      this.live.delete(route.token)
      throw error
    }
  }

  async activate(id: string, route: ReplicaRoute, pods: PodInfo[]): Promise<void> {
    await this.serial(id, async () => {
      const current = this.store.getReplica(id)?.route
      if (
        current?.token !== route.token ||
        !this.live.has(route.token) ||
        current.state !== 'pending'
      )
        return

      const parent = await this.read(route)
      const claim = parent && claimOf(parent)
      if (!parent || claim?.token !== route.token)
        throw new Error('Replica route claim was removed')
      if (claim.selected && sameSelector(parent.spec.selector, claim.selected)) {
        this.store.updateReplica(id, { route: { ...route, state: 'active', error: undefined } })
        return
      }
      if (!sameSelector(parent.spec.selector, claim.original)) {
        throw new Error('Parent Service selector changed while waiting for the replica')
      }

      const target = await this.read({ ...route, service: route.replicaService })
      const selected = target?.spec.selector
      if (target?.spec.type === 'ExternalName' || !selector(selected)) return
      const filter = Object.entries(selected)
        .map(([key, value]) => `${key}=${value}`)
        .join(',')
      const result = await this.run(
        'kubectl',
        [
          'get',
          'pods',
          '-l',
          filter,
          '-n',
          route.namespace,
          '-o',
          'json',
          '--context',
          route.context,
        ],
        { timeoutMs: 10_000 },
      )
      if (result.code !== 0)
        throw new Error(result.stderr.trim() || 'Cannot verify replica Service selector')
      const observed = JSON.parse(result.stdout) as {
        items: {
          metadata: { uid?: string; name: string }
          status?: {
            conditions?: { type: string; status: string }[]
          }
        }[]
      }
      const known = new Map(pods.map((pod) => [pod.name, pod]))
      if (
        !observed.items.length ||
        observed.items.some(({ metadata }) => {
          const pod = known.get(metadata.name)
          return !pod || pod.uid !== metadata.uid
        })
      )
        return
      if (
        !observed.items.some(
          ({ metadata, status }) =>
            known.get(metadata.name)?.ready &&
            status?.conditions?.some(({ type, status }) => type === 'Ready' && status === 'True'),
        )
      )
        return

      await this.patch(route, parent, [
        ...this.setClaim(parent, { ...claim, selected }),
        { op: 'replace', path: '/spec/selector', value: selected },
      ])
      this.store.updateReplica(id, { route: { ...route, state: 'active', error: undefined } })
    })
  }

  /** A restart has no live route tokens. Release its inherited claims before
   * considering new activations and retry unavailable clusters on later passes. */
  async recover(): Promise<void> {
    await Promise.all(
      this.store.listReplicas().map(async ({ id, route }) => {
        if (!route || route.state === 'released' || this.live.has(route.token)) return
        try {
          await this.release(id, route)
        } catch {
          // release records the error and preserves the recovery target.
        }
      }),
    )
  }

  async release(id: string, route: ReplicaRoute): Promise<void> {
    this.live.delete(route.token)
    await this.serial(id, async () => {
      const current = this.store.getReplica(id)?.route
      if (current?.token !== route.token || current.state === 'released') return
      this.store.updateReplica(id, { route: { ...current, state: 'restoring', error: undefined } })
      try {
        const parent = await this.read(current)
        const claim = parent && claimOf(parent)
        if (parent && claim?.token === current.token) {
          const patches: Patch[] = [{ op: 'remove', path: annotationPath }]
          // A Helm update or operator may already have taken over the selector.
          if (claim.selected && sameSelector(parent.spec.selector, claim.selected)) {
            patches.push({ op: 'replace', path: '/spec/selector', value: claim.original })
          }
          await this.patch(current, parent, patches)
        }
        this.store.updateReplica(id, { route: { ...current, state: 'released', error: undefined } })
      } catch (error) {
        this.store.updateReplica(id, {
          route: { ...current, state: 'restoring', error: String(error) },
        })
        throw error
      }
    })
  }

  reportActivationError(id: string, token: string, error: unknown): void {
    const route = this.store.getReplica(id)?.route
    if (route?.token !== token || route.state !== 'pending' || !this.live.has(token)) return
    const message = String(error)
    if (route.error !== message)
      this.store.updateReplica(id, { route: { ...route, error: message } })
  }

  private async serial(id: string, action: () => Promise<void>): Promise<void> {
    const previous = this.running.get(id)
    const next = previous ? previous.catch(() => undefined).then(action) : action()
    this.running.set(id, next)
    try {
      await next
    } finally {
      if (this.running.get(id) === next) this.running.delete(id)
    }
  }

  async status(target: Target, workload: string): Promise<ReplicaRouteStatus | undefined> {
    const service = await this.read(target)
    const claim = service && claimOf(service)
    if (!service || !claim) return undefined
    return {
      owner: claim.owner,
      namespace: target.namespace,
      service: target.service,
      workload,
      state:
        claim.selected && sameSelector(service.spec.selector, claim.selected)
          ? 'active'
          : 'pending',
      ...(!sameSelector(service.spec.selector, claim.selected ?? claim.original)
        ? { error: 'Parent Service selector changed outside DevDock' }
        : {}),
    }
  }

  private async read(target: Target): Promise<ServiceResource | undefined> {
    const result = await this.run(
      'kubectl',
      [
        'get',
        'service',
        target.service,
        '-n',
        target.namespace,
        '--context',
        target.context,
        '--ignore-not-found',
        '-o',
        'json',
      ],
      { timeoutMs: 10_000 },
    )
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cannot read Kubernetes Service')
    if (!result.stdout.trim()) return undefined
    const service = JSON.parse(result.stdout) as ServiceResource
    if (!service.metadata?.resourceVersion || !service.spec)
      throw new Error('Cannot identify Kubernetes Service version')
    return service
  }

  private setClaim(service: ServiceResource, claim: Claim): Patch[] {
    const value = JSON.stringify(claim)
    return [
      service.metadata.annotations
        ? { op: 'add', path: annotationPath, value }
        : { op: 'add', path: '/metadata/annotations', value: { [annotation]: value } },
    ]
  }

  private async patch(target: Target, service: ServiceResource, patches: Patch[]): Promise<void> {
    const patch: Patch[] = [
      { op: 'test', path: '/metadata/resourceVersion', value: service.metadata.resourceVersion },
      ...patches,
    ]
    const result = await this.run(
      'kubectl',
      [
        'patch',
        'service',
        target.service,
        '-n',
        target.namespace,
        '--context',
        target.context,
        '--type=json',
        '-p',
        JSON.stringify(patch),
      ],
      { timeoutMs: 10_000 },
    )
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || 'Cannot update Kubernetes Service route')
  }
}
