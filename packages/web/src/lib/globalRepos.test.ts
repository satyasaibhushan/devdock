import { describe, expect, it } from 'vitest'
import type { InstanceView, RepoState } from './api'
import { globalRepos, ownerInstanceIds, retainOwners } from './globalRepos'

function state(owner?: string, namespace = 'sai'): RepoState {
  return {
    repo: {
      id: 'accounts',
      name: 'accounts',
      namespace,
      path: '/Code/accounts',
      ports: [],
      session: 'accounts',
      workloads: ['api', 'worker'],
      defaultWorkload: 'api',
    },
    status: 'DEPLOYED',
    hasSession: false,
    pods: [],
    actions: ['start'],
    updatedAt: 0,
    workloads: ['api', 'worker'].map((type) => ({
      type,
      status: 'DEPLOYED',
      pods: [],
      deployments: [],
      hasSession: false,
      actions: ['start'],
      ownershipKnown: true,
      ownerInstanceId: owner,
    })),
  }
}
function machine(id: string, repo = state('box'), online = true): InstanceView {
  return { id, name: id, local: id === 'mac', online, repos: [repo] }
}

describe('global repo directory', () => {
  it('does not display an action target as ownership for an unclaimed deployed repo', () => {
    const instances = [machine('mac', state()), machine('box', state())]
    for (const preferred of ['mac', 'box']) {
      const row = globalRepos(instances, preferred)[0]
      if (!row) throw new Error('Missing fixture repo')
      expect(row.workloads[0]?.instanceId).toBe(preferred)
      expect(ownerInstanceIds(row)).toEqual([])
    }
  })
  it('keeps only the claimed API badge when stopped workloads target another machine', () => {
    const repo = state('box')
    const worker = repo.workloads[1]
    if (!worker) throw new Error('Missing fixture workload')
    worker.ownerInstanceId = undefined
    worker.status = 'STOPPED'
    const instances = [machine('mac', repo), machine('box', repo)]
    for (const preferred of ['mac', 'box']) {
      const row = globalRepos(instances, preferred)[0]
      if (!row) throw new Error('Missing fixture repo')
      expect(ownerInstanceIds(row)).toEqual(['box'])
    }
  })
  it('deduplicates and routes to the owner independently of the preferred machine', () => {
    const instances = [machine('mac'), machine('box')]
    expect(globalRepos(instances, 'mac')).toHaveLength(1)
    for (const preferred of ['mac', 'box']) {
      expect(globalRepos(instances, preferred)[0]?.workloads[0]?.instanceId).toBe('box')
    }
  })
  it('never falls back when the owner is offline or disconnected', () => {
    for (const instances of [
      [machine('mac'), machine('box', state('box'), false)],
      [machine('mac')],
    ]) {
      const workload = globalRepos(instances, 'mac')[0]?.workloads[0]
      expect(workload).toMatchObject({ instanceId: 'box', unavailable: true, actions: [] })
    }
  })
  it('uses the chosen machine only for unclaimed work', () => {
    const instances = [machine('mac', state()), machine('box', state())]
    expect(globalRepos(instances, 'box')[0]?.workloads[0]?.instanceId).toBe('box')
    expect(globalRepos(instances, 'mac')[0]?.workloads[0]?.instanceId).toBe('mac')
  })
  it('routes workloads independently and preserves the aggregate status', () => {
    const repo = state('box')
    const worker = repo.workloads[1]
    if (!worker) throw new Error('Missing fixture workload')
    worker.ownerInstanceId = 'mac'
    worker.status = 'CRASHED'
    const row = globalRepos([machine('mac', repo), machine('box', repo)], 'mac')[0]
    expect(row?.workloads.map((w) => w.instanceId)).toEqual(['box', 'mac'])
    expect(row?.status).toBe('CRASHED')
  })
  it('does not mix namespace claims', () => {
    const row = globalRepos(
      [machine('mac', state('mac', 'one')), machine('box', state('box', 'two'))],
      'mac',
    )[0]
    expect(row?.workloads[0]).toMatchObject({ instanceId: 'mac', unavailable: false })
  })
  it('fails closed on conflicting owners', () => {
    const row = globalRepos([machine('mac', state('mac')), machine('box')], 'mac')[0]
    expect(row?.actions).toEqual([])
  })
  it('retains an owner on transient read failures without enabling actions', () => {
    const previous = [machine('mac')]
    const unknown = state()
    for (const w of unknown.workloads) w.ownershipKnown = false
    const merged = retainOwners([machine('mac', unknown)], previous)
    expect(globalRepos(merged, 'mac')[0]?.workloads[0]).toMatchObject({
      instanceId: 'box',
      unavailable: true,
    })
  })
  it('retains offline-only repos and accepts authoritative claim removal', () => {
    const previous = [machine('box')]
    expect(
      retainOwners([{ ...machine('box'), online: false, repos: [] }], previous)[0]?.repos,
    ).toHaveLength(1)
    expect(
      retainOwners([machine('box', state())], previous)[0]?.repos[0]?.workloads[0]?.ownerInstanceId,
    ).toBeUndefined()
  })
})
