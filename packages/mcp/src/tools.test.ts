import type { RepoState } from '@devdock/core'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonClient, VerbResult } from './client.js'
import { allTools, renderList, toolsForScope } from './tools.js'

const ok: VerbResult = { ok: true, code: 0, stderr: '' }

function repoState(over: Partial<RepoState> = {}): RepoState {
  return {
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
    ...over,
  }
}

function fakeClient(over: Partial<DaemonClient> = {}): DaemonClient {
  return {
    list: async () => [repoState()],
    status: async () => repoState(),
    verb: async () => ok,
    logs: async () => ['line one', 'line two'],
    exec: async () => ({ ...ok, stdout: '' }),
    setStartup: async () => {},
    namespace: async () => ({ current: 'uat', known: ['uat', 'prod'] }),
    setNamespace: async (ns) => ({ current: ns, known: ['uat', ns] }),
    auth: async () => ({ oidc: true, phase: 'ok', checkedAt: 1 }),
    authLogin: async () => ({ oidc: true, phase: 'logging_in', checkedAt: 2 }),
    termList: async () => [
      { id: 't1', kind: 'local', createdAt: 0, lastUsedAt: 0, alive: true },
      {
        id: 't2',
        kind: 'shell',
        repo: 'svc-a',
        workload: 'cron',
        createdAt: 0,
        lastUsedAt: 0,
        alive: false,
      },
    ],
    termOpen: async (o) => ({
      id: 't3',
      kind: o.kind ?? (o.repo ? 'auto' : 'local'),
      repo: o.repo,
      workload: o.workload,
      createdAt: 0,
      lastUsedAt: 0,
      alive: true,
    }),
    termRun: async () => ({ output: 'ran', timedOut: false }),
    termRead: async () => 'scrollback',
    termClose: async () => {},
    ...over,
  }
}

function tool(name: string, scope: 'ro' | 'rw' = 'rw') {
  const t = toolsForScope(fakeClient(), scope).find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name} at scope ${scope}`)
  return t
}

describe('toolsForScope', () => {
  it('ro scope exposes only the read tools', () => {
    const names = toolsForScope(fakeClient(), 'ro').map((t) => t.name)
    expect(names).toEqual([
      'devdock_list',
      'devdock_status',
      'devdock_logs',
      'devdock_namespace',
      'devdock_auth_status',
      'devdock_term_list',
      'devdock_term_read',
    ])
  })

  it('rw scope adds every verb, exec, namespace/auth/startup writes and terminal control', () => {
    const names = toolsForScope(fakeClient(), 'rw').map((t) => t.name)
    expect(names).toEqual([
      'devdock_list',
      'devdock_status',
      'devdock_logs',
      'devdock_namespace',
      'devdock_auth_status',
      'devdock_term_list',
      'devdock_term_read',
      'devdock_start',
      'devdock_build',
      'devdock_stop',
      'devdock_restart',
      'devdock_adopt',
      'devdock_clear',
      'devdock_exec',
      'devdock_set_startup',
      'devdock_set_namespace',
      'devdock_auth_login',
      'devdock_term_open',
      'devdock_term_run',
      'devdock_term_close',
    ])
  })
})

describe('renderList', () => {
  it('renders one line for a single-workload repo', () => {
    expect(renderList([repoState()])).toBe('svc-a\tRUNNING_MANAGED\t1 pod(s)')
  })

  it('adds a per-workload breakdown for multi-workload repos', () => {
    const multi = repoState({
      workloads: [
        {
          type: 'api',
          status: 'RUNNING_MANAGED',
          pods: [{ name: 'p', phase: 'Running', ready: true, restartCount: 0 }],
          deployments: [],
          hasSession: true,
        },
        { type: 'cron', status: 'STOPPED', pods: [], deployments: [], hasSession: false },
      ],
    })
    expect(renderList([multi])).toBe(
      [
        'svc-a\tRUNNING_MANAGED\t1 pod(s)',
        '  - api: RUNNING_MANAGED (1 pod(s))',
        '  - cron: STOPPED (0 pod(s))',
      ].join('\n'),
    )
  })
})

describe('tool handlers', () => {
  it('logs passes tail and workload through', async () => {
    const logs = vi.fn(async () => ['x'])
    const t = allTools(fakeClient({ logs })).find((x) => x.name === 'devdock_logs')
    await t?.handler({ repo: 'svc-a', tail: 50, workload: 'cron' })
    expect(logs).toHaveBeenCalledWith('svc-a', 50, 'cron')
  })

  it('verbs pass the workload through and report ok', async () => {
    const verb = vi.fn(async () => ok)
    const t = allTools(fakeClient({ verb })).find((x) => x.name === 'devdock_restart')
    const out = await t?.handler({ repo: 'svc-a', workload: 'cron' })
    expect(verb).toHaveBeenCalledWith('restart', 'svc-a', 'cron')
    expect(out).toBe('restart svc-a: ok')
  })

  it('verb text reports a non-zero exit with stderr', async () => {
    const t = allTools(
      fakeClient({ verb: async () => ({ ok: false, code: 1, stderr: 'boom' }) }),
    ).find((x) => x.name === 'devdock_start')
    expect(await t?.handler({ repo: 'svc-a' })).toBe('start svc-a: exit 1\nboom')
  })

  it('exec passes the command through to the client', async () => {
    const exec = vi.fn(async () => ({ ...ok, stdout: '' }))
    const t = allTools(fakeClient({ exec })).find((x) => x.name === 'devdock_exec')
    const out = await t?.handler({ repo: 'svc-a', command: 'pnpm test' })
    expect(exec).toHaveBeenCalledWith('svc-a', 'pnpm test', undefined)
    expect(out).toBe('exec svc-a: ok')
  })

  it('term_open defaults to a local shell and reports the id', async () => {
    expect(await tool('devdock_term_open').handler({})).toBe('opened t3 (local)')
    expect(await tool('devdock_term_open').handler({ repo: 'svc-a', kind: 'shell' })).toBe(
      'opened t3 (shell on svc-a)',
    )
  })

  it('term_run returns output, flagging a timeout', async () => {
    expect(await tool('devdock_term_run').handler({ terminal: 't1', command: 'ls' })).toBe('ran')
    const slow = allTools(
      fakeClient({ termRun: async () => ({ output: 'partial', timedOut: true }) }),
    ).find((x) => x.name === 'devdock_term_run')
    expect(await slow?.handler({ terminal: 't1', command: 'sleep 99' })).toContain(
      'still running after timeout',
    )
  })

  it('term_list renders one line per terminal', async () => {
    expect(await tool('devdock_term_list', 'ro').handler({})).toBe(
      't1\tlocal\talive\nt2\tshell\tsvc-a/cron\texited',
    )
  })

  it('set_startup distinguishes save from clear', async () => {
    expect(await tool('devdock_set_startup').handler({ repo: 'svc-a', command: 'make run' })).toBe(
      'startup command saved for svc-a',
    )
    expect(await tool('devdock_set_startup').handler({ repo: 'svc-a', command: '' })).toBe(
      'startup command cleared for svc-a',
    )
  })
})
