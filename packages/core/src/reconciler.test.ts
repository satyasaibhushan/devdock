import { describe, expect, it, vi } from 'vitest'
import {
  Reconciler,
  deriveStatus,
  matchDeployments,
  matchPods,
  newClusterCache,
  parseDeployments,
  parsePods,
} from './reconciler.js'
import type { DeploymentInfo, PodInfo, Repo } from './types.js'

const ready: PodInfo = { name: 'p', phase: 'Running', ready: true, restartCount: 0 }
const crashy: PodInfo = { name: 'p', phase: 'Running', ready: false, restartCount: 3 }

describe('deriveStatus (spec §6 table)', () => {
  it('ready pod + session → RUNNING_MANAGED', () => {
    expect(deriveStatus([ready], true)).toBe('RUNNING_MANAGED')
  })
  it('ready pod, no session → RUNNING_EXTERNAL', () => {
    expect(deriveStatus([ready], false)).toBe('RUNNING_EXTERNAL')
  })
  it('restartCount>0 → CRASHED (takes precedence)', () => {
    expect(deriveStatus([crashy], true)).toBe('CRASHED')
  })
  it('no pod, no session → STOPPED', () => {
    expect(deriveStatus([], false)).toBe('STOPPED')
  })
  it('no pod but session → BUILDING', () => {
    expect(deriveStatus([], true)).toBe('BUILDING')
  })
  it('no pod, no session, deployment exists → DEPLOYED (built, scaled down)', () => {
    expect(deriveStatus([], false, true)).toBe('DEPLOYED')
  })
  it('a session outranks a dormant deployment → BUILDING', () => {
    expect(deriveStatus([], true, true)).toBe('BUILDING')
  })
  it('running pods outrank the deployment flag', () => {
    expect(deriveStatus([ready], false, true)).toBe('RUNNING_EXTERNAL')
  })
})

describe('parsePods', () => {
  it('sums restarts and computes readiness', () => {
    const json = JSON.stringify({
      items: [
        {
          metadata: { name: 'app-1' },
          status: {
            phase: 'Running',
            containerStatuses: [
              { ready: true, restartCount: 1 },
              { ready: false, restartCount: 2 },
            ],
          },
        },
      ],
    })
    expect(parsePods(json)).toEqual([
      { name: 'app-1', phase: 'Running', ready: false, restartCount: 3 },
    ])
  })
  it('tolerates junk', () => {
    expect(parsePods('not json')).toEqual([])
    expect(parsePods('{}')).toEqual([])
  })
})

describe('matchPods', () => {
  const pods: PodInfo[] = [
    { name: 'career-service-ui-devspace-abc', phase: 'Running', ready: true, restartCount: 0 },
    { name: 'registry-74cf9445-fzkg5', phase: 'Running', ready: true, restartCount: 23 },
  ]
  it('keeps only pods named after the project, dropping unrelated ones', () => {
    expect(matchPods(pods, 'career-service-ui').map((p) => p.name)).toEqual([
      'career-service-ui-devspace-abc',
    ])
  })
  it('matches an exact name and a hyphen-prefixed name', () => {
    expect(
      matchPods([{ name: 'svc', phase: 'Running', ready: true, restartCount: 0 }], 'svc'),
    ).toHaveLength(1)
  })
  it('an empty name attributes nothing', () => {
    expect(matchPods(pods, '  ')).toEqual([])
  })
})

describe('parseDeployments', () => {
  it('reads name and replica counts, defaulting absent fields to 0', () => {
    const json = JSON.stringify({
      items: [
        { metadata: { name: 'svc-devspace' }, spec: { replicas: 1 }, status: { readyReplicas: 1 } },
        { metadata: { name: 'svc' }, spec: { replicas: 0 }, status: {} },
      ],
    })
    expect(parseDeployments(json)).toEqual([
      { name: 'svc-devspace', replicas: 1, readyReplicas: 1 },
      { name: 'svc', replicas: 0, readyReplicas: 0 },
    ])
  })
  it('tolerates junk', () => {
    expect(parseDeployments('not json')).toEqual([])
    expect(parseDeployments('{}')).toEqual([])
  })
})

