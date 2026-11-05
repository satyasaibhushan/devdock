import { expect, it } from 'vitest'
import type { Operation } from './operations.js'
import type { WorkloadState } from './types.js'
import { waitBlocked } from './wait.js'

const stopped: WorkloadState = {
  type: '',
  status: 'STOPPED',
  pods: [],
  deployments: [],
  hasSession: false,
  actions: [],
}
const active: Operation = {
  id: 'op',
  repo: 'svc',
  workload: '',
  namespace: 'ns',
  action: 'build_start',
  state: 'active',
  stage: 'starting',
  createdAt: 1,
  updatedAt: 1,
  checks: [],
  logs: [],
}

it.each([
  [{ status: 'RUNNING_MANAGED' }, stopped, undefined, false, 'unreachable'],
  [{ ready: true }, stopped, undefined, false, 'unreachable'],
  [{ http: { path: '/' } }, stopped, undefined, false, 'unreachable'],
  [{ ready: true }, stopped, active, false, undefined],
  [{ ready: true }, stopped, undefined, true, undefined],
  [{ ready: true }, { ...stopped, unreachable: true }, undefined, false, undefined],
  [{ ready: true }, { ...stopped, status: 'CRASHED' }, undefined, false, 'unreachable'],
  [
    { ready: true },
    {
      ...stopped,
      status: 'DEPLOYED',
      deployments: [{ name: 'svc', replicas: 1, readyReplicas: 0 }],
    },
    undefined,
    false,
    undefined,
  ],
  [
    { status: 'RUNNING_MANAGED' },
    { ...stopped, status: 'DEPLOYED' },
    undefined,
    false,
    'unreachable',
  ],
  [
    { status: 'RUNNING_EXTERNAL' },
    {
      ...stopped,
      status: 'DEPLOYED',
      deployments: [{ name: 'svc', replicas: 1, readyReplicas: 0 }],
    },
    undefined,
    false,
    undefined,
  ],
  [
    { status: 'RUNNING_MANAGED' },
    { ...stopped, status: 'BUILDING', hasSession: true },
    undefined,
    false,
    undefined,
  ],
  [
    { status: 'STOPPED', contains: 'reloaded' },
    { ...stopped, status: 'RUNNING_MANAGED', hasSession: true },
    undefined,
    false,
    undefined,
  ],
  [{ ready: true }, stopped, { ...active, state: 'interrupted' }, false, 'operation_failed'],
] as const)(
  'decides whether a target can still progress: %j',
  (target, state, op, transition, reason) => {
    expect(
      waitBlocked(state as WorkloadState, target, op as Operation | undefined, transition)?.reason,
    ).toBe(reason)
  },
)

const retrying: WorkloadState = {
  ...stopped,
  status: 'CRASHED',
  hasSession: true,
  pods: [{ name: 'worker', phase: 'Running', ready: false, restartCount: 3, crashing: true }],
}

it.each([{ ready: true }, { http: { path: '/health' } }, { contains: 'ready' }])(
  'keeps observing recoverable pod failures for %j',
  (target) => {
    expect(waitBlocked(retrying, target, undefined, false)).toBeUndefined()
    expect(
      waitBlocked({ ...retrying, hasSession: false }, target, undefined, false),
    ).toBeUndefined()
    expect(
      waitBlocked(
        { ...retrying, pods: retrying.pods.map((pod) => ({ ...pod, phase: 'Pending' })) },
        target,
        undefined,
        false,
      ),
    ).toBeUndefined()
  },
)

it.each([
  [{ status: 'RUNNING_MANAGED' }, retrying],
  [{ ready: true }, { ...retrying, sessionDead: true, hasSession: false }],
  [
    { http: { path: '/health' } },
    { ...retrying, pods: retrying.pods.map((pod) => ({ ...pod, phase: 'Failed' })) },
  ],
  [{ contains: 'ready' }, { ...retrying, pods: [], hasSession: false }],
] as const)('rejects terminal crashes for %j', (target, state) => {
  expect(waitBlocked(state as WorkloadState, target, undefined, false)?.reason).toBe('unreachable')
})

it('allows an observable OR target to recover even when its status target is blocked', () => {
  expect(
    waitBlocked(retrying, { status: 'RUNNING_MANAGED', ready: true }, undefined, false),
  ).toBeUndefined()
})
