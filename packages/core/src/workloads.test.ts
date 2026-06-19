import { describe, expect, it } from 'vitest'
import type { Repo, WorkloadState } from './types.js'
import {
  aggregateStatus,
  assembleState,
  resolveWorkload,
  scopeRepo,
  workloadTypes,
} from './workloads.js'

const base: Repo = {
  id: 'acs-org-management',
  name: 'acs-org-management',
  path: '/home/me/Code/acs-org-management',
  configPath: '/home/me/Code/acs-org-management/devspace.yaml',
  namespace: 'uat',
  ports: [],
  varDefaults: { TARGET_REGION: 'us' },
  workloads: ['api', 'cron', 'worker'],
  defaultWorkload: 'api',
  session: 'devdock-acs-org-management',
}

const single: Repo = {
  id: 'svc-a',
  name: 'svc-a',
  path: '/home/me/Code/svc-a',
  configPath: '/home/me/Code/svc-a/devspace.yaml',
  ports: [],
  session: 'devdock-svc-a',
}

// A multi-config repo: workloads live in separate .devspace/<name>-<type>/
// configs, carried as members (each a complete Repo) rather than a question var.
const multiConfig: Repo = {
  id: 'career-service-agents',
  name: 'career-service-agents',
  path: '/home/me/Code/career-service-agents',
  root: '/home/me/Code/career-service-agents',
  configPath: '/home/me/Code/career-service-agents/.devspace/career-service-agents-api/devspace.yaml',
  ports: [],
  workloads: ['api', 'worker'],
  defaultWorkload: 'api',
  session: 'devdock-career-service-agents',
  members: [
    {
      id: 'career-service-agents-api',
      name: 'career-service-agents-api',
      path: '/home/me/Code/career-service-agents/.devspace/career-service-agents-api',
      root: '/home/me/Code/career-service-agents',
      configPath:
        '/home/me/Code/career-service-agents/.devspace/career-service-agents-api/devspace.yaml',
      ports: [],
      workloadType: 'api',
      session: 'devdock-career-service-agents-api',
    },
    {
      id: 'career-service-agents-worker',
      name: 'career-service-agents-worker',
      path: '/home/me/Code/career-service-agents/.devspace/career-service-agents-worker',
      root: '/home/me/Code/career-service-agents',
      configPath:
        '/home/me/Code/career-service-agents/.devspace/career-service-agents-worker/devspace.yaml',
      ports: [],
      workloadType: 'worker',
      session: 'devdock-career-service-agents-worker',
    },
  ],
}

describe('aggregateStatus', () => {
  it('picks the most attention-worthy status', () => {
    expect(aggregateStatus(['STOPPED', 'CRASHED', 'RUNNING_MANAGED'])).toBe('CRASHED')
    expect(aggregateStatus(['STOPPED', 'RUNNING_EXTERNAL'])).toBe('RUNNING_EXTERNAL')
    expect(aggregateStatus(['DEPLOYED', 'STOPPED'])).toBe('DEPLOYED')
  })

  it('is STOPPED when there is nothing', () => {
    expect(aggregateStatus([])).toBe('STOPPED')
    expect(aggregateStatus(['STOPPED', 'STOPPED'])).toBe('STOPPED')
  })

  it('prefers managed over external when both are present', () => {
    expect(aggregateStatus(['RUNNING_EXTERNAL', 'RUNNING_MANAGED'])).toBe('RUNNING_MANAGED')
  })
})

describe('workloadTypes', () => {
  it('lists a multi-workload repo’s types', () => {
    expect(workloadTypes(base)).toEqual(['api', 'cron', 'worker'])
  })
  it('yields a single undefined for a plain repo (act on it as-is)', () => {
    expect(workloadTypes(single)).toEqual([undefined])
  })
  it('lists a multi-config repo’s member types', () => {
    expect(workloadTypes(multiConfig)).toEqual(['api', 'worker'])
  })
})

describe('resolveWorkload', () => {
  it('honours a requested workload the repo offers', () => {
    expect(resolveWorkload(base, 'worker')).toBe('worker')
  })
  it('falls back to the default for an unknown/absent request', () => {
    expect(resolveWorkload(base, 'nope')).toBe('api')
    expect(resolveWorkload(base)).toBe('api')
  })
  it('is undefined for single-workload repos regardless of request', () => {
    expect(resolveWorkload(single, 'api')).toBeUndefined()
  })
})

describe('scopeRepo', () => {
  it('suffixes name/session and pins WORKLOAD_TYPE', () => {
    const w = scopeRepo(base, 'worker')
    expect(w.name).toBe('acs-org-management-worker')
    expect(w.session).toBe('devdock-acs-org-management-worker')
    expect(w.varDefaults).toEqual({ TARGET_REGION: 'us', WORKLOAD_TYPE: 'worker' })
    // the clone is itself single-workload — no recursion
    expect(w.workloads).toBeUndefined()
    expect(w.defaultWorkload).toBeUndefined()
    // id is stable so registry lookups still resolve the parent repo
    expect(w.id).toBe('acs-org-management')
  })
  it('returns the repo unchanged when no workload is given', () => {
    expect(scopeRepo(single, undefined)).toBe(single)
  })
  it('returns the matching member config for a multi-config repo', () => {
    const w = scopeRepo(multiConfig, 'worker')
    // the member is used as-is — its own service dir, name and session.
    expect(w.path).toBe(
      '/home/me/Code/career-service-agents/.devspace/career-service-agents-worker',
    )
    expect(w.name).toBe('career-service-agents-worker')
    expect(w.session).toBe('devdock-career-service-agents-worker')
    expect(w.root).toBe('/home/me/Code/career-service-agents')
  })
})

describe('assembleState', () => {
  const wls: WorkloadState[] = [
    {
      type: 'api',
      status: 'RUNNING_MANAGED',
      pods: [{ name: 'acs-api-1', phase: 'Running', ready: true, restartCount: 0 }],
      deployments: [{ name: 'acs-org-management-api', replicas: 1, readyReplicas: 1 }],
      hasSession: true,
    },
    {
      type: 'worker',
      status: 'STOPPED',
      pods: [],
      deployments: [],
      hasSession: false,
    },
  ]

  it('aggregates status and unions pods/deployments/session', () => {
    const state = assembleState(base, wls, 123)
    expect(state.status).toBe('RUNNING_MANAGED')
    expect(state.workloads).toHaveLength(2)
    expect(state.pods.map((p) => p.name)).toEqual(['acs-api-1'])
    expect(state.deployments.map((d) => d.name)).toEqual(['acs-org-management-api'])
    expect(state.hasSession).toBe(true)
    expect(state.updatedAt).toBe(123)
  })
})