describe('matchDeployments', () => {
  it('attributes by the same name-prefix convention as pods', () => {
    const deps: DeploymentInfo[] = [
      { name: 'jobs-ui', replicas: 0, readyReplicas: 0 },
      { name: 'jobs-ui-devspace', replicas: 0, readyReplicas: 0 },
      { name: 'registry', replicas: 1, readyReplicas: 1 },
    ]
    expect(matchDeployments(deps, 'jobs-ui').map((d) => d.name)).toEqual([
      'jobs-ui',
      'jobs-ui-devspace',
    ])
  })
})

describe('Reconciler', () => {
  const repo: Repo = {
    id: 'svc',
    name: 'svc',
    path: '/p',
    configPath: '/p/devspace.yaml',
    namespace: 'ns',
    ports: [],
    session: 'devdock-svc',
  }

  /** Dispatches on the kubectl resource being listed. */
  function clusterRunner(podsJson: string, deploymentsJson = '{"items":[]}') {
    return vi.fn(async (_cmd: string, args: string[]) => ({
      code: 0,
      stdout: args[1] === 'deployments' ? deploymentsJson : podsJson,
      stderr: '',
    }))
  }

  it('passes namespace to kubectl and reports status', async () => {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-devspace-xyz' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    const runner = clusterRunner(podsJson)
    const state = await new Reconciler(runner).reconcile(repo, true)
    expect(runner).toHaveBeenCalledWith('kubectl', ['get', 'pods', '-o', 'json', '-n', 'ns'])
    expect(runner).toHaveBeenCalledWith('kubectl', ['get', 'deployments', '-o', 'json', '-n', 'ns'])
    expect(state.status).toBe('RUNNING_MANAGED')
    expect(state.pods).toHaveLength(1)
  })

  it('treats a kubectl failure as no pods', async () => {
    const runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'boom' }))
    const state = await new Reconciler(runner).reconcile(repo, false)
    expect(state.status).toBe('STOPPED')
  })

  it('a deployment with no pods → DEPLOYED, attributed by name', async () => {
    const deploymentsJson = JSON.stringify({
      items: [
        { metadata: { name: 'svc' }, spec: { replicas: 0 }, status: {} },
        { metadata: { name: 'svc-devspace' }, spec: { replicas: 0 }, status: {} },
        { metadata: { name: 'other-app' }, spec: { replicas: 0 }, status: {} },
      ],
    })
    const state = await new Reconciler(clusterRunner('{"items":[]}', deploymentsJson)).reconcile(
      repo,
      false,
    )
    expect(state.status).toBe('DEPLOYED')
    expect(state.deployments.map((d) => d.name)).toEqual(['svc', 'svc-devspace'])
  })

  it("another repo's deployments don't flip this repo to DEPLOYED", async () => {
    const deploymentsJson = JSON.stringify({
      items: [{ metadata: { name: 'other-app' }, spec: { replicas: 1 }, status: {} }],
    })
    const state = await new Reconciler(clusterRunner('{"items":[]}', deploymentsJson)).reconcile(
      repo,
      false,
    )
    expect(state.status).toBe('STOPPED')
    expect(state.deployments).toEqual([])
  })

  it('a shared cache issues one kubectl query per namespace per pass', async () => {
    const runner = clusterRunner('{"items":[]}')
    const rec = new Reconciler(runner)
    const cache = newClusterCache()
    const other: Repo = { ...repo, id: 'svc2', name: 'svc2', session: 'devdock-svc2' }
    await rec.reconcile(repo, false, cache)
    await rec.reconcile(other, false, cache)
    // one pods + one deployments call total, not two of each
    expect(runner).toHaveBeenCalledTimes(2)
  })
})
