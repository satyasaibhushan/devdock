import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation } from './operations.js'
import { SandboxController } from './sandboxController.js'
import type { SandboxView } from './sandboxes.js'

const sha = 'a'.repeat(40)
const nextSha = 'b'.repeat(40)
const minute = 60_000
function sandbox(patch: Partial<SandboxView> = {}): SandboxView {
  return {
    key: 'ticket',
    slot: 'slot1',
    state: 'active',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    members: [
      {
        repo: 'app',
        workload: 'api',
        source: {
          kind: 'pr',
          repoSlug: 'team/app',
          number: 7,
          url: 'https://github.com/team/app/pull/7',
        },
        mode: 'built',
        headSha: sha,
        deployedSha: sha,
        build: { state: 'idle' },
      },
    ],
    activity: [],
    power: 'awake',
    urls: [],
    expiresAt: 0,
    allMerged: false,
    ...patch,
  }
}
function fixture(records: SandboxView[] = [sandbox()]) {
  let lock:
    | { metadata: { resourceVersion: string }; data: { holder: string; renewedAt: string } }
    | undefined
  let version = 0
  let conflict = false
  let namespace = 'personal'
  let remoteSha = sha
  let remoteState = 'OPEN'
  const kubectl = vi.fn(async (_cmd: string, args: string[]) => {
    let stdout = ''
    if (args[0] === 'get') stdout = lock ? JSON.stringify(lock) : ''
    if (args[0] === 'create') {
      if (lock) return { code: 1, stdout: '', stderr: 'AlreadyExists' }
      lock = {
        metadata: { resourceVersion: String(++version) },
        data: {
          holder:
            args
              .find((a) => a.startsWith('--from-literal=holder='))
              ?.split('=')
              .at(-1) ?? '',
          renewedAt: String(Date.now()),
        },
      }
    }
    if (args[0] === 'patch') {
      const patches = JSON.parse(args[args.indexOf('-p') + 1] ?? '') as {
        op: string
        path: string
        value: string
      }[]
      expect(patches[0]).toEqual({
        op: 'test',
        path: '/metadata/resourceVersion',
        value: lock?.metadata.resourceVersion,
      })
      if (conflict) return { code: 1, stdout: '', stderr: 'Conflict' }
      lock = {
        metadata: { resourceVersion: String(++version) },
        data: { holder: patches[1]?.value ?? '', renewedAt: patches[2]?.value ?? '' },
      }
    }
    return { code: 0, stdout, stderr: '' }
  })
  const runner = vi.fn(async (cmd: string, _args: string[], _opts?: { cwd?: string }) => ({
    code: 0,
    stdout:
      cmd === 'gh'
        ? JSON.stringify({ headRefOid: remoteSha, state: remoteState })
        : `${remoteSha}\trefs/heads/ticket\n`,
    stderr: '',
  }))
  const sandboxes = {
    list: vi.fn(async () => structuredClone(records)),
    recordHead: vi.fn(
      async (
        key: string,
        member: { repo: string; workload: string },
        head: string,
        _actor: string,
        merged?: boolean,
        _options?: { touch?: boolean },
      ) => {
        const target = records
          .find((s) => s.key === key)
          ?.members.find((m) => m.repo === member.repo && m.workload === member.workload)
        if (target) {
          target.headSha = head
          target.merged = merged
          target.build = { state: 'queued' }
        }
      },
    ),
    build: vi.fn(() => ({ operationId: 'build' })),
    sleep: vi.fn(() => ({ operationId: 'sleep' })),
    expire: vi.fn(() => ({ operationId: 'expire' })),
  }
  const operations = {
    active: vi.fn((_repo: string, _workload: string): Operation | undefined => undefined),
  }
  const timers = { setInterval: vi.fn(setInterval), clearInterval: vi.fn(clearInterval) }
  const controller = new SandboxController({
    sandboxes,
    operations,
    runner,
    kubectl,
    instanceId: 'one',
    namespace: async () => namespace,
    repos: () => [{ id: 'app', root: '/repo', path: '/repo/service' } as import('./types.js').Repo],
    now: Date.now,
    timers,
  })
  return {
    controller,
    sandboxes,
    operations,
    runner,
    kubectl,
    timers,
    lock: () => lock,
    setLock: (holder: string, renewedAt: number) => {
      lock = {
        metadata: { resourceVersion: String(++version) },
        data: { holder, renewedAt: String(renewedAt) },
      }
    },
    conflict: () => {
      conflict = true
    },
    remote: (head: string, state = 'OPEN') => {
      remoteSha = head
      remoteState = state
    },
    namespace: (value: string) => {
      namespace = value
    },
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
  vi.stubEnv('DEVDOCK_CONTROLLER', 'auto')
  vi.stubEnv('DEVDOCK_SANDBOX_TTL_HOURS', '24')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('controller leadership', () => {
  it('creates and renews the personal namespace lock with CAS every 30s', async () => {
    const f = fixture()
    await f.controller.start()
    expect(f.controller.status()).toEqual({
      holder: 'one',
      isLeader: true,
      lastPollAt: Date.now(),
      lastError: null,
    })
    expect(f.kubectl.mock.calls[0]?.[1]).toContain('personal')
    const first = f.lock()?.data.renewedAt
    await advance(30_000)
    expect(f.lock()?.data.renewedAt).not.toBe(first)
    expect(f.kubectl.mock.calls.filter(([, args]) => args[0] === 'patch')).toHaveLength(1)
    f.controller.stop()
    await advance(minute)
    expect(f.controller.status().isLeader).toBe(false)
    expect(f.timers.clearInterval).toHaveBeenCalledOnce()
  })
  it('waits past 90s before taking another holder over', async () => {
    const f = fixture()
    f.setLock('two', Date.now())
    await f.controller.start()
    expect(f.controller.status().holder).toBe('two')
    expect(f.sandboxes.list).not.toHaveBeenCalled()
    await advance(90_000)
    expect(f.controller.status().isLeader).toBe(false)
    await advance(30_000)
    expect(f.controller.status().isLeader).toBe(true)
  })
  it('loses leadership on CAS conflict and performs no actions', async () => {
    const f = fixture()
    await f.controller.start()
    f.conflict()
    await advance(minute)
    expect(f.controller.status()).toMatchObject({ isLeader: false, lastError: 'Conflict' })
    expect(f.sandboxes.list).toHaveBeenCalledOnce()
  })
  it('never acquires or starts timers when disabled', async () => {
    vi.stubEnv('DEVDOCK_CONTROLLER', 'off')
    const f = fixture()
    await f.controller.start()
    await advance(10 * minute)
    expect(f.kubectl).not.toHaveBeenCalled()
    expect(f.timers.setInterval).not.toHaveBeenCalled()
    expect(f.controller.status().isLeader).toBe(false)
  })
  it('does not act when stopped during an in-flight lock read', async () => {
    const f = fixture()
    let release: ((result: { code: number; stdout: string; stderr: string }) => void) | undefined
    f.kubectl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const starting = f.controller.start()
    await Promise.resolve()
    f.controller.stop()
    release?.({ code: 0, stdout: '', stderr: '' })
    await starting
    expect(f.kubectl).toHaveBeenCalledOnce()
    expect(f.sandboxes.list).not.toHaveBeenCalled()
  })
  it('changes leadership namespace when the context moves', async () => {
    const f = fixture()
    await f.controller.start()
    f.namespace('other')
    f.setLock('two', Date.now())
    await advance(30_000)
    expect(f.controller.status().isLeader).toBe(false)
    expect(f.kubectl.mock.calls.at(-1)?.[1]).toContain('other')
  })
})

describe('controller scheduling', () => {
  it.each(['awake', 'asleep'] as const)(
    'debounces %s builds from the last observed change',
    async (power) => {
      const record = sandbox({ power })
      const f = fixture([record])
      f.remote(nextSha)
      await f.controller.start()
      expect(f.sandboxes.recordHead).toHaveBeenCalledWith(
        'ticket',
        expect.anything(),
        nextSha,
        'controller',
        false,
        { touch: false },
      )
      const quiet = power === 'awake' ? 30_000 : 5 * minute
      await advance(quiet - 1)
      expect(f.sandboxes.build).not.toHaveBeenCalled()
      await advance(1)
      expect(f.sandboxes.build).toHaveBeenCalledWith('ticket', { actor: 'controller' })
      await advance(5 * minute)
      expect(f.sandboxes.build).toHaveBeenCalledOnce()
    },
  )
  it('restarts the quiet period on a new head and polls only every minute', async () => {
    const f = fixture([sandbox({ power: 'asleep' })])
    f.remote(nextSha)
    await f.controller.start()
    await advance(30_000)
    expect(f.runner).toHaveBeenCalledOnce()
    f.remote('c'.repeat(40))
    await advance(30_000)
    await advance(5 * minute - 1)
    expect(f.sandboxes.build).not.toHaveBeenCalled()
    await advance(1)
    expect(f.sandboxes.build).toHaveBeenCalledOnce()
  })
  it('waits for active operations and never overlaps a build', async () => {
    const f = fixture()
    f.remote(nextSha)
    f.operations.active.mockReturnValue({ id: 'active' } as Operation)
    await f.controller.start()
    await advance(minute)
    expect(f.sandboxes.build).not.toHaveBeenCalled()
    f.operations.active.mockReturnValue(undefined)
    await advance(30_000)
    expect(f.sandboxes.build).toHaveBeenCalledOnce()
    f.operations.active.mockReturnValue({ id: 'build' } as Operation)
    await advance(minute)
    expect(f.sandboxes.build).toHaveBeenCalledOnce()
  })
  it('does not retry a build that throws before recording a member failure', async () => {
    const f = fixture()
    f.remote(nextSha)
    f.sandboxes.build.mockImplementation(() => {
      throw new Error('build failed')
    })
    await f.controller.start()
    await advance(30_000)
    expect(f.controller.status().lastError).toBe('build failed')
    await advance(5 * minute)
    expect(f.sandboxes.build).toHaveBeenCalledOnce()
    f.remote('c'.repeat(40))
    await advance(minute)
    expect(f.sandboxes.build).toHaveBeenCalledTimes(2)
  })
  it('preserves failed SHA suppression after restart until the head changes', async () => {
    const record = sandbox()
    const member = record.members[0]
    if (!member) throw new Error('missing member')
    member.deployedSha = nextSha
    member.build = { state: 'failed' }
    const f = fixture([record])
    await f.controller.start()
    await advance(minute)
    expect(f.sandboxes.build).not.toHaveBeenCalled()
    f.remote('c'.repeat(40))
    await advance(minute + 30_000)
    expect(f.sandboxes.build).toHaveBeenCalledOnce()
  })
  it('sleeps idle awake sandboxes and expires on the hourly sweep without deleting', async () => {
    const record = sandbox({ lastUsedAt: Date.now() - 31 * minute })
    const f = fixture([record])
    await f.controller.start()
    expect(f.sandboxes.sleep).toHaveBeenCalledWith('ticket', 'controller')
    record.power = 'asleep'
    record.lastUsedAt = Date.now() - 24 * 60 * minute
    await advance(60 * minute - 1)
    expect(f.sandboxes.expire).not.toHaveBeenCalled()
    await advance(1)
    expect(f.sandboxes.expire).toHaveBeenCalledWith('ticket', 'controller')
  })
  it('prioritizes expiry over sleep and skips personal and unallocated records', async () => {
    const expired = { lastUsedAt: Date.now() - 25 * 60 * minute }
    const f = fixture([
      sandbox({ key: 'personal', personal: true, ...expired }),
      sandbox({ key: 'gone', slot: undefined, ...expired }),
      sandbox(expired),
    ])
    await f.controller.start()
    expect(f.sandboxes.expire).toHaveBeenCalledWith('ticket', 'controller')
    expect(f.sandboxes.sleep).not.toHaveBeenCalled()
    expect(f.runner).toHaveBeenCalledOnce()
  })
  it('ignores merged PRs, records merge transitions once, and never builds them', async () => {
    const record = sandbox()
    const f = fixture([record])
    f.remote(nextSha, 'MERGED')
    await f.controller.start()
    await advance(6 * minute)
    expect(f.sandboxes.recordHead).toHaveBeenCalledOnce()
    expect(f.sandboxes.recordHead.mock.calls[0]?.[4]).toBe(true)
    expect(f.runner).toHaveBeenCalledOnce()
    expect(f.sandboxes.build).not.toHaveBeenCalled()
  })
  it('reads branches at the repo root and avoids unchanged head writes', async () => {
    const record = sandbox()
    const member = record.members[0]
    if (!member) throw new Error('missing member')
    member.source = { kind: 'branch', ref: 'ticket' }
    const f = fixture([record])
    await f.controller.start()
    expect(f.runner).toHaveBeenCalledWith('git', ['ls-remote', 'origin', 'ticket'], {
      cwd: '/repo',
    })
    await advance(minute)
    expect(f.sandboxes.recordHead).not.toHaveBeenCalled()
  })
  it('contains poll failures and continues other sandboxes', async () => {
    const f = fixture([sandbox(), sandbox({ key: 'other' })])
    f.runner.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'offline' })
    await f.controller.start()
    expect(f.controller.status().lastError).toBe('offline')
    expect(f.runner).toHaveBeenCalledTimes(2)
    expect(f.sandboxes.build).not.toHaveBeenCalled()
  })
})
