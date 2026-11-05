import type { Operation } from './operations.js'
import type { RepoStatus, WorkloadState } from './types.js'

export const WAIT_STATUSES: RepoStatus[] = [
  'STOPPED',
  'DEPLOYED',
  'RUNNING_MANAGED',
  'RUNNING_EXTERNAL',
  'BUILDING',
  'RESTARTING',
  'CRASHED',
]

/** Only reject targets that need a lifecycle action. Pending pods and live
 * sessions can still make progress without a durable operation. */
export function waitBlocked(
  state: WorkloadState | undefined,
  target: { status?: string; ready?: boolean; contains?: string; http?: object },
  operation: Operation | undefined,
  transitioning: boolean,
): { reason: 'operation_failed' | 'unreachable'; error: string; operationId?: string } | undefined {
  if (operation?.state === 'failed' || operation?.state === 'interrupted') {
    return {
      reason: 'operation_failed',
      operationId: operation.id,
      error: operation.logs.at(-1)?.message ?? `Operation ${operation.state}`,
    }
  }
  if (!state || state.unreachable || operation?.state === 'active' || transitioning) return
  const canRun =
    state.pods.some((p) => p.phase !== 'Failed') || state.deployments.some((d) => d.replicas > 0)
  const canObserve =
    (target.ready || target.http || target.contains) &&
    (canRun || (state.hasSession && state.pods.length === 0))
  const canChangeStatus =
    target.status &&
    (state.status === 'BUILDING' ||
      state.status === 'RESTARTING' ||
      (target.status === 'RUNNING_EXTERNAL' && canRun && !state.hasSession) ||
      (target.status === 'RUNNING_MANAGED' && state.hasSession && !state.sessionDead))
  if (state.status === 'CRASHED' && !canObserve && !canChangeStatus)
    return {
      reason: 'unreachable',
      error: 'Workload is CRASHED and no operation is in flight',
    }
  if (!canObserve && !canChangeStatus)
    return {
      reason: 'unreachable',
      error: `No operation is in flight to reach the requested condition from ${state.status}`,
    }
}

/** Count only restarts observed during this wait, and never reject a pod that
 * has already become ready while the caller is watching logs or HTTP. */
export class WaitCrashTracker {
  private readonly pods = new Map<string, { restarts: number; wasReady: boolean }>()

  constructor(state: WorkloadState | undefined) {
    this.observe(state)
  }

  observe(state: WorkloadState | undefined, container?: string): string | undefined {
    if (!state || state.unreachable) return
    let error: string | undefined
    for (const pod of state.pods) {
      for (const c of pod.containers ?? [
        { name: '', restartCount: pod.restartCount, ready: pod.ready, init: false },
      ]) {
        // A failing init container blocks the log container too, so it still counts.
        if (container && c.name !== container && !c.init) continue
        const key = `${pod.name}/${c.name}`
        const progress = this.pods.get(key) ?? {
          restarts: c.restartCount,
          wasReady: false,
        }
        progress.wasReady ||= pod.ready || c.ready
        this.pods.set(key, progress)
        if (pod.crashing && !progress.wasReady && c.restartCount - progress.restarts >= 2)
          error = `Pod ${pod.name} restarted twice during this wait without becoming ready${
            pod.failureReason ? `: ${pod.failureReason}` : ''
          }`
      }
    }
    return error
  }
}
