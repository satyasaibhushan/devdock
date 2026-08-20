import type { RepoStatus } from './types.js'

export type LifecycleAction = 'build' | 'build_start' | 'start' | 'restart' | 'destroy'
export type LifecycleStep = 'purge' | 'deploy' | 'dev'

const ACTIONS: Record<RepoStatus, readonly LifecycleAction[]> = {
  STOPPED: ['build', 'build_start'],
  DEPLOYED: ['start', 'restart', 'destroy'],
  RUNNING_MANAGED: ['restart', 'destroy'],
  RUNNING_EXTERNAL: ['restart', 'destroy'],
  CRASHED: ['restart', 'destroy'],
  BUILDING: [],
  RESTARTING: [],
}

const PLANS: Record<LifecycleAction, readonly LifecycleStep[]> = {
  build: ['deploy'],
  build_start: ['deploy', 'dev'],
  start: ['dev'],
  restart: ['purge', 'deploy', 'dev'],
  destroy: ['purge'],
}

export function lifecycleActions(status: RepoStatus): LifecycleAction[] {
  return [...ACTIONS[status]]
}

export function lifecyclePlan(status: RepoStatus, action: LifecycleAction): LifecycleStep[] {
  if (!ACTIONS[status].includes(action)) {
    throw new Error(`${action} is not available while the workload is ${status}`)
  }
  return [...PLANS[action]]
}
