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
    queryLogs: async () => ({
      source: 'application' as const,
      lines: ['line one', 'line two'],
      cursor: 'f:1:42',
    }),
    runIn: async () => ({
      ok: true,
      exitCode: 0,
      stdout: 'all good',
      stderr: '',
      pod: 'p',
      timedOut: false,
      truncated: false,
    }),
    wait: async () => ({
      matched: true,
      reason: 'contains' as const,
      line: 'Uvicorn running',
      elapsedMs: 1200,
      cursor: 'f:1:99',
    }),
    exec: async () => ({ ...ok, stdout: '' }),
    setStartup: async () => {},
    branches: async () => [
      { name: 'main', lastCommitAt: Date.UTC(2026, 6, 1) },
      { name: 'feature-x', lastCommitAt: Date.UTC(2026, 5, 15) },
    ],
    replicaCreate: async (id, branch) => ({
      id: `${id}-r1`,
      parentId: id,
      branch,
      path: `/x/.agents/replicas/${id}-r1`,
      createdAt: 0,
      configPaths: [],
    }),
    replicaList: async () => [
      {
        id: 'svc-a-r1',
        parentId: 'svc-a',
        branch: 'feature-x',
        path: '/x/.agents/replicas/svc-a-r1',
        createdAt: Date.now() - 26 * 3_600_000,
        configPaths: [],
        ingressApplied: true,
      },
    ],
    replicaDelete: async () => {},
    namespace: async () => ({ current: 'uat', known: ['uat', 'prod'] }),
    setNamespace: async (ns) => ({ current: ns, known: ['uat', ns] }),
    auth: async () => ({ oidc: true, phase: 'ok', checkedAt: 1 }),
    authLogin: async () => ({ oidc: true, phase: 'logging_in', checkedAt: 2 }),
    termList: async () => [
      {
        id: 'host:t1',
        kind: 'local',
        attach: 'host',
        createdAt: 0,
        lastUsedAt: 0,
        alive: true,
        attached: 0,
      },
      {
        id: 'svc-a.cron:t1',
        kind: 'shell',
        repo: 'svc-a',
        workload: 'cron',
        attach: 'pod',
        createdAt: 0,
        lastUsedAt: 0,
        alive: false,
        attached: 0,
      },
    ],
    termOpen: async (o) => ({
      id: o.repo ? `${o.repo}:t1` : 'host:t1',
      kind: o.kind ?? (o.repo ? 'auto' : 'local'),
      repo: o.repo,
      workload: o.workload,
      attach: o.repo ? 'tmux' : 'host',
      createdAt: 0,
      lastUsedAt: 0,
      alive: true,
      attached: 0,
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
      'devdock_wait',
      'devdock_branch_list',
      'devdock_replica_list',
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
      'devdock_wait',
      'devdock_branch_list',
      'devdock_replica_list',
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
      'devdock_replica_create',
      'devdock_replica_delete',
      'devdock_run',
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
  it('logs queries by source/cursor and renders the header + lines', async () => {
    const queryLogs = vi.fn(async () => ({
      source: 'application' as const,
      lines: ['boot ok'],
      cursor: 'f:2:10',
    }))
    const t = allTools(fakeClient({ queryLogs })).find((x) => x.name === 'devdock_logs')
    const out = await t?.handler({ repo: 'svc-a', tail: 50, workload: 'cron', cursor: 'f:2:0' })
    expect(queryLogs).toHaveBeenCalledWith('svc-a', {
      workload: 'cron',
      source: undefined,
      cursor: 'f:2:0',
      tail: 50,
      contains: undefined,
    })
    expect(out).toBe('[source=application nextCursor=f:2:10]\nboot ok')
  })

  it('logs surfaces resync and dropped so an agent knows lines were missed', async () => {
    const t = allTools(
      fakeClient({
        queryLogs: async () => ({
          source: 'devdock' as const,
          lines: [],
          cursor: 'h:9',
          resync: true,
          dropped: true,
        }),
      }),
    ).find((x) => x.name === 'devdock_logs')
    const out = (await t?.handler({ repo: 'svc-a' })) as string
    expect(out).toContain('resync=true')
    expect(out).toContain('dropped=true')
    expect(out).toContain('(no new lines)')
  })

  it('run reports the real exit code and separates stderr', async () => {
    const runIn = vi.fn(async () => ({
      ok: false,
      exitCode: 2,
      stdout: '1 failed',
      stderr: 'AssertionError',
      pod: 'p-devspace-1',
      timedOut: false,
      truncated: false,
    }))
    const t = allTools(fakeClient({ runIn })).find((x) => x.name === 'devdock_run')
    const out = await t?.handler({ repo: 'svc-a', command: 'pytest -q', timeoutMs: 60_000 })
    expect(runIn).toHaveBeenCalledWith('svc-a', 'pytest -q', {
      workload: undefined,
      timeoutMs: 60_000,
    })
    expect(out).toBe('exit 2 (pod p-devspace-1)\n1 failed\n--- stderr ---\nAssertionError')
  })

  it('run surfaces infra errors distinctly from command failures', async () => {
    const t = allTools(
      fakeClient({
        runIn: async () => ({
          ok: false,
          exitCode: -1,
          stdout: '',
          stderr: '',
          timedOut: false,
          truncated: false,
          infraError: 'no running pod for svc-a — start it first',
        }),
      }),
    ).find((x) => x.name === 'devdock_run')
    expect(await t?.handler({ repo: 'svc-a', command: 'pytest' })).toContain('INFRA ERROR')
  })

  it('wait renders a match with the line and cursor', async () => {
    const t = tool('devdock_wait', 'ro')
    const out = (await t.handler({ repo: 'svc-a', contains: 'Uvicorn running' })) as string
    expect(out).toContain('matched: contains — Uvicorn running')
    expect(out).toContain('nextCursor=f:1:99')
  })

  it('wait renders a timeout distinctly', async () => {
    const t = allTools(
      fakeClient({
        wait: async () => ({
          matched: false,
          reason: 'timeout' as const,
          status: 'CRASHED' as const,
          elapsedMs: 30_000,
        }),
      }),
    ).find((x) => x.name === 'devdock_wait')
    const out = (await t?.handler({ repo: 'svc-a', contains: 'ready' })) as string
    expect(out).toContain('timeout')
    expect(out).toContain('status=CRASHED')
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
    expect(await tool('devdock_term_open').handler({})).toBe('opened host:t1 (local)')
    expect(await tool('devdock_term_open').handler({ repo: 'svc-a', kind: 'shell' })).toBe(
      'opened svc-a:t1 (shell on svc-a)',
    )
  })

  it('term_run returns output, flagging a timeout', async () => {
    expect(await tool('devdock_term_run').handler({ terminal: 'host:t1', command: 'ls' })).toBe(
      'ran',
    )
    const slow = allTools(
      fakeClient({ termRun: async () => ({ output: 'partial', timedOut: true }) }),
    ).find((x) => x.name === 'devdock_term_run')
    expect(await slow?.handler({ terminal: 'host:t1', command: 'sleep 99' })).toContain(
      'still running after timeout',
    )
  })

  it('term_list renders one line per terminal', async () => {
    expect(await tool('devdock_term_list', 'ro').handler({})).toBe(
      'host:t1\tlocal\talive\nsvc-a.cron:t1\tshell\tsvc-a/cron\texited',
    )
  })

  it('branch_list renders name and date, most recent first', async () => {
    const out = (await tool('devdock_branch_list', 'ro').handler({ repo: 'svc-a' })) as string
    expect(out).toBe('main\t2026-07-01\nfeature-x\t2026-06-15')
  })

  it('replica_create reports the id and points at devdock_wait', async () => {
    const replicaCreate = vi.fn(fakeClient().replicaCreate)
    const t = allTools(fakeClient({ replicaCreate })).find(
      (x) => x.name === 'devdock_replica_create',
    )
    const out = await t?.handler({ repo: 'svc-a', branch: 'feature-x' })
    expect(replicaCreate).toHaveBeenCalledWith('svc-a', 'feature-x')
    expect(out).toContain('created svc-a-r1 from feature-x')
    expect(out).toContain('devdock_wait')
  })

  it('replica_list renders id, parent, branch, age, and url', async () => {
    const out = (await tool('devdock_replica_list', 'ro').handler({})) as string
    expect(out).toContain('svc-a-r1')
    expect(out).toContain('parent=svc-a')
    expect(out).toContain('branch=feature-x')
    expect(out).toContain('age=1d2h')
    expect(out).toContain('url=/svc-a-r1/')
    expect(out).not.toContain('pending')
  })

  it('replica_delete passes the id through', async () => {
    const replicaDelete = vi.fn(async () => {})
    const t = allTools(fakeClient({ replicaDelete })).find(
      (x) => x.name === 'devdock_replica_delete',
    )
    expect(await t?.handler({ replica: 'svc-a-r1' })).toBe('deleted svc-a-r1')
    expect(replicaDelete).toHaveBeenCalledWith('svc-a-r1')
  })

  it('set_startup distinguishes save from clear', async () => {
    const setStartup = vi.fn(async () => {})
    const t = allTools(fakeClient({ setStartup })).find((x) => x.name === 'devdock_set_startup')
    expect(await t?.handler({ repo: 'svc-a', workload: 'worker', command: 'make run' })).toBe(
      'startup command saved for svc-a/worker',
    )
    expect(setStartup).toHaveBeenCalledWith('svc-a', 'make run', 'worker')
    expect(await tool('devdock_set_startup').handler({ repo: 'svc-a', command: '' })).toBe(
      'startup command cleared for svc-a',
    )
  })
})
