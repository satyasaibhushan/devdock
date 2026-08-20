import { describe, expect, it } from 'vitest'
import { lifecycleActions, lifecyclePlan } from './lifecycle.js'

describe('workload lifecycle', () => {
  it('offers build or build + start when nothing is deployed', () => {
    expect(lifecycleActions('STOPPED')).toEqual(['build', 'build_start'])
    expect(lifecyclePlan('STOPPED', 'build')).toEqual(['deploy'])
    expect(lifecyclePlan('STOPPED', 'build_start')).toEqual(['deploy', 'dev'])
  })

  it('offers start, restart, or destroy for a deployed workload', () => {
    expect(lifecycleActions('DEPLOYED')).toEqual(['start', 'restart', 'destroy'])
    expect(lifecyclePlan('DEPLOYED', 'start')).toEqual(['dev'])
    expect(lifecyclePlan('DEPLOYED', 'restart')).toEqual(['purge', 'deploy', 'dev'])
    expect(lifecyclePlan('DEPLOYED', 'destroy')).toEqual(['purge'])
  })

  it('offers only restart or destroy while a workload is running', () => {
    for (const status of ['RUNNING_MANAGED', 'RUNNING_EXTERNAL'] as const) {
      expect(lifecycleActions(status)).toEqual(['restart', 'destroy'])
      expect(lifecyclePlan(status, 'restart')).toEqual(['purge', 'deploy', 'dev'])
      expect(lifecyclePlan(status, 'destroy')).toEqual(['purge'])
    }
  })

  it('fails closed for actions outside the current state', () => {
    expect(() => lifecyclePlan('STOPPED', 'start')).toThrow(
      'start is not available while the workload is STOPPED',
    )
    expect(() => lifecyclePlan('RUNNING_MANAGED', 'build')).toThrow(
      'build is not available while the workload is RUNNING_MANAGED',
    )
  })
})
