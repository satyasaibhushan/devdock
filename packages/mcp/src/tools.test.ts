import type { RepoState } from '@devdock/core'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonClient, VerbResult } from './client.js'
import { allTools, toolsForScope } from './tools.js'

const ok: VerbResult = { ok: true, code: 0, stderr: '' }

function fakeClient(over: Partial<DaemonClient> = {}): DaemonClient {
  const state: RepoState = {
    repo: {
      id: 'svc-a',
      name: 'svc-a',
      path: '/x',
      configPath: '/x/devspace.yaml',
      ports: [],
      session: 'devdock-svc-a',
    },
    status: 'RUNNING_MANAGED',
    workloads: [
      {
        type: '',
        status: 'RUNNING_MANAGED',
        pods: [{ name: 'p', phase: 'Running', ready: true, restartCount: 0 }],
        deployments: [],
        hasSession: true,
      },
    ],
    pods: [{ name: 'p', phase: 'Running', ready: true, restartCount: 0 }],
    deployments: [],
    hasSession: true,
    updatedAt: 0,
  }
  return {
    list: async () => [state],
    status: async () => state,
    start: async () => ok,
    build: async () => ok,
    stop: async () => ok,
    logs: async () => ['line one', 'line two'],
    exec: async () => ok,
    ...over,
  }
}

function tool(name: string, scope: 'ro' | 'rw' = 'rw') {
  const t = toolsForScope(fakeClient(), scope).find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name} at scope ${scope}`)
  return t
}

describe('toolsForScope', () => {
  it('ro scope hides the write verbs', () => {
    const names = toolsForScope(fakeClient(), 'ro').map((t) => t.name)
    expect(names).toEqual(['devdock_list', 'devdock_status', 'devdock_logs'])
  })

  it('rw scope exposes all seven verbs', () => {
    const names = toolsForScope(fakeClient(), 'rw').map((t) => t.name)
    expect(names).toEqual([
      'devdock_list',
      'devdock_status',
      'devdock_logs',
      'devdock_start',
      'devdock_build',
      'devdock_stop',
      'devdock_exec',
    ])
  })
})

describe('tool handlers', () => {
  it('list renders one line per repo', async () => {
    expect(await tool('devdock_list').handler({})).toBe('svc-a\tRUNNING_MANAGED\t1 pod(s)')
  })

  it('logs joins recent lines', async () => {
    expect(await tool('devdock_logs').handler({ repo: 'svc-a' })).toBe('line one\nline two')
  })

  it('exec passes the command through to the client', async () => {
    const exec = vi.fn(async () => ok)
    const t = allTools(fakeClient({ exec })).find((x) => x.name === 'devdock_exec')
    const out = await t?.handler({ repo: 'svc-a', command: 'pnpm test' })
    expect(exec).toHaveBeenCalledWith('svc-a', 'pnpm test')
    expect(out).toBe('exec svc-a: ok')
  })

  it('verb text reports a non-zero exit with stderr', async () => {
    const t = allTools(
      fakeClient({ start: async () => ({ ok: false, code: 1, stderr: 'boom' }) }),
    ).find((x) => x.name === 'devdock_start')
    expect(await t?.handler({ repo: 'svc-a' })).toBe('start svc-a: exit 1\nboom')
  })
})
