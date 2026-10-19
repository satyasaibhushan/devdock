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
const pending: PodInfo = { name: 'p', phase: 'Pending', ready: false, restartCount: 0 }
const crashy: PodInfo = {
  name: 'p',
  phase: 'Running',
  ready: false,
  restartCount: 3,
  crashing: true,
}

describe('deriveStatus (spec §6 table)', () => {
  it('does not treat past restarts as a current failure', () => {
    expect(deriveStatus([{ ...ready, restartCount: 5 }], true)).toBe('RUNNING_MANAGED')
    expect(deriveStatus([{ ...ready, restartCount: 5 }], false)).toBe('RUNNING_EXTERNAL')
  })
  it.each([
    [{ running: {} }, true, 'RUNNING_MANAGED'],
    [{ running: {} }, false, 'BUILDING'],
    [{ waiting: { reason: 'CrashLoopBackOff' } }, false, 'CRASHED'],
    [{ waiting: { reason: 'ImagePullBackOff' } }, false, 'CRASHED'],
    [{ terminated: { exitCode: 1 } }, false, 'CRASHED'],
  ])('uses current container state %j, not last termination', (state, ready, expected) => {
    const pods = parsePods(
      JSON.stringify({
        items: [
          {
            metadata: { name: 'worker' },
            status: {
              phase: 'Running',
              containerStatuses: [
                { ready, restartCount: 5, state, lastState: { terminated: { exitCode: 1 } } },
              ],
            },
          },
        ],
      }),
    )
    expect(deriveStatus(pods, true)).toBe(expected)
  })
  it('ready pod + session → RUNNING_MANAGED', () => {
    expect(deriveStatus([ready], true)).toBe('RUNNING_MANAGED')
  })
  it('ready pod, no session → RUNNING_EXTERNAL', () => {
    expect(deriveStatus([ready], false)).toBe('RUNNING_EXTERNAL')
  })
  it('unready pods remain BUILDING with or without a session', () => {
    expect(deriveStatus([pending], true)).toBe('BUILDING')
    expect(deriveStatus([pending], false)).toBe('BUILDING')
  })
  it('pending deployment without a dev session remains startable and purgeable', () => {
    expect(deriveStatus([pending], false, true)).toBe('DEPLOYED')
    expect(deriveStatus([{ ...pending, name: 'svc-devspace-abc' }], false, true)).toBe('DEPLOYED')
    expect(deriveStatus([pending], true, true)).toBe('BUILDING')
  })
  it('current container failure → CRASHED (takes precedence)', () => {
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
  it('frontend deploy-only pods report DEPLOYED instead of external', () => {
    expect(deriveStatus([ready], false, true, false, { deployedWhenRunning: true })).toBe(
      'DEPLOYED',
    )
  })
  it('frontend devspace pods still report external when unmanaged', () => {
    const devspacePod = { ...ready, name: 'svc-devspace-abc' }
    expect(deriveStatus([devspacePod], false, true, false, { deployedWhenRunning: true })).toBe(
      'RUNNING_EXTERNAL',
    )
  })
  it('a dead managed session → CRASHED, not silently RUNNING_EXTERNAL', () => {
    // devspace dev exited but the pane is held open (remain-on-exit) and pods
    // linger: surface the crash instead of pretending it runs externally.
    expect(deriveStatus([ready], false, true, true)).toBe('CRASHED')
    expect(deriveStatus([], false, false, true)).toBe('CRASHED')
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

  it('a longer known name claims its pods away from the shorter prefix', () => {
    const mixed: PodInfo[] = [
      { name: 'svc-api-devspace-abc', phase: 'Running', ready: true, restartCount: 0 },
      { name: 'svc-r1-api-devspace-def', phase: 'Running', ready: true, restartCount: 0 },
      { name: 'svc-r1-api', phase: 'Running', ready: true, restartCount: 0 },
    ]
    const known = ['svc-api', 'svc-r1-api']
    expect(matchPods(mixed, 'svc-api', known).map((p) => p.name)).toEqual(['svc-api-devspace-abc'])
    expect(matchPods(mixed, 'svc-r1-api', known).map((p) => p.name)).toEqual([
      'svc-r1-api-devspace-def',
      'svc-r1-api',
    ])
  })

  it('an exact-name pod is never shadowed by a longer known name', () => {
    const exact: PodInfo[] = [{ name: 'svc', phase: 'Running', ready: true, restartCount: 0 }]
    expect(matchPods(exact, 'svc', ['svc', 'svc-r1'])).toHaveLength(1)
  })

  it('without knownNames the prefix behavior is unchanged', () => {
    const mixed: PodInfo[] = [
      { name: 'svc-r1-api-devspace-def', phase: 'Running', ready: true, restartCount: 0 },
    ]
    expect(matchPods(mixed, 'svc')).toHaveLength(1)
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
  it('a longer known name claims its deployments away from the shorter prefix', () => {
    const deps: DeploymentInfo[] = [
      { name: 'jobs-ui', replicas: 0, readyReplicas: 0 },
      { name: 'jobs-ui-r1', replicas: 0, readyReplicas: 0 },
      { name: 'jobs-ui-r1-devspace', replicas: 0, readyReplicas: 0 },
    ]
    const known = ['jobs-ui', 'jobs-ui-r1']
    expect(matchDeployments(deps, 'jobs-ui', known).map((d) => d.name)).toEqual(['jobs-ui'])
    expect(matchDeployments(deps, 'jobs-ui-r1', known).map((d) => d.name)).toEqual([
      'jobs-ui-r1',
      'jobs-ui-r1-devspace',
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
  function clusterRunner(
    podsJson: string,
    deploymentsJson = '{"items":[]}',
    ingressesJson = '{"items":[]}',
  ) {
    return vi.fn(async (_cmd: string, args: string[]) => ({
      code: 0,
      stdout:
        args[1] === 'deployments'
          ? deploymentsJson
          : args[1] === 'ingress'
            ? ingressesJson
            : podsJson,
      stderr: '',
    }))
  }

  it.each(['svc-api', 'svc-api-devspace'])(
    'carries the matched deployment URL into workload state: %s',
    async (name) => {
      const runner = clusterRunner(
        '{"items":[]}',
        JSON.stringify({ items: [{ metadata: { name: 'other-api' } }, { metadata: { name } }] }),
        JSON.stringify({
          items: [
            {
              metadata: { name: 'other-api' },
              spec: { rules: [{ host: 'other.example', http: { paths: [{ path: '/' }] } }] },
            },
            {
              metadata: { name: 'svc-api' },
              spec: {
                rules: [
                  { host: 'svc.example', http: { paths: [{ path: '/svc' }, { path: '/svc-2' }] } },
                ],
              },
            },
          ],
        }),
      )
      const state = await new Reconciler(runner).reconcile(repo, false)
      expect(state.workloads[0]?.url).toBe('https://svc.example/svc')
      expect(runner).toHaveBeenCalledWith('kubectl', ['get', 'ingress', '-o', 'json', '-n', 'ns'])
    },
  )

  it.each([true, false])('prefers a replica alias when present: %s', async (aliasPresent) => {
    const ingress = (name: string, path: string) => ({
      metadata: { name },
      spec: { rules: [{ host: 'svc.example', http: { paths: [{ path }] } }] },
    })
    const runner = clusterRunner(
      '{"items":[]}',
      JSON.stringify({ items: [{ metadata: { name: 'svc-r1-api-devspace' } }] }),
      JSON.stringify({
        items: [
          ingress('svc-r1-api', '/svc'),
          ...(aliasPresent ? [ingress('svc-r1-alias', '/svc-r1(/|$)(.*)')] : []),
        ],
      }),
    )
    const state = await new Reconciler(runner).reconcile(
      { ...repo, id: 'svc-r1', name: 'svc-r1-api', parentId: 'svc' },
      false,
    )
    expect(state.workloads[0]?.url).toBe(
      aliasPresent ? 'https://svc.example/svc-r1/' : 'https://svc.example/svc',
    )
  })

  it.each(['exit', 'throw'])(
    'an ingress query failure leaves status and reachability unchanged: %s',
    async (failure) => {
      const base = clusterRunner('{"items":[]}', '{"items":[{"metadata":{"name":"svc"}}]}')
      const runner = vi.fn(async (cmd: string, args: string[]) => {
        if (args[1] !== 'ingress') return base(cmd, args)
        if (failure === 'throw') throw new Error('Unavailable')
        return { code: 1, stdout: '', stderr: 'Unavailable' }
      })
      const rec = new Reconciler(runner)
      const cache = newClusterCache()
      for (let i = 0; i < 2; i++) {
        const state = await rec.reconcile(repo, false, cache)
        expect(state.status).toBe('DEPLOYED')
        expect(state.workloads[0]?.unreachable).toBeUndefined()
        expect(state.workloads[0]?.url).toBeUndefined()
      }
      expect(runner.mock.calls.filter(([, args]) => args[1] === 'ingress')).toHaveLength(1)
    },
  )

  it('caches ingress URLs separately for each namespace, including the current context', async () => {
    const runner = clusterRunner('{"items":[]}')
    const rec = new Reconciler(runner)
    const cache = newClusterCache()
    for (const namespace of ['ns', 'other', undefined, 'ns', 'other', undefined]) {
      await rec.reconcile({ ...repo, namespace }, false, cache)
    }
    const calls = runner.mock.calls.filter(([, args]) => args[1] === 'ingress')
    expect(calls.map(([, args]) => args)).toEqual([
      ['get', 'ingress', '-o', 'json', '-n', 'ns'],
      ['get', 'ingress', '-o', 'json', '-n', 'other'],
      ['get', 'ingress', '-o', 'json'],
    ])
  })

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

  it('flags a kubectl failure as unreachable — unknown, not "no pods"', async () => {
    const runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'boom' }))
    const state = await new Reconciler(runner).reconcile(repo, false)
    // the reconciler-level fallback still derives STOPPED, but the flag lets
    // the service hold the last known status and skip retire decisions
    expect(state.status).toBe('STOPPED')
    expect(state.workloads[0]?.unreachable).toBe(true)
  })

  it('does not flag a successful empty read as unreachable', async () => {
    const state = await new Reconciler(clusterRunner('{"items":[]}')).reconcile(repo, false)
    expect(state.workloads[0]?.unreachable).toBeUndefined()
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

  it('a frontend deployment pod with no session reports DEPLOYED', async () => {
    const frontend = { ...repo, codeArea: 'frontend' as const }
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-67f88768bb-tjp67' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    const deploymentsJson = JSON.stringify({
      items: [{ metadata: { name: 'svc' }, spec: { replicas: 1 }, status: { readyReplicas: 1 } }],
    })
    const state = await new Reconciler(clusterRunner(podsJson, deploymentsJson)).reconcile(
      frontend,
      false,
    )
    expect(state.status).toBe('DEPLOYED')
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

  it('cache.knownNames keeps a replica’s pods out of the parent’s view', async () => {
    const podsJson = JSON.stringify({
      items: [
        {
          metadata: { name: 'svc-devspace-xyz' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
        {
          metadata: { name: 'svc-r1-devspace-xyz' },
          status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
        },
      ],
    })
    const rec = new Reconciler(clusterRunner(podsJson))
    const cache = newClusterCache()
    cache.knownNames = ['svc', 'svc-r1']
    const parent = await rec.reconcile(repo, true, cache)
    expect(parent.pods.map((p) => p.name)).toEqual(['svc-devspace-xyz'])
    const replica: Repo = { ...repo, id: 'svc-r1', name: 'svc-r1', session: 'devdock-svc-r1' }
    const rep = await rec.reconcile(replica, true, cache)
    expect(rep.pods.map((p) => p.name)).toEqual(['svc-r1-devspace-xyz'])
  })

  it('a shared cache issues one kubectl query per namespace per pass', async () => {
    const runner = clusterRunner('{"items":[]}')
    const rec = new Reconciler(runner)
    const cache = newClusterCache()
    const other: Repo = { ...repo, id: 'svc2', name: 'svc2', session: 'devdock-svc2' }
    await rec.reconcile(repo, false, cache)
    await rec.reconcile(other, false, cache)
    // One query for each resource, shared by both repos.
    expect(runner).toHaveBeenCalledTimes(3)
  })
})
