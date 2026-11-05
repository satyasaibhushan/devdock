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
  if (state.status === 'CRASHED')
    return {
      reason: 'unreachable',
      error: 'Workload is CRASHED and no operation is in flight',
    }
  const canRun =
    state.hasSession ||
    state.pods.some((p) => p.phase !== 'Failed') ||
    state.deployments.some((d) => d.replicas > 0)
  const canObserve = (target.ready || target.http || target.contains) && canRun
  const canChangeStatus =
    target.status &&
    (state.status === 'BUILDING' ||
      state.status === 'RESTARTING' ||
      (target.status === 'RUNNING_EXTERNAL' && canRun && !state.hasSession) ||
      (target.status === 'RUNNING_MANAGED' && state.hasSession))
  if (!canObserve && !canChangeStatus)
    return {
      reason: 'unreachable',
      error: `No operation is in flight to reach the requested condition from ${state.status}`,
    }
}
