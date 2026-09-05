import type { InstanceView, RepoState, WorkloadState } from './api'

export const instanceSymbol = (instance: InstanceView | undefined) =>
  !instance ? '?' : /devbox/i.test(instance.name) ? '◇' : '▣'
export const instanceEndpoint = (instance: InstanceView) => (instance.local ? '' : instance.id)

export function retainOwners(next: InstanceView[], previous: InstanceView[]): InstanceView[] {
  return next.map((instance) => {
    const before = previous.find((item) => item.id === instance.id)
    if (!instance.online) return { ...instance, repos: before?.repos ?? [] }
    return {
      ...instance,
      repos: instance.repos.map((state) => {
        const old = before?.repos.find(
          (r) => r.repo.id === state.repo.id && r.repo.namespace === state.repo.namespace,
        )
        return {
          ...state,
          workloads: state.workloads.map((w) =>
            w.ownershipKnown
              ? w
              : {
                  ...w,
                  ownerInstanceId:
                    w.ownerInstanceId ??
                    old?.workloads.find((o) => o.type === w.type)?.ownerInstanceId,
                },
          ),
        }
      }),
    }
  })
}

/** One row per checkout identity, with each workload bound to its authoritative owner.
 * Changing the preferred machine never transfers a deployment or bypasses a claim.
 */
export function globalRepos(instances: InstanceView[], preferred: string): RepoState[] {
  const ids = new Set(instances.flatMap((instance) => instance.repos.map((r) => r.repo.id)))
  return [...ids].map((id) => {
    const sources = instances.flatMap((instance) => {
      const state = instance.repos.find((r) => r.repo.id === id)
      return state ? [{ instance, state }] : []
    })
    const base = sources.find((source) => source.instance.id === preferred) ?? sources[0]
    if (!base) throw new Error('Repository has no instance')
    const scoped = sources.filter(
      (source) => source.state.repo.namespace === base.state.repo.namespace,
    )
    const workloads = base.state.workloads.map((workload): WorkloadState => {
      const candidates = scoped.flatMap((source) => {
        const value = source.state.workloads.find((w) => w.type === workload.type)
        return value ? [{ ...source, value }] : []
      })
      const owners = [
        ...new Set(
          candidates.flatMap((c) => (c.value.ownerInstanceId ? [c.value.ownerInstanceId] : [])),
        ),
      ]
      const owner = owners[0]
      const source = owner
        ? candidates.find((c) => c.instance.id === owner)
        : (candidates.find((c) => c.value.hasSession) ??
          candidates.find((c) => c.instance.id === preferred) ??
          candidates[0])
      const value = source?.value ?? workload
      const unavailable =
        owners.length > 1 ||
        !source?.instance.online ||
        !candidates.some((c) => c.value.ownershipKnown === true)
      return {
        ...value,
        ownerInstanceId: owner,
        instanceId: owner ?? source?.instance.id,
        unavailable,
        actions: unavailable ? [] : value.actions,
      }
    })
    const primary =
      workloads.find((w) => w.type === base.state.repo.defaultWorkload) ?? workloads[0]
    const detail =
      scoped.find((source) => source.instance.id === primary?.instanceId)?.state ?? base.state
    const priority = [
      'RESTARTING',
      'CRASHED',
      'RUNNING_MANAGED',
      'RUNNING_EXTERNAL',
      'BUILDING',
      'DEPLOYED',
      'STOPPED',
    ]
    const status =
      [...workloads].sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status))[0]
        ?.status ?? detail.status
    return {
      ...detail,
      workloads,
      status,
      actions: primary?.actions ?? [],
      hasSession: workloads.some((w) => w.hasSession),
    }
  })
}

export function workloadTarget(
  repo: RepoState | undefined,
  type?: string,
): WorkloadState | undefined {
  return (
    repo?.workloads.find((w) => w.type === (type ?? repo.repo.defaultWorkload)) ??
    repo?.workloads[0]
  )
}
