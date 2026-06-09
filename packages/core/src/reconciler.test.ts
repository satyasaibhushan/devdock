import { describe, expect, it, vi } from 'vitest'
import { Reconciler, deriveStatus, matchPods, parsePods } from './reconciler.js'
import type { PodInfo, Repo } from './types.js'

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

  it('passes namespace to kubectl and reports status', async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        items: [
          {
            metadata: { name: 'svc-devspace-xyz' },
            status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] },
          },
        ],
      }),
      stderr: '',
    }))
    const state = await new Reconciler(runner).reconcile(repo, true)
    expect(runner).toHaveBeenCalledWith('kubectl', ['get', 'pods', '-o', 'json', '-n', 'ns'])
    expect(state.status).toBe('RUNNING_MANAGED')
    expect(state.pods).toHaveLength(1)
  })

  it('treats a kubectl failure as no pods', async () => {
    const runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'boom' }))
    const state = await new Reconciler(runner).reconcile(repo, false)
    expect(state.status).toBe('STOPPED')
  })
})
